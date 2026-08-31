/**
 * Сід дня (plan.md, 8.1, GET /daily).
 *
 * Однаковий для всіх у світі й змінюється о 00:00 UTC — саме це робить
 * порівняння чесним, як у Spelunky Daily Challenge. Сід виводиться з дати
 * детерміновано, тому сервер не мусить нічого зберігати.
 */
export function dailySeed(now: Date = new Date()): { seed: number; date: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // FNV-1a по рядку дати: стабільно, без залежності від локалі й таймзони.
  let h = 0x811c9dc5;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return { seed: h >>> 1, date };
}

/** Номер доби — використовується як bornDay для згасання павутини. */
export function dayNumber(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 86400000);
}
