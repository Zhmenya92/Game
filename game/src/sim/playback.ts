import type { Simulation } from './Simulation.ts';
import type { InputTrace } from './InputTrace.ts';

/**
 * Єдине місце, де трек згодовується симуляції.
 *
 * Навіщо окремий файл на три рядки. Трек відтворюють ЧОТИРИ споживачі: рій
 * невдач у грі, серверна верифікація, тести детермінізму й знімок кадру.
 * Доки це був один виклик `sim.step(trace.isDownAt(f))`, чотири копії жили
 * мирно. Тиждень 6 додав до треку воскресіння — і копія, яка про нього не
 * знає, тихо розійдеться з рештою: сервер порахує менший рахунок і відхилить
 * ЧЕСНИЙ ран.
 *
 * Той самий урок, що й з `physics.ts` у тижні 1: власна копія кроку в
 * генераторі траси давала прохідність 0.6 % і виглядала як помилка балансу.
 */
export function stepTrace(sim: Simulation, trace: InputTrace, frame: number): void {
  // Порядок важливий: спершу воскресіння, потім крок. Інакше на кадрі
  // воскресіння симуляція встигає вийти з `step` через `if (!alive) return`,
  // і кадр втрачається — а це вже розбіжність із живою грою.
  if (trace.isReviveAt(frame)) sim.revive();
  sim.step(trace.isDownAt(frame));
}

/**
 * Прогнати трек до кадру `frames` включно. Повертає, скільки кроків зроблено.
 * Зупиняється на смерті, з якої гравець не воскрес.
 */
export function playTrace(sim: Simulation, trace: InputTrace, frames: number): number {
  let f = 0;
  for (; f < frames; f++) {
    if (!sim.state.alive && !trace.isReviveAt(f)) break;
    stepTrace(sim, trace, f);
  }
  return f;
}
