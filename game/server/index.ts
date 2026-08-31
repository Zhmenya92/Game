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
  if (p.kind === 'skin' && p.skinId) return skins.grant(userId, p.skinId, ref);
  return wallet.grant(userId, p.revives, source, ref);
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
        analytics.add('iap_purchased', userId, {
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

export async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }

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
      // Серія днів (plan.md 10.1, day_streak). Рахує сервер, бо клієнту тут
      // вірити не можна взагалі: «я граю 30 днів поспіль» — це один рядок у
      // консолі браузера.
      const streak = analytics.touchDay(s.userId, dayNumber());
      analytics.add('day_streak', s.userId, { days: streak });
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

      const stored = store.add(s.chatId, {
        ownerId: s.userId, seed: run.seed, traceB64: run.traceB64,
        score: v.score, frames: v.frames, day: dayNumber(),
        foreignHooks: v.foreignHooks, difficulty: run.difficulty,
      });

      // Якщо ран зіграно за викликом — це відповідь. Без цього зв'язку
      // reply rate і K-фактор порахувати неможливо.
      let repliedTo: string | null = null;
      if (typeof b.challengeToken === 'string' && b.challengeToken) {
        if (challenges.reply(b.challengeToken, s.userId, run.seed)) repliedTo = b.challengeToken;
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
      json(res, 200, {
        ok: true, seed: c.seed, challengerId: c.ownerId, score: c.score, chatId: c.chatId,
      });
      return;
    }

    if (path === '/api/metrics' && req.method === 'GET') {
      json(res, 200, computeMetrics(analytics.all(), challenges, store.allRuns()));
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
      analytics.add(b.name, s.userId, sanitizeProps(b.props));
      json(res, 200, { ok: true });
      return;
    }

    // ── Магазин і продовження (plan.md, 10.2) ────────────────────────────

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
      analytics.add('iap_open', s.userId, { product: p.id, stars: p.stars });

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
          analytics.add('iap_purchased', s.userId, { product: p.id, stars: 0, dev: true });
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
      if (fresh) analytics.add('ad_watched', userId, { source: 'adsgram' });
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
      if (fresh) analytics.add('ad_watched', s.userId, { source: 'dev' });
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
      res.end(dashboardPage(computeMetrics(analytics.all(), challenges, store.allRuns()),
                            analytics, wallet, store.size));
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
  createServer(handler).listen(port, '0.0.0.0', () => {
    console.log(`сервер на :${port}` + (devAllowUnsigned() ? ' (DEV_ALLOW_UNSIGNED)' : ''));
  });
}
