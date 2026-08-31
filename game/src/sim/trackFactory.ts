import { BALANCE } from '../config/balance.ts';
import { generateTrack } from './generateTrack.ts';
import { Track } from './Track.ts';

/**
 * Розриває цикл імпортів: Simulation бере трасу звідси, а не будує сама.
 * Кеш потрібен, бо генерація ганяє повну симуляцію на 400 анкерів — робити це
 * на кожен рестарт означало б помітну паузу.
 */
const cache = new Map<number, Track>();

export function makeTrack(seed: number): Track {
  const hit = cache.get(seed);
  if (hit) return hit;
  const t = new Track(generateTrack(seed, BALANCE.trackAnchors));
  cache.set(seed, t);
  return t;
}
