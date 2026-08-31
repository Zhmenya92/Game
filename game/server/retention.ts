/**
 * Метрики гейта 4 (plan.md, розділ 11).
 *
 * Гейт 4 — фінальний: він вирішує, чи йде проєкт у стор-фазу, чи
 * закривається. Вісім порогів, з яких до тижня 7 рахувалися лише два
 * (K-фактор і share rate). Решта шість не рахувалися ніяк, тобто софтлонч
 * зібрав би дані, які нема чим прочитати.
 *
 * ДВА ПРАВИЛА, ЯКІ ТУТ ДІЮТЬ:
 *
 * 1. **Когорта, яка ще не дозріла, у знаменник не входить.** D7 для людини,
 *    яка прийшла вчора, порахувати неможливо: сьомого дня ще не було. Якщо
 *    її порахувати як «не повернулася», D7 занижується тим сильніше, чим
 *    швидше росте аудиторія, — класична пастка, через яку живі проєкти
 *    вважають себе мертвими на другому тижні.
 *
 * 2. **Немає даних — так і сказано.** Порожній набір дає `n/a`, а не нуль.
 */

/** Доба UTC як ціле число. Той самий номер, що й у сіді дня. */
export function dayOf(at: number): number {
  return Math.floor(at / 86400000);
}

/** Розрив, після якого активність вважається новою сесією. */
const SESSION_GAP_MS = 30 * 60 * 1000;

type User = {
  firstDay: number;
  days: Set<number>;
  sessions: number;
  /** Сумарна тривалість сесій. Сесія з однієї події дає нуль — див. нижче. */
  totalMs: number;
  lastAt: number;
  sessionStart: number;
};

export type Gate4 = {
  users: number;
  /** Скільки людей уже можна питати про D1 / D7. */
  cohortD1: number;
  cohortD7: number;
  d1: number | null;
  d7: number | null;
  sessionsPerDay: number | null;
  sessionMinutes: number | null;
  rewardedOptIn: number | null;
  payerConversion: number | null;
  verdict: Record<string, 'ok' | 'low' | 'n/a'>;
};

/** Пороги — дослівно з таблиці гейта 4. */
export const GATE4 = {
  d1: 0.27,
  d7: 0.10,
  sessionsPerDay: 2.5,
  sessionMinutes: 4,
  rewardedOptIn: 0.15,
  payerConversion: 0.01,
} as const;

export class Retention {
  private users = new Map<number, User>();

  /** Відмітити активність. Викликається на кожній події аналітики. */
  touch(userId: number, at: number): void {
    const day = dayOf(at);
    let u = this.users.get(userId);
    if (!u) {
      u = { firstDay: day, days: new Set([day]), sessions: 1, totalMs: 0, lastAt: at, sessionStart: at };
      this.users.set(userId, u);
      return;
    }
    u.days.add(day);
    if (at - u.lastAt > SESSION_GAP_MS) {
      // Попередня сесія закінчилась на останній активності, а не зараз.
      u.totalMs += u.lastAt - u.sessionStart;
      u.sessions += 1;
      u.sessionStart = at;
    }
    if (at > u.lastAt) u.lastAt = at;
    if (day < u.firstDay) u.firstDay = day;
  }

  get size(): number { return this.users.size; }

  /**
   * Утримання дня N. У знаменник ідуть лише ті, у кого цей день уже
   * настав, — інакше метрика занижується зростанням аудиторії.
   */
  private retentionAt(offset: number, today: number): { rate: number | null; cohort: number } {
    let cohort = 0, kept = 0;
    for (const u of this.users.values()) {
      if (u.firstDay + offset > today) continue;   // день ще не настав
      cohort++;
      if (u.days.has(u.firstDay + offset)) kept++;
    }
    return { rate: cohort > 0 ? kept / cohort : null, cohort };
  }

  metrics(events: readonly { name: string; userId: number }[], now = Date.now()): Gate4 {
    const today = dayOf(now);
    const d1 = this.retentionAt(1, today);
    const d7 = this.retentionAt(7, today);

    let sessions = 0, totalMs = 0, activeDays = 0;
    for (const u of this.users.values()) {
      sessions += u.sessions;
      // Поточна, ще не закрита сесія теж рахується — інакше в активного
      // гравця довжина сесії завжди на одну сесію менша, ніж є.
      totalMs += u.totalMs + (u.lastAt - u.sessionStart);
      activeDays += u.days.size;
    }

    const uniq = (name: string): number => {
      const s = new Set<number>();
      for (const e of events) if (e.name === name) s.add(e.userId);
      return s.size;
    };

    const offered = uniq('ad_offer');
    const watched = uniq('ad_watched');
    const payers = uniq('iap_purchased');
    const n = this.users.size;

    const sessionsPerDay = activeDays > 0 ? sessions / activeDays : null;
    // Тривалість рахується як «остання активність мінус перша в сесії».
    // ⚠️ Сесія з ОДНІЄЇ події дає нуль: коли людина відкрила гру й одразу
    // вийшла, вимірювати нічого. Це занижує середнє, і краще занижувати,
    // ніж домальовувати час, якого ми не бачили.
    const sessionMinutes = sessions > 0 ? totalMs / sessions / 60000 : null;
    const rewardedOptIn = offered > 0 ? watched / offered : null;
    const payerConversion = n > 0 ? payers / n : null;

    const judge = (v: number | null, min: number): 'ok' | 'low' | 'n/a' =>
      v === null ? 'n/a' : v >= min ? 'ok' : 'low';

    return {
      users: n,
      cohortD1: d1.cohort,
      cohortD7: d7.cohort,
      d1: d1.rate,
      d7: d7.rate,
      sessionsPerDay,
      sessionMinutes,
      rewardedOptIn,
      payerConversion,
      verdict: {
        d1: judge(d1.rate, GATE4.d1),
        d7: judge(d7.rate, GATE4.d7),
        sessionsPerDay: judge(sessionsPerDay, GATE4.sessionsPerDay),
        sessionMinutes: judge(sessionMinutes, GATE4.sessionMinutes),
        rewardedOptIn: judge(rewardedOptIn, GATE4.rewardedOptIn),
        payerConversion: judge(payerConversion, GATE4.payerConversion),
      },
    };
  }

  /** Таблиця когорт для дашборда: скільки прийшло і скільки лишилось. */
  cohorts(now = Date.now()): { day: number; size: number; d1: number | null; d7: number | null }[] {
    const today = dayOf(now);
    const byDay = new Map<number, User[]>();
    for (const u of this.users.values()) {
      const list = byDay.get(u.firstDay) ?? [];
      list.push(u);
      byDay.set(u.firstDay, list);
    }
    return [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, list]) => ({
        day,
        size: list.length,
        d1: day + 1 <= today ? list.filter(u => u.days.has(day + 1)).length / list.length : null,
        d7: day + 7 <= today ? list.filter(u => u.days.has(day + 7)).length / list.length : null,
      }));
  }
}
