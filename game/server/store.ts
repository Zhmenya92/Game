import type { StoredRun } from './verify.ts';

/**
 * Сховище ранів у пам'яті.
 *
 * Для тижня 3 цього досить: гейт 3 — це 50–100 живих людей, а не масштаб.
 * Інтерфейс навмисно вузький, щоб заміна на Cloudflare KV чи D1 була
 * механічною і не зачіпала решту сервера.
 */
export class RunStore {
  private byKey = new Map<string, StoredRun[]>();
  private counter = 0;

  /**
   * ДЕФЕКТ 54, знайдений репетицією софтлончу.
   *
   * Сховище тримає лише 80 найкращих ранів чату на сіді — це правильно для
   * павутини, бо видимих ліній усе одно менше. Але ghost-hook rate гейта 3
   * рахувався перебором `allRuns()`, тобто **по зрізаному й зміщеному
   * набору**: лишалися рани з найвищим рахунком, а вони не типові.
   *
   * Лічильники нижче не обрізаються ніколи, тому метрика бачить усі рани,
   * а не найкращі.
   */
  private totalRuns = 0;
  private totalWithForeign = 0;

  /** Скільки ранів було взагалі і скільки з них із чужими зачепленнями. */
  get counters(): { runs: number; withForeign: number } {
    return { runs: this.totalRuns, withForeign: this.totalWithForeign };
  }

  private countRun(run: StoredRun): void {
    this.totalRuns++;
    if ((run.foreignHooks ?? 0) > 0) this.totalWithForeign++;
  }

  private key(chatId: string, seed: number): string {
    return `${chatId}|${seed}`;
  }

  add(chatId: string, run: Omit<StoredRun, 'id'>): StoredRun {
    const id = `r${(++this.counter).toString(36).padStart(6, '0')}`;
    const full: StoredRun = { ...run, id };
    this.countRun(full);
    const k = this.key(chatId, run.seed);
    const list = this.byKey.get(k) ?? [];
    list.push(full);
    // Тримаємо лише найкращі рани чату на цьому сіді — павутина все одно
    // обмежена лімітом видимих ліній.
    list.sort((a, b) => b.score - a.score);
    if (list.length > 80) list.length = 80;
    this.byKey.set(k, list);
    return full;
  }

  /**
   * Покласти ран із ЙОГО ідентифікатором — під час програвання журналу на
   * старті. Лічильник підтягується, щоб нові рани не почали видавати вже
   * зайняті id: саме так тихо ламаються сховища після перезапуску.
   */
  restore(chatId: string, run: StoredRun): void {
    this.countRun(run);
    const n = parseInt(run.id.slice(1), 36);
    if (Number.isFinite(n) && n > this.counter) this.counter = n;
    const k = this.key(chatId, run.seed);
    const list = this.byKey.get(k) ?? [];
    list.push(run);
    list.sort((a, b) => b.score - a.score);
    if (list.length > 80) list.length = 80;
    this.byKey.set(k, list);
  }

  list(chatId: string, seed: number): StoredRun[] {
    return this.byKey.get(this.key(chatId, seed)) ?? [];
  }

  byIds(chatId: string, seed: number, ids: readonly string[]): StoredRun[] {
    const set = new Set(ids);
    return this.list(chatId, seed).filter(r => set.has(r.id));
  }

  /**
   * Рани інших гравців — з них будується павутина чату.
   *
   * ЗНАЙДЕНО КРИТИКОЮ. Раніше тут було `.slice(0, limit)` по списку,
   * відсортованому за рахунком, — тобто новачок бачив павутину **самих
   * рекордсменів**. Це виглядало як технічна оптимізація, а насправді було
   * непоміченим дизайнерським рішенням: лінії недосяжного рівня замість
   * ліній, повз які справді летиш.
   *
   * Тепер вибірка розтягнута по всьому списку рівномірним кроком: і
   * найкращі рани, і середні. Без випадковості — вибірка мусить бути
   * однаковою при кожному запиті, інакше клієнт і сервер побудують різні
   * павутини й чесний ран буде відхилено.
   *
   * Чи краще так — питання до плейтесту, а не до коду. Але зміщення до
   * рекордів було не рішенням, а випадковістю, і тепер його немає.
   */
  others(chatId: string, seed: number, userId: number, limit: number): StoredRun[] {
    const all = this.list(chatId, seed).filter(r => r.ownerId !== userId);
    if (all.length <= limit) return all;
    const out: StoredRun[] = [];
    const step = all.length / limit;
    for (let i = 0; i < limit; i++) out.push(all[Math.floor(i * step)]);
    return out;
  }

  // `allRuns` прибрано. Метрики читали саме його й через це рахували
  // частку по 80 НАЙКРАЩИХ ранах чату — дефект 54. Лічильники `counters`
  // не обрізаються, і повернути зміщення випадково вже не вийде.

  get size(): number {
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }
}
