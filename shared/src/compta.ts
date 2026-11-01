import { z } from 'zod';

// Formes reprises d'Etsy Compta : le calcul (web/src/features/compta/lib/compute.ts) s'appuie dessus.

export interface OrderItem {
  image?: string | null;
  id: number; listingId: number | null; sku?: string | null; title: string; qty: number; price: number; variations: string;
  /** Variantes choisies, une par propriété (absent des commandes récupérées avant le 2026-09-24). */
  options?: { name: string; value: string }[];
}
export interface OrderRefund { amount: number; t: number | null }
export interface Order {
  /** Date de paiement des transactions Etsy, en millisecondes. */
  paidAt?: number | null;
  id: number; t: number | null; status: string; paid: boolean; country: string; currency: string;
  totalPrice: number; subtotal: number; shipping: number; tax: number; discount: number; giftWrap: number; grandtotal: number;
  refunds: OrderRefund[]; items: OrderItem[];
  /** Destinataire et état d'expédition (absents des commandes récupérées avant le 2026-09-23 : relancer une récupération). */
  name?: string; address?: string; city?: string; state?: string; zip?: string; shipped?: boolean;
  /** Lignes de l’adresse de livraison. */
  line1?: string; line2?: string;
  /** Envois déclarés sur Etsy (transporteur, numéro de suivi, date de l'avis d'expédition). */
  shipments?: OrderShipment[];
}
export interface OrderShipment { carrier: string; code: string; t: number | null }

export interface Listing {
  id: number; title: string; state: string; price: number; quantity: number | null;
  url: string | null; views: number | null; favorites: number | null; image: string | null;
}
export interface LedgerEntry { id: string | number; t: number | null; amount: number; currency: string | null; type: string; desc: string; refType: string; refId: string }

export interface ComptaShop {
  id: string; name: string; etsyName: string | null; currency: string; syncedAt: number | null;
  /** Boutique dans l'historique (bannie, désactivée) : sa compta reste, ses chiffres ne bougent plus. */
  archived?: boolean;
  orders: Order[]; listings: Listing[]; ledger: LedgerEntry[];
}

const amount = z.union([z.number(), z.string(), z.null()]).optional();

export const costsSchema = z.object({
  /** Coût de revient et autres frais par unité, par identifiant d'annonce. */
  products: z.record(z.string(), z.object({ unit: amount, extra: amount })).default({}),

  orders: z.record(z.string(), z.object({ cost: amount })).default({}),
  expenses: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        label: z.string().max(200),
        amount: z.union([z.number(), z.string()]),
        category: z.string().max(80).default(''),
        shopId: z.string().max(64).default(''),
      }),
    )
    .default([]),
});
export type Costs = z.infer<typeof costsSchema>;

export type Expense = Costs['expenses'][number];

/**
 * Ce que l'État prend sur le résultat : cotisations sociales en % du CA net (micro-entrepreneur : 12,3 % pour la vente de
 * marchandises, à peu près la moitié la première année avec l'ACRE ; + 1 % si versement libératoire de l'impôt sur le revenu)
 * et impôt sur les sociétés en % du bénéfice après cotisations (0 si pas de société ; 15 % puis 25 % sinon).
 */
export const chargesSchema = z
  .object({
    /** Cotisations sociales, % du CA net (micro, vente de marchandises : 12,3 % ; ACRE −25 % → 9,225 %). */
    urssafRate: z.number().min(0).max(100),
    /** Impôt sur le revenu en micro, % du CA net : versement libératoire 1 %, ou 29 % × ta tranche (barème, abattement de 71 %). */
    irRate: z.number().min(0).max(100).default(0),
    /** Impôt sur les sociétés, % du bénéfice après cotisations : sociétés seulement (0 en micro). */
    isRate: z.number().min(0).max(100),
    /**
     * Base des cotisations et de l'impôt sur le revenu. `ca` = CA net (règle officielle en micro : les commissions des
     * plateformes ne se déduisent pas). `etsy_net` = ce qu'Etsy verse (CA net − frais Etsy) : choisi par l'utilisateur en
     * attendant la réponse de l'URSSAF ; sous-estime les cotisations si la règle officielle s'applique.
     */
    base: z.enum(['ca', 'etsy_net']).default('ca'),
  })
  .strict();
export type Charges = z.infer<typeof chargesSchema>;
export const DEFAULT_CHARGES: Charges = { urssafRate: 12.3, irRate: 0, isRate: 0, base: 'ca' };

export interface ComptaData {
  shops: ComptaShop[];
  costs: Costs;
  /** Taux de cotisations et d'impôt appliqués par `compute()` ; absents des anciennes réponses = taux par défaut. */
  charges?: Charges;
}

export interface SyncLogEntry { t: number; msg: string; level: 'info' | 'progress' | 'success' | 'warn' | 'error'; key: string | null }
export interface SyncState { running: boolean; startedAt: number | null; finishedAt: number | null; log: SyncLogEntry[]; errors: number }

export const syncBodySchema = z.object({ shopIds: z.array(z.string()).optional() });

/** Fichiers d'Etsy Compta (dossier AppData\Local\EtsyCompta), lus par le navigateur et envoyés tels quels. */
export const legacyImportSchema = z.object({
  config: z.object({ shops: z.array(z.record(z.string(), z.unknown())) }),
  costs: z.record(z.string(), z.unknown()).optional(),
  caches: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type LegacyImportBody = z.infer<typeof legacyImportSchema>;

export interface LegacyImportResult {
  shops: { name: string; created: boolean; connected: boolean; orders: number }[];
  expenses: number;
  productCosts: number;
}
