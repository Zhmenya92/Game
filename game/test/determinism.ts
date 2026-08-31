import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { buildFromTraces } from '../src/sim/Web.ts';
import { runMinimalPlayer } from './minimalPlayer.ts';

/**
 * Гейт 1, критерій 5: той самий сід + той самий ввід = той самий результат.
 * Тут це перевіряється всередині одного рушія. Крос-платформна перевірка
 * (iOS проти Android) робиться окремо на пристроях — цей тест ловить
 * недетермінізм у КОДІ: Math.random, залежність від порядку ітерації тощо.
 */

function stateSignature(sim: Simulation): string {
  const s = sim.state;
  const parts = [
    s.frame, s.px, s.py, s.vx, s.vy,
    s.attached ? 1 : 0, s.ax, s.ay, s.ropeLen, s.score,
  ];
  const web = sim.ownWeb.map(w => `${w.id}|${w.ax}|${w.ay}|${w.bx}|${w.by}`).join(';');
  return parts.join(',') + '#' + web;
}

function replay(seed: number, trace: InputTrace, frames: number): Simulation {
  const sim = new Simulation(seed, []);
  for (let f = 0; f < frames && sim.state.alive; f++) sim.step(trace.isDownAt(f));
  return sim;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

console.log('determinism');

// 1. Один і той самий ран двічі.
{
  const a = runMinimalPlayer(12345, 3000);
  const b = runMinimalPlayer(12345, 3000);
  check('той самий сід і політика дають той самий стан',
    stateSignature(a.sim) === stateSignature(b.sim));
  check('той самий трек', a.trace.hash() === b.trace.hash());
}

// 2. Відтворення записаного треку дає той самий стан, що й живий ран.
{
  const live = runMinimalPlayer(777, 3000);
  const replayed = replay(777, live.trace, live.frames);
  check('реплей із треку відтворює живий ран',
    stateSignature(live.sim) === stateSignature(replayed),
    `\n       live=${stateSignature(live.sim).slice(0, 90)}\n       repl=${stateSignature(replayed).slice(0, 90)}`);
}

// 3. Серіалізація треку не втрачає інформації.
{
  const r = runMinimalPlayer(999, 2000);
  const round = InputTrace.deserialize(r.trace.serialize());
  check('serialize → deserialize зберігає трек', round.hash() === r.trace.hash());
}

// 4. Різні сіди дають різні траси.
{
  const a = runMinimalPlayer(1, 2000);
  const b = runMinimalPlayer(2, 2000);
  check('різні сіди дають різний результат',
    stateSignature(a.sim) !== stateSignature(b.sim));
}

// 5. buildFromTraces детермінований і не залежить від порядку входу.
{
  const r1 = runMinimalPlayer(4242, 1500);
  const r2 = runMinimalPlayer(4242, 1500);
  const inA = [
    { ownerId: 1, trace: r1.trace, day: 0 },
    { ownerId: 2, trace: r2.trace, day: 0 },
  ];
  const inB = [
    { ownerId: 2, trace: r2.trace, day: 0 },
    { ownerId: 1, trace: r1.trace, day: 0 },
  ];
  const sig = (segs: ReturnType<typeof buildFromTraces>) =>
    segs.map(s => `${s.id}|${s.ax}|${s.ay}|${s.bx}|${s.by}`).join(';');
  check('buildFromTraces не залежить від порядку входу',
    sig(buildFromTraces(4242, inA)) === sig(buildFromTraces(4242, inB)));
}

console.log(failures === 0 ? '\nDETERMINISM OK' : `\nDETERMINISM FAILED: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
