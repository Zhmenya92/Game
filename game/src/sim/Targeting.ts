import { BALANCE } from '../config/balance.ts';
import { closestPointOnSegment, len } from './MathDet.ts';
import type { Anchor, Segment, Target } from './types.ts';

/**
 * Єдина точка вибору цілі (бриф, розділи 4.3 і 4.4).
 * Замінила queryNear, яка шукала тільки серед відрізків і тому не могла
 * реалізувати правило пріоритету «анкер проти лінії» — дефект 12 ревізії.
 *
 * Валідність (4.3): відстань у [ropeMin, ropeMax] І в конусі навколо осі +X.
 * Обмеження РАДІАЛЬНЕ, а не по екрану: інакше відбір залежав би від висоти
 * пристрою і той самий сід дав би різний результат на різних телефонах.
 *
 * Пріоритет (4.4): виграє найменша effectiveDist, де для анкера вона × 0.8.
 */



/**
 * Чи придатний напрямок до цілі.
 *
 * ДЕФЕКТ 23, знайдений покадровим трейсом. Спочатку конус будувався навколо
 * вектора швидкості — не працювало, бо при падінні вектор дивиться вниз
 * (дефект 16). Виправлення на вісь +X теж виявилося хибним: анкер, що
 * опинився майже ПРЯМО НАД гравцем, має dx/d близько нуля і відкидався.
 * У трейсі сіду 1 гравець пролітав під анкером (490, 267) на відстані 249
 * одиниць — у межах троса — і не міг за нього зачепитися. Жодного
 * перечеплення за весь ран.
 *
 * У грі з гаком чіпляються ВГОРУ. Тому правило — не конус, а чверть площини:
 * ціль мусить бути вище гравця і не позаду.
 */
function isValidDirection(dx: number, dy: number, dist: number): boolean {
  if (dist === 0) return false;
  if (dx < 0) return false;                        // не позаду
  if (dy > -BALANCE.hookMinRise) return false;     // мусить бути вище
  return true;
}

export function selectTarget(
  px: number,
  py: number,
  anchors: readonly Anchor[],
  segments: readonly Segment[],
): Target | null {
  let best: Target | null = null;
  let bestEffective = Infinity;

  for (const a of anchors) {
    const dx = a.x - px;
    const dy = a.y - py;
    const d = len(dx, dy);
    if (d < BALANCE.ropeMin || d > BALANCE.ropeMax) continue;
    if (!isValidDirection(dx, dy, d)) continue;
    const eff = d * BALANCE.anchorPreference;
    if (eff < bestEffective) {
      bestEffective = eff;
      best = { kind: 'anchor', x: a.x, y: a.y, dist: d };
    }
  }

  for (const s of segments) {
    const c = closestPointOnSegment(px, py, s.ax, s.ay, s.bx, s.by);
    const dx = c.x - px;
    const dy = c.y - py;
    const d = len(dx, dy);
    if (d < BALANCE.ropeMin || d > BALANCE.ropeMax) continue;
    if (!isValidDirection(dx, dy, d)) continue;
    const eff = d;
    if (eff < bestEffective) {
      bestEffective = eff;
      best = { kind: 'segment', x: c.x, y: c.y, dist: d, segment: s };
    }
  }

  return best;
}
