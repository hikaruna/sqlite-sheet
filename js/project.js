// プロジェクト（DB と、その DB を見るための端末側の設定）をファイル（.sqlitesheet）と URL で表す。
// 仕様は docs/openapi.json（人が読むのは docs/project-format.md）。ここは仕様どおりに読み書きするだけで、画面は main.js。
//   ファイル：{ format, version, db | db_embed, sheets: [{ type, name, sql?, widths?, heights?, format? }] }
//   URL：同じキーをブラケット記法で（sheets[0][name]=…）。db_name はパス、db_embed は # の後ろ
import { t as tr } from './i18n.js';
import { CELL_FORMATS } from './grid.js';

export const FORMAT = 'sqlite-sheet';
export const VERSION = 1;
export const EXT = '.sqlitesheet';
export const PICKER_TYPES = [{ description: tr('SQLiteシートのプロジェクト'), accept: { 'application/json': [EXT] } }];

const TYPES = { table: 't', view: 'v', query: 'q' };
const TYPE_OF = { t: 'table', v: 'view', q: 'query' };
/** URL だけのキー（ファイルに書いてあれば無視して知らせる） */
const URL_ONLY = ['db_name', 'project', 'sheet', 'sort', 'filter', 'range'];

// ======================================================================
// ブラケット記法
// ======================================================================
/** キー「sheets[0][widths]["a[1]"]」→ ['sheets', 0, 'widths', 'a[1]']（書き方が違えば null） */
export function parseKey(k) {
  const i = k.indexOf('[');
  if (i === 0) return null;
  const path = [i < 0 ? k : k.slice(0, i)];
  let p = i < 0 ? k.length : i;
  while (p < k.length) {
    if (k[p] !== '[') return null;
    if (k[p + 1] === '"') {
      // JSON の文字列：閉じる " を探す（\" は飛ばす）
      let j = p + 2;
      while (j < k.length && k[j] !== '"') j += k[j] === '\\' ? 2 : 1;
      if (k[j + 1] !== ']') return null;
      try { path.push(JSON.parse(k.slice(p + 1, j + 1))); } catch { return null; }
      p = j + 2;
    } else {
      const j = k.indexOf(']', p);
      if (j < 0) return null;
      const seg = k.slice(p + 1, j);
      if (seg === '' || seg.includes('[')) return null;
      path.push(/^\d+$/.test(seg) ? Number(seg) : seg);
      p = j + 1;
    }
  }
  return path;
}

/** 値をそのまま（文字列で）書く所か。それ以外は JSON で書く */
function isStringPath(path) {
  if (path.length === 1) return ['format', 'db', 'db_embed', 'project'].includes(path[0]);
  return path.length === 3 && path[0] === 'sheets' && typeof path[1] === 'number' && ['type', 'name', 'sql'].includes(path[2]);
}

/**
 * [キー, 値] の並び（URLSearchParams など）から、names に入っているキーで始まるものを木に組み立てる。
 * 返り値 { value: { キー: 値 }, error }。番号は並び順に使うだけ（飛んでいてもよい）
 */
