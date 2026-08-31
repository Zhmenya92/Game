import { BALANCE } from '../src/config/balance.ts';
import { runCapablePlayer, runAdaptivePlayer } from '../test/capablePlayer.ts';

// Мета: знайти НАЙБІЛЬШИЙ перепад висоти, який ще лишає трасу прохідною.
// Плоска траса проходить тест і при цьому нецікава — це не те, чого ми хочемо.
const SEEDS = 60, HORIZON = 1800;

function trial(ropeMin: number, ropeMax: number, gapMin: number, gapMax: number, dyMax: number) {
  Object.assign(BALANCE as any, { ropeMin, ropeMax, anchorGapMin: gapMin, anchorGapMax: gapMax, anchorDyMax: dyMax });
  let ok = 0;
  for (let s = 1; s <= SEEDS; s++) {
    let r = runCapablePlayer(s, HORIZON);
    if (!r.survived) { const a = runAdaptivePlayer(s, HORIZON); if (a.survived) r = a as any; }
    if (r.survived) ok++;
  }
  return (ok / SEEDS) * 100;
}

console.log('rope      gap        dy   прохід%');
const rows: any[] = [];
for (const [rmin, rmax] of [[100, 180], [110, 210], [120, 260]] as [number, number][]) {
  for (const [g0, g1] of [[120, 180], [140, 210]] as [number, number][]) {
    for (const dy of [20, 60, 100, 150, 200]) {
      const p = trial(rmin, rmax, g0, g1, dy);
      const key = `${String(rmin).padStart(3)}–${String(rmax).padEnd(4)} ${String(g0).padStart(3)}–${String(g1).padEnd(4)} ${String(dy).padStart(4)}`;
      rows.push({ key, p, dy });
      console.log(`${key}   ${p.toFixed(0).padStart(5)}%`);
    }
  }
}
console.log('\nнайбільший перепад із прохідністю ≥ 95 %:');
const good = rows.filter(r => r.p >= 95).sort((a, b) => b.dy - a.dy);
for (const r of good.slice(0, 5)) console.log(`  ${r.key}  ${r.p.toFixed(0)}%`);
if (!good.length) console.log('  жодної конфігурації ≥ 95 %');
