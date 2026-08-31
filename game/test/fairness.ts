import { BALANCE } from '../src/config/balance.ts';
import { runAdaptivePlayer, runCapablePlayer } from './capablePlayer.ts';
import { runMinimalPlayer } from './minimalPlayer.ts';

/**
 * Правило чесності (plan.md 6.4, бриф 5.2):
 * «жодної випадковості, що вбиває — траса має бути проходимою».
 *
 * ГЕЙТ — здатний гравець: перебір кутів запуску, траса прохідна, якщо існує
 * хоч один кут, з яким гравець дійшов до горизонту.
 * ДОВІДКОВО — мінімальний гравець (зрив у нижній точці): він міряє не
 * прохідність, а складність, і його результат наводиться лише як орієнтир.
 */

const seeds = BALANCE.fairnessSeeds;
const horizon = BALANCE.fairnessHorizonFrames;

let passed = 0, sumFrames = 0, totalSwings = 0;
const failed: { seed: number; frames: number }[] = [];
const angles = new Map<number, number>();

for (let seed = 1; seed <= seeds; seed++) {
  // Траса вважається прохідною, якщо її бере ХОЧ ОДНА з перевірених політик.
  let r = runCapablePlayer(seed, horizon);
  if (!r.survived) { const a = runAdaptivePlayer(seed, horizon); if (a.frames > r.frames) r = a as any; }
  sumFrames += r.frames; totalSwings += r.swings;
  if (r.survived) {
    passed++;

  } else if (failed.length < 10) {
    failed.push({ seed, frames: r.frames });
  }
}

let minSurvived = 0, minFrames = 0;
const sample = Math.min(seeds, 200);
for (let seed = 1; seed <= sample; seed++) {
  const r = runMinimalPlayer(seed, horizon);
  minFrames += r.frames;
  if (r.survived) minSurvived++;
}

console.log('fairness');
console.log(`  сідів:              ${seeds}`);
console.log(`  горизонт:           ${horizon} кроків = ${(horizon * BALANCE.dt).toFixed(0)} с`);
console.log(`  ГЕЙТ — прохідність: ${passed}/${seeds} (${((passed / seeds) * 100).toFixed(1)} %)`);
console.log(`  середній ран:       ${((sumFrames / seeds) * BALANCE.dt).toFixed(2)} с`);
console.log(`  замахів у середньому: ${(totalSwings / seeds).toFixed(1)}`);
console.log(`  довідково, мінімальний гравець на ${sample} сідах: ${minSurvived} дійшли, сер. ${((minFrames / sample) * BALANCE.dt).toFixed(2)} с`);
if (failed.length) {
  console.log('  непрохідні:');
  for (const f of failed) console.log(`    сід ${f.seed}: найкращий кут дав ${(f.frames * BALANCE.dt).toFixed(2)} с`);
}

const THRESHOLD = 95; // %
const rate = (passed / seeds) * 100;
const ok = rate >= THRESHOLD;
console.log(ok ? '\nFAIRNESS OK' : `\nFAIRNESS FAILED: ${seeds - passed} непрохідних`);
process.exitCode = ok ? 0 : 1;
