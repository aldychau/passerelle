import { z } from 'zod';
/** Jetons JSON ({ } [ ] , :) au plus dans catalogue.json : le lecteur du Studio refuse au-delà (5 000 annonces à variantes). */
export const CATALOGUE_JSON_TOKENS = 4_000_000;
const id=z.number().int().nonnegative(), amount=z.number().finite(), url=z.string().url().startsWith('https://');
const option=z.object({name:z.string(),values:z.array(z.string())}).strict();
export const catalogueFileSchema=z.object({format:z.literal('passerelle-catalogue'),version:z.literal(1),createdAt:id,boutiques:z.array(z.object({
 shop:z.string(),name:z.string(),currency:z.string(),
 sections:z.array(z.object({id,title:z.string()}).strict()),
 shippingProfiles:z.array(z.object({id,title:z.string(),originCountry:z.string().nullable(),originPostalCode:z.string().nullable(),destinations:z.array(z.object({country:z.string().nullable(),region:z.string().nullable(),primaryCost:amount,secondaryCost:amount,currency:z.string()}).strict())}).strict()),
 annonces:z.array(z.object({listingId:id,title:z.string(),description:z.string(),tags:z.array(z.string()),materials:z.array(z.string()),price:amount,currency:z.string(),quantity:id.nullable(),sku:z.array(z.string()),sectionId:id.nullable(),state:z.string(),images:z.array(url),
 products:z.array(z.object({sku:z.string(),properties:z.array(option),offerings:z.array(z.object({price:amount,currency:z.string(),quantity:id,enabled:z.boolean()}).strict())}).strict())}).strict()),
 // Pas de texte libre, photo, identifiant ou nom de l'acheteur dans les avis.
 reviews:z.array(z.object({listingId:id.nullable(),rating:amount,created:id.nullable()}).strict()),
 // Coordonnées uniquement des commandes encore à préparer, absentes du relevé.
 contacts:z.array(z.object({receiptId:id,email:z.string(),phone:z.string(),message:z.string()}).strict()).optional()
}).strict())}).strict();
export type CatalogueFile=z.infer<typeof catalogueFileSchema>;

// Copie exacte de ce que le Studio accepte (shared/src/catalogue.ts du Studio, plus strict : devises ISO, notes 1 à 5,
// une annonce par numéro). Un catalogue que le Studio refuserait ferait refuser tout l'import, commandes comprises :
// il est alors laissé de côté, et l'envoi part sans lui.
const studioCatalogueSchema=z.object({format:z.literal('passerelle-catalogue'),version:z.literal(1),createdAt:id,boutiques:z.array(z.object({
 shop:z.string(),name:z.string(),currency:z.string().regex(/^[A-Z]{3}$/),
 sections:z.array(z.object({id,title:z.string()}).strict()),
 shippingProfiles:z.array(z.object({id,title:z.string(),originCountry:z.string().nullable(),originPostalCode:z.string().nullable(),destinations:z.array(z.object({country:z.string().nullable(),region:z.string().nullable(),primaryCost:amount,secondaryCost:amount,currency:z.string().regex(/^[A-Z]{3}$/)}).strict())}).strict()),
 annonces:z.array(z.object({listingId:id,title:z.string(),description:z.string(),tags:z.array(z.string()),materials:z.array(z.string()),price:amount,currency:z.string().regex(/^[A-Z]{3}$/),quantity:id.nullable(),sku:z.array(z.string()),sectionId:id.nullable(),state:z.string(),images:z.array(url),
 products:z.array(z.object({sku:z.string(),properties:z.array(option),offerings:z.array(z.object({price:amount,currency:z.string().regex(/^[A-Z]{3}$/),quantity:id,enabled:z.boolean()}).strict())}).strict())}).strict()).refine(items=>new Set(items.map(l=>l.listingId)).size===items.length,'Annonce présente plusieurs fois.'),
 // Pas de texte libre, photo, identifiant ou nom de l'acheteur dans les avis.
 reviews:z.array(z.object({listingId:id.nullable(),rating:z.number().min(1).max(5),created:id.nullable()}).strict()),
 // Coordonnées uniquement des commandes encore à préparer, absentes du relevé.
 contacts:z.array(z.object({receiptId:id,email:z.string(),phone:z.string(),message:z.string()}).strict()).optional()
}).strict())}).strict();
/** Le catalogue tel qu'il part au Studio : sans aucune coordonnée d'acheteur, et seulement s'il passe la vérification du Studio. */
export function catalogueForStudio(raw:unknown):{file:unknown}|{reason:string}{
 if(raw===undefined)return {reason:'Catalogue absent : le Studio ne connaîtra que les variantes déjà commandées.'};
 const base=catalogueFileSchema.safeParse(raw);
 if(!base.success)return {reason:'Catalogue illisible : envoyé sans lui.'};
 const clean={...base.data,boutiques:base.data.boutiques.map(({contacts:_contacts,...shop})=>shop)};
 const checked=studioCatalogueSchema.safeParse(clean);
 if(!checked.success){const issue=checked.error.issues[0];return {reason:`Catalogue non envoyé (le Studio le refuserait : ${issue?.path.join('.')||'fichier'}) : seules les variantes déjà commandées seront connues.`};}
 const tokens=jsonTokens(JSON.stringify(checked.data));
 if(tokens>CATALOGUE_JSON_TOKENS)return {reason:'Catalogue trop volumineux pour le Studio : envoyé sans lui, seules les variantes déjà commandées seront connues.'};
 return {file:checked.data};
}
/** Le même comptage que le lecteur du Studio (json-budget.ts) : les { } [ ] , : hors des chaînes. */
export function jsonTokens(text:string):number{
 let string=false,escaped=false,tokens=0;
 for(const c of text){
  if(string){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')string=false;}
  else if(c==='"')string=true;
  else if('{}[],:'.includes(c))tokens++;
 }
 return tokens;
}