export function fromBrackets(entries, names) {
  const leaves = [];
  for (const [k, v] of entries) {
    const path = parseKey(k);
    if (!path || !names.includes(path[0])) continue;
    leaves.push([path, v]);
  }
  const seen = new Map();
  for (const [path] of leaves) {
    const s = JSON.stringify(path);
    if (seen.has(s)) return { error: tr('URL に「{0}」が2回書かれています', [keyOf(path)]) };
    seen.set(s, path);
  }
  // 同じ所を2通りに書いていないか（ある道筋が、別の道筋の途中になっている）
  for (const [path] of leaves) {
    for (let n = 1; n < path.length; n++) {
      if (seen.has(JSON.stringify(path.slice(0, n)))) return { error: tr('URL の「{0}」と「{1}」は同じ所を2通りに書いています', [keyOf(path.slice(0, n)), keyOf(path)]) };
    }
  }
  const root = {};
  for (const [path, raw] of leaves) {
    let v = raw;
    if (!isStringPath(path)) {
      try { v = JSON.parse(raw); } catch { return { error: tr('URL の「{0}」の値が JSON として読めません', [keyOf(path)]) }; }
    }
    let node = root;
    for (let n = 0; n < path.length - 1; n++) {
      const seg = path[n], next = path[n + 1];
      if (node[seg] == null) node[seg] = typeof next === 'number' ? { [ARR]: true } : {};
      node = node[seg];
      if (typeof node !== 'object' || Array.isArray(node)) return { error: tr('URL の「{0}」は同じ所を2通りに書いています', [keyOf(path)]) };
      if (typeof next === 'number' && !node[ARR]) return { error: tr('URL の「{0}」の番号の付け方が合いません', [keyOf(path)]) };
    }
    node[path[path.length - 1]] = v;
  }
  return { value: compact(root) };
}
const ARR = Symbol('array');
/** 番号で組み立てたものを配列に（番号の順に詰める） */
function compact(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  if (node[ARR]) return Object.keys(node).map(Number).sort((a, b) => a - b).map((i) => compact(node[i]));
  for (const k of Object.keys(node)) node[k] = compact(node[k]);
  return node;
}
function keyOf(path) {
  return path.map((s, i) => (i === 0 ? s : typeof s === 'number' ? `[${s}]` : /^\d+$|[[\]]/.test(s) ? `[${JSON.stringify(s)}]` : `[${s}]`)).join('');
}

/** sheets → URL の [キー, 値]。文字列はそのまま、widths などはまとめて JSON（短くなる） */
export function sheetsToParams(sheets) {
  const out = [];
  sheets.forEach((s, i) => {
    for (const k of ['type', 'name', 'sql', 'widths', 'heights', 'format']) {
      if (s[k] == null) continue;
      out.push([`sheets[${i}][${k}]`, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k])]);
    }
  });
  return out;
}

// ======================================================================
// 検査
// ======================================================================
const isRowKey = (v) => (Number.isInteger(v) && v >= 0)
  || (Array.isArray(v) && v.length > 0 && v.every((x) => x === null || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))));
const isPx = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * sheets を検査する。壊れた要素は捨て、同じ type・name は最初の1つだけ残す。
 * 返り値 { sheets, bad: 捨てた要素の数 }。中の壊れた値（無い列など）はここでは見ない
 */
export function cleanSheets(list) {
  if (list == null) return { sheets: [], bad: 0 };
  if (!Array.isArray(list)) return { sheets: [], bad: 1 };
  const out = [], seen = new Set();
  let bad = 0;
  for (const s of list) {
    if (!s || typeof s !== 'object' || !(s.type in TYPES) || typeof s.name !== 'string' || !s.name
      || (s.type === 'query' ? typeof s.sql !== 'string' || !s.sql.trim() : s.sql != null)) { bad++; continue; }
    const id = s.type + ':' + s.name;
    if (seen.has(id)) continue;
    seen.add(id);
    const x = { type: s.type, name: s.name };
    if (s.type === 'query') x.sql = s.sql;
    if (s.widths && typeof s.widths === 'object' && !Array.isArray(s.widths)) {
      const w = Object.fromEntries(Object.entries(s.widths).filter(([, v]) => isPx(v)));
      if (Object.keys(w).length) x.widths = w;
    }
    if (Array.isArray(s.heights)) {
      const h = s.heights.filter((p) => Array.isArray(p) && p.length === 2 && isRowKey(p[0]) && isPx(p[1]));
      if (h.length) x.heights = h;
    }
    if (s.format && typeof s.format === 'object' && !Array.isArray(s.format)) {
      const f = {};
      for (const [k, cells] of Object.entries(s.format)) {
        if (!(k in CELL_FORMATS) || !Array.isArray(cells)) continue;
        const c = cells.filter((p) => Array.isArray(p) && p.length === 2 && isRowKey(p[0]) && typeof p[1] === 'string');
        if (c.length) f[k] = c;
      }
      if (Object.keys(f).length) x.format = f;
    }
    out.push(x);
  }
  return { sheets: out, bad };
}

