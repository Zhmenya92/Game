import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BALANCE } from '../src/config/balance.ts';
import { validateInitData } from './auth.ts';
import { verifyRun, type SubmittedRun } from './verify.ts';
import { RunStore } from './store.ts';
import { dailySeed, dayNumber } from './daily.ts';
import { ChallengeStore } from './challenge.ts';
import { computeMetrics } from './metrics.ts';
import { Analytics, isEventName, sanitizeProps } from './analytics.ts';
import { Wallet, Skins } from './wallet.ts';
import {
  CATALOG, productById, createInvoiceLink, answerPreCheckout, sendMessage,
  refundStarPayment, invoicePayload, parsePayload, NoBotToken, PAYSUPPORT_TEXT,
} from './stars.ts';
import { dashboardPage } from './dashboardPage.ts';
import { Journal } from './journal.ts';
import { Retention, dayOf } from './retention.ts';
import type { StoredRun } from './verify.ts';

/**
 * Бекенд прототипу (plan.md, 8.1).
 *
 * Без залежностей: node:http і власна симуляція. Ендпоінти рівно ті, що в
 * плані, мінус ті, що потребують живого бота — savePreparedInlineMessage і
 * /paysupport чекають на токен від BotFather і на spike 0.2.
 */

// Читаємо оточення ПІД ЧАС ВИКЛИКУ, а не на імпорті: інакше значення
// фіксується моментом завантаження модуля, і ні тест, ні змінений конфіг
// його вже не побачать.
const botToken = () => process.env.BOT_TOKEN ?? 'dev-token-not-a-real-bot';
const devAllowUnsigned = () => process.env.DEV_ALLOW_UNSIGNED === '1';

export const store = new RunStore();
export const challenges = new ChallengeStore();
export const analytics = new Analytics();
export const retention = new Retention();

/**
 * Журнал. Порожній DATA_DIR вимикає його — так тести й розробка не
 * сміттять на диск, а софтлонч, навпаки, переживає перезапуск.
 */
export const journal = new Journal(process.env.DATA_DIR ?? '');

/**
 * Клієнтські помилки софтлончу.
 *
 * До цього моменту гра падала МОВЧКИ. Якщо на якомусь Android білий екран,
 * ми дізналися б про це лише тоді, коли хтось із півсотні запрошених
 * здогадався б написати — тобто, найімовірніше, ніколи. Замість цього
 * лишилося б враження, що «людям не зайшло».
 *
 * Тримаємо небагато й у стислому вигляді: однакові помилки об'єднуються за
 * текстом, бо один зламаний пристрій інакше заповнить усе.
 */
export type ClientError = {
  message: string; where: string; ua: string;
  count: number; users: Set<number>; firstAt: number; lastAt: number;
};
export const clientErrors = new Map<string, ClientError>();

function noteError(userId: number, message: string, where: string, ua: string, at: number): void {
  const key = message.slice(0, 120);
  const e = clientErrors.get(key);
  if (e) {
    e.count++; e.users.add(userId); e.lastAt = at;
    if (!e.where && where) e.where = where;
    return;
  }
  if (clientErrors.size >= 200) return;   // далі вже не діагностика, а шум
  clientErrors.set(key, {
    message: key, where: where.slice(0, 200), ua: ua.slice(0, 120),
    count: 1, users: new Set([userId]), firstAt: at, lastAt: at,
  });
}
const startedAt = Date.now();
export const wallet = new Wallet();
export const skins = new Skins();

/** Секрет вебхука Telegram. Без нього вебхук не приймає нічого. */
const webhookSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
/** Секрет серверного колбека Adsgram. Так само обовʼязковий. */
const adsSecret = () => process.env.ADSGRAM_SECRET ?? '';

/** Ім'я бота для діп-лінків. Без токена лишається заглушкою. */
const botName = () => process.env.BOT_NAME ?? 'pavutyna_bot';
const appName = () => process.env.APP_NAME ?? 'play';

type Session = { userId: number; chatId: string };

function auth(initData: string | undefined): Session | { error: string } {
  if (devAllowUnsigned() && initData?.startsWith('dev:')) {
    // Локальна розробка поза Telegram. Вмикається лише явним прапорцем,
    // щоб випадково не потрапити в продакшн.
    const [, user, chat] = initData.split(':');
    return { userId: Number(user) || 1, chatId: chat || 'devchat' };
  }
  const r = validateInitData(initData ?? '', botToken());
  return r.ok ? { userId: r.userId, chatId: r.chatId } : { error: r.reason };
}

