/**
 * Гаманець продовжень (continue).
 *
 * Тиждень 6 продає продовження за Stars і дає за рекламу (plan.md, 10.2).
 * Головне тут не покупка, а те, що продовження **не можна намалювати**:
 * скільки разів гравець воскрес, рахує сервер, переграючи трек
 * (`verify.ts`), і саме стільки списується звідси. Клієнт у цьому ланцюжку
 * не бере участі взагалі.
 *
 * Ідемпотентність за `ref` — не прикраса. Telegram повторює доставку
 * `successful_payment`, якщо вебхук не відповів 200, а Adsgram повторює
 * серверний колбек. Без дедупу одна покупка нарахувалася б двічі, і це
 * знайшли б не ми, а гравці.
 */

export type GrantSource = 'purchase' | 'ad' | 'gift' | 'dev';

export type LedgerEntry = {
  userId: number;
  /** Додатний — нарахування, відʼємний — списання. */
  delta: number;
  source: GrantSource | 'run';
  /** Зовнішній ідентифікатор операції. Повтор із тим самим ref ігнорується. */
  ref: string;
  at: number;
};

export class Wallet {
  private balances = new Map<number, number>();
  private seenRefs = new Set<string>();
  private ledger: LedgerEntry[] = [];

  balance(userId: number): number {
    return this.balances.get(userId) ?? 0;
  }

  /**
   * Нарахувати продовження. Повертає false, якщо цей `ref` уже проводився —
   * тобто повтор доставки, а не нова покупка.
   */
  grant(userId: number, n: number, source: GrantSource, ref: string): boolean {
    if (!Number.isInteger(n) || n <= 0) return false;
    if (this.seenRefs.has(ref)) return false;
    this.seenRefs.add(ref);
    this.balances.set(userId, this.balance(userId) + n);
    this.ledger.push({ userId, delta: n, source, ref, at: Date.now() });
    return true;
  }

  // `consume` тут БІЛЬШЕ НЕМАЄ. Списання за фактом надісланого рану — це
  // і був дефект 51: гравець воскресав і не надсилав ран. Метод лишався
  // мертвим, але виглядав як робочий шлях, і найпростіший спосіб
  // повернути ту саму діру — покликати його. Тепер лишились тільки
  // `reserve` (оплата в мить використання) і `settle` (звірка).

  /**
   * Скільки продовжень користувач ОПЛАТИВ, але ще не показав у надісланому
   * рані.
   *
   * ДЕФЕКТ 51. Спершу продовження списувалися при відправці рану. Виглядало
   * логічно й було дірою: гравець воскресав, закривав застосунок, не
   * надсилаючи ран, — і баланс лишався недоторканим. Одна покупка давала
   * нескінченні продовження.
   *
   * Тепер списання відбувається в мить використання, а ран лише звіряється:
   * воскресінь у треку не може бути більше, ніж оплачено.
   */
  private pending = new Map<number, number>();
  private useCounter = 0;

  /** Оплатити одне воскресіння наперед. */
  reserve(userId: number): boolean {
    if (this.balance(userId) < 1) return false;
    this.balances.set(userId, this.balance(userId) - 1);
    this.pending.set(userId, this.pendingFor(userId) + 1);
    this.ledger.push({
      userId, delta: -1, source: 'run',
      ref: `use:${userId}:${++this.useCounter}`, at: Date.now(),
    });
    return true;
  }

  pendingFor(userId: number): number {
    return this.pending.get(userId) ?? 0;
  }

  /**
   * Звірити надісланий ран із оплаченим. Повертає false, якщо воскресінь у
   * треку більше, ніж людина оплатила, — тобто трек підроблений.
   */
  settle(userId: number, used: number): boolean {
    if (used > this.pendingFor(userId)) return false;
    this.pending.set(userId, this.pendingFor(userId) - used);
    return true;
  }

  /**
   * Застосувати запис журналу без повторної перевірки балансу. Журнал —
   * це те, що вже сталося; переграючи його, ми відтворюємо стан, а не
   * ухвалюємо рішення заново.
   */
  applyReserve(userId: number): void {
    this.balances.set(userId, this.balance(userId) - 1);
    this.pending.set(userId, this.pendingFor(userId) + 1);
  }

  applySettle(userId: number, used: number): void {
    this.pending.set(userId, Math.max(0, this.pendingFor(userId) - used));
  }

  history(userId: number): LedgerEntry[] {
    return this.ledger.filter(e => e.userId === userId);
  }

  /** Зведення для дашборда аналітики. */
  totals(): { granted: number; consumed: number; bySource: Record<string, number>; holders: number } {
    let granted = 0, consumed = 0;
    const bySource: Record<string, number> = {};
    for (const e of this.ledger) {
      if (e.delta > 0) { granted += e.delta; bySource[e.source] = (bySource[e.source] ?? 0) + e.delta; }
      else consumed += -e.delta;
    }
    return { granted, consumed, bySource, holders: this.balances.size };
  }
}

/**
 * Косметика. Скін — це тінт героя, тобто нуль додаткових кадрів в атласі:
 * рівно те, що дозволяє бюджет кадрів плану (розділ 9).
 */
export class Skins {
  private owned = new Map<number, Set<string>>();
  private active = new Map<number, string>();
  private seenRefs = new Set<string>();

  grant(userId: number, skinId: string, ref: string): boolean {
    if (this.seenRefs.has(ref)) return false;
    this.seenRefs.add(ref);
    const set = this.owned.get(userId) ?? new Set<string>();
    set.add(skinId);
    this.owned.set(userId, set);
    this.active.set(userId, skinId);
    return true;
  }

  has(userId: number, skinId: string): boolean {
    return this.owned.get(userId)?.has(skinId) ?? false;
  }

  list(userId: number): string[] {
    return [...(this.owned.get(userId) ?? [])].sort();
  }

  activeFor(userId: number): string | null {
    return this.active.get(userId) ?? null;
  }

  /** Вдягнути вже куплений скін. Невідомий або чужий — відмова. */
  setActive(userId: number, skinId: string): boolean {
    if (!this.has(userId, skinId)) return false;
    this.active.set(userId, skinId);
    return true;
  }
}
