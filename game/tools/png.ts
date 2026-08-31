import { deflateSync, inflateSync } from 'node:zlib';

/**
 * PNG без залежностей: кодер і декодер 8-бітного RGBA.
 *
 * Навіщо своє. Пайплайн плану (розділ 9) закінчується пакуванням в атлас, і
 * єдине, що для цього треба вміти, — читати вихідні PNG і писати один
 * загальний. Тягнути заради цього sharp чи canvas означає нативний бінарник
 * у devDependencies і зламану збірку на чужій машині. zlib уже в Node, а
 * решта PNG — це заголовок і фільтри рядків.
 *
 * Підтримується рівно те, що видають генератори арту й редактори:
 * бітова глибина 8, без переплетення, типи кольору 0/2/4/6.
 * Палітрові (тип 3) і 16-бітні файли відхиляються з явною помилкою, а не
 * читаються навмання.
 */

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type Image = { width: number; height: number; rgba: Uint8Array };

// ── CRC32, таблиця за специфікацією PNG ────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// ── Кодування ──────────────────────────────────────────────────────────────

/** Абсолютна сума байтів рядка — евристика вибору фільтра зі специфікації. */
function score(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) s += row[i] < 128 ? row[i] : 256 - row[i];
  return s;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Кожен рядок пробується всіма п'ятьма фільтрами, береться найдешевший.
 * Це стандартна евристика; на градієнтах вона дає різницю в рази, а атлас
 * майже весь із градієнтів і плоских заливок.
 */
export function encodePng(img: Image): Uint8Array {
  const { width: w, height: h, rgba } = img;
  if (rgba.length !== w * h * 4) throw new Error('розмір буфера не збігається з w×h×4');

  const bpp = 4, stride = w * bpp;
  const raw = new Uint8Array((stride + 1) * h);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride),
                new Uint8Array(stride), new Uint8Array(stride)];

  for (let y = 0; y < h; y++) {
    const cur = rgba.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      cand[0][i] = cur[i];
      cand[1][i] = (cur[i] - a) & 0xff;
      cand[2][i] = (cur[i] - b) & 0xff;
      cand[3][i] = (cur[i] - ((a + b) >> 1)) & 0xff;
      cand[4][i] = (cur[i] - paeth(a, b, c)) & 0xff;
    }

    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const s = score(cand[f]);
      if (s < bestScore) { bestScore = s; best = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;    // бітова глибина
  ihdr[9] = 6;    // тип кольору: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // level 9 і фіксована стратегія — щоб два прогони давали побайтово однаковий
  // файл. Без цього неможливо перевірити детермінованість пайплайну.
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── Декодування ────────────────────────────────────────────────────────────

export function decodePng(buf: Uint8Array): Image {
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('це не PNG');

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat: Uint8Array[] = [];

  while (off < buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(off + 8);
      h = dv.getUint32(off + 12);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (depth !== 8) throw new Error(`підтримується лише 8 біт на канал, а тут ${depth}`);
  if (interlace !== 0) throw new Error('переплетені (Adam7) PNG не підтримуються');
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
  if (!channels) throw new Error(`тип кольору ${color} не підтримується (палітрові — конвертуйте в RGBA)`);

  const merged = new Uint8Array(idat.reduce((a, d) => a + d.length, 0));
  let m = 0;
  for (const d of idat) { merged.set(d, m); m += d.length; }
  const raw = new Uint8Array(inflateSync(merged));

  const bpp = channels, stride = w * bpp;
  const flat = new Uint8Array(stride * h);

  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = flat.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      out[i] = (filter === 0 ? x
        : filter === 1 ? x + a
        : filter === 2 ? x + b
        : filter === 3 ? x + ((a + b) >> 1)
        : x + paeth(a, b, c)) & 0xff;
    }
  }

  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const s = p * channels, d = p * 4;
    if (channels === 4) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = flat[s + 3];
    } else if (channels === 3) {
      rgba[d] = flat[s]; rgba[d + 1] = flat[s + 1]; rgba[d + 2] = flat[s + 2]; rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = flat[s + 1];
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = flat[s]; rgba[d + 3] = 255;
    }
  }

  return { width: w, height: h, rgba };
}
