import { BALANCE } from '../src/config/balance.ts';
import { generateTrack } from '../src/sim/generateTrack.ts';
import { Simulation } from '../src/sim/Simulation.ts';
import { len } from '../src/sim/MathDet.ts';

console.log('boost riseHi maxSp | анкерів  довж.  сер.ран  макс.швидк');
const rows: any[] = [];
for (const boost of [1.10, 1.16, 1.22, 1.28]) {
  for (const rf of [0.74, 0.84]) {
    for (const ms of [700, 820]) {
      Object.assign(BALANCE as any, { releaseBoost: boost, riseHiFactor: rf, maxSpeed: ms });
      let n = 0, L = 0, secs = 0, top = 0;
      const seeds = [1, 2, 3, 5, 8, 13];
      for (const seed of seeds) {
        const a = generateTrack(seed, 400);
        n += a.length; L += a[a.length - 1].x;
        const sim = new Simulation(seed, []); const s = sim.state;
        let down = false; const sinT = Math.sin(30 * Math.PI / 180);
        for (let f = 0; f < 7200 && s.alive; f++) {
          if (!s.attached) { if (!down) down = true; }
          else if (down) { const sp = len(s.vx, s.vy); if (sp > 0 && s.vx > 0 && (-s.vy) / sp >= sinT) down = false; }
          sim.step(down);
          const sp = len(s.vx, s.vy); if (sp > top) top = sp;
        }
        secs += s.frame / 120;
      }
      const key = `${boost.toFixed(2)}  ${rf.toFixed(2)}  ${String(ms).padStart(4)}`;
      rows.push({ key, n: n / seeds.length, secs: secs / seeds.length, top });
      console.log(`${key} | ${(n / seeds.length).toFixed(0).padStart(7)}  ${(L / seeds.length / 1000).toFixed(0).padStart(4)}k  ${(secs / seeds.length).toFixed(1).padStart(6)}s  ${top.toFixed(0).padStart(6)}`);
    }
  }
}
rows.sort((a, b) => (b.n - a.n) || (b.secs - a.secs));
console.log('\nнайкращі (повна траса + довгий ран простою політикою):');
for (const r of rows.slice(0, 5)) console.log(`  ${r.key} → ${r.n.toFixed(0)} анкерів, ран ${r.secs.toFixed(1)}s, макс ${r.top.toFixed(0)}`);
