import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, createInvoiceLink, answerPreCheckout, refundStarPayment, sendMessage } from '../server/stars.ts';

/**
 * Наша половина протоколу Telegram.
 *
 * ЩО ЦЕ ПЕРЕВІРЯЄ. Критика вказала: код оплат і скрипт налаштування бота
 * **не запускалися жодного разу** — токена немає, тож день софтлончу
 * почався б із коду, який ніколи не працював. Повністю це не лікується,
 * але половина лікується: можна підняти ЗАГЛУШКУ на місці api.telegram.org
 * і подивитися, які саме методи й параметри ми надсилаємо.
 *
 * ЧОГО ЦЕ НЕ ДОВОДИТЬ. Що Telegram їх прийме. Форми взяті з Bot API, і
 * підтвердити їх може тільки живий бот. Але «ми надсилаємо
 * `currency: XTR` без провайдерського токена» і «вебхук ставиться з
 * секретом і звуженим allowed_updates» — це вже перевірено, а не обіцяно.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', 'tools', 'setupBot.ts');

let fail = 0;
const ok = (n: string, c: boolean, d = ''): void => {
  console.log(c ? `  ok   ${n}` : `  FAIL ${n} ${d}`);
  if (!c) fail++;
};

console.log('telegram');

type Call = { method: string; body: Record<string, unknown> };

/** Заглушка Telegram: записує виклики й відповідає правдоподібно. */
async function withStub<T>(
  fn: (base: string, calls: Call[]) => Promise<T>,
  reply: (method: string) => unknown = () => true,
): Promise<T> {
  const calls: Call[] = [];
  const srv = createServer(async (req, res) => {
    const method = (req.url ?? '').split('/').pop() ?? '';
    const body = await readJson(req);
    calls.push({ method, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: reply(method) }));
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise<void>(r => srv.close(() => r()));
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// ── Оплати: що саме ми надсилаємо ─────────────────────────────────────────

await withStub(async (base, calls) => {
  process.env.TELEGRAM_API = base;
  const stars = await import(`../server/stars.ts?stub=${Date.now()}`) as typeof import('../server/stars.ts');

  const product = CATALOG[0];
  await stars.createInvoiceLink('123:token', product, 'revive3:42:n1');
  const inv = calls.find(c => c.method === 'createInvoiceLink');
  ok('інвойс іде методом createInvoiceLink', !!inv);
  ok('валюта XTR — це і є Stars', inv?.body.currency === 'XTR', String(inv?.body.currency));
  ok('провайдерський токен порожній: для Stars він не потрібен',
    inv?.body.provider_token === '', JSON.stringify(inv?.body.provider_token));
  const prices = inv?.body.prices as { amount: number }[] | undefined;
  ok('ціна в Stars збігається з каталогом',
    prices?.[0]?.amount === product.stars, JSON.stringify(prices));
  ok('payload їде з нами й повернеться в successful_payment',
    inv?.body.payload === 'revive3:42:n1', String(inv?.body.payload));

  await stars.answerPreCheckout('123:token', 'q1', true);
  const good = calls.find(c => c.method === 'answerPreCheckoutQuery');
  ok('передперевірка відповідає ok:true без тексту помилки',
    good?.body.ok === true && !('error_message' in (good?.body ?? {})));

  await stars.answerPreCheckout('123:token', 'q2', false, 'нема такого');
  const bad = calls.filter(c => c.method === 'answerPreCheckoutQuery')[1];
  ok('відмова передперевірки несе причину', bad?.body.ok === false && !!bad?.body.error_message);

  await stars.refundStarPayment('123:token', 42, 'charge-1');
  const ref = calls.find(c => c.method === 'refundStarPayment');
  ok('повернення шле user_id і charge_id',
    ref?.body.user_id === 42 && ref?.body.telegram_payment_charge_id === 'charge-1');

  await stars.sendMessage('123:token', 42, 'привіт');
  ok('повідомлення шле chat_id і текст',
    calls.some(c => c.method === 'sendMessage' && c.body.chat_id === 42));
  return null;
});
delete process.env.TELEGRAM_API;

// Без токена все це має тихо відмовлятись, а не падати з мережевою помилкою.
{
  let threw: unknown = null;
  try { await createInvoiceLink('', CATALOG[0], 'x'); } catch (e) { threw = e; }
  ok('без токена — зрозуміла відмова, а не мережева помилка',
    threw instanceof Error && threw.message.includes('BOT_TOKEN'), String(threw));
  void answerPreCheckout; void refundStarPayment; void sendMessage;
}

// ── Скрипт налаштування бота ──────────────────────────────────────────────

await withStub(async (base, calls) => {
  const env = {
    ...process.env,
    TELEGRAM_API: base,
    BOT_TOKEN: '123:token',
    PUBLIC_URL: 'https://example.test/',
    GAME_URL: 'https://example.test/play',
    TELEGRAM_WEBHOOK_SECRET: 'секрет-достатньої-довжини',
  };
  const code = await run(env, []);
  ok('скрипт налаштування завершується успішно', code === 0, String(code));

  const names = calls.map(c => c.method);
  ok('питає, хто ми', names.includes('getMe'));
  ok('ставить команди', names.includes('setMyCommands'));
  ok('ставить кнопку меню', names.includes('setChatMenuButton'));
  ok('ставить вебхук', names.includes('setWebhook'));
  ok('і перевіряє, що поставив', names.includes('getWebhookInfo'));

  const cmds = calls.find(c => c.method === 'setMyCommands')?.body.commands as { command: string }[];
  ok('серед команд є обовʼязковий /paysupport',
    cmds?.some(c => c.command === 'paysupport'), JSON.stringify(cmds));

  const hook = calls.find(c => c.method === 'setWebhook')?.body;
  ok('вебхук веде на наш ендпоінт без подвійного слеша',
    hook?.url === 'https://example.test/api/telegram/webhook', String(hook?.url));
  ok('вебхук іде з секретом', hook?.secret_token === 'секрет-достатньої-довжини');
  ok('оновлення звужені до потрібних',
    JSON.stringify(hook?.allowed_updates) === '["message","pre_checkout_query"]',
    JSON.stringify(hook?.allowed_updates));

  const menu = calls.find(c => c.method === 'setChatMenuButton')?.body.menu_button as
    { type: string; web_app?: { url: string } } | undefined;
  ok('кнопка меню відкриває гру', menu?.type === 'web_app' && menu.web_app?.url === 'https://example.test/play',
    JSON.stringify(menu));
  return null;
}, method => method === 'getMe' ? { username: 'pavutyna_bot', id: 7 }
  : method === 'getWebhookInfo' ? { url: 'https://example.test/api/telegram/webhook', pending_update_count: 0 }
  : true);

// Короткий секрет має зупиняти налаштування, а не ставити діряний вебхук.
await withStub(async (base, calls) => {
  const code = await run({
    ...process.env, TELEGRAM_API: base, BOT_TOKEN: '123:token',
    PUBLIC_URL: 'https://example.test', TELEGRAM_WEBHOOK_SECRET: 'коротко',
  }, []);
  ok('короткий секрет зупиняє налаштування', code !== 0, String(code));
  ok('і вебхук при цьому НЕ ставиться', !calls.some(c => c.method === 'setWebhook'));
  return null;
}, () => ({ username: 'pavutyna_bot', id: 7 }));

// Режим --check нічого не міняє.
await withStub(async (base, calls) => {
  const code = await run({ ...process.env, TELEGRAM_API: base, BOT_TOKEN: '123:token' }, ['--check']);
  ok('--check завершується успішно', code === 0, String(code));
  ok('--check лише читає', !calls.some(c =>
    c.method === 'setWebhook' || c.method === 'setMyCommands' || c.method === 'setChatMenuButton'));
  return null;
}, method => method === 'getMe' ? { username: 'pavutyna_bot', id: 7 }
  : { url: '', pending_update_count: 0 });

function run(env: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [SETUP, ...args], { env, stdio: 'ignore' });
    p.on('exit', c => resolve(c ?? -1));
  });
}

console.log(fail === 0 ? '\nTELEGRAM OK' : `\nTELEGRAM FAILED: ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
