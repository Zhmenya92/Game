import { Simulation } from '../src/sim/Simulation.ts';
import { selectTarget } from '../src/sim/Targeting.ts';
import { BALANCE } from '../src/config/balance.ts';
import { COL } from '../src/config/palette.ts';
import { QuadRecorder, type Quad } from '../src/render/Painter.ts';
import { FRAMES } from '../src/render/frames.ts';
import * as S from '../src/render/scene.ts';
import { runAdaptivePlayer } from './capablePlayer.ts';
import type { Segment } from '../src/sim/types.ts';

/**
 * Рендер У РУСІ.
 *
 * НАВІЩО. Критика показала: рендер має 23 статичні перевірки артефактів
 * (розмір атласа, повнота кадрів) і **жодної перевірки в русі**. Знімок
 * кадру (`tools/preview.ts`) показує композицію, але це один кадр, обраний
 * руками. Помилки замощення й камери живуть саме в русі: смуга порожнечі
 * на краю екрана зʼявляється на певних значеннях прокрутки, а не завжди.
 *
 * Тут прокручується справжній ран, і на кожному N-му кадрі розкладка
 * записується в список чотирикутників — тим самим кодом, що й у грі, — а
 * потім перевіряється як дані.
 *
 * ЧОГО ЦЕ НЕ ДОВОДИТЬ: як це виглядає. Композицію дивиться людина.
 */

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('render');

const ZOOM = 0.78;
const VIEW_W = BALANCE.viewWidth / ZOOM;
const VIEW_H = BALANCE.bandHeight / ZOOM;
const NAMES = new Set<string>(FRAMES);

type Shot = {
  seed: number; frame: number;
  view: S.View;
  bg: Quad[]; web: Quad[]; world: Quad[];
  attached: boolean; hasTarget: boolean;
};

/** Зняти розкладку кадру рівно так, як її будує сцена. */
function shoot(seed: number, everyN: number, maxFrames: number): Shot[] {
  const r = runAdaptivePlayer(seed, maxFrames);
  const sim = new Simulation(seed, []);
  const foreign: Segment[] = [];
  const trail: { x: number; y: number }[] = [];
  const out: Shot[] = [];

  for (let f = 0; f < r.frames && sim.state.alive; f++) {
    sim.step(r.trace.isDownAt(f));
    const st = sim.state;
    trail.push({ x: st.px, y: st.py });
    if (trail.length > 26) trail.shift();
    if (f % everyN !== 0) continue;

    const camX = st.px - (BALANCE.viewWidth / ZOOM) * BALANCE.cameraPlayerX;
    const camY = st.py - (BALANCE.bandHeight / ZOOM) * 0.5;
    const view: S.View = { camX, camY, w: VIEW_W, h: VIEW_H };

    const bg = new QuadRecorder();
    S.drawBackground(bg, view, st.killX, st.frame);
    const web = new QuadRecorder();
    S.drawForeignWeb(web, foreign);
    const world = new QuadRecorder();
    const live = st.attached ? null
      : selectTarget(st.px, st.py, sim.track.candidates(st.px), sim.ownWeb);
    S.drawAnchors(world, sim.track.anchors, st.px, live, st.frame);
    S.drawOwnWeb(world, sim.ownWeb);
    S.drawTrail(world, trail);
    S.drawRope(world, st, live);
    S.drawShadow(world, st.px, st.py);
    S.drawBody(world, st.px, st.py, st.vx, st.vy, COL.player, 1);

    out.push({
      seed, frame: f, view,
      bg: bg.quads, web: web.quads, world: world.quads,
      attached: st.attached, hasTarget: !!live,
    });
  }
  return out;
}

const shots: Shot[] = [];
for (let s = 1; s <= 12; s++) shots.push(...shoot(s, 37, 3600));
ok(`знято кадрів: ${shots.length}`, shots.length > 200, String(shots.length));

// ── Жодного зіпсованого чотирикутника ─────────────────────────────────────

{
  let bad = '';
  for (const sh of shots) {
    for (const q of [...sh.bg, ...sh.web, ...sh.world]) {
      if (!NAMES.has(q.frame)) { bad = `невідомий кадр «${q.frame}»`; break; }
      if (![q.x, q.y, q.w, q.h, q.rot, q.alpha].every(Number.isFinite)) {
        bad = `NaN у ${q.frame}, сід ${sh.seed}, кадр ${sh.frame}`; break;
      }
      if (q.w <= 0 || q.h <= 0) {
        bad = `нульовий розмір ${q.frame}: ${q.w}×${q.h}`; break;
      }
      if (q.alpha < 0 || q.alpha > 1) { bad = `прозорість ${q.alpha}`; break; }
      if (q.tint < 0 || q.tint > 0xffffff) { bad = `тінт ${q.tint}`; break; }
    }
    if (bad) break;
  }
  ok('усі чотирикутники мають скінченні координати, розмір і прозорість', bad === '', bad);
}

// ── Фон завжди накриває видиму частину ────────────────────────────────────
//
// Найдорожча помилка замощення: смуга порожнечі на краю екрана, яка
// зʼявляється лише на певних значеннях прокрутки. Одним знімком її не
// впіймати — саме тому тест іде по руху.

