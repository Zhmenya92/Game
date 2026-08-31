import { createServer } from 'node:http';
import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { buildWeb, type StoredRun } from '../server/verify.ts';
import type { Segment } from '../src/sim/types.ts';
import { ChallengeStore } from '../server/challenge.ts';
import { computeMetrics } from '../server/metrics.ts';
import { handler } from '../server/index.ts';

/**
 * Віральна петля й метрики гейта 3 (plan.md, 8.2 і 8.3).
 *
 * Перевіряється не «чи повертає сервер 200», а те, що метрики НЕ МОЖНА
 * намалювати: відповіддю вважається лише той, хто спершу відкрив виклик;
 * автор власного виклику не рахується ні у відкриттях, ні у відповідях;
 * походження гравця не перезаписується; ghost-hook rate береться з того,
 * що порахував сервер, а не з того, що прислав клієнт.
 */

let fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('challenge');

// ── логіка сховища викликів ──────────────────────────────────────────────
{
  const cs = new ChallengeStore();
  const c = cs.create('chat', 1, 42, 'r1', 100);
  ok('токен виданий і читабельний', /^[23456789a-z]{7}$/.test(c.token), c.token);

  ok('відповідь без відкриття не зараховується', !cs.reply(c.token, 2, 42));
  ok('відкриття зараховується', !!cs.open(c.token, 2) && c.opens.size === 1);
  ok('повторне відкриття тим самим не подвоює', !!cs.open(c.token, 2) && c.opens.size === 1);
  ok('автор не рахується у власних відкриттях', !!cs.open(c.token, 1) && c.opens.size === 1);
  ok('відповідь на ІНШОМУ сіді не зараховується (дефект 39)', !cs.reply(c.token, 2, 43));
  ok('тепер відповідь зараховується', cs.reply(c.token, 2, 42) && c.replies.size === 1);
  ok('автор не може відповісти сам собі', !cs.reply(c.token, 1, 42));
  ok('невідомий токен не воскрешає', cs.open('немає', 3) === null && !cs.reply('немає', 3, 42));

  const o = cs.originsSnapshot();
  ok('походження: автор органічний, гість за викликом', o.total === 2 && o.viaChallenge === 1);

  cs.seen(2, 'organic');
  ok('походження не перезаписується', cs.originsSnapshot().viaChallenge === 1);
}

// ── метрики ──────────────────────────────────────────────────────────────
{
  const cs = new ChallengeStore();
  const runs: StoredRun[] = [];
  // 4 гравці кидають по виклику, кожен відкривають двоє, відповідає один.
  for (let owner = 1; owner <= 4; owner++) {
    const c = cs.create('chat', owner, 1, `r${owner}`, 10);
    cs.open(c.token, 100 + owner);
    cs.open(c.token, 200 + owner);
    cs.reply(c.token, 100 + owner, 1);
  }
  for (let i = 0; i < 10; i++) {
    runs.push({
      id: `x${i}`, ownerId: 1, seed: 1, traceB64: '', score: 1, frames: 1, day: 0,
      foreignHooks: i < 4 ? 2 : 0,
    });
  }
  const events = [
    ...Array(50).fill({ name: 'run_end' }),
    ...Array(4).fill({ name: 'share_click' }),
  ];
  const m = computeMetrics(events, cs, runs);

  ok('share rate = шери / смерті', Math.abs(m.shareRate - 4 / 50) < 1e-9, String(m.shareRate));
  ok('відкриттів на виклик, а не конверсія', Math.abs(m.opensPerChallenge - 8 / 4) < 1e-9, String(m.opensPerChallenge));
  ok('reply rate = відповіді / відкриття', Math.abs(m.replyRate - 4 / 8) < 1e-9, String(m.replyRate));
  // 4 виклики / 4 відправники = 1 запрошення на відправника;
  // 8 нових гравців за викликом / 8 відкриттів = 1 конверсія; K = 1.
  ok('K-фактор рахується за визначенням', Math.abs(m.kFactor - 1) < 1e-9, String(m.kFactor));
  ok('ghost-hook rate із серверних чисел', Math.abs(m.foreignHookRate - 0.4) < 1e-9, String(m.foreignHookRate));
  ok('вердикт по порогах', m.verdict.shareRate === 'ok' && m.verdict.replyRate === 'ok'
    && m.verdict.foreignHookRate === 'ok' && m.verdict.kFactor === 'ok',
    JSON.stringify(m.verdict));

  const empty = computeMetrics([], new ChallengeStore(), []);
  ok('на порожніх даних метрики не брешуть', empty.verdict.shareRate === 'n/a'
    && empty.kFactor === 0 && empty.foreignHookRate === 0);
}

