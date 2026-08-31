import { createServer } from 'node:http';
import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { playTrace } from '../src/sim/playback.ts';
import { buildFromTraces } from '../src/sim/Web.ts';
import { BALANCE } from '../src/config/balance.ts';
import { verifyRun } from '../server/verify.ts';
import { handler } from '../server/index.ts';
import { QuadRecorder } from '../src/render/Painter.ts';
import { drawForeignWeb, drawOwnWeb } from '../src/render/scene.ts';
import type { Segment } from '../src/sim/types.ts';

/**
 * Доступність і налаштування.
 *
 * Три знахідки евристичної самоперевірки з `testing-plan.md`:
 *   1. у грі не було ЖОДНОГО налаштування — порушення евристики Pinelle
 *      про можливість налаштувати складність і базового рівня
 *      Game Accessibility Guidelines;
 *   2. чужі лінії відрізнялися від власних ЛИШЕ кольором — бірюзовий проти
 *      помаранчевого, тобто пара, яку плутають при дейтеранопії;
 *   3. підказка гасла за таймером, а не в темпі гравця.
 *
 * Третю перевірити тут неможливо — вона живе у сцені Phaser. Перші дві
 * перевіряються повністю, і головне тут не «чи є перемикач», а те, що
 * складність **не ламає верифікацію**: вона входить у симуляцію, тож
 * сервер мусить переграти ран саме з нею.
 */

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('accessibility');

// ── Складність справді щось міняє ─────────────────────────────────────────

/**
 * Політика з ДОВГИМИ утриманнями: гравець висить на тросі й ледве
 * посувається, тому його наздоганяє стіна.
 *
 * Це не примха. Ритм із короткими замахами гине ПАДІННЯМ, а падіння від
 * складності не залежить узагалі — і перша версія цього тесту падала саме
 * тому, що порівнювала два рани, на які складність не впливала. Щоб
 * перевіряти стіну, треба вмирати від стіни.
 */
function playRhythm(seed: number, difficulty: 'normal' | 'calm', frames = 6000) {
  const sim = new Simulation(seed, [], undefined, difficulty);
  const tr = new InputTrace();
  let down = false;
  for (let f = 0; f < frames && sim.state.alive; f++) {
    const want = (f % 200) < 190;
    if (want !== down) { down = want; tr.record(f, down ? 'down' : 'up'); }
    sim.step(down);
  }
  return { sim, trace: tr };
}

{
  ok('спокійна складність повільніша за звичайну',
    BALANCE.difficulty.calm.chaseFactor < BALANCE.difficulty.normal.chaseFactor,
    `${BALANCE.difficulty.calm.chaseFactor} проти ${BALANCE.difficulty.normal.chaseFactor}`);

  const n = new Simulation(7, [], undefined, 'normal');
  const c = new Simulation(7, [], undefined, 'calm');
  for (let f = 0; f < 1200; f++) { n.step(false); c.step(false); }
  ok('на спокійній стіна відстає далі',
    c.state.killX < n.state.killX,
    `calm ${c.state.killX.toFixed(1)} проти normal ${n.state.killX.toFixed(1)}`);

  ok('складність переживає clone (потрібно тесту прохідності)',
    new Simulation(7, [], undefined, 'calm').clone().difficulty === 'calm');
}

// ── Головне: складність не ламає верифікацію ──────────────────────────────

{
  const calm = playRhythm(101, 'calm');
  const b64 = Buffer.from(calm.trace.serialize()).toString('base64');
  const run = {
    seed: 101, traceB64: b64,
    score: calm.sim.state.score, frames: calm.sim.state.frame, webRunIds: [],
  };

  const good = verifyRun({ ...run, difficulty: 'calm' }, []);
  ok('ЧЕСНИЙ ран на спокійній складності приймається', good.ok === true,
    good.ok ? '' : good.reason);

  // Той самий трек, але заявлений як звичайна складність, — це вже інша
  // симуляція, і збігтися вона не може. Якби збігалася, складність можна
  // було б підмінювати після рану.
  const lie = verifyRun({ ...run, difficulty: 'normal' }, []);
  ok('той самий трек, заявлений як звичайна складність, ВІДХИЛЯЄТЬСЯ',
    lie.ok === false, lie.ok ? 'прийнято — складність можна підмінити' : lie.reason);

  const normal = playRhythm(101, 'normal');
  ok('той самий ритм на різних складностях гине в різний момент',
    normal.sim.state.frame !== calm.sim.state.frame
    || normal.sim.state.score !== calm.sim.state.score,
    `${normal.sim.state.frame}/${normal.sim.state.score} проти ${calm.sim.state.frame}/${calm.sim.state.score}`);
}

// ── Павутина будується зі складністю того рану ────────────────────────────

{
  const calm = playRhythm(101, 'calm');
  const entry = { ownerId: 3, trace: calm.trace, day: 0 };
  const withCalm = buildFromTraces(101, [{ ...entry, difficulty: 'calm' as const }]);
  const withNormal = buildFromTraces(101, [entry]);
  const sig = (segs: Segment[]) => segs.map(s => `${s.ax}|${s.ay}|${s.bx}|${s.by}`).join(';');
  ok('павутина чужого рану залежить від ЙОГО складності',
    sig(withCalm) !== sig(withNormal),
    `${withCalm.length} проти ${withNormal.length} відрізків`);
  ok('без явної складності поводиться як звичайна',
    sig(withNormal) === sig(buildFromTraces(101, [{ ...entry, difficulty: 'normal' as const }])));
}