/**
 * Обмеження частоти запитів.
 *
 * До софтлончу сервер жив лише в локальній мережі, тож потреби не було.
 * Публічний бекенд без обмеження — це один цикл `for` у чужій консолі,
 * який заповнює журнал сміттям і псує рівно ті дані, заради яких
 * софтлонч і робиться.
 */
const buckets = new Map<string, { n: number; until: number }>();

function allow(key: string, perMinute: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.until) {
    buckets.set(key, { n: 1, until: now + 60000 });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.until) buckets.delete(k);
    }
    return true;
  }
  b.n++;
  return b.n <= perMinute;
}

/** Хто саме стукає. За проксі справжня адреса приходить у заголовку. */
function clientKey(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
  return ip;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > 64 * 1024) throw new Error('тіло завелике');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function adminSecretOk(given: string): boolean {
  const want = process.env.ADMIN_SECRET ?? '';
  return want.length >= 8 && given === want;
}

/** Видати куплене. Одна точка, щоб оплата й dev-режим не розійшлися. */
export function grantProduct(
  userId: number, productId: string, ref: string, source: 'purchase' | 'dev',
): boolean {
  const p = productById(productId);
  if (!p) return false;
  if (p.kind === 'skin' && p.skinId) {
    const okSkin = skins.grant(userId, p.skinId, ref);
    if (okSkin) journal.append({ t: 'skin', userId, skinId: p.skinId, ref });
    return okSkin;
  }
  const okGrant = wallet.grant(userId, p.revives, source, ref);
  if (okGrant) journal.append({ t: 'grant', userId, n: p.revives, source, ref });
  return okGrant;
}

/**
 * Оновлення від Telegram. Розбирається тут, а не в `stars.ts`, бо тільки
 * тут є доступ до гаманця й аналітики.
 *
 * ⚠️ Проти живого Telegram не перевірялося — немає токена. Перевірено
 * тестами лише нашу половину: розбір, ідемпотентність, відмова на чужий
 * товар і на поганий секрет.
 */
export async function handleUpdate(update: Record<string, any>): Promise<void> {
  const token = botToken();

  // 1. Передперевірка. Відповісти треба за 10 секунд, інакше платіж
  //    зривається — тому тут жодних довгих операцій.
  const pcq = update.pre_checkout_query;
  if (pcq) {
    const parsed = parsePayload(String(pcq.invoice_payload ?? ''));
    const product = parsed ? productById(parsed.productId) : null;
    const good = !!product && parsed!.userId === Number(pcq.from?.id);
    try {
      await answerPreCheckout(token, String(pcq.id), good,
        good ? undefined : 'Товар недоступний або замовлення не ваше');
    } catch { /* без токена відповісти нікуди — це нормально в розробці */ }
    return;
  }

  const msg = update.message;
  if (!msg) return;

  // 2. Успішна оплата. Нарахування — ідемпотентне за ідентифікатором
  //    платежу: Telegram повторює доставку, якщо ми не відповіли 200.
  const sp = msg.successful_payment;
  if (sp) {
    const parsed = parsePayload(String(sp.invoice_payload ?? ''));
    const userId = parsed?.userId ?? Number(msg.from?.id);
    const chargeId = String(sp.telegram_payment_charge_id ?? '');
    if (parsed && Number.isInteger(userId) && chargeId) {
      const fresh = grantProduct(userId, parsed.productId, `tg:${chargeId}`, 'purchase');
      if (fresh) {
        track('iap_purchased', userId, {
          product: parsed.productId,
          stars: Number(sp.total_amount ?? 0),
        });
      }
      try {
        await sendMessage(token, msg.chat?.id ?? userId,
          fresh ? 'Оплату отримано, продовження нараховані.'
                : 'Цю оплату вже зараховано раніше.');
      } catch { /* немає токена — писати нікуди */ }
    }
    return;
  }

  // 3. /paysupport — обовʼязковий за правилами Telegram (plan.md, 1.2).
  const text = String(msg.text ?? '');
  if (text.startsWith('/paysupport')) {
    try { await sendMessage(token, msg.chat?.id, PAYSUPPORT_TEXT); } catch { /* без токена */ }
    return;
  }
}

