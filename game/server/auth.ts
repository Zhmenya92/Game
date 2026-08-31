import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Валідація `initData` з Telegram Mini App.
 *
 * plan.md, розділ 8.1: «Без цього все інше — фікція». Поки сервер не довів,
 * що дані прийшли від Telegram, будь-який рахунок можна надіслати curl-ом.
 *
 * Алгоритм за офіційною документацією Bot API:
 *   1. Зібрати всі пари key=value, ОКРІМ hash, відсортувати за ключем,
 *      з'єднати через \n — це data_check_string.
 *   2. secret_key = HMAC_SHA256(ключ: "WebAppData", дані: bot_token)
 *   3. очікуваний hash = HMAC_SHA256(ключ: secret_key, дані: data_check_string)
 *
 * Порядок аргументів у кроках 2 і 3 різний, і це найчастіша помилка реалізацій.
 */

export type InitDataResult =
  | { ok: true; userId: number; chatId: string; authDate: number }
  | { ok: false; reason: string };

export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 86400,
  nowSec = Math.floor(Date.now() / 1000),
): InitDataResult {
  if (!initData) return { ok: false, reason: 'порожній initData' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'немає hash' };

  const pairs: string[] = [];
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Порівняння сталого часу: інакше зловмисник підбирає hash побайтово.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'підпис не збігається' };
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate) return { ok: false, reason: 'немає auth_date' };
  if (nowSec - authDate > maxAgeSec) return { ok: false, reason: 'initData застарів' };

  let userId = 0;
  const userRaw = params.get('user');
  if (userRaw) {
    try { userId = Number(JSON.parse(userRaw).id ?? 0); } catch { /* лишається 0 */ }
  }
  if (!userId) return { ok: false, reason: 'немає user.id' };

  // chat_instance стабільний для конкретного чату — саме він робить павутину
  // «своєю в кожному чаті». Поза чатом (запуск із профілю бота) його немає.
  const chatId = params.get('chat_instance') ?? `dm:${userId}`;

  return { ok: true, userId, chatId, authDate };
}

/** Побудова валідного initData — потрібна тестам і локальній розробці. */
export function signInitData(
  fields: Record<string, string>,
  botToken: string,
): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}
