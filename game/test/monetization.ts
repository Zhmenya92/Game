import { createServer } from 'node:http';
import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { playTrace } from '../src/sim/playback.ts';
import { BALANCE } from '../src/config/balance.ts';
import { verifyRun } from '../server/verify.ts';
import { Wallet, Skins } from '../server/wallet.ts';
import { CATALOG, productById, parsePayload, invoicePayload } from '../server/stars.ts';
import { Analytics, isEventName, sanitizeProps } from '../server/analytics.ts';
import { handler, handleUpdate, wallet as srvWallet } from '../server/index.ts';

/**
 * Монетизація й аналітика (plan.md, розділ 10).
 *
 * Головне, що тут перевіряється, — не «чи працює кнопка», а те, що
 * продовження **не можна намалювати**:
 *   • воскресіння лишає слід у треку, і реплей відтворює ран точно;
 *   • сервер рахує воскресіння сам, переграванням, і списує саме стільки;
 *   • нарахування ідемпотентні, бо і Telegram, і Adsgram повторюють доставку;
 *   • подія аналітики без сесії не приймається.
 *
 * Чого тут НЕМАЄ і бути не може: перевірки проти живого Telegram і живого
 * Adsgram. Для них потрібні токен бота й акаунт рекламної мережі. Тому
 * перевірена ЛИШЕ наша половина — розбір оновлень і реакція на них.
 */

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('monetization');

// ── Воскресіння в симуляції ───────────────────────────────────────────────

function sig(sim: Simulation): string {
  const s = sim.state;
  return [s.frame, s.px, s.py, s.vx, s.vy, s.attached ? 1 : 0,
          s.ax, s.ay, s.ropeLen, s.score, s.revives, s.killX].join(',');
}

/** Ран із наївним ритмом, який гине, і воскресіннями після смерті. */
function playWithRevives(seed: number, maxRevives: number, frames = 2400) {
  const sim = new Simulation(seed, []);
  const tr = new InputTrace();
  let down = false, used = 0;
  for (let f = 0; f < frames; f++) {
    if (!sim.state.alive) {
      if (used >= maxRevives) break;
      if (!sim.revive()) break;
      tr.record(sim.state.frame, 'revive');
      used++;
    }
    const want = (f % 40) < 26;
    if (want !== down) { down = want; tr.record(f, down ? 'down' : 'up'); }
    sim.step(down);
  }
  return { sim, trace: tr, used };
}

{
  const sim = new Simulation(1, []);
  ok('живого воскресити не можна', !sim.revive());

  // Доводимо до смерті, нічого не натискаючи.
  for (let f = 0; f < 4000 && sim.state.alive; f++) sim.step(false);
  ok('гравець таки загинув', !sim.state.alive);

  const beforeScore = sim.state.score;
  const beforeX = sim.state.px;
  ok('воскресіння спрацювало', sim.revive());
  ok('рахунок не змінився', sim.state.score === beforeScore, `${beforeScore} → ${sim.state.score}`);
  ok('позиція по X не змінилася — воскресіння не продає очки',
    sim.state.px === beforeX, `${beforeX} → ${sim.state.px}`);
  ok('стіна відсунулась рівно на константу',
    Math.abs((sim.state.px - sim.state.killX) - BALANCE.reviveWallGap) < 1e-9,
    String(sim.state.px - sim.state.killX));
  ok('трос відпущено', !sim.state.attached);
  ok('результат рану скинуто', sim.result() === null);
}

{
  const sim = new Simulation(2, []);
  for (let i = 0; i < BALANCE.reviveMaxPerRun + 2; i++) {
    for (let f = 0; f < 4000 && sim.state.alive; f++) sim.step(false);
    sim.revive();
  }
  ok(`стеля воскресінь на ран — ${BALANCE.reviveMaxPerRun}`,
    sim.state.revives === BALANCE.reviveMaxPerRun, String(sim.state.revives));
}

// ── Трек: воскресіння переживає серіалізацію і не чіпає кнопку ────────────

{
  const t = new InputTrace();
  t.record(10, 'down');
  t.record(20, 'revive');
  t.record(20, 'revive');
  t.record(30, 'up');
  ok('два воскресіння підряд не зливаються в одне', t.reviveCount === 2);
  ok('isDownAt не збивається воскресінням', t.isDownAt(25) === true);
  ok('isReviveAt бачить кадр', t.isReviveAt(20) && !t.isReviveAt(21));

  const round = InputTrace.deserialize(t.serialize());
  ok('serialize → deserialize зберігає воскресіння',
    round.reviveCount === 2 && round.hash() === t.hash());
}

