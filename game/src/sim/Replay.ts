import { Simulation } from './Simulation.ts';
import { InputTrace } from './InputTrace.ts';
import type { Segment } from './types.ts';
import { stepTrace } from './playback.ts';

/**
 * Реплей: відтворення рану з сіду й треку вводу.
 *
 * Нічого спеціального тут немає — і це головне. Детермінована симуляція означає,
 * що «реплей» це просто та сама симуляція, якій згодовують збережений трек.
 * Той самий механізм далі дає привида, кліп і серверну верифікацію
 * (plan.md, Рішення 2).
 */

export type Attempt = {
  trace: InputTrace;
  frames: number;
  score: number;
  /** Порядковий номер спроби на цьому сіді, з 1. */
  index: number;
};

/** Одна доріжка рою — симуляція, що програє збережений трек. */
export class ReplayTrack {
  readonly sim: Simulation;
  readonly attempt: Attempt;
  private frame = 0;

  constructor(seed: number, attempt: Attempt, foreignWeb: readonly Segment[] = []) {
    this.sim = new Simulation(seed, foreignWeb);
    this.attempt = attempt;
  }

  get alive(): boolean { return this.sim.state.alive; }
  get done(): boolean {
    if (this.frame >= this.attempt.frames) return true;
    // Мертвий, але з воскресінням на цьому кадрі, — ще не готовий.
    return !this.sim.state.alive && !this.attempt.trace.isReviveAt(this.frame);
  }

  step(): void {
    if (this.done) return;
    stepTrace(this.sim, this.attempt.trace, this.frame);
    this.frame++;
  }
}

/**
 * Рій невдач (differentiation-research.md, ідея 3; прецедент — Multi-Play
 * у Super Meat Boy). Усі спроби на цьому сіді програються ОДНОЧАСНО.
 * Артефакт показує зусилля, а не число: видно, де ламалися всі попередні рази.
 */
export function buildSwarm(
  seed: number,
  attempts: readonly Attempt[],
  foreignWeb: readonly Segment[] = [],
  limit = 24,
): ReplayTrack[] {
  // Беремо останні спроби: свіжі цікавіші за давні.
  const take = attempts.slice(-limit);
  return take.map(a => new ReplayTrack(seed, a, foreignWeb));
}
