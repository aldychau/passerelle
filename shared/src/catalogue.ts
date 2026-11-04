import { z } from 'zod';
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
