import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { len } from '../src/sim/MathDet.ts';
import type { Segment } from '../src/sim/types.ts';

/**
 * «Здатний гравець» — тест ПРОХІДНОСТІ траси.
 *
 * Три послідовні помилки в постановці цього тесту, усі знайдені прогоном:
 *
 * ДЕФЕКТ 18. У брифі гравець зривався в нижній точці дуги. Такий зрив не дає
 * ЖОДНОГО набору висоти — гравець тільки опускається і впаде на будь-якій
 * трасі. Це міряло складність, а не прохідність.
 *
 * ДЕФЕКТ 20. Жадібний пошук моменту зриву з оцінкою «скільки проживу далі»
 * нагороджував найкоротші утримання: гравець не встигав опуститися й формально
 * «жив довше». 59 замахів за 7.7 с, 5 % прохідності.
 *
 * ДЕФЕКТ 22. Перебір ритмів «зірватися через D кадрів після нижньої точки» не
 * керує тим, що фізично визначає політ, — КУТОМ ЗАПУСКУ. Один і той самий D
 * дає різний кут залежно від довжини троса й швидкості.
 *
 * Робоча постановка: політика задає кут зриву. Гравець тримається, поки вектор
 * швидкості не підніметься на θ градусів над горизонтом уперед, і відпускає.
 * Це прямий аналог кута кидка в балістиці. Траса прохідна, якщо існує θ,
 * з яким гравець дійшов до горизонту.
 */

const LAUNCH_ANGLES_DEG = [0, 8, 16, 24, 32, 40, 48, 56, 64];

export function runWithAngle(
  seed: number,
  horizonFrames: number,
  angleDeg: number,
  foreignWeb: readonly Segment[] = [],
): { survived: boolean; frames: number; score: number; trace: InputTrace; swings: number } {
  const sim = new Simulation(seed, foreignWeb);
  const trace = new InputTrace();
  const sinTarget = Math.sin((angleDeg * Math.PI) / 180);
  let down = false;
  let swings = 0;

  for (let f = 0; f < horizonFrames && sim.state.alive; f++) {
    const s = sim.state;

    if (!s.attached) {
      if (!down) { down = true; trace.record(f, 'down'); swings++; }
    } else if (down) {
      const sp = len(s.vx, s.vy);
      // -vy > 0 означає рух угору (вісь Y спрямована вниз).
      if (sp > 0 && s.vx > 0 && (-s.vy) / sp >= sinTarget) {
        down = false;
        trace.record(f, 'up');
      }
    }

    sim.step(down);
  }

  const s = sim.state;
  return { survived: s.alive, frames: s.frame, score: s.score, trace, swings };
}

export function runCapablePlayer(
  seed: number,
  horizonFrames: number,
  foreignWeb: readonly Segment[] = [],
): { survived: boolean; frames: number; score: number; trace: InputTrace; swings: number; angle: number } {
  let best = { survived: false, frames: -1, score: 0, trace: new InputTrace(), swings: 0, angle: 0 };
  for (const a of LAUNCH_ANGLES_DEG) {
    const r = runWithAngle(seed, horizonFrames, a, foreignWeb);
    if (r.survived) return { ...r, angle: a };
    if (r.frames > best.frames) best = { ...r, angle: a };
  }
  return best;
}

/**
 * Адаптивний гравець — остаточна постановка тесту прохідності.
 *
 * ДЕФЕКТ 25: константний кут запуску протягом усього рану — теж надто жорстка
 * політика. На горизонті 60 с вона дає 93.1 % прохідних сідів, і провали
 * трапляються на 8–51 секунді, тобто там, де потрібен інший кут, ніж на решті
 * траси. Реальний гравець підбирає кут щоразу.
 *
 * Тут кут вибирається НА КОЖНОМУ ЗАМАХУ: для кожного кандидата робиться
 * прорахунок наперед на LOOKAHEAD кадрів тією самою політикою, і береться
 * той, що дає найбільший прогрес. Це depth-1 з коректною цільовою функцією
 * (прогрес, а не виживання без зачеплень — саме на цьому провалився дефект 20).
 */

const LOOKAHEAD = 360; // 3 с

function rollout(base: Simulation, angleDeg: number, frames: number): number {
  const sim = base.clone();
  const sinT = Math.sin((angleDeg * Math.PI) / 180);
  let down = sim.state.attached;
  for (let i = 0; i < frames && sim.state.alive; i++) {
    const s = sim.state;
    if (!s.attached) { if (!down) down = true; }
    else if (down) {
      const sp = len(s.vx, s.vy);
      if (sp > 0 && s.vx > 0 && (-s.vy) / sp >= sinT) down = false;
    }
    sim.step(down);
  }
  // Прогрес, а не просто виживання. Мертвий ран штрафується.
  return sim.state.alive ? sim.state.px : sim.state.px - 100000;
}

export function runAdaptivePlayer(
  seed: number,
  horizonFrames: number,
  foreignWeb: readonly Segment[] = [],
): { survived: boolean; frames: number; score: number; trace: InputTrace; swings: number } {
  const sim = new Simulation(seed, foreignWeb);
  const trace = new InputTrace();
  let down = false;
  let swings = 0;
  let sinT = 0;
  let needChoice = false;

  while (sim.state.frame < horizonFrames && sim.state.alive) {
    const s = sim.state;

    if (!s.attached) {
      if (!down) { down = true; trace.record(s.frame, 'down'); }
      needChoice = true;
    } else {
      if (needChoice) {
        needChoice = false;
        swings++;
        let bestAngle = 0, bestScore = -Infinity;
        for (const a of LAUNCH_ANGLES_DEG) {
          const v = rollout(sim, a, LOOKAHEAD);
          if (v > bestScore) { bestScore = v; bestAngle = a; }
        }
        sinT = Math.sin((bestAngle * Math.PI) / 180);
      }
      if (down) {
        const sp = len(s.vx, s.vy);
        if (sp > 0 && s.vx > 0 && (-s.vy) / sp >= sinT) {
          down = false;
          trace.record(s.frame, 'up');
        }
      }
    }

    sim.step(down);
  }

  const s = sim.state;
  return { survived: s.alive, frames: s.frame, score: s.score, trace, swings };
}
