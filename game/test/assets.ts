import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../tools/png.ts';
import { FRAMES } from '../src/render/frames.ts';

/**
 * Технічні гейти арту (plan.md, розділ 9).
 *
 * Гейти плану дослівно:
 *   • один атлас ≤2048×2048 і ≤500 КБ;
 *   • увесь білд ≤3 МБ gzip;
 *   • час до першого кадру ≤2 с на 4G / середньому Android;
 *   • 1–2 виклики малювання на сцену.
 *
 * Перші два перевіряються тут по-справжньому. Третій і четвертий — ні, і це
 * сказано прямо: час завантаження на реальному пристрої й кількість викликів
 * малювання в GPU з Node не виміряти. Замість вигаданих чисел тест перевіряє
 * ПЕРЕДУМОВУ четвертого гейта: у світі не лишилось малювання геометрією, усе
 * йде одним атласом. Що з цього виходить у драйвері — питання до профайлера
 * на пристрої, і воно записане як відкрите.
 */

// fileURLToPath, а не URL.pathname: у шляху проєкту є пробіли й дужки, і
// pathname віддає їх у відсотковому кодуванні — fs такого файлу не знаходить.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};
const kb = (n: number) => (n / 1024).toFixed(1) + ' КБ';

console.log('assets');

// ── Атлас існує й влазить у гейти ──────────────────────────────────────────

const pngPath = join(PUBLIC, 'atlas.png');
const jsonPath = join(PUBLIC, 'atlas.json');

ok('атлас згенерований', existsSync(pngPath) && existsSync(jsonPath),
  'запустіть node tools/makeAtlas.ts');
if (!existsSync(pngPath)) { console.log('\nASSETS FAILED: немає атласа'); process.exitCode = 1; }

const pngBytes = new Uint8Array(readFileSync(pngPath));
const atlas = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { size: { w: number; h: number }; image: string };
};

ok(`гейт: атлас ≤500 КБ (зараз ${kb(pngBytes.length)})`, pngBytes.length <= 500 * 1024);

const img = decodePng(pngBytes);
ok(`гейт: атлас ≤2048×2048 (зараз ${img.width}×${img.height})`,
  img.width <= 2048 && img.height <= 2048);
ok('розмір у JSON збігається з самим PNG',
  atlas.meta.size.w === img.width && atlas.meta.size.h === img.height,
  `${atlas.meta.size.w}×${atlas.meta.size.h} проти ${img.width}×${img.height}`);
ok('сторони — степені двійки',
  (img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0);

const names = Object.keys(atlas.frames);
ok(`бюджет плану 8–12 кадрів (зараз ${names.length})`, names.length >= 1 && names.length <= 12);

// ── Кожен кадр існує фізично, а не лише в JSON ─────────────────────────────
// Ловить painter, який нічого не намалював: у JSON кадр є, у грі — порожнеча.

for (const [name, f] of Object.entries(atlas.frames)) {
  const r = f.frame;
  const inside = r.x >= 0 && r.y >= 0 && r.x + r.w <= img.width && r.y + r.h <= img.height;
  let painted = 0;
  if (inside) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (img.rgba[(y * img.width + x) * 4 + 3] > 0) painted++;
      }
    }
  }
  ok(`кадр «${name}» у межах атласа й не порожній`,
    inside && painted > r.w * r.h * 0.01,
    inside ? `непрозорих пікселів ${painted}` : 'виходить за межі атласа');
}

// ── Кадри не перекриваються ────────────────────────────────────────────────
// Перекриття дало б чужі пікселі на краю спрайта — помилку, яку в грі
// помічають випадково й пізно.

{
  const list = Object.entries(atlas.frames).map(([n, f]) => ({ n, ...f.frame }));
  let clash = '';
  for (let i = 0; i < list.length && !clash; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        clash = `${a.n} і ${b.n}`; break;
      }
    }
  }
  ok('кадри не перекриваються', clash === '', clash);
}

// ── Атлас збігається зі списком кадрів, який бачить компілятор ─────────────
//
// Перша версія цієї перевірки шукала імена в коді регуляркою і впала при
// першому ж рефакторингу: імена почали передаватися через проміжну функцію,
// і тест оголосив живі кадри мертвими. Тепер імена — тип (`render/frames.ts`),
// одруківку ловить компілятор, а тут лишається одна змістовна перевірка:
// в атласі рівно ті кадри, які оголошені, без зайвих і без пропущених.

{
  const declared = new Set<string>(FRAMES);
  const missing = [...declared].filter(n => !(n in atlas.frames));
  const extra = names.filter(n => !declared.has(n));
  ok('усі оголошені кадри є в атласі', missing.length === 0, missing.join(', '));
  ok('в атласі немає кадрів поза списком', extra.length === 0,
    extra.join(', ') + ' — це мертва вага в текстурі');
}

// ── Генерація детермінована ────────────────────────────────────────────────
// Без цього неможливо ні перевіряти атлас у гіті, ні довіряти кешу.

{
  const before = readFileSync(pngPath);
  execFileSync(process.execPath, [join(ROOT, 'tools', 'makeAtlas.ts')], { stdio: 'ignore' });
  const after = readFileSync(pngPath);
  ok('повторна генерація дає побайтово той самий файл', before.equals(after),
    `${before.length} проти ${after.length} байтів`);
}

// ── Передумова гейта «1–2 виклики малювання» ───────────────────────────────

{
  const scene = readFileSync(join(SRC, 'scenes', 'GameScene.ts'), 'utf8');
  const graphics = [...scene.matchAll(/this\.add\.graphics\(/g)].length;
  ok('у сцені лишився рівно один Graphics — статичне небо', graphics === 1,
    `знайдено ${graphics}`);
  ok('світ більше не малюється геометрією',
    !/lineBetween|strokeCircle|fillCircle|fillEllipse|lineStyle/.test(scene),
    'у сцені лишилися виклики Graphics для ігрового поля');
}

// ── Гейт усього білда ──────────────────────────────────────────────────────

{
  if (!existsSync(DIST)) {
    console.log('  n/a  гейт ≤3 МБ gzip — немає dist/, спершу npx vite build');
  } else {
    let total = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else total += gzipSync(readFileSync(p)).length;
      }
    };
    walk(DIST);
    ok(`гейт: увесь білд ≤3 МБ gzip (зараз ${kb(total)})`, total <= 3 * 1024 * 1024);
    console.log(`       довідково: атлас ${kb(gzipSync(pngBytes).length)} gzip із цих ${kb(total)}`);
  }
}

console.log('\n  не перевіряється тут і чому:');
console.log('    • час до першого кадру ≤2 с — потрібен реальний пристрій і мережа 4G;');
console.log('    • 1–2 виклики малювання — потрібен профайлер GPU на пристрої.');
console.log('      Перевірено лише передумову: усе ігрове поле йде одним атласом.');

console.log(fail === 0 ? '\nASSETS OK' : `\nASSETS FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
