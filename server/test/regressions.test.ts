import yauzl from 'yauzl';
import { normalizeReceipt } from '../src/modules/compta/normalize.js';
import { catalogueFileSchema } from '@passerelle/shared';
import { it,expect,vi } from 'vitest';
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { Store } from '../src/store.js';
import { EtsyClient } from '../src/modules/connectors/etsy/client.js';
import { createApp } from '../src/app.js';
import { Extraction } from '../src/extraction.js';
import { Imports } from '../src/imports.js';
import { writeExchangeArchive,readExchangeArchive } from '../src/core/echange.js';
const now=Math.floor(Date.now()/1000)*1000,money={amount:1200,divisor:100,currency_code:'EUR'};
const receipt=(id:number,shipped=false)=>({receipt_id:id,is_paid:true,is_shipped:shipped,status:'paid',country_iso:'FR',name:'Camille Exemple',first_line:'12 rue Fictive',city:'Ville Exemple',zip:'75001',created_timestamp:now/1000-60,grandtotal:money,transactions:[{transaction_id:id,listing_id:10,title:'Tasse exemple',quantity:1,paid_timestamp:now/1000-60,price:money}]});
async function setup(){
 const store=await Store.open('memory://'),id=await store.add('Exemple','FAKE_KEY','FAKE_SECRET');
 await store.credentials(id).saveTokens({access_token:'FAKE_ACCESS',refresh_token:'FAKE_REFRESH',expires_at:now+86400000});
 await store.db.query('UPDATE shops SET etsy_id=1,currency=$1 WHERE id=$2',['EUR',id]);
 await store.put(id,'settings','defaults',{shippingProfileId:5,readinessStateId:6});
 const calls:{url:string;method:string;body:string}[]=[],tracking={status:200,lost:false};
 const etsy=new EtsyClient({now:()=>now,sleep:async()=>{},fetch:async(input,init)=>{
  const url=String(input),method=init?.method??'GET';calls.push({url,method,body:String(init?.body??'')});let body:unknown={};
  if(url.endsWith('/tracking')){if(tracking.lost)throw new Error('simulated lost response');return new Response('{}',{status:tracking.status});}
  if(url.endsWith('/users/me'))body={shop_id:1};
  else if(url.endsWith('/shops/1'))body={shop_name:'Exemple Etsy',currency_code:'EUR',created_timestamp:now/1000-3600};
  else if(url.includes('/sections?'))body={results:[{shop_section_id:7,title:'Tasses'}],count:1};
  else if(url.includes('/shipping-profiles?'))body={results:[{shipping_profile_id:5,title:'France',origin_country_iso:'FR',origin_postal_code:'00000',shipping_profile_destinations:[{destination_country_iso:'FR',primary_cost:money,secondary_cost:money}]}],count:1};
  else if(url.includes('/reviews?'))body={results:[{listing_id:10,rating:5,create_timestamp:now/1000,buyer_user_id:987654321,review:'AVIS_IDENTITE_PRIVEE',buyer_name:'AVIS_NOM_PRIVE'}],count:1};
  else if(url.endsWith('/listings/10/inventory'))body={products:[{sku:'SKU_BLEU',property_values:[{property_name:'Couleur',values:['Bleu']}],offerings:[{price:money,quantity:5,is_enabled:true}]}]};
  else if(url.includes('/listings/10/images?'))body={results:[{url_fullxfull:'https://example.com/image.jpg'}],count:1};
  else if(url.includes('/receipts/'))body=receipt(Number(url.split('/').at(-1)));
  else if(url.includes('/receipts?'))body={results:[receipt(1),receipt(2),receipt(3,true)],count:3};
  else if(url.includes('/ledger-entries?'))body={results:[{entry_id:8,amount:-100,currency:'EUR',ledger_type:'fee',created_timestamp:now/1000-1}],count:1};
  else if(url.includes('/listings?')){const active=url.includes('state=active');body={results:active?[{listing_id:10,title:'Tasse exemple',description:'Description complète',materials:['argile'],skus:['SKU_BLEU'],shop_section_id:7,state:'active',price:money,quantity:5,views:42,num_favorers:3,tags:['tasse']}]:[],count:active?1:0};}
  else if(url.endsWith('/shops/1/listings')&&method==='POST')body={listing_id:55};
  else if(url.endsWith('/listings/55'))body={listing_id:55,shop_id:1,state:'draft'};
  return new Response(JSON.stringify(body),{status:200});
 }});
 return {store,id,etsy,calls,tracking};
}
const envelope=(type:string,items:unknown[])=>({format:'atelier-echange',version:1,type,from:'studio',createdAt:now,items});
it('applique une annulation importée avant chaque écriture et export suivant',async()=>{
 const {store,id,etsy}=await setup(),imports=new Imports(store,etsy),extraction=new Extraction(store,etsy);
 try{
  const p=await imports.preview(await writeExchangeArchive(envelope('suivis',[{shop:'Exemple',receiptId:1,etat:'annule',carrier:null,trackingCode:null,shippedAt:null}])));await imports.confirm(p.token);
  const put=vi.spyOn(store,'put');await extraction.sync(await store.shops());
  const writes=put.mock.calls.filter(c=>c[1]==='order'&&Number(c[2])===1);expect(writes.length).toBeGreaterThan(0);
  for(const c of writes){expect(c[3]).toMatchObject({status:'canceled'});expect(JSON.stringify(c[3])).not.toContain('Camille Exemple');expect(JSON.stringify(c[3])).not.toContain('rue Fictive');}
  const zip=await readExchangeArchive(await extraction.export([id],'30j'),{media:false,releve:true});
  expect((zip.json as any).commandes.map((o:any)=>o.receiptId)).toEqual([2]);expect((await store.rows<any>(id,'order')).find(o=>o.id===1).status).toBe('canceled');
 }finally{imports.dispose();await store.db.close();}
});
it('permet une nouvelle confirmation après refus certain et bloque réseau perdu et 5xx',async()=>{
 const {store,id,etsy,calls,tracking}=await setup(),imports=new Imports(store,etsy);
 const send=async(receiptId:number)=>{const p=await imports.preview(await writeExchangeArchive(envelope('suivis',[{shop:'Exemple',receiptId,etat:'envoye',carrier:'La Poste',trackingCode:'FICTIF',shippedAt:now}])));return imports.confirm(p.token);};
 const status=async(n:number)=>(await store.db.query<any>('SELECT sent,send_status FROM suivis WHERE shop=$1 AND receipt_id=$2',[id,n])).rows[0];
 try{
  tracking.status=400;await send(1);expect(await status(1)).toMatchObject({sent:false,send_status:'rejected'});
  tracking.status=200;await send(1);expect(await status(1)).toMatchObject({sent:true,send_status:'success'});await send(1);expect(calls.filter(c=>c.url.endsWith('/1/tracking'))).toHaveLength(2);
  for(const n of [2,3]){tracking.lost=n===2;tracking.status=500;await send(n);expect(await status(n)).toMatchObject({sent:false,send_status:'uncertain'});tracking.lost=false;tracking.status=200;await send(n);expect(calls.filter(c=>c.url.endsWith(`/${n}/tracking`))).toHaveLength(1);}
 }finally{imports.dispose();await store.db.close();}
});
it('remplace les variantes par un produit simple lors du réimport',async()=>{
 const {store,etsy,calls}=await setup(),imports=new Imports(store,etsy);
 const fiche={ref:'st_simple',shop:'Exemple',title:'Tasse',description:'Exemple',tags:[],materials:[],price:{amount:12,currency:'EUR'},quantity:4,whoMade:'i_did',whenMade:'made_to_order',isSupply:false,productionPartner:null,taxonomyId:1,language:'fr',translations:{},images:[],video:null};
 try{
  for(const variations of [{properties:[{name:'Couleur',values:['Bleu','Vert']}],combinations:[{values:['Bleu'],price:12,sku:'BLEU'},{values:['Vert'],price:14,sku:'VERT'}]},null]){const p=await imports.preview(await writeExchangeArchive(envelope('fiches',[{...fiche,variations}])));expect(p.accepted).toBe(1);await imports.confirm(p.token);}
  const inventory=calls.filter(c=>c.url.endsWith('/inventory'));expect(inventory).toHaveLength(2);expect(JSON.parse(inventory[0]!.body).products).toHaveLength(2);
  expect(JSON.parse(inventory[1]!.body)).toEqual({products:[{sku:'',property_values:[],offerings:[{price:12,quantity:4,is_enabled:true,readiness_state_id:6}]}],price_on_property:[],quantity_on_property:[],sku_on_property:[],readiness_state_on_property:[]});
 }finally{imports.dispose();await store.db.close();}
});
it('installe les dépendances manquantes avant de préparer et démarrer, sans exécuter npm',async()=>{
 const source=readFileSync(new URL('../../scripts/launch.mjs',import.meta.url),'utf8').replace(/^\uFEFF?import .*;\r?\n/gm,'').replaceAll('import.meta.dirname','launcherDir');
 const commands:string[]=[],messages:string[]=[],spawn=(_command:string,args:string[])=>{commands.push(args.at(-1)!);const child=new EventEmitter() as EventEmitter&{unref:()=>void};child.unref=()=>{};queueMicrotask(()=>child.emit('exit',0));return child;};
 const run=new Function('existsSync','readdirSync','statSync','spawn','path','process','launcherDir','console','fetch','AbortSignal',`return (async()=>{${source}})();`);
 await run(()=>false,()=>[],()=>({isDirectory:()=>false,mtimeMs:0}),spawn,path,{chdir:()=>{},versions:{node:'24.0.0'},platform:'win32'},'.',{log:(s:string)=>messages.push(s)},async()=>({ok:true}),AbortSignal);
 expect(commands.slice(0,3)).toEqual(['npm ci','npm run build','npm start']);expect(messages.join(' ')).toContain('npm ci');expect(messages.join(' ')).toContain('Internet');
});
it('parcourt HTTP avec Etsy simulé et réécrit boutique-exemple.zip à chaque exécution',async()=>{
 const fetch=(url:string,init:{headers:Record<string,string>;method?:string;body?:string})=>new Promise<Response>((resolve,reject)=>{
  const req=request(url,{method:init.method,headers:init.headers},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:{'content-type':String(res.headers['content-type'])}})));});
  req.on('error',reject);req.end(init.body);
 });
 const {store,id,etsy}=await setup(),{app}=await createApp(store,etsy),host={host:'127.0.0.1:3030'};
 try{
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing local socket');
  const base='http://127.0.0.1:'+address.port;
  const session=await fetch(base+'/api/session',{headers:host});const headers={...host,origin:'http://127.0.0.1:3030','x-csrf-token':(await session.json()).csrf,'content-type':'application/json'};
  const start=await fetch(base+'/api/extract',{method:'POST',headers,body:JSON.stringify({shops:[id],periode:'30j'})});expect(start.status).toBe(200);
  let state:any;for(let n=0;n<200;n++){const response=await fetch(base+'/api/extract/state',{headers:host});expect(response.status).toBe(200);state=await response.json();if(!state.running)break;await new Promise(resolve=>setTimeout(resolve,5));}
  expect(state).toMatchObject({running:false,ready:true,error:null});
  const response=await fetch(base+'/api/extract/download',{headers:host});expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/zip');const payload=Buffer.from(await response.arrayBuffer());
  const zip=await readExchangeArchive(payload,{media:false,releve:true}),data=zip.json as any,releve=zip.releve as any;
  expect(data.commandes).toHaveLength(2);expect(data.annonces).toHaveLength(1);expect(releve.boutiques[0].commandes).toHaveLength(3);expect(releve.boutiques[0].operations).toHaveLength(1);expect(releve.boutiques[0].vues).toHaveLength(1);
  const compatibleResponse=await fetch(base+'/api/extract/download?studio=1',{headers:host});expect(compatibleResponse.status).toBe(200);
  const compatible=await everyZipEntry(Buffer.from(await compatibleResponse.arrayBuffer()));expect([...compatible.keys()].sort()).toEqual(['echange.json','releve.json']);expect(JSON.parse(compatible.get('echange.json')!)).toEqual(data);
  expect([...(await everyZipEntry(payload)).keys()].sort()).toEqual(['echange.json','releve.json']);
  const extendedResponse=await fetch(base+'/api/extract/download?catalogue=1',{headers:host});expect(extendedResponse.status).toBe(200);
  const extended=await everyZipEntry(Buffer.from(await extendedResponse.arrayBuffer()));expect([...extended.keys()].sort()).toEqual(['catalogue.json','echange.json','releve.json']);
  expect(JSON.parse(extended.get('echange.json')!)).toEqual(data);expect(JSON.parse(extended.get('releve.json')!)).toEqual(releve);
  expect(catalogueFileSchema.safeParse(JSON.parse(extended.get('catalogue.json')!)).success).toBe(true);
  const target=new URL('./fixtures/boutique-exemple.zip',import.meta.url);mkdirSync(new URL('./fixtures/',import.meta.url),{recursive:true});writeFileSync(target,payload);
 }finally{await app.close();}
});

