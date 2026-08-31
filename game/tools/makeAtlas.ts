import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng, type Image } from './png.ts';
import { Bitmap, disc, ring, capsule, roundBox, subtract } from './raster.ts';
import { COL, rgb, mix } from '../src/config/palette.ts';
import { FRAMES, type FrameName } from '../src/render/frames.ts';

/**
 * Крок [6] пайплайну плану (розділ 9): пакування в atlas.png + atlas.json.
 *
 * ЩО ЦЕ НАСПРАВДІ, БЕЗ ПРИКРАС.
 * Кроки [1]–[5] плану — генерація зображень нейромережею, витяг альфи й
 * ручне вирівнювання pivot — тут не виконані: для них потрібні інструменти
 * генерації зображень і перевірка ліцензій, чого в цій сесії немає.
 * Тому кадри намальовані КОДОМ: ті самі форми, та сама палітра, чесний
 * растеризатор зі згладжуванням. Це не «AI-арт», це заготовка потрібної
 * форми, і так вона і підписана.
 *
 * Головне, що тут справжнє, — САМ ПАЙПЛАЙН і його гейти. Коли зʼявиться
 * справжній арт, його не треба вбудовувати в код: покласти
 * `art/src/<ім'я кадру>.png` — і цей файл візьме його замість намальованого.
 * Решта — розміри, атлас, JSON, перевірки — не змінюється.
 *
 * Запуск: node tools/makeAtlas.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public');
const SRC_DIR = join(HERE, '..', 'art', 'src');

/** Відступ між кадрами + дублювання крайніх пікселів у нього. */
const PAD = 2;

type Frame = { name: FrameName; w: number; h: number; paint: (b: Bitmap) => void };

// ── Кадри ──────────────────────────────────────────────────────────────────
// Бюджет плану — 8–12 кадрів на всю гру. Тут 10.
// Все, що оживає обертанням, розтягуванням або тінтом, кадрів не витрачає.

