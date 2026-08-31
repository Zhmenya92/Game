/**
 * Adsgram rewarded — «1 continue за ран» (plan.md, 10.2).
 *
 * ⚠️ ГОЛОВНЕ, ЩО ТРЕБА ЗНАТИ ПРО ЦЕЙ ФАЙЛ. Він не нараховує нічого. Успішний
 * показ реклами тут — лише сигнал; продовження нараховує СЕРВЕР і тільки за
 * серверним колбеком Adsgram із секретом (`/api/ad/callback`). Інакше
 * «я подивився рекламу» — це один рядок у консолі браузера, і саме так це
 * і зламали б.
 *
 * ⚠️ Проти живого Adsgram не перевірялося: потрібен акаунт і block id.
 * Перевірено лише поведінку без SDK — вона мусить бути тихою відмовою, а не
 * зламаним екраном смерті.
 *
 * Реалістика з плану: eCPM $0.40–1.50 за консервативною оцінкою, верхні
 * оцінки $5–6 для казуального трафіку не підтверджені.
 */

const BLOCK_ID: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ADSGRAM_BLOCK ?? '';

const SDK_URL = 'https://sad.adsgram.ai/js/sad.min.js';

type Controller = { show: () => Promise<unknown> };
type Adsgram = { init: (o: { blockId: string }) => Controller };

let loading: Promise<Controller | null> | null = null;

function load(): Promise<Controller | null> {
  if (loading) return loading;
  loading = new Promise<Controller | null>(resolve => {
    if (!BLOCK_ID) { resolve(null); return; }
    const w = window as unknown as { Adsgram?: Adsgram };
    if (w.Adsgram) { resolve(w.Adsgram.init({ blockId: BLOCK_ID })); return; }

    const el = document.createElement('script');
    el.src = SDK_URL;
    el.async = true;
    el.onload = () => {
      try {
        resolve(w.Adsgram ? w.Adsgram.init({ blockId: BLOCK_ID }) : null);
      } catch { resolve(null); }
    };
    // Блокувальники реклами — норма, а не помилка. Тиха відмова.
    el.onerror = () => resolve(null);
    document.head.appendChild(el);
    setTimeout(() => resolve(w.Adsgram ? w.Adsgram.init({ blockId: BLOCK_ID }) : null), 8000);
  });
  return loading;
}

export const ads = {
  /** Чи взагалі має сенс пропонувати рекламу. */
  get configured(): boolean { return !!BLOCK_ID; },

  /**
   * Показати ролик. `true` означає лише «показ дійшов до кінця» —
   * нарахування ЦЕ НЕ ГАРАНТУЄ і гарантувати не може.
   */
  async show(): Promise<boolean> {
    const c = await load();
    if (!c) return false;
    try {
      await c.show();
      return true;
    } catch {
      // Користувач закрив ролик або реклами не знайшлося.
      return false;
    }
  },
};
