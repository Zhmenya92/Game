import { Simulation } from '../src/sim/Simulation.ts';
import { InputTrace } from '../src/sim/InputTrace.ts';
import { playTrace } from '../src/sim/playback.ts';
import { selectTarget } from '../src/sim/Targeting.ts';
import { BALANCE } from '../src/config/balance.ts';
import { runAdaptivePlayer } from './capablePlayer.ts';

/**
 * Керування: інваріанти відчуття.
 *
 * НАВІЩО ЦЕЙ ФАЙЛ. Критика показала перекіс: 228 перевірок, і майже всі —
 * серверні. У фізики було десять, у **керування — жодної**. Тобто
 * найдорожче перевіреною була та частина, яку найлегше перевіряти, а не
 * та, від якої залежить, чи в гру приємно грати.
 *
 * ЧОГО ЦЕ НЕ ЗАМІНЮЄ. Жоден тест не скаже, чи приємно відпускати трос, —
 * це кола 3 і 4 плейтесту з `testing-plan.md`. Але «приємно» має
 * ПЕРЕДУМОВИ, і кожну з них можна записати як інваріант: трос не
 * розтягується, ціль не мерехтить, відпускання завжди щось дає, швидкість
 * не вибухає, мертвий гравець не рухається. Якщо хоч одна з них ламається,
 * ніякий плейтест уже не врятує.
 */

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('feel');

const SEEDS = 60;
const HORIZON = BALANCE.fairnessHorizonFrames;

// ── Нічого не стає NaN ────────────────────────────────────────────────────
//
// Найпідступніший клас помилок фізики: одне ділення на нуль — і гра
// «працює», але герой зникає з екрана назавжди. Без перевірки це видно
// лише на пристрої й лише випадково.

{
  let bad = '';
  for (let s = 1; s <= SEEDS && !bad; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      sim.step(r.trace.isDownAt(f));
      const st = sim.state;
      if (!Number.isFinite(st.px) || !Number.isFinite(st.py)
        || !Number.isFinite(st.vx) || !Number.isFinite(st.vy)
        || !Number.isFinite(st.ropeLen)) {
        bad = `сід ${s}, кадр ${f}`;
      }
    }
  }
  ok(`жодного NaN за ${SEEDS} сідів`, bad === '', bad);
}

// ── Трос не розтягується ──────────────────────────────────────────────────
//
// Фізика троса — позиційне обмеження: точку проєктують на коло радіуса
// ropeLen. Якщо обмеження не тримає, маятник «пливе», і це відчувається
// як гумовий трос ще до того, як гравець зрозуміє чому.

{
  let worst = 0, where = '';
  for (let s = 1; s <= SEEDS; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      sim.step(r.trace.isDownAt(f));
      const st = sim.state;
      if (!st.attached) continue;
      const d = Math.sqrt((st.px - st.ax) ** 2 + (st.py - st.ay) ** 2);
      const err = Math.abs(d - st.ropeLen);
      if (err > worst) { worst = err; where = `сід ${s}, кадр ${f}`; }
    }
  }
  ok(`відстань до анкера дорівнює довжині троса (найбільша похибка ${worst.toExponential(2)})`,
    worst < 1e-6, where);
}

// ── Довжина троса в оголошених межах ──────────────────────────────────────

{
  let bad = '';
  for (let s = 1; s <= SEEDS && !bad; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      sim.step(r.trace.isDownAt(f));
      const st = sim.state;
      if (!st.attached) continue;
      if (st.ropeLen < BALANCE.ropeMin - 1e-9 || st.ropeLen > BALANCE.ropeMax + 1e-9) {
        bad = `сід ${s}, кадр ${f}: ${st.ropeLen.toFixed(1)}`;
      }
    }
  }
  ok(`довжина троса завжди в [${BALANCE.ropeMin}, ${BALANCE.ropeMax}]`, bad === '', bad);
}

// ── Швидкість не вибухає ──────────────────────────────────────────────────

