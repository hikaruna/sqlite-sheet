// BLOB の中身の種類を見分ける（先頭のバイト＝マジックナンバーで判定）

const startsWith = (b, sig, at = 0) => b.length >= at + sig.length && sig.every((x, i) => x === null || b[at + i] === x);
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

/** @typedef {{ mime: string, ext: string, label: string, image: boolean, text?: boolean }} Kind */

const K = (mime, ext, label, image = false) => ({ mime, ext, label, image });

const SIGS = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], K('image/png', 'png', 'PNG', true)],
  [[0xff, 0xd8, 0xff], K('image/jpeg', 'jpg', 'JPEG', true)],
  [[0x47, 0x49, 0x46, 0x38], K('image/gif', 'gif', 'GIF', true)],
  [[0x42, 0x4d], K('image/bmp', 'bmp', 'BMP', true)],
  [[0x00, 0x00, 0x01, 0x00], K('image/x-icon', 'ico', 'ICO', true)],
  [[0x25, 0x50, 0x44, 0x46, 0x2d], K('application/pdf', 'pdf', 'PDF')],
  [[0x50, 0x4b, 0x03, 0x04], K('application/zip', 'zip', 'ZIP')],
  [[0x1f, 0x8b], K('application/gzip', 'gz', 'gzip')],
  [[0x49, 0x44, 0x33], K('audio/mpeg', 'mp3', 'MP3')],
];

const BIN = K('application/octet-stream', 'bin', 'バイナリ');
const cache = new WeakMap();

/** @param {Uint8Array} b @returns {Kind} */
export function sniff(b) {
  let k = cache.get(b);
  if (!k) { k = detect(b); cache.set(b, k); }
  return k;
}

function detect(b) {
  for (const [sig, kind] of SIGS) if (startsWith(b, sig)) return kind;
  if (b.length >= 16 && ascii(b, 0, 15) === 'SQLite format 3') return K('application/vnd.sqlite3', 'sqlite', 'SQLite');
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF') {
    const t = ascii(b, 8, 4);
    if (t === 'WEBP') return K('image/webp', 'webp', 'WebP', true);
    if (t === 'WAVE') return K('audio/wav', 'wav', 'WAV');
  }
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return K('image/avif', 'avif', 'AVIF', true);
    return K('video/mp4', 'mp4', 'MP4');
  }
  const text = asText(b);
  if (text != null) {
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return K('image/svg+xml', 'svg', 'SVG', true);
    return { ...K('text/plain', 'txt', 'テキスト'), text: true };
  }
  return BIN;
}

/** UTF-8 として読めて制御文字（タブ・改行以外）がなければ文字列を返す */
export function asText(b, max = 65536) {
  if (b.length === 0) return null;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(b.length > max ? b.subarray(0, max) : b);
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) ? null : s;
  } catch (e) {
    // 途中で切ったせいで末尾の文字が壊れた場合は、少し手前で切り直す
    if (b.length > max) return asText(b.subarray(0, max - 4), max);
    return null;
  }
}
