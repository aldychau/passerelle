import { expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { EtsyClient } from '../src/modules/connectors/etsy/client.js';

it('importe les vrais exports Studio par HTTP sans publication ni doublon',async()=>{
 const store=await Store.open('memory://');
 const shop=await store.add('Exemple','TEST_KEY','TEST_SECRET');
 await store.credentials(shop).saveTokens({access_token:'TEST_ACCESS',refresh_token:'TEST_REFRESH',expires_at:Date.now()+3600000});
 await store.db.query('UPDATE shops SET etsy_id=1,currency=$1 WHERE id=$2',['EUR',shop]);
 await store.put(shop,'settings','defaults',{shippingProfileId:5,readinessStateId:6});
 const calls:{method:string;path:string;body:unknown}[]=[];
 const listings=new Map<number,{listing_id:number;shop_id:number;state:string}>();
 const unexpected:string[]=[];
 const etsy=new EtsyClient({sleep:async()=>{},fetch:async(input,init)=>{
  const url=new URL(String(input)),route=url.pathname.replace('/v3/application',''),method=init?.method??'GET';
  const body=init?.body instanceof FormData?init.body:new URLSearchParams(String(init?.body??''));
  calls.push({method,path:route,body});
  let result:unknown;
  if(method==='POST'&&route==='/shops/1/listings'){
   // Etsy crée les annonces en brouillon par défaut.
   const listing={listing_id:55,shop_id:1,state:String(body.get('state')??'draft')};
   listings.set(55,listing);result=listing;
  }else if(method==='GET'&&route==='/listings/55')result=listings.get(55);
  else if(method==='PATCH'&&route==='/shops/1/listings/55'){
   const state=body.get('state');if(state)listings.get(55)!.state=String(state);result=listings.get(55);
  }else if(method==='PUT'&&route==='/listings/55/inventory')result={};
  else if(method==='POST'&&route==='/shops/1/listings/55/images')result={listing_image_id:100};
  else if(method==='GET'&&/^\/shops\/1\/receipts\/[12]$/.test(route)){
   // Le reçu reste non expédié : le rejeu doit être bloqué par la Passerelle elle-même.
   result={receipt_id:Number(route.split('/').at(-1)),is_shipped:false};
  }else if(method==='POST'&&route==='/shops/1/receipts/1/tracking')result={};
  else{unexpected.push(`${method} ${route}`);throw new Error('Appel Etsy inattendu');}
  return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
 }});
 const {app}=await createApp(store,etsy);
 try{
  const headers={host:'127.0.0.1:3030'};
  const session=await app.inject({url:'/api/session',headers});
  expect(session.statusCode).toBe(200);
  const write={...headers,origin:'http://127.0.0.1:3030','x-csrf-token':session.json().csrf};
  const run=async(name:string,accepted:number)=>{
   const before=calls.length;
   const preview=await app.inject({method:'POST',url:'/api/import/preview',headers:{...write,'content-type':'application/zip'},payload:readFileSync(new URL(`./fixtures/${name}-exemple.zip`,import.meta.url))});
   expect(preview.statusCode,preview.body).toBe(200);
   expect(preview.json().accepted,preview.body).toBe(accepted);
   expect(calls.slice(before).every(c=>c.method==='GET')).toBe(true);
   const confirm=await app.inject({method:'POST',url:'/api/import/confirm',headers:write,payload:{token:preview.json().token}});
   expect(confirm.statusCode,confirm.body).toBe(200);
   expect(calls.slice(before).every(c=>c.method==='GET')).toBe(true);
   expect(confirm.json().pending).toBe(accepted);
   const start=await app.inject({method:'POST',url:'/api/import/sync',headers:write,payload:{}});
   expect(start.statusCode).toBe(200);
   let state:any;for(let n=0;n<200;n++){state=(await app.inject({url:'/api/import/state',headers})).json();if(!state.running)break;await new Promise(resolve=>setTimeout(resolve,5));}
   expect(state.pending).toBe(0);
   expect(state.log).toHaveLength(accepted);
   for(const line of state.log)expect(line).toContain('terminé');
   const reused=await app.inject({method:'POST',url:'/api/import/confirm',headers:write,payload:{token:preview.json().token}});
   expect(reused.statusCode).toBe(400);
   expect(listings.get(55)?.state).toBe('draft');
  };
  await run('fiches',1);
  expect(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/images'))).toHaveLength(2);
  await run('suivis',2);
  await run('fiches',1);
  await run('suivis',2);
  expect(unexpected).toEqual([]);
  expect(calls.filter(c=>c.method==='POST'&&c.path==='/shops/1/listings')).toHaveLength(1);
  expect(listings.size).toBe(1);
  expect(calls.filter(c=>c.method==='PATCH'&&c.path==='/shops/1/listings/55')).toHaveLength(1);
  const tracking=calls.filter(c=>c.path.endsWith('/tracking'));
  expect(tracking).toHaveLength(1);
  expect((tracking[0]!.body as URLSearchParams).get('tracking_code')).toBe('EXEMPLE-FICTIF-001');
  expect((tracking[0]!.body as URLSearchParams).get('carrier_name')).toBe('Colissimo');
  for(const call of calls.filter(c=>c.method!=='GET'))expect((call.body as URLSearchParams).get('state')).toBeNull();
  expect((await store.db.query('SELECT * FROM imported_fiches')).rows).toHaveLength(1);
  const suivis=await store.db.query<{receipt_id:number;sent:boolean}>('SELECT receipt_id,sent FROM suivis ORDER BY receipt_id');
  expect(suivis.rows).toEqual([{receipt_id:1,sent:true},{receipt_id:2,sent:false}]);
 }finally{await app.close();}
});