{
  let maxSpeed = 0, where = '';
  for (let s = 1; s <= SEEDS; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      sim.step(r.trace.isDownAt(f));
      const sp = Math.sqrt(sim.state.vx ** 2 + sim.state.vy ** 2);
      if (sp > maxSpeed) { maxSpeed = sp; where = `сід ${s}, кадр ${f}`; }
    }
  }
  // Стеля стоїть в інтегруванні (дефект 30: розгін до 1522 од/с робив гру
  // нечитабельною). Невеликий допуск — на гравітацію в кадрі після стелі.
  ok(`швидкість не перевищує стелю ${BALANCE.maxSpeed} (пік ${maxSpeed.toFixed(0)})`,
    maxSpeed <= BALANCE.maxSpeed * 1.05, where);
}

// ── Відпускання завжди щось дає ───────────────────────────────────────────
//
// Поштовх на зриві — це дефект 29: без нього гравець просідав щозамах і
// гра відчувалася як падіння, а не політ. Інваріант простий: після зриву
// швидкість не менша, ніж до нього.

{
  let releases = 0, weak = 0;
  for (let s = 1; s <= 25; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    let prevAttached = false, before = 0;
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      const st = sim.state;
      if (st.attached) before = Math.sqrt(st.vx ** 2 + st.vy ** 2);
      prevAttached = st.attached;
      sim.step(r.trace.isDownAt(f));
      if (prevAttached && !st.attached) {
        releases++;
        const after = Math.sqrt(st.vx ** 2 + st.vy ** 2);
        // Кадр після зриву вже включає гравітацію, тому допуск.
        if (after < before * 0.98) weak++;
      }
    }
  }
  ok(`зривів ${releases}, і жоден не сповільнив гравця`, releases > 100 && weak === 0,
    `слабких ${weak}`);
}

// ── Ціль не мерехтить ─────────────────────────────────────────────────────
//
// Якщо підсвічена ціль стрибає між двома анкерами щокадру, гравець не може
// прицілитись, і провина відчувається як «гра не слухається». Перевіряємо
// частоту перемикань, поки гравець у польоті.

{
  let worst = 0, where = '';
  for (let s = 1; s <= 25; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    let prev = '';
    let switches = 0, airborne = 0;
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      sim.step(r.trace.isDownAt(f));
      const st = sim.state;
      if (st.attached) { prev = ''; continue; }
      airborne++;
      const t = selectTarget(st.px, st.py, sim.track.candidates(st.px), sim.ownWeb);
      const key = t ? `${t.kind}:${t.x}:${t.y}` : '';
      if (prev && key && key !== prev) switches++;
      prev = key;
    }
    // Перемикань на секунду польоту.
    const rate = airborne > 0 ? (switches * 120) / airborne : 0;
    if (rate > worst) { worst = rate; where = `сід ${s}`; }
  }
  ok(`ціль перемикається рідше ніж 6 разів на секунду польоту (пік ${worst.toFixed(1)})`,
    worst < 6, where);
}

// ── Виміри, а не вироки ───────────────────────────────────────────────────
//
// Ці два числа нічого не «проходять» і не «валять». Вони друкуються, бо
// їх ніхто ніколи не міряв, і вони кажуть про відчуття гри більше, ніж
// решта файлу. Пороги тут навмисно широкі: вони ловлять обвал, а не
// оцінюють дизайн. Оцінка — це плейтест, кола 3 і 4 з `testing-plan.md`.

{
  let total = 0, attachedF = 0, air = 0, withTarget = 0;
  for (let s = 1; s <= 25; s++) {
    const r = runAdaptivePlayer(s, HORIZON);
    const sim = new Simulation(s, []);
    for (let f = 0; f < r.frames && sim.state.alive; f++) {
      sim.step(r.trace.isDownAt(f));
      const st = sim.state;
      total++;
      if (st.attached) { attachedF++; continue; }
      air++;
      if (selectTarget(st.px, st.py, sim.track.candidates(st.px), sim.ownWeb)) withTarget++;
    }
  }
  const airShare = air / total;
  const aimShare = air > 0 ? withTarget / air : 0;

  console.log(`  —    на тросі ${(attachedF / total * 100).toFixed(1)} %, у польоті ${(airShare * 100).toFixed(1)} %`);
  console.log(`  —    з видимою ціллю: ${(aimShare * 100).toFixed(1)} % польотних кадрів`);
  console.log('       обидва числа — для плейтесту, а не для гейта:');
  console.log('       бот тримає трос довше за людину, і саме людина скаже,');
  console.log('       чи це «політ», чи «висіння».');

  ok('гравець узагалі буває в польоті (обвал ловиться, дизайн — ні)',
    airShare > 0.02, (airShare * 100).toFixed(2) + ' %');
  ok('ціль у польоті хоч іноді є', aimShare > 0.05, (aimShare * 100).toFixed(1) + ' %');
}

