/**
 * Обгортка над Telegram WebApp SDK.
 *
 * Головна вимога: гра мусить працювати і ПОЗА Telegram — у звичайному браузері
 * на телефоні, бо саме так її зараз тестують. Тому все тут з фолбеком, і
 * жоден виклик не кидає, якщо SDK немає.
 *
 * Версійні фолбеки (plan.md, 8.2): клієнти зі старим Bot API не мають частини
 * методів, тому кожен перевіряється окремо, а не гуртом.
 */

type Haptic = {
  impactOccurred?: (style: string) => void;
  notificationOccurred?: (type: string) => void;
};

type WebApp = {
  initData?: string;
  version?: string;
  ready?: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
  HapticFeedback?: Haptic;
  initDataUnsafe?: { start_param?: string };
};

function api(): WebApp | null {
  const w = window as unknown as { Telegram?: { WebApp?: WebApp } };
  return w.Telegram?.WebApp ?? null;
}

export const telegram = {
  /** Чи ми справді всередині Telegram. */
  get inside(): boolean {
    const a = api();
    return !!a && typeof a.initData === 'string' && a.initData.length > 0;
  },

  get version(): string {
    return api()?.version ?? '0';
  },

  /**
   * initData для сервера. Поза Telegram віддаємо dev-рядок — сервер приймає
   * його ЛИШЕ під явним прапорцем DEV_ALLOW_UNSIGNED.
   */
  initData(): string {
    const a = api();
    if (a?.initData) return a.initData;
    let id = localStorage.getItem('pav.devuser');
    if (!id) {
      id = String(1000 + Math.floor(Math.random() * 900000));
      try { localStorage.setItem('pav.devuser', id); } catch { /* приватний режим */ }
    }
    return `dev:${id}:local`;
  },

  /** Параметр діп-лінка: t.me/bot/app?startapp=<...> */
  startParam(): string | null {
    return api()?.initDataUnsafe?.start_param ?? null;
  },

  init(): void {
    const a = api();
    if (!a) return;
    try { a.ready?.(); } catch { /* старий клієнт */ }
    try { a.expand?.(); } catch { /* до 6.1 методу немає */ }
    try { a.disableVerticalSwipes?.(); } catch { /* з 7.7 */ }
  },

  /** Тактильний відгук. Усередині Telegram — рідний, поза ним — вібрація. */
  haptic(kind: 'light' | 'heavy' | 'fail'): void {
    const h = api()?.HapticFeedback;
    try {
      if (h?.impactOccurred && kind !== 'fail') { h.impactOccurred(kind); return; }
      if (h?.notificationOccurred && kind === 'fail') { h.notificationOccurred('error'); return; }
    } catch { /* падати через вібрацію не можна */ }
    const nav = navigator as Navigator & { vibrate?: (p: number) => boolean };
    if (typeof nav.vibrate === 'function') nav.vibrate(kind === 'fail' ? 35 : 12);
  },
};