/**
 * Відновлення стану програванням журналу.
 *
 * Тут немає жодної нової ідеї: у грі джерелом істини є трек вводу, а не
 * знімок стану, — і на сервері так само. Порядок записів у журналі і є
 * порядок подій, тож достатньо застосувати їх один за одним.
 */
export function hydrate(): number {
  const recs = journal.readAll();
  for (const r of recs) {
    switch (r.t) {
      case 'run': store.restore(r.chatId, r.run as StoredRun); break;
      case 'challenge': challenges.restore(r.c as never); break;
      case 'open': challenges.open(r.token, r.userId); break;
      case 'reply': challenges.reply(r.token, r.userId, r.seed); break;
      case 'seen': challenges.seen(r.userId, r.how as 'organic' | 'challenge'); break;
      case 'grant': wallet.grant(r.userId, r.n, r.source as never, r.ref); break;
      case 'reserve': wallet.applyReserve(r.userId); break;
      case 'settle': wallet.applySettle(r.userId, r.used); break;
      case 'skin': skins.grant(r.userId, r.skinId, r.ref); break;
      case 'day': analytics.restoreDay(r.userId, r.day); break;
      case 'error': noteError(r.userId, r.message, r.where, r.ua, r.at); break;
      case 'event':
        if (isEventName(r.name)) {
          analytics.record(r.name, r.userId, r.props as never, r.at);
          retention.touch(r.userId, r.at);
        }
        break;
    }
  }
  if (recs.length) console.log(`журнал: відновлено записів — ${recs.length}`);
  return recs.length;
}

/** Записати подію аналітики й одразу — у журнал і в ретеншен. */
function track(name: string, userId: number, props: Record<string, unknown> = {}): void {
  if (!isEventName(name)) return;
  const e = analytics.add(name, userId, sanitizeProps(props));
  retention.touch(userId, e.at);
  journal.append({ t: 'event', name, userId, props: e.props, at: e.at });
}

