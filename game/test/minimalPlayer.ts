import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import type { Segment } from '../src/sim/types.ts';

/**
 * «Мінімальний гравець» — бриф, розділ 5.2.
 *
 * Політика, якої в першій версії брифа не було й через яку тест був
 * неможливий (дефект 8 ревізії):
 *   • чіпляється, щойно зʼявляється валідна ціль;
 *   • зривається в НИЖНІЙ ТОЧЦІ ДУГИ — коли вектор швидкості вперше стає
 *     горизонтальним і спрямованим уперед (vy переходить через нуль вниз→вгору
 *     при vx > 0). Це найконсервативніша політика: найменша висота, найкоротша
 *     дуга. Пройшов такий — пройде будь-який кращий.
 */
export function runMinimalPlayer(
  seed: number,
  horizonFrames: number,
  foreignWeb: readonly Segment[] = [],
): { survived: boolean; frames: number; score: number; trace: InputTrace; sim: Simulation } {
  const sim = new Simulation(seed, foreignWeb);
  const trace = new InputTrace();
  let down = false;
  let prevVy = 0;

  for (let f = 0; f < horizonFrames; f++) {
    const s = sim.state;

    if (!s.attached && !down) {
      down = true;                       // тримаємо — спрацює буфер вводу
      trace.record(f, 'down');
    } else if (s.attached && down) {
      const passedBottom = prevVy > 0 && s.vy <= 0 && s.vx > 0;
      if (passedBottom) {
        down = false;
        trace.record(f, 'up');
      }
    }

    prevVy = s.vy;
    sim.step(down);
    if (!s.alive) {
      return { survived: false, frames: s.frame, score: s.score, trace, sim };
    }
  }

  return { survived: true, frames: sim.state.frame, score: sim.state.score, trace, sim };
}
