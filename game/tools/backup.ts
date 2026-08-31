import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Journal } from '../server/journal.ts';

export {};   // робить файл модулем: інакше TypeScript не дозволяє await зверху

/**
 * Резервна копія журналу.
 *
 * ЗНАЙДЕНО КРИТИКОЮ. Резервної копії не було взагалі, а в `DEPLOY.md` це
 * було списано на хостинг. Для двох тижнів збору, які **не можна
 * повторити**, це занадто легковажно: один загублений диск — і гейт 4
 * починається спочатку.
 *
 * Копія робиться простим копіюванням файлу: журнал дописується в кінець і
 * ніколи не переписується, тож копія в найгіршому випадку обірветься на
 * половині рядка — а обірваний рядок читач і так пропускає.
 *
 * Запуск:
 *   DATA_DIR=/data node tools/backup.ts                # копія
 *   DATA_DIR=/data node tools/backup.ts --compact      # копія + ущільнення
 *
 * У продакшні — раз на добу з cron. Копії старші за 14 днів прибираються:
 * саме стільки триває збір даних гейта 4.
 */

const dataDir = process.env.DATA_DIR ?? '';
const backupDir = process.env.BACKUP_DIR ?? (dataDir ? join(dataDir, 'backup') : '');
const compact = process.argv.includes('--compact');
const KEEP_DAYS = 14;

if (!dataDir) {
  console.error('немає DATA_DIR — нема чого копіювати.');
  process.exit(1);
}

const journal = new Journal(dataDir);
if (!existsSync(journal.path)) {
  console.error(`журналу ${journal.path} не існує — сервер ще не писав нічого.`);
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const dest = join(backupDir, `journal-${stamp}.jsonl`);
copyFileSync(journal.path, dest);

const size = statSync(dest).size;
console.log(`копія: ${dest} (${(size / 1024).toFixed(1)} КБ)`);

// Перевіряємо, що скопійоване взагалі читається, — інакше це не копія,
// а файл, який колись здасться копією. Читаємо саме КОПІЮ, не оригінал.
let good = 0, broken = 0;
for (const line of readFileSync(dest, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { JSON.parse(line); good++; } catch { broken++; }
}
console.log(`  читається: записів ${good}` + (broken ? `, пошкоджених ${broken}` : ''));
if (good === 0) {
  console.error('  ⚠️ копія порожня або нечитабельна — це не резервна копія');
  process.exit(1);
}

if (compact) {
  const before = statSync(journal.path).size;
  journal.compact(journal.readAll());
  const after = statSync(journal.path).size;
  console.log(`ущільнено: ${(before / 1024).toFixed(1)} → ${(after / 1024).toFixed(1)} КБ`);
  console.log('  ⚠️ робіть це лише при зупиненому сервері: він дописує в кінець');
}

// Прибирання старих копій.
const cutoff = Date.now() - KEEP_DAYS * 86400000;
let removed = 0;
for (const f of readdirSync(backupDir)) {
  if (!f.startsWith('journal-') || !f.endsWith('.jsonl')) continue;
  const p = join(backupDir, f);
  if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
}
if (removed) console.log(`прибрано копій старших за ${KEEP_DAYS} днів: ${removed}`);