export async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }

  // Запис коштує дорожче за читання, тому й ліміт для нього суворіший.
  // Вебхук Telegram виключено: його частоту визначає Telegram, і різати
  // її означало б втрачати оплати.
  if (path !== '/api/telegram/webhook') {
    const write = req.method === 'POST';
    if (!allow(`${clientKey(req)}|${write ? 'w' : 'r'}`, write ? 120 : 240)) {
      json(res, 429, { ok: false, reason: 'забагато запитів' });
      return;
    }
  }

  if (path === '/health' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      runs: store.size,
      users: retention.size,
      events: analytics.all().length,
      clientErrors: clientErrors.size,
      journal: journal.on ? journal.path : 'вимкнено',
    });
    return;
  }

  try {
    if (path === '/api/daily' && req.method === 'GET') {
      json(res, 200, dailySeed());
      return;
    }

    if (path === '/api/session' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      // Перша поява користувача. Якщо він прийшов за викликом, походження
      // вже записане в /api/challenge/open і перезаписати його не можна —
      // інакше K-фактор рахувався б від неправильного знаменника.
      challenges.seen(s.userId, 'organic');
      journal.append({ t: 'seen', userId: s.userId, how: 'organic' });
      // Серія днів (plan.md 10.1, day_streak). Рахує сервер, бо клієнту тут
      // вірити не можна взагалі: «я граю 30 днів поспіль» — це один рядок у
      // консолі браузера.
      const streak = analytics.touchDay(s.userId, dayNumber());
      journal.append({ t: 'day', userId: s.userId, day: dayNumber() });
      track('day_streak', s.userId, { days: streak });
      json(res, 200, {
        ok: true, userId: s.userId, chatId: s.chatId,
        streak,
        revives: wallet.balance(s.userId),
        skin: skins.activeFor(s.userId),
        skins: skins.list(s.userId),
      });
      return;
    }

    if (path === '/api/runs' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      const seed = Number(b.seed);
      if (!Number.isInteger(seed)) { json(res, 400, { ok: false, reason: 'поганий сід' }); return; }
      const others = store.others(s.chatId, seed, s.userId, BALANCE.foreignLineLimit);
      json(res, 200, {
        ok: true,
        runs: others.map(r => ({
          id: r.id, ownerId: r.ownerId, traceB64: r.traceB64, score: r.score, day: r.day,
          difficulty: r.difficulty ?? 'normal',
        })),
      });
      return;
    }

    if (path === '/api/run' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }

      const run: SubmittedRun = {
        seed: Number(b.seed),
        traceB64: String(b.traceB64 ?? ''),
        score: Number(b.score),
        frames: Number(b.frames),
        webRunIds: Array.isArray(b.webRunIds) ? (b.webRunIds as unknown[]).map(String) : [],
        difficulty: b.difficulty === 'calm' ? 'calm' : 'normal',
      };
      const webRuns = store.byIds(s.chatId, run.seed, run.webRunIds);
      if (webRuns.length !== run.webRunIds.length) {
        json(res, 400, { ok: false, reason: 'невідомий чужий ран у павутині' });
        return;
      }

      const v = verifyRun(run, webRuns);
      if (!v.ok) { json(res, 400, v); return; }

      // Воскресіння вже оплачені через /api/revive (дефект 51). Тут лише
      // звірка: у треку не може бути більше воскресінь, ніж людина оплатила.
      if (!wallet.settle(s.userId, v.revives)) {
        json(res, 402, {
          ok: false,
          reason: `у треку ${v.revives} воскресінь, оплачено ${wallet.pendingFor(s.userId)}`,
        });
        return;
      }

      journal.append({ t: 'settle', userId: s.userId, used: v.revives });
      const stored = store.add(s.chatId, {
        ownerId: s.userId, seed: run.seed, traceB64: run.traceB64,
        score: v.score, frames: v.frames, day: dayNumber(),
        foreignHooks: v.foreignHooks, difficulty: run.difficulty,
      });

      // Якщо ран зіграно за викликом — це відповідь. Без цього зв'язку
      // reply rate і K-фактор порахувати неможливо.
      journal.append({ t: 'run', chatId: s.chatId, run: stored });

      let repliedTo: string | null = null;
      if (typeof b.challengeToken === 'string' && b.challengeToken) {
        if (challenges.reply(b.challengeToken, s.userId, run.seed)) {
          repliedTo = b.challengeToken;
          journal.append({ t: 'reply', token: b.challengeToken, userId: s.userId, seed: run.seed });
        }
      }

      json(res, 200, {
        ok: true, id: stored.id, score: v.score,
        foreignHooks: v.foreignHooks, revives: v.revives,
        revivesLeft: wallet.balance(s.userId), repliedTo,
      });
      return;
    }

    if (path === '/api/challenge' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      const seed = Number(b.seed);
      const runId = String(b.runId ?? '');
      const mine = store.list(s.chatId, seed).find(r => r.id === runId && r.ownerId === s.userId);
      if (!mine) { json(res, 400, { ok: false, reason: 'немає такого власного рану' }); return; }
      // Виклик на спокійній складності був би нечесним порівнянням: у того,
      // хто кинув, стіна їхала повільніше. Ран лишається, викликом не стає.
      if (mine.difficulty === 'calm') {
        json(res, 400, { ok: false, reason: 'на спокійній складності виклик не кидається' });
        return;
      }
      const c = challenges.create(s.chatId, s.userId, seed, runId, mine.score);
      journal.append({ t: 'challenge', c: { ...c, opens: [], replies: [] } });
      json(res, 200, {
        ok: true,
        token: c.token,
        score: c.score,
        // Діп-лінк за форматом plan.md 8.2: startapp=<токен>
        link: `https://t.me/${botName()}/${appName()}?startapp=${c.token}`,
      });
      return;
    }

    if (path === '/api/challenge/open' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      const c = challenges.open(String(b.token ?? ''), s.userId);
      if (!c) { json(res, 404, { ok: false, reason: 'виклик не знайдено' }); return; }
      journal.append({ t: 'open', token: c.token, userId: s.userId });
      json(res, 200, {
        ok: true, seed: c.seed, challengerId: c.ownerId, score: c.score, chatId: c.chatId,
      });
      return;
    }

    if (path === '/api/metrics' && req.method === 'GET') {
      json(res, 200, {
        gate3: computeMetrics(analytics, challenges, store.counters),
        gate4: retention.metrics(analytics),
        cohorts: retention.cohorts(),
      });
      return;
    }

    if (path === '/api/event' && req.method === 'POST') {
      const b = await readBody(req);
      // ДЕФЕКТ 50. Ендпоінт був відкритий: будь-хто міг звичайним curl
      // накрутити чисельник share rate і зіпсувати гейт 3 — той самий гейт,
      // заради чесності якого писався весь тиждень 4.
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      if (!isEventName(b.name)) {
        json(res, 400, { ok: false, reason: 'невідома подія' });
        return;
      }
      track(b.name, s.userId, b.props as Record<string, unknown>);
      json(res, 200, { ok: true });
      return;
    }

    // ── Магазин і продовження (plan.md, 10.2) ────────────────────────────

    if (path === '/api/clienterror' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      // Окремий, жорсткіший ліміт: помилка в циклі рендера дала б сотні
      // запитів на секунду з одного пристрою.
      if (!allow(`err|${s.userId}`, 6)) { json(res, 429, { ok: false }); return; }
      const message = String(b.message ?? '').slice(0, 200);
      if (!message) { json(res, 400, { ok: false, reason: 'порожнє повідомлення' }); return; }
      const where = String(b.where ?? '').slice(0, 200);
      const ua = String(req.headers['user-agent'] ?? '').slice(0, 120);
      const at = Date.now();
      noteError(s.userId, message, where, ua, at);
      journal.append({ t: 'error', userId: s.userId, message, where, ua, at });
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/shop' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      json(res, 200, {
        ok: true,
        products: CATALOG,
        revives: wallet.balance(s.userId),
        skins: skins.list(s.userId),
        skin: skins.activeFor(s.userId),
        starsAvailable: !!process.env.BOT_TOKEN,
        // Щоб клієнт не показував кнопку покупки там, де вона нічого не
        // зробить, і показував її там, де dev-режим видає товар одразу.
        devGrant: devAllowUnsigned(),
      });
      return;
    }

    if (path === '/api/iap/invoice' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      const p = productById(String(b.productId ?? ''));
      if (!p) { json(res, 400, { ok: false, reason: 'немає такого товару' }); return; }
      track('iap_open', s.userId, { product: p.id, stars: p.stars });

      const nonce = Math.random().toString(36).slice(2, 10);
      const payload = invoicePayload(s.userId, p.id, nonce);
      try {
        const link = await createInvoiceLink(botToken(), p, payload);
        json(res, 200, { ok: true, link, product: p });
      } catch (e) {
        // Без токена Stars недоступні. У режимі розробки товар видається
        // одразу — щоб петлю можна було пройти цілком, — але це ЯВНО
        // позначено в відповіді, щоб ніхто не сплутав із оплатою.
        if (e instanceof NoBotToken && devAllowUnsigned()) {
          grantProduct(s.userId, p.id, `dev:${s.userId}:${nonce}`, 'dev');
          track('iap_purchased', s.userId, { product: p.id, stars: 0, dev: true });
          json(res, 200, {
            ok: true, dev: true, granted: true, product: p,
            revives: wallet.balance(s.userId),
            note: 'без BOT_TOKEN оплати немає — товар видано в режимі розробки',
          });
          return;
        }
        json(res, 503, { ok: false, reason: String((e as Error).message) });
      }
      return;
    }

    // Оплатити воскресіння В МИТЬ використання, а не при відправці рану.
    // Інакше можна воскресати й не надсилати ран (дефект 51).
    if (path === '/api/revive' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      if (!wallet.reserve(s.userId)) {
        json(res, 402, { ok: false, reason: 'немає продовжень' });
        return;
      }
      journal.append({ t: 'reserve', userId: s.userId });
      json(res, 200, { ok: true, revives: wallet.balance(s.userId) });
      return;
    }

    if (path === '/api/skin' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      const id = String(b.skinId ?? '');
      if (!skins.setActive(s.userId, id)) {
        json(res, 400, { ok: false, reason: 'скін не куплений' });
        return;
      }
      json(res, 200, { ok: true, skin: id });
      return;
    }

    // ── Реклама за продовження ───────────────────────────────────────────
    //
    // Нарахування йде ТІЛЬКИ серверним колбеком Adsgram із секретом.
    // Клієнтське «я подивився рекламу» не нараховує нічого: це найпростіший
    // з можливих обманів, і саме так його роблять.

    if (path === '/api/ad/callback') {
      const q = url.searchParams;
      const secret = adsSecret();
      if (!secret || q.get('secret') !== secret) {
        json(res, 403, { ok: false, reason: 'поганий секрет' });
        return;
      }
      const userId = Number(q.get('userid'));
      const rid = q.get('rid') ?? '';
      if (!Number.isInteger(userId) || !rid) {
        json(res, 400, { ok: false, reason: 'потрібні userid і rid' });
        return;
      }
      const fresh = wallet.grant(userId, 1, 'ad', `ad:${rid}`);
      if (fresh) {
        journal.append({ t: 'grant', userId, n: 1, source: 'ad', ref: `ad:${rid}` });
        track('ad_watched', userId, { source: 'adsgram' });
      }
      json(res, 200, { ok: true, granted: fresh, revives: wallet.balance(userId) });
      return;
    }

    if (path === '/api/ad/claim' && req.method === 'POST') {
      const b = await readBody(req);
      const s = auth(b.initData as string | undefined);
      if ('error' in s) { json(res, 401, { ok: false, reason: s.error }); return; }
      if (!devAllowUnsigned()) {
        json(res, 403, {
          ok: false,
          reason: 'нарахування за рекламу — лише серверним колбеком Adsgram',
        });
        return;
      }
      const rid = String(b.rid ?? Math.random().toString(36).slice(2));
      const fresh = wallet.grant(s.userId, 1, 'dev', `devad:${rid}`);
      if (fresh) {
        journal.append({ t: 'grant', userId: s.userId, n: 1, source: 'dev', ref: `devad:${rid}` });
        track('ad_watched', s.userId, { source: 'dev' });
      }
      json(res, 200, { ok: true, granted: fresh, revives: wallet.balance(s.userId), dev: true });
      return;
    }

    // ── Вебхук Telegram: оплати й /paysupport ────────────────────────────

    if (path === '/api/telegram/webhook' && req.method === 'POST') {
      const given = req.headers['x-telegram-bot-api-secret-token'];
      if (!webhookSecret() || given !== webhookSecret()) {
        json(res, 403, { ok: false, reason: 'поганий секрет вебхука' });
        return;
      }
      const update = await readBody(req);
      await handleUpdate(update);
      // Telegram повторює доставку на будь-що, крім 200. Тому відповідаємо
      // 200 навіть на те, чого не зрозуміли: інакше нас закидає повторами.
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/admin/refund' && req.method === 'POST') {
      const b = await readBody(req);
      if (!adminSecretOk(String(b.secret ?? ''))) {
        json(res, 403, { ok: false, reason: 'поганий секрет' });
        return;
      }
      try {
        await refundStarPayment(botToken(), Number(b.userId), String(b.chargeId ?? ''));
        json(res, 200, { ok: true });
      } catch (e) {
        json(res, 503, { ok: false, reason: String((e as Error).message) });
      }
      return;
    }

    if (path === '/dashboard' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dashboardPage(
        computeMetrics(analytics, challenges, store.counters),
        retention.metrics(analytics),
        retention.cohorts(),
        analytics, wallet, store.size,
        [...clientErrors.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 20)
          .map(e => ({ message: e.message, where: e.where, ua: e.ua, count: e.count, users: e.users.size }))));
      return;
    }

    if (path === '/api/stats' && req.method === 'GET') {
      json(res, 200, { runs: store.size, events: analytics.all().length, wallet: wallet.totals() });
      return;
    }

    json(res, 404, { ok: false, reason: 'немає такого ендпоінта' });
  } catch (e) {
    json(res, 400, { ok: false, reason: String((e as Error).message ?? e) });
  }
}

if (import.meta.filename === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8790);
  hydrate();
  const srv = createServer(handler);
  srv.listen(port, '0.0.0.0', () => {
    console.log(`сервер на :${port}` + (devAllowUnsigned() ? ' (DEV_ALLOW_UNSIGNED)' : '')
      + (journal.on ? ` · журнал ${journal.path}` : ' · журнал вимкнено (немає DATA_DIR)'));
  });
  // Хостинги зупиняють процес через SIGTERM. Журнал пишеться синхронно,
  // тож нічого зливати не треба — досить не обривати запити на льоту.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`${sig}: зупиняюсь`);
      srv.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
