import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { buildFromTraces } from '../src/sim/Web.ts';
import { selectVisible } from '../src/sim/Web.ts';
import { BALANCE } from '../src/config/balance.ts';
import type { Segment } from '../src/sim/types.ts';

/**
 * Серверна верифікація рахунку переграванням (plan.md, 8.1).
 *
 * Клієнту не вірять. Він надсилає сід, трек вводу й перелік чужих треків,
 * з яких будувалася павутина; сервер переграє все сам і звіряє рахунок.
 * Це можливо тільки тому, що симуляція детермінована — те саме рішення,
 * що дає реплей, привида й кліп.
 */

export type SubmittedRun = {
  seed: number;
  traceB64: string;
  score: number;
  frames: number;
  /** Ідентифікатори чужих ранів, з яких клієнт будував павутину. */
  webRunIds: string[];
};

export type StoredRun = {
  id: string;
  ownerId: number;
  seed: number;
  traceB64: string;
  score: number;
  frames: number;
  day: number;
};

export type VerifyResult =
  | { ok: true; score: number; frames: number }
  | { ok: false; reason: string };

/** Ліміти, які роблять підробку дорожчою за чесну гру. */
const MAX_TRACE_BYTES = 8 * 1024;      // ~2700 подій — вистачає на 10 хвилин
const MAX_FRAMES = 120 * 60 * 15;      // 15 хвилин
const MAX_WEB_RUNS = BALANCE.foreignLineLimit;

export function verifyRun(
  run: SubmittedRun,
  webRuns: readonly StoredRun[],
): VerifyResult {
  if (!Number.isInteger(run.seed) || run.seed < 0) return { ok: false, reason: 'поганий сід' };
  if (!Number.isInteger(run.frames) || run.frames < 0 || run.frames > MAX_FRAMES) {
    return { ok: false, reason: 'поганий frames' };
  }
  if (!Number.isInteger(run.score) || run.score < 0) return { ok: false, reason: 'поганий рахунок' };
  if (webRuns.length > MAX_WEB_RUNS) return { ok: false, reason: 'забагато чужих ранів' };

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(run.traceB64, 'base64');
  } catch {
    return { ok: false, reason: 'трек не декодується' };
  }
  if (bytes.length === 0) return { ok: false, reason: 'порожній трек' };
  if (bytes.length > MAX_TRACE_BYTES) return { ok: false, reason: 'трек завеликий' };
  if (bytes.length % 3 !== 0) return { ok: false, reason: 'пошкоджений трек' };

  const trace = InputTrace.deserialize(bytes);

  // Павутина будується з тих самих чужих треків, що й у клієнта — інакше
  // симуляція розійдеться й чесний ран буде відхилено.
  const web = buildWeb(run.seed, webRuns);

  const sim = new Simulation(run.seed, web);
  const limit = Math.min(run.frames + 2, MAX_FRAMES);
  for (let f = 0; f < limit && sim.state.alive; f++) {
    sim.step(trace.isDownAt(f));
  }

  const s = sim.state;
  if (s.alive && run.frames < MAX_FRAMES) {
    return { ok: false, reason: 'ран не завершився на заявленому кадрі' };
  }
  if (s.score !== run.score) {
    return { ok: false, reason: `рахунок не збігається: заявлено ${run.score}, пораховано ${s.score}` };
  }
  if (s.frame !== run.frames) {
    return { ok: false, reason: `кадр смерті не збігається: заявлено ${run.frames}, пораховано ${s.frame}` };
  }

  return { ok: true, score: s.score, frames: s.frame };
}

/** Павутина з чужих ранів. Порядок детермінований — сортування за id. */
export function buildWeb(seed: number, runs: readonly StoredRun[]): Segment[] {
  const traces = runs
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(r => ({
      ownerId: r.ownerId,
      trace: InputTrace.deserialize(Buffer.from(r.traceB64, 'base64')),
      day: r.day,
    }));
  return selectVisible(buildFromTraces(seed, traces), BALANCE.foreignLineLimit);
}
