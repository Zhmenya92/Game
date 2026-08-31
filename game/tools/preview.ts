import { writeFileSync } from 'node:fs';
import { Simulation } from '../src/sim/Simulation.ts';
import { runAdaptivePlayer } from '../test/capablePlayer.ts';
import type { Segment } from '../src/sim/types.ts';
import { selectTarget } from '../src/sim/Targeting.ts';
import { BALANCE } from '../src/config/balance.ts';
import { COL, mix } from '../src/config/palette.ts';
import { QuadRecorder, type Quad } from '../src/render/Painter.ts';
import * as S from '../src/render/scene.ts';
import { Bitmap } from './raster.ts';
import { encodePng, decodePng } from './png.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Знімок кадру гри в PNG, без браузера й GPU.
 *
 * Навіщо. Рендер — єдина частина проєкту, яку не перевіряв жоден тест: у
 * Node немає канваса, тож помилка шарів, дірка в замощенні чи спрайт із
 * чужим кутом виявлялися б лише очима на телефоні, вже після збірки.
 *
 * Тут виконується РІВНО ТА САМА розкладка, що і в грі (`render/scene.ts`),
 * але замість спрайтів Phaser вона пишеться в список чотирикутників, який
 * потім малюється власним растеризатором тими самими кадрами атласа.
 * Це не друга реалізація рендера: геометрія одна, різний лише споживач.
 *
 * Чого знімок НЕ доводить: як це пакує GPU і як виглядає рух. Він ловить
 * композицію, шари, замощення й кути — тобто те, що ламається найчастіше.
 *
 * Запуск: node tools/preview.ts [сід] [кадр] [вихідний файл]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = Number(process.argv[2] ?? 24680);
const untilFrame = Number(process.argv[3] ?? 900);
const outPath = process.argv[4] ?? join(HERE, '..', 'preview.png');

// ── Прогін до потрібного кадру ─────────────────────────────────────────────
//
// Гравець — той самий адаптивний бот, яким ганяються тести прохідності.
// Наївний ритм «тримай N кадрів, чекай M» гине за пару секунд, і знімок
// показував би труп біля землі замість гри.
//
// Спочатку прогін БЕЗ павутини — щоб отримати чужі лінії, потім прогін ІЗ
// ними: рівно та ситуація, що в грі, і саме на ній перевіряються шари.

const first = runAdaptivePlayer(seed, 4000);
const foreignWeb: Segment[] = [];
{
  const a = new Simulation(seed, []);
  for (let f = 0; f < first.frames && a.state.alive; f++) a.step(first.trace.isDownAt(f));
  for (const s of a.ownWeb) foreignWeb.push({ ...s, ownerId: 7 });
}

const second = runAdaptivePlayer(seed, 4000, foreignWeb);
const sim = new Simulation(seed, foreignWeb);
const st = sim.state;
const trail: { x: number; y: number }[] = [];
const stopAt = Math.min(untilFrame, second.frames);
for (let f = 0; f < stopAt && st.alive; f++) {
  sim.step(second.trace.isDownAt(f));
  trail.push({ x: st.px, y: st.py });
  if (trail.length > 26) trail.shift();
}
if (!st.alive) console.log(`  гравець загинув на кадрі ${st.frame} — знімок буде з мертвим тілом`);

// ── Камера, як у грі ───────────────────────────────────────────────────────

const ZOOM = 0.78;
const VIEW_W = BALANCE.viewWidth / ZOOM;
const VIEW_H = BALANCE.bandHeight / ZOOM;
const camX = st.px - (BALANCE.viewWidth / ZOOM) * BALANCE.cameraPlayerX;
const camY = st.py - (BALANCE.bandHeight / ZOOM) * 0.5;
const view: S.View = { camX, camY, w: VIEW_W, h: VIEW_H };

// Зум <1 показує більше, ніж вікно, і симетрично навколо центру камери.
// Вікно знімка — саме те, що бачить гравець.
const offX = camX + BALANCE.viewWidth / 2 - VIEW_W / 2;
const offY = camY + BALANCE.bandHeight / 2 - VIEW_H / 2;

// ── Запис розкладки трьома шарами, у тому самому порядку, що й у грі ───────

const bg = new QuadRecorder();
S.drawBackground(bg, view, st.killX, st.frame);

const web = new QuadRecorder();
S.drawForeignWeb(web, foreignWeb);