/**
 * .sqlitesheet の中身（文字列）を読む。返り値 { project: { db, db_embed, sheets }, warnings: [文] } か { error }。
 * db はまだ解決しない（相対パスの基準は呼ぶ側が決める）
 */
export function parseProjectFile(text) {
  let o;
  try { o = JSON.parse(text); } catch { return { error: tr('プロジェクトのファイルが JSON として読めません') }; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.format !== FORMAT) return { error: tr('SQLiteシートのプロジェクトのファイルではありません') };
  if (!Number.isInteger(o.version) || o.version < 1) return { error: tr('プロジェクトのファイルの version が正しくありません') };
  const hasDb = typeof o.db === 'string' && o.db !== '', hasEmbed = typeof o.db_embed === 'string' && o.db_embed !== '';
  if (hasDb === hasEmbed) return { error: tr('プロジェクトのファイルには、db か db_embed のどちらか一方を書きます') };
  const warnings = [];
  if (o.version > VERSION) warnings.push(tr('新しい版（{0}）のプロジェクトです。一部の設定が反映されないかもしれません', [o.version]));
  const extra = URL_ONLY.filter((k) => k in o);
  if (extra.length) warnings.push(tr('ファイルには書けないキーを無視しました：{0}', [extra.join(', ')]));
  const { sheets, bad } = cleanSheets(o.sheets);
  if (bad) warnings.push(tr('壊れたシートの設定を {0} 個無視しました', [bad]));
  return { project: { db: hasDb ? o.db : null, db_embed: hasEmbed ? o.db_embed : null, sheets }, warnings };
}

/** 中身が .sqlitesheet らしいか（先頭が { で format が合う）。バイト列で見る */
export function looksLikeProject(bytes) {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3; // BOM
  while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i])) i++;
  return bytes[i] === 0x7b && new TextDecoder().decode(bytes.slice(0, 4096)).includes(FORMAT);
}

// ======================================================================
// URL を読む
// ======================================================================
/**
 * アプリの URL を読む。base はアプリの場所のパス。
 * 返り値 { dbName, db, embed, project, sheets, sheet, legacy, sig, keep, warnings, error }
 *   keep：開いた後も URL に残す [キー, 値]（sheets などのプロジェクトのキー）
 *   sig：同じものを開いているかの見分け（DB の指し方とプロジェクトのキー）
 */
