import { z } from 'zod';
import { badRequest } from './core/errors.js';
import { networkReason } from './core/network.js';
import type { Store } from './store.js';

/**
 * Envoi direct au Studio : l'adresse du Studio, l'identifiant et le secret d'une clé API créée dans
 * Studio → Réglages → Passerelle. Le secret est chiffré sur le PC comme les clés Etsy et ne ressort jamais.
 * Sans réglage, rien ne part : le fichier se télécharge comme avant.
 */
export interface StudioConfig { url: string; id: string; secret: string }
export interface StudioState { configured: boolean; url: string | null; id: string | null; last: { at: number; ok: boolean; message: string } | null; sending: boolean }

const CONTEXT = 'studio';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export const studioConfigSchema = z.object({
  url: z.string().trim().max(200).transform((value, ctx) => {
    let u: URL;
    try { u = new URL(value); } catch { ctx.addIssue({ code: 'custom', message: 'Adresse du Studio invalide.' }); return z.NEVER; }
    // HTTPS obligatoire, sauf un Studio lancé sur ce PC
    if (u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL.has(u.hostname)))) { ctx.addIssue({ code: 'custom', message: 'L’adresse du Studio doit commencer par « https:// ».' }); return z.NEVER; }
    return u.origin;
  }),
  id: z.string().trim().regex(/^stk_[a-f0-9]{16}$/, 'Identifiant de clé invalide (il commence par stk_).'),
  secret: z.string().trim().regex(/^sts_[A-Za-z0-9_-]{20,200}$/, 'Secret invalide (il commence par sts_).'),
}).strict();

export class StudioLink {
  last: StudioState['last'] = null;
  sending = false;
  constructor(private readonly store: Store, private readonly fetchImpl: typeof fetch = fetch, private readonly now = Date.now) {}

  async #table() { await this.store.db.exec('CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)'); }

  async config(): Promise<StudioConfig | null> {
    await this.#table();
    const row = (await this.store.db.query<{ value: string }>("SELECT value FROM app_settings WHERE key='studio'")).rows[0];
    return row ? JSON.parse(this.store.secrets.open(row.value, CONTEXT)) as StudioConfig : null;
  }

  async save(input: unknown): Promise<void> {
    const parsed = studioConfigSchema.safeParse(input);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Réglage du Studio invalide.');
    const config = parsed.data;
    await this.#table();
    await this.store.db.query("INSERT INTO app_settings VALUES('studio',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [this.store.secrets.seal(JSON.stringify(config), CONTEXT)]);
    this.last = null;
  }

  async clear(): Promise<void> {
    await this.#table();
    await this.store.db.query("DELETE FROM app_settings WHERE key='studio'");
    this.last = null;
  }

  async state(): Promise<StudioState> {
    const c = await this.config();
    return { configured: !!c, url: c?.url ?? null, id: c?.id ?? null, last: this.last, sending: this.sending };
  }

  /** Envoie le fichier boutique (version Studio) ; rend le résumé du Studio. N'envoie rien sans réglage. */
  async send(zip: Buffer): Promise<string | null> {
    const c = await this.config();
    if (!c) return null;
    this.sending = true;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${c.url}/api/boutique/import?attestation=1`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
          headers: { 'content-type': 'application/zip', 'x-studio-key-id': c.id, authorization: `Bearer ${c.secret}` },
          body: new Uint8Array(zip),
        });
      } catch (e) { throw badRequest(`Studio injoignable (${networkReason(e)}). Le fichier reste téléchargeable.`); }
      const body = await response.json().catch(() => null) as { total?: number; creations?: number; updates?: number; error?: { message?: string } | string } | null;
      if (!response.ok) {
        const reason = typeof body?.error === 'string' ? body.error : body?.error?.message;
        throw badRequest(response.status === 401 ? 'Clé Studio refusée : vérifie l’identifiant et le secret, ou crée une nouvelle clé dans Studio → Réglages.' : `Le Studio a refusé le fichier${reason ? ` : ${String(reason).slice(0, 300)}` : ` (HTTP ${response.status})`}.`);
      }
      const message = `Envoyé au Studio : ${body?.total ?? 0} commande(s) en cours (${body?.creations ?? 0} nouvelle(s), ${body?.updates ?? 0} mise(s) à jour).`;
      this.last = { at: this.now(), ok: true, message };
      return message;
    } catch (e) {
      this.last = { at: this.now(), ok: false, message: e instanceof Error ? e.message : 'Envoi au Studio impossible.' };
      throw e;
    } finally { this.sending = false; }
  }
}
