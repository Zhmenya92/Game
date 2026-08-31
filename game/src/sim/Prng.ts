/**
 * Seeded PRNG. plan.md, Рішення 2: жодного Math.random() у симуляції.
 *
 * xorshift32 — цілочисельний, тому побітово однаковий у будь-якому JS-рушії.
 * Усі операції — 32-бітні цілі через |0 і >>> 0, без плаваючої коми в стані.
 */
export class Prng {
  private s: number;

  constructor(seed: number) {
    // Стан не може бути нулем — xorshift залипне назавжди.
    this.s = (seed | 0) === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  /** Наступне 32-бітне ціле. */
  nextUint(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x;
  }

  /** [0, 1). Ділення на 2^32 — точне в подвійній точності. */
  next(): number {
    return this.nextUint() / 4294967296;
  }

  /** Ціле в [min, max] включно. */
  int(min: number, max: number): number {
    const span = max - min + 1;
    return min + (this.nextUint() % span);
  }

  /** Копія стану — щоб відгалужувати генерацію, не зачіпаючи основний потік. */
  clone(): Prng {
    const p = new Prng(1);
    p.s = this.s;
    return p;
  }
}
