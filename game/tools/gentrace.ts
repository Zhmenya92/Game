import { BALANCE } from '../src/config/balance.ts';
import { Prng } from '../src/sim/Prng.ts';
import { len } from '../src/sim/MathDet.ts';
import { Track } from '../src/sim/Track.ts';
import { Simulation } from '../src/sim/Simulation.ts';

const seed = Number(process.argv[2] ?? 1);
const prng = new Prng((seed ^ 0x5bf03635) >>> 0);
const track = new Track([{ x: BALANCE.firstAnchor.x, y: BALANCE.firstAnchor.y }]);
const sim = new Simulation(seed, [], track);
const s = sim.state;
const REF = Math.sin((30 * Math.PI) / 180);
let down = true, fa = 0;

function valid(px: number, py: number) {
  for (const a of track.anchors) {
    const dx = a.x - px, dy = a.y - py;
    if (dx < 0 || dy > -BALANCE.hookMinRise) continue;
    const d = len(dx, dy);
    if (d >= BALANCE.ropeMin && d <= BALANCE.ropeMax) return true;
  }
  return false;
}

for (let f = 0; f < 1200 && s.alive; f++) {
  let ev = '';
  if (!s.attached) {
    down = true; fa = 0;
    if (!valid(s.px, s.py)) {
      const span = BALANCE.anchorZoneBottom - BALANCE.anchorZoneTop;
      let t = (s.py - BALANCE.anchorZoneTop) / span; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = BALANCE.ropeMax - 10 - prng.int(0, 40);
      const riseLo = BALANCE.hookMinRise + 20, riseHi = d * 0.62;
      let rise = riseLo + (riseHi - riseLo) * t + prng.int(-25, 25);
      rise = Math.max(riseLo, Math.min(riseHi, rise));
      const horiz = Math.sqrt(Math.max(1, d * d - rise * rise));
      let y = s.py - rise; if (y < BALANCE.anchorZoneTop) y = BALANCE.anchorZoneTop;
      track.anchors.push({ x: s.px + horiz, y });
      ev = `SPAWN (${(s.px + horiz).toFixed(0)},${y.toFixed(0)}) rise=${rise.toFixed(0)} d=${d.toFixed(0)}`;
    }
  } else {
    fa++;
    const sp = len(s.vx, s.vy);
    down = !((sp > 0 && s.vx > 0 && (-s.vy) / sp >= REF) || fa > 200);
  }
  if (f % 30 === 0 || ev) {
    console.log(`${String(f).padStart(4)} px=${s.px.toFixed(0).padStart(6)} py=${s.py.toFixed(0).padStart(6)} vy=${s.vy.toFixed(0).padStart(6)} att=${s.attached ? 'Y' : '.'} kill=${s.killX.toFixed(0).padStart(6)} n=${track.anchors.length} ${ev}`);
  }
  sim.step(down);
}
console.log('result', JSON.stringify(sim.result()), 'frame', s.frame, 'anchors', track.anchors.length);
