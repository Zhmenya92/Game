import { Simulation } from '../src/sim/Simulation.ts';
import { buildSwarm } from '../src/sim/Replay.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import type { Attempt } from '../src/sim/Replay.ts';

/**
 * Гейт 2, критерій 1: «реплей побайтово відтворює оригінальний ран».
 * Це фундамент кліпу, привида й серверної верифікації — якщо він не тримає,
 * уся диференціація тижнів 3–4 не має сенсу.
 */

let fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('replay');

// Збираємо кілька справжніх спроб «людським» гравцем.
function collect(seed: number, n: number): { attempts: Attempt[]; live: { px: number; py: number; score: number; frames: number }[] } {
  const attempts: Attempt[] = [];
  const live: { px: number; py: number; score: number; frames: number }[] = [];
  for (let i = 0; i < n; i++) {
    const r = runHumanPlayerTraced(seed, i);
    attempts.push({ trace: r.trace, frames: r.frames, score: r.score, index: i + 1 });
    live.push({ px: r.px, py: r.py, score: r.score, frames: r.frames });
  }
  return { attempts, live };
}

// humanPlayer не віддає трек, тому тут його власна копія з записом.
function runHumanPlayerTraced(seed: number, salt: number) {
  const sim = new Simulation(seed, []);
  const s = sim.state;
  const trace = new InputTrace();
  let down = false, f = 0;
  // Простий детермінований ритм, різний для кожної спроби.
  const hold = 20 + ((salt * 7) % 40);
  const wait = 8 + ((salt * 5) % 14);
  let t = 0;
  for (; f < 3600 && s.alive; f++) {
    const want = (t % (hold + wait)) < hold;
    if (want !== down) { down = want; trace.record(f, down ? 'down' : 'up'); }
    sim.step(down);
    t++;
  }
  return { trace, frames: s.frame, score: s.score, px: s.px, py: s.py };
}

{
  const seed = 4242;
  const { attempts, live } = collect(seed, 8);
  ok('спроби реально різні', new Set(live.map(l => l.frames)).size > 1);

  const swarm = buildSwarm(seed, attempts, [], 24);
  ok('рій має стільки ж доріжок, скільки спроб', swarm.length === attempts.length);

  // Проганяємо рій до кінця.
  for (let i = 0; i < 4000; i++) {
    let any = false;
    for (const t of swarm) if (!t.done) { t.step(); any = true; }
    if (!any) break;
  }

  let exact = 0;
  for (let i = 0; i < swarm.length; i++) {
    const st = swarm[i].sim.state;
    const l = live[i];
    if (st.px === l.px && st.py === l.py && st.score === l.score && st.frame === l.frames) exact++;
  }
  ok(`усі ${swarm.length} доріжок відтворені точно`, exact === swarm.length,
    `— збіглося ${exact}`);

  // Рій, програний двічі, дає той самий результат.
  const a = buildSwarm(seed, attempts, [], 24);
  const b = buildSwarm(seed, attempts, [], 24);
  for (let i = 0; i < 4000; i++) {
    let any = false;
    for (const t of a) if (!t.done) { t.step(); any = true; }
    for (const t of b) if (!t.done) t.step();
    if (!any) break;
  }
  const sig = (ts: typeof a) => ts.map(t => `${t.sim.state.px}|${t.sim.state.py}|${t.sim.state.frame}`).join(';');
  ok('рій відтворюваний', sig(a) === sig(b));
}

console.log(fail === 0 ? '\nREPLAY OK' : `\nREPLAY FAILED: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
