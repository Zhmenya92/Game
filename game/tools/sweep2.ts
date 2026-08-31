import { BALANCE } from '../src/config/balance.ts';
import { runCapablePlayer } from '../test/capablePlayer.ts';

const SEEDS = 60, HORIZON = 1800;
const cosDeg = (d: number) => Math.cos((d * Math.PI) / 180);

function trial(minRise: number, gapMin: number, gapMax: number, dyMax: number) {
  Object.assign(BALANCE as any, {
    hookMinRise: minRise, anchorGapMin: gapMin, anchorGapMax: gapMax, anchorDyMax: dyMax,
  });
  let ok = 0, frames = 0, sw = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const r = runCapablePlayer(s, HORIZON);
    if (r.survived) ok++; frames += r.frames; sw += r.swings;
  }
  return { pass: (ok / SEEDS) * 100, avgSec: (frames / SEEDS) * BALANCE.dt, sw: sw / SEEDS };
}

console.log('minRise gap        dy    прохід%  сер.ран  замахів');
const rows: any[] = [];
for (const cone of [0, 40, 80, 140]) {
  for (const [g0, g1] of [[180, 340], [180, 280], [150, 240]] as [number, number][]) {
    for (const dy of [40, 90, 150]) {
      const r = trial(cone, g0, g1, dy);
      const key = `${String(cone).padStart(5)}°  ${String(g0).padStart(3)}–${String(g1).padEnd(4)}  ${String(dy).padStart(3)}`;
      rows.push({ key, ...r });
      console.log(`${key}   ${r.pass.toFixed(0).padStart(5)}%  ${r.avgSec.toFixed(1).padStart(6)}s  ${r.sw.toFixed(1).padStart(6)}`);
    }
  }
}
rows.sort((a, b) => b.pass - a.pass || a.sw - b.sw);
console.log('\nнайкращі:');
for (const r of rows.slice(0, 6)) console.log(`  ${r.key}  ${r.pass.toFixed(0)}%  ран ${r.avgSec.toFixed(1)}s  замахів ${r.sw.toFixed(1)}`);