const frames: Frame[] = [
  {
    // Герой. Один кадр: обертання за вектором швидкості + squash&stretch
    // дають рух, як і написано в бюджеті кадрів плану.
    // +X спрайта = напрямок польоту, тому лапи тягнуться назад, у −X.
    name: 'hero', w: 80, h: 80,
    paint: b => {
      // Центр тіла збігається з центром кадру: спрайт обертається навколо
      // 0.5/0.5, і зсунуте тіло їхало б по колу навколо фізичної точки.
      const cx = 40, cy = 40, r = 24;
      for (let i = 0; i < 3; i++) {
        const ang = Math.PI * (0.78 + i * 0.22);
        const ex = cx + Math.cos(ang) * 34, ey = cy + Math.sin(ang) * 30 - 8 + i * 8;
        b.fill(capsule(cx, cy, ex, ey, 3.2 - i * 0.5), () => [...rgb(COL.playerCore), 0.85]);
      }
      b.fill(disc(cx, cy, r + 2.5), () => [...rgb(COL.skyTop), 0.55]);
      b.fill(disc(cx, cy, r), (x, y) => {
        const t = (y - (cy - r)) / (2 * r);
        return [...mix(0xfff3cf, COL.playerCore, t * 0.95), 1];
      });
      // Відблиск: серп у верхньому лівому куті, зроблений відніманням кіл.
      b.fill(subtract(disc(cx - 6, cy - 7, 13), disc(cx - 3, cy - 3, 12)),
        () => [255, 255, 255, 0.5]);
    },
  },
  {
    // Анкер. Білий — щоб тінт давав і спокійний, і активний стан
    // без другого кадру.
    name: 'anchor', w: 64, h: 64,
    paint: b => {
      const c = 32;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        b.fill(capsule(c, c, c + Math.cos(a) * 27, c + Math.sin(a) * 27, 2),
          () => [255, 255, 255, 0.45]);
      }
      b.fill(ring(c, c, 20, 5), () => [255, 255, 255, 1]);
      b.fill(disc(c, c, 8), () => [255, 255, 255, 1]);
    },
  },
  {
    // Мʼяке світіння. Пульс живого анкера, точка кріплення троса, спалах.
    name: 'glow', w: 64, h: 64,
    paint: b => {
      const c = 32;
      b.fillAll((x, y) => {
        const t = Math.sqrt((x - c) ** 2 + (y - c) ** 2) / c;
        return [255, 255, 255, t >= 1 ? 0 : (1 - t) ** 2.4];
      });
    },
  },
  {
    // Суцільний білий піксель. Ним малюються всі прямокутники — тіло землі,
    // спалах, смуги, — і завдяки цьому вони йдуть тим самим пакетом, що й
    // решта спрайтів, а не окремим Graphics.
    name: 'px', w: 8, h: 8,
    paint: b => { b.fillAll(() => [255, 255, 255, 1]); },
  },
  {
    // Трос і лінії павутини: спрайт розтягується по довжині, тому потрібен
    // лише профіль упоперек — мʼякі краї, щільна серцевина.
    name: 'rope', w: 8, h: 16,
    paint: b => {
      b.fillAll((_x, y) => {
        const t = Math.abs(y - 8) / 8;
        return [255, 255, 255, t >= 1 ? 0 : Math.min(1, (1 - t) * 2.1)];
      });
    },
  },
  {
    name: 'spark', w: 24, h: 24,
    paint: b => {
      b.fillAll((x, y) => {
        const t = Math.sqrt((x - 12) ** 2 + (y - 12) ** 2) / 11;
        return [255, 255, 255, t >= 1 ? 0 : Math.min(1, (1 - t) * 1.7)];
      });
    },
  },
  {
    // Верхня кромка землі. Плитка з періодом 256 — кладеться поруч сама з
    // собою. Тіло землі під кромкою — просто розтягнутий `px`, і кадру
    // на нього не треба.
    name: 'ground', w: 256, h: 64,
    paint: b => {
      b.fillAll((_x, y) => {
        const t = Math.min(1, y / 26);
        return [...mix(COL.groundRim, COL.ground, t ** 0.6), 1];
      });
      b.fill(roundBox(128, 2, 130, 3, 1), () => [...rgb(COL.groundRim), 1]);
      for (let i = 0; i < 8; i++) {
        const x = i * 32 + 16;
        b.fill(capsule(x, 8, x + 5, 44, 1.4), () => [...rgb(COL.groundRim), 0.28]);
      }
    },
  },
  {
    // Стіна, що наздоганяє. Плитка з періодом 128 по вертикалі.
    // Праворуч — межа; ліворуч альфа згасає в нуль, тому шва немає.
    name: 'wall', w: 64, h: 128,
    paint: b => {
      const [r, g, bl] = rgb(COL.chase);
      b.fillAll((x, _y) => [r, g, bl, (x / 64) ** 2.2 * 0.5]);
      for (let i = 0; i < 2; i++) {
        const y = i * 64 + 12;
        b.fill(capsule(12, y, 59, y + 46, 1.8), () => [r, g, bl, 0.3]);
      }
      b.fill(roundBox(62, 64, 2.5, 66, 1), () => [r, g, bl, 0.95]);
    },
  },
  {
    // Далекий шар паралакса. Період 256 — синуси з цілим числом хвиль,
    // тому ліва й права межі збігаються побайтово й шва при повторенні немає.
    // Силует мʼякий, тому в грі він розтягується вдвічі без видимої втрати.
    name: 'bgFar', w: 256, h: 128,
    paint: b => {
      const [r, g, bl] = rgb(COL.bgFar);
      const horizon = (x: number) =>
        52 + Math.sin((2 * Math.PI * x) / 256) * 13
           + Math.sin((4 * Math.PI * x) / 256 + 1.1) * 7.5
           + Math.sin((8 * Math.PI * x) / 256 + 2.3) * 3.5;
      b.fillAll((x, y) => [r, g, bl, y >= horizon(x) ? 1 : 0]);
      // Нитки павутини між вершинами — тема гри, нуль додаткових кадрів.
      for (let i = 0; i < 4; i++) {
        const x0 = i * 64 + 10;
        b.fill(capsule(x0, horizon(x0) - 2, x0 + 54, horizon(x0 + 54) - 2, 0.8),
          () => [...rgb(COL.foreignWeb), 0.12]);
      }
    },
  },
  {
    name: 'bgNear', w: 256, h: 128,
    paint: b => {
      const [r, g, bl] = rgb(COL.bgNear);
      const horizon = (x: number) =>
        75 + Math.sin((2 * Math.PI * x) / 256 + 0.7) * 19
           + Math.sin((6 * Math.PI * x) / 256 + 2.0) * 8;
      b.fillAll((x, y) => [r, g, bl, y >= horizon(x) ? 1 : 0]);
      for (let i = 0; i < 6; i++) {
        const x0 = i * 42 + 15;
        const top = horizon(x0);
        b.fill(capsule(x0, top, x0, top + 23 + (i % 3) * 11, 1), () => [r, g, bl, 1]);
      }
    },
  },
];

