/**
 * Детермінована математика для симуляції.
 *
 * ЧОМУ ЦЕЙ ФАЙЛ МАЙЖЕ ПОРОЖНІЙ — і це добре.
 *
 * plan.md, Рішення 2, забороняє Math.sin/cos/tan у симуляції: реалізації
 * трансцендентних функцій НЕ гарантовано ідентичні між JS-рушіями (V8 на
 * Android проти JavaScriptCore на iOS). Там передбачалися таблиці або
 * поліноміальні апроксимації.
 *
 * При реалізації виявилося, що тригонометрія не потрібна взагалі:
 *   • маятник робиться позиційним обмеженням — тільки +, −, ×, ÷ і sqrt;
 *   • перевірка конуса — це скалярний добуток проти константи cos(30°),
 *     яка захардкоджена в balance.ts, а не рахується в рантаймі.
 *
 * А +, −, ×, ÷ і sqrt за IEEE 754 задані точно й однаково скрізь.
 * Math.hypot — НІ (точність визначає реалізація), тому його тут немає.
 */

/** Довжина вектора. Тільки sqrt, без Math.hypot. */
export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Квадрат довжини — коли корінь не потрібен. */
export function len2(x: number, y: number): number {
  return x * x + y * y;
}

/** Обмеження значення. Math.min/max за стандартом детерміновані. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Найближча точка на відрізку [a, b] до точки p.
 * Повертає параметр t ∈ [0, 1] і саму точку.
 */
export function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { t: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const dd = dx * dx + dy * dy;
  if (dd === 0) return { t: 0, x: ax, y: ay };
  let t = ((px - ax) * dx + (py - ay) * dy) / dd;
  t = clamp(t, 0, 1);
  return { t, x: ax + dx * t, y: ay + dy * t };
}
