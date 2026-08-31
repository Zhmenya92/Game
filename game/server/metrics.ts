import type { ChallengeStore } from './challenge.ts';
import type { StoredRun } from './verify.ts';

/**
 * Метрики гейта 3 (plan.md, 8.3).
 *
 * Головна вимога до цього файлу — щоб числа не можна було намалювати.
 * Тому:
 *   • share rate рахується від смертей, а не від «сесій»;
 *   • відповіддю вважається лише той, хто СПОЧАТКУ відкрив виклик;
 *   • K-фактор рахується за визначенням, а не «на око»;
 *   • ghost-hook rate бере значення, яке ПОРАХУВАВ СЕРВЕР під час
 *     переграваня, а не те, що прислав клієнт.
 */

export type GateMetrics = {
  deaths: number;
  shareClicks: number;
  challengesCreated: number;
  challengeOpens: number;
  challengeReplies: number;

  /** Шер на смерть. Мінімум гейта 3 — 2 %, добре — 5 %. */
  shareRate: number;
  /**
   * Відкриттів НА ВИКЛИК — не конверсія.
   *
   * ДЕФЕКТ 38. У plan.md 8.3 метрика записана як «відкрив / отримав» із
   * порогом 25 %. Порахувати її неможливо: Telegram не повідомляє, скільки
   * людей побачило повідомлення в чаті. Знаменника просто немає.
   * Тому тут вимірне: скільки різних людей відкрило один виклик. Це не
   * відсоток і може бути більшим за одиницю — на живому прогоні вийшло 2.0,
   * що в старому формулюванні виглядало як «200 %» і не означало нічого.
   */
  opensPerChallenge: number;
  /** Зіграв ту саму трасу / відкрив. Мінімум 50 %, добре 70 %. */
  replyRate: number;
  /** K = запрошень на відправника × конверсія відкриття в нового гравця. */
  kFactor: number;

  /** Ранів із хоча б одним зачепленням за ЧУЖУ лінію. Мінімум 30 %. */
  foreignHookRate: number;
  runs: number;

  /** Оцінка гейта 3 по кожному порогу. */
  verdict: Record<string, 'ok' | 'low' | 'n/a'>;
};

/**
 * Джерела чисел. Навмисно НЕ списки подій і не список ранів: обидва
 * обрізаються (дефекти 53 і 54), і метрика тихо дрейфує тим сильніше, чим
 * довше йде збір.
 */
export type Counters = {
  count(name: 'run_end' | 'share_click'): number;
};

export function computeMetrics(
  analytics: Counters,
  challenges: ChallengeStore,
  runCounters: { runs: number; withForeign: number },
): GateMetrics {
  const deaths = analytics.count('run_end');
  const shareClicks = analytics.count('share_click');

  const all = challenges.all();
  const challengesCreated = all.length;
  let challengeOpens = 0;
  let challengeReplies = 0;
  const senders = new Set<number>();
  for (const c of all) {
    challengeOpens += c.opens.size;
    challengeReplies += c.replies.size;
    senders.add(c.ownerId);
  }

  const origins = challenges.originsSnapshot();

  const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

  // K-фактор за визначенням: скільки запрошень на відправника, помножити на
  // частку відкриттів, що дали НОВОГО гравця. Обидві частини вимірні.
  const invitesPerSender = ratio(challengesCreated, senders.size);
  const conversion = ratio(origins.viaChallenge, challengeOpens);
  const kFactor = invitesPerSender * conversion;

  const foreignHookRate = ratio(runCounters.withForeign, runCounters.runs);

  const shareRate = ratio(shareClicks, deaths);
  const opensPerChallenge = ratio(challengeOpens, challengesCreated);
  const replyRate = ratio(challengeReplies, challengeOpens);

  const judge = (v: number, min: number, have: boolean): 'ok' | 'low' | 'n/a' =>
    !have ? 'n/a' : v >= min ? 'ok' : 'low';

  return {
    deaths, shareClicks, challengesCreated, challengeOpens, challengeReplies,
    shareRate, opensPerChallenge, replyRate, kFactor, foreignHookRate, runs: runCounters.runs,
    verdict: {
      shareRate: judge(shareRate, 0.02, deaths > 0),
      // Поріг 0.5 відкриття на виклик — власна оцінка, бо порогу плану
      // (25 % від отримувачів) відповідати нічому.
      opensPerChallenge: judge(opensPerChallenge, 0.5, challengesCreated > 0),
      replyRate: judge(replyRate, 0.5, challengeOpens > 0),
      kFactor: judge(kFactor, 0.25, challengesCreated > 0),
      foreignHookRate: judge(foreignHookRate, 0.3, runCounters.runs > 0),
    },
  };
}
