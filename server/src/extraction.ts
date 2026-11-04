import { catalogueFileSchema, boutiqueFileSchema, releveFileSchema, periodeStart, RELEVE_LIMITS, type EchangePeriode, type Order, type Listing, type LedgerEntry } from '@passerelle/shared';
import { normalizeReceipt, normalizeListing, normalizeLedger } from './modules/compta/normalize.js';
import { EtsyClient } from './modules/connectors/etsy/client.js';
import { privateOrder, Store, type Shop } from './store.js';
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
   const sections=await this.etsy.paginate<Raw>(creds,`/shops/${id}/sections`);
   const profiles=await this.etsy.paginate<Raw>(creds,`/shops/${id}/shipping-profiles`);
   const reviews=await this.etsy.paginate<Raw>(creds,`/shops/${id}/reviews`);
   const money=(m:Raw|undefined)=>m?.divisor?m.amount/m.divisor:0;
   await this.store.put(shop.id,'catalogue','shop',{shop:shop.name,name:info.shop_name??shop.name,currency:info.currency_code??'',sections:sections.map(r=>({id:r.shop_section_id,title:r.title??''})),shippingProfiles:profiles.map(r=>({id:r.shipping_profile_id,title:r.title??'',originCountry:r.origin_country_iso??null,originPostalCode:r.origin_postal_code??null,destinations:(r.shipping_profile_destinations??[]).map((d:Raw)=>({country:d.destination_country_iso??null,region:d.destination_region??null,primaryCost:money(d.primary_cost),secondaryCost:money(d.secondary_cost),currency:d.primary_cost?.currency_code??info.currency_code??''}))})),reviews:reviews.map(r=>({listingId:r.listing_id??null,rating:r.rating,created:r.create_timestamp??r.created_timestamp??null}))});
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
     const inventory=await this.etsy.get<Raw>(creds,`/listings/${r.listing_id}/inventory`);
     const images=await this.etsy.paginate<Raw>(creds,`/listings/${r.listing_id}/images`);
     const base=normalizeListing(r);
     await this.store.put(shop.id,'catalogue-listing',r.listing_id,{listingId:r.listing_id,title:base.title,description:r.description??'',tags:r.tags??[],materials:r.materials??[],price:base.price,currency:r.price?.currency_code??info.currency_code??'',quantity:base.quantity,sku:r.skus??[],sectionId:r.shop_section_id??null,state:r.state,images:images.map(i=>i.url_fullxfull).filter((u:unknown)=>typeof u==='string'&&u.startsWith('https://')),products:(inventory.products??[]).map((p:Raw)=>({sku:p.sku??'',properties:(p.property_values??[]).map((v:Raw)=>({name:v.property_name??'',values:v.values??[]})),offerings:(p.offerings??[]).map((o:Raw)=>({price:money(o.price),currency:o.price?.currency_code??info.currency_code??'',quantity:o.quantity??0,enabled:!!o.is_enabled}))}))});
     const l={...base,tags:r.tags??[],created:r.original_creation_timestamp??null,expires:r.ending_timestamp??null};
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
  const commandes:unknown[]=[],annonces:unknown[]=[],boutiques:unknown[]=[],catalogues:unknown[]=[];
  for(const s of await this.store.shops()){
   if(!ids.includes(s.id))continue;
   const orders=(await this.store.rows<Order>(s.id,'order')).map(o=>privateOrder(o) as Order),listings=await this.store.rows<RichListing>(s.id,'listing');
   const refs=new Map((await this.store.db.query<{listing_id:number;ref:string}>('SELECT listing_id,ref FROM imported_fiches WHERE shop=$1',[s.id])).rows.map(r=>[Number(r.listing_id),r.ref]));
   for(const o of orders){const paidAt=o.paidAt??(o.t?o.t*1000:null);
    if(!o.paid||o.shipped||o.refunds.length||['completed','canceled','cancelled','fully refunded','refunded'].includes(o.status)||!paidAt||paidAt<periodeStart(periode,this.now())||!o.country||!o.items.length)continue;
    commandes.push({shop:s.name,receiptId:o.id,paidAt,items:o.items.map(i=>({listingId:i.listingId,ref:refs.get(i.listingId??0)??null,title:i.title,variation:i.variations,options:i.options??[],sku:i.sku??null,quantity:i.qty,image:listings.find(l=>l.id===i.listingId)?.image??null})),shipTo:{country:o.country,name:o.name??'',line1:o.line1??'',line2:o.line2??'',city:o.city??'',state:o.state??'',zip:o.zip??''}});
   }
   for(const l of listings)annonces.push({shop:s.name,listingId:l.id,ref:refs.get(l.id)??null,title:l.title,state:l.state,image:l.image,sales:orders.reduce((n,o)=>n+o.items.filter(i=>i.listingId===l.id).reduce((n,i)=>n+i.qty,0),0),variations:[...new Set(orders.flatMap(o=>o.items.filter(i=>i.listingId===l.id).map(i=>i.variations)))],hasVideo:false});
   const shopInfo=(await this.store.rows<Raw>(s.id,'catalogue'))[0];
   catalogues.push({...shopInfo??{shop:s.name,name:s.name,currency:s.currency,sections:[],shippingProfiles:[],reviews:[]},annonces:await this.store.rows(s.id,'catalogue-listing'),contacts:commandes.filter((o:any)=>o.shop===s.name).map((c:any)=>{const o=orders.find(o=>o.id===c.receiptId)!;return {receiptId:o.id,email:o.email??'',phone:o.phone??'',message:o.message??''};})});
   boutiques.push({shop:s.name,currency:s.currency,commandes:orders.map(o=>({id:o.id,paidAt:o.paidAt??null,t:o.t,status:o.status,paid:o.paid,country:o.country,currency:o.currency,totalPrice:o.totalPrice,subtotal:o.subtotal,shipping:o.shipping,tax:o.tax,discount:o.discount,giftWrap:o.giftWrap,grandtotal:o.grandtotal,refunds:o.refunds,shipped:!!o.shipped,items:o.items.map(i=>({id:i.id,listingId:i.listingId,sku:null,title:"",qty:i.qty,price:i.price,variations:""}))})),annonces:listings,operations:(await this.store.rows<LedgerEntry>(s.id,'operation')).map(o=>({...o,desc:'',id:String(o.id)})),vues:await this.store.rows(s.id,'view')});
  }
  if(commandes.length+annonces.length>5000)throw new Error('Plus de 5000 éléments : choisissez une boutique ou une période plus courte.');
  const e=boutiqueFileSchema.parse({format:'atelier-echange',version:1,type:'boutique',from:'etsy',createdAt:this.now(),periode,commandes,annonces});
  const r=Buffer.from(JSON.stringify(releveFileSchema.parse({format:'atelier-releve',version:1,createdAt:this.now(),boutiques})));
  if(r.length>RELEVE_LIMITS.bytes)throw new Error('Relevé supérieur à 100 Mo');
  const c=Buffer.from(JSON.stringify(catalogueFileSchema.parse({format:'passerelle-catalogue',version:1,createdAt:this.now(),boutiques:catalogues})));
  if(c.length>20*1024*1024||c.length+r.length+Buffer.byteLength(JSON.stringify(e))>200*1024*1024)throw new Error('Catalogue trop volumineux');
  return writeExchangeArchive(e,new Map([['releve.json',r],['catalogue.json',c]]));
 }
 async run(ids:string[],p:EchangePeriode){this.state={running:true,ready:false,error:null,log:[]};this.zip=null;
  try {await this.sync((await this.store.shops()).filter(s=>ids.includes(s.id)));this.zip=await this.export(ids,p);this.state.ready=true;}
  catch {this.state.error='Extraction interrompue. Vérifiez la connexion Etsy et réessayez.';}
  finally{this.state.running=false;}
 }
}
