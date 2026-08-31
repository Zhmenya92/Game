/**
 * Аналітика (plan.md, 10.1).
 *
 * План перелічує тринадцять подій зі словами «без цього гейти неможливо
 * порахувати». Тут вони й живуть — у власному бекенді, а не в третій
 * стороні: бекенд усе одно є, а стороння аналітика додає вартість і ризик
 * блокування.
 *
 * Два правила, без яких дані не варті нічого:
 *   • подія без користувача не приймається — інакше будь-хто накрутить
 *     чисельник гейта 3 звичайним curl;
 *   • ім'я події має бути зі списку — інакше набір даних заростає сміттям
 *     і за півроку ніхто не скаже, що означає `run_end2`.
 */

/** Рівно ті тринадцять, що в плані 10.1. */
export const EVENT_NAMES = [
  'app_open', 'run_start', 'run_end', 'share_click', 'share_sent',
  'challenge_opened', 'challenge_replied', 'ghost_beaten',
  'ad_offer', 'ad_watched', 'iap_open', 'iap_purchased', 'day_streak',
] as const;

export type EventName = typeof EVENT_NAMES[number];

export type Props = Record<string, string | number | boolean>;
export type Event = { name: EventName; userId: number; props: Props; at: number };

const MAX_EVENTS = 20000;
const MAX_PROPS = 8;
const MAX_STRING = 64;

export function isEventName(n: unknown): n is EventName {
  return typeof n === 'string' && (EVENT_NAMES as readonly string[]).includes(n);
}

/** Пропси чистяться, а не відхиляються: втратити подію гірше, ніж поле. */
export function sanitizeProps(raw: unknown): Props {
  const out: Props = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROPS) break;
    if (!/^[a-z_][a-z0-9_]{0,23}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_STRING);
    else continue;
    n++;
  }
  return out;
}

export class Analytics {
  private events: Event[] = [];
  /** Останній день і довжина серії — для `day_streak`. */
  private days = new Map<number, { last: number; streak: number }>();

  /**
   * ДЕФЕКТ 53, знайдений репетицією софтлончу.
   *
   * Метрики рахувалися перебором `events`, а цей список обрізається:
   * після 20 000 подій половина найстаріших викидається. На синтетичному
   * наборі за два тижні (29 400 подій) це зʼїло рівно ті події, що
   * трапляються НА ПОЧАТКУ життя гравця, — покупки й перші перегляди
   * реклами. Payer conversion показав 1.7 % замість 2.0 %, і жодного
   * попередження при цьому не було.
   *
   * Для softлончу це гірше за помилку: дані виглядають правдоподібно й
   * тихо дрейфують тим сильніше, чим довше йде збір.
   *
   * Тому лічильники живуть окремо й НЕ обрізаються ніколи. Список подій
   * лишається тільки як недавня історія, і метрики його більше не читають.
   */
  private counts = new Map<string, number>();
  private userSets = new Map<string, Set<number>>();
  private sums = new Map<string, number>();
  private breaks = new Map<string, Map<string, number>>();

  add(name: EventName, userId: number, props: Props = {}): Event {
    return this.record(name, userId, props, Date.now());
  }

  /** Те саме, але з явним часом — для програвання журналу. */
  record(name: EventName, userId: number, props: Props, at: number): Event {
    const e: Event = { name, userId, props, at };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, MAX_EVENTS / 2);

    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    const set = this.userSets.get(name) ?? new Set<number>();
    set.add(userId);
    this.userSets.set(name, set);
    for (const [k, v] of Object.entries(props)) {
      const key = `${name}|${k}`;
      if (typeof v === 'number') {
        this.sums.set(key, (this.sums.get(key) ?? 0) + v);
        continue;   // числа сумуються, у розподіл не йдуть — див. нижче
      }
      // ДЕФЕКТ 55. Виправлення дефекту 53 замінило кільцевий буфер на
      // лічильники — і разом з тим прибрало межу. Розподіл будувався по
      // КОЖНОМУ полю, включно з рахунком і тривалістю: 20 000 подій дали
      // 24 000 записів у мапі, тобто пам'ять росла лінійно з кількістю
      // подій. За два тижні софтлончу це сотні тисяч записів заради
      // одного питання, яке ми справді ставимо, — причини смерті.
      //
      // Тому в розподіл ідуть лише рядки, і не більш як 50 різних значень
      // на поле. Далі лічильник просто перестає рости: краще втратити
      // рідкісний хвіст, ніж пам'ять.
      const b = this.breaks.get(key) ?? new Map<string, number>();
      const label = String(v);
      if (b.has(label) || b.size < 50) b.set(label, (b.get(label) ?? 0) + 1);
      this.breaks.set(key, b);
    }
    return e;
  }

  all(): readonly Event[] { return this.events; }

  count(name: EventName): number {
    return this.counts.get(name) ?? 0;
  }

  /** Скільки РІЗНИХ людей зробили подію. Для ретеншену й воронки. */
  users(name: EventName): number {
    return this.userSets.get(name)?.size ?? 0;
  }

  sum(name: EventName, prop: string): number {
    return this.sums.get(`${name}|${prop}`) ?? 0;
  }

  /** Розподіл значень поля — для причин смерті. */
  breakdown(name: EventName, prop: string): Record<string, number> {
    const b = this.breaks.get(`${name}|${prop}`);
    return b ? Object.fromEntries(b) : {};
  }

  /** Прямо виставити серію — при програванні журналу. */
  restoreDay(userId: number, day: number): void {
    this.touchDay(userId, day);
  }

  /**
   * Відмітити появу користувача в цей день і повернути довжину серії.
   * День — номер доби UTC, той самий, що дає `dailySeed`.
   */
  touchDay(userId: number, day: number): number {
    const rec = this.days.get(userId);
    if (!rec) { this.days.set(userId, { last: day, streak: 1 }); return 1; }
    if (rec.last === day) return rec.streak;
    rec.streak = day === rec.last + 1 ? rec.streak + 1 : 1;
    rec.last = day;
    return rec.streak;
  }

  streak(userId: number): number {
    return this.days.get(userId)?.streak ?? 0;
  }

  /** Скільки людей грали щонайменше N днів поспіль. */
  streakHistogram(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.days.values()) {
      const k = String(Math.min(r.streak, 7));
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
}
