import { BALANCE } from '../config/balance.ts';
import { Prng } from './Prng.ts';
import type { Anchor } from './types.ts';

/**
 * Seeded генерація траси (бриф, розділ 5).
 *
 * Коридор заввишки bandHeight, нескінченний по горизонталі.
 * Анкери — ланцюжок зліва направо: крок anchorGapMin..Max, висота 0..anchorZoneBottom.
 *
 * Детермінізм: генерація монотонна по x і викликається тільки через ensureUpTo,
 * тому послідовність PRNG не залежить від того, як часто її смикають.
 */
export class Track {
  private prng: Prng;
  readonly anchors: Anchor[] = [];

  constructor(seed: number) {
    this.prng = new Prng(seed);
    this.anchors.push({ x: BALANCE.firstAnchor.x, y: BALANCE.firstAnchor.y });
  }

  /**
   * Догенерувати анкери, поки останній не зайде за x.
   *
   * ДЕФЕКТ 19, знайдений тестом прохідності.
   * У брифі висота анкера була «рівномірно в [0, anchorZoneBottom]». Так
   * генерувати НЕ МОЖНА: після зриву гравець опиняється на висоті приблизно
   * anchorY + ropeLen, а наступний анкер має потрапити в кільце досяжності
   * [ropeMin, ropeMax]. При рівномірному розкиді по всій смузі в це кільце
   * потрапляє лише частина анкерів, і ймовірність довгого ланцюга прямує до
   * нуля — 0 % прохідних сідів на всіх 30 конфігураціях свипу.
   *
   * Тому висота породжується ВІДНОСНО попереднього анкера з обмеженим кроком.
   * Траса стає плавним ланцюгом, а не розсипом, і лишається seeded.
   */
  ensureUpTo(x: number): void {
    while (this.anchors[this.anchors.length - 1].x < x) {
      const prev = this.anchors[this.anchors.length - 1];
      const gap = this.prng.int(BALANCE.anchorGapMin, BALANCE.anchorGapMax);
      const dy = this.prng.int(-BALANCE.anchorDyMax, BALANCE.anchorDyMax);
      let y = prev.y + dy;
      if (y < BALANCE.anchorZoneTop) y = BALANCE.anchorZoneTop;
      if (y > BALANCE.anchorZoneBottom) y = BALANCE.anchorZoneBottom;
      this.anchors.push({ x: prev.x + gap, y });
    }
  }

  /** Анкери, які взагалі можуть бути валідними для гравця в точці px. */
  candidates(px: number): Anchor[] {
    this.ensureUpTo(px + BALANCE.ropeMax + BALANCE.anchorGapMax);
    const out: Anchor[] = [];
    for (const a of this.anchors) {
      if (a.x < px - BALANCE.ropeMax) continue;
      if (a.x > px + BALANCE.ropeMax) break;
      out.push(a);
    }
    return out;
  }
}
