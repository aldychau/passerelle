import { describe,it,expect,beforeAll,afterAll } from 'vitest';
import { readFileSync,readdirSync } from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { Store } from '../src/store.js';
import { createApp,HOST,PORT } from '../src/app.js';
import { EtsyClient } from '../src/modules/connectors/etsy/client.js';
import { Extraction } from '../src/extraction.js';
import { Imports } from '../src/imports.js';
import { normalizeReceipt,normalizeListing } from '../src/modules/compta/normalize.js';
import { writeExchangeArchive,readExchangeArchive,mediaKind } from '../src/core/echange.js';
import { periodeStart,boutiqueFileSchema,releveFileSchema,RELEVE_LIMITS } from '@passerelle/shared';
const now=Date.UTC(2026,10,1,12),money={amount:1200,divisor:100,currency_code:'EUR'};
const raw=(id:number,extra={})=>({receipt_id:id,is_paid:true,is_shipped:false,status:'paid',country_iso:'FR',name:'CLIENT PRIVE',first_line:'42 RUE PRIVEE',city:'VILLE PRIVEE',zip:'75001',created_timestamp:now/1000-60,grandtotal:money,transactions:[{transaction_id:id,listing_id:10,title:'Objet',quantity:1,paid_timestamp:now/1000-60,price:money}],...extra});
async function unzip(buffer:Buffer):Promise<Record<string,any>>{return new Promise((resolve,reject)=>{yauzl.fromBuffer(buffer,{lazyEntries:true},(err,zip)=>{if(err)return reject(err);const out:Record<string,any>={};zip.on('error',reject);zip.on('end',()=>resolve(out));zip.on('entry',entry=>zip.openReadStream(entry,(err,stream)=>{if(err)return reject(err);const c:Buffer[]=[];stream.on('data',b=>c.push(b));stream.on('end',()=>{out[entry.fileName]=JSON.parse(Buffer.concat(c).toString());zip.readEntry();});}));zip.readEntry();});});}
async function archive(entries:[string,Buffer][]):Promise<Buffer>{return new Promise(resolve=>{const z=new yazl.ZipFile(),chunks:Buffer[]=[];for(const[n,b]of entries)z.addBuffer(b,n);z.outputStream.on('data',b=>chunks.push(b));z.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));z.end();});}
let db:Store,id:string,etsy:EtsyClient,extraction:Extraction,imports:Imports;
const calls:{url:string;method:string;body:string}[]=[];
let listingState='draft',shipped=false,failCreate=false;
beforeAll(async()=>{
 db=await Store.open('memory://');id=await db.add('Boutique','TEST_KEY','TEST_SECRET');await db.credentials(id).saveTokens({access_token:'TEST_ACCESS',refresh_token:'TEST_REFRESH',expires_at:now+99999999999});
 await db.db.query('UPDATE shops SET etsy_id=1,currency=$1 WHERE id=$2',['EUR',id]);await db.put(id,'settings','defaults',{shippingProfileId:5,readinessStateId:6});
 etsy=new EtsyClient({sleep:async()=>{},now:()=>now,fetch:async(input,init)=>{
  const url=String(input),method=init?.method??'GET';calls.push({url,method,body:String(init?.body??'')});let body:unknown={};
  if(url.endsWith('/users/me'))body={shop_id:1};
  else if(url.endsWith('/shops/1'))body={currency_code:'EUR',created_timestamp:now/1000-3600};
  else if(url.includes('/receipts/'))body={receipt_id:101,is_shipped:shipped};
  else if(url.includes('/receipts?'))body={results:[raw(1),raw(2,{is_shipped:true}),raw(3,{status:'fully refunded'})],count:3};
  else if(url.includes('/ledger-entries?'))body={results:[{entry_id:8,amount:-100,currency:'EUR',ledger_type:'fee',created_timestamp:now/1000-1}],count:1};
  else if(url.includes('/listings?'))body={results:url.includes('state=active')?[{listing_id:10,title:'Objet',state:'active',price:money,quantity:1,views:4,num_favorers:2,tags:['objet'],images:[{url_170x135:'http://unsafe.example/image'}]}]:[],count:url.includes('state=active')?1:0};
  else if(url.endsWith('/listings/55')&&method==='GET')body={listing_id:55,shop_id:1,state:listingState};
  else if(url.endsWith('/shops/1/listings')&&method==='POST'){if(failCreate)throw new Error('lost');body={listing_id:55};}
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 }});
 extraction=new Extraction(db,etsy,()=>now);imports=new Imports(db,etsy,()=>now);
});
afterAll(async()=>{if(!db.db.closed)await db.db.close();});
describe('Extraction et confidentialité',()=>{
 it('récupère les quatre étapes et produit les deux fichiers compatibles',async()=>{
  await extraction.sync(await db.shops());const files=await unzip(await extraction.export([id],'30j'));
  expect(Object.keys(files).sort()).toEqual(['catalogue.json','echange.json','releve.json']);expect(boutiqueFileSchema.safeParse(files['echange.json']).success).toBe(true);expect(releveFileSchema.safeParse(files['releve.json']).success).toBe(true);
  expect(files['echange.json'].commandes).toHaveLength(1);expect(files['echange.json'].commandes[0].shipTo.name).toBe('CLIENT PRIVE');
  const r=files['releve.json'];expect(r.boutiques[0].commandes).toHaveLength(3);expect(r.boutiques[0].operations).toHaveLength(1);expect(r.boutiques[0].vues[0].day).toBe('2026-11-01');expect(r.boutiques[0].annonces[0].image).toBeNull();
  const text=JSON.stringify(r);for(const token of ['CLIENT PRIVE','RUE PRIVEE','VILLE PRIVEE','75001','shipments','trackingCode','name','address','line1','line2','city','zip'])expect(text).not.toContain(token);
  for(const token of ['TEST_KEY','TEST_SECRET','TEST_ACCESS','TEST_REFRESH'])expect(JSON.stringify(files)).not.toContain(token);
  expect(extraction.state.log.join(' ')).toContain('vues du jour');
 });
 it('efface les coordonnées expédiées, annulées et remboursées avant stockage',async()=>{
  for(const extra of [{is_shipped:true},{status:'canceled'},{status:'fully refunded'}]){const o=normalizeReceipt(raw(5,extra));expect(o.name).toBe('');expect(o.line1).toBe('');}
  expect((await db.rows<any>(id,'order')).filter(o=>o.id!==1).every(o=>!o.name&&!o.line1)).toBe(true);
 });
 it('distingue mois calendaire et durées glissantes',()=>{
  const end=Date.UTC(2024,2,31,12);expect(periodeStart('1m',end)).toBe(Date.UTC(2024,1,29,12));expect(periodeStart('30j',end)).toBe(end-30*86400000);expect(periodeStart('7j',end)).toBe(end-7*86400000);expect(periodeStart('1j',end)).toBe(end-86400000);expect(periodeStart('tout',end)).toBe(0);
 });
 it('la période ne filtre ni le relevé ni les annonces',async()=>{
  const o=normalizeReceipt(raw(20,{transactions:[{transaction_id:20,title:'Ancien',quantity:1,paid_timestamp:(now-60*86400000)/1000,price:money}]}));await db.put(id,'order',20,o);
  const recent=await unzip(await extraction.export([id],'1j')),all=await unzip(await extraction.export([id],'tout'));
  expect(recent['echange.json'].commandes).toHaveLength(1);expect(all['echange.json'].commandes).toHaveLength(2);expect(recent['releve.json'].boutiques[0].commandes).toHaveLength(4);expect(recent['echange.json'].annonces).toHaveLength(1);
 });
 it('refuse les données personnelles ajoutées au relevé et les URL non HTTPS',()=>{
  expect(releveFileSchema.safeParse({format:'atelier-releve',version:1,createdAt:now,boutiques:[{shop:'B',currency:'EUR',commandes:[{...normalizeReceipt(raw(3)),email:'secret'}],annonces:[],operations:[],vues:[]}]}).success).toBe(false);
  expect(normalizeListing({listing_id:1,url:'javascript:alert(1)',images:[{url_170x135:'http://x'}]}).url).toBeNull();expect(RELEVE_LIMITS).toEqual({bytes:104857600,rows:200000});
 });
 it('chiffre clés et jetons en base avec un contexte authentifié',async()=>{
  const s=await db.shop(id);for(const value of ['TEST_KEY','TEST_SECRET','TEST_ACCESS','TEST_REFRESH'])expect(s.credentials).not.toContain(value);
  expect((await db.credentials(id).load()).tokens?.access_token).toBe('TEST_ACCESS');expect(()=>db.secrets.open(s.credentials,'other-shop')).toThrow();
 });
});
const fiche={ref:'st_test',shop:'Boutique',title:'Objet',description:'Description',tags:['objet'],materials:[],price:{amount:12,currency:'EUR'},quantity:1,whoMade:'i_did',whenMade:'made_to_order',isSupply:false,productionPartner:null,taxonomyId:1,language:'fr',translations:{},variations:null,images:[],video:null};
const envelope=(type:string,items:unknown[],createdAt=now)=>({format:'atelier-echange',version:1,type,from:'studio',createdAt,items});
describe('Imports confirmés',()=>{
 it('aperçu sans écriture, création puis mise à jour du même brouillon',async()=>{
  const zip=await writeExchangeArchive(envelope('fiches',[fiche]));const start=calls.length,p=await imports.preview(zip);expect(p.accepted).toBe(1);expect(calls.slice(start).every(c=>c.method==='GET')).toBe(true);
  await imports.confirm(p.token);await expect(imports.confirm(p.token)).rejects.toThrow();const p2=await imports.preview(zip);expect(p2.entries[0]?.action).toContain('Mettre à jour');await imports.confirm(p2.token);
  expect(calls.filter(c=>c.url.endsWith('/shops/1/listings')&&c.method==='POST')).toHaveLength(1);expect(calls.some(c=>c.method==='PATCH')).toBe(true);expect(calls.every(c=>!c.body.includes('state=active'))).toBe(true);
 });
 it('ne modifie jamais une annonce publiée et ignore les fichiers anciens',async()=>{
  listingState='active';let p=await imports.preview(await writeExchangeArchive(envelope('fiches',[fiche])));expect(p.accepted).toBe(1);const before=calls.filter(c=>c.method==='PATCH').length;await imports.confirm(p.token);expect(calls.filter(c=>c.method==='PATCH')).toHaveLength(before);listingState='draft';
  p=await imports.preview(await writeExchangeArchive(envelope('fiches',[fiche],now-1)));expect(p.entries[0]?.action).toContain('plus ancien');const n=calls.filter(c=>c.method==='PATCH').length;await imports.confirm(p.token);expect(calls.filter(c=>c.method==='PATCH')).toHaveLength(n);
 });
 it('bloque une création incertaine au lieu de la dupliquer',async()=>{
  failCreate=true;const z=await writeExchangeArchive(envelope('fiches',[{...fiche,ref:'st_uncertain'}]));let p=await imports.preview(z);await imports.confirm(p.token);expect(imports.log[0]).toContain('échec');failCreate=false;p=await imports.preview(z);expect(p.accepted).toBe(0);expect(p.entries[0]?.action).toContain('incertaine');
 });
 it('suivi après confirmation, idempotence et purge immédiate des coordonnées',async()=>{
  await db.put(id,'order',101,normalizeReceipt(raw(101)));const item={shop:'Boutique',receiptId:101,etat:'envoye',carrier:'La Poste',trackingCode:'TEST_TRACKING',shippedAt:now};const zip=await writeExchangeArchive(envelope('suivis',[item]));
  const p=await imports.preview(zip);expect(p.entries[0]?.action).toContain('Envoyer');expect(calls.filter(c=>c.url.endsWith('/tracking'))).toHaveLength(0);await imports.confirm(p.token);
  const p2=await imports.preview(zip);await imports.confirm(p2.token);expect(calls.filter(c=>c.url.endsWith('/tracking'))).toHaveLength(1);
  const o=(await db.rows<any>(id,'order')).find(o=>o.id===101);expect(o.shipped).toBe(true);expect(o.name).toBeUndefined();expect(o.line1).toBeUndefined();
  const old=await imports.preview(await writeExchangeArchive(envelope('suivis',[{...item,etat:'a_preparer'}],now-1)));await imports.confirm(old.token);expect((await db.db.query<any>('SELECT data FROM suivis WHERE shop=$1 AND receipt_id=101',[id])).rows[0].data.etat).toBe('envoye');
 });
 it('ignore un reçu déjà expédié sur Etsy',async()=>{shipped=true;const p=await imports.preview(await writeExchangeArchive(envelope('suivis',[{shop:'Boutique',receiptId:101,etat:'envoye',carrier:null,trackingCode:'OTHER',shippedAt:now}])));expect(p.entries[0]?.action).not.toContain('Envoyer');shipped=false;});
 it('refuse une confirmation inconnue et un aperçu expiré',async()=>{await expect(imports.confirm(crypto.randomUUID())).rejects.toThrow();const p=await imports.preview(await writeExchangeArchive(envelope('fiches',[fiche])));imports.pending!.expires=now-1;await expect(imports.confirm(p.token)).rejects.toThrow();});
});
describe('Archives hostiles',()=>{
 it('refuse champs inconnus, versions et médias non référencés',async()=>{
  for(const json of [{...envelope('fiches',[fiche]),secret:'x'},{...envelope('fiches',[fiche]),version:2},envelope('fiches',[{...fiche,ref:'../bad'}])])await expect(imports.preview(await writeExchangeArchive(json))).rejects.toThrow();
  await expect(imports.preview(await writeExchangeArchive(envelope('fiches',[fiche]),new Map([['images/extra.png',Buffer.from([137,80,78,71,13,10,26,10])]])))).rejects.toThrow();
 });
 it('refuse fichiers inattendus, doublons, fausses images et archives illisibles',async()=>{
  for(const entries of [[['evil.txt',Buffer.from('x')]], [['echange.json',Buffer.from('{}')],['echange.json',Buffer.from('{}')]], [['echange.json',Buffer.from('{}')],['images/a.png',Buffer.from('<script>')]] ] as [string,Buffer][][])await expect(readExchangeArchive(await archive(entries))).rejects.toThrow();
  await expect(readExchangeArchive(Buffer.from('not zip'))).rejects.toThrow();expect(mediaKind(Buffer.from('<svg/>'))).toBeNull();
 });
 it('refuse les traversées et les bombes dépassant la taille JSON annoncée',async()=>{
  const zip=await archive([['echange.json',Buffer.from('{}')],['images/evil.png',Buffer.from([137,80,78,71,13,10,26,10])]]);const hostile=Buffer.from(zip);let i=0;while((i=hostile.indexOf('images/evil.png',i))!==-1){hostile.write('../xxx/evil.png',i);i+=15;}await expect(readExchangeArchive(hostile)).rejects.toThrow();
  const large=await archive([['echange.json',Buffer.alloc(20*1024*1024+1,32)]]);await expect(readExchangeArchive(large)).rejects.toThrow();
 });
});
describe('Serveur local et réseau',()=>{
 it('Host, Origin, CSRF, sécurité et réponses sans secrets',async()=>{
  const s=await Store.open('memory://');await s.add('Autre','LOCAL_KEY','LOCAL_SECRET');const {app}=await createApp(s,etsy);
  const host={host:'localhost:3030'},origin='https://localhost:3030';
  expect((await app.inject({url:'/api/session',headers:{host:'evil.test:3030'}})).statusCode).toBe(403);
  const session=await app.inject({url:'/api/session',headers:host});expect(session.statusCode).toBe(200);expect(session.headers['content-security-policy']).toContain("default-src 'self'");expect(session.headers['x-content-type-options']).toBe('nosniff');
  for(const headers of [{...host},{...host,origin},{...host,origin:'https://evil.test','x-csrf-token':session.json().csrf},{...host,origin,'x-csrf-token':'bad'}])expect((await app.inject({method:'POST',url:'/api/shops',headers,payload:{name:'X',keystring:'K',secret:'S'}})).statusCode).toBe(403);
  const valid={...host,origin,'x-csrf-token':session.json().csrf};expect((await app.inject({method:'POST',url:'/api/shops',headers:valid,payload:{name:'X',keystring:'K',secret:'S'}})).statusCode).toBe(200);
  const shops=await app.inject({url:'/api/shops',headers:host});expect(shops.body).not.toContain('LOCAL_KEY');expect(shops.body).not.toContain('LOCAL_SECRET');
  expect((await app.inject({url:'/api/shops',headers:{...host,origin:'null'}})).statusCode).toBe(403);expect((await app.inject({url:'/api/session',headers:{host:'localhost:3030'}})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/api/extract',headers:valid,payload:{shops:['x'],periode:'bad'}})).statusCode).toBe(400);
  expect((await app.inject({url:'/oauth/etsy/callback?state=bad&code=bad',headers:host})).statusCode).toBe(400);
  await app.close();expect(HOST).toBe('127.0.0.1');expect(PORT).toBe(3030);expect(readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')).toContain('host:HOST,port:PORT');
 });
 it('le code applicatif ne contient aucun accès réseau externe à Etsy',()=>{
  const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?walk(path.join(dir,d.name)):[path.join(dir,d.name)]);
  for(const file of [...walk(path.resolve(import.meta.dirname,'../src')),...walk(path.resolve(import.meta.dirname,'../../web/src'))]){
   const text=readFileSync(file,'utf8');for(const match of text.matchAll(/https?:\/\/[^\s'"`<>]+/g)){if(match[0] === 'https://${req.headers.host}')continue;const url=new URL(match[0]);expect(['api.etsy.com','www.etsy.com','127.0.0.1','localhost','www.studio-atelier-ets.com']).toContain(url.hostname);if(url.hostname==='www.studio-atelier-ets.com')expect(file.endsWith('main.tsx')).toBe(true);}
   expect(text).not.toMatch(/WebSocket|EventSource|sendBeacon|XMLHttpRequest|node:https|node:http['"]|from ['"](?:axios|undici)/);
   if(text.includes('fetch(')||text.includes('this.#fetch('))expect(file.endsWith('client.ts')||file.endsWith('main.tsx')).toBe(true);
   // le seul autre appel sortant : l'envoi au Studio réglé par l'utilisateur (studio.ts) ; l'adresse du Studio n'est qu'une valeur proposée dans le formulaire
   if(text.includes('fetchImpl('))expect(file.endsWith('studio.ts')).toBe(true);
  }
 });
});

describe('OAuth PKCE et écoute réelle',()=>{
 it('lie le rappel au navigateur, consomme le state et ne renvoie pas les jetons',async()=>{
  const s=await Store.open('memory://'),id=await s.add('OAuth','OAUTH_KEY','OAUTH_SECRET');
  const oauthClient=new EtsyClient({sleep:async()=>{},fetch:async(input)=>{
   const url=String(input);return new Response(JSON.stringify(url.endsWith('/token')?{access_token:'OAUTH_ACCESS',refresh_token:'OAUTH_REFRESH',expires_in:3600}:url.endsWith('/users/me')?{shop_id:9}:{currency_code:'EUR',created_timestamp:1}),{status:200});
  }});
  const {app}=await createApp(s,oauthClient),headers={host:'localhost:3030'},session=await app.inject({url:'/api/session',headers});
  const write={...headers,origin:'https://localhost:3030','x-csrf-token':session.json().csrf};
  const connect=await app.inject({method:'POST',url:`/api/shops/${id}/connect`,headers:write,payload:{}}),start=new URL(connect.json().url,'https://localhost:3030');
  expect(connect.body).not.toContain('OAUTH_KEY');
  const redirect=await app.inject({url:start.pathname+start.search,headers:{...headers,cookie:String(connect.headers['set-cookie']).split(';')[0]!}}),url=new URL(String(redirect.headers.location));
  expect(url.origin).toBe('https://www.etsy.com');expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('redirect_uri')).toBe('https://localhost:3030/oauth/etsy/callback');expect(url.searchParams.get('code_challenge')).toHaveLength(43);expect(connect.body).not.toContain('OAUTH_SECRET');
  expect(connect.headers['set-cookie']).toContain('; Secure;');
  const callback='/oauth/etsy/callback?code=mock&state='+url.searchParams.get('state');
  expect((await app.inject({url:callback,headers})).statusCode).toBe(400);
  const second=await app.inject({method:'POST',url:`/api/shops/${id}/connect`,headers:write,payload:{}}),state=new URL(second.json().url,'https://localhost:3030').searchParams.get('state');
  const cookie=String(second.headers['set-cookie']).split(';')[0]!;
  const success=await app.inject({url:'/oauth/etsy/callback?code=mock&state='+state,headers:{...headers,cookie}});expect(success.statusCode).toBe(302);expect(success.headers.location).toBe('/');expect(success.headers['set-cookie']).toContain('; Secure;');expect(success.headers['set-cookie']).toContain('Path=/oauth/etsy;');
  expect((await app.inject({url:'/oauth/etsy/callback?code=mock&state='+state,headers:{...headers,cookie}})).statusCode).toBe(400);
  expect((await s.credentials(id).load()).tokens?.access_token).toBe('OAUTH_ACCESS');const publicData=await app.inject({url:'/api/shops',headers});expect(publicData.body).not.toContain('OAUTH_ACCESS');expect(publicData.json()[0].connected).toBe(true);
  await app.close();
 });
 it('ouvre un socket uniquement sur 127.0.0.1',async()=>{
  const s=await Store.open('memory://'),{app}=await createApp(s,etsy);await app.listen({host:HOST,port:0});
  const address=app.server.address();expect(address&&typeof address==='object'?address.address:null).toBe('127.0.0.1');await app.close();
 });
 it('lit le zip complet avec le lecteur compatible Studio et accepte les anciens sans relevé',async()=>{
  const full=await readExchangeArchive(await extraction.export([id],'30j'),{media:false,releve:true});expect(releveFileSchema.safeParse(full.releve).success).toBe(true);
  const old=await readExchangeArchive(await writeExchangeArchive({old:true}),{media:false,releve:true});expect(old.releve).toBeUndefined();imports.dispose();
 });
});
