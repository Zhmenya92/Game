import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Репетиція софтлончу.
 *
 * ⚠️ ЩО ЦЕ НЕ Є. Це не результати гри й не прогноз. Усі числа тут
 * **вигадані генератором** і про «Павутину» не кажуть нічого.
 *
 * ЩО ЦЕ Є. Метрики гейта 4 написані в тижні 7 і **жодного разу не бачили
 * даних**. Модульні тести перевіряють арифметику на трьох гравцях; на
 * наборі за два тижні ламається інше — когорти, межі доби, гідрація
 * журналу, порядок записів. Дізнатися про це через два тижні після
 * запуску, коли дані вже зібрані неправильно, — найдорожчий варіант.
 *
 * ЯК ЦЕ ПРАЦЮЄ. Генератор пише журнал і **сам рахує істину по тому, що
 * реально написав**, а не по параметрах, які в нього заклали. Потім
 * піднімається справжній сервер, відновлює стан із того ж журналу й
 * рахує метрики. Числа мусять збігтися **точно**: обидві сторони бачать
 * ті самі події.
 *
 * Порівнювати з параметрами було б помилкою — параметри задають лише
 * очікування, а вибірка від нього відхиляється. Перша версія цього файлу
 * саме так і робила, і через це не могла відрізнити помилку приладу від
 * звичайного розкиду.
 *
 * Запуск: node tools/rehearse.ts [гравців] [днів]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server', 'index.ts');

const PLAYERS = Number(process.argv[2] ?? 300);
const DAYS = Number(process.argv[3] ?? 14);

/** Параметри генерації. Це вхід, а не очікуваний результат. */
const P = {
  d1: 0.35,
  d7: 0.12,
  maxSessionsPerDay: 5,
  sessionMinutes: 5,
  shareOnDeath: 0.05,
  replyAfterOpen: 0.6,
  adOfferShare: 0.5,
  adOptIn: 0.22,
  payerConversion: 0.02,
  foreignHookRate: 0.4,
};

const DAY = 86400000;
const MIN = 60000;

let seed = 20260831;
const rnd = (): number => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};
const chance = (p: number): boolean => rnd() < p;
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

// ── 1. Хто коли грає ───────────────────────────────────────────────────────
//
// Крива утримання степенева: p(d) = d1 · d^(−b), де b підібране так, щоб
// p(7) дорівнювало заданому D7. Експонента дала б D7 порядку тисячних,
// чого в живих іграх не буває, — репетиція перевіряла б неможливий випадок.

const b = Math.log(P.d1 / P.d7) / Math.log(7);
const returnChance = (rel: number): number => P.d1 * Math.pow(rel, -b);

/** Доба 0 — ПІВНІЧ UTC. Інакше згенерований «день» переїжджає за північ. */
const day0Index = Math.floor(Date.now() / DAY) - (DAYS - 1);
const day0 = day0Index * DAY;

type Player = {
  id: number;
  joinDay: number;               // індекс усередині періоду, 0..DAYS-1
  active: Set<number>;           // ті самі індекси
  showAds: boolean;
  willPay: boolean;
};

const players: Player[] = [];
for (let u = 1; u <= PLAYERS; u++) {
  const joinDay = Math.floor(rnd() * Math.max(1, DAYS - 2));
  const active = new Set<number>([joinDay]);
  for (let d = joinDay + 1; d < DAYS; d++) {
    if (chance(returnChance(d - joinDay))) active.add(d);
  }
  players.push({
    id: 100000 + u, joinDay, active,
    showAds: chance(P.adOfferShare), willPay: chance(P.payerConversion),
  });
}

/** Хто активний у цей день — щоб виклики відкривали ті, хто того дня грав. */
const activeOn = new Map<number, Player[]>();
for (const p of players) {
  for (const d of p.active) {
    const list = activeOn.get(d) ?? [];
    list.push(p);
    activeOn.set(d, list);
  }
}

// ── 2. Журнал ──────────────────────────────────────────────────────────────

const lines: string[] = [];
const put = (r: unknown): void => { lines.push(JSON.stringify(r)); };

