/**
 * Мінімальний растеризатор для генерації атласа.
 *
 * Форми задаються знаковою відстанню (SDF), а не полігонами: відстань до межі
 * прямо дає покриття пікселя, тобто згладжування виходить безкоштовно й без
 * суперсемплінгу. Для кіл, кілець, капсул і скруглених прямокутників —
 * а це весь наш арт — SDF пишеться в один рядок.
 *
 * Усе детерміноване: жодного Math.random, тільки арифметика від координат.
 */

export type Shade = (x: number, y: number) => [number, number, number, number];

export class Bitmap {
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;

  // Поля оголошені явно: Node виконує TypeScript зрізанням типів і параметри
  // конструктора з модифікатором доступу не підтримує.
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.rgba = new Uint8Array(width * height * 4);
  }

  /** Змішування source-over із заздалегідь непомноженою альфою. */
  blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const dst = this.rgba[i + 3] / 255;
    const out = a + dst * (1 - a);
    if (out <= 0) return;
    this.rgba[i] = (r * a + this.rgba[i] * dst * (1 - a)) / out;
    this.rgba[i + 1] = (g * a + this.rgba[i + 1] * dst * (1 - a)) / out;
    this.rgba[i + 2] = (b * a + this.rgba[i + 2] * dst * (1 - a)) / out;
    this.rgba[i + 3] = out * 255;
  }

  /**
   * Залити форму. `sdf` повертає відстань у пікселях: від'ємна — всередині.
   * Покриття береться як 0.5 − d, обрізане в [0,1], — це стандартне
   * наближення площі пікселя, що перетинається межею.
   */
  fill(sdf: (x: number, y: number) => number, shade: Shade): void {
    for (let py = 0; py < this.height; py++) {
      for (let px = 0; px < this.width; px++) {
        const x = px + 0.5, y = py + 0.5;
        const d = sdf(x, y);
        if (d > 0.5) continue;
        const cov = d < -0.5 ? 1 : 0.5 - d;
        const [r, g, b, a] = shade(x, y);
        this.blend(px, py, r, g, b, a * cov);
      }
    }
  }

  /** Заливка без форми — тільки за шейдером. Для градієнтів і фонів. */
  fillAll(shade: Shade): void {
    for (let py = 0; py < this.height; py++) {
      for (let px = 0; px < this.width; px++) {
        const [r, g, b, a] = shade(px + 0.5, py + 0.5);
        this.blend(px, py, r, g, b, a);
      }
    }
  }

  blit(src: Bitmap, dx: number, dy: number): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        const a = src.rgba[i + 3] / 255;
        if (a > 0) this.blend(dx + x, dy + y, src.rgba[i], src.rgba[i + 1], src.rgba[i + 2], a);
      }
    }
  }
}

// ── SDF-примітиви ──────────────────────────────────────────────────────────

export const disc = (cx: number, cy: number, r: number) =>
  (x: number, y: number) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r;

export const ring = (cx: number, cy: number, r: number, thick: number) =>
  (x: number, y: number) => Math.abs(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r) - thick / 2;

export const roundBox = (cx: number, cy: number, hw: number, hh: number, rad: number) =>
  (x: number, y: number) => {
    const qx = Math.abs(x - cx) - hw + rad;
    const qy = Math.abs(y - cy) - hh + rad;
    return Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0) - rad;
  };

/** Капсула між двома точками — нею малюються всі «лапи» й штрихи. */
export const capsule = (ax: number, ay: number, bx: number, by: number, r: number) =>
  (x: number, y: number) => {
    const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
    const len2 = bax * bax + bay * bay;
    const h = len2 === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / len2));
    return Math.sqrt((pax - bax * h) ** 2 + (pay - bay * h) ** 2) - r;
  };

/** Перетин двох форм: max. Різниця: max(a, −b). */
export const intersect = (a: (x: number, y: number) => number, b: (x: number, y: number) => number) =>
  (x: number, y: number) => Math.max(a(x, y), b(x, y));

export const subtract = (a: (x: number, y: number) => number, b: (x: number, y: number) => number) =>
  (x: number, y: number) => Math.max(a(x, y), -b(x, y));

export const solid = (rgb: [number, number, number], alpha = 1): Shade =>
  () => [rgb[0], rgb[1], rgb[2], alpha];
