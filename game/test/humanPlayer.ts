import { BALANCE } from '../src/config/balance.ts';
import { Simulation } from '../src/sim/Simulation.ts';
import { Prng } from '../src/sim/Prng.ts';
import { len } from '../src/sim/MathDet.ts';

/**
 * ЖИВИЙ ГРАВЕЦЬ — оцінка реальної складності.
 *
 * Тести прохідності відповідають на питання «чи можна пройти». Вони не
 * відповідають на питання «чи пройде людина», бо людина має розкид реакції,
 * не влучає в кут ідеально й іноді тисне не вчасно.
 *
 * Тут гравець: цілиться в кут зриву з шумом ±spreadDeg, після зриву робить
 * паузу 80–260 мс, і з імовірністю missChance «задумується» — пропускає
 * зачеплення на 100–300 мс.
 */
export function runHumanPlayer(
  seed: number,
  horizonFrames: number,
  skill: number,          // 0 = новачок, 1 = майстер
): { frames: number; score: number; swings: number } {
  const rng = new Prng((seed * 2654435761) >>> 0);
  const sim = new Simulation(seed, []);
  const s = sim.state;

  const spreadDeg = 22 - 18 * skill;         // новачок ±22°, майстер ±4°
  const missChance = 0.16 - 0.15 * skill;    // 16 % → 1 %
  const baseAngle = 30;

  let down = false, swings = 0, releasedAt = -1000, distractedUntil = -1;
  let targetSin = Math.sin((baseAngle * Math.PI) / 180);

  for (let f = 0; f < horizonFrames && s.alive; f++) {
    if (!s.attached) {
      const pause = 10 + rng.int(0, 21);      // 80–260 мс
      if (!down && f - releasedAt >= pause && f > distractedUntil) {
        if (rng.next() < missChance) {
          distractedUntil = f + 12 + rng.int(0, 24);   // «задумався»
        } else {
          down = true; swings++;
          const jitter = (rng.next() * 2 - 1) * spreadDeg;
          const a = Math.max(0, Math.min(70, baseAngle + jitter));
          targetSin = Math.sin((a * Math.PI) / 180);
        }
      }
    } else if (down) {
      const sp = len(s.vx, s.vy);
      if (sp > 0 && s.vx > 0 && (-s.vy) / sp >= targetSin) { down = false; releasedAt = f; }
    }
    sim.step(down);
  }
  return { frames: s.frame, score: s.score, swings };
}

if (import.meta.filename === process.argv[1]) {
  const H = BALANCE.fairnessHorizonFrames;
  console.log('скіл   | сер.час  медіана  10%   90%   макс   сер.рахунок');
  for (const skill of [0, 0.35, 0.7, 1]) {
    const times: number[] = []; let score = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = runHumanPlayer(seed, H, skill);
      times.push(r.frames / 120); score += r.score;
    }
    times.sort((a, b) => a - b);
    const q = (p: number) => times[Math.floor(p * (times.length - 1))];
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `${skill.toFixed(2).padStart(5)}  | ${avg.toFixed(1).padStart(6)}s  ${q(0.5).toFixed(1).padStart(6)}s ${q(0.1).toFixed(1).padStart(5)}s ${q(0.9).toFixed(1).padStart(5)}s ${q(1).toFixed(1).padStart(6)}s  ${(score / 300).toFixed(0).padStart(8)}`);
  }
}