// ── Воскресіння в чужому треку не обриває розбір павутини ─────────────────

{
  // Раніше buildFromTraces мав власний цикл, що зупинявся на смерті.
  // Трек із воскресінням давав коротшу павутину, ніж бачив автор рану.
  const sim = new Simulation(909, []);
  const tr = new InputTrace();
  let down = false;
  for (let f = 0; f < 2000; f++) {
    if (!sim.state.alive) {
      if (!sim.revive()) break;
      tr.record(sim.state.frame, 'revive');
    }
    const want = (f % 40) < 26;
    if (want !== down) { down = want; tr.record(f, down ? 'down' : 'up'); }
    sim.step(down);
  }
  const segs = buildFromTraces(909, [{ ownerId: 4, trace: tr, day: 0 }]);
  const live = new Simulation(909, []);
  playTrace(live, tr, sim.state.frame + 1);
  ok('павутина з треку з воскресінням збігається з живим раном',
    segs.length === live.ownWeb.length,
    `${segs.length} проти ${live.ownWeb.length}`);
}

// ── Форма, а не колір ─────────────────────────────────────────────────────

{
  const seg: Segment = {
    id: '1:0', ax: 0, ay: 0, bx: 300, by: 0,
    ownerId: 1, hooks: 0, bornDay: 0,
  };

  const foreign = new QuadRecorder();
  drawForeignWeb(foreign, [seg]);
  const own = new QuadRecorder();
  drawOwnWeb(own, [{ ...seg, ownerId: 0 }]);

  ok('чужа лінія — ПУНКТИРНА: багато коротких відрізків',
    foreign.quads.length > own.quads.length * 3,
    `чужа ${foreign.quads.length}, власна ${own.quads.length}`);

  const foreignLen = Math.max(...foreign.quads.map(q => q.w));
  ok('жоден штрих не займає всю лінію', foreignLen < 300 * 0.8, String(foreignLen));

  const ownWidth = Math.max(...own.quads.map(q => q.h));
  const foreignWidth = Math.max(...foreign.quads.map(q => q.h));
  ok('власна лінія товща за чужу — друга відмінність крім форми',
    ownWidth > foreignWidth, `${ownWidth} проти ${foreignWidth}`);

  const safe = new QuadRecorder();
  drawForeignWeb(safe, [seg], true);
  const plain = new Set(foreign.quads.map(q => q.tint));
  const safeTints = new Set(safe.quads.map(q => q.tint));
  ok('режим без кольору справді міняє тінт',
    [...safeTints].every(t => !plain.has(t)),
    `${[...plain].map(t => t.toString(16))} → ${[...safeTints].map(t => t.toString(16))}`);
  ok('пунктир лишається і в режимі без кольору',
    safe.quads.length === foreign.quads.length);
}

// ── HTTP: спокійна складність не кидає виклик ─────────────────────────────

await (async () => {
  process.env.DEV_ALLOW_UNSIGNED = '1';
  const srv = createServer(handler);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const B = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) => {
    const r = await fetch(B + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { s: r.status, j: await r.json() as Record<string, any> };
  };

  const U = 'dev:700:chatD';
  await post('/api/session', { initData: U });

  const seed = 101;
  const calm = playRhythm(seed, 'calm');
  const sent = await post('/api/run', {
    initData: U, seed,
    traceB64: Buffer.from(calm.trace.serialize()).toString('base64'),
    score: calm.sim.state.score, frames: calm.sim.state.frame,
    webRunIds: [], difficulty: 'calm',
  });
  ok('ран на спокійній складності приймається сервером',
    sent.s === 200 && sent.j.ok === true, JSON.stringify(sent.j).slice(0, 120));

  const ch = await post('/api/challenge', { initData: U, seed, runId: sent.j.id });
  ok('але виклик із нього кинути НЕ можна',
    ch.s === 400 && String(ch.j.reason).includes('спокійній'), JSON.stringify(ch.j));

  const normal = playRhythm(seed, 'normal');
  const sent2 = await post('/api/run', {
    initData: U, seed,
    traceB64: Buffer.from(normal.trace.serialize()).toString('base64'),
    score: normal.sim.state.score, frames: normal.sim.state.frame,
    webRunIds: [], difficulty: 'normal',
  });
  const ch2 = await post('/api/challenge', { initData: U, seed, runId: sent2.j.id });
  ok('зі звичайної складності виклик кидається', ch2.s === 200 && !!ch2.j.token);

  // Підміна складності через API: трек зіграно на спокійній, заявлено
  // звичайну — сервер переграє й не сходиться.
  const cheat = await post('/api/run', {
    initData: U, seed,
    traceB64: Buffer.from(calm.trace.serialize()).toString('base64'),
    score: calm.sim.state.score, frames: calm.sim.state.frame,
    webRunIds: [], difficulty: 'normal',
  });
  ok('підміна складності в запиті відхиляється', cheat.s === 400, JSON.stringify(cheat.j).slice(0, 120));

  await new Promise<void>(r => srv.close(() => r()));
})();

console.log(fail === 0 ? '\nACCESSIBILITY OK' : `\nACCESSIBILITY FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
