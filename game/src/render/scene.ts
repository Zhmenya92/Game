import { BALANCE } from '../config/balance.ts';
import { COL } from '../config/palette.ts';
import type { Painter } from './Painter.ts';
import type { FrameName } from './frames.ts';
import type { Segment, Anchor } from '../sim/types.ts';

/**
 * Розкладка кадру: що і де малюється. Без Phaser, без канваса, без стану.
 *
 * Тут живе вся геометрія рендера — замощення фону, паралакс, земля, стіна,
 * анкери, троси, слід, герой. Сцена гри лише передає сюди `Painter` і стан
 * симуляції, а `tools/preview.ts` передає той самий виклик у власний
 * растеризатор і отримує PNG. Тому помилку шарів або дірку в замощенні
 * видно ДО телефона.
 */

/** Видима частина світу. Ширина й висота вже враховують зум камери. */
export type View = { camX: number; camY: number; w: number; h: number };

export type Trail = readonly { x: number; y: number }[];
export type Particle = { x: number; y: number; c: number; life: number };

/** Ціль захоплення — те, що поверне `selectTarget`. */
export type Live = { kind: string; x: number; y: number } | null;

/**
 * Паралакс. Шар замощується періодичним кадром зі зсувом за модулем ширини
 * плитки, тому прокрутка нескінченна й без шва.
 *
 * Множник прокрутки Phaser не використовується навмисно: спрайти живуть у
 * звичайних світових координатах, а ефект дає арифметика — щоб шар їхав
 * повільніше за камеру в `factor` разів, його світова X зсувається на
 * camX·(1−factor). Так поведінка не залежить від того, як рушій трактує
 * scrollFactor усередині контейнера, і так її можна перевірити тут.
 *
 * По вертикалі шари прибиті до світу: інакше при різкому падінні героя
 * горизонт «пливе» окремо від землі й читається як помилка.
 */
function parallax(p: Painter, view: View, frame: FrameName, factor: number,
                  worldY: number, tileW: number, tileH: number): void {
  const shift = view.camX * factor;
  const base = Math.floor(shift / tileW) * tileW;
  const n = Math.ceil(view.w / tileW) + 2;
  for (let i = 0; i < n; i++) {
    p.quad(frame, view.camX - shift + base + i * tileW, worldY, tileW, tileH, 0, 1);
  }
}

/**
 * Фон, земля й стіна. Малюється в шар ПІД чужою павутиною: якби вони йшли
 * разом із рештою світу, непрозорий паралакс і смуга небезпеки лягли б
 * поверх чужих ліній і сховали б головну механіку концепту.
 */
export function drawBackground(p: Painter, view: View, killX: number, frame: number): void {
  const H = BALANCE.bandHeight;

  parallax(p, view, 'bgFar', 0.30, H - 30, 512, 256);
  parallax(p, view, 'bgNear', 0.62, H + 20, 512, 256);

  // Земля: кромка плитками, тіло — розтягнутий `px`.
  const tile = 512;
  const from = Math.floor((view.camX - tile) / tile) * tile;
  for (let x = from; x < view.camX + view.w + tile; x += tile) {
    p.rect(x, H + 120, tile + 2, 900, COL.ground, 1);
    p.quad('ground', x, H, tile, 128, 0, 0);
  }

  // Стіна, що наздоганяє: зона позаду плюс плитки самої межі.
  p.rect(killX - 3000, -2200, 3000, H + 4400, COL.chase, 0.10);
  // Плитка 128×256 — рівно подвоєний кадр 64×128. Неоднаковий масштаб по
  // осях розтягнув би діагональні штрихи й видав би, що це текстура.
  const wallW = 128, wallH = 256;
  const drift = (frame * 2) % wallH;
  const wy = Math.floor(view.camY / wallH) * wallH - wallH * 2;
  for (let y = wy; y < view.camY + view.h + wallH; y += wallH) {
    p.quad('wall', killX, y + drift, wallW, wallH, 1, 0);
  }
}

/** Чужа павутина. За рану не змінюється, тому в грі розкладається один раз. */
export function drawForeignWeb(p: Painter, web: readonly Segment[]): void {
  for (const s of web) {
    p.line(s.ax, s.ay, s.bx, s.by, BALANCE.lineVisualWidth + 5, COL.foreignWeb, 0.16);
    p.line(s.ax, s.ay, s.bx, s.by, BALANCE.lineVisualWidth, COL.foreignWeb, 0.55);
  }
}