// ── Головне: реплей із воскресінням відтворює живий ран точно ─────────────

{
  const live = playWithRevives(4242, 2);
  ok('бот справді скористався воскресінням', live.used >= 1, String(live.used));

  const replayed = new Simulation(4242, []);
  playTrace(replayed, live.trace, live.sim.state.frame + 1);
  ok('РЕПЛЕЙ ІЗ ВОСКРЕСІННЯМ ЗБІГАЄТЬСЯ З ЖИВИМ РАНОМ',
    sig(replayed) === sig(live.sim),
    `\n       live=${sig(live.sim)}\n       repl=${sig(replayed)}`);
}

// ── Серверна верифікація рахує воскресіння сама ──────────────────────────

{
  const live = playWithRevives(777, 2);
  const b64 = Buffer.from(live.trace.serialize()).toString('base64');
  const v = verifyRun({
    seed: 777, traceB64: b64, score: live.sim.state.score,
    frames: live.sim.state.frame, webRunIds: [],
  }, []);
  ok('чесний ран із воскресіннями приймається', v.ok === true,
    v.ok ? '' : v.reason);
  ok('сервер порахував ті самі воскресіння',
    v.ok && v.revives === live.sim.state.revives,
    v.ok ? `${v.revives} проти ${live.sim.state.revives}` : '');
}

{
  // Трек із воскресіннями понад стелю відхиляється до програвання.
  const t = new InputTrace();
  t.record(0, 'down');
  for (let i = 0; i < BALANCE.reviveMaxPerRun + 1; i++) t.record(100 + i, 'revive');
  const v = verifyRun({
    seed: 1, traceB64: Buffer.from(t.serialize()).toString('base64'),
    score: 0, frames: 200, webRunIds: [],
  }, []);
  ok('трек із воскресіннями понад стелю відхиляється',
    v.ok === false && v.reason.includes('стеля'), v.ok ? '' : v.reason);
}

// ── Гаманець ──────────────────────────────────────────────────────────────

{
  const w = new Wallet();
  ok('порожній баланс — нуль', w.balance(1) === 0);
  ok('нарахування працює', w.grant(1, 3, 'purchase', 'tg:abc') && w.balance(1) === 3);
  ok('ПОВТОРНА доставка того самого платежу не нараховує вдруге',
    !w.grant(1, 3, 'purchase', 'tg:abc') && w.balance(1) === 3);
  ok('списати більше, ніж є, не можна', !w.consume(1, 5, 'run:1') && w.balance(1) === 3);
  ok('списання працює', w.consume(1, 2, 'run:1') && w.balance(1) === 1);
  ok('повторна відправка того самого рану не списує вдруге',
    w.consume(1, 2, 'run:1') && w.balance(1) === 1);
  ok('нуль списується без помилки', w.consume(1, 0, 'run:2'));

  // Оплата в мить використання (дефект 51).
  const r = new Wallet();
  ok('без балансу воскресіння не оплатити', !r.reserve(7));
  r.grant(7, 2, 'purchase', 'p7');
  ok('оплата знімає з балансу одразу', r.reserve(7) && r.balance(7) === 1 && r.pendingFor(7) === 1);
  ok('ран із більшою кількістю воскресінь, ніж оплачено, не звіряється', !r.settle(7, 2));
  ok('ран рівно на оплачене звіряється', r.settle(7, 1) && r.pendingFor(7) === 0);
  ok('ран без воскресінь звіряється завжди', r.settle(7, 0));
  const t = w.totals();
  ok('зведення сходиться', t.granted === 3 && t.consumed === 2, JSON.stringify(t));
}

{
  const sk = new Skins();
  ok('невідомий скін вдягти не можна', !sk.setActive(5, 'amber'));
  ok('скін видається', sk.grant(5, 'amber', 'tg:1') && sk.has(5, 'amber'));
  ok('повторна видача того самого платежу — ні', !sk.grant(5, 'amber', 'tg:1'));
  ok('куплений скін вдягається', sk.setActive(5, 'amber') && sk.activeFor(5) === 'amber');
}

// ── Каталог і payload ─────────────────────────────────────────────────────

