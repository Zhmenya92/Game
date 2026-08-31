/**
 * Виклики (plan.md, 8.2 — віральна петля).
 *
 * Виклик — це посилання на КОНКРЕТНИЙ сід із рахунком того, хто його кинув.
 * Друг відкриває, грає ту саму трасу й бачить павутину того, хто викликав.
 *
 * Тут же зберігається те, без чого гейт 3 неможливо порахувати: хто відкрив
 * виклик і хто на нього відповів. Без цього зв'язку K-фактор — фантазія.
 */

export type Challenge = {
  token: string;
  chatId: string;
  ownerId: number;
  seed: number;
  runId: string;
  score: number;
  createdAt: number;
  /** Унікальні користувачі, що відкрили. */
  opens: Set<number>;
  /** Унікальні користувачі, що зіграли той самий сід після відкриття. */
  replies: Set<number>;
};

/** Як користувач уперше потрапив у гру — потрібно для K-фактора. */
export type Origin = 'organic' | 'challenge';

export class ChallengeStore {
  private byToken = new Map<string, Challenge>();
  private origins = new Map<number, Origin>();
  private counter = 0;

  /** Короткий токен без неоднозначних символів — його читатимуть очима. */
  private mint(): string {
    const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
    let n = ++this.counter + Date.now() % 100000;
    let out = '';
    for (let i = 0; i < 7; i++) {
      out += alphabet[n % alphabet.length];
      n = Math.floor(n / alphabet.length) + 7919;
    }
    return out;
  }

  create(chatId: string, ownerId: number, seed: number, runId: string, score: number): Challenge {
    const token = this.mint();
    const c: Challenge = {
      token, chatId, ownerId, seed, runId, score,
      createdAt: Date.now(), opens: new Set(), replies: new Set(),
    };
    this.byToken.set(token, c);
    this.seen(ownerId, 'organic');
    return c;
  }

  /** Покласти виклик із журналу, не видаючи новий токен. */
  restore(c: Omit<Challenge, 'opens' | 'replies'> & { opens?: number[]; replies?: number[] }): void {
    this.byToken.set(c.token, {
      token: c.token, chatId: c.chatId, ownerId: c.ownerId, seed: c.seed,
      runId: c.runId, score: c.score, createdAt: c.createdAt,
      opens: new Set(c.opens ?? []), replies: new Set(c.replies ?? []),
    });
    this.seen(c.ownerId, 'organic');
  }

  get(token: string): Challenge | null {
    return this.byToken.get(token) ?? null;
  }

  /** Відкриття виклику. Той, хто кинув, не рахується — інакше метрика бреше. */
  open(token: string, userId: number): Challenge | null {
    const c = this.byToken.get(token);
    if (!c) return null;
    if (userId !== c.ownerId) {
      c.opens.add(userId);
      this.seen(userId, 'challenge');
    }
    return c;
  }

  /**
   * Відповідь: зіграв ТОЙ САМИЙ сід після того, як відкрив виклик.
   *
   * ДЕФЕКТ 39. Раніше сід не перевірявся взагалі — зарахувалась би будь-яка
   * пробіжка на будь-якій трасі, аби токен був у тілі запиту. Визначення
   * плану (8.3) — «зіграв ту саму трасу», тож без цієї перевірки reply rate
   * і K-фактор можна було намалювати, змінивши сід і надіславши ран.
   */
  reply(token: string, userId: number, seed: number): boolean {
    const c = this.byToken.get(token);
    if (!c) return false;
    if (userId === c.ownerId) return false;
    if (seed !== c.seed) return false;        // інша траса — це не відповідь
    if (!c.opens.has(userId)) return false;   // відповісти, не відкривши, не можна
    c.replies.add(userId);
    return true;
  }

  /** Перша поява користувача. Перезаписати походження вже не можна. */
  seen(userId: number, how: Origin): void {
    if (!this.origins.has(userId)) this.origins.set(userId, how);
  }

  all(): Challenge[] {
    return [...this.byToken.values()];
  }

  originsSnapshot(): { total: number; viaChallenge: number } {
    let viaChallenge = 0;
    for (const o of this.origins.values()) if (o === 'challenge') viaChallenge++;
    return { total: this.origins.size, viaChallenge };
  }
}
