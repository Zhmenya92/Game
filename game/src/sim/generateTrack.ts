import { BALANCE } from '../config/balance.ts';
import { Prng } from './Prng.ts';
import { len } from './MathDet.ts';
import { Track } from './Track.ts';
import { Simulation } from './Simulation.ts';
import type { Anchor } from './types.ts';

/**
 * ГЕНЕРАЦІЯ ТРАСИ ПОЛЬОТОМ (дефект 26).
 *
 * Раніше анкери ставилися наосліп: крок по X, висота відносно попереднього.
 * Три свипи поспіль показали ту саму стелю — перепад висоти більший за 20
 * одиниць валив прохідність, і це не лікувалося жодним параметром. Причина
 * геометрична: після зриву гравець висить на ropeLen НИЖЧЕ анкера, і наступний
 * мусить одночасно бути вище гравця й у кільці досяжності. Вікно вузьке.
 *
 * Тепер анкери ставляться там, куди гравець ДОЛІТАЄ. Генератор ганяє
 * СПРАВЖНЮ симуляцію (не копію фізики — дефект 27, перша спроба з окремим
 * інтегратором розійшлася з грою і дала 0.6 % прохідності) з еталонною
 * політикою, і щоразу, коли валідної цілі немає, ставить нову в досяжній точці.
 *
 * Траса прохідна ЗА ПОБУДОВОЮ, рельєф — наслідок польоту, а не обмеження.
 * Детермінізм збережено: усе залежить тільки від сіду.
 */

/** Кут зриву еталонного гравця. */
const REF_LAUNCH_SIN = Math.sin((30 * Math.PI) / 180);

/** Траса, до якої генератор дописує анкери під час польоту. */
class GrowingTrack extends Track {
  constructor() {
    super([{ x: BALANCE.firstAnchor.x, y: BALANCE.firstAnchor.y }]);
  }
  push(a: Anchor): void {
    this.anchors.push(a);
  }
}

export function generateTrack(seed: number, anchorCount: number): Anchor[] {
  const prng = new Prng((seed ^ 0x5bf03635) >>> 0);
  const track = new GrowingTrack();
  const sim = new Simulation(seed, [], track);
  const s = sim.state;

  const top = BALANCE.anchorZoneTop;
  const bottom = BALANCE.anchorZoneBottom;
  let down = true;
  let framesAttached = 0;
  let cooldownUntil = -1;

  const maxFrames = anchorCount * 300 + 3000;
  for (let f = 0; f < maxFrames && s.alive && track.anchors.length < anchorCount; f++) {
    if (!s.attached) {
      framesAttached = 0;
      down = f > cooldownUntil;
      // Чи є валідна ціль? Якщо ні — ставимо нову там, куди дістаємо.
      if (!hasValidTarget(track.anchors, s.px, s.py)) {
        track.push(spawnAhead(prng, s.px, s.py, top, bottom));
      }
    } else {
      framesAttached++;
      const sp = len(s.vx, s.vy);
      const rising = sp > 0 && s.vx > 0 && (-s.vy) / sp >= REF_LAUNCH_SIN;
      // Захист від нескінченного кружляння на одному тросі.
      if (rising || framesAttached > 200) { down = false; cooldownUntil = f + 12; }
      else down = true;
    }
    sim.step(down);
  }

  // Анкери мусять бути відсортовані за X: candidates() покладається на це.
  // Під час замаху гравець рухається назад, тому порядок породження ≠ порядок X.
  return track.anchors.slice().sort((a, b) => a.x - b.x);
}

function hasValidTarget(anchors: readonly Anchor[], px: number, py: number): boolean {
  for (const a of anchors) {
    const dx = a.x - px;
    const dy = a.y - py;
    if (dx < 0) continue;
    if (dy > -BALANCE.hookMinRise) continue;
    const d = len(dx, dy);
    if (d >= BALANCE.ropeMin && d <= BALANCE.ropeMax) return true;
  }
  return false;
}

/**
 * Нова точка кріплення попереду й вище гравця, гарантовано валідна.
 *
 * Висота підйому залежить від того, де гравець у смузі: високо — ставимо
 * низько над ним, щоб він спускався; низько — високо, щоб піднявся. Так траса
 * гуляє по всій висоті замість того, щоб залипнути під стелею.
 */
function spawnAhead(prng: Prng, px: number, py: number, top: number, bottom: number): Anchor {
  const span = bottom - top;
  let t = span > 0 ? (py - top) / span : 0.5;   // 0 = гравець високо, 1 = низько
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  // Довжина троса — майже максимальна: довша дуга читабельніша.
  const d = BALANCE.ropeMax - 10 - prng.int(0, 40);

  // ДЕФЕКТ 28. Спочатку підйом брався майже рівним відстані, тобто анкер
  // опинявся ПРЯМО НАД гравцем. Жорсткий трос зберігає енергію, тож такий
  // маятник лише мляво гойдається біля нижньої точки, ніколи не набирає кута
  // зриву — у трейсі гравець висів 350 кадрів, поки його не з'їла межа.
  // Анкер має бути ПОПЕРЕДУ: підйом обмежений часткою від відстані.
  const riseLo = BALANCE.hookMinRise + 20;
  const riseHi = d * BALANCE.riseHiFactor;
  const base = riseLo + (riseHi - riseLo) * t;
  let rise = base + prng.int(-25, 25);
  if (rise < riseLo) rise = riseLo;
  if (rise > riseHi) rise = riseHi;

  const horiz = Math.sqrt(Math.max(1, d * d - rise * rise));
  let y = py - rise;
  if (y < top) y = top;
  return { x: px + horiz, y };
}