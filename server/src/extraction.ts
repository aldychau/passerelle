import { boutiqueFileSchema, releveFileSchema, periodeStart, RELEVE_LIMITS, type EchangePeriode, type Order, type Listing, type LedgerEntry } from '@passerelle/shared';
import { normalizeReceipt, normalizeListing, normalizeLedger } from './modules/compta/normalize.js';
import { EtsyClient } from './modules/connectors/etsy/client.js';
import { Store, type Shop } from './store.js';
import { writeExchangeArchive } from './core/echange.js';
type Raw=Record<string,any>;
type RichListing=Listing & {tags:string[];created:number|null;expires:number|null};
export class Extraction {
 state:{running:boolean;log:string[];ready:boolean;error:string|null}={running:false,log:[],ready:false,error:null};
 zip:Buffer|null=null;
 constructor(readonly store:Store,readonly etsy:EtsyClient,readonly now=Date.now){}
 async sync(shops:Shop[]){
  for(const shop of shops){
   const creds=this.store.credentials(shop.id);if(!(await creds.load()).tokens)throw new Error('Boutique déconnectée');
   const me=await this.etsy.get<Raw>(creds,'/users/me');const id=Number(me.shop_id ?? shop.etsy_id);if(shop.etsy_id&&Number(shop.etsy_id)!==id)throw new Error('Le compte Etsy a changé de boutique.');if(!id)throw new Error('Aucune boutique Etsy');
   const info=await this.etsy.get<Raw>(creds,`/shops/${id}`);
   await this.store.db.query('UPDATE shops SET etsy_id=$1,currency=$2,created=$3 WHERE id=$4',[id,info.currency_code??'',info.created_timestamp??null,shop.id]);
   this.state.log.push(`${shop.name} : commandes`);
   const receipts=await this.etsy.paginate<Raw>(creds,`/shops/${id}/receipts`,{},n=>{this.state.log[this.state.log.length-1]=`${shop.name} : commandes ${n}`;});
   for(const r of receipts){
    const etat=(await this.store.db.query<{data:Raw}>('SELECT data FROM suivis WHERE shop=$1 AND receipt_id=$2',[shop.id,r.receipt_id])).rows[0]?.data.etat;
    await this.store.put(shop.id,'order',r.receipt_id,normalizeReceipt({...r,...(etat==='annule'?{status:'canceled'}:etat==='envoye'?{is_shipped:true}:{})}));
   }
   // Un état Studio expédié efface aussi les coordonnées avant la prochaine lecture Etsy.
   for(const o of await this.store.rows<Order>(shop.id,'order')){
    const sent=(await this.store.db.query<{data:Raw}>('SELECT data FROM suivis WHERE shop=$1 AND receipt_id=$2',[shop.id,o.id])).rows[0]?.data.etat==='envoye';
    if(sent||o.shipped||['canceled','cancelled','fully refunded','refunded'].includes(o.status)){
     for(const k of ['name','address','line1','line2','city','state','zip'] as const)delete o[k];
     if(sent)o.shipped=true;await this.store.put(shop.id,'order',o.id,o);
    }
   }
   const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());
   for(const state of ['active','sold_out','inactive','expired','draft']){
    this.state.log.push(`${shop.name} : annonces ${state}`);
    for(const r of await this.etsy.paginate<Raw>(creds,`/shops/${id}/listings`,{state,includes:'Images'})){
     const l={...normalizeListing(r),tags:r.tags??[],created:r.original_creation_timestamp??null,expires:r.ending_timestamp??null};
     await this.store.put(shop.id,'listing',l.id,l);
     await this.store.put(shop.id,'view',`${day}:${l.id}`,{day,listingId:l.id,views:l.views,favorites:l.favorites});
    }
   }
   const nowS=Math.floor(this.now()/1000), orders=await this.store.rows<Order>(shop.id,'order');
   let cursor=Math.max(0,orders.reduce((min,o)=>Math.min(min,o.t??nowS),info.created_timestamp??nowS)-86400);
   while(cursor<nowS){const end=Math.min(cursor+30*86400,nowS);this.state.log.push(`${shop.name} : relevé ${new Date(cursor*1000).toISOString().slice(0,10)}`);
    for(const r of await this.etsy.paginate<Raw>(creds,`/shops/${id}/payment-account/ledger-entries`,{min_created:cursor,max_created:end}))await this.store.put(shop.id,'operation',r.entry_id,normalizeLedger(r));cursor=end;
   }
   this.state.log.push(`${shop.name} : vues du jour enregistrées`);
  }
 }
 async export(ids:string[],periode:EchangePeriode){
  const commandes:unknown[]=[],annonces:unknown[]=[],boutiques:unknown[]=[];
  for(const s of await this.store.shops()){
   if(!ids.includes(s.id))continue;
   const orders=await this.store.rows<Order>(s.id,'order'),listings=await this.store.rows<RichListing>(s.id,'listing');
   const refs=new Map((await this.store.db.query<{listing_id:number;ref:string}>('SELECT listing_id,ref FROM imported_fiches WHERE shop=$1',[s.id])).rows.map(r=>[Number(r.listing_id),r.ref]));
   for(const o of orders){const paidAt=o.paidAt??(o.t?o.t*1000:null);
    if(!o.paid||o.shipped||['completed','canceled','cancelled','fully refunded','refunded'].includes(o.status)||!paidAt||paidAt<periodeStart(periode,this.now())||!o.country||!o.items.length)continue;
    commandes.push({shop:s.name,receiptId:o.id,paidAt,items:o.items.map(i=>({listingId:i.listingId,ref:refs.get(i.listingId??0)??null,title:i.title,variation:i.variations,options:i.options??[],sku:i.sku??null,quantity:i.qty,image:listings.find(l=>l.id===i.listingId)?.image??null})),shipTo:{country:o.country,name:o.name??'',line1:o.line1??'',line2:o.line2??'',city:o.city??'',state:o.state??'',zip:o.zip??''}});
   }
   for(const l of listings)annonces.push({shop:s.name,listingId:l.id,ref:refs.get(l.id)??null,title:l.title,state:l.state,image:l.image,sales:orders.reduce((n,o)=>n+o.items.filter(i=>i.listingId===l.id).reduce((n,i)=>n+i.qty,0),0),variations:[...new Set(orders.flatMap(o=>o.items.filter(i=>i.listingId===l.id).map(i=>i.variations)))],hasVideo:false});
   boutiques.push({shop:s.name,currency:s.currency,commandes:orders.map(o=>({id:o.id,paidAt:o.paidAt??null,t:o.t,status:o.status,paid:o.paid,country:o.country,currency:o.currency,totalPrice:o.totalPrice,subtotal:o.subtotal,shipping:o.shipping,tax:o.tax,discount:o.discount,giftWrap:o.giftWrap,grandtotal:o.grandtotal,refunds:o.refunds,shipped:!!o.shipped,items:o.items.map(i=>({id:i.id,listingId:i.listingId,sku:i.sku??null,title:i.title,qty:i.qty,price:i.price,variations:i.variations}))})),annonces:listings,operations:(await this.store.rows<LedgerEntry>(s.id,'operation')).map(o=>({...o,id:String(o.id)})),vues:await this.store.rows(s.id,'view')});
  }
  if(commandes.length+annonces.length>5000)throw new Error('Plus de 5000 éléments : choisissez une boutique ou une période plus courte.');
  const e=boutiqueFileSchema.parse({format:'atelier-echange',version:1,type:'boutique',from:'etsy',createdAt:this.now(),periode,commandes,annonces});
  const r=Buffer.from(JSON.stringify(releveFileSchema.parse({format:'atelier-releve',version:1,createdAt:this.now(),boutiques})));
  if(r.length>RELEVE_LIMITS.bytes)throw new Error('Relevé supérieur à 100 Mo');
  return writeExchangeArchive(e,new Map([['releve.json',r]]));
 }
 async run(ids:string[],p:EchangePeriode){this.state={running:true,ready:false,error:null,log:[]};this.zip=null;
  try {await this.sync((await this.store.shops()).filter(s=>ids.includes(s.id)));this.zip=await this.export(ids,p);this.state.ready=true;}
  catch {this.state.error='Extraction interrompue. Vérifiez la connexion Etsy et réessayez.';}
  finally{this.state.running=false;}
 }
}