/**
 * Остання позначена активність кожного гравця. Потрібна, щоб відкриття
 * чужого виклику лягало у ЙОГО ж сесію, а не створювало нову: інакше
 * генератор дарує активність, якої не планував, і сам себе не сходиться.
 */
const lastAt = new Map<number, number>();
const mark = (userId: number, at: number): void => {
  if (at > (lastAt.get(userId) ?? 0)) lastAt.set(userId, at);
};

/** Істина: скільки сесій і скільки хвилин реально записано. */
const truth = {
  sessions: 0,
  sessionMs: 0,
  adOffers: 0,
  adWatched: 0,
  payers: new Set<number>(),
  deaths: 0,
  shares: 0,
  runs: 0,
  runsWithForeign: 0,
  challenges: 0,
  opens: 0,
  replies: 0,
};

let runSeq = 0;
let challengeSeq = 0;
type Ch = { token: string; owner: number; day: number; at: number };
const challenges: Ch[] = [];

for (const p of players) {
  put({ t: 'seen', userId: p.id, how: p.joinDay === 0 || !chance(0.25) ? 'organic' : 'challenge' });

  for (const d of [...p.active].sort((a, z) => a - z)) {
    const dayStart = day0 + d * DAY + (8 + rnd() * 3) * 3600000;
    put({ t: 'day', userId: p.id, day: day0Index + d });

    const sessions = 1 + Math.floor(rnd() * P.maxSessionsPerDay);
    for (let sIdx = 0; sIdx < sessions; sIdx++) {
      // Сесії рознесені рівно на 2.2 години.
      //
      // Спершу тут було sIdx × (1.5…2) год із випадковим множником НА КОЖНУ
      // сесію. Для sIdx = 2 мінімальний розрив виходив рівно 30 хвилин, а
      // далі й від'ємний, тож сусідні сесії злипалися в одну — і сервер
      // чесно бачив менше сесій, ніж генератор думав, що записав.
      const sStart = dayStart + sIdx * 2.2 * 3600000;
      put({ t: 'event', name: 'app_open', userId: p.id, props: {}, at: sStart });
      truth.sessions++;

      const runs = 2 + Math.floor(rnd() * 8);
      const runMs = (P.sessionMinutes * MIN) / runs;
      let tail = sStart;   // остання подія сесії; звідси її тривалість
      for (let r = 0; r < runs; r++) {
        const at = sStart + r * runMs;
        put({ t: 'event', name: 'run_start', userId: p.id, props: { seed: 1 }, at });
        const score = 20 + Math.floor(rnd() * 400);
        const endAt = at + runMs * 0.8;
        put({
          t: 'event', name: 'run_end', userId: p.id,
          props: { score, ms: Math.round(runMs), cause: pick(['fell', 'left']) }, at: endAt,
        });
        truth.deaths++;
        tail = endAt;

        const id = `r${(++runSeq).toString(36).padStart(6, '0')}`;
        const foreign = chance(P.foreignHookRate) ? 1 + Math.floor(rnd() * 3) : 0;
        put({
          t: 'run', chatId: `chat${p.id % 12}`,
          run: {
            id, ownerId: p.id, seed: 1, traceB64: '', score,
            frames: 600, day: day0Index + d, foreignHooks: foreign,
          },
        });
        truth.runs++;
        if (foreign > 0) truth.runsWithForeign++;

        if (chance(P.shareOnDeath)) {
          const at2 = endAt + 1000;
          put({ t: 'event', name: 'share_click', userId: p.id, props: {}, at: at2 });
          truth.shares++;
          tail = at2;
          const token = `t${(++challengeSeq).toString(36)}`;
          put({
            t: 'challenge',
            c: {
              token, chatId: `chat${p.id % 12}`, ownerId: p.id, seed: 1,
              runId: id, score, createdAt: at2, opens: [], replies: [],
            },
          });
          truth.challenges++;
          challenges.push({ token, owner: p.id, day: d, at: at2 });
        }

        if (p.showAds && chance(0.25)) {
          const at2 = endAt + 2000;
          put({ t: 'event', name: 'ad_offer', userId: p.id, props: { score }, at: at2 });
          truth.adOffers++;
          tail = at2;
          if (chance(P.adOptIn)) {
            put({ t: 'grant', userId: p.id, n: 1, source: 'ad', ref: `ad:${p.id}:${d}:${r}` });
            put({ t: 'event', name: 'ad_watched', userId: p.id, props: { source: 'adsgram' }, at: at2 + 1000 });
            truth.adWatched++;
            tail = at2 + 1000;
          }
        }
      }

      if (p.willPay && sIdx === 0 && d === p.joinDay) {
        put({ t: 'event', name: 'iap_open', userId: p.id, props: { product: 'revive3', stars: 25 }, at: sStart + MIN });
        put({ t: 'grant', userId: p.id, n: 3, source: 'purchase', ref: `tg:${p.id}` });
        const at2 = sStart + MIN + 5000;
        put({ t: 'event', name: 'iap_purchased', userId: p.id, props: { product: 'revive3', stars: 25 }, at: at2 });
        truth.payers.add(p.id);
        if (at2 > tail) tail = at2;
      }

      truth.sessionMs += tail - sStart;
      mark(p.id, tail);
    }
  }
}

