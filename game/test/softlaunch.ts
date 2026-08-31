import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Retention, GATE4, countersFrom } from '../server/retention.ts';
import { Journal } from '../server/journal.ts';

/**
 * Готовність до софтлончу (plan.md, розділ 11).
 *
 * Гейт 4 вимагає **мінімум двох тижнів** збору даних. Тому головна
 * перевірка тут — не «чи працює ендпоінт», а **чи переживають дані
 * перезапуск сервера**. До тижня 7 не переживали: усе жило в пам'яті
 * процесу, і перший же деплой стирав софтлонч.
 *
 * Друга половина — арифметика гейта 4. Вона проста, і саме тому в ній
 * легко збрехати: якщо порахувати D7 для людини, яка прийшла вчора, як
 * «не повернулася», ретеншен занижується тим сильніше, чим швидше росте
 * аудиторія. Тут це перевіряється явно.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server', 'index.ts');

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('softlaunch');

const DAY = 86400000;

// ── Ретеншен: когорта, що не дозріла, у знаменник не входить ──────────────

{
  const r = new Retention();
  const t0 = 1_700_000_000_000;          // якийсь фіксований момент

  // Гравець A: прийшов у день 0, повернувся в день 1 і в день 7.
  r.touch(1, t0);
  r.touch(1, t0 + DAY);
  r.touch(1, t0 + 7 * DAY);
  // Гравець B: прийшов у день 0 і не повернувся.
  r.touch(2, t0);
  // Гравець C: прийшов у день 7 — для нього ні D1, ні D7 ще не настали.
  r.touch(3, t0 + 7 * DAY);

  const m = r.metrics(countersFrom([]), t0 + 7 * DAY + 3600000);
  ok('усі троє порахувалися як гравці', m.users === 3, String(m.users));
  ok('когорта D1 — лише ті, у кого день настав', m.cohortD1 === 2, String(m.cohortD1));
  ok('когорта D7 — так само', m.cohortD7 === 2, String(m.cohortD7));
  ok('D1 = 1 з 2', Math.abs((m.d1 ?? -1) - 0.5) < 1e-9, String(m.d1));
  ok('D7 = 1 з 2', Math.abs((m.d7 ?? -1) - 0.5) < 1e-9, String(m.d7));

  // Той самий набір, але «сьогодні» — день приходу. Питати нема про що.
  const early = r.metrics(countersFrom([]), t0 + 3600000);
  ok('на першу добу D1 ще НЕМАЄ ДАНИХ, а не нуль', early.d1 === null, String(early.d1));
  ok('і вердикт каже n/a', early.verdict.d1 === 'n/a', early.verdict.d1);

  const cohorts = r.cohorts(t0 + 7 * DAY + 3600000);
  ok('когорти згруповані за днем приходу', cohorts.length === 2, String(cohorts.length));
  ok('свіжа когорта позначена як «ще рано»',
    cohorts[cohorts.length - 1].d1 === null, JSON.stringify(cohorts[cohorts.length - 1]));
}

// ── Сесії ─────────────────────────────────────────────────────────────────

{
  const r = new Retention();
  // Рівно 09:00 UTC. Це не педантизм: метрика плану — «сесій НА ДЕНЬ», тож
  // сесія, що перетинає північ, лягає у два дні, і випадковий t0 давав
  // 1 замість 2. Гравці справді грають опівночі — просто у вимірі це має
  // бути видно навмисно, а не випадково.
  const t0 = 19675 * DAY + 9 * 3600000;
  // Одна сесія: три події з інтервалом 5 хвилин.
  r.touch(9, t0);
  r.touch(9, t0 + 5 * 60000);
  r.touch(9, t0 + 10 * 60000);
  // Друга сесія: через дві години.
  r.touch(9, t0 + 130 * 60000);
  r.touch(9, t0 + 136 * 60000);

  const m = r.metrics(countersFrom([]), t0 + 137 * 60000);
  ok('дві сесії за день, бо між ними більш ніж півгодини',
    Math.abs((m.sessionsPerDay ?? 0) - 2) < 1e-9, String(m.sessionsPerDay));
  ok('середня довжина сесії — 8 хвилин',
    Math.abs((m.sessionMinutes ?? 0) - 8) < 1e-9, String(m.sessionMinutes));
}

// ── Rewarded opt-in і payer conversion ────────────────────────────────────

{
  const r = new Retention();
  const t0 = 1_700_000_000_000;
  for (let u = 1; u <= 10; u++) r.touch(u, t0);
  const events = [
    ...[1, 2, 3, 4].map(userId => ({ name: 'ad_offer', userId })),
    { name: 'ad_watched', userId: 1 },
    { name: 'ad_watched', userId: 1 },     // той самий — не подвоює
    { name: 'iap_purchased', userId: 2 },
  ];
  const m = r.metrics(countersFrom(events), t0 + 3600000);
  // ДЕФЕКТ 52. Спершу opt-in рахувався за РІЗНИМИ ЛЮДЬМИ: скільки з тих,
  // кому показали, подивилися хоч раз. Репетиція софтлончу показала, чому
  // це неправильно: з десятком пропозицій на гравця метрика насичується до
  // одиниці (82 % при закладених 22 %) і, головне, накручується простим
  // збільшенням кількості показів. Знаменник — ПОКАЗИ: 2 перегляди з 4
  // пропозицій, а не 1 людина з 4.
  ok('rewarded opt-in рахується за ПОКАЗАМИ, а не за людьми',
    Math.abs((m.rewardedOptIn ?? 0) - 0.5) < 1e-9, String(m.rewardedOptIn));
  ok('payer conversion від усіх гравців',
    Math.abs((m.payerConversion ?? 0) - 0.1) < 1e-9, String(m.payerConversion));
  ok('пороги гейта 4 взяті з плану',
    GATE4.d1 === 0.27 && GATE4.d7 === 0.10 && GATE4.payerConversion === 0.01);
}

// ── Журнал ────────────────────────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'pav-'));
  const j = new Journal(dir);
  j.append({ t: 'seen', userId: 1, how: 'organic' });
  j.append({ t: 'reserve', userId: 1 });
  ok('журнал пише файл', existsSync(j.path));
  ok('і читає його назад', j.readAll().length === 2);

  // Обірваний рядок — звичайний наслідок жорсткого вимкнення.
  appendFileSync(j.path, '{"t":"seen","userId":', 'utf8');
  ok('пошкоджений хвіст не роняє читання', j.readAll().length === 2);

  const off = new Journal('');
  off.append({ t: 'seen', userId: 2, how: 'organic' });
  ok('порожня тека вимикає журнал', !off.on && off.readAll().length === 0);

  rmSync(dir, { recursive: true, force: true });
}

// ── Головне: дані переживають перезапуск ──────────────────────────────────

await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pav-run-'));
  const port = 9100 + Math.floor(Math.random() * 400);
  const B = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir, PORT: String(port),
    DEV_ALLOW_UNSIGNED: '1', ADSGRAM_SECRET: 'sl-secret',
  };

  const start = async (): Promise<ChildProcess> => {
    const p = spawn(process.execPath, [SERVER], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${B}/health`);
        if (r.ok) return p;
      } catch { /* ще піднімається */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('сервер не піднявся');
  };
  const stop = (p: ChildProcess) => new Promise<void>(r => {
    p.once('exit', () => r());
    p.kill('SIGKILL');           // саме жорстко: перевіряємо найгірший випадок
  });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(B + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { s: r.status, j: await r.json() as Record<string, any> };
  };

  const U = 'dev:5001:chatS';
  let srv = await start();

  await post('/api/session', { initData: U });
  await post('/api/event', { initData: U, name: 'run_start', props: { seed: 1 } });
  await post('/api/event', { initData: U, name: 'run_end', props: { score: 42, cause: 'left' } });
  await fetch(`${B}/api/ad/callback?userid=5001&rid=r1&secret=sl-secret`);

  const before = await (await fetch(`${B}/health`)).json() as Record<string, any>;
  ok('перед перезапуском є події й гравець',
    before.events >= 3 && before.users === 1, JSON.stringify(before));

  // Жорстке вбивство: саме так процес зупиняє хостинг при падінні.
  await stop(srv);
  ok('журнал лишився на диску', existsSync(join(dir, 'journal.jsonl')));

  srv = await start();
  const after = await (await fetch(`${B}/health`)).json() as Record<string, any>;
  ok('ПІСЛЯ ПЕРЕЗАПУСКУ ПОДІЇ НА МІСЦІ', after.events >= 3, JSON.stringify(after));
  ok('і гравець на місці', after.users === 1, String(after.users));

  const shop = await post('/api/shop', { initData: U });
  ok('нараховане за рекламу продовження пережило перезапуск',
    shop.j.revives === 1, String(shop.j.revives));

  const m = await (await fetch(`${B}/api/metrics`)).json() as Record<string, any>;
  ok('метрики рахуються з відновлених даних', m.gate4.users === 1, JSON.stringify(m.gate4));
  ok('причина смерті теж збереглася',
    readFileSync(join(dir, 'journal.jsonl'), 'utf8').includes('"cause":"left"'));

  // Клієнтські помилки: без них софтлонч сліпий на падіння.
  const anon = await fetch(B + '/api/clienterror', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'без сесії' }),
  });
  ok('помилка без сесії не приймається', anon.status === 401);
  const errOk = await post('/api/clienterror', { initData: U, message: 'TypeError: x is not a function', where: 'main.ts:1:1' });
  ok('помилка з сесією приймається', errOk.s === 200);
  const empty = await post('/api/clienterror', { initData: U, message: '' });
  ok('порожнє повідомлення відхиляється', empty.s === 400);
  const dash = await (await fetch(B + '/dashboard')).text();
  ok('помилка видно на дашборді', dash.includes('is not a function'));
  const h2 = await (await fetch(B + '/health')).json() as Record<string, any>;
  ok('лічильник помилок у /health', h2.clientErrors === 1, String(h2.clientErrors));

  // ДЕФЕКТ 56: дашборд і метрики були відкриті всім, хто знає адресу.
  {
    const openNow = await fetch(B + '/dashboard');
    ok('без ADMIN_SECRET дашборд відкритий (режим розробки)', openNow.status === 200);
  }

  // Обмеження частоти.
  let limited = false;
  for (let i = 0; i < 130 && !limited; i++) {
    const r = await post('/api/event', { initData: U, name: 'run_start' });
    if (r.s === 429) limited = true;
  }
  ok('надто часті запити впираються в обмеження', limited);

  const health = await fetch(`${B}/health`);
  ok('перевірка живості відповідає навіть під лімітом', health.status === 200);

  await stop(srv);
  rmSync(dir, { recursive: true, force: true });
})();

// ── Секрет адміністратора справді закриває дашборд ────────────────────────

await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pav-adm-'));
  const port = 9500 + Math.floor(Math.random() * 90);
  const B = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), ADMIN_SECRET: 'secret-for-tests' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${B}/health`)).ok) break; } catch { /* піднімається */ }
      await new Promise(r => setTimeout(r, 100));
    }
    ok('із ADMIN_SECRET дашборд без секрета — 403',
      (await fetch(`${B}/dashboard`)).status === 403);
    ok('із правильним секретом — 200',
      (await fetch(`${B}/dashboard?secret=secret-for-tests`)).status === 200);
    ok('метрики так само закриті',
      (await fetch(`${B}/api/metrics`)).status === 403);
    ok('перевірка живості лишається відкритою',
      (await fetch(`${B}/health`)).status === 200);
    const h = await (await fetch(`${B}/health`)).json() as Record<string, any>;
    ok('і не видає шлях у файловій системі', h.journal === 'увімкнено', String(h.journal));
  } finally {
    p.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
})();

console.log(fail === 0 ? '\nSOFTLAUNCH OK' : `\nSOFTLAUNCH FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
