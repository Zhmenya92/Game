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

  async session(): Promise<{ ok: boolean; userId: number; chatId: string } | null> {
    return call('/api/session', { initData: telegram.initData() });
  },

  async runs(seed: number): Promise<RemoteRun[]> {
    const r = await call<{ ok: boolean; runs: RemoteRun[] }>(
      '/api/runs', { initData: telegram.initData(), seed });
    return r?.runs ?? [];
  },

  async submit(run: {
    seed: number; traceB64: string; score: number; frames: number; webRunIds: string[];
  }): Promise<{ ok: boolean; reason?: string } | null> {
    return call('/api/run', { initData: telegram.initData(), ...run });
  },

  async event(name: string): Promise<void> {
    void call('/api/event', { name });
  },
};
