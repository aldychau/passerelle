import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { EtsyClient } from '../src/modules/connectors/etsy/client.js';
import { writeExchangeArchive } from '../src/core/echange.js';

// Envoi direct au Studio : réglage (adresse, identifiant, secret chiffré), puis envoi du fichier avec la clé.
const KEY = { url: 'https://studio.exemple.test/reglages', id: 'stk_0123456789abcdef', secret: 'sts_secret-de-test-0123456789abcdef' };

it('règle le Studio, garde le secret chiffré et envoie le fichier boutique avec la clé', async () => {
  const store = await Store.open('memory://');
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const studioFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    return new Response(JSON.stringify(status === 200 ? { total: 2, creations: 2, updates: 0 } : { error: { code: 'cle_api_invalide', message: 'Clé API inconnue' } }), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const etsy = new EtsyClient({ sleep: async () => {}, fetch: async () => { throw new Error('Appel Etsy inattendu'); } });
  const { app, extraction } = await createApp(store, etsy, studioFetch);
  try {
    const headers = { host: 'localhost:3030' };
    const write = { ...headers, origin: 'https://localhost:3030', 'x-csrf-token': (await app.inject({ url: '/api/session', headers })).json().csrf };

    // refus : http hors de ce PC, identifiant ou secret mal formés, sans jeton CSRF
    for (const bad of [{ ...KEY, url: 'http://studio.exemple.test' }, { ...KEY, id: 'abc' }, { ...KEY, secret: 'court' }, { ...KEY, url: 'https://moi:mdp@studio.exemple.test' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/studio', headers: write, payload: bad })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/api/studio', headers, payload: KEY })).statusCode).toBe(403);

    const saved = await app.inject({ method: 'POST', url: '/api/studio', headers: write, payload: KEY });
    expect(saved.statusCode, saved.body).toBe(200);
    // seule l'origine est gardée ; le secret ne ressort jamais et n'est pas en clair dans la base
    expect(saved.json()).toMatchObject({ configured: true, url: 'https://studio.exemple.test', id: KEY.id });
    expect(saved.body).not.toContain(KEY.secret);
    expect(JSON.stringify((await store.db.query('SELECT * FROM app_settings')).rows)).not.toContain(KEY.secret);

    expect((await app.inject({ method: 'POST', url: '/api/studio/send', headers: write, payload: {} })).statusCode).toBe(400); // pas encore d'extraction

    extraction.zip = await writeExchangeArchive({ format: 'atelier-echange', version: 1, type: 'boutique', from: 'etsy', createdAt: 1, periode: '30j', commandes: [], annonces: [] }, new Map([['releve.json', Buffer.from('{"format":"atelier-releve"}')]]));
    extraction.state.ready = true;
    const sent = await app.inject({ method: 'POST', url: '/api/studio/send', headers: write, payload: {} });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().message).toContain('2 commande(s)');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://studio.exemple.test/api/boutique/import?attestation=1');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.headers).toMatchObject({ 'content-type': 'application/zip', 'x-studio-key-id': KEY.id, authorization: `Bearer ${KEY.secret}` });

    // clé révoquée côté Studio : message clair, sans recopier le secret
    status = 401;
    const refused = await app.inject({ method: 'POST', url: '/api/studio/send', headers: write, payload: {} });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('Clé Studio refusée');
    expect(refused.body).not.toContain(KEY.secret);

    // désactivé : plus rien ne part
    expect((await app.inject({ method: 'DELETE', url: '/api/studio', headers: write })).json()).toMatchObject({ configured: false });
    expect((await app.inject({ method: 'POST', url: '/api/studio/send', headers: write, payload: {} })).statusCode).toBe(400);
    expect(calls).toHaveLength(2);
  } finally { await app.close(); }
});