async function everyZipEntry(buffer:Buffer):Promise<Map<string,string>>{return new Promise((resolve,reject)=>{yauzl.fromBuffer(buffer,{lazyEntries:true},(err,zip)=>{if(err)return reject(err);const out=new Map<string,string>();zip.on('error',reject);zip.on('end',()=>resolve(out));zip.on('entry',entry=>zip.openReadStream(entry,(err,stream)=>{if(err)return reject(err);const chunks:Buffer[]=[];stream.on('error',reject);stream.on('data',b=>chunks.push(b));stream.on('end',()=>{out.set(entry.fileName,Buffer.concat(chunks).toString('utf8'));zip.readEntry();});}));zip.readEntry();});});}
it('parcourt chaque fichier du ZIP et la base sans identité de commande terminée',async()=>{
 const {store,id,etsy}=await setup();const extraction=new Extraction(store,etsy,()=>now);
 try{
  await extraction.sync(await store.shops());
  const markers=['FIN_NOM','FIN_PRENOM','FIN_RUE','FIN_EMAIL@example.com','FIN_TELEPHONE','FIN_MESSAGE','FIN_USER_ID','FIN_NOTE','FIN_AVIS','FIN_SKU','FIN_PERSONNALISATION'];
  for(const [n,extra] of [{is_shipped:true},{status:'completed'},{status:'canceled'},{status:'refunded'},{refunds:[{amount:money,created_timestamp:now/1000}]},{is_paid:false}].entries()){
   const raw={...receipt(100+n),...extra,name:markers[0],first_name:markers[1],first_line:markers[2],buyer_email:markers[3],phone:markers[4],message_from_buyer:markers[5],buyer_user_id:markers[6],note_from_buyer:markers[7],review:markers[8],transactions:[{transaction_id:100+n,listing_id:10,title:markers[10],quantity:1,price:money,sku:markers[9],variations:[{formatted_name:'Nom',formatted_value:markers[10]}]}]};
   // Simule aussi un ancien cache enrichi d'alias bruts.
   await store.put(id,'order',100+n,{...normalizeReceipt(raw),buyer_email:markers[3],buyer_user_id:markers[6],recipient_name:markers[0],notes:markers[7],messages:markers[5],review:markers[8]});
  }
  const files=await everyZipEntry(await extraction.export([id],'tout'));
  expect([...files.keys()].sort()).toEqual(['catalogue.json','echange.json','releve.json']);
  for(const [name,content] of files)for(const marker of markers)expect(content,name).not.toContain(marker);
  const stored=JSON.stringify((await store.db.query('SELECT data FROM records')).rows);
  for(const marker of markers)expect(stored).not.toContain(marker);
  const catalogue=JSON.parse(files.get('catalogue.json')!);expect(catalogueFileSchema.safeParse(catalogue).success).toBe(true);
  expect(catalogue.boutiques[0]).toMatchObject({name:'Exemple Etsy',currency:'EUR',sections:[{id:7,title:'Tasses'}],reviews:[{listingId:10,rating:5,created:now/1000}]});
  expect(catalogue.boutiques[0].annonces[0]).toMatchObject({description:'Description complète',materials:['argile'],sku:['SKU_BLEU'],sectionId:7,images:['https://example.com/image.jpg'],products:[{sku:'SKU_BLEU',properties:[{name:'Couleur',values:['Bleu']}],offerings:[{price:12,currency:'EUR',quantity:5,enabled:true}]}]});
  expect(JSON.stringify(catalogue)).not.toContain('AVIS_IDENTITE_PRIVEE');expect(stored).not.toContain('AVIS_NOM_PRIVE');expect(stored).not.toContain('987654321');
 }finally{await store.db.close();}
});
it('enregistre sans écriture Etsy, reprend après interruption et ne rejoue pas les réussites',async()=>{
 const {store,etsy,calls,tracking}=await setup();let imports=new Imports(store,etsy,()=>now);
 try{
  const initial=calls.length;const p=await imports.preview(await writeExchangeArchive(envelope('suivis',[{shop:'Exemple',receiptId:1,etat:'envoye',carrier:'La Poste',trackingCode:'FICTIF_REPRISE',shippedAt:now},{shop:'Exemple',receiptId:2,etat:'envoye',carrier:'La Poste',trackingCode:'FICTIF_REPRISE_2',shippedAt:now}])));
  expect(calls).toHaveLength(initial);const before=calls.length;await imports.enqueue(p.token);expect(calls.length).toBe(before);expect((await imports.state()).pending).toBe(2);
  expect(JSON.stringify((await store.db.query('SELECT payload FROM import_jobs')).rows)).not.toContain('FICTIF_REPRISE');
  await store.db.query("UPDATE import_jobs SET status='running' WHERE id=(SELECT id FROM import_jobs ORDER BY position LIMIT 1)");
  imports.dispose();imports=new Imports(store,etsy,()=>now);
  tracking.status=400;await imports.synchronize();expect((await imports.state()).pending).toBe(2);
  tracking.status=200;await imports.synchronize();expect((await imports.state()).pending).toBe(0);
  const writes=calls.filter(c=>c.method!=='GET').length;await imports.synchronize();expect(calls.filter(c=>c.method!=='GET')).toHaveLength(writes);
  expect((await store.db.query<{payload:string}>('SELECT payload FROM import_jobs')).rows.every(r=>!r.payload)).toBe(true);
 }finally{imports.dispose();await store.db.close();}
});