{
  ok('каталог не порожній і має ціни в Stars',
    CATALOG.length > 0 && CATALOG.every(p => p.stars > 0));
  ok('товар знаходиться за id', productById('revive3')?.revives === 3);
  ok('невідомого товару немає', productById('нема') === null);

  const pl = invoicePayload(42, 'revive3', 'nonce1');
  const parsed = parsePayload(pl);
  ok('payload розбирається назад',
    parsed?.userId === 42 && parsed.productId === 'revive3' && parsed.nonce === 'nonce1');
  ok('сміття в payload не проходить', parsePayload('казна-що') === null);
}

// ── Аналітика ─────────────────────────────────────────────────────────────

{
  ok('імена подій зі списку плану', isEventName('ghost_beaten') && !isEventName('run_end2'));

  const p = sanitizeProps({ score: 10, cause: 'left', ok: true, 'Погане Ім\'я': 1, big: 'x'.repeat(200) });
  ok('пропси чистяться, а не відхиляються',
    p.score === 10 && p.cause === 'left' && p.ok === true
    && !('Погане Ім\'я' in p) && String(p.big).length === 64,
    JSON.stringify(p));

  const a = new Analytics();
  a.add('run_end', 1, { cause: 'left' });
  a.add('run_end', 1, { cause: 'fell' });
  a.add('run_end', 2, { cause: 'left' });
  const bd = a.breakdown('run_end', 'cause');
  ok('розподіл причин смерті', bd.fell === 1 && bd.left === 2, JSON.stringify(bd));
  ok('унікальні користувачі рахуються окремо від подій',
    a.count('run_end') === 3 && a.users('run_end') === 2);

  ok('перший день — серія 1', a.touchDay(9, 100) === 1);
  ok('той самий день серію не подовжує', a.touchDay(9, 100) === 1);
  ok('наступний день подовжує', a.touchDay(9, 101) === 2);
  ok('пропущений день серію рве', a.touchDay(9, 105) === 1);
}

// ── Наскрізно по HTTP ─────────────────────────────────────────────────────

