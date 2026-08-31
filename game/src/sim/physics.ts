import { BALANCE } from '../config/balance.ts';
import { len } from './MathDet.ts';

/**
 * Один крок інтегрування. Виділено в окрему функцію, щоб симуляція і
 * генератор траси користувалися РІВНО ТИМ САМИМ кодом, а не двома копіями,
 * які згодом розійдуться.
 *
 * Тільки + − × ÷ і sqrt: жодної тригонометрії, детермінізм за IEEE 754.
 */
export type Body = { px: number; py: number; vx: number; vy: number };

export function integrate(
  b: Body,
  attached: boolean,
  ax: number, ay: number, ropeLen: number,
  baseSpeed: number,
): void {
  const dt = BALANCE.dt;
  b.vy += BALANCE.gravity * dt;
  b.px += b.vx * dt;
  b.py += b.vy * dt;

  if (attached) {
    const dx = b.px - ax;
    const dy = b.py - ay;
    const d = len(dx, dy);
    if (d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      // Жорсткий трос: повертаємо точку на коло радіуса ropeLen.
      b.px = ax + nx * ropeLen;
      b.py = ay + ny * ropeLen;
      // Гасимо радіальну складову швидкості, тангенціальну лишаємо.
      const radial = b.vx * nx + b.vy * ny;
      b.vx -= radial * nx;
      b.vy -= radial * ny;
    }
  } else if (b.vx < baseSpeed) {
    // Підлога швидкості: траса нескінченна, гравець завжди їде вперед.
    b.vx = baseSpeed;
  }

  // Стеля швидкості. ДЕФЕКТ 30: поштовх на зриві розганяв гравця до 1500 од/с,
  // тобто екран перетинався за пів секунди й гра ставала нечитабельною.
  // Обмеження застосовується завжди, а не лише до поштовху.
  const sp = len(b.vx, b.vy);
  if (sp > BALANCE.maxSpeed) {
    const k = BALANCE.maxSpeed / sp;
    b.vx *= k;
    b.vy *= k;
  }
}

/** Базова швидкість на кадрі: +8 од/с кожні 10 с, стеля 520. */
export function baseSpeedAt(frame: number): number {
  const seconds = frame * BALANCE.dt;
  const gain = Math.floor(seconds / 10) * BALANCE.speedGainPer10s;
  const v = BALANCE.baseSpeed + gain;
  return v > BALANCE.speedCap ? BALANCE.speedCap : v;
}
