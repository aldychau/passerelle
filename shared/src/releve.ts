import { z } from 'zod';
const n = z.number().finite(), integer = n.int().nonnegative(), timestamp = integer.nullable();
const url = z.string().url().startsWith('https://').nullable();
export const releveOrderSchema = z.object({
 id: integer, paidAt: timestamp, t: timestamp, status:z.string(), paid:z.boolean(),country:z.string(),currency:z.string(),
 totalPrice:n,subtotal:n,shipping:n,tax:n,discount:n,giftWrap:n,grandtotal:n,
 refunds:z.array(z.object({amount:n,t:timestamp}).strict()),shipped:z.boolean(),
 items:z.array(z.object({id:integer,listingId:timestamp,sku:z.string().nullable(),title:z.string(),qty:integer,price:n,variations:z.string()}).strict())
}).strict();
export const releveListingSchema = z.object({id:integer,title:z.string(),state:z.string(),price:n,quantity:timestamp,url,views:timestamp,favorites:timestamp,image:url,tags:z.array(z.string()),created:timestamp,expires:timestamp}).strict();
export const releveOperationSchema = z.object({id:z.string(),t:timestamp,amount:n,currency:z.string().nullable(),type:z.string(),desc:z.string(),refType:z.string(),refId:z.string()}).strict();
export const releveViewSchema = z.object({day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=> !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s),listingId:integer,views:timestamp,favorites:timestamp}).strict();
export const RELEVE_LIMITS = {bytes:100*1024*1024,rows:200000};
export const releveFileSchema = z.object({format:z.literal('atelier-releve'),version:z.literal(1),createdAt:integer,boutiques:z.array(z.object({shop:z.string().min(1).max(80),currency:z.string(),commandes:z.array(releveOrderSchema),annonces:z.array(releveListingSchema),operations:z.array(releveOperationSchema),vues:z.array(releveViewSchema)}).strict())}).strict().refine(f=>f.boutiques.reduce((n,b)=>n+b.commandes.length+b.annonces.length+b.operations.length+b.vues.length,0)<=RELEVE_LIMITS.rows,'Plus de 200 000 lignes');
export type ReleveFile = z.infer<typeof releveFileSchema>;
