/**
 * Палітра. Одна на гру й на генератор атласа.
 *
 * Тримати її тут, а не в сцені, довелося з практичної причини: атлас
 * малюється в Node тими самими кольорами, якими сцена тінтує спрайти. Дві
 * копії палітри розійшлися б із першою ж правкою, і тінт перестав би
 * збігатися з тим, що запечено в текстурі.
 */

export const COL = {
  skyTop: 0x0a1420,
  skyBottom: 0x16323a,
  ground: 0x0a1a18,
  groundRim: 0x2b4a46,
  anchor: 0x8fa8a4,
  anchorLive: 0x4fd1bc,
  rope: 0xffffff,
  player: 0xffe9a8,
  playerCore: 0xf0b95e,
  trail: 0xffd166,
  ownWeb: 0xf0a24a,
  foreignWeb: 0x4fd1bc,
  chase: 0xd6455b,
  ghost: 0x9fb4c7,
  bgFar: 0x102630,
  bgNear: 0x0d1d24,
} as const;

/**
 * Скіни. Кожен — просто інший тінт того самого кадру hero, тобто НУЛЬ
 * додаткових кадрів в атласі. Саме це дозволяє бюджет кадрів плану
 * (розділ 9): «не генерувати те, що малюється кодом».
 */
export const SKINS: Record<string, { hero: number; trail: number; title: string }> = {
  amber: { hero: 0xffb347, trail: 0xff8c42, title: 'Бурштиновий слід' },
};

export function skinHero(skin: string | null): number {
  return (skin && SKINS[skin]?.hero) || COL.player;
}

export function skinTrail(skin: string | null): number {
  return (skin && SKINS[skin]?.trail) || COL.trail;
}

/** 0xRRGGBB → [r, g, b]. Потрібно генератору, який працює побайтово. */
export function rgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** Лінійна інтерполяція двох кольорів; t поза [0,1] обрізається. */
export function mix(a: number, b: number, t: number): [number, number, number] {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b);
  return [ar + (br - ar) * k, ag + (bg - ag) * k, ab + (bb - ab) * k];
}