// ── наскрізна петля через HTTP ───────────────────────────────────────────
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

  function play(seed: number, salt: number, web: readonly Segment[] = []) {
    const sim = new Simulation(seed, web);
    const st = sim.state;
    const tr = new InputTrace();
    const hold = 22 + ((salt * 11) % 34), wait = 9 + ((salt * 7) % 13);
    let down = false;
    for (let f = 0; f < 4000 && st.alive; f++) {
      const w = (f % (hold + wait)) < hold;
      if (w !== down) { down = w; tr.record(f, down ? 'down' : 'up'); }
      sim.step(down);
    }
    return {
      b64: Buffer.from(tr.serialize()).toString('base64'),
      score: st.score, frames: st.frame, foreign: st.foreignHooks,
    };
  }

  const seed = 24680;
  const A = 'dev:501:chatQ';
  const Bu = 'dev:502:chatQ';

  await post('/api/session', { initData: A });
  const a = play(seed, 4);
  const ra = await post('/api/run', { initData: A, seed, traceB64: a.b64, score: a.score, frames: a.frames, webRunIds: [] });
  ok('ран A прийнято', ra.s === 200 && ra.j.ok === true);
  ok('сервер сам порахував foreignHooks', typeof ra.j.foreignHooks === 'number');

  const ch = await post('/api/challenge', { initData: A, seed, runId: ra.j.id });
  ok('виклик створено', ch.s === 200 && typeof ch.j.token === 'string');
  ok('діп-лінк має формат startapp', String(ch.j.link).includes('?startapp=' + ch.j.token), String(ch.j.link));

  const stolen = await post('/api/challenge', { initData: Bu, seed, runId: ra.j.id });
  ok('чужий ран не можна викликати від свого імені', stolen.s === 400);

  const opened = await post('/api/challenge/open', { initData: Bu, token: ch.j.token });
  ok('B відкрив виклик', opened.s === 200 && opened.j.seed === seed && opened.j.challengerId === 501);

  const missing = await post('/api/challenge/open', { initData: Bu, token: 'немає' });
  ok('неіснуючий виклик дає 404', missing.s === 404);

  // B грає той самий сід із павутиною A і відповідає на виклик.
  const listB = await post('/api/runs', { initData: Bu, seed });
  const web = buildWeb(seed, listB.j.runs as StoredRun[]);
  const b = play(seed, 9, web);
  const rb = await post('/api/run', {
    initData: Bu, seed, traceB64: b.b64, score: b.score, frames: b.frames,
    webRunIds: (listB.j.runs as { id: string }[]).map(r => r.id),
    challengeToken: ch.j.token,
  });
  ok('відповідь на виклик зарахована', rb.s === 200 && rb.j.repliedTo === ch.j.token,
    JSON.stringify(rb.j).slice(0, 100));

  // ДЕФЕКТ 39 по HTTP: той самий токен, але інший сід — це не відповідь.
  const otherSeed = seed + 1;
  const listC = await post('/api/runs', { initData: Bu, seed: otherSeed });
  const bOther = play(otherSeed, 13);
  const rOther = await post('/api/run', {
    initData: Bu, seed: otherSeed, traceB64: bOther.b64, score: bOther.score,
    frames: bOther.frames, webRunIds: (listC.j.runs as { id: string }[]).map(r => r.id),
    challengeToken: ch.j.token,
  });
  ok('ран на іншому сіді не зараховується як відповідь',
    rOther.s === 200 && rOther.j.ok === true && rOther.j.repliedTo === null,
    JSON.stringify(rOther.j).slice(0, 120));

  const mid = await (await fetch(B + '/api/metrics')).json() as Record<string, any>;
  ok('після чужої траси відповідь усе ще одна', mid.challengeReplies === 1,
    String(mid.challengeReplies));

  for (let i = 0; i < 3; i++) await post('/api/event', { initData: A, name: 'run_end' });
  await post('/api/event', { initData: A, name: 'share_click' });

  const m = await (await fetch(B + '/api/metrics')).json() as Record<string, any>;
  ok('метрики бачать виклик, відкриття й відповідь',
    m.challengesCreated === 1 && m.challengeOpens === 1 && m.challengeReplies === 1,
    JSON.stringify({ c: m.challengesCreated, o: m.challengeOpens, r: m.challengeReplies }));
  ok('метрики бачать рани', m.runs === 3, String(m.runs));

  await new Promise<void>(r => srv.close(() => r()));
})();

console.log(fail === 0 ? '\nCHALLENGE OK' : `\nCHALLENGE FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
