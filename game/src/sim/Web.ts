import { BALANCE } from '../config/balance.ts';
import { InputTrace } from './InputTrace.ts';
import { Simulation } from './Simulation.ts';
import type { Segment } from './types.ts';
import type { Difficulty } from './Simulation.ts';
import { playTrace } from './playback.ts';

/**
 * Павутина (бриф, розділ 4 і prototype-1-pavutyna.md, розділ 4).
 *
 * КЛЮЧОВЕ: павутина не потребує окремого сховища. Відрізок повністю
 * визначається кадром зачеплення й кадром зриву, а вони вже є у треку вводу.
 * Тому павутина чужого рану — це просто його трек, переграний тут.
 * Вартість чужої павутини = вартість чужого привида, кілька сотень байтів.
 */

/**
 * Детермінований розбір треків у відрізки.
 * Порядок стабільний: спершу за ownerId, потім за порядком подій усередині треку.
 */
export function buildFromTraces(
  seed: number,
  traces: readonly {
    ownerId: number; trace: InputTrace; day: number;
    /** Складність, з якою грався ТОЙ ран. Без неї відрізки розійдуться
     *  з тим, що бачив автор рану, і верифікація почне відхиляти чесних. */
    difficulty?: Difficulty;
  }[],
): Segment[] {
  const out: Segment[] = [];

  // Сортування копії — стабільне і з детермінованим тайбрейком за ownerId.
  const ordered = traces.slice().sort((a, b) => a.ownerId - b.ownerId);

  for (const t of ordered) {
    const sim = new Simulation(seed, [], undefined, t.difficulty ?? 'normal');
    const lastFrame = t.trace.events.length
      ? t.trace.events[t.trace.events.length - 1].frame + 1
      : 0;
    // Через playTrace, а не власним циклом: інакше воскресіння в чужому
    // треку обірве розбір на першій смерті й павутина вийде коротшою.
    playTrace(sim, t.trace, lastFrame + 1);
    for (let i = 0; i < sim.ownWeb.length; i++) {
      const s = sim.ownWeb[i];
      out.push({
        ...s,
        id: `${t.ownerId}:${i}`,
        ownerId: t.ownerId,
        bornDay: t.day,
      });
    }
  }

  return out;
}

/**
 * Відбір видимих (бриф, 4.2). Модель Dark Souls: показуємо не все.
 * Сортування за кількістю зачеплень ↓, при рівності — за свіжістю ↓,
 * при повній рівності — за id, щоб порядок був детермінованим.
 */
export function selectVisible(
  all: readonly Segment[],
  limit: number = BALANCE.foreignLineLimit,
): Segment[] {
  return all
    .slice()
    .sort((a, b) => {
      if (b.hooks !== a.hooks) return b.hooks - a.hooks;
      if (b.bornDay !== a.bornDay) return b.bornDay - a.bornDay;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}
