import { BALANCE } from '../config/balance.ts';
import type { Anchor } from './types.ts';

/**
 * Траса — список анкерів, породжений польотом еталонного гравця
 * (generateTrack.ts, дефект 26). Той самий сід дає ту саму трасу для всіх:
 * це умова щоденного сіду, привидів і павутини.
 *
 * Track нічого не генерує сам — інакше виникає цикл імпортів
 * Track → generateTrack → Simulation → Track. Генерацію робить trackFactory.
 */
export class Track {
  readonly anchors: Anchor[];

  constructor(anchors: Anchor[] = []) {
    this.anchors = anchors;
  }

  ensureUpTo(_x: number): void { /* траса вже згенерована повністю */ }

  candidates(px: number): Anchor[] {
    const out: Anchor[] = [];
    for (const a of this.anchors) {
      // БЕЗ break: під час генерації анкери ще не відсортовані за X, бо гравець
      // під час замаху рухається назад. Обрив циклу тут ховав валідні цілі.
      if (a.x < px - BALANCE.ropeMax) continue;
      if (a.x > px + BALANCE.ropeMax) continue;
      out.push(a);
    }
    return out;
  }
}