function coversX(quads: readonly Quad[], frame: string, left: number, right: number): boolean {
  const spans = quads
    .filter(q => q.frame === frame)
    .map(q => [q.x - q.ox * q.w, q.x - q.ox * q.w + q.w] as const)
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return false;
  let reach = spans[0][0];
  if (reach > left) return false;
  for (const [a, b] of spans) {
    if (a > reach) return false;           // дірка
    if (b > reach) reach = b;
  }
  return reach >= right;
}

{
  let bad = '';
  for (const sh of shots) {
    // Видима смуга у світі — вікно навколо центру камери.
    const left = sh.view.camX + BALANCE.viewWidth / 2 - VIEW_W / 2;
    const right = left + VIEW_W;
    for (const layer of ['bgFar', 'bgNear', 'ground'] as const) {
      if (!coversX(sh.bg, layer, left, right)) {
        bad = `${layer} не накриває екран: сід ${sh.seed}, кадр ${sh.frame}`;
        break;
      }
    }
    if (bad) break;
  }
  ok('паралакс і земля накривають видиму смугу на кожному кадрі', bad === '', bad);
}

// ── Стіна завжди на місці ─────────────────────────────────────────────────

{
  let bad = '';
  for (const sh of shots) {
    const wall = sh.bg.filter(q => q.frame === 'wall');
    if (!wall.length) { bad = `немає стіни: сід ${sh.seed}, кадр ${sh.frame}`; break; }
    const top = sh.view.camY + BALANCE.bandHeight / 2 - VIEW_H / 2;
    const bottom = top + VIEW_H;
    const ys = wall.map(q => q.y - q.oy * q.h);
    if (Math.min(...ys) > top || Math.max(...ys) + wall[0].h < bottom) {
      bad = `стіна не накриває висоту екрана: сід ${sh.seed}, кадр ${sh.frame}`;
      break;
    }
  }
  ok('стіна замощена на всю видиму висоту', bad === '', bad);
}

// ── Герой малюється завжди й лишається в кадрі ────────────────────────────

{
  let missing = 0, offscreen = 0;
  for (const sh of shots) {
    const hero = sh.world.filter(q => q.frame === 'hero');
    if (hero.length !== 1) { missing++; continue; }
    const h = hero[0];
    const left = sh.view.camX + BALANCE.viewWidth / 2 - VIEW_W / 2;
    const top = sh.view.camY + BALANCE.bandHeight / 2 - VIEW_H / 2;
    if (h.x < left || h.x > left + VIEW_W || h.y < top || h.y > top + VIEW_H) offscreen++;
  }
  ok('герой малюється рівно один раз на кадр', missing === 0, `пропусків ${missing}`);
  ok('камера тримає героя в кадрі', offscreen === 0, `за екраном ${offscreen}`);
}

// ── Трос малюється тоді й лише тоді, коли він є ───────────────────────────

{
  let wrong = 0;
  for (const sh of shots) {
    // Трос і пунктир до цілі — обидва кадром `rope`; відрізняє їх стан.
    const ropes = sh.world.filter(q => q.frame === 'rope' && q.tint === COL.rope).length;
    if (sh.attached && ropes < 2) wrong++;          // тінь + сам трос
    if (!sh.attached && ropes > 0) wrong++;
  }
  ok('білий трос є саме тоді, коли гравець зачеплений', wrong === 0, `розбіжностей ${wrong}`);
}

// ── Кількість спрайтів не вибухає ─────────────────────────────────────────
//
// Пул перевикористовує обʼєкти, але якщо розкладка почне видавати тисячі
// чотирикутників на кадр, це вбʼє мідл-андроїд ще до того, як хтось
// помітить причину.

{
  let peak = 0, where = '';
  for (const sh of shots) {
    const n = sh.bg.length + sh.web.length + sh.world.length;
    if (n > peak) { peak = n; where = `сід ${sh.seed}, кадр ${sh.frame}`; }
  }
  console.log(`  —    пік чотирикутників на кадр: ${peak}`);
  ok('на кадр менше 600 чотирикутників', peak < 600, `${peak} (${where})`);
}

// ── Чужа павутина лишається пунктирною при будь-якій довжині ─────────────

{
  const cases: Segment[] = [30, 120, 400, 1200].map((len, i) => ({
    id: `x:${i}`, ax: 0, ay: 0, bx: len, by: 0, ownerId: 9, hooks: 0, bornDay: 0,
  }));
  let bad = '';
  for (const seg of cases) {
    const rec = new QuadRecorder();
    S.drawForeignWeb(rec, [seg]);
    const strokes = rec.quads.length / 2;        // ореол + серцевина на штрих
    const longest = Math.max(...rec.quads.map(q => q.w));
    if (strokes < 3) bad = `довжина ${seg.bx}: штрихів лише ${strokes}`;
    else if (longest > seg.bx * 0.8) bad = `довжина ${seg.bx}: штрих ${longest} — це вже суцільна лінія`;
    if (bad) break;
  }
  ok('пунктир лишається пунктиром і на короткій, і на довгій лінії', bad === '', bad);
}

console.log(fail === 0 ? '\nRENDER OK' : `\nRENDER FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
