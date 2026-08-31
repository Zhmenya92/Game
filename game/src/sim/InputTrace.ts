/**
 * Трек вводу: список подій (кадр, тип).
 * plan.md, Рішення 2: кілька сотень байтів на ран, а не відео.
 *
 * Симуляція споживає СТАН кнопки (див. Simulation.step), а трек — це спосіб
 * цей стан відтворити. Так виправлено дефект 14 ревізії брифа.
 */

/**
 * 'revive' додано в тижні 6. Воскресіння мусить бути ПОДІЄЮ ТРЕКУ, а не
 * станом клієнта: сервер перевіряє рахунок переграванням, і якщо гравець
 * воскрес, а в треку цього немає, чесний ран буде відхилено як накрутка.
 */
export type InputEventType = 'down' | 'up' | 'revive';
export type InputEvent = { frame: number; type: InputEventType };

export class InputTrace {
  readonly events: InputEvent[] = [];

  record(frame: number, type: InputEventType): void {
    const last = this.events[this.events.length - 1];
    // Дедуп: два 'down' підряд не мають сенсу і псують відтворення.
    // Воскресіння з-під дедупу виведене: два поспіль — це два різні
    // воскресіння, і злити їх в одне означає розійтися з симуляцією.
    if (type !== 'revive' && last && last.type === type) return;
    this.events.push({ frame, type });
    this.reviveFrames_ = null;
  }

  /** Кадри, на яких гравець воскресав. Рахується один раз і кешується. */
  private reviveFrames_: Set<number> | null = null;

  /** Стан кнопки на заданому кадрі. Воскресіння кнопки не чіпає. */
  isDownAt(frame: number): boolean {
    let down = false;
    for (const e of this.events) {
      if (e.frame > frame) break;
      if (e.type === 'revive') continue;
      down = e.type === 'down';
    }
    return down;
  }

  /**
   * Чи є воскресіння на цьому кадрі.
   *
   * Через Set, а не лінійним пошуком, як `isDownAt`: перевірка робиться
   * щокадру, а воскресінь у треку одиниці. Кеш скидається на `record`.
   */
  isReviveAt(frame: number): boolean {
    if (!this.reviveFrames_) {
      this.reviveFrames_ = new Set(
        this.events.filter(e => e.type === 'revive').map(e => e.frame));
    }
    return this.reviveFrames_.has(frame);
  }

  get reviveCount(): number {
    let n = 0;
    for (const e of this.events) if (e.type === 'revive') n++;
    return n;
  }

  /**
   * Серіалізація: 3 байти на подію — кадр u16 + тип u8.
   * 40 замахів × 2 події × 3 = 240 байтів. Вкладаємось у «сотні байтів».
   */
  serialize(): Uint8Array {
    const out = new Uint8Array(this.events.length * 3);
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      out[i * 3] = e.frame & 0xff;
      out[i * 3 + 1] = (e.frame >> 8) & 0xff;
      out[i * 3 + 2] = e.type === 'down' ? 1 : e.type === 'revive' ? 2 : 0;
    }
    return out;
  }

  static deserialize(bytes: Uint8Array): InputTrace {
    const t = new InputTrace();
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      t.events.push({
        frame: bytes[i] | (bytes[i + 1] << 8),
        type: bytes[i + 2] === 1 ? 'down' : bytes[i + 2] === 2 ? 'revive' : 'up',
      });
    }
    return t;
  }

  /** FNV-1a по серіалізованих байтах. Для серверної верифікації. */
  hash(): string {
    const bytes = this.serialize();
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
}
