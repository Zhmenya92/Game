import { BALANCE } from '../src/config/balance.ts';
import { Simulation } from '../src/sim/Simulation.ts';
import { len } from '../src/sim/MathDet.ts';

const seed = Number(process.argv[2] ?? 1);
const angleDeg = Number(process.argv[3] ?? 24);
const sinT = Math.sin((angleDeg * Math.PI) / 180);
const sim = new Simulation(seed, []);
let down = false;
console.log('anchors:', sim.track.candidates(0).map(a => `(${a.x},${a.y})`).join(' '));
sim.track.ensureUpTo(1500);
console.log('first 8:', sim.track.anchors.slice(0, 8).map(a => `(${a.x},${a.y})`).join(' '));
console.log('\nframe    px     py     vx     vy   att  ropeL  killX  event');
let prevAtt = false;
for (let f = 0; f < 900 && sim.state.alive; f++) {
  const s = sim.state;
  let ev = '';
  if (!s.attached) { if (!down) { down = true; ev = 'DOWN'; } }
  else if (down) {
    const sp = len(s.vx, s.vy);
    if (sp > 0 && s.vx > 0 && (-s.vy) / sp >= sinT) { down = false; ev = 'UP'; }
  }
  if (s.attached !== prevAtt) ev += s.attached ? ' [attached]' : ' [free]';
  prevAtt = s.attached;
  if (f % 20 === 0 || ev) {
    console.log(
      `${String(f).padStart(5)} ${s.px.toFixed(0).padStart(6)} ${s.py.toFixed(0).padStart(6)} ` +
      `${s.vx.toFixed(0).padStart(6)} ${s.vy.toFixed(0).padStart(6)} ${s.attached ? ' Y ' : ' . '} ` +
      `${s.ropeLen.toFixed(0).padStart(6)} ${s.killX.toFixed(0).padStart(6)}  ${ev}`);
  }
  sim.step(down);
}
console.log('\nresult:', JSON.stringify(sim.result()), 'frame', sim.state.frame);