// Список кадрів і список малярів мусять збігатися рівно: тип ловить
// одруківку, а це — забутого маляра або зайвого.
{
  const painted = new Set(frames.map(f => f.name));
  const missing = FRAMES.filter(n => !painted.has(n));
  const extra = [...painted].filter(n => !(FRAMES as readonly string[]).includes(n));
  if (missing.length || extra.length) {
    throw new Error(
      `frames.ts і makeAtlas розійшлися. Немає маляра: ${missing.join(', ') || '—'}; ` +
      `зайвий маляр: ${extra.join(', ') || '—'}`);
  }
}

// ── Джерело кадру: справжній PNG, якщо він покладений, інакше намальований ──

function sourceFor(f: Frame): { bmp: Bitmap; from: 'art/src' | 'код' } {
  const file = join(SRC_DIR, `${f.name}.png`);
  if (existsSync(file)) {
    const img: Image = decodePng(new Uint8Array(readFileSync(file)));
    if (img.width !== f.w || img.height !== f.h) {
      throw new Error(
        `art/src/${f.name}.png має розмір ${img.width}×${img.height}, ` +
        `а кадр оголошений як ${f.w}×${f.h}. Пайплайн не масштабує — ` +
        `або приведіть файл до розміру, або змініть розмір кадру тут.`);
    }
    const bmp = new Bitmap(f.w, f.h);
    bmp.rgba.set(img.rgba);
    return { bmp, from: 'art/src' };
  }
  const bmp = new Bitmap(f.w, f.h);
  f.paint(bmp);
  return { bmp, from: 'код' };
}

// ── Пакування: полицями, за спаданням висоти ───────────────────────────────

