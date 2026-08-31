import { telegram } from './telegram.ts';

/**
 * Клієнт бекенду.
 *
 * Правило: жоден мережевий збій не має ламати гру. Якщо сервера немає —
 * граємо локально з власною павутиною, як у тижні 1. Мережа додає чужі лінії,
 * а не вмикає гру.
 */

export type RemoteRun = {
  id: string;
  ownerId: number;
  traceB64: string;
  score: number;
  day: number;
};

const API_BASE: string = (() => {
  const fromEnv = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API;
  if (fromEnv) return fromEnv;
  // За замовчуванням сервер поруч, на сусідньому порту — так зручно тестувати
  // з телефона в тій самій мережі.
  const { protocol, hostname } = location;
  return `${protocol}//${hostname}:8790`;
})();

const TIMEOUT_MS = 4000;

async function call<T>(path: string, body?: unknown): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(API_BASE + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;   // офлайн, таймаут, CORS — гра просто грає далі
  }
}

export const api = {
  base: API_BASE,

  async daily(): Promise<{ seed: number; date: string } | null> {
    return call('/api/daily');
  },

  async session(): Promise<{
    ok: boolean; userId: number; chatId: string;
    streak: number; revives: number; skin: string | null; skins: string[];
  } | null> {
    return call('/api/session', { initData: telegram.initData() });
  },

  async runs(seed: number): Promise<RemoteRun[]> {
    const r = await call<{ ok: boolean; runs: RemoteRun[] }>(
      '/api/runs', { initData: telegram.initData(), seed });
    return r?.runs ?? [];
  },

  async submit(run: {
    seed: number; traceB64: string; score: number; frames: number;
    webRunIds: string[]; challengeToken?: string | null;
  }): Promise<{
    ok: boolean; reason?: string; id?: string;
    foreignHooks?: number;
    /** Токен виклику, ЯКЩО сервер зарахував цей ран як відповідь на нього. */
    repliedTo?: string | null;
  } | null> {
    return call('/api/run', { initData: telegram.initData(), ...run });
  },

  /** Створити виклик зі свого рану. Повертає токен і діп-лінк. */
  async challenge(seed: number, runId: string): Promise<{ token: string; link: string; score: number } | null> {
    const r = await call<{ ok: boolean; token: string; link: string; score: number }>(
      '/api/challenge', { initData: telegram.initData(), seed, runId });
    return r?.ok ? r : null;
  },

  /** Відкрити виклик за токеном із start_param. */
  async openChallenge(token: string): Promise<{ seed: number; challengerId: number; score: number } | null> {
    const r = await call<{ ok: boolean; seed: number; challengerId: number; score: number }>(
      '/api/challenge/open', { initData: telegram.initData(), token });
    return r?.ok ? r : null;
  },

  /** Каталог, баланс продовжень і куплені скіни. */
  async shop(): Promise<{
    ok: boolean;
    products: { id: string; kind: string; title: string; description: string; stars: number; revives: number }[];
    revives: number; skins: string[]; skin: string | null;
    starsAvailable: boolean; devGrant?: boolean;
  } | null> {
    return call('/api/shop', { initData: telegram.initData() });
  },

  /** Посилання на інвойс Stars. Без токена бота сервер віддає dev-видачу. */
  async invoice(productId: string): Promise<{
    ok: boolean; link?: string; dev?: boolean; granted?: boolean;
    revives?: number; note?: string; reason?: string;
  } | null> {
    return call('/api/iap/invoice', { initData: telegram.initData(), productId });
  },

  /**
   * Заявити перегляд реклами. Працює ЛИШЕ в режимі розробки: у продакшні
   * нараховує тільки серверний колбек Adsgram, і сервер тут відповість 403.
   */
  async adClaim(rid: string): Promise<{ ok: boolean; revives?: number } | null> {
    return call('/api/ad/claim', { initData: telegram.initData(), rid });
  },

  /**
   * Оплатити одне воскресіння. Клієнт воскресає ЛИШЕ після ok від сервера:
   * інакше продовження, за яке не заплачено, потрапить у трек, і сервер
   * відхилить увесь ран.
   */
  async reserveRevive(): Promise<{ ok: boolean; revives?: number; reason?: string } | null> {
    return call('/api/revive', { initData: telegram.initData() });
  },

  async setSkin(skinId: string): Promise<{ ok: boolean } | null> {
    return call('/api/skin', { initData: telegram.initData(), skinId });
  },

  /**
   * Подія аналітики. З тиждня 6 подія без сесії не приймається — інакше
   * чисельник гейта 3 накручується звичайним curl (дефект 50).
   */
  async event(name: string, props?: Record<string, string | number | boolean>): Promise<void> {
    void call('/api/event', { initData: telegram.initData(), name, props });
  },
};