export function drawAnchors(p: Painter, anchors: readonly Anchor[],
                            px: number, live: Live, frame: number): void {
  const from = px - 900, to = px + 1400;
  for (const a of anchors) {
    if (a.x < from) continue;
    if (a.x > to) break;
    const isLive = !!live && live.kind === 'anchor' && live.x === a.x && live.y === a.y;
    if (isLive) {
      const pulse = 92 + Math.sin(frame * 0.12) * 14;
      p.at('glow', a.x, a.y, pulse, pulse, COL.anchorLive, 0.45);
    }
    // Прозорість спокійного анкера — 0.9, а не 0.7. На знімку кадру видно
    // було, що при 0.7 анкери на тлі неба майже зникають, а це головна
    // ціль погляду: гравець цілиться саме в них.
    p.at('anchor', a.x, a.y, 48, 48, isLive ? COL.anchorLive : COL.anchor, isLive ? 1 : 0.9);
  }
}

export function drawOwnWeb(p: Painter, web: readonly Segment[]): void {
  for (const w of web) {
    p.line(w.ax, w.ay, w.bx, w.by, BALANCE.lineVisualWidth + 6, COL.ownWeb, 0.14);
    p.line(w.ax, w.ay, w.bx, w.by, BALANCE.lineVisualWidth, COL.ownWeb, 0.85);
  }
}

export function drawTrail(p: Painter, trail: Trail, color: number = COL.trail): void {
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    const k = i / trail.length;
    p.line(a.x, a.y, b.x, b.y, 2 + k * 10, color, k * 0.6);
  }
}

/** Трос, коли зачеплений, або пунктир до цілі, коли ні. */
export function drawRope(p: Painter, s: { attached: boolean; ax: number; ay: number; px: number; py: number },
                         live: Live): void {
  if (s.attached) {
    p.line(s.ax, s.ay, s.px, s.py, 11, COL.rope, 0.22);
    p.line(s.ax, s.ay, s.px, s.py, 4, COL.rope, 1);
    p.at('glow', s.ax, s.ay, 66, 66, COL.anchorLive, 0.7);
    return;
  }
  if (!live) return;
  // Пунктир до цілі: показує, ЩО саме зачепиться, якщо натиснути.
  const dx = live.x - s.px, dy = live.y - s.py, n = 9;
  for (let i = 0; i < n; i += 2) {
    p.line(s.px + (dx * i) / n, s.py + (dy * i) / n,
           s.px + (dx * (i + 1)) / n, s.py + (dy * (i + 1)) / n,
           3, COL.anchorLive, 0.5);
  }
}

/** Squash & stretch: тіло витягується вздовж швидкості. Найдешевший джус. */
export function drawBody(p: Painter, x: number, y: number, vx: number, vy: number,
                         color: number, alpha: number, r = 19): void {
  const sp = Math.sqrt(vx * vx + vy * vy);
  const k = Math.min(0.55, sp / 1600);
  const d = r * 2.7;
  p.at('hero', x, y, d * (1 + k), d * (1 - k * 0.7), color, alpha, Math.atan2(vy, vx));
}

export function drawShadow(p: Painter, x: number, y: number): void {
  p.at('glow', x, y + 8, 58, 42, 0x000000, 0.32);
}

export function drawParticles(p: Painter, parts: readonly Particle[]): void {
  for (const pt of parts) {
    const sz = 7 + pt.life * 18;
    p.at('spark', pt.x, pt.y, sz, sz, pt.c, Math.min(1, pt.life));
  }
}

/**
 * Білий спалах. Іде тим самим пулом і тією ж текстурою, що й світ, — інакше
 * коштував би окремого виклику малювання на кожен кадр смерті. Координати
 * світові, від камери: так не потрібен scrollFactor.
 */
export function drawFlash(p: Painter, view: View, flash: number): void {
  if (flash <= 0.01) return;
  p.rect(view.camX - 200, view.camY - 200, view.w + 400, view.h + 400, 0xffffff, flash);
}