function pack(items: { name: string; bmp: Bitmap }[], width: number):
    { placed: { name: string; bmp: Bitmap; x: number; y: number }[]; height: number } | null {
  const sorted = [...items].sort((a, b) =>
    b.bmp.height - a.bmp.height || b.bmp.width - a.bmp.width || (a.name < b.name ? -1 : 1));
  const placed: { name: string; bmp: Bitmap; x: number; y: number }[] = [];
  let x = PAD, y = PAD, shelf = 0;
  for (const it of sorted) {
    if (x + it.bmp.width + PAD > width) {
      x = PAD; y += shelf + PAD; shelf = 0;
    }
    if (it.bmp.width + PAD * 2 > width) return null;
    placed.push({ ...it, x, y });
    x += it.bmp.width + PAD;
    shelf = Math.max(shelf, it.bmp.height);
  }
  return { placed, height: y + shelf + PAD };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// ── Збірка ─────────────────────────────────────────────────────────────────

const sources = frames.map(f => ({ name: f.name, ...sourceFor(f) }));

let layout: ReturnType<typeof pack> = null;
let atlasW = 0;
for (const w of [256, 512, 1024, 2048]) {
  const r = pack(sources, w);
  if (r && nextPow2(r.height) <= 2048) { layout = r; atlasW = w; break; }
}
if (!layout) throw new Error('кадри не влізли в 2048×2048 — гейт плану порушено на етапі пакування');

const atlasH = nextPow2(layout.height);
const atlas = new Bitmap(atlasW, atlasH);

for (const p of layout.placed) {
  atlas.blit(p.bmp, p.x, p.y);
  // Витягування країв у відступ: інакше при масштабуванні спрайта
  // білінійна фільтрація підмішує сусідній кадр і по краю йде смуга.
  for (let e = 1; e <= PAD; e++) {
    for (let y = 0; y < p.bmp.height; y++) {
      copyPx(atlas, p.x, p.y + y, p.x - e, p.y + y);
      copyPx(atlas, p.x + p.bmp.width - 1, p.y + y, p.x + p.bmp.width - 1 + e, p.y + y);
    }
    for (let x = -PAD; x < p.bmp.width + PAD; x++) {
      copyPx(atlas, p.x + x, p.y, p.x + x, p.y - e);
      copyPx(atlas, p.x + x, p.y + p.bmp.height - 1, p.x + x, p.y + p.bmp.height - 1 + e);
    }
  }
}

function copyPx(b: Bitmap, sx: number, sy: number, dx: number, dy: number): void {
  if (sx < 0 || sy < 0 || sx >= b.width || sy >= b.height) return;
  if (dx < 0 || dy < 0 || dx >= b.width || dy >= b.height) return;
  const s = (sy * b.width + sx) * 4, d = (dy * b.width + dx) * 4;
  b.rgba[d] = b.rgba[s]; b.rgba[d + 1] = b.rgba[s + 1];
  b.rgba[d + 2] = b.rgba[s + 2]; b.rgba[d + 3] = b.rgba[s + 3];
}

const png = encodePng({ width: atlasW, height: atlasH, rgba: atlas.rgba });

// Формат Phaser «JSON Hash» — той самий, що видає TexturePacker,
// тож справжній атлас із редактора ляже сюди без переписування завантажувача.
const json = {
  frames: Object.fromEntries(layout.placed.map(p => [p.name, {
    frame: { x: p.x, y: p.y, w: p.bmp.width, h: p.bmp.height },
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: p.bmp.width, h: p.bmp.height },
    sourceSize: { w: p.bmp.width, h: p.bmp.height },
  }])),
  meta: {
    image: 'atlas.png',
    format: 'RGBA8888',
    size: { w: atlasW, h: atlasH },
    scale: '1',
    app: 'tools/makeAtlas.ts',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'atlas.png'), png);
writeFileSync(join(OUT_DIR, 'atlas.json'), JSON.stringify(json, null, 2) + '\n');

const fromArt = sources.filter(s => s.from === 'art/src').map(s => s.name);
const kb = (n: number) => (n / 1024).toFixed(1) + ' КБ';

console.log(`атлас ${atlasW}×${atlasH}, кадрів ${layout.placed.length}, ${kb(png.length)}`);
console.log(`  з art/src: ${fromArt.length ? fromArt.join(', ') : 'нічого — усі кадри намальовані кодом'}`);
if (existsSync(SRC_DIR)) {
  const known = new Set(frames.map(f => f.name + '.png'));
  const extra = readdirSync(SRC_DIR).filter(f => f.endsWith('.png') && !known.has(f));
  if (extra.length) console.log(`  УВАГА: у art/src лежить непотрібне й не потрапило в атлас: ${extra.join(', ')}`);
}
console.log(png.length <= 500 * 1024
  ? `  гейт ≤500 КБ: пройдено (запас ${kb(500 * 1024 - png.length)})`
  : `  ГЕЙТ ≤500 КБ ПОРУШЕНО на ${kb(png.length - 500 * 1024)}`);
