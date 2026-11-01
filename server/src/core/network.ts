/**
 * Raison d'une panne réseau, dite sans jamais recopier le message d'origine : celui de fetch peut citer un en-tête
 * entier (clé API comprise) quand sa valeur est refusée. On ne garde que le type d'erreur et son code système.
 */
export function networkReason(e: unknown): string {
  if (!(e instanceof Error)) return 'erreur inconnue';
  if (e.name === 'TimeoutError') return 'délai dépassé';
  if (e.name === 'AbortError') return 'requête interrompue';
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : e.name;
}