await (async () => {
  process.env.DEV_ALLOW_UNSIGNED = '1';
  process.env.ADSGRAM_SECRET = 'ad-secret-123';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret-123';
  const srv = createServer(handler);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const B = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(B + p, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { s: r.status, j: await r.json() as Record<string, any> };
  };

  const U = 'dev:900:chatM';

  // Аналітика тепер за сесією.
  const anon = await post('/api/event', { name: 'share_click' });
  ok('подія без сесії відхиляється (дефект 50)', anon.s === 401, String(anon.s));
  const bad = await post('/api/event', { initData: U, name: 'вигадана' });
  ok('невідома подія відхиляється', bad.s === 400);
  const good = await post('/api/event', { initData: U, name: 'share_click', props: { n: 1 } });
  ok('відома подія приймається', good.s === 200);

  const ses = await post('/api/session', { initData: U });
  ok('сесія віддає серію днів і баланс',
    ses.s === 200 && ses.j.streak === 1 && ses.j.revives === 0, JSON.stringify(ses.j));

  const shop = await post('/api/shop', { initData: U });
  ok('магазин віддає каталог', shop.s === 200 && shop.j.products.length === CATALOG.length);
  ok('без токена бота Stars позначені недоступними', shop.j.starsAvailable === false);

  // Ран із воскресінням БЕЗ балансу — відмова.
  const live = playWithRevives(31337, 1);
  ok('бот скористався воскресінням для HTTP-перевірки', live.used === 1);
  const body = {
    initData: U, seed: 31337,
    traceB64: Buffer.from(live.trace.serialize()).toString('base64'),
    score: live.sim.state.score, frames: live.sim.state.frame, webRunIds: [],
  };
  const poor = await post('/api/run', body);
  ok('ран із воскресінням без оплати НЕ приймається',
    poor.s === 402 && String(poor.j.reason).includes('оплачено'), JSON.stringify(poor.j));

  const noMoney = await post('/api/revive', { initData: U });
  ok('оплатити воскресіння без балансу не можна', noMoney.s === 402);

  // Купівля в режимі розробки.
  const inv = await post('/api/iap/invoice', { initData: U, productId: 'revive3' });
  ok('без токена бота dev-режим видає товар і каже про це',
    inv.s === 200 && inv.j.dev === true && inv.j.revives === 3, JSON.stringify(inv.j));

  const stillPoor = await post('/api/run', body);
  ok('баланс є, але воскресіння не оплачене — ран усе одно не приймається',
    stillPoor.s === 402, JSON.stringify(stillPoor.j));

  const reserved = await post('/api/revive', { initData: U });
  ok('оплата воскресіння знімає з балансу одразу',
    reserved.s === 200 && reserved.j.revives === 2, JSON.stringify(reserved.j));

  const rich = await post('/api/run', body);
  ok('оплачений ран приймається',
    rich.s === 200 && rich.j.ok === true && rich.j.revives === 1, JSON.stringify(rich.j).slice(0, 140));
  ok('баланс саме такий, як після оплати', rich.j.revivesLeft === 2, String(rich.j.revivesLeft));

  const twice = await post('/api/run', body);
  ok('ПОВТОРНА відправка того самого рану не проходить: оплата вже звірена',
    twice.s === 402, JSON.stringify(twice.j));

  // Реклама: тільки серверний колбек із секретом.
  const noSecret = await fetch(`${B}/api/ad/callback?userid=900&rid=r1`);
  ok('колбек реклами без секрета — 403', noSecret.status === 403);
  const before = srvWallet.balance(900);
  const cb1 = await fetch(`${B}/api/ad/callback?userid=900&rid=r1&secret=ad-secret-123`);
  ok('колбек із секретом нараховує', cb1.status === 200 && srvWallet.balance(900) === before + 1);
  await fetch(`${B}/api/ad/callback?userid=900&rid=r1&secret=ad-secret-123`);
  ok('ПОВТОРНИЙ колбек із тим самим rid не нараховує вдруге',
    srvWallet.balance(900) === before + 1, String(srvWallet.balance(900)));

  // Вебхук Telegram.
  const hookBad = await post('/api/telegram/webhook', {}, { 'x-telegram-bot-api-secret-token': 'wrong-secret' });
  ok('вебхук із чужим секретом — 403', hookBad.s === 403);

  const payload = invoicePayload(901, 'revive10', 'n1');
  const paid = {
    message: {
      from: { id: 901 }, chat: { id: 901 },
      successful_payment: {
        invoice_payload: payload, total_amount: 75,
        telegram_payment_charge_id: 'charge-1',
      },
    },
  };
  const h1 = await post('/api/telegram/webhook', paid, { 'x-telegram-bot-api-secret-token': 'hook-secret-123' });
  ok('оплата через вебхук нараховує', h1.s === 200 && srvWallet.balance(901) === 10,
    String(srvWallet.balance(901)));
  await post('/api/telegram/webhook', paid, { 'x-telegram-bot-api-secret-token': 'hook-secret-123' });
  ok('ПОВТОРНА доставка тієї самої оплати не нараховує вдруге',
    srvWallet.balance(901) === 10, String(srvWallet.balance(901)));

  // Чужий товар у payload не нараховує нічого.
  await handleUpdate({
    message: {
      from: { id: 902 }, chat: { id: 902 },
      successful_payment: {
        invoice_payload: 'немаєТакого:902:n', total_amount: 999,
        telegram_payment_charge_id: 'charge-2',
      },
    },
  });
  ok('оплата неіснуючого товару нічого не нараховує', srvWallet.balance(902) === 0);

  // /paysupport не повинен падати без токена.
  let threw = false;
  try {
    await handleUpdate({ message: { from: { id: 903 }, chat: { id: 903 }, text: '/paysupport' } });
  } catch { threw = true; }
  ok('/paysupport без токена не роняє сервер', !threw);

  const dash = await fetch(`${B}/dashboard`);
  const html = await dash.text();
  ok('дашборд аналітики віддається', dash.status === 200 && html.includes('<table'));
  ok('дашборд не малює ретеншен, якого немає', html.includes('D1 / D7'));

  const all = await (await fetch(`${B}/api/metrics`)).json() as Record<string, any>;
  ok('метрики бачать події з аналітики', typeof all.gate3.shareRate === 'number');
  ok('метрики гейта 4 віддаються поруч', typeof all.gate4.users === 'number');
  ok('когорти віддаються масивом', Array.isArray(all.cohorts));

  await new Promise<void>(r => srv.close(() => r()));
})();

console.log(fail === 0 ? '\nMONETIZATION OK' : `\nMONETIZATION FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
