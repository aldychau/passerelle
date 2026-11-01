
import crypto from 'node:crypto';
import { networkReason } from '../../../core/network.js';

// Connecteur Etsy (API v3). Repris d'Etsy Compta : débit limité, reprises sur 429 (en-tête retry-after
// respecté) et 5xx, pannes réseau, rafraîchissement du jeton. Depuis le 9 février 2026, chaque requête,
// publique ou non, doit porter « keystring:shared_secret » dans x-api-key.

const API_BASE = 'https://api.etsy.com/v3/application';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';
const AUTH_URL = 'https://www.etsy.com/oauth/connect';
const MIN_INTERVAL_MS = 150; // Etsy limite à ~10 requêtes/s
const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 180_000;
/** Au-delà, la limite journalière est en cause : attendre bloquerait la chaîne pour rien. */
const MAX_RETRY_AFTER_S = 120;

export interface EtsyTokens {
  access_token: string;
  refresh_token: string;
  /** Époque en ms. */
  expires_at: number;
}

export interface EtsyCredentials {
  keystring: string;
  secret: string;
  tokens: EtsyTokens | null;
}

/** Accès aux identifiants d'UNE boutique : le client lit l'état courant et persiste ce qu'il apprend. */
export interface EtsyCredentialStore {
  load(): EtsyCredentials | Promise<EtsyCredentials>;
  saveTokens(tokens: EtsyTokens | null): void | Promise<void>;
}

export class EtsyError extends Error {
  /** Posé quand Etsy demande d'attendre plus longtemps que le client ne patiente : la chaîne remet la fiche à plus tard sans lui compter d'échec. */
  retryAfterMs?: number;

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface EtsyClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Params = Record<string, string | number | undefined | null>;

/** Une entrée d'un tableau d'erreurs Etsy, en une phrase : « invalid_marketplace Oh dear, you cannot sell this item on Etsy. (/marketplace) ». */
function describeError(e: unknown): string {
  if (typeof e !== 'object' || e === null) return String(e);
  const r = e as Record<string, unknown>;
  return [r.type, r.message, r.path ? `(${String(r.path)})` : ''].filter(Boolean).map(String).join(' ');
}

export class EtsyClient {
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  /** Un seul rafraîchissement à la fois par jeton : des appels concurrents partagent la même promesse au lieu de consommer deux fois le refresh_token. */
  readonly #refreshing = new Map<string, Promise<EtsyTokens>>();
  readonly #lastCalls = new Map<number | null, number>();
  get #lastCall(): number { return this.#lastCalls.get(0) ?? 0; }
  set #lastCall(value: number) { this.#lastCalls.set(0, value); }

  constructor(deps: EtsyClientDeps = {}) {
    this.#fetch = deps.fetch ?? fetch;
    this.#sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.#now = deps.now ?? Date.now;
  }

  // ---------- OAuth (PKCE) ----------

  static createPkce(): { state: string; verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return {
      state: crypto.randomBytes(16).toString('base64url'),
      verifier,
      challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    };
  }

