const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Apostrophes typographiques que les modèles produisent volontiers : Etsy n'admet que l'apostrophe droite dans un tag. */
const APOSTROPHES = /[‘’ʼ`´]/g;

/** Tag : lettres, chiffres, espaces, tiret, apostrophe, ™ © ® ; minuscules ; écarté s'il dépasse 20 caractères. */
export function cleanTag(v: string): string {
  const tag = squeeze(v.replace(APOSTROPHES, "'").replace(/[^\p{L}\p{Nd}\p{Zs}\-'™©®]/gu, ' ')).toLowerCase();
  return tag.length > 20 ? '' : tag;
}

/** Matière : lettres, chiffres et espaces seulement ; 45 caractères. */
export const cleanMaterial = (v: string) => squeeze(squeeze(v.replace(/[^\p{L}\p{Nd}\p{Zs}]/gu, ' ')).slice(0, 45));

/**
 * Titre : lettres, chiffres, ponctuation, symboles mathématiques, espaces, ™ © ® ; %, :, & et + une seule fois chacun ; 140 caractères.
 * Les séparateurs de listes de mots-clés (« | », « • ») deviennent des virgules : Etsy donne ce titre-liste en exemple de mauvais titre.
 */
export function cleanTitle(v: string): string {
  let s = v.replace(/\s*[|•·¦]+\s*/g, ', ').replace(/(,\s*){2,}/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  s = s.replace(/[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/gu, ' ');
  for (const c of ['%', ':', '&', '+']) {
    const first = s.indexOf(c);
    if (first >= 0) s = s.slice(0, first + 1) + s.slice(first + 1).split(c).join(' ');
  }
  return squeeze(squeeze(s).slice(0, 140));
}

const uniqueClean = (list: unknown, clean: (v: string) => string, max: number) =>
  [...new Set((Array.isArray(list) ? list : []).map(v => clean(String(v))).filter(Boolean))].slice(0, max);

/**
 * Tags nettoyés, sans doublon, et sans le pluriel d'un autre tag (« fox plush » / « fox plushes ») : Etsy rapproche déjà
 * singulier et pluriel, le second tag serait perdu.
 */
export function cleanTags(list: unknown): string[] {
  const tags = uniqueClean(list, cleanTag, 30);
  const set = new Set(tags);
  // un mot au pluriel, où qu'il soit (« fox plushes », « peluches renard »), et l'autre tag l'a au singulier
  const singulars = (w: string) => [w.replace(/ies$/, 'y'), w.replace(/es$/, ''), w.replace(/s$/, '')].filter(s => s !== w && s.length > 1);
  const isPluralOf = (t: string) => {
    const words = t.split(' ');
    return words.some((w, i) => singulars(w).some(s => set.has([...words.slice(0, i), s, ...words.slice(i + 1)].join(' '))));
  };
  return tags.filter(t => !isPluralOf(t)).slice(0, 13);
}

/** Adresse tirée d'une réponse d'Etsy avant de la montrer comme lien ou image : https seulement (jamais javascript:, data: ni http:). */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const value = v.startsWith('//') ? `https:${v}` : v;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}