// ── Мертвий гравець не рухається ──────────────────────────────────────────

{
  const sim = new Simulation(3, []);
  for (let f = 0; f < 4000 && sim.state.alive; f++) sim.step(false);
  ok('гравець таки загинув', !sim.state.alive);
  const before = { ...sim.state };
  for (let f = 0; f < 100; f++) sim.step(true);
  ok('після смерті крок нічого не змінює',
    sim.state.px === before.px && sim.state.py === before.py
    && sim.state.frame === before.frame && sim.state.score === before.score);
}

// ── Гра починається швидко ────────────────────────────────────────────────
//
// Перше зачеплення — це момент, коли гравець розуміє, що керує. Якщо воно
// настає пізно, перші секунди читаються як «нічого не працює».

{
  let worst = 0, where = '';
  for (let s = 1; s <= SEEDS; s++) {
    const sim = new Simulation(s, []);
    let f = 0;
    for (; f < 600 && sim.state.alive && !sim.state.attached; f++) sim.step(true);
    if (!sim.state.attached) { worst = 9999; where = `сід ${s}: не зачепився взагалі`; break; }
    if (f > worst) { worst = f; where = `сід ${s}`; }
  }
  ok(`з утриманням кнопки перше зачеплення настає за ${(worst / 120).toFixed(2)} с`,
    worst < 120, where);
}

// ── Буфер вводу справді рятує ранній тап ─────────────────────────────────
//
// Дефект 17: у брифі тап без цілі не робив нічого, і всі 1000 сідів гинули
// за 1.05 с. Буфер існує саме для цього випадку.

{
  const withBuffer = new Simulation(11, []);
  const t = new InputTrace();
  t.record(0, 'down');
  t.record(1, 'up');            // короткий тап на самому початку
  let attached = false;
  for (let f = 0; f < BALANCE.inputBufferFrames + 40 && withBuffer.state.alive; f++) {
    withBuffer.step(t.isDownAt(f));
    if (withBuffer.state.attached) { attached = true; break; }
  }
  ok(`буфер ${BALANCE.inputBufferFrames} кадрів ловить ранній тап`, attached);
}

// ── Утримання не блокує відпускання ───────────────────────────────────────
//
// Дефект 24: буфер озброювався на ВІДПУСКАННІ, тож гравець автоматично
// перечіплювався і висів на одному тросі 460 кадрів.

{
  const sim = new Simulation(5, []);
  const t = new InputTrace();
  t.record(0, 'down');
  t.record(400, 'up');
  let maxHold = 0, hold = 0;
  for (let f = 0; f < 1200 && sim.state.alive; f++) {
    sim.step(t.isDownAt(f));
    if (sim.state.attached) { hold++; if (hold > maxHold) maxHold = hold; }
    else hold = 0;
  }
  ok('після відпускання гравець справді зривається', !sim.state.attached || maxHold < 460,
    `найдовше утримання ${maxHold} кадрів`);
}

// ── Реплей чутливий до одного кадру ──────────────────────────────────────
//
// Якщо зсув вводу на один кадр нічого не міняє, то або симуляція не
// детермінована, або ввід ні на що не впливає. Обидва варіанти погані.

{
  const r = runAdaptivePlayer(42, HORIZON);
  const a = new Simulation(42, []);
  playTrace(a, r.trace, r.frames);

  const shifted = new InputTrace();
  for (const e of r.trace.events) shifted.record(e.frame + 1, e.type);
  const b = new Simulation(42, []);
  playTrace(b, shifted, r.frames + 2);

  ok('зсув вводу на один кадр змінює результат',
    a.state.score !== b.state.score || a.state.frame !== b.state.frame,
    `${a.state.score}/${a.state.frame} проти ${b.state.score}/${b.state.frame}`);
}

console.log(fail === 0 ? '\nFEEL OK' : `\nFEEL FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
