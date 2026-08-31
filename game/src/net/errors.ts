import { api } from './api.ts';

/**
 * Повідомлення про падіння клієнта.
 *
 * До софтлончу гра падала **мовчки**. Якщо на якомусь Android білий екран,
 * ми дізналися б про це лише тоді, коли хтось із півсотні запрошених
 * здогадався б написати, — тобто найімовірніше ніколи. Лишилося б враження,
 * що «людям не зайшло», і хибний висновок про механіку замість правдивого
 * про один зламаний пристрій.
 *
 * Правила, без яких це саме стає проблемою:
 *   • не більше кількох повідомлень за сесію — помилка всередині циклу
 *     рендера інакше шле по шістдесят запитів на секунду;
 *   • однакові тексти не повторюються;
 *   • сам звіт нічого не кидає: обробник помилок, що падає, — це смішно.
 */

const MAX_PER_SESSION = 5;
let sent = 0;
const seen = new Set<string>();

function report(message: string, where: string): void {
  if (sent >= MAX_PER_SESSION) return;
  const key = message.slice(0, 120);
  if (seen.has(key)) return;
  seen.add(key);
  sent++;
  try {
    void api.clientError(key, where.slice(0, 200));
  } catch { /* обробник помилок не має права падати */ }
}

export function installErrorReporting(): void {
  window.addEventListener('error', e => {
    const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '';
    report(String(e.message ?? 'помилка без тексту'), where);
  });

  // Провалені промиси — це ми: мережа, атлас, оплати. Їх не видно в
  // 'error', і саме вони найчастіше лишаються непоміченими.
  window.addEventListener('unhandledrejection', e => {
    const r = (e as PromiseRejectionEvent).reason;
    const msg = r instanceof Error ? `${r.name}: ${r.message}` : String(r);
    report(msg, 'promise');
  });
}
