import type { LedgerEntry, Listing, Order } from '@passerelle/shared';
import { httpsUrl } from '../../core/etsy-text.js';

// Réponses brutes de l'API Etsy → formes compactes gardées en base. Repris d'Etsy Compta sans changement de sens.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = Record<string, any>;

const money = (m: Raw | null | undefined): number => (m && m.divisor ? m.amount / m.divisor : 0);

/**
 * Les coordonnées de l'acheteur ne servent qu'à expédier : gardées tant que la commande est à envoyer, jetées dès la
 * récupération une fois qu'elle est envoyée, annulée ou remboursée (RGPD, conditions d'Etsy). Etsy les renvoie avec chaque
 * commande ; pour celles-là, elles ne sont jamais écrites en base.
 */
export function keepsBuyerContact(r: Raw): boolean {
  return !!r.is_paid && !r.is_shipped && !(r.refunds || []).length && !['completed', 'canceled', 'cancelled', 'fully refunded', 'refunded'].includes(String(r.status || '').toLowerCase());
}


export function normalizeReceipt(r: Raw): Order {
  const contact = keepsBuyerContact(r);
  const paidTimestamps = (r.transactions || []).map((x: Raw) => x.paid_timestamp).filter((t: unknown): t is number => typeof t === 'number' && t > 0);
  return {
    id: r.receipt_id,
    paidAt: paidTimestamps.length ? Math.max(...paidTimestamps) * 1000 : null,
    t: r.created_timestamp || r.create_timestamp || null,
    status: String(r.status || '').toLowerCase(),
    paid: !!r.is_paid,
    country: r.country_iso || '',
    currency: (r.grandtotal && r.grandtotal.currency_code) || '',
    totalPrice: money(r.total_price),
    subtotal: money(r.subtotal),
    shipping: money(r.total_shipping_cost),
    tax: money(r.total_tax_cost) + money(r.total_vat_cost),
    discount: money(r.discount_amt),
    giftWrap: money(r.gift_wrap_price),
    grandtotal: money(r.grandtotal),
    refunds: (r.refunds || []).map((f: Raw) => ({ amount: money(f.amount), t: f.created_timestamp ?? null })),
    // destinataire et état d'expédition : pour préparer les envois
    name: contact ? String(r.name || '') : '',
    address: contact ? String(r.formatted_address || '') : '',
    city: contact ? String(r.city || '') : '',
    state: contact ? String(r.state || '') : '',
    zip: contact ? String(r.zip || '') : '',
    line1: contact ? String(r.first_line || '') : '',
    line2: contact ? String(r.second_line || '') : '',
    ...(contact ? {email:String(r.buyer_email || ''),phone:String(r.phone || ''),message:String(r.message_from_buyer || '')} : {}),
    shipped: !!r.is_shipped,
    shipments: (r.shipments || []).map((s: Raw) => ({
      carrier: String(s.carrier_name || ''),
      code: String(s.tracking_code || ''),
      t: s.shipment_notification_timestamp ?? null,
    })),
    items: (r.transactions || []).map((x: Raw) => ({
      id: x.transaction_id,
      listingId: x.listing_id ?? null,
      sku: typeof x.sku === 'string' ? x.sku : null,
      title: contact ? x.title || '' : '',
      qty: x.quantity || 1,
      price: money(x.price),
      variations: (contact ? x.variations || [] : []).map((v: Raw) => v.formatted_value).filter(Boolean).join(', '),
      options: (contact ? x.variations || [] : []).map((v: Raw) => ({ name: String(v.formatted_name || ''), value: String(v.formatted_value || '') })).filter((o: { value: string }) => o.value),
    })),
  };
}

export function normalizeListing(l: Raw): Listing {
  const img = (l.images || [])[0];
  return {
    id: l.listing_id,
    title: l.title || '',
    state: l.state,
    price: money(l.price),
    quantity: l.quantity ?? null,
    url: httpsUrl(l.url),
    views: l.views ?? null,
    favorites: l.num_favorers ?? null,
    image: img ? httpsUrl(img.url_170x135 || img.url_75x75) : null,
  };
}

export function normalizeLedger(e: Raw): LedgerEntry {
  return {
    id: e.entry_id,
    t: e.created_timestamp || e.create_date || null,
    amount: (Number(e.amount) || 0) / 100, // le relevé est en centimes
    currency: e.currency ?? null,
    type: e.ledger_type || '',
    desc: '', // Le texte libre peut identifier un acheteur.
    refType: e.reference_type || '',
    refId: e.reference_id != null ? String(e.reference_id) : '',
  };
}
