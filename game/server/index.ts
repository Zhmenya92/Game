import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BALANCE } from '../src/config/balance.ts';
import { validateInitData } from './auth.ts';
import { verifyRun, type SubmittedRun } from './verify.ts';
import { RunStore } from './store.ts';
import { dailySeed, dayNumber } from './daily.ts';

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
const events: { name: string; at: number }[] = [];

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
      json(res, 200, { ok: true, userId: s.userId, chatId: s.chatId });
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
      };
      const webRuns = store.byIds(s.chatId, run.seed, run.webRunIds);
      if (webRuns.length !== run.webRunIds.length) {
        json(res, 400, { ok: false, reason: 'невідомий чужий ран у павутині' });
        return;
      }

      const v = verifyRun(run, webRuns);
      if (!v.ok) { json(res, 400, v); return; }

      const stored = store.add(s.chatId, {
        ownerId: s.userId, seed: run.seed, traceB64: run.traceB64,
        score: v.score, frames: v.frames, day: dayNumber(),
      });
      json(res, 200, { ok: true, id: stored.id, score: v.score });
      return;
    }

    if (path === '/api/event' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.name === 'string') events.push({ name: b.name, at: Date.now() });
      if (events.length > 5000) events.splice(0, 2500);
      json(res, 200, { ok: true });
      return;
    }

    if (path === '/api/stats' && req.method === 'GET') {
      json(res, 200, { runs: store.size, events: events.length });
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
