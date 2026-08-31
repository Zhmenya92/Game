/** Спільні типи симуляції. Окремий файл, щоб Web ↔ Simulation не утворили цикл. */

export type Anchor = { x: number; y: number };

/** Ідентифікатор відрізка. Додано при ревізії брифа (дефект 13). */
export type SegmentId = string;

export type Segment = {
  /** `${ownerId}:${eventIndex}` — стабільний між сесіями, сховища не потребує. */
  id: SegmentId;
  /** Анкер, за який чіплялися. */
  ax: number; ay: number;
  /** Точка зриву. */
  bx: number; by: number;
  /** 0 = поточний гравець. */
  ownerId: number;
  /** Лічильник зачеплень — для ліміту за популярністю. */
  hooks: number;
  /** День народження — для згасання. */
  bornDay: number;
};

export type Target =
  | { kind: 'anchor'; x: number; y: number; dist: number }
  | { kind: 'segment'; x: number; y: number; dist: number; segment: Segment };