// ── 3. Виклики відкривають ті, хто того дня грав ──────────────────────────
//
// Це не дрібниця. Перша версія роздавала відкриття випадковим гравцям у
// час автора виклику — тобто дарувала їм активність у дні, коли вони не
// грали. Ретеншен через це виріс утричі, і виглядало це як помилка
// сервера. Подія має належати ДНЮ ТОГО, ХТО ЇЇ РОБИТЬ.

for (const c of challenges) {
  const candidates = (activeOn.get(c.day) ?? []).filter(p => p.id !== c.owner);
  if (!candidates.length) continue;
  const opens = 1 + (chance(0.4) ? 1 : 0);
  const used = new Set<number>();
  for (let i = 0; i < opens; i++) {
    const other = candidates[Math.floor(rnd() * candidates.length)];
    if (used.has(other.id)) continue;
    used.add(other.id);
    // Час — усередині ВЛАСНОЇ сесії відкривача, за пʼять секунд після його
    // останньої дії. Інакше подія створює йому зайву сесію в чужий час.
    const base = lastAt.get(other.id);
    if (base === undefined) continue;
    put({ t: 'open', token: c.token, userId: other.id });
    put({ t: 'event', name: 'challenge_opened', userId: other.id, props: {}, at: base + 5000 });
    truth.opens++;
    truth.sessionMs += 5000;
    mark(other.id, base + 5000);
    if (chance(P.replyAfterOpen)) {
      put({ t: 'reply', token: c.token, userId: other.id, seed: 1 });
      put({ t: 'event', name: 'challenge_replied', userId: other.id, props: {}, at: base + 10000 });
      truth.replies++;
      truth.sessionMs += 5000;
      mark(other.id, base + 10000);
    }
  }
}

// ── 4. Істина за тим самим правилом, що й у сервера ───────────────────────

const today = day0Index + DAYS - 1;
const retentionAt = (offset: number): { rate: number | null; cohort: number } => {
  let cohort = 0, kept = 0;
  for (const p of players) {
    const first = day0Index + p.joinDay;
    if (first + offset > today) continue;
    cohort++;
    if (p.active.has(p.joinDay + offset)) kept++;
  }
  return { rate: cohort ? kept / cohort : null, cohort };
};

let activeDays = 0;
for (const p of players) activeDays += p.active.size;

const expected = {
  users: players.length,
  d1: retentionAt(1),
  d7: retentionAt(7),
  sessionsPerDay: truth.sessions / activeDays,
  sessionMinutes: truth.sessionMs / truth.sessions / 60000,
  rewardedOptIn: truth.adOffers ? truth.adWatched / truth.adOffers : null,
  payerConversion: truth.payers.size / players.length,
  foreignHookRate: truth.runsWithForeign / truth.runs,
  shareRate: truth.shares / truth.deaths,
  replyRate: truth.opens ? truth.replies / truth.opens : null,
};

// ── 5. Прогін справжнього сервера ─────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'pav-rehearse-'));
writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + '\n', 'utf8');

