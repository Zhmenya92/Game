import type { GateMetrics } from './metrics.ts';
import type { Analytics } from './analytics.ts';
import type { Wallet } from './wallet.ts';
import { GATE4, type Gate4 } from './retention.ts';

export type Cohort = { day: number; size: number; d1: number | null; d7: number | null };

/**
 * Дашборд аналітики (plan.md, 10.1 — «PostHog як альтернатива, якщо не
 * хочеться будувати дашборд»). Ми будуємо: сторонній сервіс тут дав би
 * вартість, ліміти безкоштовного тарифу й ще один зовнішній ризик заради
 * дюжини чисел.
 *
 * Сторінка навмисно без збірки, без залежностей і в одному файлі: її
 * відкривають, щоб подивитися числа, а не щоб милуватися.
 *
 * Головне правило те саме, що в `metrics.ts`: якщо число порахувати
 * неможливо — писати «немає даних», а не малювати нуль.
 */

const esc = (v: unknown): string =>
  String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const pct = (v: number): string => (v * 100).toFixed(1) + ' %';
const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function verdictChip(v: 'ok' | 'low' | 'n/a' | undefined): string {
  if (v === 'ok') return '<span class="chip ok">норма</span>';
  if (v === 'low') return '<span class="chip low">нижче порога</span>';
  return '<span class="chip na">немає даних</span>';
}

/** Рядки гейта 4. Порожня метрика пишеться словами, а не нулем. */
function gate4rows(g: Gate4): string {
  const p = (v: number | null) => v === null ? '<span class="dim">немає даних</span>' : pct(v);
  const n = (v: number | null) => v === null ? '<span class="dim">немає даних</span>' : num(v);
  const list: [string, string, string, string][] = [
    [`D1 retention <span class="dim">— когорта ${g.cohortD1}</span>`, p(g.d1), pct(GATE4.d1), 'd1'],
    [`D7 retention <span class="dim">— когорта ${g.cohortD7}</span>`, p(g.d7), pct(GATE4.d7), 'd7'],
    ['Сесій на активний день', n(g.sessionsPerDay), String(GATE4.sessionsPerDay), 'sessionsPerDay'],
    ['Довжина сесії, хв', n(g.sessionMinutes), String(GATE4.sessionMinutes), 'sessionMinutes'],
    ['Rewarded opt-in', p(g.rewardedOptIn), pct(GATE4.rewardedOptIn), 'rewardedOptIn'],
    ['Payer conversion', p(g.payerConversion), pct(GATE4.payerConversion), 'payerConversion'],
  ];
  return list.map(([name, val, min, key]) =>
    `<tr><td>${name}</td><td class="n">${val}</td><td class="n dim">${min}</td>` +
    `<td>${verdictChip(g.verdict[key])}</td></tr>`).join('');
}

function cohortRows(cs: readonly Cohort[]): string {
  if (!cs.length) return '<tr><td colspan="4" class="dim">жодного гравця ще не було</td></tr>';
  const cell = (v: number | null) =>
    v === null ? '<span class="dim">ще рано</span>' : pct(v);
  return cs.map(c =>
    `<tr><td>доба ${c.day}</td><td class="n">${c.size}</td>` +
    `<td class="n">${cell(c.d1)}</td><td class="n">${cell(c.d7)}</td></tr>`).join('');
}

function rows(obj: Record<string, number>): string {
  const keys = Object.keys(obj).sort();
  if (!keys.length) return '<tr><td colspan="2" class="dim">поки порожньо</td></tr>';
  return keys.map(k => `<tr><td>${esc(k)}</td><td class="n">${obj[k]}</td></tr>`).join('');
}

export type ErrorRow = {
  message: string; where: string; ua: string; count: number; users: number;
};

