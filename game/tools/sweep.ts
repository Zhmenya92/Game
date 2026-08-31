import { BALANCE } from '../src/config/balance.ts';
import { runCapablePlayer } from '../test/capablePlayer.ts';

/**
 * Підбір параметрів генерації за даними, а не на око.
 * Прогін «здатного гравця» по сітці конфігурацій; критерій — частка
 * прохідних сідів. Числа з брифа позначені як START саме для цього.
 */

const SEEDS = 100;
const HORIZON = 1800; // 15 с

function cosDeg(d: number): number {
  return Math.cos((d * Math.PI) / 180);
}

function trial(coneDeg: number, gapMin: number, gapMax: number, zoneBottom: number) {
  Object.assign(BALANCE as any, {
    hookConeCos: cosDeg(coneDeg),
    anchorGapMin: gapMin,
    anchorGapMax: gapMax,
    anchorZoneBottom: zoneBottom,
  });
  let ok = 0;
  let frames = 0;
  let swings = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = runCapablePlayer(seed, HORIZON);
    if (r.survived) ok++;
    frames += r.frames;
    swings += r.swings;
  }
  return {
    pass: (ok / SEEDS) * 100,
    avgSec: (frames / SEEDS) * BALANCE.dt,
    swingsPerRun: swings / SEEDS,
  };
}

const cones = [30, 45, 60, 75, 89];
const gaps: [number, number][] = [[180, 340], [180, 280], [150, 240]];
const zones = [576, 420];

console.log('sweep: здатний гравець, ' + SEEDS + ' сідів, горизонт 15 с\n');
console.log('конус°  gap        зона   прохід%  сер.ран  замахів');
console.log('------  ---------  -----  -------  -------  -------');

const rows: { key: string; pass: number; avgSec: number; sw: number }[] = [];
for (const cone of cones) {
  for (const [g0, g1] of gaps) {
    for (const z of zones) {
      const r = trial(cone, g0, g1, z);
      const key = `${String(cone).padStart(5)}°  ${String(g0).padStart(3)}–${String(g1).padEnd(4)}  ${String(z).padStart(4)}`;
      rows.push({ key, pass: r.pass, avgSec: r.avgSec, sw: r.swingsPerRun });
      console.log(
        `${key}   ${r.pass.toFixed(0).padStart(5)}%  ${r.avgSec.toFixed(1).padStart(6)}s  ${r.swingsPerRun.toFixed(1).padStart(6)}`,
      );
    }
  }
}

rows.sort((a, b) => b.pass - a.pass || b.sw - a.sw);
console.log('\nнайкращі:');
for (const r of rows.slice(0, 5)) {
  console.log(`  ${r.key}  ${r.pass.toFixed(0)}%  замахів/ран ${r.sw.toFixed(1)}`);
}
