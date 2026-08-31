import { createServer } from 'node:http';
import { BALANCE } from '../src/config/balance.ts';
import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { validateInitData, signInitData } from '../server/auth.ts';
import { verifyRun, buildWeb, type StoredRun } from '../server/verify.ts';
import { dailySeed } from '../server/daily.ts';
import { RunStore } from '../server/store.ts';
import { handler } from '../server/index.ts';
import type { Segment } from '../src/sim/types.ts';

/**
 * Тести бекенду (plan.md, 8.1).
 *
 * Головне, що тут перевіряється, — не «чи повертає сервер 200», а два
 * твердження, на яких тримається весь соціальний шар:
 *   • підроблений рахунок відхиляється;
 *   • ЧЕСНИЙ рахунок НЕ відхиляється, навіть коли в грі була чужа павутина.
 * Друге важливіше: сервер, який ріже своїх, гірший за сервер без перевірки.
 */

const TOKEN = 'dev-token-not-a-real-bot';
let fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('server');

// ── initData ──────────────────────────────────────────────────────────────
{
  const now = Math.floor(Date.now() / 1000);
  const fields = {
    auth_date: String(now),
    query_id: 'AAE',
    user: JSON.stringify({ id: 777, first_name: 'Тест' }),
    chat_instance: '-123456789',
  };
  const good = signInitData(fields, TOKEN);

  const v = validateInitData(good, TOKEN);
  ok('валідний initData приймається', v.ok && v.userId === 777 && v.chatId === '-123456789',
    v.ok ? '' : `— ${v.reason}`);

  ok('чужий токен відхиляється', !validateInitData(good, 'інший-токен').ok);

  const tampered = good.replace('id%22%3A777', 'id%22%3A888');
  ok('підміна user.id відхиляється', !validateInitData(tampered, TOKEN).ok);

  const stale = signInitData({ ...fields, auth_date: String(now - 100000) }, TOKEN);
  ok('застарілий initData відхиляється', !validateInitData(stale, TOKEN).ok);

  ok('порожній initData відхиляється', !validateInitData('', TOKEN).ok);

  const noUser = signInitData({ auth_date: String(now), chat_instance: 'x' }, TOKEN);
  ok('initData без user відхиляється', !validateInitData(noUser, TOKEN).ok);
}

// ── сід дня ───────────────────────────────────────────────────────────────
{
  const a = dailySeed(new Date('2026-08-31T03:00:00Z'));
  const b = dailySeed(new Date('2026-08-31T22:59:59Z'));
  const c = dailySeed(new Date('2026-09-01T00:00:01Z'));
  ok('сід дня однаковий протягом доби UTC', a.seed === b.seed && a.date === '2026-08-31');
  ok('сід дня змінюється опівночі UTC', a.seed !== c.seed && c.date === '2026-09-01');
}

// ── чесний ран проти підробленого ─────────────────────────────────────────

/** Детермінований «гравець» із фіксованим ритмом — щоб рани були різні. */
function playRun(seed: number, salt: number, web: readonly Segment[] = []) {
  const sim = new Simulation(seed, web);
  const s = sim.state;
  const trace = new InputTrace();
  const hold = 22 + ((salt * 11) % 34);
  const wait = 9 + ((salt * 7) % 13);
  let down = false;
  for (let f = 0; f < 4000 && s.alive; f++) {
    const want = (f % (hold + wait)) < hold;
    if (want !== down) { down = want; trace.record(f, down ? 'down' : 'up'); }
    sim.step(down);
  }
  return {
    traceB64: Buffer.from(trace.serialize()).toString('base64'),
    score: s.score,
    frames: s.frame,
    foreignHooks: s.foreignHooks,
  };
}

{
  const seed = 909;
  const r = playRun(seed, 1);
  ok('чесний ран без павутини приймається',
    verifyRun({ seed, traceB64: r.traceB64, score: r.score, frames: r.frames, webRunIds: [] }, []).ok);

  const inflated = verifyRun({ seed, traceB64: r.traceB64, score: r.score + 1000, frames: r.frames, webRunIds: [] }, []);
  ok('накручений рахунок відхиляється', !inflated.ok);

  const wrongFrames = verifyRun({ seed, traceB64: r.traceB64, score: r.score, frames: r.frames + 60, webRunIds: [] }, []);
  ok('підроблений кадр смерті відхиляється', !wrongFrames.ok);

  const bytes = Buffer.from(r.traceB64, 'base64');
  bytes[3] = (bytes[3] + 7) & 0xff;
  const tamperedTrace = verifyRun(
    { seed, traceB64: bytes.toString('base64'), score: r.score, frames: r.frames, webRunIds: [] }, []);
  ok('зіпсований трек відхиляється', !tamperedTrace.ok);

  const huge = verifyRun(
    { seed, traceB64: Buffer.alloc(9000).toString('base64'), score: 1, frames: 1, webRunIds: [] }, []);
  ok('завеликий трек відхиляється', !huge.ok);

  ok('порожній трек відхиляється',
    !verifyRun({ seed, traceB64: '', score: 0, frames: 0, webRunIds: [] }, []).ok);

  const otherSeed = verifyRun({ seed: seed + 1, traceB64: r.traceB64, score: r.score, frames: r.frames, webRunIds: [] }, []);
  ok('той самий трек на іншому сіді не проходить', !otherSeed.ok);
}

