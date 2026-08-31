import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

/**
 * Локальний перегляд дашборда.
 *
 * Файл читається з диска на КОЖЕН запит — інакше після правки сторінка
 * віддає стару версію, і здається, що зміни не застосувалися.
 */

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/') path = '/dashboard.html';
  const file = join(root, normalize(path).replace(/^([/\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403).end('ні'); return; }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, {
      'content-type': types[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('немає такого файлу: ' + path);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`дашборд: http://127.0.0.1:${PORT}/`);
});
