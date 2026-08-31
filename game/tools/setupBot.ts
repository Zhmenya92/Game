/**
 * Одноразове налаштування бота перед софтлончем.
 *
 * Це те, що не можна зробити за власника: потрібен його токен від
 * BotFather. Але можна зробити так, щоб це зайняло одну команду замість
 * години читання документації й трьох забутих кроків.
 *
 * ⚠️ Проти живого Telegram цей скрипт не запускався жодного разу — токена
 * немає. Форми запитів узяті з Bot API; кожен виклик друкує, що саме він
 * зробив, тож розбіжність буде видно з першого прогону, а не через тиждень
 * мовчазних невдач.
 *
 * Запуск:
 *   BOT_TOKEN=... PUBLIC_URL=https://ваш-домен TELEGRAM_WEBHOOK_SECRET=... \
 *     node tools/setupBot.ts
 *
 * Лише перевірити, нічого не міняючи:
 *   BOT_TOKEN=... node tools/setupBot.ts --check
 */

export {};   // робить файл модулем: без цього TypeScript не дозволяє await на верхньому рівні

const token = process.env.BOT_TOKEN ?? '';
const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const gameUrl = process.env.GAME_URL ?? publicUrl;
const checkOnly = process.argv.includes('--check');

const hasToken = token.length > 0;
if (!hasToken) {
  console.error('немає BOT_TOKEN. Візьміть його у @BotFather і передайте змінною оточення.');
  process.exitCode = 1;
}

async function call<T>(method: string, body?: unknown): Promise<T> {
  const api = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  const res = await fetch(`${api}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const j = await res.json() as { ok: boolean; result?: T; description?: string };
  if (!j.ok) throw new Error(`${method}: ${j.description ?? 'відмова Telegram'}`);
  return j.result as T;
}

const say = (s: string) => console.log(s);

// Без токена далі йти нікуди: раніше тут стояв process.exit(), і після
// переходу на exitCode скрипт продовжував працювати й друкував зайву
// мережеву помилку поверх зрозумілої.
if (hasToken) try {
  const me = await call<{ username: string; id: number; can_join_groups?: boolean }>('getMe');
  say(`бот: @${me.username} (id ${me.id})`);

  // Далі — через прапорці, а не через process.exit(). Вихід посеред живого
  // зʼєднання ронить Node з кодом 0xC0000409 на Windows: саме так упав
  // режим --check, і саме цю помилку вже ловили раніше в цьому проєкті.
  let done = false;

  if (checkOnly) {
    const info = await call<{
      url: string; pending_update_count: number; last_error_message?: string;
    }>('getWebhookInfo');
    say(`вебхук: ${info.url || 'не встановлений'}`);
    say(`  черга оновлень: ${info.pending_update_count}`);
    if (info.last_error_message) say(`  ⚠️ остання помилка: ${info.last_error_message}`);
    done = true;
  }

  if (!done && !publicUrl) {
    console.error('немає PUBLIC_URL — адреси, за якою Telegram дістане бекенд (https, не localhost).');
    process.exitCode = 1;
    done = true;
  }
  if (!done && secret.length < 16) {
    console.error('TELEGRAM_WEBHOOK_SECRET має бути щонайменше 16 символів: ' +
      'без нього вебхук приймає що завгодно від кого завгодно.');
    process.exitCode = 1;
    done = true;
  }

  if (!done) {
  // 1. Команди. /paysupport обовʼязковий за правилами Telegram для Stars.
  await call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Грати' },
      { command: 'paysupport', description: 'Питання щодо оплати' },
    ],
  });
  say('команди встановлено: /start, /paysupport');

  // 2. Кнопка меню — вхід у гру просто з чату з ботом.
  await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Грати', web_app: { url: gameUrl } },
  });
  say(`кнопка меню веде на ${gameUrl}`);

  // 3. Вебхук. allowed_updates звужено навмисно: усе інше нам не потрібне,
  //    а зайві оновлення — це зайвий трафік і зайва поверхня.
  const hook = `${publicUrl}/api/telegram/webhook`;
  await call('setWebhook', {
    url: hook,
    secret_token: secret,
    allowed_updates: ['message', 'pre_checkout_query'],
    drop_pending_updates: true,
  });
  say(`вебхук: ${hook}`);

  const info = await call<{ url: string; pending_update_count: number }>('getWebhookInfo');
  say(`перевірка: ${info.url === hook ? 'збігається' : '⚠️ НЕ ЗБІГАЄТЬСЯ — ' + info.url}`);

  say('');
  say('Далі покласти в оточення сервера:');
  say(`  BOT_TOKEN=<той самий>`);
  say(`  BOT_NAME=${me.username}`);
  say(`  APP_NAME=<коротке імʼя Mini App із BotFather>`);
  say(`  TELEGRAM_WEBHOOK_SECRET=<той самий секрет>`);
  say(`  DATA_DIR=<тека для журналу, інакше дані не переживуть перезапуск>`);
  say('');
  say('І прибрати DEV_ALLOW_UNSIGNED: із живим токеном він більше не потрібен,');
  say('а лишившись, він дозволяє будь-кому вигадати собі initData.');
  }
} catch (e) {
  console.error('помилка:', (e as Error).message);
  process.exitCode = 1;
}