export function parseLink(u, base) {
  const path = u.pathname.startsWith(base) ? u.pathname.slice(base.length) : '';
  let dbName = null;
  try { dbName = decodeURIComponent(path.split('/')[0]) || null; } catch { /* 壊れたエンコードは無視 */ }
  const p = new URLSearchParams(u.search);
  const h = new URLSearchParams(!u.hash || u.hash.startsWith('#/') ? '' : u.hash.slice(1));
  const out = { dbName, db: null, embed: null, project: null, sheets: null, sheet: p.get('sheet'), legacy: false, keep: [], warnings: [], sig: null, error: null };
  const fail = (msg) => ({ ...out, error: msg });

  const tree = fromBrackets(p.entries(), ['format', 'version', 'db', 'project', 'sheets']);
  if (tree.error) return fail(tree.error);
  const v = tree.value;
  if (h.getAll('db_embed').length > 1 || h.getAll('data').length > 1) return fail(tr('URL に「{0}」が2回書かれています', ['db_embed']));
  if (v.format != null && v.format !== FORMAT) return fail(tr('URL の format が「{0}」ではありません', [FORMAT]));
  if (v.version != null && (!Number.isInteger(v.version) || v.version < 1)) return fail(tr('URL の version が正しくありません'));
  if (v.version > VERSION) out.warnings.push(tr('新しい版（{0}）のリンクです。一部の設定が反映されないかもしれません', [v.version]));
  out.db = typeof v.db === 'string' && v.db ? v.db : null;
  out.project = typeof v.project === 'string' && v.project ? v.project : null;
  out.embed = h.get('db_embed') || null;

  // 以前の書き方：#data= と query1= / query1.name=（読み込みだけ。新しい書き方と混ぜたらエラー）
  const legacyData = h.get('data');
  const nums = [...new Set([...p.keys()].map((k) => k.match(/^query(\d+)(\.name)?$/)?.[1]).filter(Boolean))].sort((a, b) => a - b);
  if (legacyData) {
    if (out.embed) return fail(tr('URL に以前の書き方（{0}）と新しい書き方（{1}）が混ざっています', ['data', 'db_embed']));
    out.embed = legacyData; out.legacy = true;
  }
  let sheets = v.sheets;
  if (nums.length) {
    if (sheets != null) return fail(tr('URL に以前の書き方（{0}）と新しい書き方（{1}）が混ざっています', ['query1', 'sheets']));
    sheets = nums.filter((n) => p.get('query' + n)?.trim())
      .map((n) => ({ type: 'query', name: p.get(`query${n}.name`)?.trim() || 'query' + n, sql: p.get('query' + n) }));
    out.legacy = true;
  }

  const ways = ['db', 'embed', 'project'].filter((k) => out[k]);
  if (ways.length > 1) return fail(tr('URL には db・db_embed・project のどれか1つしか書けません'));
  if (out.project && (sheets != null || v.format != null || v.version != null)) return fail(tr('project と一緒に書けるのは db_name・sheet・#（sort・filter・range）だけです'));
  if (!ways.length && sheets != null) return fail(tr('端末の DB を開く URL には sheets を書けません'));
  if (sheets != null) {
    const c = cleanSheets(sheets);
    if (c.bad) out.warnings.push(tr('壊れたシートの設定を {0} 個無視しました', [c.bad]));
    out.sheets = c.sheets;
    out.keep = sheetsToParams(c.sheets);
  }
  if (ways.length) out.sig = JSON.stringify([out.db, out.embed && fingerprint(out.embed), out.project, out.keep]);
  return out;
}

/** # に sort・filter・range があるか */
export function hasViewHash(h) {
  return ['sort', 'filter', 'range'].some((k) => h.has(k));
}

/** 文字列の短い指紋（長いデータをそのままキーにしない） */
export function fingerprint(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + '-' + str.length.toString(36);
}

// ======================================================================
// 端末側の設定（localStorage）との行き来
// 列の幅は w:<DB>/<シート>、行の高さは h:…、セルの書式は CELL_FORMATS の store（wrapc: など）。
// <シート> はテーブルなら名前、ビュー・クエリは内部キー（v:名前・q:名前）。
// 行は「行のキー」の文字列：テーブルは主キーの {列名: 値}（主キーが無ければ {_rowid_: 値}）の JSON、ほかは #何行目
// ======================================================================
const sheetKey = (dbKey, key) => `${dbKey}/${key[0] === 't' ? key.slice(2) : key}`;
const readJson = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 見た目の設定なので無視 */ } };