it('garde un suivi incertain dans la file sans le renvoyer après reprise',async()=>{
 const {store,etsy,calls,tracking}=await setup();let imports=new Imports(store,etsy,()=>now);
 try{
  const p=await imports.preview(await writeExchangeArchive(envelope('suivis',[{shop:'Exemple',receiptId:1,etat:'envoye',carrier:'La Poste',trackingCode:'FICTIF_INCERTAIN',shippedAt:now}])));
  await imports.enqueue(p.token);tracking.lost=true;await imports.synchronize();expect((await imports.state()).pending).toBe(1);
  const count=calls.filter(c=>c.url.endsWith('/tracking')).length;
  tracking.lost=false;imports.dispose();imports=new Imports(store,etsy,()=>now);await imports.synchronize();
  expect(calls.filter(c=>c.url.endsWith('/tracking'))).toHaveLength(count);expect((await imports.state()).entries[0]?.status).toBe('failed');
 }finally{imports.dispose();await store.db.close();}
});

it('anonymise le releve des commandes en cours personnalisees',async()=>{
 const {store,id,etsy}=await setup();
 try{
  const o=normalizeReceipt(receipt(42));
  Object.assign(o,{name:'Alice Dupont',email:'alice@example.com',phone:'0123456789',message:'Pour Alice Dupont'});
  Object.assign(o.items[0]!,{title:'Tasse Alice Dupont',sku:'Alice Dupont',variations:'Nom : Alice Dupont',options:[{name:'Nom',value:'Alice Dupont'}]});
  await store.put(id,'order',42,o);
  const archive=await readExchangeArchive(await new Extraction(store,etsy,()=>now).export([id],'tout'),{media:false,releve:true});
  expect(JSON.stringify(archive.releve)).not.toContain('Alice');
  expect(JSON.stringify(archive.releve)).not.toContain('alice@example.com');
  expect((archive.releve as any).boutiques[0].commandes[0].items[0]).toMatchObject({title:'',sku:null,variations:'',qty:1,price:12,listingId:10});
  expect((archive.json as any).commandes[0]).toMatchObject({shipTo:{name:'Alice Dupont'},items:[{title:'Tasse Alice Dupont',variation:'Nom : Alice Dupont'}]});
  expect((archive.catalogue as any).boutiques[0].contacts[0]).toMatchObject({receiptId:42,email:'alice@example.com',phone:'0123456789',message:'Pour Alice Dupont'});
  expect((await store.rows<any>(id,'order'))[0].items[0].variations).toBe('Nom : Alice Dupont');
 }finally{await store.db.close();}
});
