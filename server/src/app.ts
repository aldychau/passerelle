import { localTls } from './tls.js';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import serveStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ECHANGE_PERIODES, catalogueForStudio } from '@passerelle/shared';
import { Store } from './store.js';
import { EtsyClient } from './modules/connectors/etsy/client.js';
import { Extraction } from './extraction.js';
import { Imports } from './imports.js';
import { StudioLink } from './studio.js';
import { badRequest } from './core/errors.js';
import { readExchangeArchive,writeExchangeArchive } from './core/echange.js';
export const HOST='127.0.0.1',PORT=3030;
/** Une boutique pour l'instant (ajout et extraction) ; plusieurs boutiques viendront avec l'abonnement Studio. */
export const MAX_SHOPS=1;
export const CALLBACK='https://localhost:3030/oauth/etsy/callback';
const allowedHosts=new Set(['127.0.0.1:3030','localhost:3030']);
const scopes=['shops_r','transactions_r','listings_r','listings_w','transactions_w','billing_r','profile_r'];
export async function createApp(store:Store,etsy=new EtsyClient(),studioFetch:typeof fetch=fetch){
 const app=Fastify({https:localTls(store.location),logger:false,bodyLimit:200*1024*1024,requestTimeout:300000});
 const csrf=crypto.randomBytes(32).toString('base64url');
 const extraction=new Extraction(store,etsy),imports=new Imports(store,etsy),studio=new StudioLink(store,studioFetch);
 // La version lue par le Studio : echange.json, releve.json et le catalogue (toutes les variantes en vente, pour lier
 // chacune à AliExpress), sans les coordonnées des acheteurs. Un catalogue que le Studio refuserait reste de côté.
 const studioZip=async(zip:Buffer,log?:(line:string)=>void)=>{const archive=await readExchangeArchive(zip,{media:false,releve:true});const files=new Map([['releve.json',Buffer.from(JSON.stringify(archive.releve))]]);const catalogue=catalogueForStudio(archive.catalogue);if('file' in catalogue)files.set('catalogue.json',Buffer.from(JSON.stringify(catalogue.file)));else log?.(catalogue.reason);return writeExchangeArchive(archive.json,files);};
 // Après une extraction réussie, si une clé Studio est réglée, le fichier part tout seul au Studio.
 const sendToStudio=async()=>{if(!extraction.zip||!extraction.state.ready||!(await studio.config()))return;extraction.state.log.push('Envoi au Studio…');try{extraction.state.log.push((await studio.send(await studioZip(extraction.zip,line=>extraction.state.log.push(line))))!);}catch(e){extraction.state.log.push(e instanceof Error?e.message:'Envoi au Studio impossible.');}};
 const oauth=new Map<string,{id:string;verifier:string;expires:number;browser:string}>();
 let task:Promise<unknown>|null=null;
 await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],connectSrc:["'self'"],imgSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],baseUri:["'none'"],frameAncestors:["'none'"],formAction:["'self'"],upgradeInsecureRequests:null}},hsts:false});
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('Cache-Control','no-store');
  if(!allowedHosts.has(req.headers.host??''))return reply.code(403).send({error:'Hôte refusé'});
  const origin=req.headers.origin;
  if(origin&&origin!==`https://${req.headers.host}`)return reply.code(403).send({error:'Origine refusée'});
  if(req.headers['sec-fetch-site']==='cross-site'&&!req.url.startsWith('/oauth/etsy/callback'))return reply.code(403).send({error:'Origine refusée'});
  if(req.headers.host==='127.0.0.1:3030'&&['GET','HEAD'].includes(req.method)&&!/^\/api(?:\/|\?|$)/.test(req.url))return reply.redirect('https://localhost:3030'+req.url,302);
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
   if(origin!==`https://${req.headers.host}`||req.headers['x-csrf-token']!==csrf)return reply.code(403).send({error:'Protection CSRF : rechargez la page.'});
  }
 });
 app.setErrorHandler((e,_req,reply)=>{const status=(e as {statusCode?:number}).statusCode??400;reply.code(status>=400&&status<500?status:400).send({error:e instanceof z.ZodError?'Données invalides.':status===400?(e instanceof Error&&'statusCode'in e?e.message:'Opération impossible. Vérifiez les données et la connexion Etsy.'):'Opération refusée.'});});
 app.addContentTypeParser('application/zip',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
 app.get('/api/session',async()=>({csrf,callback:CALLBACK}));
 app.get('/api/shops',async()=>Promise.all((await store.shops()).map(async s=>({id:s.id,name:s.name,connected:!!(await store.credentials(s.id).load()).tokens,currency:s.currency,settings:(await store.rows(s.id,'settings'))[0]??null}))));
 app.post('/api/shops',async req=>{
  if(task)throw badRequest('Attendez la fin de l’opération.');
  const b=z.object({name:z.string().trim().min(1).max(80),keystring:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),secret:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)}).strict().parse(req.body);
  // Une seule boutique pour l'instant : plusieurs boutiques arriveront avec l'abonnement Studio.
  if((await store.shops()).length>=MAX_SHOPS)throw badRequest('Une boutique par Passerelle pour l’instant. Plusieurs boutiques arriveront avec l’abonnement Studio.');
  return {id:await store.add(b.name,b.keystring,b.secret)};
 });
 app.delete('/api/shops/:id',async req=>{if(task)throw badRequest('Opération en cours.');const {id}=req.params as {id:string};await store.db.query('DELETE FROM shops WHERE id=$1',[id]);return {ok:true};});
 app.post('/api/shops/:id/disconnect',async req=>{if(task)throw badRequest('Opération en cours.');const {id}=req.params as {id:string};await store.credentials(id).saveTokens(null);for(const [state,p] of oauth)if(p.id===id)oauth.delete(state);return {ok:true};});
 app.post('/api/shops/:id/connect',async(req,reply)=>{
  if(task)throw badRequest('Opération en cours.');
  for(const [state,p]of oauth)if(p.expires<Date.now())oauth.delete(state);
  const {id}=req.params as {id:string},c=await store.credentials(id).load(),pkce=EtsyClient.createPkce(),browser=crypto.randomBytes(32).toString('hex');
  for(const [state,p]of oauth)if(p.id===id)oauth.delete(state);
  oauth.set(pkce.state,{id,verifier:pkce.verifier,expires:Date.now()+600000,browser});
  reply.header('Set-Cookie',`passerelle_oauth=${browser}; Secure; HttpOnly; SameSite=Lax; Path=/oauth/etsy; Max-Age=600`);
  return {url:'/oauth/etsy/start?state='+pkce.state};
 });
 app.get('/oauth/etsy/start',async(req,reply)=>{
  const {state}=z.object({state:z.string()}).parse(req.query),p=oauth.get(state);
  if(!p||p.expires<Date.now()||!req.headers.cookie?.split(';').some(c=>c.trim()===`passerelle_oauth=${p.browser}`))throw badRequest('Connexion expiree.');
  const c=await store.credentials(p.id).load();
  return reply.redirect(EtsyClient.authorizeUrl({keystring:c.keystring,redirectUri:CALLBACK,scopes,state,challenge:crypto.createHash('sha256').update(p.verifier).digest('base64url')}));
 });
 app.get('/oauth/etsy/callback',async(req,reply)=>{
  const q=z.object({state:z.string(),code:z.string()}).parse(req.query),p=oauth.get(q.state);oauth.delete(q.state);
  if(!p||p.expires<Date.now()||!req.headers.cookie?.split(';').some(c=>c.trim()===`passerelle_oauth=${p.browser}`))throw badRequest('Connexion expirée : recommencez depuis Boutiques.');
  const c=await store.credentials(p.id).load(),tokens=await etsy.exchangeCode({keystring:c.keystring,redirectUri:CALLBACK,code:q.code,verifier:p.verifier});
  await store.credentials(p.id).saveTokens(tokens);
  try{const me=await etsy.get<{shop_id:number}>(store.credentials(p.id),'/users/me');if(!me.shop_id)throw badRequest('Aucune boutique Etsy.');const old=await store.shop(p.id);if(old.etsy_id&&Number(old.etsy_id)!==Number(me.shop_id))throw badRequest('Cette connexion désigne une autre boutique.');
   const info=await etsy.get<{currency_code:string;created_timestamp:number}>(store.credentials(p.id),`/shops/${me.shop_id}`);
   await store.db.query('UPDATE shops SET etsy_id=$1,currency=$2,created=$3 WHERE id=$4',[me.shop_id,info.currency_code,info.created_timestamp,p.id]);
  }catch{await store.credentials(p.id).saveTokens(null);throw badRequest('Impossible d’identifier la boutique. Recommencez.');}
  reply.header('Set-Cookie','passerelle_oauth=; Secure; HttpOnly; SameSite=Lax; Path=/oauth/etsy; Max-Age=0');return reply.redirect('/');
 });
 app.get('/api/shops/:id/profiles',async req=>{
  const s=await store.shop((req.params as {id:string}).id);if(!s.etsy_id)throw badRequest('Connectez la boutique.');const c=store.credentials(s.id);
  const shipping=await etsy.get<{results:unknown[]}>(c,`/shops/${s.etsy_id}/shipping-profiles`);
  const readiness=await etsy.get<{results:unknown[]}>(c,`/shops/${s.etsy_id}/readiness-state-definitions`);
  return {shipping:shipping.results,readiness:readiness.results};
 });
 app.post('/api/shops/:id/settings',async req=>{if(task)throw badRequest('Opération en cours.');const s=await store.shop((req.params as {id:string}).id);const b=z.object({shippingProfileId:z.number().int().positive(),readinessStateId:z.number().int().positive()}).strict().parse(req.body);await store.put(s.id,'settings','defaults',b);return {ok:true};});
 app.post('/api/extract',async req=>{
  if(task)throw badRequest('Une opération est en cours.');
  const b=z.object({shops:z.array(z.string()).min(1),periode:z.enum(ECHANGE_PERIODES).default('30j')}).strict().parse(req.body);
  if(b.shops.length>MAX_SHOPS)throw badRequest('Une boutique par extraction pour l’instant.');
  if(b.shops.some(id=>!id)||new Set(b.shops).size!==b.shops.length)throw badRequest('Sélection invalide');
  for(const id of b.shops)await store.shop(id);
  task=extraction.run(b.shops,b.periode).then(sendToStudio).finally(()=>{task=null;});return {ok:true};
 });
 app.get('/api/extract/state',async()=>({...extraction.state,running:extraction.state.running||task!==null}));
 app.get('/api/extract/download',async(req,reply)=>{if(!extraction.zip||extraction.state.running)throw badRequest('Aucun fichier prêt.');let zip=extraction.zip;const q=z.object({studio:z.enum(['1']).optional(),catalogue:z.enum(['1']).optional()}).strict().parse(req.query);if(!q.catalogue||q.studio)zip=await studioZip(zip);return reply.type('application/zip').header('Content-Disposition','attachment; filename="boutique.zip"').send(zip);});
 app.get('/api/studio',async()=>studio.state());
 app.post('/api/studio',async req=>{if(task)throw badRequest('Opération en cours.');await studio.save(req.body);return studio.state();});
 app.delete('/api/studio',async()=>{if(task)throw badRequest('Opération en cours.');await studio.clear();return studio.state();});
 app.post('/api/studio/send',async()=>{if(task)throw badRequest('Opération en cours.');if(!extraction.zip||!extraction.state.ready)throw badRequest('Lance d’abord une extraction.');const run=studio.send(await studioZip(extraction.zip));task=run;try{const message=await run;if(!message)throw badRequest('Règle d’abord l’envoi au Studio.');return {message};}finally{task=null;}});
 app.post('/api/import/preview',async req=>{if(task)throw badRequest('Opération en cours.');if(!Buffer.isBuffer(req.body))throw badRequest('Choisissez un zip.');const run=imports.preview(req.body);task=run;try{return await run;}finally{task=null;}});
 app.post('/api/import/confirm',async req=>{if(task)throw badRequest('Opération en cours.');const b=z.object({token:z.string().uuid()}).strict().parse(req.body);const run=imports.enqueue(b.token);task=run;try{return await run;}finally{task=null;}});
 app.post('/api/import/sync',async()=>{if(task)throw badRequest('Op?ration en cours.');task=imports.synchronize().finally(()=>{task=null;});return {ok:true};});
 app.get('/api/import/state',async()=>imports.state());
 const root=path.resolve(import.meta.dirname,'../../web/dist');
 if(fs.existsSync(root))await app.register(serveStatic,{root});
 else app.get('/',async(_req,reply)=>reply.type('text/plain').send('Interface non construite. Fermez puis utilisez Lancer.bat.'));
 app.addHook('onClose',async()=>{if(task)await task;imports.dispose();oauth.clear();await store.db.close();});
 return {app,extraction,imports};
}
