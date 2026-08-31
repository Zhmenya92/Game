import { BALANCE } from '../src/config/balance.ts';
import { generateTrack } from '../src/sim/generateTrack.ts';

console.log('boost  riseHi  chase | анкерів  довжина  y-діапазон');
const rows: any[] = [];
for (const boost of [1.18, 1.24, 1.30, 1.36]) {
  for (const rf of [0.62, 0.74]) {
    for (const chase of [0.9, 0.75]) {
      Object.assign(BALANCE as any, { releaseBoost: boost, riseHiFactor: rf, chaseSpeedScale: chase });
      let n = 0, L = 0, lo = 1e9, hi = -1e9;
      for (const seed of [1, 2, 3, 5, 8, 13]) {
        const a = generateTrack(seed, 400);
        n += a.length; L += a[a.length - 1].x;
        for (const p of a) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
      }
      const key = `${boost.toFixed(2)}   ${rf.toFixed(2)}    ${chase.toFixed(2)}`;
      rows.push({ key, n: n / 6, L: L / 6, span: hi - lo });
      console.log(`${key} | ${(n / 6).toFixed(0).padStart(7)}  ${(L / 6).toFixed(0).padStart(7)}  ${lo.toFixed(0)}..${hi.toFixed(0)}`);
    }
  }
}
rows.sort((a, b) => b.n - a.n);
console.log('\nнайдовші траси:');
for (const r of rows.slice(0, 4)) console.log(`  ${r.key} → ${r.n.toFixed(0)} анкерів, ${r.L.toFixed(0)} од`);
