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

  private key(chatId: string, seed: number): string {
    return `${chatId}|${seed}`;
  }

  add(chatId: string, run: Omit<StoredRun, 'id'>): StoredRun {
    const id = `r${(++this.counter).toString(36).padStart(6, '0')}`;
    const full: StoredRun = { ...run, id };
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

  list(chatId: string, seed: number): StoredRun[] {
    return this.byKey.get(this.key(chatId, seed)) ?? [];
  }

  byIds(chatId: string, seed: number, ids: readonly string[]): StoredRun[] {
    const set = new Set(ids);
    return this.list(chatId, seed).filter(r => set.has(r.id));
  }

  /** Рани інших гравців — з них будується павутина чату. */
  others(chatId: string, seed: number, userId: number, limit: number): StoredRun[] {
    return this.list(chatId, seed).filter(r => r.ownerId !== userId).slice(0, limit);
  }

  get size(): number {
    let n = 0;
    for (const list of this.byKey.values()) n += list.length;
    return n;
  }
}