export function dashboardPage(
  m: GateMetrics, g4: Gate4, cohorts: readonly Cohort[],
  a: Analytics, w: Wallet, runs: number,
  errors: readonly ErrorRow[] = [],
): string {
  const wt = w.totals();
  const deaths = a.count('run_end');
  const starts = a.count('run_start');
  const players = a.users('app_open');

  // Воронка віральності. Кожен крок — від попереднього, а не від початку:
  // так видно, ДЕ саме сипеться, а не лише що сипеться.
  const funnel: [string, number, number][] = [
    ['Відкрили гру', players, players],
    ['Зіграли ран', a.users('run_start'), players],
    ['Натиснули «кинути виклик»', a.users('share_click'), a.users('run_start')],
    ['Виклик створено', m.challengesCreated, a.users('share_click')],
    ['Хтось відкрив виклик', m.challengeOpens, m.challengesCreated],
    ['Відповів тією ж трасою', m.challengeReplies, m.challengeOpens],
  ];

  const gates: [string, string, string, 'ok' | 'low' | 'n/a'][] = [
    ['Share rate', 'шер / смерть, мінімум 2 %', pct(m.shareRate), m.verdict.shareRate as never],
    ['Відкриттів на виклик', 'різних людей / виклик, мінімум 0.5', num(m.opensPerChallenge), m.verdict.opensPerChallenge as never],
    ['Reply rate', 'зіграв ту саму трасу / відкрив, мінімум 50 %', pct(m.replyRate), m.verdict.replyRate as never],
    ['K-фактор', 'запрошень на відправника × конверсія, мінімум 0.25', num(m.kFactor), m.verdict.kFactor as never],
    ['Ghost-hook rate', 'ранів із зачепленням за чужу лінію, мінімум 30 %', pct(m.foreignHookRate), m.verdict.foreignHookRate as never],
  ];

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Павутина — аналітика</title>
<style>
  :root{--bg:#0b100f;--card:#131a19;--line:#26302e;--ink:#e6edeb;--dim:#8fa8a4;
        --ok:#4fd1bc;--low:#e08585;--na:#93a09f;color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--ink);
       font:15px/1.5 ui-monospace,"SF Mono",Menlo,monospace}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:15px;margin:28px 0 10px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
  .sub{color:var(--dim);margin:0 0 8px}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
  .card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px}
  .v{font-size:28px;font-weight:600}
  .k{color:var(--dim);font-size:13px}
  table{width:100%;border-collapse:collapse;background:var(--card);
        border:1px solid var(--line);border-radius:6px;overflow:hidden}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  th{color:var(--dim);font-weight:500;font-size:13px}
  td.n{text-align:right;font-variant-numeric:tabular-nums}
  .dim{color:var(--dim)}
  .chip{padding:2px 8px;border-radius:99px;font-size:12px;white-space:nowrap}
  .chip.ok{background:#14302c;color:var(--ok)}
  .chip.low{background:#361f1f;color:var(--low)}
  .chip.na{background:#212927;color:var(--na)}
  .bar{height:6px;background:#1e2725;border-radius:99px;overflow:hidden;margin-top:6px}
  .bar>i{display:block;height:100%;background:var(--ok)}
  footer{margin-top:32px;color:var(--dim);font-size:13px;line-height:1.7}
</style></head><body>

<h1>Павутина — аналітика</h1>
<p class="sub">Гейт 3 (plan.md, 8.3) і воронка віральності. Оновлено ${esc(new Date().toISOString().replace('T', ' ').slice(0, 19))} UTC.</p>

<div class="grid">
  <div class="card"><div class="v">${players}</div><div class="k">гравців (унікальні app_open)</div></div>
  <div class="card"><div class="v">${starts}</div><div class="k">ранів почато</div></div>
  <div class="card"><div class="v">${deaths}</div><div class="k">ранів завершено</div></div>
  <div class="card"><div class="v">${runs}</div><div class="k">ранів прийнято сервером</div></div>
</div>

<h2>Гейт 3</h2>
<table>
  <tr><th>Метрика</th><th>Значення</th><th>Стан</th></tr>
  ${gates.map(([name, hint, val, v]) => `<tr>
    <td>${esc(name)}<div class="dim" style="font-size:12px">${esc(hint)}</div></td>
    <td class="n">${esc(val)}</td><td>${verdictChip(v)}</td></tr>`).join('')}
</table>

<h2>Воронка</h2>
<table>
  <tr><th>Крок</th><th>Людей</th><th>Від попереднього</th></tr>
  ${funnel.map(([name, v, base]) => {
    const share = base > 0 ? v / base : 0;
    return `<tr><td>${esc(name)}<div class="bar"><i style="width:${Math.min(100, share * 100).toFixed(1)}%"></i></div></td>
      <td class="n">${v}</td><td class="n">${base > 0 ? pct(share) : '<span class="dim">—</span>'}</td></tr>`;
  }).join('')}
</table>

<h2>Гейт 4 — фінальний</h2>
<p class="sub">Вісім порогів, що вирішують: стор-фаза чи закриття. Когорта, у якої відповідний день ще не настав, у знаменник <b>не входить</b> — інакше ретеншен занижується самим лише зростанням аудиторії.</p>
<table>
  <tr><th>Метрика</th><th>Значення</th><th>Мінімум</th><th>Стан</th></tr>
  ${gate4rows(g4)}
</table>

<h2>Когорти</h2>
<table>
  <tr><th>День приходу</th><th>Людей</th><th>D1</th><th>D7</th></tr>
  ${cohortRows(cohorts)}
</table>

<h2>Гроші й продовження</h2>
<div class="grid">
  <div class="card"><div class="v">${a.count('iap_purchased')}</div><div class="k">покупок</div></div>
  <div class="card"><div class="v">${a.sum('iap_purchased', 'stars')}</div><div class="k">Stars отримано</div>
    <div class="k" style="margin-top:6px">≈ $${(a.sum('iap_purchased', 'stars') * 0.009).toFixed(2)} за курсом ~$0.009/Star</div></div>
  <div class="card"><div class="v">${a.count('ad_watched')}</div><div class="k">переглядів реклами</div></div>
  <div class="card"><div class="v">${wt.granted} / ${wt.consumed}</div><div class="k">продовжень видано / витрачено</div></div>
</div>

<h2>Помилки на клієнтах</h2>
<p class="sub">До софтлончу гра падала мовчки: про білий екран на чужому Android ми дізналися б лише тоді, коли хтось здогадався б написати — тобто найімовірніше ніколи, а лишилося б враження, що «людям не зайшло».</p>
<table>
  <tr><th>Помилка</th><th>Разів</th><th>Людей</th></tr>
  ${errors.length ? errors.map(e => `<tr>
    <td>${esc(e.message)}<div class="dim" style="font-size:12px">${esc(e.where)}<br>${esc(e.ua)}</div></td>
    <td class="n">${e.count}</td><td class="n">${e.users}</td></tr>`).join('')
    : '<tr><td colspan="3" class="dim">жодної — або жодного гравця ще не було</td></tr>'}
</table>

<h2>Що ще видно</h2>
<div class="grid">
  <div class="card"><div class="k">Причини смерті</div>
    <table style="border:none;background:none;margin-top:6px">${rows(a.breakdown('run_end', 'cause'))}</table></div>
  <div class="card"><div class="k">Серії днів поспіль</div>
    <table style="border:none;background:none;margin-top:6px">${rows(a.streakHistogram())}</table></div>
  <div class="card"><div class="k">Обійшли конкретного друга</div>
    <div class="v">${a.count('ghost_beaten')}</div>
    <div class="k">подій ghost_beaten — прямий вимір того, чи працює диференціація</div></div>
</div>

<footer>
  <b>Чого тут немає і чому.</b><br>
  • <b>D1 / D7 retention</b> — потрібні дві доби спостережень мінімум; рахувати їх на порожньому наборі означало б намалювати число.<br>
  • <b>Конверсія «відкрив / отримав»</b> — метрику плану порахувати неможливо: Telegram не повідомляє, скільки людей побачило повідомлення в чаті (дефект 38). Замість неї — «відкриттів на виклик».<br>
  • <b>Дохід</b> — перерахунок Stars у долари приблизний: ефективна ставка залежить від того, звідки куплено (мобільний застосунок чи веб), мінімум виводу 1 000 Stars, холд 21 день.
</footer>
</body></html>`;
}
