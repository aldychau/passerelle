import crypto from 'node:crypto';
import { fichesFileSchema,suivisFileSchema,type FicheItem,type SuiviItem,type Order } from '@passerelle/shared';
import { readExchangeArchive,parseExchange,mediaKind,type ExchangeArchive } from './core/echange.js';
import { badRequest } from './core/errors.js';
import { cleanTitle,cleanTags,cleanMaterial } from './core/etsy-text.js';
import { EtsyClient,EtsyError } from './modules/connectors/etsy/client.js';
import { Store,type Shop } from './store.js';
type Raw=Record<string,any>;
type Pending={token:string;expires:number;archive:ExchangeArchive;items:(FicheItem|SuiviItem)[];createdAt:number};
const key=(s:string)=>s.trim().toLocaleLowerCase('fr');
export class Imports {
 pending:Pending|null=null;
 private timer:ReturnType<typeof setTimeout>|null=null;
 dispose(){if(this.timer)clearTimeout(this.timer);this.timer=null;this.pending=null;}
 running=false;
 log:string[]=[];
 constructor(readonly store:Store,readonly etsy:EtsyClient,readonly now=Date.now){}
 async shop(name:string){const s=(await this.store.shops()).filter(s=>key(s.name)===key(name));if(s.length!==1||!s[0]?.etsy_id)throw badRequest('Boutique inconnue ou non connectée : '+name);if(!(await this.store.credentials(s[0].id).load()).tokens)throw badRequest('Boutique déconnectée');return s[0];}
 async existing(i:FicheItem,s:Shop){
  const r=(await this.store.db.query<{shop:string;listing_id:number|null;status:string;created_at:number}>('SELECT * FROM imported_fiches WHERE ref=$1',[i.ref])).rows[0];
  if(r){if(r.shop!==s.id)throw badRequest('Référence affectée à une autre boutique');if(!r.listing_id)throw badRequest('Création incertaine : vérifiez Etsy avant de reprendre cette référence.');
   const l=await this.etsy.get<Raw>(this.store.credentials(s.id),`/listings/${r.listing_id}`);
   if(Number(l.shop_id)!==Number(s.etsy_id)||l.state!=='draft')throw badRequest('Cette annonce n’est plus un brouillon de cette boutique.');
  }return r;
 }
 async check(i:FicheItem,s:Shop,files:Map<string,Buffer>){
  if(i.price.currency!==s.currency)throw badRequest('Devise différente de la boutique');
  if(!i.whoMade||!i.whenMade||!i.taxonomyId)throw badRequest('Renseignez fabricant, période de fabrication et catégorie dans le Studio.');
  if(i.whoMade==='someone_else'&&!i.productionPartner)throw badRequest('Partenaire de production manquant.');
  if(!cleanTitle(i.title))throw badRequest('Titre vide après nettoyage.');
  for(const image of i.images)if(!['jpeg','png','webp'].includes(mediaKind(files.get(image.file)??Buffer.alloc(0))??''))throw badRequest('Image absente ou invalide.');
  if(i.video)throw badRequest('Les vidéos ne sont pas prises en charge par Passerelle.');
  if(i.variations){const v=i.variations,seen=new Set<string>();
   for(const p of v.properties){const values=p.values.map(s=>s.replace(/[()]/g,'').trim());if(values.some(s=>!s)||new Set(values).size!==values.length)throw badRequest('Valeurs de variantes ambiguës.');}
   for(const c of v.combinations){const sig=JSON.stringify(c.values);if(seen.has(sig)||c.values.length!==v.properties.length||c.values.some((x,n)=>!v.properties[n]!.values.includes(x)))throw badRequest('Combinaisons de variantes invalides.');seen.add(sig);}
  }
  const d=(await this.store.rows<Raw>(s.id,'settings'))[0];
  if(!d?.shippingProfileId||!d?.readinessStateId)throw badRequest('Choisissez les profils d’expédition et de préparation dans Boutiques.');
  let partner:number|null=null;
  if(i.productionPartner){const rows=await this.etsy.get<Raw>(this.store.credentials(s.id),`/shops/${s.etsy_id}/production-partners`);partner=rows.results?.find((p:Raw)=>key(p.partner_name)===key(i.productionPartner!))?.production_partner_id??null;if(!partner)throw badRequest('Partenaire de production non déclaré sur Etsy.');}
  return {d,partner};
 }
 async checkSuivi(i:SuiviItem,s:Shop){
  const r=await this.etsy.get<Raw>(this.store.credentials(s.id),`/shops/${s.etsy_id}/receipts/${i.receiptId}`);
  if(Number(r.receipt_id)!==i.receiptId)throw badRequest('Commande étrangère refusée.');
  const old=(await this.store.db.query<{data:SuiviItem;sent:boolean;send_status:string;created_at:number}>('SELECT * FROM suivis WHERE shop=$1 AND receipt_id=$2',[s.id,i.receiptId])).rows[0];
  return {r,old,send:i.etat==='envoye'&&!!i.trackingCode&&!r.is_shipped&&!old?.sent&&old?.send_status!=='uncertain'};
 }
 async preview(data:Buffer){
  if(this.running)throw badRequest('Import en cours');this.dispose();
  const archive=await readExchangeArchive(data);
  const raw=archive.json as {type?:string};
  const f=raw?.type==='fiches'?parseExchange(fichesFileSchema,raw):parseExchange(suivisFileSchema,raw);
  const referenced=new Set(f.type==='fiches'?(f.items as FicheItem[]).flatMap(i=>i.images.map(x=>x.file)):[]);
  for(const name of archive.files.keys())if(!referenced.has(name))throw badRequest('Fichier non référencé : '+name);
  const entries:{label:string;action:string}[]=[],accepted:(FicheItem|SuiviItem)[]=[],seen=new Set<string>();
  for(const i of f.items){const label='ref'in i?i.ref:`${i.shop} · ${i.receiptId}`;
   if(seen.has(label))throw badRequest('Élément en double');seen.add(label);
   try{const s=await this.shop(i.shop);let action:string;
    if('ref'in i){await this.check(i,s,archive.files);const old=await this.existing(i,s);action=old&&Number(old.created_at)>f.createdAt?'Ignorer : fichier plus ancien':old?'Mettre à jour le brouillon':'Créer un brouillon';}
    else{const c=await this.checkSuivi(i,s);action=c.old&&Number(c.old.created_at)>f.createdAt?'Ignorer : fichier plus ancien':c.send?'Envoyer le suivi à Etsy et prévenir l’acheteur':'Enregistrer l’état, sans envoi Etsy';}
    entries.push({label,action});accepted.push(i);
   }catch(e){entries.push({label,action:e instanceof Error&&'statusCode'in e?e.message:'Vérification Etsy impossible. Reconnectez la boutique si nécessaire.'});}
  }
  const token=crypto.randomUUID();this.pending={token,expires:this.now()+30*60000,archive,items:accepted,createdAt:f.createdAt};
  this.timer=setTimeout(()=>this.dispose(),30*60000);this.timer.unref();
  return {token,type:f.type,entries,accepted:accepted.length};
 }
 async confirm(token:string){
  const p=this.pending;if(this.running||!p||p.token!==token||p.expires<this.now())throw badRequest('Aperçu expiré : rechargez le fichier.');
  this.dispose();this.running=true;this.log=[];
  try{for(const i of p.items){const label='ref'in i?i.ref:String(i.receiptId);
   try{const s=await this.shop(i.shop);if('ref'in i)await this.save(i,s,p);else await this.suivi(i,s,p.createdAt);this.log.push(label+' : terminé.');}
   catch{this.log.push(label+' : échec. Vérifiez Etsy avant de réessayer ; aucune publication effectuée.');}
  }}finally{this.running=false;}
  return {log:this.log};
 }
 async save(i:FicheItem,s:Shop,p:Pending){
  const {d,partner}=await this.check(i,s,p.archive.files),creds=this.store.credentials(s.id),old=await this.existing(i,s);
  if(old&&Number(old.created_at)>p.createdAt)return;
  const form={title:cleanTitle(i.title),description:i.description,tags:cleanTags(i.tags),materials:i.materials.map(cleanMaterial).filter(Boolean),price:i.price.amount,quantity:i.quantity,taxonomy_id:i.taxonomyId,who_made:i.whoMade,when_made:i.whenMade,is_supply:i.isSupply,shipping_profile_id:d.shippingProfileId,readiness_state_id:d.readinessStateId,production_partner_ids:partner?[String(partner)]:[],type:'physical',should_auto_renew:false};
  let id=Number(old?.listing_id);
  if(old)await this.etsy.patchForm(creds,`/shops/${s.etsy_id}/listings/${id}`,form);
  else{
   // Réserver avant l’appel : une réponse perdue ne doit jamais créer un second brouillon.
   await this.store.db.query("INSERT INTO imported_fiches(ref,shop,listing_id,status,created_at) VALUES($1,$2,NULL,'uncertain',$3)",[i.ref,s.id,p.createdAt]);
   const created=await this.etsy.postForm<{listing_id:number}>(creds,`/shops/${s.etsy_id}/listings`,form,{once:true});
   id=created.listing_id;if(!Number.isSafeInteger(id)||id<=0)throw badRequest('Identifiant Etsy invalide');
   await this.store.db.query("UPDATE imported_fiches SET listing_id=$1,status='ready' WHERE ref=$2",[id,i.ref]);
  }
  if(i.variations){const {properties,combinations}=i.variations,ids=properties.map((_,n)=>513+n);
   await this.etsy.putJson(creds,`/listings/${id}/inventory`,{products:combinations.map(c=>({sku:c.sku??'',property_values:properties.map((v,n)=>({property_id:ids[n],property_name:v.name.replace(/[()]/g,''),value_ids:[v.values.indexOf(c.values[n]!)+1],values:[c.values[n]!.replace(/[()]/g,'')]})),offerings:[{price:c.price,quantity:i.quantity,is_enabled:true,readiness_state_id:d.readinessStateId}]})),price_on_property:new Set(combinations.map(c=>c.price)).size>1?ids:[],quantity_on_property:[],sku_on_property:combinations.some(c=>c.sku)?ids:[],readiness_state_on_property:[]});
  }
  if(!i.variations)await this.etsy.putJson(creds,`/listings/${id}/inventory`,{products:[{sku:'',property_values:[],offerings:[{price:i.price.amount,quantity:i.quantity,is_enabled:true,readiness_state_id:d.readinessStateId}]}],price_on_property:[],quantity_on_property:[],sku_on_property:[],readiness_state_on_property:[]});
  for(const [n,image]of i.images.entries()){const data=p.archive.files.get(image.file)!,kind=mediaKind(data)!;await this.etsy.uploadImage(creds,`/shops/${s.etsy_id}/listings/${id}/images`,{data,filename:`photo.${kind}`,mime:`image/${kind}`},{rank:n+1,overwrite:'true',alt_text:image.alt});}
  for(const [lang,text]of Object.entries(i.translations)){if(lang===i.language)continue;const url=`/shops/${s.etsy_id}/listings/${id}/translations/${lang}`,translation={...text,title:cleanTitle(text.title),tags:cleanTags(text.tags)};
   try{await this.etsy.get(creds,url);await this.etsy.putForm(creds,url,translation);}catch(e){if(!(e instanceof EtsyError&&e.status===404))throw e;await this.etsy.postForm(creds,url,translation);}
  }
  await this.store.db.query('UPDATE imported_fiches SET created_at=$1 WHERE ref=$2',[p.createdAt,i.ref]);
 }
 async suivi(i:SuiviItem,s:Shop,createdAt:number){
  const {old,send}=await this.checkSuivi(i,s);if(old&&Number(old.created_at)>createdAt)return;
  const ranks=['a_preparer','devis_en_cours','paiement_attendu','paye','annule','envoye'];if(old&&ranks.indexOf(old.data.etat)>ranks.indexOf(i.etat))return;
  await this.store.db.query('INSERT INTO suivis(shop,receipt_id,data,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(shop,receipt_id) DO UPDATE SET data=excluded.data,created_at=excluded.created_at',[s.id,i.receiptId,JSON.stringify(i),createdAt]);
  if(i.etat==='envoye'||i.etat==='annule')for(const o of await this.store.rows<Order>(s.id,'order'))if(o.id===i.receiptId){for(const k of ['name','address','line1','line2','city','state','zip']as const)delete o[k];if(i.etat==='envoye')o.shipped=true;else o.status='canceled';await this.store.put(s.id,'order',o.id,o);}
  if(send){
   // Un appel incertain n’est pas renvoyé automatiquement : vérifier le reçu Etsy.
   await this.store.db.query("UPDATE suivis SET sent=false,send_status='uncertain' WHERE shop=$1 AND receipt_id=$2",[s.id,i.receiptId]);
   try{
   await this.etsy.postForm(this.store.credentials(s.id),`/shops/${s.etsy_id}/receipts/${i.receiptId}/tracking`,{tracking_code:i.trackingCode,carrier_name:i.carrier??''},{once:true});
    await this.store.db.query("UPDATE suivis SET sent=true,send_status='success' WHERE shop=$1 AND receipt_id=$2",[s.id,i.receiptId]);
   }catch(e){
    if(e instanceof EtsyError&&[400,401,403,404,422,429].includes(e.status??0))await this.store.db.query("UPDATE suivis SET sent=false,send_status='rejected' WHERE shop=$1 AND receipt_id=$2",[s.id,i.receiptId]);
    throw e;
   }
  }
 }
}