const world = new QuadRecorder();
const live = st.attached ? null
  : selectTarget(st.px, st.py, sim.track.candidates(st.px), foreignWeb.concat(sim.ownWeb));
S.drawAnchors(world, sim.track.anchors, st.px, live, st.frame);
S.drawOwnWeb(world, sim.ownWeb);
S.drawTrail(world, trail);
S.drawRope(world, st, live);
S.drawShadow(world, st.px, st.py);
S.drawBody(world, st.px, st.py, st.vx, st.vy, st.alive ? COL.player : COL.chase, 1);

// ── Растеризація ───────────────────────────────────────────────────────────

const SCALE = 0.5;                       // знімок удвічі менший — щоб читався
const W = Math.round(VIEW_W * SCALE), H = Math.round(VIEW_H * SCALE);
const out = new Bitmap(W, H);

// Небо: той самий градієнт, що малює `gSky`.
out.fillAll((_x, y) => [...mix(COL.skyTop, COL.skyBottom, y / H), 1]);

const atlasPng = decodePng(new Uint8Array(readFileSync(join(HERE, '..', 'public', 'atlas.png'))));
const atlasJson = JSON.parse(readFileSync(join(HERE, '..', 'public', 'atlas.json'), 'utf8')) as {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
};

/** Білінійна вибірка кадру атласа в нормованих координатах кадру. */
function sample(frame: string, u: number, v: number): [number, number, number, number] {
  const f = atlasJson.frames[frame]?.frame;
  if (!f) throw new Error(`кадру «${frame}» немає в атласі — розкладка просить те, чого нема`);
  const fx = f.x + Math.min(0.999999, Math.max(0, u)) * (f.w - 1);
  const fy = f.y + Math.min(0.999999, Math.max(0, v)) * (f.h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const px = (x: number, y: number, c: number) =>
    atlasPng.rgba[(Math.min(atlasPng.height - 1, y) * atlasPng.width + Math.min(atlasPng.width - 1, x)) * 4 + c];
  const lerp = (c: number) =>
    (px(x0, y0, c) * (1 - tx) + px(x0 + 1, y0, c) * tx) * (1 - ty) +
    (px(x0, y0 + 1, c) * (1 - tx) + px(x0 + 1, y0 + 1, c) * tx) * ty;
  return [lerp(0), lerp(1), lerp(2), lerp(3) / 255];
}

function drawQuad(q: Quad): void {
  const cos = Math.cos(q.rot), sin = Math.sin(q.rot);
  // Кути чотирикутника у світі — щоб не обходити весь екран заради спрайта.
  const cx = [-q.ox * q.w, (1 - q.ox) * q.w];
  const cy = [-q.oy * q.h, (1 - q.oy) * q.h];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const lx of cx) for (const ly of cy) {
    const wx = q.x + lx * cos - ly * sin, wy = q.y + lx * sin + ly * cos;
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
  }
  const x0 = Math.max(0, Math.floor((minX - offX) * SCALE));
  const x1 = Math.min(W - 1, Math.ceil((maxX - offX) * SCALE));
  const y0 = Math.max(0, Math.floor((minY - offY) * SCALE));
  const y1 = Math.min(H - 1, Math.ceil((maxY - offY) * SCALE));

  const tr = ((q.tint >> 16) & 0xff) / 255, tg = ((q.tint >> 8) & 0xff) / 255, tb = (q.tint & 0xff) / 255;

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const wx = offX + (px + 0.5) / SCALE, wy = offY + (py + 0.5) / SCALE;
      const dx = wx - q.x, dy = wy - q.y;
      const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
      const u = lx / q.w + q.ox, v = ly / q.h + q.oy;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const [r, g, b, a] = sample(q.frame, u, v);
      if (a <= 0) continue;
      out.blend(px, py, r * tr, g * tg, b * tb, a * q.alpha);
    }
  }
}

let drawn = 0;
for (const layer of [bg, web, world]) for (const q of layer.quads) { drawQuad(q); drawn++; }

writeFileSync(outPath, encodePng({ width: W, height: H, rgba: out.rgba }));
console.log(`знімок ${W}×${H} → ${outPath}`);
console.log(`  сід ${seed}, кадр ${st.frame}, рахунок ${st.score}, ${st.attached ? 'на тросі' : 'у польоті'}`);
console.log(`  чотирикутників: фон ${bg.quads.length}, павутина ${web.quads.length}, світ ${world.quads.length} — разом ${drawn}`);