/** 端末の行のキー → 仕様の行キー（読めなければ undefined） */
function toRowKey(id) {
  if (/^#\d+$/.test(id)) return Number(id.slice(1));
  try { const o = JSON.parse(id); return o && typeof o === 'object' && !Array.isArray(o) ? Object.values(o) : undefined; } catch { return undefined; }
}
/** 仕様の行キー → 端末の行のキー。pk はテーブルの主キーの列名（主キーが無ければ []）、テーブルでなければ null */
function fromRowKey(rk, pk) {
  if (Number.isInteger(rk)) return pk ? undefined : '#' + rk;
  if (!pk) return undefined;
  if (!pk.length) return rk.length === 1 ? JSON.stringify({ _rowid_: rk[0] }) : undefined;
  return rk.length === pk.length ? JSON.stringify(Object.fromEntries(pk.map((p, i) => [p, rk[i]]))) : undefined;
}

/** 今の端末側の設定 → sheets。keys は並び順の内部キー、queries は [{name, sql}] */
export function collectSheets(dbKey, keys, queries) {
  const sqlOf = new Map(queries.map((x) => [x.name, x.sql]));
  return keys.map((key) => {
    const s = { type: TYPE_OF[key[0]], name: key.slice(2) };
    if (key[0] === 'q') s.sql = sqlOf.get(s.name) ?? '';
    const sk = sheetKey(dbKey, key);
    const w = readJson('w:' + sk, {});
    if (w && typeof w === 'object' && Object.keys(w).length) s.widths = w;
    const h = Object.entries(readJson('h:' + sk, {}) || {}).map(([id, px]) => [toRowKey(id), px]).filter(([rk]) => rk !== undefined);
    if (h.length) s.heights = h;
    const f = {};
    for (const [name, def] of Object.entries(CELL_FORMATS)) {
      const cells = (readJson(def.store + sk, []) || []).map((c) => {
        try { const [id, col] = JSON.parse(c); const rk = toRowKey(id); return rk === undefined ? null : [rk, col]; } catch { return null; }
      }).filter(Boolean);
      if (cells.length) f[name] = cells;
    }
    if (Object.keys(f).length) s.format = f;
    return s;
  });
}

/** 許可が要るシートの設定か：クエリ（端末のほかの DB を参照できる）か、URL の画像表示（外へ値を送れる）がある */
export const needsTrust = (sheets) => sheets.some((s) => s.type === 'query' || s.format?.image?.length > 0);

/**
 * sheets を端末側の設定に入れる（読み込んだばかりの DB に使う。前の値は呼ぶ側で消しておく）。
 * クエリシートの一覧・シートの並び・列の幅・行の高さ・セルの書式。pkOf(テーブル名) は主キーの列名（無い表なら null）
 */
export async function applySheets(dbKey, sheets, pkOf) {
  writeJson('queries:' + dbKey, sheets.filter((s) => s.type === 'query').map(({ name, sql }) => ({ name, sql })));
  writeJson('order:' + dbKey, sheets.map((s) => TYPES[s.type] + ':' + s.name));
  for (const s of sheets) {
    const key = TYPES[s.type] + ':' + s.name, sk = sheetKey(dbKey, key);
    if (!s.widths && !s.heights && !s.format) continue;
    const pk = s.type === 'table' ? await pkOf(s.name) : null;
    if (s.type === 'table' && !pk) continue; // 無いテーブル
    if (s.widths) writeJson('w:' + sk, s.widths);
    if (s.heights) {
      const h = {};
      for (const [rk, px] of s.heights) { const id = fromRowKey(rk, pk); if (id !== undefined) h[id] = px; }
      if (Object.keys(h).length) writeJson('h:' + sk, h);
    }
    for (const [name, cells] of Object.entries(s.format || {})) {
      const list = cells.map(([rk, col]) => { const id = fromRowKey(rk, pk); return id === undefined ? null : JSON.stringify([id, col]); }).filter(Boolean);
      if (list.length) writeJson(CELL_FORMATS[name].store + sk, list);
    }
  }
}

/** 書き出すプロジェクトの JSON（文字列）。db は絶対 URL か null、embed は db_embed の文字列か null */
export function projectText({ db, embed, sheets }) {
  const o = { format: FORMAT, version: VERSION };
  if (db) o.db = db; else o.db_embed = embed;
  o.sheets = sheets;
  return JSON.stringify(o, null, 2) + '\n';
}
