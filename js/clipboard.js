// クリップボードの形式：TSV（text/plain）と HTML の表（text/html）
// このアプリ同士では HTML の data 属性から型・NULL・BLOB まで元どおりに戻し、Excel・メモ帳などには TSV と表で渡す
import { sniff } from './blob.js';
import { affinity } from './schema.js';
import { convertInput } from './sources.js';

/** HTML に埋め込む BLOB の合計バイト数の上限（base64 でクリップボードが重くなりすぎないように） */
export const BLOB_LIMIT = 16 * 1024 * 1024;

const isBlob = (v) => v instanceof Uint8Array;

// ---------- TSV ----------

function tsvCell(v) {
  if (v == null || isBlob(v)) return ''; // NULL も BLOB も空（BLOB は文字にできない）
  const s = String(v);
  return /[\t\n"]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/** 値の行×列 → TSV（Excel と同じく、タブ・改行・" を含む値は "…" で囲む） */
export const toTsv = (values) => values.map((row) => row.map(tsvCell).join('\t')).join('\n');

/** TSV → 文字の行×列 */
export function parseTsv(text) {
  if (text.endsWith('\n')) text = text.replace(/\r?\n$/, '');
  const rows = []; let row = []; let cell = ''; let i = 0; let quoted = false;
  text = text.replace(/\r\n/g, '\n');
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell); rows.push(row);
  return rows;
}

// ---------- HTML の表 ----------

const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromBase64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** セルの型の名前（数は整数かどうかで分ける。DB から返る値では 2.0 と 2 を見分けられない） */
function typeOf(v) {
  if (v === null) return 'null';
  if (isBlob(v)) return 'blob';
  if (typeof v === 'bigint' || Number.isInteger(v)) return 'integer';
  return typeof v === 'number' ? 'real' : 'text';
}

/**
 * セルの HTML。画像の BLOB は <img>（元の形式のまま）、それ以外の BLOB は data-blob に base64。
 * 上限を超えたときは中身を入れず data-omitted だけ付ける
 */
function toTd(v, embed) {
  const type = typeOf(v);
  let attr = '', body = '';
  if (type === 'blob') {
    const kind = sniff(v);
    if (!embed) attr = ' data-omitted';
    else if (kind.image) body = `<img src="data:${kind.mime};base64,${toBase64(v)}">`;
    else attr = ` data-blob="${toBase64(v)}"`;
  } else if (type !== 'null') body = esc(String(v)).replaceAll('\n', '<br>');
  return `<td data-type="${type}"${attr}>${body}</td>`;
}

/** 値の行×列 → クリップボードに載せる文字列。omitted は、大きすぎて BLOB の中身を入れなかったとき真 */
export function toClipboard(values) {
  const bytes = values.flat().reduce((n, v) => n + (isBlob(v) ? v.length : 0), 0);
  const embed = bytes <= BLOB_LIMIT;
  const rows = values.map((row) => `<tr>${row.map((v) => toTd(v, embed)).join('')}</tr>`).join('');
  return { text: toTsv(values), html: `<table data-sqlite-sheet="1">${rows}</table>`, omitted: !embed };
}

/** <img> の data URL → バイト列（data URL でなければ undefined） */
function imageOf(td) {
  const m = td.querySelector('img')?.getAttribute('src')?.match(/^data:[^;,]*;base64,(.*)$/s);
  try { return m ? fromBase64(m[1]) : undefined; } catch { return undefined; }
}

const textOf = (td) => [...td.childNodes].map((n) => (n.nodeName === 'BR' ? '\n' : n.textContent)).join('');

/** このアプリが書いたセルを、元の値に戻す。undefined は、大きすぎて運べなかった BLOB */
function ownValue(td) {
  const text = textOf(td);
  switch (td.dataset.type) {
    case 'null': return null;
    case 'integer': { const n = Number(text); return Number.isSafeInteger(n) ? n : BigInt(text); }
    case 'real': return Number(text);
    case 'blob': return td.hasAttribute('data-blob') ? fromBase64(td.dataset.blob) : imageOf(td);
    default: return text;
  }
}

/**
 * HTML の表を読む。表がなければ null。
 * このアプリが書いた表（own）なら、行×列の元の値。ほかのアプリの表なら、<img> の画像だけ（ほかは undefined）
 */
export function fromHtml(html) {
  const table = html && new DOMParser().parseFromString(html, 'text/html').querySelector('table');
  if (!table) return null;
  const own = table.hasAttribute('data-sqlite-sheet');
  return { own, cells: [...table.rows].map((row) => [...row.cells].map(own ? ownValue : imageOf)) };
}

// ---------- 列への合わせ込み ----------

/**
 * 貼る値を列の型に合わせる。入らない値は undefined。
 * STRICT でない列は何でも入る。STRICT の列だけ、入らないものがある（NULL・CHECK などの違反は DB に任せる）。
 * blankIsNull は、ほかのアプリの空欄（NULL と空文字の区別がない）を NULL にする。NOT NULL の列は空文字のまま
 */
export function fit(v, col, blankIsNull = false) {
  if (v === '' && blankIsNull && !col.notnull) return null;
  if (v == null || !col.strict) return v;
  const a = affinity(col.type);
  if (a === 'ANY') return v;
  if (a === 'BLOB') return isBlob(v) ? v : undefined;
  if (isBlob(v)) return undefined;
  if (a === 'TEXT') return v;
  if (v === '') return null; // 数値の列に空文字は入らないので NULL に
  const n = convertInput(v, col.type);
  const ok = typeof n === 'bigint' || (typeof n === 'number' && (a !== 'INTEGER' || Number.isInteger(n)));
  return ok ? n : undefined;
}
