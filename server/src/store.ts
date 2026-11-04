import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SecretBox } from './core/secret.js';
import type { EtsyCredentials, EtsyCredentialStore } from './modules/connectors/etsy/client.js';
export interface Shop {id:string;name:string;credentials:string;etsy_id:number|null;currency:string;created:number|null}
export class Store {
 constructor(readonly db:PGlite,readonly secrets:SecretBox,readonly location='memory://') {}
 static async open(location=process.env.PASSERELLE_DATA ?? path.join(process.env.LOCALAPPDATA ?? '.', 'Passerelle')) {
  let key:Buffer;
  if(location==='memory://') key=crypto.randomBytes(32);
  else { fs.mkdirSync(location,{recursive:true});const file=path.join(location,'secret.key');
   if(!fs.existsSync(file))fs.writeFileSync(file,crypto.randomBytes(32),{flag:'wx',mode:0o600});
   key=fs.readFileSync(file);
  }
  const s=new Store(new PGlite(location==='memory://'?'memory://':path.join(location,'db')),new SecretBox(key),location);
  await s.db.exec(`CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,credentials TEXT NOT NULL,etsy_id BIGINT UNIQUE,currency TEXT NOT NULL DEFAULT '',created BIGINT);
  CREATE TABLE IF NOT EXISTS records(shop TEXT REFERENCES shops(id) ON DELETE CASCADE,kind TEXT,id TEXT,data JSONB NOT NULL,PRIMARY KEY(shop,kind,id));
  CREATE TABLE IF NOT EXISTS imported_fiches(ref TEXT PRIMARY KEY,shop TEXT REFERENCES shops(id) ON DELETE CASCADE,listing_id BIGINT,status TEXT NOT NULL DEFAULT 'ready',created_at BIGINT NOT NULL);
  CREATE TABLE IF NOT EXISTS suivis(shop TEXT REFERENCES shops(id) ON DELETE CASCADE,receipt_id BIGINT,data JSONB NOT NULL,created_at BIGINT NOT NULL,sent BOOLEAN NOT NULL DEFAULT false,PRIMARY KEY(shop,receipt_id));`);
  await s.db.exec("ALTER TABLE suivis ADD COLUMN IF NOT EXISTS send_status TEXT NOT NULL DEFAULT 'pending'; UPDATE suivis SET send_status='uncertain' WHERE sent=true AND send_status='pending';");
  await s.db.exec("UPDATE records SET data=jsonb_set(data,'{desc}','\"\"'::jsonb) WHERE kind='operation';");
  for(const row of (await s.db.query<{shop:string;id:string;data:unknown}>("SELECT shop,id,data FROM records WHERE kind='order'")).rows)await s.put(row.shop,'order',row.id,row.data);
  await s.db.exec("CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY,shop TEXT REFERENCES shops(id) ON DELETE CASCADE,label TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',result TEXT NOT NULL DEFAULT '',position BIGSERIAL); UPDATE import_jobs SET status='pending' WHERE status='running';");
   return s;
 }
 async shops(){return (await this.db.query<Shop>('SELECT * FROM shops ORDER BY name')).rows;}
 async shop(id:string){const s=(await this.shops()).find(s=>s.id===id);if(!s)throw new Error('Boutique introuvable');return s;}
 async add(name:string,keystring:string,secret:string){const id=crypto.randomUUID();await this.db.query('INSERT INTO shops(id,name,credentials) VALUES($1,$2,$3)',[id,name,this.secrets.seal(JSON.stringify({keystring,secret,tokens:null}),id)]);return id;}
 credentials(id:string):EtsyCredentialStore { return {load:async()=>{const s=await this.shop(id);return JSON.parse(this.secrets.open(s.credentials,id)) as EtsyCredentials;},saveTokens:async tokens=>{const c=await this.credentials(id).load();await this.db.query('UPDATE shops SET credentials=$1 WHERE id=$2',[this.secrets.seal(JSON.stringify({...c,tokens}),id),id]);}}; }
 async put(shop:string,kind:string,id:string|number,data:unknown){
  if(kind==='order')data=privateOrder(data as Record<string,any>);
  if(kind==='operation')data={...(data as object),desc:''};
  await this.db.query('INSERT INTO records VALUES($1,$2,$3,$4) ON CONFLICT(shop,kind,id) DO UPDATE SET data=excluded.data',[shop,kind,String(id),JSON.stringify(data)]);}
 async rows<T>(shop:string,kind:string):Promise<T[]>{return (await this.db.query<{data:T}>('SELECT data FROM records WHERE shop=$1 AND kind=$2 ORDER BY id',[shop,kind])).rows.map(r=>r.data);}
}

// Liste autorisée : purge aussi les alias et notes des anciens caches.
export function privateOrder(o:Record<string,any>){
 const active=!!o.paid&&!o.shipped&&!o.refunds?.length&&!['completed','canceled','cancelled','fully refunded','refunded'].includes(String(o.status).toLowerCase());
 const fields=['id','paidAt','t','status','paid','country','currency','totalPrice','subtotal','shipping','tax','discount','giftWrap','grandtotal','refunds','shipped'];
 if(active)fields.push('name','address','line1','line2','city','state','zip','email','phone','message');
 const out:Record<string,any>=Object.fromEntries(fields.filter(k=>k in o).map(k=>[k,o[k]]));
 out.refunds=(o.refunds??[]).map((r:Record<string,any>)=>({amount:r.amount,t:r.t??null}));
 out.items=(o.items??[]).map((i:Record<string,any>)=>({id:i.id,listingId:i.listingId??null,sku:active?i.sku??null:null,title:active?i.title:'',qty:i.qty,price:i.price,variations:active?i.variations:'',...(active?{options:i.options??[]}:{})}));
 if(active)out.shipments=o.shipments??[];
 return out;
}
