/**
 * Трек вводу: список подій (кадр, тип).
 * plan.md, Рішення 2: кілька сотень байтів на ран, а не відео.
 *
 * Симуляція споживає СТАН кнопки (див. Simulation.step), а трек — це спосіб
 * цей стан відтворити. Так виправлено дефект 14 ревізії брифа.
 */

export type InputEventType = 'down' | 'up';
export type InputEvent = { frame: number; type: InputEventType };

export class InputTrace {
  readonly events: InputEvent[] = [];

  record(frame: number, type: InputEventType): void {
    const last = this.events[this.events.length - 1];
    // Дедуп: два 'down' підряд не мають сенсу і псують відтворення.
    if (last && last.type === type) return;
    this.events.push({ frame, type });
  }

  /** Стан кнопки на заданому кадрі. */
  isDownAt(frame: number): boolean {
    let down = false;
    for (const e of this.events) {
      if (e.frame > frame) break;
      down = e.type === 'down';
    }
    return down;
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
      out[i * 3 + 2] = e.type === 'down' ? 1 : 0;
    }
    return out;
  }

  static deserialize(bytes: Uint8Array): InputTrace {
    const t = new InputTrace();
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      t.events.push({
        frame: bytes[i] | (bytes[i + 1] << 8),
        type: bytes[i + 2] === 1 ? 'down' : 'up',
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