const port = 9600 + Math.floor(Math.random() * 300);
const B = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, [SERVER], {
  env: { ...process.env, DATA_DIR: dir, PORT: String(port), DEV_ALLOW_UNSIGNED: '' },
  stdio: 'ignore',
});

const wait = async (): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${B}/health`)).ok) return; } catch { /* піднімається */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('сервер не піднявся');
};

const pct = (v: number | null) => v === null ? '—' : (v * 100).toFixed(1) + ' %';
const num = (v: number | null) => v === null ? '—' : v.toFixed(3);

let bad = 0;
const same = (name: string, got: number | null, want: number | null, fmt = pct): void => {
  const ok = got === null && want === null
    ? true
    : got !== null && want !== null && Math.abs(got - want) < 1e-9;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'РОЗБІЖНІСТЬ'} ${name.padEnd(24)} у журналі ${fmt(want).padStart(9)}   сервер ${fmt(got).padStart(9)}`);
};

try {
  await wait();
  const health = await (await fetch(`${B}/health`)).json() as Record<string, number | string>;
  const m = await (await fetch(`${B}/api/metrics`)).json() as Record<string, any>;
  const g3 = m.gate3, g4 = m.gate4;

  console.log('\nРЕПЕТИЦІЯ СОФТЛОНЧУ — числа синтетичні, про гру не кажуть нічого');
  console.log(`  гравців ${PLAYERS}, днів ${DAYS}, записів у журналі ${lines.length}`);
  console.log(`  сервер відновив: гравців ${health.users}, подій ${health.events}, ранів ${health.runs}\n`);

  console.log('чи бачить сервер те саме, що лежить у журналі:');
  same('гравців', g4.users, expected.users, String);
  same('когорта D1', g4.cohortD1, expected.d1.cohort, String);
  same('когорта D7', g4.cohortD7, expected.d7.cohort, String);
  same('D1 retention', g4.d1, expected.d1.rate);
  same('D7 retention', g4.d7, expected.d7.rate);
  same('сесій на день', g4.sessionsPerDay, expected.sessionsPerDay, num);
  same('довжина сесії, хв', g4.sessionMinutes, expected.sessionMinutes, num);
  same('rewarded opt-in', g4.rewardedOptIn, expected.rewardedOptIn);
  same('payer conversion', g4.payerConversion, expected.payerConversion);
  same('ghost-hook rate', g3.foreignHookRate, expected.foreignHookRate);
  same('share rate', g3.shareRate, expected.shareRate);
  same('reply rate', g3.replyRate, expected.replyRate);

  console.log('\nяк це виглядало б у гейтах (нагадування: дані вигадані):');
  const row = (n: string, v: string, verdict: string) =>
    console.log(`  ${n.padEnd(24)} ${v.padStart(9)}   ${verdict}`);
  row('D1', pct(g4.d1), g4.verdict.d1);
  row('D7', pct(g4.d7), g4.verdict.d7);
  row('сесій на день', num(g4.sessionsPerDay), g4.verdict.sessionsPerDay);
  row('довжина сесії, хв', num(g4.sessionMinutes), g4.verdict.sessionMinutes);
  row('rewarded opt-in', pct(g4.rewardedOptIn), g4.verdict.rewardedOptIn);
  row('payer conversion', pct(g4.payerConversion), g4.verdict.payerConversion);
  row('K-фактор', num(g3.kFactor), g3.verdict.kFactor);
  row('ghost-hook rate', pct(g3.foreignHookRate), g3.verdict.foreignHookRate);

  const cohorts = m.cohorts as { d7: number | null }[];
  const mature = cohorts.filter(c => c.d7 !== null).length;
  console.log(`\nкогорт усього ${cohorts.length}, з дозрілим D7 — ${mature}`);
  if (cohorts.length && mature === cohorts.length) {
    console.log('  ⚠️ дозріли ВСІ когорти: правило «ще рано» не перевірене цим прогоном');
    bad++;
  }

  console.log(bad === 0
    ? '\nREHEARSAL OK — сервер рахує рівно те, що лежить у журналі'
    : `\nREHEARSAL FAILED: розбіжностей ${bad}`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  console.error('репетиція впала:', (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}
