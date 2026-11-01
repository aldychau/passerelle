import { z } from 'zod';

// Fichiers d'échange entre l'appli Etsy et le Studio (docs/ECHANGE.md, version 1). Chaque appli garde sa copie de ce
// fichier : les deux ne partagent aucun code. Tout est strict : un champ inconnu ou faux refuse le fichier entier.

export const ECHANGE_FORMAT = 'atelier-echange';
export const ECHANGE_VERSION = 1;
/** Bornes d'une archive importée. */
export const ECHANGE_LIMITS = { archive: 200 * 1024 * 1024, image: 20 * 1024 * 1024, video: 100 * 1024 * 1024, json: 20 * 1024 * 1024, items: 500, boutique: 5000, entries: 6000 };
/** Sans médias, une archive de commandes ou de suivis reste petite. */
export const ECHANGE_SMALL_LIMIT = 25 * 1024 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable();
const receiptId = z.number().int().positive();
const file = (folder: 'images' | 'videos') => z.string().regex(new RegExp(`^${folder}/[A-Za-z0-9._-]{1,120}$`));

export const ECHANGE_WHO_MADE = ['i_did', 'someone_else', 'collective'] as const;

export const ficheItemSchema = z.object({
  ref: z.string().regex(/^st_[A-Za-z0-9_-]{1,60}$/),
  shop: text(80),
  title: text(140),
  description: z.string().trim().min(1).max(20_000),
  tags: z.array(text(20)).max(13),
  materials: z.array(text(45)).max(13),
  price: z.object({ amount: z.number().positive().max(1_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  quantity: z.number().int().min(1).max(999),
  whoMade: z.enum(ECHANGE_WHO_MADE).nullable(),
  whenMade: optionalText(40),
  isSupply: z.boolean(),
  productionPartner: optionalText(80),
  taxonomyId: z.number().int().positive().nullable(),
  language: z.string().regex(/^[a-z]{2}$/),
  translations: z.record(z.string().regex(/^[a-z]{2}$/), z.object({ title: text(140), description: z.string().trim().min(1).max(20_000), tags: z.array(text(20)).max(13) }).strict()),
  // les combinaisons réellement en vente : deux options ne se croisent pas forcément toutes
  variations: z.object({
    properties: z.array(z.object({ name: text(45), values: z.array(text(45)).min(1).max(70) }).strict()).min(1).max(2),
    combinations: z.array(z.object({ values: z.array(text(45)).min(1).max(2), price: z.number().positive().max(1_000_000), sku: optionalText(32) }).strict()).min(1).max(400),
  }).strict().nullable(),
  images: z.array(z.object({ file: file('images'), alt: z.string().trim().max(250) }).strict()).max(20),
  video: file('videos').nullable(),
}).strict();
export type FicheItem = z.infer<typeof ficheItemSchema>;

export const commandeItemSchema = z.object({
  shop: text(80),
  receiptId,
  paidAt: z.number().int().positive(),
  items: z.array(z.object({
    listingId: z.number().int().positive().nullable(),
    ref: z.string().max(70).nullable(),
    title: z.string().trim().max(300),
    variation: z.string().trim().max(500),
    options: z.array(z.object({ name: text(80), value: z.string().trim().max(200) }).strict()).max(10),
    sku: optionalText(64),
    quantity: z.number().int().min(1).max(10_000),
    image: z.string().url().startsWith('https://').max(1000).nullable(),
  }).strict()).min(1).max(200),
  // l'adresse de livraison ne voyage que pour une commande pas encore expédiée
  shipTo: z.object({
    country: z.string().regex(/^[A-Z]{2}$/),
    name: z.string().trim().max(200).optional(),
    line1: z.string().trim().max(300).optional(),
    line2: z.string().trim().max(300).optional(),
    city: z.string().trim().max(200).optional(),
    state: z.string().trim().max(200).optional(),
    zip: z.string().trim().max(40).optional(),
  }).strict(),
}).strict();
export type CommandeItem = z.infer<typeof commandeItemSchema>;

/** Où en est une commande dans le Studio : seule `envoye` compte comme expédiée sur le site Etsy. */
export const ECHANGE_ETATS = ['a_preparer', 'devis_en_cours', 'paiement_attendu', 'paye', 'envoye', 'annule'] as const;

export const suiviItemSchema = z.object({
  shop: text(80),
  receiptId,
  etat: z.enum(ECHANGE_ETATS),
  carrier: optionalText(80),
  trackingCode: optionalText(120),
  shippedAt: z.number().int().positive().nullable(),
}).strict();
export type SuiviItem = z.infer<typeof suiviItemSchema>;

export const annonceItemSchema = z.object({
  shop: text(80),
  listingId: z.number().int().positive(),
  ref: z.string().max(70).nullable(),
  title: z.string().trim().max(300),
  state: z.string().trim().max(40),
  image: z.string().url().startsWith('https://').max(1000).nullable(),
  sales: z.number().int().min(0).nullable(),
  variations: z.array(z.string().trim().max(500)).max(400),
  // le montage reste sur le site Etsy : le Studio apprend seulement qu'il existe
  hasVideo: z.boolean(),
}).strict();
export type AnnonceItem = z.infer<typeof annonceItemSchema>;

/** Périodes de l'export de boutique, comptées sur la date de paiement des commandes. */
export const ECHANGE_PERIODES = ['tout', '1m', '30j', '7j', '1j'] as const;
export type EchangePeriode = (typeof ECHANGE_PERIODES)[number];
export const ECHANGE_PERIODE_DEFAUT: EchangePeriode = '30j';
export const ECHANGE_PERIODE_LABELS: Record<EchangePeriode, string> = { tout: "Depuis l'ouverture", '1m': '1 mois', '30j': '30 jours', '7j': '7 jours', '1j': '1 jour' };

const envelope = <T extends z.ZodType>(type: string, from: 'studio' | 'etsy', item: T) => z.object({
  format: z.literal(ECHANGE_FORMAT),
  type: z.literal(type),
  version: z.literal(ECHANGE_VERSION),
  createdAt: z.number().int().positive(),
  from: z.literal(from),
  items: z.array(item).min(1).max(ECHANGE_LIMITS.items),
}).strict();

export const fichesFileSchema = envelope('fiches', 'studio', ficheItemSchema);
export const suivisFileSchema = envelope('suivis', 'studio', suiviItemSchema);

/** L'export d'une ou plusieurs boutiques : un seul fichier pour les commandes à préparer et toutes les annonces. */
export const boutiqueFileSchema = z.object({
  format: z.literal(ECHANGE_FORMAT),
  type: z.literal('boutique'),
  version: z.literal(ECHANGE_VERSION),
  createdAt: z.number().int().positive(),
  from: z.literal('etsy'),
  periode: z.enum(ECHANGE_PERIODES),
  commandes: z.array(commandeItemSchema).max(ECHANGE_LIMITS.boutique),
  annonces: z.array(annonceItemSchema).max(ECHANGE_LIMITS.boutique),
}).strict().refine(file => file.commandes.length + file.annonces.length > 0);

/** Ce qu'un import ferait, montré avant d'agir. */
export interface ImportPreview {
  type: 'fiches' | 'suivis' | 'boutique';
  total: number;
  creations: number;
  updates: number;
  /** Annonces du fichier, pour un export de boutique. */
  annonces?: number;
  commandesComptables?: number;
  operations?: number;
  joursVues?: number;
  /** Éléments laissés de côté, et pourquoi. */
  skipped: { label: string; reason: string }[];
  /** Boutiques absentes du site, créées à l'import. */
  newShops: string[];
}