// ── найважливіше: чесний ран У ПАВУТИНІ не відхиляється ───────────────────
{
  const seed = 5150;
  const store = new RunStore();
  const chat = 'chat-1';

  // Троє інших гравців лишили свої рани.
  const foreignIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const p = playRun(seed, i * 3);
    const s = store.add(chat, {
      ownerId: 100 + i, seed, traceB64: p.traceB64, score: p.score, frames: p.frames, day: 0,
    });
    foreignIds.push(s.id);
  }
  const webRuns = store.byIds(chat, seed, foreignIds);
  ok('сховище віддає рівно ті рани, що просили', webRuns.length === 3);

  // Клієнт будує павутину з цих ранів і грає з нею.
  const web = buildWeb(seed, webRuns);
  ok('павутина з чужих ранів не порожня', web.length > 0, `— ${web.length} ліній`);

  const mine = playRun(seed, 2, web);
  const v = verifyRun(
    { seed, traceB64: mine.traceB64, score: mine.score, frames: mine.frames, webRunIds: foreignIds },
    webRuns,
  );
  ok('ЧЕСНИЙ ран у павутині приймається', v.ok, v.ok ? '' : `— ${v.reason}`);

  // Підміна складу павутини має відхилятись — але лише якщо павутина взагалі
  // вплинула на ран. Якщо гравець жодного разу не зачепився за чужу лінію,
  // результат від складу павутини не залежить, і перевірка була б порожньою.
  ok('гравець реально користувався чужою павутиною', mine.foreignHooks > 0,
    );
  if (mine.foreignHooks > 0) {
    const wrongWeb = verifyRun(
      { seed, traceB64: mine.traceB64, score: mine.score, frames: mine.frames, webRunIds: [foreignIds[0]] },
      store.byIds(chat, seed, [foreignIds[0]]),
    );
    ok('підміна складу павутини відхиляється', !wrongWeb.ok,
      wrongWeb.ok ? '— прийнято, хоча павутина інша' : '');
  }

  ok('павутина детермінована',
    JSON.stringify(buildWeb(seed, webRuns)) === JSON.stringify(buildWeb(seed, webRuns.slice().reverse())));
}

// ── HTTP наскрізно ────────────────────────────────────────────────────────
await (async () => {
  process.env.DEV_ALLOW_UNSIGNED = '1';
  const srv = createServer(handler);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  const d = await (await fetch(base + '/api/daily')).json() as { seed: number };
  ok('GET /api/daily віддає сід', Number.isInteger(d.seed));

  const badSession = await post('/api/session', { initData: 'сміття' });
  ok('POST /api/session відхиляє сміття', badSession.status === 401);

  const s1 = await post('/api/session', { initData: 'dev:1001:chatA' });
  ok('dev-сесія працює під прапорцем', s1.status === 200 && s1.body.userId === 1001);

  const seed = 31337;
  const p1 = playRun(seed, 5);
  const sub1 = await post('/api/run', {
    initData: 'dev:1001:chatA', seed, traceB64: p1.traceB64, score: p1.score, frames: p1.frames, webRunIds: [],
  });
  ok('POST /api/run приймає чесний ран', sub1.status === 200 && sub1.body.ok === true,
    JSON.stringify(sub1.body).slice(0, 90));

  const cheat = await post('/api/run', {
    initData: 'dev:1001:chatA', seed, traceB64: p1.traceB64, score: p1.score + 5000, frames: p1.frames, webRunIds: [],
  });
  ok('POST /api/run відхиляє накрутку', cheat.status === 400);

  const noAuth = await post('/api/run', {
    initData: 'підроблено', seed, traceB64: p1.traceB64, score: p1.score, frames: p1.frames, webRunIds: [],
  });
  ok('POST /api/run без валідної сесії відхиляє', noAuth.status === 401);

  // Інший гравець того ж чату бачить чужий ран.
  const runs = await post('/api/runs', { initData: 'dev:2002:chatA', seed });
  const list = runs.body.runs as { id: string }[];
  ok('POST /api/runs віддає чужі рани', runs.status === 200 && list.length === 1);

  // Але не бачить власних.
  const own = await post('/api/runs', { initData: 'dev:1001:chatA', seed });
  ok('свої рани не потрапляють у чужу павутину', (own.body.runs as unknown[]).length === 0);

  // Інший чат ізольований.
  const otherChat = await post('/api/runs', { initData: 'dev:2002:chatB', seed });
  ok('чати ізольовані', (otherChat.body.runs as unknown[]).length === 0);

  // Гравець 2 грає з павутиною гравця 1 і надсилає результат.
  const web2 = buildWeb(seed, list as unknown as StoredRun[]);
  const p2 = playRun(seed, 8, web2);
  const sub2 = await post('/api/run', {
    initData: 'dev:2002:chatA', seed, traceB64: p2.traceB64, score: p2.score, frames: p2.frames,
    webRunIds: list.map(r => r.id),
  });
  ok('наскрізно: ран у чужій павутині приймається', sub2.status === 200 && sub2.body.ok === true,
    JSON.stringify(sub2.body).slice(0, 120));

  const unknownWeb = await post('/api/run', {
    initData: 'dev:2002:chatA', seed, traceB64: p2.traceB64, score: p2.score, frames: p2.frames,
    webRunIds: ['rНЕМАЄ'],
  });
  ok('невідомий id у павутині відхиляється', unknownWeb.status === 400);

  const ev = await post('/api/event', { name: 'run_end' });
  ok('POST /api/event приймає подію', ev.status === 200);

  const nf = await fetch(base + '/api/немає');
  ok('невідомий шлях дає 404', nf.status === 404);

  await new Promise<void>(r => srv.close(() => r()));
})();

console.log(fail === 0 ? '\nSERVER OK' : `\nSERVER FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