  static authorizeUrl(p: { keystring: string; redirectUri: string; scopes: readonly string[]; state: string; challenge: string }): string {
    const query = new URLSearchParams({
      response_type: 'code',
      redirect_uri: p.redirectUri,
      scope: p.scopes.join(' '),
      client_id: p.keystring,
      state: p.state,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${query.toString().replace(/\+/g, '%20')}`;
  }

  async exchangeCode(p: { keystring: string; redirectUri: string; code: string; verifier: string }): Promise<EtsyTokens> {
    return this.#token(
      { grant_type: 'authorization_code', client_id: p.keystring, redirect_uri: p.redirectUri, code: p.code, code_verifier: p.verifier },
      'Échange du code impossible',
    );
  }

  async refresh(store: EtsyCredentialStore): Promise<EtsyTokens> {
    const { keystring, tokens } = await store.load();
    if (!tokens?.refresh_token) return Promise.reject(new EtsyError('boutique non connectée à Etsy.'));
    const refreshToken = tokens.refresh_token;
    const refreshKey = `${0}:${keystring}:${refreshToken}`;
    const pending = this.#refreshing.get(refreshKey);
    if (pending) return pending;
    const run = (async () => {
      try {
        const fresh = await this.#token({ grant_type: 'refresh_token', client_id: keystring, refresh_token: refreshToken }, 'session Etsy expirée, reconnecte la boutique');
        await store.saveTokens(fresh);
        return fresh;
      } catch (e) {
        // 400/401 : le jeton de rafraîchissement est mort, inutile de le garder — sauf si un autre appel vient
        // d'en enregistrer un neuf, que ce perdant ne doit pas effacer
        if (e instanceof EtsyError && (e.status === 400 || e.status === 401) && (await store.load()).tokens?.refresh_token === refreshToken) await store.saveTokens(null);
        throw e;
      } finally {
        this.#refreshing.delete(refreshKey);
      }
    })();
    this.#refreshing.set(refreshKey, run);
    return run;
  }

  async #token(form: Record<string, string>, failure: string): Promise<EtsyTokens> {
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new EtsyError(`${failure} (${String(body.error_description || body.error || response.status)}).`, response.status);
    return {
      access_token: String(body.access_token),
      refresh_token: String(body.refresh_token),
      expires_at: this.#now() + (Number(body.expires_in) || 3600) * 1000,
    };
  }

  // ---------- Appels à l'API ----------

  /** Lecture authentifiée (jeton de la boutique). */
  get<T>(store: EtsyCredentialStore, pathname: string, params: Params = {}, beforeRequest?: () => Promise<void>): Promise<T> {
    return this.#request<T>(store, { method: 'GET', pathname, params, auth: true, beforeRequest });
  }

  /** Lecture publique : la clé de l'app suffit (recherche d'annonces, taxonomie). */
  getPublic<T>(store: EtsyCredentialStore, pathname: string, params: Params = {}): Promise<T> {
    return this.#request<T>(store, { method: 'GET', pathname, params, auth: false });
  }

  /**
   * Écriture en formulaire (createDraftListing…). Les tableaux s'envoient séparés par des virgules. `once` : création non
   * idempotente — après une coupure, un délai dépassé ou un 5xx, Etsy a peut-être déjà créé l'objet : pas de nouvel essai ici,
   * l'erreur remonte et le poste, rejoué plus tard, retrouve d'abord ce qui existe (le brouillon par son titre).
   */
  postForm<T>(store: EtsyCredentialStore, pathname: string, form: Record<string, string | number | boolean | string[] | undefined | null>, opts: { once?: boolean } = {}): Promise<T> {
    return this.#form<T>('POST', store, pathname, form, opts.once);
  }

  /** Mise à jour en formulaire (updateListingProperty, updateListingTranslation…). */
  putForm<T>(store: EtsyCredentialStore, pathname: string, form: Record<string, string | number | boolean | string[] | undefined | null>): Promise<T> {
    return this.#form<T>('PUT', store, pathname, form);
  }

  /** Suppression (deleteListingProperty…) : Etsy répond 204 sans corps. */
  delete<T>(store: EtsyCredentialStore, pathname: string): Promise<T> {
    return this.#request<T>(store, { method: 'DELETE', pathname, auth: true });
  }

  /** Modification partielle en formulaire (updateListing : seuls les champs envoyés changent). */
  patchForm<T>(store: EtsyCredentialStore, pathname: string, form: Record<string, string | number | boolean | string[] | undefined | null>, beforeRequest?: () => Promise<void>): Promise<T> {
    return this.#form<T>('PATCH', store, pathname, form, false, beforeRequest);
  }

  #form<T>(method: 'POST' | 'PUT' | 'PATCH', store: EtsyCredentialStore, pathname: string, form: Record<string, string | number | boolean | string[] | undefined | null>, once = false, beforeRequest?: () => Promise<void>): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (Array.isArray(value)) {
        // une liste vide ne s'envoie pas : « tags= » est refusé là où l'absence du champ est admise
        if (value.length) body.set(key, value.join(','));
        continue;
      }
      if (value === undefined || value === null || value === '') continue;
      body.set(key, String(value));
    }
    return this.#request<T>(store, { method, pathname, auth: true, body: () => body, once, beforeRequest });
  }

  /** Écriture en JSON (updateListingInventory…). */
  putJson<T>(store: EtsyCredentialStore, pathname: string, payload: unknown, beforeRequest?: () => Promise<void>): Promise<T> {
    return this.#request<T>(store, { method: 'PUT', pathname, auth: true, body: () => JSON.stringify(payload), json: true, beforeRequest });
  }

  /** Envoi d'une image d'annonce (multipart, champ « image »). */
  setImageAlt<T>(store: EtsyCredentialStore, pathname: string, imageId: number, text: string, rank: number, beforeRequest?: () => Promise<void>): Promise<T> {
    return this.#request<T>(store, { method: 'POST', pathname, auth: true, beforeRequest, body: () => {
      const form = new FormData();
      form.set('listing_image_id', String(imageId));
      form.set('alt_text', text);
      form.set('rank', String(rank));
      form.set('overwrite', 'true');
      return form;
    } });
  }

  uploadImage<T>(store: EtsyCredentialStore, pathname: string, image: { data: Buffer; filename: string; mime: string }, fields: Record<string, string | number> = {}): Promise<T> {
    // le corps est reconstruit à chaque tentative : un FormData ne se relit pas
    const body = () => {
      const form = new FormData();
      form.set('image', new Blob([new Uint8Array(image.data)], { type: image.mime }), image.filename);
      for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
      return form;
    };
    return this.#request<T>(store, { method: 'POST', pathname, auth: true, body, timeoutMs: UPLOAD_TIMEOUT_MS });
  }

  /**
   * Envoi de la vidéo d'une annonce (multipart : fichier « video » et son nom « name » ; une seule vidéo par annonce). Pas de
   * nouvel essai sur coupure ou 5xx : le poste rejoué regarde d'abord si l'annonce a déjà sa vidéo.
   */
  uploadVideo<T>(store: EtsyCredentialStore, pathname: string, video: { data: Buffer; filename: string; mime: string }): Promise<T> {
    const body = () => {
      const form = new FormData();
      form.set('video', new Blob([new Uint8Array(video.data)], { type: video.mime }), video.filename);
      form.set('name', video.filename);
      return form;
    };
    return this.#request<T>(store, { method: 'POST', pathname, auth: true, body, timeoutMs: UPLOAD_TIMEOUT_MS, once: true });
  }

  async #request<T>(
    store: EtsyCredentialStore,
    req: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; pathname: string; params?: Params; auth: boolean; body?: () => URLSearchParams | FormData | string; json?: boolean; timeoutMs?: number; once?: boolean; beforeRequest?: () => Promise<void> },
    retry = 0,
  ): Promise<T> {
    const { pathname } = req;
    const creds = await store.load();
    if (!creds.secret) throw new EtsyError('shared secret manquant pour cette boutique : ajoute-le dans la page Boutiques (Etsy l\'exige pour chaque requête).');
    let bearer: string | null = null;
    if (req.auth) {
      let tokens = creds.tokens;
      if (!tokens?.access_token) throw new EtsyError('boutique non connectée à Etsy.');
      // le jeton rendu par refresh() est celui qu'on vient d'obtenir : relire la base exposerait à lire ce qu'un appel concurrent a écrit entre-temps
      if (this.#now() > tokens.expires_at - 60_000) tokens = await this.refresh(store);
      bearer = tokens.access_token;
    }

    const url = new URL(API_BASE + pathname);
    for (const [key, value] of Object.entries(req.params ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    await this.#throttle();

    const headers: Record<string, string> = { 'x-api-key': `${creds.keystring}:${creds.secret}`, Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (req.json) headers['Content-Type'] = 'application/json';

    await req.beforeRequest?.();
    let response: Response;
    try {
      // redirect: 'error' : fetch retire Authorization en changeant d'hôte, mais pas x-api-key (keystring:secret)
      response = await this.#fetch(url, { method: req.method, headers, body: req.body?.(), signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS), redirect: 'error' });
    } catch (e) {
      // une création non idempotente a peut-être été reçue avant la coupure : ne pas la renvoyer
      if (retry < 3 && !req.once) {
        await this.#sleep(1500 * (retry + 1));
        return this.#request(store, req, retry + 1);
      }
      throw new EtsyError(`erreur réseau (${networkReason(e)})`);
    }

    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      // les refus liés aux règles de la place de marché arrivent en tableau : [{ type, message, path }]
      body = Array.isArray(parsed) ? { error: parsed.map(describeError).join(' ; ') } : (parsed as Record<string, unknown>);
    } catch {
      body = { error: text.slice(0, 300) };
    }
    if (response.ok) return body as T;

    // le corps entier plutôt que le seul statut : un 400 sans champ « error » n'expliquerait rien
    const message = String(body.error_description || body.error || (text.trim() ? text.slice(0, 500) : '') || response.statusText || response.status);
    // un 429 n'a rien traité : on peut toujours le relancer ; un 5xx sur une création non idempotente, non (elle a pu aboutir)
    if ((response.status === 429 || (response.status >= 500 && !req.once)) && retry < 4) {
      const retryAfter = Number(response.headers.get('retry-after')) || 0;
      if (response.status === 429 && retryAfter > MAX_RETRY_AFTER_S) {
        const error = new EtsyError(`Etsy 429 (${pathname}) : quota d'appels atteint, réessayer dans ${Math.ceil(retryAfter / 60)} min`, 429);
        error.retryAfterMs = retryAfter * 1000;
        throw error;
      }
      // un 5xx peut aussi porter un retry-after : jamais au-delà du plafond, la chaîne ne doit pas dormir une heure
      await this.#sleep(retryAfter > 0 ? Math.min(retryAfter, MAX_RETRY_AFTER_S) * 1000 : 2000 * 2 ** retry);
      return this.#request(store, req, retry + 1);
    }
    if (req.auth && response.status === 401 && /token/i.test(message) && retry < 1) {
      await this.refresh(store);
      return this.#request(store, req, retry + 1);
    }
    throw new EtsyError(`Etsy ${response.status} (${pathname}) : ${message}`, response.status);
  }

  async paginate<T>(store: EtsyCredentialStore, pathname: string, params: Params = {}, onPage?: (loaded: number, total: number | null) => void): Promise<T[]> {
    const out: T[] = [];
    const limit = 100;
    let offset = 0;
    for (;;) {
      const body = await this.get<{ results?: T[]; count?: number }>(store, pathname, { ...params, limit, offset });
      const rows = body.results ?? [];
      out.push(...rows);
      offset += rows.length;
      onPage?.(out.length, body.count ?? null);
      if (rows.length < limit || (body.count != null && offset >= body.count)) break;
    }
    return out;
  }

  async #throttle(): Promise<void> {
    const wait = this.#lastCall + MIN_INTERVAL_MS - this.#now();
    if (wait > 0) await this.#sleep(wait);
    this.#lastCall = this.#now();
  }
}
