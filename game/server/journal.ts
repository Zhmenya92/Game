import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Довговічність даних софтлончу (plan.md, розділ 11).
 *
 * НАВІЩО ЦЕ ГОЛОВНА РОБОТА ТИЖНЯ 7. Гейт 4 вимагає **мінімум двох тижнів**
 * збору даних — інакше D7 не порахувати. До цього тижня всі сховища жили в
 * пам'яті процесу, тобто перший же перезапуск сервера — деплой, падіння,
 * оновлення — стирав усе. Софтлонч на такому сховищі не збирає нічого; він
 * лише створює враження, що збирає.
 *
 * ФОРМА: журнал додавання, по одному JSON на рядок. Стан не зберігається
 * взагалі — він **відтворюється** програванням журналу на старті. Це рівно
 * те саме рішення, що й у самій грі: там джерелом істини є трек вводу, а не
 * знімок стану. Тому тут немає жодної нової ідеї, лише та сама, застосована
 * до сервера.
 *
 * Чого тут свідомо немає: бази даних. На 50–100 гравцях гейта 3 і на
 * кількох тисячах записів файл робить те саме, не додаючи ні залежності, ні
 * ще одного зовнішнього ризику. Коли вона знадобиться, замінюється `Journal`,
 * а не решта сервера.
 */

export type Rec =
  | { t: 'run'; chatId: string; run: unknown }
  | { t: 'challenge'; c: unknown }
  | { t: 'open'; token: string; userId: number }
  | { t: 'reply'; token: string; userId: number; seed: number }
  | { t: 'seen'; userId: number; how: string }
  | { t: 'grant'; userId: number; n: number; source: string; ref: string }
  | { t: 'reserve'; userId: number }
  | { t: 'settle'; userId: number; used: number }
  | { t: 'skin'; userId: number; skinId: string; ref: string }
  | { t: 'event'; name: string; userId: number; props: Record<string, unknown>; at: number }
  | { t: 'day'; userId: number; day: number };

export class Journal {
  private readonly file: string;
  private readonly enabled: boolean;
  private written = 0;

  /** Порожня тека вимикає журнал: тести й розробка не мають сміттити на диск. */
  constructor(dir: string) {
    this.enabled = dir.length > 0;
    this.file = this.enabled ? join(dir, 'journal.jsonl') : '';
    if (this.enabled) mkdirSync(dir, { recursive: true });
  }

  get on(): boolean { return this.enabled; }
  get path(): string { return this.file; }
  get count(): number { return this.written; }

  append(r: Rec): void {
    if (!this.enabled) return;
    try {
      appendFileSync(this.file, JSON.stringify(r) + '\n', 'utf8');
      this.written++;
    } catch (e) {
      // Втратити запис гірше, ніж галасувати, але впасти через журнал —
      // ще гірше: гра має пережити повний диск.
      console.error('журнал не записався:', (e as Error).message);
    }
  }

  /**
   * Прочитати все. Пошкоджений рядок пропускається з попередженням, а не
   * роняє старт: обірваний запис у кінці файлу — звичайний наслідок
   * жорсткого вимкнення, і через нього не можна втрачати решту двох тижнів.
   */
  readAll(): Rec[] {
    if (!this.enabled || !existsSync(this.file)) return [];
    const out: Rec[] = [];
    let broken = 0;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Rec); } catch { broken++; }
    }
    if (broken) console.error(`журнал: пропущено пошкоджених рядків — ${broken}`);
    return out;
  }

  /**
   * Ущільнення: переписати журнал переліком записів. Викликається вручну,
   * коли файл виріс; поточна форма гри до цього не дійде за місяці.
   */
  compact(recs: readonly Rec[]): void {
    if (!this.enabled) return;
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    renameSync(tmp, this.file);
  }
}
