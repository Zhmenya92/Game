import { BALANCE } from '../src/config/balance.ts';
import { Simulation } from '../src/sim/Simulation.ts';
import { runWithAngle } from '../test/capablePlayer.ts';

const SEEDS = 60, HORIZON = 1800;
const ANGLES = [0, 8, 16, 24, 32, 40, 48, 56, 64];

function trial(minRise: number, gapMin: number, gapMax: number, dyMax: number, ropeMax: number) {
  Object.assign(BALANCE as any, { hookMinRise: minRise, anchorGapMin: gapMin, anchorGapMax: gapMax, anchorDyMax: dyMax, ropeMax });
  let ok = 0, fell = 0, left = 0, frames = 0;
  for (let s = 1; s <= SEEDS; s++) {
    let bestFrames = -1, bestReason = 'left', survived = false;
    for (const a of ANGLES) {
      const r = runWithAngle(s, HORIZON, a);
      if (r.survived) { survived = true; bestFrames = r.frames; break; }
      if (r.frames > bestFrames) { bestFrames = r.frames; }
    }
    if (survived) ok++;
    else {
      // повторюємо найкращий кут, щоб дізнатись причину
      let bf = -1, reason = 'left';
      for (const a of ANGLES) {
        const sim = new Simulation(s, []);
        const r = runWithAngle(s, HORIZON, a);
        if (r.frames > bf) { bf = r.frames; }
      }
      // причина береться з найдовшого прогону
      const sim2 = new Simulation(s, []);
      const rr = runWithAngle(s, HORIZON, 32);
      reason = 'n/a';
      if (rr.frames >= 0) reason = 'x';
      fell++;
    }
    frames += bestFrames;
  }
  return { pass: (ok / SEEDS) * 100, avgSec: (frames / SEEDS) * BALANCE.dt };
}

console.log('minRise gap        dy  ropeMax  прохід%  сер.ран');
const rows: any[] = [];
for (const mr of [140, 190, 240]) {
  for (const [g0, g1] of [[120, 200], [150, 240], [140, 210]] as [number, number][]) {
    for (const dy of [20, 40, 70]) {
      for (const rm of [260, 320]) {
        const r = trial(mr, g0, g1, dy, rm);
        const key = `${String(mr).padStart(6)} ${String(g0).padStart(4)}–${String(g1).padEnd(4)} ${String(dy).padStart(3)} ${String(rm).padStart(6)}`;
        rows.push({ key, ...r });
        console.log(`${key}   ${r.pass.toFixed(0).padStart(5)}%  ${r.avgSec.toFixed(1).padStart(6)}s`);
      }
    }
  }
}
rows.sort((a, b) => b.pass - a.pass);
console.log('\nнайкращі:');
for (const r of rows.slice(0, 6)) console.log(`  ${r.key}  ${r.pass.toFixed(0)}%  ран ${r.avgSec.toFixed(1)}s`);
