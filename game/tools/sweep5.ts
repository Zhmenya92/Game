import { BALANCE } from '../src/config/balance.ts';
import { runCapablePlayer, runAdaptivePlayer } from '../test/capablePlayer.ts';
const SEEDS = 60, HORIZON = 1800;
function trial(minRise: number, dyMax: number, chase: number) {
  Object.assign(BALANCE as any, { hookMinRise: minRise, anchorDyMax: dyMax, chaseSpeedScale: chase,
    ropeMin: 120, ropeMax: 260, anchorGapMin: 140, anchorGapMax: 210 });
  let ok = 0;
  for (let s = 1; s <= SEEDS; s++) {
    let r = runCapablePlayer(s, HORIZON);
    if (!r.survived) { const a = runAdaptivePlayer(s, HORIZON); if (a.survived) r = a as any; }
    if (r.survived) ok++;
  }
  return (ok / SEEDS) * 100;
}
console.log('minRise  dy   chase  прохід%');
const rows: any[] = [];
for (const mr of [0, 60, 140, 200]) for (const dy of [20, 60, 100, 150]) for (const ch of [0.9, 0.7]) {
  const p = trial(mr, dy, ch);
  const key = `${String(mr).padStart(6)} ${String(dy).padStart(4)} ${ch.toFixed(1).padStart(6)}`;
  rows.push({ key, p, dy, mr, ch });
  console.log(`${key}   ${p.toFixed(0).padStart(5)}%`);
}
const good = rows.filter(r => r.p >= 95).sort((a, b) => b.dy - a.dy);
console.log('\n≥95 %, найбільший перепад першим:');
for (const r of good.slice(0, 6)) console.log(`  minRise ${r.mr}  dy ${r.dy}  chase ${r.ch}  → ${r.p.toFixed(0)}%`);
if (!good.length) console.log('  немає');
