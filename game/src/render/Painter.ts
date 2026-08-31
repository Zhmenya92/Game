/**
 * Куди малює розкладка кадру.
 *
 * Навіщо інтерфейс. Розкладка сцени (`scene.ts`) не має знати ні про Phaser,
 * ні про WebGL — тоді її можна не лише виконати в грі, а й ЗАПИСАТИ й
 * намалювати окремо (`tools/preview.ts`). Без цього рендер неможливо
 * перевірити взагалі: у Node немає ні канваса, ні GPU, і кожна помилка
 * шарів чи замощення виявлялася б лише очима на телефоні.
 *
 * У грі це реалізує `SpritePool`, у прев'ю — `QuadRecorder`.
 */
import type { FrameName } from './frames.ts';

export interface Painter {
  /** Кадр із явною точкою обертання. Базова операція. */
  quad(frame: FrameName, x: number, y: number, w: number, h: number,
       ox: number, oy: number, color?: number, alpha?: number, rotation?: number): void;
  /** Прямокутник кадром `px`. */
  rect(x: number, y: number, w: number, h: number, color: number, alpha?: number): void;
  /** Лінія як розтягнутий кадр `rope`. */
  line(x1: number, y1: number, x2: number, y2: number,
       width: number, color: number, alpha?: number): void;
  /** Кадр із центром у точці. */
  at(frame: FrameName, x: number, y: number, w: number, h: number,
     color?: number, alpha?: number, rotation?: number): void;
}

export type Quad = {
  frame: FrameName; x: number; y: number; w: number; h: number;
  ox: number; oy: number; tint: number; alpha: number; rot: number;
};

/** Записує розкладку замість малювання. Використовується прев'ю і тестами. */
export class QuadRecorder implements Painter {
  readonly quads: Quad[] = [];

  quad(frame: FrameName, x: number, y: number, w: number, h: number,
       ox: number, oy: number, color = 0xffffff, alpha = 1, rotation = 0): void {
    this.quads.push({ frame, x, y, w, h, ox, oy, tint: color, alpha, rot: rotation });
  }

  rect(x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
    this.quad('px', x, y, w, h, 0, 0, color, alpha);
  }

  line(x1: number, y1: number, x2: number, y2: number,
       width: number, color: number, alpha = 1): void {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) return;
    this.quad('rope', x1, y1, len, width, 0, 0.5, color, alpha, Math.atan2(dy, dx));
  }

  at(frame: FrameName, x: number, y: number, w: number, h: number,
     color = 0xffffff, alpha = 1, rotation = 0): void {
    this.quad(frame, x, y, w, h, 0.5, 0.5, color, alpha, rotation);
  }
}
