/**
 * Telegram Stars (plan.md, 10.2).
 *
 * ⚠️ ЧЕСНО ПРО СТАН. Жоден виклик у цьому файлі не перевірявся проти живого
 * Telegram: для цього потрібен токен від BotFather, якого немає. Перевірено
 * тестами лише НАШУ половину — розбір оновлень, ідемпотентність нарахування,
 * відмову на чужий payload і на неправильний секрет вебхука. Форми запитів
 * узяті з Bot API; підтвердити їх може тільки живий бот.
 *
 * Що з плану реалізовано дослівно:
 *   • валюта XTR, ціни в Stars, без провайдерського токена;
 *   • обовʼязковий `/paysupport` — без нього це порушення правил Telegram;
 *   • `refundStarPayment` для повернень.
 *
 * Що з плану треба памʼятати перед тим, як радіти доходу: мінімум виводу
 * 1 000 Stars, холд 21 день, ефективно ~$0.009 за Star при мобільній
 * купівлі. Telegram-фаза приносить десятки доларів, і це не спосіб
 * заробити, а спосіб перевірити, чи гра комусь потрібна.
 */

export type Product = {
  id: string;
  kind: 'revives' | 'skin';
  title: string;
  description: string;
  /** Ціна в Stars. START — тюнити за живими даними, а не вгадувати. */
  stars: number;
  /** Скільки продовжень дає. Для скінів — 0. */
  revives: number;
  /** Для скінів — ідентифікатор косметики. */
  skinId?: string;
};

export const CATALOG: readonly Product[] = [
  {
    id: 'revive3', kind: 'revives', stars: 25, revives: 3,
    title: 'Три продовження',
    description: 'Стіна відсувається, рахунок лишається. Три рази за ран.',
  },
  {
    id: 'revive10', kind: 'revives', stars: 75, revives: 10,
    title: 'Десять продовжень',
    description: 'Те саме, вигідніше.',
  },
  {
    id: 'skin_amber', kind: 'skin', stars: 60, revives: 0, skinId: 'amber',
    title: 'Бурштиновий слід',
    description: 'Колір героя і сліду. Косметика, на гру не впливає.',
  },
];

export function productById(id: string): Product | null {
  return CATALOG.find(p => p.id === id) ?? null;
}

/**
 * Адресу можна підмінити — і це не бекдор, а єдиний спосіб перевірити
 * НАШУ половину протоколу без токена: тест піднімає заглушку й дивиться,
 * які саме методи й параметри ми надсилаємо. Проти живого Telegram це
 * нічого не доводить, і так і написано в шапці файлу.
 */
const API = process.env.TELEGRAM_API ?? 'https://api.telegram.org';

export class NoBotToken extends Error {
  constructor() { super('немає BOT_TOKEN — Stars недоступні'); }
}

async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  if (!token || token === 'dev-token-not-a-real-bot') throw new NoBotToken();
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!j.ok) throw new Error(`${method}: ${j.description ?? 'помилка Telegram'}`);
  return j.result as T;
}

/**
 * Посилання на інвойс. Клієнт відкриває його через `WebApp.openInvoice`.
 *
 * `payload` — наше поле, яке Telegram поверне назад у `successful_payment`.
 * Кладемо туди id товару й id користувача: інакше в момент оплати ми не
 * знатимемо, кому нараховувати.
 */
export function invoicePayload(userId: number, productId: string, nonce: string): string {
  return `${productId}:${userId}:${nonce}`;
}

export function parsePayload(payload: string): { productId: string; userId: number; nonce: string } | null {
  const [productId, user, nonce] = String(payload).split(':');
  const userId = Number(user);
  if (!productId || !Number.isInteger(userId) || !nonce) return null;
  return { productId, userId, nonce };
}

export async function createInvoiceLink(
  token: string, p: Product, payload: string,
): Promise<string> {
  return call<string>(token, 'createInvoiceLink', {
    title: p.title,
    description: p.description,
    payload,
    // Для Stars провайдерський токен не потрібен, валюта — XTR.
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: p.title, amount: p.stars }],
  });
}

export async function answerPreCheckout(
  token: string, queryId: string, ok: boolean, errorMessage?: string,
): Promise<void> {
  await call(token, 'answerPreCheckoutQuery', {
    pre_checkout_query_id: queryId,
    ok,
    ...(ok ? {} : { error_message: errorMessage ?? 'Товар недоступний' }),
  });
}

export async function sendMessage(token: string, chatId: number | string, text: string): Promise<void> {
  await call(token, 'sendMessage', { chat_id: chatId, text });
}

/**
 * Повернення (plan.md, 10.2). Викликається вручну через адмінський ендпоінт:
 * автоматичних повернень ми не робимо, бо це прямий вектор зловживання.
 */
export async function refundStarPayment(
  token: string, userId: number, chargeId: string,
): Promise<void> {
  await call(token, 'refundStarPayment', {
    user_id: userId,
    telegram_payment_charge_id: chargeId,
  });
}

/** Текст `/paysupport`. Обовʼязковий за правилами Telegram. */
export const PAYSUPPORT_TEXT =
  'Підтримка з питань оплати.\n\n' +
  'Якщо продовження не нарахувалися після оплати — надішліть сюди час покупки, ' +
  'і ми перевіримо за ідентифікатором платежу.\n' +
  'Повернення Stars робиться вручну за зверненням: напишіть, що саме сталося.\n' +
  'Куплені продовження витрачаються лише під час гри й не згорають.';
