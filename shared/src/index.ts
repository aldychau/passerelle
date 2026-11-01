export * from './echange.js';
export * from './releve.js';
export * from './compta.js';
export function periodeStart(p: import('./echange.js').EchangePeriode, now: number): number {
  if (p === 'tout') return 0;
  if (p !== '1m') return now - ({'30j':30,'7j':7,'1j':1}[p]) * 86400000;
  const d = new Date(now), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()-1);
  const end = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,end)); return d.getTime();
}
