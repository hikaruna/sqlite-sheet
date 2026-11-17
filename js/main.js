// アプリ本体：DB・シートの管理、画面の組み立て
import { t as tr, lang, LANGS, setLang, locale } from './i18n.js';
import { db, q } from './db-client.js';
import { el, toast, menu, popover, closePopover, ask, confirmDialog, choiceDialog, modal, pickFile, download, exportFile, fmtBytes, isTouch, modKey, isMac, icon, appIcon, phone } from './ui.js';
import { listObjects, readTable, createTableSql, migrationSql, constantDefault, TYPES, affinity } from './schema.js';
import { Grid, CELL_FORMATS } from './grid.js';
import { sniff, asText, hexDump } from './blob.js';
import { TableSource, QuerySource, FILTER_OPS, friendlyError, convertInput, formText, formToDefault } from './sources.js';
import { txMarks } from './txmarks.js';
import { DesignPanel } from './design-panel.js';
import { SqlConsole } from './console.js';
import { undo, tableSummary } from './undo.js';
import { createSample, SAMPLE_QUERIES } from './sample.js';
import * as store from './store.js';
import { APP_VERSION } from './version.js';
import * as files from './files.js';
import { readProtections, protectSql, unprotectSql, protectionChecker, canProtectRows, describe, KIND_ICON as PROT_ICON } from './protect.js';

const MOD = isMac ? '⌘' : 'Ctrl+';

const $ = (id) => document.getElementById(id);
// ファイルを直接編集している DB の端末側データ（保存クエリ・列幅など）のキーの接頭辞。
// DB 名には「:」を使えないので重ならない
const FILE = 'file:';
const state = {
  dbName: null,     // 開いている DB。ファイルを直接編集しているときは FILE + ファイル名（端末側データのキー）
  dbs: [],          // データベース（OPFS 上）の名前
  file: null,       // ファイルを直接編集しているとき { handle, name }
  dirty: false,     // ファイルに未保存の変更があるか
  objects: [],      // {type:'table'|'view', name, sql}
  queries: [],      // {name, sql}
  key: null,        // 't:名前' | 'v:名前' | 'q:名前'
  views: new Map(), // key → {sort, filters}
  model: null,
  source: null,
  grid: null,
  panel: null,
  panelOpen: false,
};
let sqlConsole;

// ======================================================================
// 起動
// ======================================================================
async function boot() {
  buildChrome();
  try {
    if (!navigator.storage?.getDirectory) throw new Error(tr('このブラウザは OPFS（Origin Private File System）に対応していません。'));
    const info = await db.init();
    $('version').textContent = `SQLite ${info.version} · ${tr('版')} ${APP_VERSION}`;
  } catch (e) {
    return showFatal(e);
  }
  state.dbs = await db.list();
  // 消えた DB の端末側データを掃除（最近開いたファイルの分は残す）
  store.sweep([...state.dbs, ...(await files.list()).map((r) => FILE + r.name)]);
  restoreUrl();
  addEventListener('popstate', route);
  await route();
}

function showFatal(e) {
  const msg = String(e?.message || e);
  const busy = /access handle|NoModificationAllowed|locked|InvalidState/i.test(msg);
  $('app').replaceChildren(el('div.fatal',
    el('h1', busy ? tr('別のタブで開かれています') : tr('起動できませんでした')),
    el('p', busy
      ? tr('SQLiteシートは同時に1つのタブでしか使えません。他のタブを閉じてから再試行してください。')
      : msg),
    busy ? null : el('p.muted', tr('http(s) で配信されたページを、最近の Chrome / Edge / Firefox / Safari で開いてください。')),
    el('button.btn.primary', { on: { click: () => location.reload() } }, tr('再試行'))));
}

// URL は「/<DB 名>?sheet=<シート>」。DB はパス（移動は履歴に積む）、シートはクエリ文字列（切り替えは置き換える）。
// <シート> はテーブル・ビューなら名前そのまま、保存クエリなら先頭に「~」。名前自体の先頭の「~」は2つに重ねるので、
// 先頭の「~」が奇数個ならクエリ、偶数個ならテーブル・ビュー（テーブルとクエリが同名でも区別できる）
const BASE = new URL('../', import.meta.url).pathname;
const REDIRECT = 'redirect-url'; // 404.html が元の URL を預ける sessionStorage のキー

function parseUrl() {
  const path = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : '';
  let dbName = null;
  try { dbName = decodeURIComponent(path.split('/')[0]) || null; } catch { /* 壊れたエンコードは無視 */ }
  const p = new URLSearchParams(location.search);
  // #data=<圧縮した DB>：共有リンクに埋め込まれたデータ（# 以降はサーバーに送られない）
  const data = hashParams().get('data');
  return { dbName, sheet: p.get('sheet'), src: p.get('db'), data };
}

// ---------- # 以降：選択を渡すリンク（「🔗 リンクをコピー」で作る。選んだだけでは URL は変えない） ----------
// #data=…&sort=列:desc&filter=["列","op","値"]&range=B3:D7
// sort・filter は並べ替え・絞り込み（いくつでも、前ほど優先）。無ければ付けない。
// range は選択範囲。両端を「:」でつなぐ（片方だけなら1つ）。書き方は2通りで、両端は同じ書き方にする：
//   位置で（A1 形式）：列は A, B…（表示の位置）、行は表示上の行番号（1 から）。セル B3・列 B・行 3・すべて all
//   名前で（テーブル）：R[主キーの値の JSON 配列]C[列名の JSON 文字列]。セル R[42]C["price"]・行 R[42]・列 C["price"]
//     複合主キーは R[4,"F-010"]、主キーがなければ rowid。大カッコは必須（A1 形式とは [ の有無で分かれる）
function hashParams() {
  const h = location.hash;
  return new URLSearchParams(!h || h.startsWith('#/') ? '' : h.slice(1));
}

/** # から並べ替え・絞り込み・選択を読む */
function readHashView() {
  const p = hashParams();
  const sorts = p.getAll('sort').map((v) => {
    const i = v.lastIndexOf(':'), dir = v.slice(i + 1);
    return i > 0 && (dir === 'asc' || dir === 'desc') ? { col: v.slice(0, i), dir } : { col: v, dir: 'asc' };
  }).filter((x) => x.col);
  const filters = p.getAll('filter').map((v) => {
    try {
      const [col, op, value] = JSON.parse(v);
      return typeof col === 'string' && FILTER_OPS.some((o) => o.id === op) ? { col, op, value: value == null ? '' : String(value) } : null;
    } catch { return null; }
  }).filter(Boolean);
  const sel = p.get('range') ? { range: p.get('range') } : null;
  // 開いたあと、並べ替え・絞り込み・選択を変えるまでは URL に残す
  const raw = [...p.entries()].filter(([k]) => k !== 'data');
  return { sorts, filters, sel, raw };
}

/** # に書く値（読みやすさのため [ ] " , : @ はそのまま） */
const hashEnc = (v) => encodeURIComponent(v).replace(/%(5B|5D|22|2C|3A|40)/g, (m) => decodeURIComponent(m));
const hashParam = ([k, v]) => k + '=' + hashEnc(v);

/** 開いたリンクの #（並べ替え・絞り込み・選択）。そのシートで何か変えるまでは URL に残す */
function viewHashParams() {
  return state.urlView && state.urlView.key === state.key ? state.urlView.raw : [];
}

/** 今のシートの並べ替え・絞り込み → [[キー, 値]]（リンクを作るとき用） */
function viewParams(key = state.key) {
  const v = state.views.get(key), out = [];
  if (!v) return out;
  for (const x of v.sorts) out.push(['sort', `${x.col}:${x.dir}`]);
  for (const f of v.filters) out.push(['filter', JSON.stringify([f.col, f.op, f.value ?? ''])]);
  return out;
}

function hashOf(data, params = []) {
  const parts = [...(data ? ['data=' + data] : []), ...params.map(hashParam)];
  return parts.length ? '#' + parts.join('&') : '';
}

function colLetter(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}
const colOfLetter = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** 行の見分け方（テーブルだけ）：主キーの値、主キーがなければ rowid。URL に書けない値（BLOB 等）なら null */
function rowKeyValues(row) {
  const m = state.model;
  if (!m || !row) return null;
  const vals = m.pk.length ? m.pk.map((p) => row.values[m.columns.findIndex((c) => c.name === p)]) : [row.key?._rowid_];
  return vals.every((x) => x === null || typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))) ? vals : null;
}

/** 今の選択 → 位置の range（選んでいない・新しい行なら null） */
function rangeParam() {
  const g = state.grid;
  if (!g || g.none || !g.cols.length) return null;
  const { cur, ext } = g;
  if (cur.r === g.newRowIndex || ext.r === g.newRowIndex) return null;
  const two = (a, b) => (a === b ? a : `${a}:${b}`);
  if (g.colSelect && g.rowSelect) return 'all';
  if (g.colSelect) return two(colLetter(cur.c), colLetter(ext.c));
  if (g.rowSelect) return two(String(cur.r + 1), String(ext.r + 1));
  return two(colLetter(cur.c) + (cur.r + 1), colLetter(ext.c) + (ext.r + 1));
}

/** 今の選択 → 名前で指す range（テーブルだけ。キーが URL に書けない行・新しい行なら null） */
function namedRange() {
  const g = state.grid;
  if (!state.model || !g || g.none || !g.cols.length) return null;
  if (g.colSelect && g.rowSelect) return 'all';
  const { cur, ext } = g;
  const ref = (p) => {
    let out = '';
    if (!g.colSelect) {
      const k = p.r === g.newRowIndex ? null : rowKeyValues(g.rowAt(p.r));
      if (!k) return null;
      out += 'R' + JSON.stringify(k);
    }
    if (!g.rowSelect) out += 'C' + JSON.stringify([g.cols[p.c].name]);
    return out;
  };
  const a = ref(cur), b = ref(ext);
  return a && b ? (a === b ? a : `${a}:${b}`) : null;
}

/** s[i] の「[」に対応する「]」の位置（JSON の文字列の中は飛ばす）。無ければ -1 */
function bracketEnd(s, i) {
  if (s[i] !== '[') return -1;
  let depth = 0, inStr = false;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/** range を両端に分ける（大カッコ・文字列の中の「:」では切らない） */
function splitRange(s) {
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') { i = bracketEnd(s, i); if (i < 0) return null; }
    else if (s[i] === ':') { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * range の片側 → { named, c, row }。
 * 位置で「B3」「3」「B」：c は列の位置、row は表示上の行番号。
 * 名前で「R[42]C["price"]」「R[42]」「C["price"]」：c は列名、row は主キーの値の配列
 */
function parseRef(s) {
  if (s[0] !== 'R' && s[0] !== 'C' || s[1] !== '[') {
    const m = s.match(/^([A-Z]*)(\d*)$/);
    if (!m || (!m[1] && !m[2])) return null;
    return { named: false, c: m[1] ? colOfLetter(m[1]) : null, row: m[2] ? Number(m[2]) : null };
  }
  let i = 0, row = null, c = null;
  const part = () => {
    const e = bracketEnd(s, i + 1);
    if (e < 0) return null;
    let v;
    try { v = JSON.parse(s.slice(i + 1, e + 1)); } catch { return null; }
    i = e + 1;
    return v;
  };
  if (s[i] === 'R') {
    row = part();
    if (!Array.isArray(row) || !row.length) return null;
  }
  if (s[i] === 'C') {
    const v = part();
    if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== 'string') return null;
    c = v[0];
  }
  return i === s.length ? { named: true, c, row } : null;
}

/** キーの値 → 今の並び順・絞り込みでの表示位置（見つからなければ null） */
async function rowIndexOfKey(vals) {
  const s = state.source, m = state.model;
  if (!m) return null;
  const cols = m.pk.length ? m.pk : ['_rowid_'];
  if (vals.length !== cols.length) return null;
  const w = s.where();
  const sel = cols.map((c, i) => `${s.t}.${c === '_rowid_' ? '_rowid_' : q(c)} AS __k${i}`).join(', ');
  const r = await db.query(`SELECT __n FROM (SELECT row_number() OVER (${s.orderBy().trim()}) AS __n, ${sel} FROM ${s.t}${w.sql}) WHERE ${cols.map((_, i) => `__k${i} IS ?`).join(' AND ')} LIMIT 1`, [...w.bind, ...vals]);
  return r.rows.length ? Number(r.rows[0][0]) - 1 : null;
}

/** リンクの選択（range か cols/rows）を今のグリッドに当てる。当てられたら true */
async function applySelection(sel) {
  const g = state.grid;
  if (!g || !sel || !g.cols.length) return false;
  if (sel.range === 'all') { g.selectAll(); return true; }
  const refs = splitRange(sel.range)?.map(parseRef);
  if (!refs || refs.length > 2 || refs.some((x) => !x)) return false;
  let [a, b = a] = refs;
  if (a.named !== b.named) return false; // 両端は同じ書き方
  if (a.named) {
    if ((a.row || b.row) && !state.model) return false; // キーで指せるのはテーブルだけ
    const colIdx = (n) => (n == null ? null : g.cols.findIndex((c) => c.name === n));
    a = { ...a, c: colIdx(a.c) }; b = { ...b, c: colIdx(b.c) };
  }
  if ((a.row == null) !== (b.row == null) || (a.c == null) !== (b.c == null)) return false; // 両端は同じ形
  const rowOf = async (row) => (row == null ? null : Array.isArray(row) ? await rowIndexOfKey(row) : row - 1);
  const ok = (r) => r != null && r >= 0 && r < g.rowCount;
  const okC = (c) => c != null && c >= 0 && c < g.cols.length;
  try {
    if (a.row == null && b.row == null) { // 列だけ
      if (!okC(a.c) || !okC(b.c)) return false;
      g.selectCol(a.c, false); g.selectCol(b.c, true);
      return true;
    }
    const ra = await rowOf(a.row), rb = await rowOf(b.row);
    if (!ok(ra) || !ok(rb) || state.grid !== g) return false;
    if (a.c == null && b.c == null) { g.selectRows(ra, rb); g.ensureVisible(g.cur); return true; } // 行だけ
    if (!okC(a.c) || !okC(b.c)) return false;
    g.moveTo(ra, a.c);
    if (rb !== ra || b.c !== a.c) g.moveTo(rb, b.c, true);
    return true;
  } catch { return false; }
}

/** 開いたリンクの選択から動いたら、URL の # を外す（履歴は増やさない） */
const selSig = (g) => (g ? JSON.stringify([g.none, g.colSelect, g.rowSelect, g.cur, g.ext]) : '');
function dropUrlView() {
  if (!state.rangeReady || !state.urlView) return;
  // 行の読み込み後などに同じ選択のまま知らせてくることがあるので、実際に動いたときだけ
  if (selSig(state.grid) === state.urlView.sig) return;
  state.urlView = null;
  setUrl();
}

/** 同じシートのまま # が変わった（手で書き換えた・戻る）：リンクとして当て直す。当てたら true */
async function syncFromHash() {
  if (!state.key || !state.grid) return false;
  const h = readHashView();
  if (!h.raw.length) return false;
  state.pendingHash = h;
  await showSheet(state.key);
  return true;
}

/** 右クリックメニューの「🔗 リンクを作る…」：今の選択を入れて共有ダイアログを開く */
function linkItems() {
  return ['-', { label: tr('🔗 リンクを作る…'), disabled: !rangeParam() && !namedRange(), action: () => shareDialog({ withSelection: true }) }];
}

/** URL から読んだ DB の URL（/<保存するときの名前の候補>?db=…&sheet=…） */
function urlOfSrc(m, key) {
  return linkUrl({ wanted: m.wanted, src: m.embed ? null : m.url, queryParams: m.queryParams, key, data: m.embed, hash: key && key === state.key ? viewHashParams() : [] });
}

/** /<名前>?db=…&query1=…&sheet=…#data=… を組み立てる（src・data はどちらか一方） */
function linkUrl({ wanted, src, queryParams = [], key, data, hash = [] }) {
  const params = [];
  if (src) params.push(['db', src]);
  params.push(...queryParams);
  if (key) params.push(['sheet', sheetParam(key)]);
  return BASE + (wanted ? encodeURIComponent(wanted) : '')
    + (params.length ? '?' + params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '')
    + hashOf(data, hash);
}

/** 文字列の短い指紋（埋め込みデータの端末側データのキーに使う。長いデータをそのままキーにしない） */
function fingerprint(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + '-' + str.length.toString(36);
}

/**
 * ?db= に添えた ?query1=<SQL>&query1.name=<名前>&query2=… を、番号の順に読む。
 * 返り値: { list: [{ name, sql }], params: URL に残す [キー, 値] }。名前がなければ query1 など
 */
function urlQueries(p = new URLSearchParams(location.search)) {
  const nums = [...new Set([...p.keys()].map((k) => k.match(/^query(\d+)$/)?.[1]).filter(Boolean))]
    .sort((a, b) => a - b);
  const list = [], params = [];
  for (const n of nums) {
    const sql = p.get('query' + n), name = p.get(`query${n}.name`)?.trim();
    if (!sql?.trim()) continue;
    params.push(['query' + n, sql]);
    if (name) params.push([`query${n}.name`, name]);
    list.push({ name: name || 'query' + n, sql });
  }
  return { list, params };
}

/** 内部キー（'t:名前' 等）→ ?sheet= の値 */
function sheetParam(key) {
  const name = key.slice(2).replace(/^~+/, (m) => m + m);
  return (key[0] === 'q' ? '~' : '') + name;
}

/** ?sheet= の値 → 内部キー（無ければ null） */
function keyOfParam(v) {
  if (!v) return null;
  const n = v.match(/^~*/)[0].length, rest = v.slice(n);
  if (n % 2) return 'q:' + '~'.repeat((n - 1) / 2) + rest;
  const name = '~'.repeat(n / 2) + rest;
  const o = state.objects.find((x) => x.name === name);
  return o ? (o.type === 'table' ? 't:' : 'v:') + name : null;
}

function urlOf(dbName, key) {
  if (!dbName) return BASE;
  return BASE + encodeURIComponent(dbName) + (key ? '?sheet=' + encodeURIComponent(sheetParam(key)) : '')
    + (key && key === state.key ? hashOf(null, viewHashParams()) : '');
}

function setUrl() {
  // ファイルを直接編集している間は URL に DB を載せない（リロードしたらホームに戻る）。
  // URL から読んだものは ?db= を残す（リロード・共有で同じものが開く。変更は消える）
  const u = state.manual?.kind === 'url' ? urlOfSrc(state.manual, state.key)
    : state.manual ? urlOf(null) : urlOf(state.dbName, state.key);
  if (location.pathname + location.search + location.hash !== u) {
    const was = parseUrl();
    const same = state.manual?.kind === 'url' ? (state.manual.embed ? was.data === state.manual.embed : was.src === state.manual.url)
      : !was.src && was.dbName === (state.manual ? null : state.dbName);
    if (same) history.replaceState(null, '', u);
    else history.pushState(null, '', u);
  }
  document.title = (state.dirty ? '● ' : '') + [state.key?.slice(2), dbLabel(), tr('SQLiteシート')].filter(Boolean).join(' · ');
}

// 起動時：404.html から来た元の URL と、旧形式「#/DB/t:名前」を今の形に直す
function restoreUrl() {
  let u = null;
  try { u = sessionStorage.getItem(REDIRECT); sessionStorage.removeItem(REDIRECT); } catch { /* 無視 */ }
  if (u) history.replaceState(null, '', u);
  const old = location.hash.match(/^#\/([^/]*)\/?(.*)$/);
  if (old) {
    try {
      const [db, key] = [old[1], old[2]].map(decodeURIComponent);
      history.replaceState(null, '', urlOf(db || null, /^[tvq]:/.test(key) ? key : null));
    } catch { history.replaceState(null, '', BASE); }
  }
}

async function route() {
  // # の並べ替え・絞り込み・選択は、このあと開くシートに当てる（URL が正）
  state.pendingHash = readHashView();
  try { return await routeInner(); } finally { state.pendingHash = null; }
}

async function routeInner() {
  const { dbName, sheet, src, data } = parseUrl();
  // ?db=<SQLite ファイルの URL>：そのファイルをメモリに読み込んで開く（手動保存）。
  // /<DB 名> は保存するときの名前の候補、?sheet= は開くシート
  // #data=<圧縮した DB>：共有リンクに埋め込まれたデータを、?db= と同じようにメモリで開く
  if (src || data) {
    // 同じファイル・同じクエリならシートを切り替えるだけ。クエリが違えば読み直す
    if (state.manual?.kind === 'url' && (data ? state.manual.embed === data : !state.manual.embed && state.manual.url === src)
      && JSON.stringify(urlQueries().params) === JSON.stringify(state.manual.queryParams)) {
      const key = keyOfParam(sheet);
      if (key && key !== state.key) await showSheet(key);
      else if (!(await syncFromHash())) setUrl();
      return;
    }
    if (!(await leaveCurrent())) { if (state.dbName) setUrl(); else history.replaceState(null, '', BASE); return; }
    return data ? loadEmbedded(data, dbName, sheet) : loadFromUrl(src, dbName, sheet);
  }
  // 手動保存のものを開いているときに「戻る」などで URL が変わったとき：
  // ファイルを編集中でホームの URL ならそのまま、ほかへなら未保存の確認をしてから
  if (state.manual) {
    if (!dbName && state.manual.kind === 'file') return setUrl();
    if (!(await leaveCurrent())) { setUrl(); return; }
  }
  // / は最初の画面。前回の DB を勝手には開かない
  if (!dbName || !state.dbs.includes(dbName)) {
    if (dbName) toast(tr('DB「{0}」は見つかりません', [dbName]), 'error');
    if (state.grid && !(await state.grid.flushDraft())) return setUrl();
    return showWelcome();
  }
  if (dbName !== state.dbName) await openDb(dbName, null, sheet);
  else {
    const key = keyOfParam(sheet);
    if (key && key !== state.key) await showSheet(key);
    else if (!(await syncFromHash())) setUrl();
  }
}

// ======================================================================
// 画面の骨組み
// ======================================================================
function buildChrome() {
  $('app').replaceChildren(
    el('header.topbar',
      // 左上：アイコン＝ホーム（DB の一覧）、DB 名＝その場で名前を変更、ファイル＝DB の操作メニュー
      el('button#home-btn.home-btn', { dataset: { keepInput: '' }, title: tr('ホーム（データベースの一覧）'), on: { click: onHomeBtn } }, appIcon(),
        // スマホのシート画面だけ：ふだんは ‹（ホームへ）、何か選んでいる間は ✓（選択を解除）
        // 確定できなかった入力があるときは ✕（入力をやめて選択を解除）
        el('span.home-back', '‹'), el('span.home-done', '✓'), el('span.home-cancel', '✕')),
      // ホームでだけ出す：アプリ名と、DB を名前で探して開く検索窓
      el('span.app-title.home-only', tr('SQLiteシート')),
      el('div.db-search.home-only',
        // スマホだけ：検索窓の内側の左に、操作をまとめたメニュー（左から出る）を開くボタン
        el('button.icon-btn.home-menu-btn', { title: tr('メニュー'), 'aria-label': tr('メニュー'), on: { click: homeDrawer } }, '☰'),
        el('input#db-search.db-search-input', {
          type: 'search', placeholder: tr('データベースを検索'), spellcheck: false, autocomplete: 'off',
          'aria-label': tr('データベースを検索'), role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'db-search-list',
          on: { input: renderSearch, focus: renderSearch, keydown: onSearchKey, blur: () => setTimeout(hideSearch, 150) },
        }),
        el('div#db-search-list.db-search-list', { role: 'listbox', hidden: true })),
      el('input#db-name.db-name', {
        hidden: true, spellcheck: false, title: tr('クリックして名前を変更'),
        on: {
          keydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.target.value = state.dbName || ''; e.target.blur(); }
          },
          blur: (e) => commitDbName(e.target.value),
        },
      }),
      // 今のシート（パンくず）。押すとシートのメニュー（タブの右クリックと同じ）
      el('span#crumb-sep.crumb-sep', { hidden: true }, '›'),
      el('button#sheet-crumb.sheet-crumb', { hidden: true, title: tr('シートの操作'), on: { click: (e) => state.key && tabMenu(state.key, e.currentTarget) } }),
      // ファイルを直接編集しているときだけ出す。未保存ならクリックで保存
      el('button#save-state.save-state', { hidden: true, on: { click: () => saveFile() } }),
      // メニューバー：機能の正式な入口（ツールバーはその近道）。狭い画面では ☰ 1つにまとめる
      el('nav.menubar',
        el('button#file-btn.menubar-btn', { on: { click: (e) => dbMenu(e.currentTarget) } }, tr('ファイル')),
        el('button.menubar-btn', { on: { click: (e) => menu(e.currentTarget, editItems()) } }, tr('編集')),
        el('button.menubar-btn', { on: { click: (e) => menu(e.currentTarget, formatItems()) } }, tr('表示形式')),
        el('button.menubar-btn', { on: { click: (e) => menu(e.currentTarget, dataItems()) } }, tr('データ')),
        el('button.menubar-btn', { on: { click: (e) => menu(e.currentTarget, toolItems()) } }, tr('ツール'))),
      el('button#undo-btn2.tb-btn.phone-only', { title: tr('元に戻す'), disabled: true, on: { click: doUndo } }, icon('undo')),
      el('button#redo-btn2.tb-btn.phone-only', { title: tr('やり直す'), disabled: true, on: { click: doRedo } }, icon('redo')),
      el('button.icon-btn.menubar-all', { title: tr('メニュー'), 'aria-label': tr('メニュー'), on: { click: (e) => allMenu(e.currentTarget) } }, '☰')),
    // ツールバー（シート画面だけ）：編集の取り消し・表示の操作・パネル
    el('div.toolbar',
      el('button#undo-btn.tb-btn', { title: tr('元に戻す'), disabled: true, on: { click: doUndo } }, icon('undo')),
      el('button#redo-btn.tb-btn', { title: tr('やり直す'), disabled: true, on: { click: doRedo } }, icon('redo')),
      el('span.vsep'),
      // トランザクション：ふだんは「開始」、実行中は確定・取り消しをその場で
      el('button#tx-begin.tb-btn', { title: tr('トランザクションを開始（確定するまで変更を保存しない）'), on: { click: beginTx } }, icon('tx'), el('span.tb-label', tr('トランザクション'))),
      el('span#tx-box.tx-box', { hidden: true },
        el('span.tx-label', { title: tr('確定するまで変更は保存されません') }, tr('● トランザクション中')),
        el('button.tb-btn.tx-commit', { title: tr('確定（COMMIT）'), on: { click: commitTx } }, tr('確定')),
        el('button.tb-btn.tx-rollback', { title: tr('取り消し（ROLLBACK）'), on: { click: rollbackTx } }, tr('取り消し'))),
      el('span.vsep'),
      // 保護：テーブルなら常に出す（保護がなくても、ここから新しく保護できる）
      el('button#prot-btn.tb-btn', { title: tr('シートと範囲の保護'), on: { click: (e) => protPanel(e.currentTarget) } }, icon('lock'), el('span.tb-label', tr('保護')), el('span#prot-n.tb-count', { hidden: true })),
      el('span.vsep'),
      // セルごとの書式（折り返し・画像表示など。スプレッドシートのツールバーと同じく、押すと選べる）
      ...formatButtons(),
      el('span.grow'),
      el('button#panel-btn.tb-btn', { title: tr('テーブルの設計（列・キー・制約）'), on: { click: () => togglePanel() } }, icon('design'), el('span.tb-label', tr('設計'))),
      el('button#console-btn.tb-btn', { title: tr('SQL コンソール（{0}`）', [MOD]), on: { click: () => toggleConsole() } }, icon('terminal'), el('span.tb-label', 'SQL')),
      el('button.tb-btn.cmd-btn', { title: tr('コマンド（{0}K）', [MOD]), on: { click: () => palette() } }, el('kbd.tb-kbd', `${MOD}K`))),
    // 数式バー（値のエリア）：名前ボックス ＋ fx ＋ 入力欄
    el('div.fxbar',
      el('span#fx-ref.fx-ref', ''),
      // 式の入口：押すと列・関数・定数を選んで =式 を入れられる（スプレッドシートの「関数を挿入」）
      el('button#fx-btn.fx-btn', { dataset: { keepInput: '' }, title: tr('式を入力（= で始めると SQL の式として計算）'), on: { click: (e) => exprPicker(e.currentTarget) } }, 'fx'),
      el('input#fx-input.fx-input', { spellcheck: false, placeholder: '', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', name: 'sqlite-sheet-fx', on: { keydown: onFxKey, input: onFxInput, focus: onFxFocus, blur: onFxBlur, pointerdown: onFxPointerDown } }),
      // スマホだけ：選んだセルを編集（✎）／編集中は確定（✓）
      el('button#fx-edit.fx-edit.phone-only', { title: tr('編集'), 'aria-label': tr('編集'), on: { click: phoneEditInFx } }, '✎'),
      // 確定できなかったときだけ、✓ の代わりに ✕（やめる）。書き直し始めたら ✓ に戻る
      el('button#fx-cancel.fx-cancel.phone-only', { dataset: { keepInput: '' }, title: tr('やめる'), 'aria-label': tr('やめる'), on: { click: cancelPhoneEdit } }, '✕'),
      el('button#fx-ok.fx-ok.phone-only', { dataset: { keepInput: '' }, title: tr('確定'), 'aria-label': tr('確定'), on: { click: commitPhoneEdit } }, '✓')),
    // スマホで編集中だけ：キーボードの上の、式でよく使う記号のキー
    el('div.sym-row.phone-only', ['=', '+', '-', '/', '*', '.', ',', ';', '(', ')'].map((k) =>
      el('button.sym-key', { type: 'button', dataset: { keepInput: '' }, on: { click: () => insertSym(k) } }, k))),
    el('main.workspace',
      el('section#sheet.sheet',
        el('div#sheet-head.sheet-head'),
        el('div#grid-host.grid-host')),
      el('aside#panel.panel', { hidden: true })),
    el('section#console.console', { hidden: true }),
    el('footer.bottombar',
      el('div#tabs.tabs', { on: { wheel: tabsWheel, scroll: updateTabNav } }),
      el('span#tab-nav.tab-nav', { hidden: true },
        el('button#tab-prev.tab-nav-btn', { title: tr('前のシートへスクロール'), on: { click: () => scrollTabs(-1) } }, '‹'),
        el('button#tab-next.tab-nav-btn', { title: tr('次のシートへスクロール'), on: { click: () => scrollTabs(1) } }, '›')),
      el('button.tab-add', { title: tr('シートを追加'), on: { click: (e) => addSheetMenu(e.currentTarget) } }, tr('＋')),
      el('span.grow'),
      el('span#status.status'),
      el('span#version.version')),
  );
  // タブ列の幅が変わったら（窓の大きさ・‹ › の出し入れ）ボタンの状態を合わせ直す
  new ResizeObserver(() => updateTabNav()).observe($('tabs'));
  sqlConsole = new SqlConsole($('console'), {
    onSchemaMaybeChanged: async () => { undo.clear(); await refreshObjects(); await showSheet(state.key, { keepView: true }); },
    onDataChanged: async () => { undo.clear(); await state.grid?.reload(); },
    // データの変更を元に戻せる形で記録した（記録は消さない）
    onDataRecorded: async () => { await state.grid?.reload(); },
  });
  undo.onChange(updateUndoButtons);
  // DB への書き込み（成功したもの）を最終更新として記録する。ローカルファイルは対象外
  db.onLog((e) => { if (!e.error && state.dbName && !state.manual) store.touch(state.dbName, 'updated'); });
  // データが元に戻っても、クエリの変更が残っていれば未保存のまま
  db.onDirty((v) => setDirty(v || state.queriesDirty));
  db.onTx(setTx);
  // タブに戻ってきたら、ファイルがほかのアプリで変更されていないか確かめる
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExternalChange(); });
  addEventListener('keydown', onGlobalKey);
  // iPhone：シート画面ではページ全体を拡大させない（表は Grid が自分で拡大する）。
  // document に付けると、ホームで引っ張って更新できなくなるおそれがあるので、シート画面の要素にだけ付ける
  for (const sel of ['.topbar', '.toolbar', '.fxbar', '.workspace', '.bottombar']) {
    document.querySelector(sel).addEventListener('gesturestart', (e) => { if (!document.body.classList.contains('at-home')) e.preventDefault(); });
  }
  // 未保存の新しい行があるまま閉じようとしたら確認
  // ファイルに保存していない変更があるときも確認
  addEventListener('beforeunload', (e) => { if (state.grid?.hasDraft || state.inTx || (state.manual && state.dirty)) { e.preventDefault(); e.returnValue = ''; } });
  // .sqlite ファイルのドラッグ＆ドロップ
  document.documentElement.style.setProperty('--drop-label', JSON.stringify(tr('.sqlite ファイルをドロップして読み込む')));
  addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', (e) => {
    document.body.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (f) { e.preventDefault(); importFile(f); }
  });
}

function onGlobalKey(e) {
  if (modKey(e) && e.key.toLowerCase() === 's') {
    e.preventDefault(); // ブラウザの「ページを保存」は出さない
    if (state.manual) saveFile();
    else if (state.dbName) toast(tr('データベースは、変更のたびに自動で保存されています'));
    return;
  }
  if (modKey(e) && e.key === '`') { e.preventDefault(); if (state.dbName) toggleConsole(); return; }
  if (modKey(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]') && !e.target.classList.contains('grid-sink');
  if (!inField && modKey(e) && e.key.toLowerCase() === 'z' && !e.target.classList?.contains('grid-sink')) {
    e.preventDefault(); e.shiftKey ? doRedo() : doUndo();
  }
}

function updateUndoButtons() {
  for (const [u, r] of [[$('undo-btn'), $('redo-btn')], [$('undo-btn2'), $('redo-btn2')]]) {
    if (!u) continue;
    u.disabled = !undo.canUndo(); r.disabled = !undo.canRedo();
    u.title = undo.canUndo() ? tr('元に戻す: {0}（{1}Z）', [undo.peekUndo(), MOD]) : tr('元に戻す');
    r.title = undo.canRedo() ? tr('やり直す: {0}（{1}Y）', [undo.peekRedo(), MOD]) : tr('やり直す');
  }
}

async function doUndo() {
  try {
    const e = await undo.undo();
    if (e) toast(tr('元に戻しました：{0}{1}', [e.label, await showUndone(e, 'undo')]));
  } catch (e) { toast(tr('元に戻せませんでした：') + friendlyError(e.message), 'error'); }
}
async function doRedo() {
  try {
    const e = await undo.redo();
    if (e) toast(tr('やり直しました：{0}{1}', [e.label, await showUndone(e, 'redo')]));
  } catch (e) { toast(tr('やり直せませんでした：') + friendlyError(e.message), 'error'); }
}

/**
 * 元に戻した・やり直した場所を見せる。その操作のシートへ切り替え、変わったセル・行・列を選んで光らせる。
 * 記録は DB で1本なので、見えないシートのものが戻ることがある（Google スプレッドシートと同じ動き）。
 * トーストに添える言葉を返す
 */
async function showUndone(e, dir) {
  const sheet = (dir === 'undo' ? e.undoSheet : e.redoSheet) ?? e.sheet;
  const cells = (dir === 'undo' ? e.cells?.before : e.cells?.after) ?? [];
  const cols = (dir === 'undo' ? e.undoCols : e.redoCols) ?? (e.col ? [e.col] : []);
  // CASCADE などで複数の表が変わったときは、表ごとの件数も添える（コンソールの実行はラベルに入っている）
  const many = e.tables && Object.keys(e.tables).length > 1 && !e.label.startsWith(tr('SQL コンソール')) ? tr('（{0}）', [tableSummary(e.tables)]) : '';
  if (sheet && sheet !== state.key && allKeys().includes(sheet)) await showSheet(sheet);
  else await state.grid?.reload();
  if (!sheet || sheet !== state.key || !state.grid) return many;
  // 光らせるのは、この表のセル・行だけ
  const t = sheet.slice(2);
  const hidden = await state.grid.reveal({ cells: cells.filter((c) => c.t === undefined || c.t === t), cols });
  return many + (hidden ? tr('（絞り込みで表示されていません）') : '');
}

function toggleConsole(force) {
  const open = sqlConsole.toggle(force);
  if (!open) state.grid?.focus();
}

// ======================================================================
// ようこそ画面
// ======================================================================
function showWelcome() {
  document.body.classList.add('at-home'); // ホームでは上部バーをホーム用（アプリ名・検索）にし、下のバーを隠す
  sqlConsole?.toggle(false);
  if (state.manual) db.close().catch(() => {}); // 未保存の確認は呼ぶ側で済ませている
  state.dbName = null; state.key = null; state.grid = null; state.source = null; state.model = null;
  state.manual = null; setDirty(false);
  $('db-name').hidden = true;
  $('fx-ref').textContent = ''; $('fx-input').value = ''; $('status').textContent = '';
  $('tabs').replaceChildren();
  $('sheet-head').replaceChildren();
  $('panel').hidden = true;
  setUrl();
  // 操作はすべて一覧より上に置く（一覧が長くなっても埋もれない）
  $('db-search').value = ''; hideSearch();
  store.ensureCreated(state.dbs);
  $('grid-host').replaceChildren(el('div.welcome',
    el('div.home',
      el('header.home-head',
        el('p.lead', tr('スプレッドシートの手軽さで、SQLite データベースを。'))),
      el('div.home-tools',
        el('button.btn.primary', { title: tr('空のデータベースを作る'), on: { click: newDb } }, tr('＋ 新規作成')),
        el('button.btn', { title: tr('.sqlite ファイルをデータベースとして取り込む（ドラッグ＆ドロップでも可）'), on: { click: pickSqlite } }, tr('⤒ 取り込む')),
        el('button.btn', { title: tr('サンプルのデータベースを作る'), on: { click: makeSample } }, tr('✨ サンプル')),
        files.supported ? el('button.btn', { title: tr('パソコンの .sqlite ファイルをそのまま開いて編集する'), on: { click: fileModeDialog } }, tr('📂 ローカルファイルを直接編集…')) : null,
        isPwa() ? el('button.btn', { title: tr('Web 上の .sqlite ファイルを URL で開く（保存するまで何も残らない）'), on: { click: (e) => openUrlDialog(e.currentTarget) } }, tr('🌐 URL から開く…')) : null),
      el('section.home-section',
        el('div.home-section-head',
          el('h2', tr('データベース')),
          state.dbs.length > 1 ? el('button.tool-btn.home-sort', { title: tr('並べ替え'), on: { click: (e) => sortMenu(e.currentTarget) } },
            tr('並べ替え：{0}', [SORTS[homeSort()]]), el('span.caret', ' ▾')) : null),
        state.dbs.length
          ? el('div.home-list', el('div.home-cols', el('span', tr('名前')), el('span', tr('最終閲覧'))), sortedDbs().map((n) => el('div.home-item',
            el('button.home-row', { title: tr('「{0}」を開く', [n]), on: { click: () => openDb(n) } },
              el('span.home-row-icon', appIcon()), el('span.home-row-name', n),
              el('span.home-row-time', viewedText(n))),
            el('button.icon-btn.home-more', {
              title: tr('「{0}」の操作', [n]), 'aria-label': tr('「{0}」の操作', [n]),
              on: { click: (e) => menu(e.currentTarget, dbActions(n, { anchor: e.currentTarget, home: true }), { align: 'end' }) },
            }, '⋯'))))
          : el('p.home-empty', tr('まだデータベースがありません。'), el('span.wide-only', tr('上の「＋ 新規作成」か「✨ サンプル」から始めましょう。')), el('span.narrow-only', tr('左上の ☰ から「新規作成」か「サンプル」を選んで始めましょう。')))),
      el('footer.home-foot', $('version').textContent,
        langSwitch()))));
}

// ホームの一覧の並べ替え（選んだものは覚えておく）。時刻の記録がないときは作成時刻を使う
const SORTS = { viewed: tr('最終閲覧'), updated: tr('最終更新'), name: tr('名前') };
function homeSort() { try { const v = localStorage.getItem('home-sort'); return v in SORTS ? v : 'viewed'; } catch { return 'viewed'; } }
function sortedDbs() {
  const by = homeSort();
  if (by === 'name') return [...state.dbs];
  const t = (n) => { const m = store.getMeta(n); return m[by] ?? m.created ?? 0; };
  return [...state.dbs].sort((a, b) => t(b) - t(a) || a.localeCompare(b));
}
function viewedText(n) {
  const m = store.getMeta(n), t = m.viewed ?? m.created;
  return t ? ago(t) : '—';
}
function sortMenu(anchor) {
  const cur = homeSort();
  menu(anchor, Object.entries(SORTS).map(([k, label]) => ({
    label, icon: k === cur ? '✓' : '',
    action: () => { try { localStorage.setItem('home-sort', k); } catch { /* 無視 */ } showWelcome(); },
  })), { align: 'end' });
}

// スマホのホーム：左から出るメニュー。ホームの操作を一通りここから選べる
function homeDrawer() {
  const items = [
    { label: tr('新規作成'), icon: tr('＋'), run: newDb },
    { label: tr('取り込む'), icon: '⤒', run: pickSqlite },
    { label: tr('サンプル'), icon: '✨', run: makeSample },
    files.supported ? { label: tr('ローカルファイルを直接編集…'), icon: '📂', run: fileModeDialog } : null,
    isPwa() ? { label: tr('URL から開く…'), icon: '🌐', run: () => openUrlDialog($('db-search')) } : null,
  ].filter(Boolean);
  const close = () => {
    wrap.classList.remove('open');
    removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 200);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const wrap = el('div.drawer-wrap', { on: { click: (e) => { if (e.target === wrap) close(); } } },
    el('nav.drawer', { 'aria-label': tr('メニュー') },
      el('div.drawer-head', el('span.home-row-icon', appIcon()), el('span', tr('SQLiteシート'))),
      ...items.map((it) => el('button.drawer-item', { on: { click: () => { close(); it.run(); } } },
        el('span.mi-icon', it.icon), el('span', it.label))),
      el('div.drawer-foot', $('version').textContent, langSwitch())));
  document.body.append(wrap);
  addEventListener('keydown', onKey);
  requestAnimationFrame(() => wrap.classList.add('open'));
}

// ホームの検索窓：入力に合う DB をプルダウンで出し、選ぶと開く
let searchHits = [], searchSel = 0;
function renderSearch() {
  const input = $('db-search'), list = $('db-search-list');
  const q = input.value.trim().toLowerCase();
  searchHits = q ? state.dbs.filter((n) => n.toLowerCase().includes(q)) : [];
  searchSel = Math.min(searchSel, Math.max(0, searchHits.length - 1));
  if (!q) { hideSearch(); return; }
  list.replaceChildren(...(searchHits.length
    ? searchHits.map((n, i) => el('button.db-search-item' + (i === searchSel ? '.active' : ''), {
      role: 'option', 'aria-selected': String(i === searchSel), tabIndex: -1,
      on: { mousedown: (e) => e.preventDefault(), click: () => pickSearch(n) },
    }, el('span.home-row-icon', appIcon()), el('span', n)))
    : [el('div.db-search-none', tr('見つかりません'))]));
  list.hidden = false; input.setAttribute('aria-expanded', 'true');
}
function hideSearch() { $('db-search-list').hidden = true; $('db-search').setAttribute('aria-expanded', 'false'); }
function pickSearch(n) { $('db-search').value = ''; hideSearch(); $('db-search').blur(); openDb(n); }
function onSearchKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (searchHits.length) { searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length; renderSearch(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchHits[searchSel]) pickSearch(searchHits[searchSel]);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.target.value = ''; hideSearch();
  } else searchSel = 0;
}

// 「ローカルファイルを直接編集」：主のモードとは別のモードなので、説明と入口をこのダイアログにまとめる（履歴には積まない）
async function fileModeDialog() {
  const recent = await files.list();
  const list = el('div.recent-list');
  const renderList = (rows) => list.replaceChildren(...(rows.length
    ? [el('h3', tr('最近開いたファイル')), ...rows.map((r) => el('div.recent-item',
      el('button.recent-row', { title: tr('「{0}」を開く', [r.name]), on: { click: () => { m.close(); openRecent(r); } } },
        el('span.recent-icon', '📄'), el('span.recent-name', r.name), el('span.recent-ago', ago(r.at))),
      el('button.icon-btn.recent-x', {
        title: tr('一覧から消す（ファイルは消えません）'), 'aria-label': tr('「{0}」を一覧から消す', [r.name]),
        on: { click: async () => { await files.remove(r.id); renderList(await files.list()); } },
      }, '✕')))]
    : []));
  renderList(recent);
  const m = modal([
    el('h2', tr('📂 ローカルファイルを直接編集')),
    el('p', tr('パソコンの .sqlite ファイルをそのまま開いて編集します。')),
    el('ul.file-mode-notes',
      el('li', tr('保存は手動です（{0}S）', [MOD])),
      el('li', tr('ほかのアプリでファイルが変更されていたら、保存するときに知らせます')),
      el('li', tr('閉じても、このアプリには何も残りません'))),
    el('button.btn.primary.file-mode-pick', { on: { click: () => { m.close(); openFileDialog(); } } }, tr('📂 ファイルを選ぶ…')),
    list,
    el('div.modal-actions', el('button.btn', { on: { click: () => m.close() } }, tr('閉じる'))),
  ], { className: 'file-mode' });
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return tr('たった今');
  if (m < 60) return tr('{0} 分前', [m]);
  if (m < 60 * 24) return tr('{0} 時間前', [Math.round(m / 60)]);
  if (m < 60 * 24 * 30) return tr('{0} 日前', [Math.round(m / 60 / 24)]);
  return new Date(t).toLocaleDateString(locale);
}

// ======================================================================
// DB 操作
// ======================================================================
// key は内部キー（'t:名前' 等）、param は URL の ?sheet= の値
async function openDb(name, key, param) {
  // 未保存の新しい行・ファイルへの未保存の変更があれば先に片付ける（やめたら切り替えない）
  if (!(await leaveCurrent())) return;
  try {
    await db.open(name);
  } catch (e) { toast(friendlyError(e.message), 'error'); return showWelcome(); }
  state.manual = null; setDirty(false);
  state.dbName = name;
  store.touch(name, 'viewed');
  await showDb(key, param);
}

// DB を開いた直後の画面づくり（データベース・ローカルファイル共通）
async function showDb(key, param) {
  const name = state.dbName;
  document.body.classList.remove('at-home');
  // ホームはページ全体がスクロールする。下までスクロールしたまま開くと、シート画面の上が切れて下が空くので一番上に戻す
  window.scrollTo(0, 0);
  state.views = new Map();
  state.key = null;
  undo.clear();
  Object.assign($('db-name'), {
    value: dbLabel(), hidden: false, readOnly: !!state.manual,
    title: state.manual?.embed ? tr('リンクに埋め込まれたデータを開いています（保存すると、データベースとして残ります）')
      : state.manual?.kind === 'url' ? tr('URL から読み込んでいます（保存すると、データベースとして残ります）：{0}', [state.manual.url])
      : state.manual ? tr('ローカルファイルを直接編集しています') : tr('クリックして名前を変更'),
  });
  await refreshObjects();
  const keys = allKeys();
  const last = localStorage.getItem('last-sheet:' + name);
  if (param) key = keyOfParam(param);
  await showSheet(keys.includes(key) ? key : keys.includes(last) ? last : keys[0] || null);
}

// ======================================================================
// ローカルファイルを直接編集するモード
// 中身はメモリに読み込んで編集し、保存（Ctrl+S）したときだけファイルへ書く。閉じたら何も残さない
// ======================================================================
const dbLabel = () => (state.manual ? state.manual.name : state.dbName);

// ---------- トランザクション ----------
// 開始中の変更は確定（COMMIT）するまで DB に残らない。変えたセル・足した行には未確定の印を付ける
// 開始時の「元に戻す」の記録の写し。取り消したら、記録もこの状態に戻す
let txUndoSnap = null;
function setTx(v) {
  if (state.inTx === v) return;
  state.inTx = v;
  $('tx-box').hidden = !v;
  $('tx-begin').hidden = v;
  txMarks.clear();
  undo.resetTx();
  txMarks.on = v;
  if (v) txUndoSnap = undo.snapshot();
  state.grid?.render();
}

async function beginTx() {
  if (state.grid && !(await state.grid.flushDraft())) return;
  try { await db.begin(); toast(tr('トランザクションを開始しました。確定するまで変更は保存されません')); }
  catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function commitTx() {
  if (state.grid && !(await state.grid.flushDraft())) return false;
  try { await db.commit(); toast(tr('確定しました'), 'success'); return true; }
  catch (e) { toast(tr('確定できませんでした：') + friendlyError(e.message), 'error'); return false; }
}

async function rollbackTx() {
  state.grid?.discardDraft?.();
  try {
    const snap = txUndoSnap;
    await db.rollback();
    if (snap) undo.restore(snap);
    await refreshObjects();
    if (state.key) await showSheet(state.key, { keepView: true });
    toast(tr('取り消しました'));
    return true;
  } catch (e) { toast(tr('取り消せませんでした：') + friendlyError(e.message), 'error'); return false; }
}

/** 離れる前に：トランザクション中なら確定か取り消しを選んでもらう */
async function settleTx() {
  if (!state.inTx) return true;
  const c = await choiceDialog({
    title: tr('トランザクション中です'),
    body: tr('確定していない変更があります。どうしますか？'),
    choices: [
      { label: tr('キャンセル'), value: null },
      { label: tr('取り消す（ROLLBACK）'), value: 'rollback', danger: true },
      { label: tr('確定する（COMMIT）'), value: 'commit', primary: true },
    ],
  });
  if (c === 'commit') return commitTx();
  if (c === 'rollback') return rollbackTx();
  return false;
}

function setDirty(v) {
  state.dirty = !!v;
  if (!v) state.queriesDirty = false; // 読み込み・保存・破棄で、クエリの変更も済んだことになる
  const b = $('save-state');
  if (!b) return;
  b.hidden = !state.manual;
  if (state.manual) {
    const url = state.manual.kind === 'url';
    b.replaceChildren(el('span.ss-mark', state.dirty ? '●' : '✓'),
      el('span.ss-text', state.dirty ? tr('未保存') : url ? tr('変更なし') : tr('保存済み')));
    b.classList.toggle('dirty', state.dirty);
    b.disabled = !state.dirty;
    b.title = !state.dirty ? (url ? tr('URL から読んだときのままです') : tr('ファイルに保存されています'))
      : url ? tr('クリックしてデータベースとして保存（{0}S）', [MOD]) : tr('クリックしてファイルに保存（{0}S）', [MOD]);
  }
  if (state.dbName) setUrl(); // タブのタイトルの「● 」
}

/** 今の DB から離れてよいか。未保存の新しい行は保存し、ファイルの未保存の変更は保存するか尋ねる */
async function leaveCurrent() {
  if (state.grid && !(await state.grid.flushDraft())) return false;
  if (!(await settleTx())) return false;
  if (!state.manual || !state.dirty) return true;
  const c = await choiceDialog({
    title: tr('「{0}」への変更を保存しますか？', [state.manual.name]),
    body: tr('保存しないと、開いてから行った変更は失われます。'),
    choices: [
      { label: tr('キャンセル'), value: null },
      { label: tr('保存しない'), value: 'discard' },
      { label: tr('保存する'), value: 'save', primary: true },
    ],
  });
  if (c === 'save') return saveFile(false, { open: false });
  if (c === 'discard') { await db.close(); setDirty(false); return true; }
  return false;
}

async function pickToOpen() {
  try {
    const [handle] = await window.showOpenFilePicker({ types: files.PICKER_TYPES, id: 'sqlite-sheet' });
    return handle;
  } catch (e) {
    if (e.name !== 'AbortError') toast(friendlyError(e.message), 'error');
    return null;
  }
}

async function openFileDialog() {
  if (!(await leaveCurrent())) return;
  const handle = await pickToOpen();
  if (handle) await enterFile(handle);
}

async function openRecent(r) {
  if (!(await leaveCurrent())) return;
  await enterFile(r.handle, { recentId: r.id });
}

async function enterFile(handle, { recentId = null } = {}) {
  try {
    if (!(await files.ensurePermission(handle))) { toast(tr('ファイルの読み書きが許可されなかったため、開けませんでした'), 'error'); return; }
    await db.openFile(FILE + handle.name, handle);
  } catch (e) {
    if (e.name === 'NotFoundError' && recentId != null) {
      if (await confirmDialog({ title: tr('「{0}」が見つかりません', [handle.name]), body: tr('ファイルが移動・削除・名前の変更をされた可能性があります。最近開いたファイルの一覧から消しますか？'), okLabel: tr('一覧から消す') })) {
        await files.remove(recentId);
      }
      if (!state.dbName) showWelcome();
      return;
    }
    toast(friendlyError(e.message), 'error');
    return;
  }
  files.add(handle).catch(() => {});
  state.manual = { kind: 'file', handle, name: handle.name };
  state.dbName = FILE + handle.name;
  setDirty(false);
  await showDb(null);
}

/** ファイルへ保存する。保存できたら true */
async function saveFile(force = false, { open = true } = {}) {
  if (!state.manual) return false;
  if (state.grid && !(await state.grid.flushDraft())) return false;
  if (state.manual.kind === 'url') return saveUrlAsDb({ open });
  try {
    await db.save(force);
    toast(tr('「{0}」に保存しました', [state.manual.name]), 'success');
    return true;
  } catch (e) {
    if (e.message === 'CONFLICT') return resolveConflict({ saving: true });
    toast(friendlyError(e.message), 'error');
    return false;
  }
}

/**
 * URL から読んだものを、名前を聞いてデータベース（OPFS）として保存する。
 * open なら保存したデータベースに切り替える（以後は自動保存）。保存できたら true
 */
async function saveUrlAsDb({ open = true } = {}) {
  if (state.inTx) { toast(tr('トランザクション中です。先に確定か取り消しをしてください'), 'error'); return false; }
  let def = state.manual.wanted || state.manual.name, i = 2;
  const base = def;
  while (state.dbs.includes(def)) def = `${base} (${i++})`;
  const anchor = $('save-state').offsetParent ? $('save-state') : $('file-btn');
  const name = await ask(anchor, {
    title: tr('データベースとして保存する名前'), value: def, okLabel: tr('保存'),
    validate: (v) => validDbName(v) || (state.dbs.includes(v) ? tr('「{0}」は既にあります', [v]) : null),
  });
  if (!name) return false;
  const key = state.key;
  try {
    const bytes = await db.exportDb(state.dbName);
    store.removeDb(name);
    await db.importDb(name, bytes);
    store.copyDb(state.dbName, name);
    requestPersist();
    state.dbs = await db.list();
  } catch (e) { toast(friendlyError(e.message), 'error'); return false; }
  toast(tr('「{0}」としてデータベースに保存しました', [name]), 'success');
  // 保存できたので、メモリの方は捨ててよい。URL も ?db= から保存したデータベースのものに置き換える（「戻る」で読み直さない）
  await db.close(); state.manual = null; state.dbName = null; setDirty(false);
  if (open) { history.replaceState(null, '', urlOf(name)); await openDb(name, key); }
  return true;
}

/** ファイルを読み直す（この画面の未保存の変更は捨てる） */
async function reloadFile() {
  const { handle } = state.manual, key = state.key;
  try { await db.openFile(FILE + handle.name, handle); } catch (e) { toast(friendlyError(e.message), 'error'); return false; }
  setDirty(false);
  await showDb(key);
  toast(tr('「{0}」を読み直しました', [handle.name]));
  return true;
}

// ほかのアプリでファイルが変更されていたとき。保存しようとしたとき・タブに戻ったときに呼ぶ
let askingConflict = false;
async function resolveConflict({ saving = false } = {}) {
  if (askingConflict) return false;
  askingConflict = true;
  try {
    const name = state.manual.name;
    if (!saving && !state.dirty) {
      // こちらに未保存の変更がなければ、読み直すかどうかだけ
      if (await confirmDialog({ title: tr('「{0}」がほかのアプリで変更されました', [name]), body: tr('読み直して、ファイルの今の内容を表示しますか？'), okLabel: tr('読み直す') })) return reloadFile();
      return false;
    }
    const c = await choiceDialog({
      title: tr('「{0}」は、開いた後にほかのアプリで変更されています', [name]),
      body: tr('どちらの内容を残すか選んでください。'),
      choices: [
        { label: tr('キャンセル'), value: null },
        { label: tr('ファイルを読み直す'), hint: tr('この画面での変更を捨てる'), value: 'reload' },
        { label: tr('上書き保存'), hint: tr('ほかのアプリでの変更を捨てる'), value: 'overwrite', danger: true },
      ],
    });
    if (c === 'overwrite') { askingConflict = false; return saveFile(true); }
    if (c === 'reload') return reloadFile();
    return false;
  } finally { askingConflict = false; }
}

let lastCheckedStamp = null;
async function checkExternalChange() {
  if (!state.manual?.handle || askingConflict) return;
  try {
    const r = await db.checkFile();
    if (!r.changed) { lastCheckedStamp = null; return; }
    // 同じ変更について何度も尋ねない（キャンセルしたら、次に保存するときまで黙る）
    const f = await state.manual.handle.getFile();
    const stamp = `${f.lastModified}:${f.size}`;
    if (stamp === lastCheckedStamp) return;
    lastCheckedStamp = stamp;
    await resolveConflict();
  } catch { /* ファイルが消えた等は、保存しようとしたときに知らせる */ }
}

// ローカルファイルを直接編集しているときに、その内容をデータベースとして取り込む
async function importFileToBrowser() {
  const base = state.manual.name.replace(/\.(sqlite3?|db)$/i, '') || 'imported';
  let def = base, i = 2;
  while (state.dbs.includes(def)) def = `${base} (${i++})`;
  const name = await ask($('file-btn'), { title: tr('データベースとして取り込む名前'), value: def, okLabel: tr('取り込む'), validate: (v) => validDbName(v) || (state.dbs.includes(v) ? tr('「{0}」は既にあります', [v]) : null) });
  if (!name) return;
  try {
    if (state.grid && !(await state.grid.flushDraft())) return;
    const bytes = await db.exportDb(state.dbName);
    await db.importDb(name, bytes);
    store.copyDb(state.dbName, name);
    requestPersist();
    state.dbs = await db.list();
    toast(tr('「{0}」としてデータベースに取り込みました（このファイルはそのまま開いています）', [name]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ファイルを閉じてホームへ
async function closeFile() {
  if (!(await leaveCurrent())) return;
  showWelcome();
}

// OPFS の DB が消されにくくなるよう頼む。Firefox では確認が出るので、データベースを作る・取り込むときだけ
async function requestPersist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* 無視 */ }
}

function validDbName(v) {
  if (!v) return tr('名前を入力してください');
  if (/[\\/:*?"<>|]/.test(v)) return tr('使えない文字が含まれています（\\ / : * ? " < > |）');
  return null;
}

async function newDb(anchor) {
  if (!(await leaveCurrent())) return;
  const name = await ask(anchor instanceof Element ? anchor : $('file-btn'), {
    title: tr('新しいデータベース'), value: uniqueName(tr('データベース'), state.dbs), placeholder: tr('名前'), okLabel: tr('作成'),
    validate: (v) => validDbName(v) || (state.dbs.includes(v) ? tr('「{0}」は既にあります', [v]) : null),
  });
  if (!name) return;
  try {
    store.removeDb(name); // 同名で作り直したときに前の DB の設定を引き継がない
    await db.create(name);
    requestPersist();
    state.manual = null; setDirty(false);
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(name);
    toast(tr('「{0}」を作成しました', [name]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function makeSample() {
  if (!(await leaveCurrent())) return;
  let name = tr('サンプル'), i = 2;
  while (state.dbs.includes(name)) name = tr('サンプル{0}', [i++]);
  try {
    store.removeDb(name); // 同名で作り直したときに前の DB の設定を引き継がない
    await db.create(name);
    requestPersist();
    state.manual = null; setDirty(false);
    await createSample(db);
    store.setQueries(name, SAMPLE_QUERIES);
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(name);
    toast(tr('サンプルの DB を作成しました'), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// スマホのファイル選択は、知らない拡張子（.sqlite など）を選べなくすることがあるので絞らない。中身は importFile が確かめる
async function pickSqlite() {
  const f = await pickFile(isTouch ? '' : '.sqlite,.sqlite3,.db,application/x-sqlite3');
  if (f) importFile(f);
}

async function importFile(file) {
  importBytes(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.(sqlite3?|db)$/i, ''));
}

/** SQLite のファイルの中身を、名前を聞いてからデータベースとして取り込んで開く（sheet は開く ?sheet= の値） */
async function importBytes(bytes, defName, sheet = null) {
  const header = new TextDecoder().decode(bytes.slice(0, 15));
  if (header !== 'SQLite format 3') { toast(tr('SQLite のデータベースファイルではありません'), 'error'); return; }
  let name = defName || 'imported';
  const base = name; let i = 2;
  while (state.dbs.includes(name)) name = `${base} (${i++})`;
  name = await ask($('file-btn'), { title: tr('このファイルを読み込む名前'), value: name, okLabel: tr('読み込む'), validate: (v) => validDbName(v) || (state.dbs.includes(v) ? tr('「{0}」は既にあります', [v]) : null) });
  if (!name) return;
  if (!(await leaveCurrent())) return;
  try {
    store.removeDb(name);
    await db.importDb(name, bytes);
    requestPersist();
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(name, null, sheet);
    toast(tr('「{0}」を読み込みました', [name]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

/**
 * URL の ?db= で指定された SQLite ファイルを、メモリに読み込んで開く（手動保存。保存すると OPFS のデータベースになる）。
 * wanted は URL のパスの DB 名（保存するときの名前の候補）、sheet は開く ?sheet= の値
 */
async function loadFromUrl(src, wanted, sheet) {
  const fail = (msg) => {
    history.replaceState(null, '', BASE);
    if (state.manual?.kind === 'url' || !state.dbName) showWelcome();
    toast(msg, 'error', 8000);
  };
  let url;
  try { url = new URL(src, location.href); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) return fail(tr('読み込めない URL です：{0}', [src]));
  let file = url.pathname.split('/').pop() || '';
  try { file = decodeURIComponent(file); } catch { /* 壊れたエンコードはそのまま */ }
  const name = file.replace(/\.(sqlite3?|db)$/i, '') || url.hostname;
  const loading = toast(tr('読み込んでいます…'), 'info', 60000);
  let bytes;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    loading?.remove?.();
    return fail(tr('ファイルを取得できませんでした（{0}）。相手のサーバーが他のサイトからの読み込みを許していない（CORS）こともあります', [e.message]));
  }
  loading?.remove?.();
  if (new TextDecoder().decode(bytes.slice(0, 15)) !== 'SQLite format 3') return fail(tr('SQLite のデータベースファイルではありません'));
  await openLoaded(bytes, { url: src, key: 'url:' + src, name, wanted, sheet }, fail);
}

/** #data= に埋め込まれた DB（deflate で圧縮して base64url にしたもの）をメモリで開く */
async function loadEmbedded(data, wanted, sheet) {
  const fail = (msg) => {
    history.replaceState(null, '', BASE);
    if (state.manual?.kind === 'url' || !state.dbName) showWelcome();
    toast(msg, 'error', 8000);
  };
  let bytes;
  try { bytes = await inflate(fromBase64Url(data)); } catch { return fail(tr('リンクに埋め込まれたデータを読めませんでした。リンクが途中で切れているかもしれません')); }
  if (new TextDecoder().decode(bytes.slice(0, 15)) !== 'SQLite format 3') return fail(tr('SQLite のデータベースファイルではありません'));
  await openLoaded(bytes, { url: null, embed: data, key: 'url:#' + fingerprint(data), name: wanted || tr('共有されたデータ'), wanted, sheet }, fail);
}

/** 読み込んだ DB をメモリで開き、URL の ?query1= などのクエリシートを足して表示する（?db= と #data= 共通） */
async function openLoaded(bytes, { url, embed = null, key, name, wanted, sheet }, fail) {
  try { await db.openBytes(key, bytes); } catch (e) { return fail(friendlyError(e.message)); }
  // 端末側データ（列幅など）のキー。名前に「:」を含むので OPFS の DB とは重ならない
  // ?query1= などで添えたクエリは、クエリシートとして足す（クエリシートは SELECT しか通らないので読み取り専用）。
  // URL にも残すので、リロード・共有で同じシートが並ぶ
  const { list, params } = urlQueries();
  state.manual = { kind: 'url', url, embed, name, wanted: wanted || null, queryParams: params };
  state.dbName = key;
  store.removeDb(state.dbName);
  if (list.length) {
    const qs = [];
    for (const x of list) qs.push({ name: uniqueName(x.name, qs.map((y) => y.name)), sql: x.sql });
    store.setQueries(state.dbName, qs);
  }
  setDirty(false);
  await showDb(null, sheet);
}

// ---------- 共有 ----------
// 共有リンクの長さの目安：これを超えるとチャットアプリなどで切れることがある／ブラウザが受け付けない
const LINK_WARN = 8000;
const LINK_MAX = 2_000_000;

async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
const deflate = (bytes) => pipeBytes(bytes, new CompressionStream('deflate-raw'));
const inflate = (bytes) => pipeBytes(bytes, new DecompressionStream('deflate-raw'));

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** クエリの SQL が、ほかの DB を「DB名.表名」で参照しているか（共有先には無いかもしれない） */
function refersOtherDb(sql) {
  return state.dbs.some((n) => n !== state.dbName
    && [n + '.', `"${n.replaceAll('"', '""')}".`, `[${n}].`, '`' + n + '`.'].some((t) => sql.includes(t)));
}


/**
 * 「🔗 共有…」と、右クリックの「🔗 リンクを作る…」（withSelection：今の選択も入れる）。
 * DB の渡し方・選択の指し方・並べ替えと絞り込みを選ぶと、下のリンクがすぐ変わる。
 * DB は「含めない」（端末の DB を名前で開く）・元のファイルの URL（?db= で開いたとき）・置いたファイルの URL・#data= に埋め込む
 */
async function shareDialog({ withSelection = false } = {}) {
  if (!state.dbName) return;
  if (state.grid && !(await state.grid.flushDraft())) return;
  const fromUrl = state.manual?.kind === 'url' && !state.manual.embed;
  const local = !state.manual;
  const name = state.manual ? (state.manual.wanted || state.manual.name) : state.dbName;
  const picked = new Set(state.queries.map((x) => x.name)); // 含めるクエリシート（はじめは全部）
  // 選択を入れるなら今のシートのクエリは外せない
  const fixedQuery = withSelection && state.key?.[0] === 'q' ? state.key.slice(2) : null;
  const posRange = withSelection ? rangeParam() : null;
  const keyRange = withSelection ? namedRange() : null;
  let selMode = posRange ? 'pos' : keyRange ? 'key' : null;
  let mode = fromUrl ? 'link' : 'embed';
  let embedded = null; // 圧縮した DB（作るのに時間がかかるので一度だけ）
  let url = '';

  const lead = el('p');
  const modeBox = el('div.share-mode');
  const selBox = el('div.share-mode');
  const queryBox = el('div.share-queries');
  const sheetSel = el('select.share-sheet', { on: { change: () => update() } });
  const viewCheck = el('input', { type: 'checkbox', checked: true, on: { change: () => update() } });
  const viewBox = el('label.share-check', viewCheck, el('span', tr('並べ替え・絞り込みを含める')));
  const viewNote = el('small.muted');
  const out = el('textarea.share-url.mono', { readOnly: true, rows: 4, 'aria-label': tr('共有リンク'), on: { focus: (e) => e.target.select() } });
  const info = el('div.share-info');
  const warn = el('div.share-warn');
  const copyBtn = el('button.btn.primary', { on: { click: () => copyLink() } }, tr('🔗 リンクをコピー'));
  const shareBtn = navigator.share ? el('button.btn', { on: { click: () => shareLink() } }, tr('📤 共有…')) : null;

  // 「置いたファイルの URL を指定する」：自分でどこかに置いたファイルの URL を ?db= に入れる
  const srcInput = el('input.share-src.mono', {
    type: 'url', placeholder: 'https://…/data.sqlite', 'aria-label': tr('ファイルの URL'),
    on: { input: () => update() },
  });
  const srcBox = el('div.share-src-box', srcInput,
    el('small', tr('アプリはファイルを置きません。今のデータを書き出してどこかに置き、その URL を入れてください。相手のブラウザから読めること（CORS）が必要です')));
  const customSrc = () => {
    const v = srcInput.value.trim();
    try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
  };

  const radio = (group, v, cur, onPick, label, note, { extra = '', disabled = false } = {}) => {
    const input = el('input', { type: 'radio', name: group, checked: cur === v, on: { change: () => onPick(v) } });
    input.disabled = disabled;
    return el('label.share-radio' + (disabled ? '.disabled' : ''), input, el('span', el('b', label), el('small', note), extra));
  };
  {
    const pick = (v) => { mode = v; update(); if (v === 'custom') srcInput.focus(); };
    const items = [];
    if (local) items.push(radio('share-mode', 'none', mode, pick, tr('DB を含めない'), tr('DB の名前だけを入れます。この端末か、同じ名前の DB がある端末で開くとき向けです')));
    if (fromUrl) {
      items.push(radio('share-mode', 'link', mode, pick, tr('元のファイルの URL を使う'), state.dirty
        ? tr('データの未保存の変更は含まれません。相手は元のファイルを開きます')
        : tr('相手も同じファイルを開きます。リンクは短くなります')));
    }
    items.push(
      radio('share-mode', 'embed', mode, pick, tr('データごと埋め込む'), tr('今のデータをリンクに入れます。元のファイルが無くても開けます')),
      radio('share-mode', 'custom', mode, pick, tr('置いたファイルの URL を指定する'), tr('相手はその URL のファイルを開きます。リンクは短くなります'), { extra: srcBox }));
    modeBox.append(el('div.share-label', tr('DB')), ...items);
  }
  if (withSelection) {
    const pick = (v) => { selMode = v; update(); };
    selBox.append(el('div.share-label', tr('選択範囲の指し方')),
      radio('share-sel', 'pos', selMode, pick, tr('位置で'), tr('列は A, B…、行は表示上の何行目か。どのシートでも使えます。データが変わるとずれます'), { disabled: !posRange }),
      radio('share-sel', 'key', selMode, pick, tr('列名・主キーで'), keyRange
        ? tr('列の並びやデータが変わっても同じ所を指します。リンクに主キーの値が入ります')
        : tr('テーブルで、主キーの値をリンクに書ける行だけ使えます'), { disabled: !keyRange }));
  }

  function renderSheets() {
    const cur = sheetSel.value || state.key;
    const keys = allKeys().filter((k) => k[0] !== 'q' || picked.has(k.slice(2)) || mode === 'none');
    sheetSel.replaceChildren(...keys.map((k) => el('option', { value: k, selected: k === cur }, `${KIND_ICON[k[0]]} ${k.slice(2)}`)));
    if (!keys.includes(cur) && keys.length) sheetSel.value = keys[0];
  }
  if (state.queries.length) {
    queryBox.append(el('div.share-label', tr('含めるクエリシート')),
      el('div.share-checks', ...state.queries.map((x) => {
        const cb = el('input', { type: 'checkbox', checked: true, on: { change: (e) => { if (e.target.checked) picked.add(x.name); else picked.delete(x.name); renderSheets(); update(); } } });
        cb.disabled = x.name === fixedQuery;
        return el('label.share-check', cb, el('span', x.name));
      })));
  }
  renderSheets();
  sheetSel.disabled = withSelection; // 選択を入れるなら今のシート

  async function update() {
    srcBox.hidden = mode !== 'custom';
    queryBox.hidden = mode === 'none';
    renderSheets();
    const key = withSelection ? state.key : sheetSel.value || null;
    const sel = selMode === 'pos' ? posRange : selMode === 'key' ? keyRange : null;
    // 位置で指すなら、並べ替え・絞り込みは必ず入れる（無いと別の行になる）
    const view = key ? viewParams(key) : [];
    viewBox.hidden = !view.length;
    viewCheck.disabled = !!sel && selMode === 'pos';
    if (viewCheck.disabled) viewCheck.checked = true;
    viewNote.textContent = view.length && viewCheck.disabled ? tr('位置で指すときは必ず含めます') : '';
    lead.textContent = mode === 'none'
      ? tr('このリンクに DB は入りません。開いた端末にある同じ名前の DB で、同じシートを開きます')
      : mode !== 'embed'
        ? tr('このリンクを開くと、相手のブラウザで同じファイルとシートが開きます。相手の変更はこちらには届きません')
        : tr('このリンクを開くと、相手のブラウザで今のデータとシートが開きます（保存するまで相手の端末には残りません）。相手の変更はこちらには届きません');
    const qs = mode === 'none' ? [] : state.queries.filter((x) => picked.has(x.name));
    const queryParams = [];
    qs.forEach((x, i) => queryParams.push(['query' + (i + 1), x.sql], [`query${i + 1}.name`, x.name]));
    if (mode === 'embed' && !embedded) {
      info.textContent = tr('データを圧縮しています…');
      copyBtn.disabled = true;
      try {
        const bytes = await db.exportDb(state.dbName);
        embedded = { raw: bytes.length, data: toBase64Url(await deflate(bytes)) };
      } catch (e) { info.textContent = friendlyError(e.message); return; }
    }
    const src = mode === 'link' ? state.manual.url : mode === 'custom' ? customSrc() : null;
    const noSrc = mode === 'custom' && !src;
    const hash = [...(viewCheck.checked ? view : []), ...(sel ? [['range', sel]] : [])];
    url = noSrc ? '' : location.origin + linkUrl({
      wanted: name, src, queryParams, key, hash, data: mode === 'embed' ? embedded.data : null,
    });
    const len = url.length, tooLong = len > LINK_MAX;
    out.value = tooLong ? '' : url;
    copyBtn.disabled = tooLong || noSrc;
    if (shareBtn) shareBtn.disabled = tooLong || noSrc;
    info.replaceChildren(noSrc ? '' : el('span', tr('リンクの長さ：{0} 文字', [len.toLocaleString()])),
      mode === 'embed' ? el('span.muted', ' ' + tr('（DB {0} を圧縮）', [fmtBytes(embedded.raw)])) : '');
    const notes = [];
    if (noSrc) notes.push(srcInput.value.trim() ? tr('http(s) の URL を入力してください') : tr('ファイルの URL を入力してください'));
    else if (tooLong) notes.push(tr('DB が大きすぎてリンクに入りません。「ファイルに書き出す」でファイルを渡してください'));
    else if (len > LINK_WARN) notes.push(tr('リンクが長いので、チャットアプリなどで途中で切れることがあります。切れると開けません'));
    if (mode === 'embed') notes.push(tr('リンクにはデータそのものが入っています。リンクを知っている人は中身を見られます'));
    const ext = qs.filter((x) => refersOtherDb(x.sql)).map((x) => x.name);
    if (ext.length) notes.push(tr('ほかの DB を参照しているクエリがあります（{0}）。相手の端末に同じ名前の DB がないと動きません', [ext.join(', ')]));
    warn.replaceChildren(...notes.map((t) => el('p', t)));
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(url); toast(tr('リンクをコピーしました'), 'success'); }
    catch { out.focus(); out.select(); toast(tr('コピーできませんでした。リンクを選んであるので、手でコピーしてください'), 'error'); }
  }
  async function shareLink() {
    try { await navigator.share({ title: name, url }); }
    catch (e) { if (e.name !== 'AbortError') toast(tr('共有できませんでした（{0}）', [e.message]), 'error'); }
  }

  const m = modal([
    el('h2', withSelection ? tr('🔗 選択範囲へのリンク') : tr('🔗 「{0}」を共有', [name])),
    lead, modeBox, selBox, el('div.share-view', viewBox, viewNote), queryBox,
    el('label.share-label', tr('はじめに開くシート'), sheetSel),
    out, info, warn,
    el('div.modal-actions', shareBtn || '', copyBtn, el('button.btn', { on: { click: () => m.close() } }, tr('閉じる'))),
  ], { className: 'share' });
  update();
}

// PWA として開いているか（アドレスバーがないので、?db= を打ち込めない）
function isPwa() { return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true; }

// 「URL から開く…」：貼り付けた URL を開く。このアプリの URL（/<DB 名>?db=…&query1=…）ならそのとおりに、
// それ以外は SQLite ファイルの URL とみなして ?db= と同じ流れで開く（メモリに読み込み、手動保存）
async function openUrlDialog(anchor) {
  const v = await ask(anchor instanceof Element ? anchor : $('file-btn'), {
    title: tr('URL から開く'), placeholder: 'https://…?db=…', okLabel: tr('開く'),
    validate: (v) => {
      if (!v) return tr('URL を入力してください');
      try { if (/^https?:$/.test(new URL(v, location.href).protocol)) return null; } catch { /* 下で知らせる */ }
      return tr('http(s) の URL を入力してください');
    },
  });
  if (!v) return;
  const u = new URL(v, location.href);
  // このアプリの URL：公開版・検証用など別のオリジンのものでも、パスと引数をこちらで開く。
  // ?db=・?sheet=・queryN=、# の data・range・sort・filter のどれかがあるか、同じオリジンで拡張子のないパスならアプリの URL。
  // DB の入っていないリンク（/<DB 名>?sheet=…#range=…）は、この端末の同じ名前の DB を開く
  const hp = new URLSearchParams(u.hash.startsWith('#/') ? '' : u.hash.slice(1));
  const last = u.pathname.split('/').pop();
  const isApp = ['db', 'sheet'].some((k) => u.searchParams.has(k))
    || [...u.searchParams.keys()].some((k) => /^query\d+$/.test(k))
    || ['data', 'range', 'sort', 'filter'].some((k) => hp.has(k))
    || (u.origin === location.origin && u.pathname.startsWith(BASE) && !last.includes('.'));
  if (isApp) {
    // パスの最後が DB 名（保存するときの名前の候補）。公開先によって手前のパスが違うので最後だけ使う
    history.pushState(null, '', BASE + u.pathname.split('/').pop() + u.search + u.hash);
    return route();
  }
  if (!(await leaveCurrent())) return;
  history.pushState(null, '', BASE + '?db=' + encodeURIComponent(v));
  await loadFromUrl(v, null, null);
}

// データベースをファイルに書き出す。保存先を選べるブラウザでは選んでもらう
async function exportCurrent(name = state.dbName) {
  const filename = `${name === state.dbName && state.manual ? state.manual.name : name}.sqlite`;
  try {
    if (name === state.dbName && state.grid && !(await state.grid.flushDraft())) return;
    if (typeof window.showSaveFilePicker !== 'function') {
      await exportFile(await db.exportDb(name), filename, 'application/x-sqlite3');
      return;
    }
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: filename, types: files.PICKER_TYPES, id: 'sqlite-sheet' }); } catch (e) {
      if (e.name === 'AbortError') return;
      throw e;
    }
    const bytes = await db.exportDb(name);
    const w = await handle.createWritable();
    await w.write(bytes); await w.close();
    toast(tr('「{0}」に書き出しました', [handle.name]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

/**
 * あるデータベースに対する操作。ホームの「⋯」と、シート画面の「ファイル ▾」で同じものを使う。
 * home なら「開く」を加え、名前の変更はポップオーバーで尋ねる（シート画面では DB 名の欄で直接変える）
 */
function dbActions(name, { anchor, home = false } = {}) {
  return [
    home ? { label: tr('開く'), icon: '↗', action: () => openDb(name) } : null,
    { label: tr('ファイルに書き出す…'), icon: '⤓', action: () => exportCurrent(name) },
    { label: tr('名前を変更…'), icon: '✎', action: () => (home ? renameDbAsk(name, anchor) : (() => { $('db-name').focus(); $('db-name').select(); })()) },
    { label: tr('複製…'), icon: '⧉', action: () => copyDb(name, anchor) },
    // 共有はシートやクエリシートを選ぶので、ホームからは開いてから
    { label: tr('共有…'), icon: '🔗', action: async () => { if (home) await openDb(name); if (state.dbName === name) shareDialog(); } },
    { label: tr('削除…'), icon: '🗑', danger: true, action: () => deleteDb(name) },
  ].filter(Boolean);
}

function dbMenu(anchor, { list = false } = {}) {
  const items = [];
  // 今開いているもの
  if (state.manual?.kind === 'url') {
    items.push({ header: tr('🌐 {0}（URL から読み込み中）', [state.manual.name]) },
      { label: tr('データベースとして保存…'), icon: '💾', kbd: `${MOD}S`, action: () => saveFile() },
      { label: tr('ファイルに書き出す…'), icon: '⤓', action: () => exportCurrent() },
      { label: tr('共有…'), icon: '🔗', action: shareDialog },
      { label: tr('閉じる'), icon: '✕', action: closeFile }, '-');
  } else if (state.manual) {
    items.push({ header: tr('📄 {0}（ローカルファイルを直接編集中）', [state.manual.name]) },
      { label: tr('保存'), icon: '💾', kbd: `${MOD}S`, disabled: !state.dirty, action: () => saveFile() },
      { label: tr('データベースとして取り込む…'), icon: '⤒', action: importFileToBrowser },
      { label: tr('共有…'), icon: '🔗', action: shareDialog },
      { label: tr('ファイルを閉じる'), icon: '✕', action: closeFile }, '-');
  } else if (state.dbName) {
    items.push({ header: el('span.menu-header-db', appIcon(), state.dbName) }, ...dbActions(state.dbName, { anchor }), '-',
      { label: tr('ホームへ（データベースの一覧）'), icon: '⌂', action: goHome });
  }
  // 何か開いているときは、その DB の操作だけ。ほかの DB・新規作成などのアプリ全体の操作はホームに置く
  if (state.manual || state.dbName) {
    if (list) return items;
    return menu(anchor, items);
  }
  items.push({ header: tr('データベース') });
  for (const n of state.dbs) items.push({ label: n, icon: n === state.dbName ? '✓' : appIcon(), action: () => { if (n !== state.dbName) openDb(n); } });
  items.push({ label: tr('新規作成…'), icon: tr('＋'), action: () => newDb(anchor) },
    { label: tr('.sqlite ファイルを取り込む…'), icon: '⤒', action: pickSqlite },
    { label: tr('サンプルを作成'), icon: '✨', action: makeSample });
  if (files.supported || isPwa()) items.push('-');
  if (files.supported) items.push({ label: tr('ローカルファイルを直接編集…'), icon: '📂', action: fileModeDialog });
  if (isPwa()) items.push({ label: tr('URL から開く…'), icon: '🌐', action: () => openUrlDialog(anchor) });
  if (list) return items;
  menu(anchor, items);
}

// ---------- メニューバーの各メニュー ----------
function editItems() {
  return [
    { label: undo.canUndo() ? tr('元に戻す：{0}', [undo.peekUndo()]) : tr('元に戻す'), icon: '↶', kbd: `${MOD}Z`, disabled: !undo.canUndo(), action: doUndo },
    { label: undo.canRedo() ? tr('やり直す：{0}', [undo.peekRedo()]) : tr('やり直す'), icon: '↷', kbd: `${MOD}Y`, disabled: !undo.canRedo(), action: doRedo },
  ];
}

// ---------- セルごとの書式の UI（定義は grid.js の CELL_FORMATS） ----------
// 書式を足すときはここに1つ足すと、メニュー・ツールバーのボタン・元に戻すが揃う。
// 文言は表示するときに tr() で訳す
const FORMAT_UI = [
  { name: 'wrap', icon: 'wrap', title: 'テキストの折り返し', on: '折り返す', off: '切り詰める', undo: '「{0}」のテキストの折り返し' },
  { name: 'image', icon: 'image', title: 'URL を画像で表示', on: '画像で表示', off: '文字で表示', undo: '「{0}」の URL の画像表示' },
  { name: 'info', icon: 'info', title: 'プレビューの付加情報', on: '情報を表示', off: 'プレビューだけ', undo: '「{0}」のプレビューの付加情報' },
];

/** 「表示形式」メニュー：書式ごとに見出しと2択を並べる */
function formatItems() {
  return FORMAT_UI.flatMap((f) => [{ header: tr(f.title) }, ...formatToggleItems(f)]);
}

/** ツールバーの書式ボタン（押すとその書式の2択） */
function formatButtons() {
  return FORMAT_UI.map((f) => el(`button#fmt-${f.name}-btn.tb-btn`, { title: tr(f.title), on: { click: (e) => { if (state.grid) menu(e.currentTarget, formatToggleItems(f)); } } }, icon(f.icon)));
}

/** 選んでいるセル（読み込み済みの行のもの）のうち、その書式を付けられるもの */
function formatTargets(name) {
  const g = state.grid;
  return g && !g.none ? g.selectedCells().filter((x) => g.canFormat(name, x.r, x.row, x.c)) : [];
}

/**
 * ツールバーの書式ボタン：選んでいる範囲に対象のセルがなければ灰色。
 * 対象のセルが全部その書式ならオンの見た目（メニューの ✓ と同じ判定）
 */
function updateFormatButtons() {
  const g = state.grid;
  for (const f of FORMAT_UI) {
    const btn = $(`fmt-${f.name}-btn`);
    if (!btn) continue;
    const targets = formatTargets(f.name), on = targets.length > 0 && targets.every((x) => g.isFormat(f.name, x.r, x.row, x.c));
    btn.disabled = !targets.length;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

/**
 * 書式を切り替える2つの選択肢。対象が1つもなければ灰色。今の設定に ✓（セルごとに違うときは付けない）
 */
function formatToggleItems(f) {
  const g = state.grid, targets = formatTargets(f.name);
  if (!targets.length) return [{ label: tr(f.on), icon: '', disabled: true }, { label: tr(f.off), icon: '', disabled: true }];
  const on = targets.filter((x) => g.isFormat(f.name, x.r, x.row, x.c)).length;
  return [
    { label: tr(f.on), icon: on === targets.length ? '✓' : '', action: () => g.setFormat(f.name, targets, true) },
    { label: tr(f.off), icon: on === 0 ? '✓' : '', action: () => g.setFormat(f.name, targets, false) },
  ];
}

function dataItems() {
  const isTable = state.key?.[0] === 't' && !!state.model;
  const name = state.key?.slice(2), locked = isTable && state.lockedSheets?.has(name);
  const anchor = $('prot-btn');
  return [
    { header: tr('保護') },
    { label: tr('保護されたシートと範囲…'), icon: '🔒', disabled: !isTable, action: () => protPanel(anchor) },
    locked
      ? { label: tr('シートの保護を外す…'), icon: '🔓', action: () => unprotect(state.prots.find((p) => p.kind === 'sheet')) }
      : { label: tr('シート全体を保護…'), icon: '🔒', disabled: !isTable, action: () => protect({ kind: 'sheet' }, anchor) },
    { label: tr('選択範囲を保護…'), icon: '▦', disabled: !isTable || !state.grid, action: () => protectSelection(anchor) },
    '-',
    { header: tr('トランザクション') },
    ...(state.inTx
      ? [{ label: tr('確定（COMMIT）'), icon: '✓', action: commitTx },
        { label: tr('取り消し（ROLLBACK）'), icon: '↶', danger: true, action: rollbackTx }]
      : [{ label: tr('トランザクションを開始'), icon: '⧗', action: beginTx }]),
  ];
}

function toolItems() {
  const isTable = state.key?.[0] === 't' && !!state.model;
  return [
    { label: tr('テーブルの設計'), icon: '⚙', disabled: !isTable, action: () => togglePanel() },
    { label: tr('SQL コンソール'), icon: '⌨', kbd: `${MOD}\``, action: () => toggleConsole() },
    { label: tr('コマンド'), icon: '⌕', kbd: `${MOD}K`, action: () => palette() },
    '-', ...langItems(),
  ];
}

/** ホーム・ドロワーの下の、言語の切り替え（日本語 | English） */
function langSwitch() {
  return el('span.home-lang', { title: 'Language / 言語' }, ...Object.entries(LANGS).map(([k, label]) => el('button.lang-btn', {
    class: k === lang ? 'on' : '', 'aria-pressed': String(k === lang), on: { click: () => { if (k !== lang) setLang(k); } },
  }, label)));
}

/** 言語の切り替え（見出しは両方の言語で書き、どちらの人にも見つけられるように） */
function langItems() {
  return [{ header: 'Language / 言語' },
    ...Object.entries(LANGS).map(([k, label]) => ({ label, icon: k === lang ? '✓' : '', action: () => { if (k !== lang) setLang(k); } }))];
}

/** 狭い画面：メニューバーの中身を1つのメニューに */
function allMenu(anchor) {
  menu(anchor, [
    { header: tr('ファイル') }, ...dbMenu(anchor, { list: true }), '-',
    { header: tr('編集') }, ...editItems(), '-',
    ...formatItems(), '-',
    ...dataItems(), '-',
    { header: tr('ツール') }, ...toolItems(),
  ]);
}

// 左上のアプリのアイコン：ホーム（DB の一覧）へ。DB の移動なので履歴に積む（「戻る」で元の DB に戻れる）
async function goHome() {
  if (!state.dbName) return;
  if (!(await leaveCurrent())) return;
  history.pushState(null, '', urlOf(null));
  showWelcome();
}

// DB 名の入力欄で確定したとき。だめな名前なら知らせて元に戻す
let renaming = false;
async function commitDbName(value) {
  const from = state.dbName, to = value.trim(), input = $('db-name');
  if (!from || renaming || state.manual) return; // ファイルの名前はここでは変えない
  const err = to === from ? null : validDbName(to) || (state.dbs.includes(to) ? tr('「{0}」は既にあります', [to]) : null);
  if (to === from || err) {
    if (err) toast(err, 'error');
    input.value = from;
    return;
  }
  renaming = true;
  try {
    // 未保存の新しい行は先に保存（失敗したら名前は変えない）
    if (state.grid && !(await state.grid.flushDraft())) { input.value = from; return; }
    await db.rename(from, to);
    store.renameDb(from, to);
    state.dbs = await db.list();
    // 名前を変えただけなので履歴は置き換える（「戻る」で古い名前の URL に戻らない）
    history.replaceState(null, '', urlOf(to, state.key));
    state.dbName = null;
    await openDb(to, state.key);
  } catch (e) { toast(friendlyError(e.message), 'error'); input.value = from; await openDb(from); }
  finally { renaming = false; }
}

// ホームの「⋯」から名前を変える（開いていない DB）
async function renameDbAsk(from, anchor) {
  const to = await ask(anchor, {
    title: tr('新しい名前'), value: from, okLabel: tr('変更'),
    validate: (v) => (v === from ? null : validDbName(v) || (state.dbs.includes(v) ? tr('「{0}」は既にあります', [v]) : null)),
  });
  if (!to || to === from) return;
  try {
    await db.rename(from, to);
    store.renameDb(from, to);
    state.dbs = await db.list();
    showWelcome();
    toast(tr('「{0}」を「{1}」に変更しました', [from, to]));
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// 複製。シート画面からなら複製を開き、ホームからなら一覧に加えるだけ
async function copyDb(from = state.dbName, anchor = $('file-btn')) {
  const opened = from === state.dbName;
  let def = tr('{0} のコピー', [from]), i = 2;
  while (state.dbs.includes(def)) def = tr('{0} のコピー {1}', [from, i++]);
  const to = await ask(anchor, { title: tr('複製先の名前'), value: def, okLabel: tr('複製'), validate: (v) => validDbName(v) || (state.dbs.includes(v) ? tr('「{0}」は既にあります', [v]) : null) });
  if (!to) return;
  try {
    await db.copy(from, to);
    requestPersist();
    store.duplicateDb(from, to);
    state.dbs = await db.list();
    if (opened) { state.dbName = null; await openDb(to); } else showWelcome();
    toast(tr('「{0}」を作成しました', [to]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function deleteDb(name = state.dbName) {
  if (!await confirmDialog({ title: tr('「{0}」を削除しますか？', [name]), body: tr('データベースのすべてのデータが失われ、元に戻せません。必要なら先に書き出してください。'), okLabel: tr('削除'), danger: true })) return;
  try {
    await db.remove(name);
    store.removeDb(name);
    state.dbs = await db.list();
    toast(tr('「{0}」を削除しました', [name]));
    if (name === state.dbName) state.dbName = null;
    showWelcome();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ======================================================================
// シート一覧
// ======================================================================
async function refreshObjects() {
  state.objects = await listObjects();
  state.queries = store.getQueries(state.dbName);
  // もう無い表・シートの列幅を掃除（表は名前、ビュー・クエリは内部キーで保存している）
  const tables = new Set(state.objects.filter((o) => o.type === 'table').map((o) => o.name));
  const keys = new Set(allKeys());
  store.sweepWidths(state.dbName, (rest) => tables.has(rest) || keys.has(rest));
  // シート全体が保護されている表（タブに 🔒 を出す）
  state.lockedSheets = new Set((await db.query(`SELECT tbl_name FROM sqlite_schema WHERE type = 'trigger' AND name GLOB 'protect_[0-9]*_ins'`)).rows.map(([n]) => n));
  renderTabs();
}

// シートの並び順は端末ごとに保存（テーブルを作り直しても順番が変わらないように）
function loadOrder() { try { return JSON.parse(localStorage.getItem('order:' + state.dbName) || '[]'); } catch { return []; } }
function saveOrder(keys) { try { localStorage.setItem('order:' + state.dbName, JSON.stringify(keys)); } catch { /* 無視 */ } }
function renameInOrder(from, to) { saveOrder(loadOrder().map((k) => (k === from ? to : k))); }

function allKeys() {
  const keys = [...state.objects.map((o) => (o.type === 'table' ? 't:' : 'v:') + o.name), ...state.queries.map((x) => 'q:' + x.name)];
  const order = loadOrder();
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length + keys.indexOf(k) : i; };
  const sorted = keys.sort((a, b) => rank(a) - rank(b));
  if (JSON.stringify(sorted) !== JSON.stringify(order)) saveOrder(sorted);
  return sorted;
}

const tableNames = () => state.objects.filter((o) => o.type === 'table').map((o) => o.name);
const KIND_ICON = { t: '▦', v: '◫', q: '⌕' };
const KIND_NAME = { t: tr('テーブル'), v: tr('ビュー'), q: tr('クエリ') };

// PC ではシートタブをホイールと ‹ › ボタンで左右にスクロールできるようにする（スマホは指でスライド）
function tabsWheel(e) {
  const tabs = e.currentTarget;
  if (tabs.scrollWidth <= tabs.clientWidth) return;
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!d) return;
  e.preventDefault();
  tabs.scrollLeft += e.deltaMode === 1 ? d * 40 : d;
  updateTabNav();
}
function scrollTabs(dir) {
  const tabs = $('tabs');
  tabs.scrollBy({ left: dir * Math.max(80, tabs.clientWidth * 0.8), behavior: 'smooth' });
}
function updateTabNav() {
  const tabs = $('tabs'), nav = $('tab-nav');
  if (!tabs || !nav) return;
  const max = tabs.scrollWidth - tabs.clientWidth;
  nav.hidden = max <= 1;
  $('tab-prev').disabled = tabs.scrollLeft <= 0;
  $('tab-next').disabled = tabs.scrollLeft >= max - 1;
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...allKeys().map((key) => {
    const kind = key[0], name = key.slice(2);
    return el('button.tab', {
      class: (key === state.key ? 'on ' : '') + 'k-' + kind,
      title: tr('{0}：{1}', [KIND_NAME[kind], name]),
      on: {
        // タッチ：開いているタブをもう一度タップするか、長押しでタブのメニュー（スプレッドシートのアプリと同じ）
        click: (e) => {
          if (e.pointerType && e.pointerType !== 'mouse' && key === state.key) tabMenu(key, e.currentTarget);
          else showSheet(key);
        },
        pointerdown: (e) => tabPointer(e, key),
        dblclick: (e) => renameSheet(key, e.currentTarget),
        contextmenu: (e) => { e.preventDefault(); if (e.pointerType !== 'touch') tabMenu(key, e.currentTarget); },
      },
    }, el('span.tab-icon', KIND_ICON[kind]), name, kind === 't' && state.lockedSheets?.has(name) ? el('span.tab-lock', { title: tr('シート全体が保護されています') }, '🔒') : null);
  }));
  tabs.querySelector('.tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  updateTabNav();
  // 上部のパンくず：DB 名 › 今のシート
  const crumb = $('sheet-crumb'), has = !!state.key;
  crumb.hidden = $('crumb-sep').hidden = !has;
  if (has) crumb.replaceChildren(el('span.tab-icon', KIND_ICON[state.key[0]]), el('span.crumb-name', state.key.slice(2)));
}

/**
 * タブを押したとき：ドラッグで順番を入れ替える（スプレッドシートのシートタブと同じ）。
 * マウスは少し動かせばドラッグ。タッチは長押ししてから動かすとドラッグ、動かさずに離せばタブのメニュー
 * （長押しせずに動かせば、ふつうにタブの列をスクロール）
 */
function tabPointer(e, key) {
  if (e.button !== 0) return;
  const tab = e.currentTarget, box = tab.parentElement, touch = e.pointerType !== 'mouse';
  const sx = e.clientX, sy = e.clientY;
  let armed = !touch, dragging = false, to = -1, lastX = sx;
  const timer = touch ? setTimeout(() => { armed = true; navigator.vibrate?.(10); tab.classList.add('armed'); }, 450) : 0;
  const others = () => [...box.querySelectorAll('.tab')].filter((t) => t !== tab);
  // 長押しのあとは、指を動かしてもタブの列がスクロールしないようにする
  const noScroll = (ev) => { if (armed) ev.preventDefault(); };
  const place = () => {
    const x = lastX, br = box.getBoundingClientRect();
    // 端まで持っていったら、タブの列をその方向へ送る
    if (x < br.left + 24) box.scrollLeft -= 8; else if (x > br.right - 24) box.scrollLeft += 8;
    tab.style.transform = `translateX(${x - sx + (box.scrollLeft - sl0)}px)`;
    const mid = tab.getBoundingClientRect().left + tab.offsetWidth / 2;
    const rest = others();
    to = rest.filter((t) => { const r = t.getBoundingClientRect(); return mid > r.left + r.width / 2; }).length;
    rest.forEach((t, k) => t.classList.toggle('drop-before', k === to));
    box.classList.toggle('drop-end', to === rest.length);
  };
  const sl0 = box.scrollLeft;
  const move = (ev) => {
    lastX = ev.clientX;
    const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
    if (!dragging) {
      if (!armed) { if (d > 10) end(); return; } // 長押し前に動いた：スクロールに任せる
      if (d < 5) return;
      dragging = true;
      tab.classList.add('dragging'); box.classList.add('sorting');
    }
    place();
  };
  const end = () => {
    clearTimeout(timer);
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', end);
    removeEventListener('touchmove', noScroll);
    tab.classList.remove('armed', 'dragging'); tab.style.transform = '';
    box.classList.remove('sorting', 'drop-end');
    box.querySelectorAll('.drop-before').forEach((t) => t.classList.remove('drop-before'));
  };
  const up = () => {
    const wasArmed = armed && touch, moved = dragging;
    end();
    // 離したあとの click で、シートを開いたりメニューを出したりしない
    if (moved || wasArmed) {
      const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', eat, { capture: true }), 300);
    }
    if (!moved) { if (wasArmed) tabMenu(key, tab); return; }
    const keys = allKeys(), from = keys.indexOf(key);
    if (from < 0 || to < 0 || to === from) return;
    keys.splice(from, 1); keys.splice(to, 0, key);
    saveOrder(keys);
    renderTabs();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', end);
  addEventListener('touchmove', noScroll, { passive: false });
}

function tabMenu(key, anchor) {
  const kind = key[0], name = key.slice(2);
  menu(anchor, [
    { header: tr('{0}：{1}', [KIND_NAME[kind], name]) },
    { label: tr('名前を変更…'), icon: '✎', action: () => renameSheet(key, anchor) },
    kind === 't' ? { label: tr('複製…'), icon: '⧉', action: () => duplicateTable(name, anchor) } : null,
    kind === 't' ? (state.lockedSheets?.has(name)
      ? { label: tr('シートの保護を外す…'), icon: '🔓', action: () => withSheet(key, () => unprotect(state.prots.find((p) => p.kind === 'sheet'))) }
      : { label: tr('シートを保護…'), icon: '🔒', action: () => withSheet(key, () => protect({ kind: 'sheet' }, anchor)) }) : null,
    kind !== 'q' ? { label: tr('SQL コンソールで SELECT'), icon: '⌨', action: () => sqlConsole.insert(`SELECT * FROM ${q(name)};`) } : null,
    kind === 't' ? { label: tr('CSV で書き出し'), icon: '⤓', action: () => exportCsv(key) } : { label: tr('CSV で書き出し'), icon: '⤓', action: () => exportCsv(key) },
    '-',
    { label: tr('削除…'), icon: '🗑', danger: true, action: () => deleteSheet(key) },
  ].filter(Boolean), { });
}

function addSheetMenu(anchor) {
  if (!state.dbName) return;
  menu(anchor, [
    { label: tr('新しいテーブル'), icon: '▦', action: () => newTable(anchor) },
    { label: tr('新しいクエリ'), icon: '⌕', action: () => newQuery() },
    { label: tr('ファイルから表を作成（CSV/TSV）…'), icon: '⤒', action: () => importCsv() },
  ]);
}

function uniqueName(base, taken) {
  let n = base, i = 2;
  while (taken.includes(n)) n = `${base}${i++}`;
  return n;
}

// 名前の一意性は持ち主ごと：テーブル・ビューは SQLite、保存クエリは端末側の一覧の中だけ（両者は同名でもよい）
const objNames = () => state.objects.map((o) => o.name);
const queryNames = () => state.queries.map((x) => x.name);
const namesFor = (kind) => (kind === 'q' ? queryNames() : objNames());
function saveQueries() {
  store.setQueries(state.dbName, state.queries);
  // URL から読んだものは、保存するまでクエリも残らないので未保存にする
  // （ローカルファイルのクエリは端末側に保存されていて、ファイルの保存とは関係ない）
  if (state.manual?.kind === 'url') { state.queriesDirty = true; setDirty(true); }
}

async function newTable(anchor) {
  const name = await ask(anchor, {
    title: tr('新しいテーブル'), value: uniqueName(tr('テーブル'), objNames()), okLabel: tr('作成'),
    validate: (v) => !v ? tr('名前を入力してください') : objNames().includes(v) ? tr('「{0}」は既にあります', [v]) : null,
  });
  if (!name) return;
  try {
    await db.exec(tr('CREATE TABLE {0} (\n  "id" INTEGER PRIMARY KEY,\n  "名前" TEXT\n) STRICT', [q(name)]));
    await refreshObjects();
    await showSheet('t:' + name);
    toast(tr('テーブルを作成しました。列は見出しの ＋ か「⚙ 設計」から追加できます。'));
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function newQuery(sql, base = tr('クエリ')) {
  const name = uniqueName(base, queryNames());
  const first = tableNames()[0];
  sql ??= first ? `SELECT *\nFROM ${q(first)}\nLIMIT 100` : 'SELECT 1';
  try {
    state.queries.push({ name, sql });
    saveQueries();
    await refreshObjects();
    await showSheet('q:' + name);
    // ひな形はたいてい書き換えるので全選択しておく（そのまま打てば置き換わる）
    const ta = $('sheet-head').querySelector('textarea');
    ta?.focus();
    ta?.select();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function viewSelect(sql) {
  const m = sql.match(/^\s*CREATE\s+(?:TEMP\w*\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[\w\u0080-￿.]+)(\s*\([^)]*\))?\s+AS\s+([\s\S]*)$/i);
  return m ? { cols: m[1] || '', select: m[2].trim() } : { cols: '', select: sql };
}

async function renameSheet(key, anchor) {
  const kind = key[0], name = key.slice(2);
  const to = await ask(anchor, {
    title: tr('{0}の名前を変更', [KIND_NAME[kind]]), value: name, okLabel: tr('変更'),
    validate: (v) => !v ? tr('名前を入力してください') : v !== name && namesFor(kind).includes(v) ? tr('「{0}」は既にあります', [v]) : null,
  });
  if (!to || to === name) return;
  try {
    await doRenameSheet(kind, name, to);
    // 名前の変更も元に戻せる（戻すときは、どのシートを開いていても名前だけを戻す）
    undo.push({
      label: tr('{0}「{1}」→「{2}」の名前の変更', [KIND_NAME[kind], name, to]),
      undoSheet: kind + ':' + name, redoSheet: kind + ':' + to,
      undoFn: () => doRenameSheet(kind, to, name),
      redoFn: () => doRenameSheet(kind, name, to),
    });
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

/** シート（表・ビュー・クエリ）の名前を変える。元に戻す・やり直すからも呼ぶ */
async function doRenameSheet(kind, from, to) {
  if (kind === 't') return renameSchema({ fromTable: from, toTable: to, cols: [] });
  if (kind === 'v') {
    const v = state.objects.find((o) => o.name === from);
    const { cols, select } = viewSelect(v.sql);
    await db.batch([{ sql: `DROP VIEW ${q(from)}` }, { sql: `CREATE VIEW ${q(to)}${cols} AS ${select}` }]);
  } else { state.queries.find((x) => x.name === from).name = to; saveQueries(); }
  const wasOpen = state.key === kind + ':' + from;
  moveSheetState(kind + ':' + from, kind + ':' + to);
  await refreshObjects();
  if (wasOpen) await showSheet(kind + ':' + to, { keepView: true });
}

/** 名前が変わったシートの、並び順・並べ替えや絞り込みの状態を新しい名前へ移す */
function moveSheetState(fromKey, toKey) {
  if (fromKey === toKey) return;
  const view = state.views.get(fromKey);
  if (view) { state.views.set(toKey, view); state.views.delete(fromKey); }
  renameInOrder(fromKey, toKey);
}

/**
 * 表の名前・列名を変える（名前だけの変更）。シートの名前の変更・設計パネル・元に戻す／やり直すから呼ぶ。
 * cols は [[元の列名, 新しい列名]]。列名の変更は新しい表の名前で行う
 */
async function renameSchema({ fromTable, toTable, cols }) {
  const stmts = [];
  if (fromTable !== toTable) stmts.push({ sql: `ALTER TABLE ${q(fromTable)} RENAME TO ${q(toTable)}` });
  for (const [a, b] of cols) stmts.push({ sql: `ALTER TABLE ${q(toTable)} RENAME COLUMN ${q(a)} TO ${q(b)}` });
  await db.batch(stmts);
  const fromKey = 't:' + fromTable, toKey = 't:' + toTable;
  const wasOpen = state.key === fromKey;
  // 未確定の印・並べ替えや絞り込み・列幅を、新しい名前に付け替える
  txMarks.renameTable(fromTable, toTable);
  for (const [a, b] of cols) txMarks.renameColumn(toTable, a, b);
  moveSheetState(fromKey, toKey);
  const view = state.views.get(toKey);
  if (view) {
    const ren = (c) => cols.find(([a]) => a === c)?.[1] ?? c;
    view.sorts.forEach((s) => { s.col = ren(s.col); });
    view.filters.forEach((f) => { f.col = ren(f.col); });
  }
  try {
    const wk = (t) => `w:${state.dbName}/${t}`;
    const widths = JSON.parse(localStorage.getItem(wk(fromTable)) || 'null');
    if (widths) {
      for (const [a, b] of cols) if (a in widths) { widths[b] = widths[a]; delete widths[a]; }
      localStorage.removeItem(wk(fromTable));
      localStorage.setItem(wk(toTable), JSON.stringify(widths));
    }
  } catch { /* 見た目の設定なので失敗しても続ける */ }
  await refreshObjects();
  if (wasOpen) await showSheet(toKey, { keepView: true });
}

async function deleteSheet(key) {
  const kind = key[0], name = key.slice(2);
  let body = '';
  if (kind === 't') {
    const n = (await db.query(`SELECT count(*) FROM ${q(name)}`)).rows[0][0];
    body = tr('{0} 行のデータとインデックス・トリガーも削除されます。元に戻せません。', [n]);
  }
  if (!await confirmDialog({ title: tr('{0}「{1}」を削除しますか？', [KIND_NAME[kind], name]), body, okLabel: tr('削除'), danger: true })) return;
  try {
    const idx = allKeys().indexOf(key); // 消す前の位置（隣のシートを開くため）
    if (kind === 't') await db.exec(`DROP TABLE ${q(name)}`);
    else if (kind === 'v') await db.exec(`DROP VIEW ${q(name)}`);
    else { state.queries = state.queries.filter((x) => x.name !== name); saveQueries(); }
    undo.clear();
    await refreshObjects();
    const rest = allKeys();
    await showSheet(rest[Math.min(idx, rest.length - 1)] || null);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function duplicateTable(name, anchor) {
  const to = await ask(anchor, { title: tr('テーブルを複製'), value: uniqueName(name + '_copy', objNames()), okLabel: tr('複製'), validate: (v) => !v ? tr('名前を入力してください') : objNames().includes(v) ? tr('「{0}」は既にあります', [v]) : null });
  if (!to) return;
  try {
    const m = await readTable(name);
    const cols = m.columns.filter((c) => !c.generated).map((c) => q(c.name)).join(', ');
    await db.batch([
      { sql: createTableSql(m, to) },
      { sql: `INSERT INTO ${q(to)} (${cols}) SELECT ${cols} FROM ${q(name)}` },
      ...m.indexes.map((ix) => ({ sql: `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name + '_' + to)} ON ${q(to)} (${ix.cols.map(q).join(', ')})` })).filter((x) => !x.sql.includes('()')),
    ]);
    await refreshObjects();
    await showSheet('t:' + to);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ======================================================================
// シート表示
// ======================================================================
function viewOf(key) {
  if (!state.views.has(key)) state.views.set(key, { sorts: [], filters: [] });
  return state.views.get(key);
}

async function labelColumns(model) {
  const map = new Map();
  for (const f of model.fks) {
    if (f.cols.length !== 1) continue;
    try {
      const info = (await db.query(`SELECT name, type FROM pragma_table_info(?) ORDER BY cid`, [f.table])).rows;
      const pick = info.find(([n, t]) => n !== f.refCols[0] && affinity(t) === 'TEXT');
      if (pick) map.set(f.cols[0], pick[0]);
    } catch { /* 参照先がない */ }
  }
  return map;
}

async function showSheet(key, { keepView = true } = {}) {
  closePopover();
  // 別のシートへ移るなら未保存の新しい行を保存（失敗したら留まる）。同じシートの再表示なら下書きを引き継ぐ
  let carryDraft = null;
  if (state.grid?.hasDraft) {
    if (key !== state.key) { if (!(await state.grid.flushDraft())) { renderTabs(); return; } }
    else carryDraft = state.grid.draft;
  }
  // 離れるシートのスクロール位置と選択を覚えておく（戻ってきたら、そこから再開する）
  if (state.grid && state.key && state.views.has(state.key)) state.views.get(state.key).pos = state.grid.getPos();
  // 消えたシート（コンソールでの DROP/RENAME、古いハッシュ等）は近くのシートに切り替える
  const keys = allKeys();
  if (key && !keys.includes(key)) {
    const prev = state.order?.indexOf(key) ?? -1;
    key = keys[Math.min(Math.max(prev, 0), keys.length - 1)] || null;
  }
  state.order = keys;
  state.key = key;
  // URL から来たときは、# の並べ替え・絞り込みをこのシートに当てる
  const fromUrl = state.pendingHash;
  state.pendingHash = null;
  // リンクの # が何か指していれば当てる。何も無い URL（タブの切り替え・戻る）なら今の並べ替えのまま
  if (fromUrl?.raw.length && key) Object.assign(viewOf(key), { sorts: fromUrl.sorts, filters: fromUrl.filters });
  state.urlView = fromUrl?.raw.length && key ? { key, raw: fromUrl.raw } : null;
  state.rangeReady = false; // 当て終えるまで、選択の変化で # を外さない
  setUrl();
  renderTabs();
  if (!key) {
    state.grid = null; state.source = null; state.model = null;
    updateStatus();
    $('sheet-head').replaceChildren();
    $('grid-host').replaceChildren(el('div.empty-db',
      el('h2', tr('まだシートがありません')),
      el('p.muted', tr('テーブルを作るか、SQL コンソールから CREATE TABLE を実行してください。')),
      el('div.row-gap', el('button.btn.primary', { on: { click: (e) => addSheetMenu(e.currentTarget) } }, tr('＋ 追加')),
        el('button.btn', { on: { click: () => toggleConsole(true) } }, tr('⌨ SQL を書く')))));
    updatePanel();
    return;
  }
  localStorage.setItem('last-sheet:' + state.dbName, key);
  if (!keepView) state.views.delete(key);
  const kind = key[0], name = key.slice(2);
  const view = viewOf(key);
  try {
    if (kind === 't') {
      state.model = await readTable(name);
      // URL などから来た、無い列の並べ替え・絞り込みは捨てる
      const has = (c) => state.model.columns.some((x) => x.name === c);
      view.sorts = view.sorts.filter((x) => has(x.col)); view.filters = view.filters.filter((x) => has(x.col));
      state.source = new TableSource(state.dbName, state.model, view, await labelColumns(state.model));
      state.prots = readProtections(state.model);
      state.source.protect = protectionChecker(state.model, state.prots);
      if (state.prots.some((p) => p.kind === 'sheet')) state.source.editable = false;
    } else {
      state.prots = [];
      state.model = null;
      const sql = kind === 'v' ? `SELECT * FROM ${q(name)}` : state.queries.find((x) => x.name === name)?.sql || 'SELECT 1';
      state.source = await new QuerySource(`${state.dbName}/${key}`, sql, view).init();
    }
  } catch (e) {
    state.source = null; state.grid = null;
    updateStatus();
    renderSheetHead(kind, name, e);
    $('grid-host').replaceChildren(el('div.grid-error', friendlyError(e.message)));
    updatePanel();
    return;
  }
  renderSheetHead(kind, name);
  state.grid = new Grid($('grid-host'), state.source, gridHooks(kind));
  if (carryDraft && carryDraft.values.length === state.source.columns.length) state.grid.draft = carryDraft;
  await state.grid.reload({ keepSelection: false });
  const grid = state.grid;
  const placed = fromUrl?.sel ? await applySelection(fromUrl.sel) : false;
  if (state.grid !== grid) return; // 当てている間に別のシートへ移った
  if (fromUrl?.sel && !placed) toast(tr('リンクの選択範囲が見つかりませんでした（消えたか、絞り込みで隠れています）'));
  if (!placed) {
    if (view.pos) state.grid.setPos(view.pos);
    // スマホは開いた直後は何も選ばない（スプレッドシートと同じ）
    if (phone.matches) await state.grid.deselect(); else state.grid.focus();
  } else if (!phone.matches) state.grid.focus();
  if (state.urlView) state.urlView.sig = selSig(state.grid);
  state.rangeReady = true;
  setUrl();
  updatePanel();
}

async function reloadSheet() {
  if (!state.key) return;
  const sel = state.grid ? { ...state.grid.cur } : null;
  const scroll = state.grid?.scroll.scrollTop;
  await showSheet(state.key);
  if (state.grid && sel) {
    state.grid.scroll.scrollTop = scroll;
    state.grid.moveTo(sel.r, sel.c);
  }
}

// ---------- シート上部（クエリ編集・絞り込みチップ） ----------
function renderSheetHead(kind, name, error) {
  const head = $('sheet-head');
  const parts = [];
  if (kind === 'q' || kind === 'v') parts.push(queryEditor(kind, name, error));
  const view = viewOf(state.key);
  const chips = el('div.chips',
    view.sorts.length ? el('span.sort-chips', { title: tr('並べ替え（左ほど優先）') },
      view.sorts.flatMap((s, i) => [
        i ? el('span.sort-sep', '›') : null,
        el('span.chip.sort', {
          class: i === 0 && state.justSorted === s.col ? 'flash' : '',
          title: view.sorts.length > 1 ? tr('クリックで昇順／降順を切り替え・ドラッグで優先順位を変更') : tr('クリックで昇順／降順を切り替え'),
          dataset: { i },
          on: { pointerdown: (e) => sortChipPointer(e, i) },
        }, view.sorts.length > 1 ? el('span.chip-grip', '⋮⋮') : null, `${s.dir === 'asc' ? '↑' : '↓'} ${s.col}`,
        el('button.chip-x', { title: tr('この並べ替えを解除'), on: { click: () => removeSort(s.col) } }, '×')),
      ])) : null,
    view.filters.map((f, i) => el('span.chip.filter', {
      title: tr('クリックで編集'),
      on: { click: (e) => { if (!e.target.closest('.chip-x')) filterPopover(e.currentTarget, f.col, i); } },
    }, `${f.col} ${FILTER_OPS.find((o) => o.id === f.op)?.label.replace(/^\S+ /, '') ?? f.op}${FILTER_OPS.find((o) => o.id === f.op)?.noValue ? '' : tr(' 「') + f.value + tr('」')}`,
    el('button.chip-x', { title: tr('絞り込みを解除'), on: { click: () => { view.filters.splice(i, 1); reloadSheet(); } } }, '×'))),
    el('span.grow'),
    kind === 't' && state.source ? el('code.sheet-sql', { title: tr('このシートが実行している SQL') }, state.source.displaySql()) : null,
  );
  // 並べ替え・絞り込みがあるときだけ出す
  if (view.sorts.length || view.filters.length) parts.push(chips);
  head.replaceChildren(...parts);
  updateProtBtn(kind);
}

function queryEditor(kind, name, error) {
  const isView = kind === 'v';
  const obj = isView ? state.objects.find((o) => o.name === name) : state.queries.find((x) => x.name === name);
  const viewParts = isView ? viewSelect(obj.sql) : null;
  const original = isView ? viewParts.select : obj.sql;
  const ta = el('textarea.query-input.mono', {
    value: original, spellcheck: false, readOnly: isView,
    rows: 1,
    on: {
      keydown: (e) => {
        if (modKey(e) && e.key === 'Enter') { e.preventDefault(); run(); }
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
        if (e.key === 'Escape') state.grid?.focus();
      },
      input: () => { dirtyMark.hidden = ta.value === original; },
    },
  });
  // 普段は1行。つまみをドラッグして高さを変える（シートごとに覚える）
  const heights = state.queryHeights ??= new Map();
  const sheetKey = state.key;
  if (heights.has(sheetKey)) ta.style.height = heights.get(sheetKey) + 'px';
  const resizer = el('div.query-resizer', {
    title: tr('ドラッグで高さを変更・ダブルクリックで1行に戻す'),
    on: {
      pointerdown: (e) => {
        e.preventDefault();
        resizer.setPointerCapture(e.pointerId);
        const startY = e.clientY, startH = ta.offsetHeight;
        const move = (ev) => {
          // 最小の高さは CSS の min-height が受け持つ
          const h = Math.max(0, Math.min(window.innerHeight * 0.6, startH + ev.clientY - startY));
          ta.style.height = h + 'px';
        };
        const up = () => {
          resizer.removeEventListener('pointermove', move);
          resizer.removeEventListener('pointerup', up);
          resizer.removeEventListener('pointercancel', up);
          if (ta.style.height) heights.set(sheetKey, ta.offsetHeight);
        };
        resizer.addEventListener('pointermove', move);
        resizer.addEventListener('pointerup', up);
        resizer.addEventListener('pointercancel', up);
      },
      dblclick: () => { ta.style.height = ''; heights.delete(sheetKey); },
    },
  });
  const dirtyMark = el('span.dirty-dot', { hidden: true, title: tr('未実行の変更') }, '●');
  const err = el('div.query-error', error ? friendlyError(error.message) : '');
  async function run() {
    const sql = ta.value.trim().replace(/;+\s*$/, '');
    if (!sql) return;
    try {
      // 読み取りの1文か先に確かめる（「; DELETE …」を後ろに続けられないように）
      await db.checkQuery(sql);
      if (isView) {
        await db.rebuild([{ sql: `DROP VIEW ${q(name)}` }, { sql: `CREATE VIEW ${q(name)}${viewParts.cols} AS ${sql}` }]);
      } else {
        // 保存する前に実行できるか確かめる
        await db.readQuery(`SELECT * FROM (${sql}\n) LIMIT 0`);
        state.queries.find((x) => x.name === name).sql = sql;
        saveQueries();
      }
      state.views.set(state.key, { sorts: [], filters: [] });
      await refreshObjects();
      await showSheet(state.key);
    } catch (e) { err.textContent = friendlyError(e.message); }
  }
  const actions = isView
    ? el('div.query-actions',
      el('span.muted.sm', tr('ビューの定義')),
      el('span.grow'),
      el('button.btn.sm', { on: { click: (e) => { ta.readOnly = false; ta.focus(); ta.select(); e.currentTarget.remove(); saveBtn.hidden = false; } } }, tr('✎ 編集')),
      el('button.btn.sm', { on: { click: () => newQuery(original, name + tr('のクエリ')) } }, tr('クエリとして複製')),
      Object.assign(el('button.btn.primary.sm', { hidden: true, on: { click: run } }, tr('ビューを更新')), {}))
    : el('div.query-actions',
      el('span.muted.sm', tr('{0}Enter で実行', [MOD])), dirtyMark,
      el('span.grow'),
      el('button.btn.sm', { on: { click: () => saveAsView(name, ta.value) } }, tr('◫ ビューとして保存')),
      el('button.btn.primary.sm', { on: { click: run } }, tr('▶ 実行')));
  const saveBtn = actions.querySelector('.btn.primary');
  return el('div.query-box', { class: isView ? 'readonly' : '' }, ta, resizer, actions, err);
}

async function saveAsView(queryName, sql) {
  sql = sql.trim().replace(/;+\s*$/, '');
  const name = await ask($('sheet-head'), { title: tr('ビューの名前'), value: uniqueName(queryName, objNames()), okLabel: tr('作成'), validate: (v) => !v ? tr('名前を入力してください') : objNames().includes(v) ? tr('「{0}」は既にあります', [v]) : null });
  if (!name) return;
  try {
    await db.checkQuery(sql); // 「; DELETE …」を後ろに続けられないように
    await db.exec(`CREATE VIEW ${q(name)} AS ${sql}`);
    // 同名ならクエリをビューに置き換える。別名なら元のクエリを残すか尋ねる
    if (name === queryName || await confirmDialog({ title: tr('ビューを作成しました'), body: tr('元のクエリ「{0}」は削除しますか？', [queryName]), okLabel: tr('削除する') })) {
      state.queries = state.queries.filter((x) => x.name !== queryName);
      saveQueries();
    }
    await refreshObjects();
    await showSheet('v:' + name);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ---------- 並べ替え・絞り込み ----------
/** 並べ替えを一番強い基準として積む（同じ列の古い基準は外す） */
function pushSort(col, dir) {
  const v = viewOf(state.key);
  v.sorts = [{ col, dir }, ...v.sorts.filter((s) => s.col !== col)];
  state.justSorted = col;
  reloadSheet().finally(() => { state.justSorted = null; });
}

function removeSort(col) {
  const v = viewOf(state.key);
  v.sorts = v.sorts.filter((s) => s.col !== col);
  reloadSheet();
}

/** 並べ替えチップ：動かさずに離せば昇順/降順の切り替え、少し動かせばドラッグで順位変更 */
function sortChipPointer(e, from) {
  if (e.button !== 0 || e.target.closest('.chip-x')) return;
  e.preventDefault();
  const chip = e.currentTarget;
  const box = chip.parentElement;
  const sx = e.clientX, sy = e.clientY;
  let dragging = false, to = from;
  const others = () => [...box.querySelectorAll('.chip.sort')].filter((c) => c !== chip);
  const move = (ev) => {
    const dx = ev.clientX - sx;
    if (!dragging) {
      if (Math.hypot(dx, ev.clientY - sy) < 5 || viewOf(state.key).sorts.length < 2) return;
      dragging = true;
      chip.classList.add('dragging');
      box.classList.add('sorting');
    }
    chip.style.transform = `translateX(${dx}px)`;
    // 他のチップの中心より右にいくつ越えたかで挿入位置を決める
    const x = chip.getBoundingClientRect().left + chip.offsetWidth / 2;
    const rest = others();
    to = rest.filter((c) => { const r = c.getBoundingClientRect(); return x > r.left + r.width / 2; }).length;
    rest.forEach((c, k) => c.classList.toggle('drop-before', k === to));
    box.classList.toggle('drop-end', to === rest.length);
  };
  const up = () => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!dragging) { toggleSortDir(from); return; }
    const v = viewOf(state.key);
    if (to !== from) { const [s] = v.sorts.splice(from, 1); v.sorts.splice(to, 0, s); }
    reloadSheet();
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}

function toggleSortDir(i) {
  const s = viewOf(state.key).sorts[i];
  if (!s) return;
  s.dir = s.dir === 'asc' ? 'desc' : 'asc';
  reloadSheet();
}

function filterPopover(anchor, colName, index) {
  const view = viewOf(state.key);
  const cur = index != null ? view.filters[index] : { col: colName, op: 'eq', value: '' };
  const colSel = el('select.input', state.source.columns.map((c) => el('option', { value: c.name, selected: c.name === cur.col }, c.name)));
  const opSel = el('select.input', FILTER_OPS.map((o) => el('option', { value: o.id, selected: o.id === cur.op }, o.label)));
  const val = el('input.input', { value: cur.value ?? '', placeholder: tr('値'), autofocus: true });
  const sync = () => { val.hidden = FILTER_OPS.find((o) => o.id === opSel.value)?.noValue; };
  opSel.addEventListener('change', sync); sync();
  const apply = () => {
    const f = { col: colSel.value, op: opSel.value, value: val.value };
    if (index != null) view.filters[index] = f; else view.filters.push(f);
    closePopover();
    reloadSheet();
  };
  popover(anchor, el('form.filter-form', { on: { submit: (e) => { e.preventDefault(); apply(); } } },
    el('div.ask-title', tr('絞り込み')), colSel, opSel, val,
    el('div.ask-actions',
      index != null ? el('button.btn.danger-text', { type: 'button', on: { click: () => { view.filters.splice(index, 1); closePopover(); reloadSheet(); } } }, tr('解除')) : null,
      el('span.grow'),
      el('button.btn.primary', { type: 'submit' }, tr('適用')))));
}

// ---------- グリッドのフック ----------
function gridHooks(kind) {
  const isTable = kind === 't';
  return {
    onSelect: (s) => {
      document.body.classList.toggle('has-sel', !!s);
      updateFormatButtons();
      dropUrlView();
      // 数式バーで次のセルを打っている最中（前のセルの保存が後から終わったとき）は、打った文字を上書きしない
      if (state.grid?.editing && document.activeElement === $('fx-input')) return;
      updateFx(s ?? undefined);
    },
    onEditState: (editing, text) => {
      document.body.classList.toggle('cell-editing', editing);
      // 書き直し始めたら（セルで打った・記号キーを押した）、✕ を ✓ に戻す
      clearEditError();
      const fx = $('fx-input');
      if (editing) { fx.value = text; fx.placeholder = state.grid.sink.placeholder; } else updateFx();
    },
    onError: (e) => toast(friendlyError(e.message), 'error'),
    // 1セルの入力を確定できなかった。スマホは数式バーで直す（引き受けたら true。PC はこれまで通りグリッドに任せる）
    onEditError: showEditError,
    onInfo: (m) => toast(m),
    onUndo: doUndo,
    onRedo: doRedo,
    onHeaderMenu: (c, anchor) => headerMenu(c, anchor),
    // 列幅の変更も元に戻せるようにする（スプレッドシートと同じ）。別のシートに移っていたら保存値だけ戻す
    // changes: [{name, before, after}]。複数の列をまとめて変えたときも1回で戻る
    onColumnWidth: (key, changes) => {
      const apply = (pick) => {
        if (state.grid?.source.widthKey === key) { state.grid.setColWidths(Object.fromEntries(changes.map((x) => [x.name, pick(x)]))); return; }
        try {
          const all = JSON.parse(localStorage.getItem('w:' + key) || '{}');
          for (const x of changes) { const w = pick(x); if (w == null) delete all[x.name]; else all[x.name] = w; }
          localStorage.setItem('w:' + key, JSON.stringify(all));
        } catch { /* 無視 */ }
      };
      const sheet = state.key;
      undo.push({ label: tr('「{0}」の列幅の変更', [sheet.slice(2)]), sheet, col: changes[0].name, undoFn: () => apply((x) => x.before), redoFn: () => apply((x) => x.after) });
    },
    // セルごとの書式も元に戻せる。before / after: 既定と違うセルのキーの配列
    onFormat: (name, key, before, after) => {
      updateFormatButtons();
      const store = CELL_FORMATS[name].store;
      const apply = (keys) => {
        if (state.grid?.source.widthKey === key) { state.grid.setFormatKeys(name, keys); updateFormatButtons(); return; }
        try { if (keys.length) localStorage.setItem(store + key, JSON.stringify(keys)); else localStorage.removeItem(store + key); } catch { /* 無視 */ }
      };
      const sheet = state.key, f = FORMAT_UI.find((x) => x.name === name);
      undo.push({ label: tr(f.undo, [sheet.slice(2)]), sheet, undoFn: () => apply(before), redoFn: () => apply(after) });
    },
    // 行の高さも同じく元に戻せる。changes: [{id: 行の見分け方, before, after}]
    onRowHeight: (key, changes) => {
      const apply = (pick) => {
        const map = Object.fromEntries(changes.map((x) => [x.id, pick(x)]));
        if (state.grid?.source.widthKey === key) { state.grid.setRowHeights(map); return; }
        try {
          const all = JSON.parse(localStorage.getItem('h:' + key) || '{}');
          for (const [id, h] of Object.entries(map)) { if (h == null) delete all[id]; else all[id] = h; }
          localStorage.setItem('h:' + key, JSON.stringify(all));
        } catch { /* 無視 */ }
      };
      const sheet = state.key;
      undo.push({ label: tr('「{0}」の行の高さの変更', [sheet.slice(2)]), sheet, undoFn: () => apply((x) => x.before), redoFn: () => apply((x) => x.after) });
    },
    onAddColumn: isTable ? (anchor) => quickAddColumn(anchor) : null,
    onContextMenu: (pos, range) => cellMenu(pos, range),
    onReadonlyEdit: (col) => toast(isTable ? (col ? tr('「{0}」は生成列のため編集できません', [col.name]) : tr('編集できません')) : tr('{0}の結果は編集できません。元のテーブルで編集してください', [KIND_NAME[kind]])),
    onBlobEdit: (r, c) => blobMenu(r, c),
    onBlobView: (r, c) => viewBlob(r, c),
    onProtectedEdit: (prots) => toast(tr('🔒 {0}（{1}）', [prots[0].note || tr('保護されています'), describe(state.model, prots[0])])),
    onCellCtrlClick: isTable ? (r, c, row) => {
      const col = state.source.columns[c];
      if (!col.fk || row.values[c] == null) return false;
      jumpToRef(col.fk, row.values[c]);
      return true;
    } : null,
    onFkPick: isTable ? (r, c, anchor) => fkPicker(r, c, anchor) : null,
    onDeleteRows: isTable ? () => deleteSelectedRows() : null,
  };
}

function updateFx(s) {
  const g = state.grid;
  const ref = $('fx-ref'), fx = $('fx-input');
  if (!g || !state.source) { ref.textContent = ''; fx.value = ''; fx.readOnly = true; return; }
  s ??= { r: g.cur.r, c: g.cur.c, row: g.rowAt(g.cur.r), isNew: g.cur.r === g.newRowIndex, col: g.cols[g.cur.c], range: g.range() };
  const col = s.col;
  const draft = s.isNew && g.hasDraft;
  ref.textContent = col ? (s.isNew ? (g.draft ? `✎ ${draft ? tr('未保存') : tr('新しい行')} · ${col.name}` : tr('＋ 行を追加（クリックか Enter）')) : tr('{0} · {1}行目', [col.name, s.r + 1])) : '';
  const v = s.isNew ? (g.draft ? g.draft.values[s.c] : undefined) : s.row?.values[s.c];
  fx.readOnly = !state.source.editable || col?.readonly || v instanceof Uint8Array;
  fx.classList.toggle('null', false);
  // グリッドでフォームを開いたときと同じ文字列（下書きの未入力は空で、INSERT で入るものを placeholder に）
  fx.value = v instanceof Uint8Array ? tr('BLOB（{0} バイト）', [v.length]) : !col ? '' : s.isNew ? (g.draft ? g.formAt(s.r, s.c) : '') : s.row ? formText(v) : '';
  fx.placeholder = s.isNew && g.draft && v === undefined ? g.placeholderFor(s.c) : '';
  updateStatus(s.range);
}

function updateStatus(range) {
  const g = state.grid;
  const st = $('status');
  if (!g) { st.textContent = ''; return; }
  let text = tr('{0} 行', [g.rowCount.toLocaleString()]);
  if (range) {
    const cells = (Math.min(range.r1, g.rowCount - 1) - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (cells > 1 && cells <= 20000) {
      let sum = 0, n = 0;
      for (let r = range.r0; r <= Math.min(range.r1, g.rowCount - 1); r++) {
        const row = g.rowAt(r);
        if (!row) continue;
        for (let c = range.c0; c <= range.c1; c++) { const v = row.values[c]; if (typeof v === 'number') { sum += v; n++; } }
      }
      text = tr('選択 {0} セル', [cells.toLocaleString()]) + (n ? tr(' · 合計 {0} · 平均 {1}', [+sum.toFixed(10), +(sum / n).toFixed(4)]) : '') + ' · ' + text;
    }
  }
  st.textContent = text;
}

// ---------- 式ピッカー（数式バーの fx） ----------
// よく使う組み込み関数の説明。一覧そのものは PRAGMA function_list から取る（この DB で使えるものだけを出す）
const FN_HELP = {
  abs: ['abs(X)', tr('絶対値')], coalesce: ['coalesce(X, Y, …)', tr('最初の NULL でない値')], ifnull: ['ifnull(X, Y)', tr('X が NULL なら Y')],
  iif: [tr('iif(条件, 真, 偽)'), tr('条件で値を選ぶ')], nullif: ['nullif(X, Y)', tr('X と Y が同じなら NULL')],
  length: ['length(X)', tr('文字数')], lower: ['lower(X)', tr('小文字にする')], upper: ['upper(X)', tr('大文字にする')],
  trim: ['trim(X)', tr('前後の空白を取る')], ltrim: ['ltrim(X)', tr('先頭の空白を取る')], rtrim: ['rtrim(X)', tr('末尾の空白を取る')],
  substr: [tr('substr(X, 開始, 長さ)'), tr('部分文字列（1 始まり）')], replace: [tr('replace(X, 探す, 置換)'), tr('文字列を置き換える')],
  instr: [tr('instr(X, 探す)'), tr('見つかった位置（なければ 0）')], printf: [tr('printf(書式, …)'), tr('書式を指定して文字列に')], format: [tr('format(書式, …)'), tr('書式を指定して文字列に')],
  round: [tr('round(X, 桁)'), tr('四捨五入')], max: ['max(X, Y, …)', tr('最大値')], min: ['min(X, Y, …)', tr('最小値')],
  random: ['random()', tr('乱数（整数）')], typeof: ['typeof(X)', tr('値の型の名前')], hex: ['hex(X)', tr('16 進の文字列')],
  date: ["date('now')", tr('日付（YYYY-MM-DD）')], time: ["time('now')", tr('時刻（HH:MM:SS）')], datetime: ["datetime('now')", tr('日時')],
  julianday: ["julianday('now')", tr('ユリウス日（日数の差の計算に）')], strftime: ["strftime('%Y/%m', X)", tr('書式を指定して日時を文字列に')],
  unixepoch: ["unixepoch('now')", tr('UNIX 時刻（秒）')], json_extract: ["json_extract(X, '$.key')", tr('JSON から値を取り出す')],
  json_object: ["json_object('key', X, …)", tr('JSON オブジェクトを作る')], json_array: ['json_array(X, …)', tr('JSON 配列を作る')],
  concat: ['concat(X, Y, …)', tr('文字列をつなぐ')], concat_ws: [tr('concat_ws(区切り, X, …)'), tr('区切り文字でつなぐ')],
};
const EXPR_CONSTS = [
  ['NULL', tr('値なし')], ['CURRENT_TIMESTAMP', tr('今の日時（UTC）')], ['CURRENT_DATE', tr('今日の日付（UTC）')], ['CURRENT_TIME', tr('今の時刻（UTC）')],
  ['TRUE', '1'], ['FALSE', '0'], ['CASE WHEN  THEN  ELSE  END', tr('条件で値を分ける')], [' || ', tr('文字列をつなぐ')],
];
let fnListCache = null;
async function scalarFunctions() {
  if (fnListCache) return fnListCache;
  try {
    const rows = (await db.query(`SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 1 AND type = 's' ORDER BY name`)).rows.map(([n]) => n);
    // 内部向けのもの（sqlite_ や全文検索の補助など）は出さない
    fnListCache = rows.filter((n) => !/^(sqlite_|fts|rtree|geopoly|likelihood|likely|unlikely|load_extension)/.test(n));
  } catch { fnListCache = Object.keys(FN_HELP).sort(); }
  return fnListCache;
}

/** fx：列・関数・定数を選んで、数式バーに =式 を組み立てる */
async function exprPicker(anchor) {
  const fx = $('fx-input');
  if (!state.source) return;
  const g = state.grid;
  // BLOB が入っているセルは式を書けないので、BLOB の操作を出す
  if (g && g.rowAt(g.cur.r)?.values[g.cur.c] instanceof Uint8Array) { blobMenu(g.cur.r, g.cur.c, anchor); return; }
  if (fx.readOnly) { toast(tr('このセルは編集できません')); return; }
  const fns = await scalarFunctions();
  const fileRow = g && g.acceptsBlob(g.cur.c) && g.canEdit(g.cur.r, g.cur.c)
    ? el('button.btn.sm.expr-file', { type: 'button', on: { mousedown: (e) => e.preventDefault(), click: () => { closePopover(); loadFileInto(g.cur.r, g.cur.c); } } }, tr('⤒ ファイルから読み込む…（BLOB）'))
    : null;
  const onNew = g && g.cur.r === g.newRowIndex;
  // スマホ：開く前に打っていた入力欄（数式バーかセル）とカーソル位置を覚えておく。
  // セルで打っていたなら、検索欄へ移っても確定しない（数式バーとセルは同じ文字なので、位置はどちらのものでも使える）
  const ae = document.activeElement;
  const typing = phone.matches && g && (ae === fx || ae === g.sink) ? { input: ae, a: ae.selectionStart, b: ae.selectionEnd } : null;
  if (typing?.input === g?.sink && g.editing) g.sinkFocusKeep = true;
  let picked = false;
  const groups = {
    [tr('関数')]: [...fns.filter((n) => FN_HELP[n]), ...fns.filter((n) => !FN_HELP[n])].map((n) => ({
      // スプレッドシートと同じく関数名は大文字で見せる（SQLite は大文字小文字を区別しない）
      key: n, label: n.toUpperCase(), insert: `${n.toUpperCase()}()`, caret: -1,
      sig: (FN_HELP[n]?.[0] ?? `${n}(…)`).replace(/^\w+/, (m) => m.toUpperCase()), hint: FN_HELP[n]?.[1] ?? tr('SQLite の組み込み関数') })),
    [tr('列')]: state.source.columns.map((c) => ({ key: c.name, label: c.name, insert: q(c.name), sig: q(c.name), hint: tr('同じ行の「{0}」の値{1}', [c.name, c.type ? tr('（{0}）', [c.type]) : '']) })),
    [tr('定数・構文')]: EXPR_CONSTS.map(([v, h]) => ({ key: v, label: v.trim(), insert: v, sig: v.trim(), hint: h, caret: v.startsWith('CASE') ? -'  THEN  ELSE  END'.length + 1 : 0 })),
  };
  let tab = tr('関数'), active = 0, items = [];
  const search = el('input.expr-search', { placeholder: tr('関数や列を検索'), spellcheck: false });
  const tabs = el('div.expr-tabs');
  const list = el('div.expr-list');
  // 右側：選んでいる項目の説明（スプレッドシートの関数ヘルプのカード）
  const help = el('div.expr-help');
  const note = el('div.expr-note', onNew ? tr('新しい行の式では列は使えません。') : tr('選ぶと数式バーに入ります。数式バーで Enter を押すと確定します。'));
  const insert = (it) => {
    picked = true;
    closePopover();
    let v = fx.value, a = typing?.a ?? fx.selectionStart ?? v.length, b = typing?.b ?? fx.selectionEnd ?? v.length;
    // 式でなければ = から始める（全体が選ばれていたら置き換え、そうでなければ今の値は残さない）
    if (!v.startsWith('=')) { v = '='; a = b = 1; }
    const text = v.slice(0, a) + it.insert + v.slice(b);
    const pos = a + it.insert.length + (it.caret || 0);
    fx.value = text;
    fx.focus();
    fx.setSelectionRange(pos, pos);
    // スマホは数式バーの入力をそのままセルの編集に映す（✓・Enter・ほかのタップで確定）
    if (phone.matches) fx.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const render = () => {
    const s = search.value.trim().toLowerCase();
    items = s ? Object.values(groups).flat().filter((it) => it.key.toLowerCase().includes(s) || it.hint.toLowerCase().includes(s)) : groups[tab];
    active = Math.min(active, Math.max(0, items.length - 1));
    tabs.replaceChildren(...Object.keys(groups).map((t) => el('button.expr-tab', {
      class: !s && t === tab ? 'on' : '', type: 'button',
      on: { mousedown: (e) => e.preventDefault(), click: () => { tab = t; search.value = ''; active = 0; render(); } },
    }, t)));
    list.replaceChildren(...items.map((it, i) => el('button.expr-item', {
      class: i === active ? 'on' : '', type: 'button',
      on: { mousedown: (e) => e.preventDefault(), click: () => insert(it), mouseenter: () => { if (active !== i) { active = i; mark(); } } },
    }, el('span.mono.expr-label', it.label))));
    if (!items.length) list.append(el('div.expr-empty', tr('見つかりません')));
    mark();
  };
  // 選択の印と説明だけ更新する（一覧は作り直さない）
  const mark = () => {
    [...list.children].forEach((b, i) => b.classList.toggle('on', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
    const it = items[active];
    help.replaceChildren(...(it ? [el('div.expr-sig.mono', it.sig), el('div.expr-desc', it.hint)] : []));
  };
  search.addEventListener('input', () => { active = 0; render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); mark(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
    if (isEnter(e) && items[active]) { e.preventDefault(); insert(items[active]); }
  });
  render();
  popover(anchor, el('div.expr-picker', fileRow, search, tabs, el('div.expr-body', list, help), note), {
    className: 'expr-pop',
    // スマホで何も選ばずに閉じたら、打っていた入力欄に戻る
    onClose: () => {
      if (picked || !typing) return;
      refocus(typing.input);
      g.sinkFocusKeep = false;
    },
  });
  search.focus();
}

// 確定の Enter か。日本語入力の変換を確定する Enter は除く
// （iPhone の Safari は変換の確定でも isComposing が false の keydown を送ってくる。そのときの keyCode は 229）
function isEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

function onFxKey(e) {
  const g = state.grid;
  if (!g) return;
  if (isEnter(e)) {
    e.preventDefault();
    if (phone.matches) { continueInFx(e.target); return; }
    if (!e.target.readOnly) {
      const onNew = g.cur.r === g.newRowIndex;
      g.setCurrent(e.target.value).then(() => { onNew ? g.moveTo(g.cur.r, g.cur.c + 1) : g.moveTo(g.cur.r + 1, g.cur.c); g.focus(); });
    }
  } else if (e.key === 'Escape') { if (g.editing) g.cancelEdit(); updateFx(); g.focus(); }
}

// ======================================================================
// スマホの入力（狭い画面かつタッチ端末）
// 選んだセルの値は下の数式バーで打つ。打った文字は入力中としてセルに映り、Enter・✓・ほかのタップで確定する。
// 確定できなければ ✓ が ✕（やめる）に変わる。iPhone がキーボードを閉じないよう、カーソルの動かし方に気をつけている
// ======================================================================

// data-keep-input の付いたボタン（✓ ✕ 記号キー fx 左上）は、押しても入力欄から離れたことにしない。
// iPhone は押した瞬間に入力欄からフォーカスを外す（pointerdown を止めても外す）ので、その離脱を「確定」に数えない
let keepInputUntil = 0;
const tappingKeepInput = () => performance.now() < keepInputUntil;
for (const type of ['pointerdown', 'mousedown']) {
  document.addEventListener(type, (e) => {
    if (!e.target.closest?.('[data-keep-input]')) return;
    e.preventDefault();
    keepInputUntil = performance.now() + 1000;
  }, true);
}

// シート画面では、画面の左右端から始まるタッチを止めて、iPhone Safari の「端からスワイプで戻る・進む」をさせない
const EDGE_SWIPE = 10;
document.addEventListener('touchstart', (e) => {
  if (document.body.classList.contains('at-home') || e.touches.length !== 1) return;
  const x = e.touches[0].clientX;
  if (x < EDGE_SWIPE || x > innerWidth - EDGE_SWIPE) e.preventDefault();
}, { passive: false, capture: true });

// いま打っている入力欄（最後にフォーカスした数式バーかセル）
let lastTyping = null;
document.addEventListener('focusin', (e) => {
  if (e.target.id === 'fx-input' || e.target.classList?.contains('grid-sink')) lastTyping = e.target;
}, true);
const typingIn = () => (lastTyping?.isConnected && lastTyping) || state.grid?.sink;

// 入力欄にカーソルを戻す（タップの中で呼べば、iPhone でもキーボードを閉じない）
function refocus(input) {
  if (input && document.activeElement !== input) input.focus({ preventScroll: true });
}

function caretToEnd(input) {
  const n = input.value.length;
  input.setSelectionRange(n, n);
}

// ---------- 数式バー ----------
function onFxFocus(e) {
  // セルの編集から移ってきたときの「確定しない」を戻す
  if (state.grid) state.grid.sinkFocusKeep = false;
  // スマホは続きから打てるよう末尾にカーソル。PC は今まで通り全体を選ぶ
  if (phone.matches) caretToEnd(e.target); else e.target.select();
}

// セルで編集中に数式バーをタップしても、そこで確定せず数式バーで続ける
function onFxPointerDown() {
  const g = state.grid;
  if (phone.matches && g?.editing && document.activeElement === g.sink) g.sinkFocusKeep = true;
}

// 打った文字を、入力中のセルにそのまま映す
function onFxInput(e) {
  const g = state.grid, fx = e.target;
  if (!phone.matches || !g || fx.readOnly) return;
  // 編集を始めると数式バーがセルの元の値に戻されるので、打った文字と位置を先に取っておく
  const text = fx.value, a = fx.selectionStart, b = fx.selectionEnd;
  clearEditError();
  if (!g.editing && !g.beginEdit('edit')) return;
  if (fx.value !== text) { fx.value = text; fx.setSelectionRange(a, b); }
  g.sink.value = text;
  g.placeSink();
}

// ほかの所へ移ったら確定（入力欄まわりのボタン・fx のメニュー・セルの入力欄へ移るときは除く）
function onFxBlur() {
  const g = state.grid;
  if (!phone.matches || !g) return;
  setTimeout(() => {
    const a = document.activeElement, fx = $('fx-input');
    if (!g.editing || a === fx || a === g.sink || a?.closest?.('.popover') || tappingKeepInput()) return;
    // 確定できなかった値のままなら、離れただけでもう一度確定しようとしない（同じエラーを繰り返さない）
    if (hasEditError()) return;
    g.commitEdit({ move: null });
  }, 0);
}

// Enter：確定して下のセルへ移り、数式バーのまま続けて編集する（キーボードを閉じない）。何も打っていなければ下へ移るだけ。
// 保存を待たずに次の編集を始め（待つ間に iPhone がキーボードを閉じないように）、保存できなければ失敗したセルの編集に戻る
function continueInFx(fx) {
  const g = state.grid;
  clearEditError();
  if (g.editing) g.commitEdit({ move: 'down' });
  else g.moveTo(g.cur.r + 1, g.cur.c);
  if (!g.editing && g.beginEdit('edit')) { fx.value = g.sink.value; caretToEnd(fx); }
  refocus(fx);
}

// ---------- ボタン ----------
// ✎：選んだセルの編集を始め、数式バーで打つ
function phoneEditInFx() {
  const g = state.grid, fx = $('fx-input');
  if (!g || !g.beginEdit('edit')) return;
  fx.value = g.sink.value;
  fx.focus();
}

// ✓：確定する。確定できたときだけ入力を終え、できなければ数式バーのまま直せるように残す
async function commitPhoneEdit() {
  const g = state.grid, fx = $('fx-input');
  if (!g) return;
  if (g.editing) {
    if (typingIn() === fx) refocus(fx); // タップで外れたカーソルを、タップの中で戻しておく
    await g.commitEdit({ move: null });
    if (g.editing) return;
  }
  if (document.activeElement === fx) fx.blur();
}

// ✕：確定できなかった入力をやめて元の値に戻し、入力も終える
function cancelPhoneEdit() {
  clearEditError();
  if (state.grid?.editing) state.grid.cancelEdit();
  const fx = $('fx-input');
  if (document.activeElement === fx) fx.blur();
  updateFx();
}

// 記号キー：打っている入力欄（数式バーかセル）のカーソル位置に入れる
function insertSym(k) {
  const g = state.grid;
  if (!g) return;
  const target = typingIn();
  if (target === g.sink && !g.editing && !g.editByTouch()) return;
  refocus(target);
  target.setRangeText(k, target.selectionStart, target.selectionEnd, 'end');
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

// 左上：ふだんは ‹ ホームへ。何か選んでいる間は ✓ 確定して選択を解除、
// 確定できなかった入力があるときは ✕ 入力をやめて選択を解除（数式バーの右の ✓ / ✕ と同じ切り替え）
function onHomeBtn() {
  const g = state.grid;
  if (!phone.matches || !g || !document.body.classList.contains('has-sel')) { goHome(); return; }
  if (hasEditError()) cancelPhoneEdit();
  g.deselect();
}

// ---------- 確定できなかったとき ----------
// グリッドの onEditError：スマホなら知らせ方とカーソルを引き受け、✓ を ✕ に変える（PC はグリッドに任せる）
function showEditError(err) {
  if (!phone.matches) return false;
  const g = state.grid, fx = $('fx-input'), col = g.cols[g.editing.c];
  // 型が合わないときは、どの列に何を入れればよいかを伝える
  toast(/datatype mismatch/i.test(err.message)
    ? tr('「{0}」は {1} の列です。合う値を入れてください', [col.name, col.type || tr('型のある')])
    : friendlyError(err.message), 'error');
  document.body.classList.add('edit-err');
  fx.value = g.sink.value;
  // キーボードが出たままなら、そのまま数式バーで直せるように（閉じていれば数式バーのタップで出る）
  if (document.documentElement.classList.contains('kb-open')) refocus(fx);
  if (document.activeElement === fx) caretToEnd(fx);
  return true;
}

// 確定できなかった入力を直している最中か（✓ の代わりに ✕ を出している間）
function hasEditError() {
  return document.body.classList.contains('edit-err');
}

function clearEditError() {
  if (!hasEditError()) return;
  document.body.classList.remove('edit-err');
  state.grid?.sink.classList.remove('invalid');
}

function headerMenu(c, anchor) {
  const col = state.source.columns[c];
  const isTable = state.key[0] === 't';
  const at = anchor instanceof Element ? anchor : $('sheet-head');
  // 「セル」の欄はこの列のセルが対象なので、列ごと選んでいる範囲の外なら、この列を選んでから（Excel と同じ）
  const sel = state.grid.range();
  if (!state.grid.colSelect || c < sel.c0 || c > sel.c1) state.grid.selectCol(c);
  // 列ごと複数選んでいて c がその中にあれば、選んだ列すべてが対象（複数列ならではの項目だけ）
  const cols = state.grid.resizeCols(c);
  if (cols.length > 1) {
    const names = cols.map((i) => state.source.columns[i].name);
    const items = [
      { header: tr('{0} 列', [cols.length]) },
      ...formatItems(),
      '-', sizeItem('col', cols, anchor),
      ...cellSection('col'),
    ];
    if (isTable) items.push('-',
      { label: tr('{0} 列を保護…', [cols.length]), icon: '🔒', action: () => protect({ kind: 'cols', cols: names }, at) },
      '-',
      { label: tr('{0} 列を削除…', [cols.length]), icon: '🗑', danger: true, disabled: state.model.columns.length <= names.length, action: () => dropColumns(names) });
    return menu(anchor, [...items, ...linkItems()]);
  }
  const items = [
    { header: col.name },
    { label: tr('昇順に並べ替え'), icon: '↑', action: () => pushSort(col.name, 'asc') },
    { label: tr('降順に並べ替え'), icon: '↓', action: () => pushSort(col.name, 'desc') },
    viewOf(state.key).sorts.some((s) => s.col === col.name) ? { label: tr('この列の並べ替えを解除'), icon: '⇅', action: () => removeSort(col.name) } : null,
    { label: tr('絞り込み…'), icon: '⏷', action: () => filterPopover(anchor instanceof Element ? anchor : $('sheet-head'), col.name) },
    '-',
    // 選んでいる範囲（列ごと選んだときは、その列の読み込み済みのセル）
    ...formatItems(),
    '-', sizeItem('col', [c], anchor),
    ...cellSection('col'),
  ];
  if (isTable) {
    items.push('-',
      { label: tr('列の設定…'), icon: '⚙', action: () => togglePanel(true, col.name) },
      { label: tr('名前を変更…'), icon: '✎', action: () => renameColumn(col.name, anchor) },
      { label: tr('列を保護…'), icon: '🔒', action: () => protect({ kind: 'cols', cols: [col.name] }, anchor instanceof Element ? anchor : $('sheet-head')) },
      { label: tr('列を追加…'), icon: tr('＋'), action: () => quickAddColumn(anchor instanceof Element ? anchor : $('sheet-head')) });
    if (col.fk) {
      items.push('-',
        { label: tr('参照先「{0}」を開く', [col.fk.table]), icon: '→', action: () => showSheet('t:' + col.fk.table) },
        { label: tr('「{0}」を結合したクエリを作成', [col.fk.table]), icon: '⋈', action: () => joinQuery(col) });
    }
    items.push('-', { label: tr('列を削除…'), icon: '🗑', danger: true, disabled: state.model.columns.length <= 1, action: () => dropColumn(col.name) });
  }
  menu(anchor, [...items.filter(Boolean), ...linkItems()]);
}

/**
 * 「列の幅を変更…」「行の高さを変更…」。選ぶと同じ場所にサブメニュー（数値で指定・データに合わせる）を出す。
 * kind が 'col' なら targets は列の番号の並び、'row' なら [基準の行]（行ごと選んでいればその範囲が対象）
 */
function sizeItem(kind, targets, anchor) {
  const g = state.grid, col = kind === 'col';
  const at = anchor instanceof Element ? anchor : (anchor?.x != null ? anchor : $('sheet-head'));
  const askAt = anchor instanceof Element ? anchor : $('sheet-head');
  const byNumber = async () => {
    const cur = Math.round(col ? g.colW(targets[0]) : g.rowH(targets[0]));
    const v = await ask(askAt, {
      title: col ? tr('列の幅（px）') : tr('行の高さ（px）'), value: String(cur),
      validate: (s) => /^\d+(\.\d+)?$/.test(s) && +s > 0 ? null : tr('正の数を入力してください'),
    });
    if (v == null) return;
    if (col) g.setColsWidth(targets, +v); else await g.setRowsHeight(targets[0], +v);
  };
  const fit = () => (col ? g.autoFit(targets[0]) : g.autoFitRows(targets[0]));
  return {
    label: col ? tr('列の幅を変更…') : tr('行の高さを変更…'), icon: col ? '↔' : '↕',
    // menu はクリックで閉じてから action を呼ぶので、次の描画で開き直す
    action: () => setTimeout(() => menu(at, [
      { label: tr('数値で指定…'), icon: '#', action: byNumber },
      { label: tr('データに合わせる'), icon: '⤢', action: fit },
    ]), 0),
  };
}

async function renameColumn(name, anchor) {
  const to = await ask(anchor instanceof Element ? anchor : $('sheet-head'), {
    title: tr('列名を変更'), value: name, okLabel: tr('変更'),
    validate: (v) => !v ? tr('名前を入力してください') : v !== name && state.model.columns.some((c) => c.name === v) ? tr('「{0}」は既にあります', [v]) : null,
  });
  if (!to || to === name) return;
  try {
    await db.exec(`ALTER TABLE ${q(state.model.name)} RENAME COLUMN ${q(name)} TO ${q(to)}`);
    const v = viewOf(state.key);
    v.sorts.forEach((s) => { if (s.col === name) s.col = to; });
    v.filters.forEach((f) => { if (f.col === name) f.col = to; });
    await reloadSheet();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function dropColumn(name) { return dropColumns([name]); }

/** 列を削除する。複数なら1回の確認・1回の作り直しでまとめて */
async function dropColumns(names) {
  const many = names.length > 1;
  const title = many ? tr('{0} 列（{1}）を削除しますか？', [names.length, names.join('、')]) : tr('列「{0}」を削除しますか？', [names[0]]);
  const body = many ? tr('これらの列のデータはすべて失われ、元に戻せません。') : tr('この列のデータはすべて失われ、元に戻せません。');
  if (!await confirmDialog({ title, body, okLabel: tr('削除'), danger: true })) return;
  const m = state.model;
  const gone = (n) => names.includes(n);
  try {
    // キー・制約に含まれる列は ALTER TABLE DROP COLUMN できないので作り直す。複数列も1回の作り直しで
    const inKey = names.some((name) => m.pk.includes(name) || m.uniques.some((u) => u.includes(name)) || m.fks.some((f) => f.cols.includes(name)) || m.indexes.some((i) => i.cols.includes(name)));
    if (inKey || many) {
      const { migrationSql } = await import('./schema.js');
      const next = JSON.parse(JSON.stringify(m));
      next.columns = next.columns.filter((c) => !gone(c.name)).map((c) => ({ ...c, from: c.name }));
      next.pk = next.pk.filter((n) => !gone(n));
      next.uniques = next.uniques.map((u) => u.filter((n) => !gone(n))).filter((u) => u.length);
      next.fks = next.fks.filter((f) => !f.cols.some(gone));
      if (!next.pk.length) next.withoutRowid = false;
      await db.rebuild(migrationSql(m, next).map((sql) => ({ sql })));
    } else {
      await db.exec(`ALTER TABLE ${q(m.name)} DROP COLUMN ${q(names[0])}`);
    }
    undo.clear();
    const v = viewOf(state.key);
    v.sorts = v.sorts.filter((s) => !gone(s.col));
    v.filters = v.filters.filter((f) => !gone(f.col));
    await reloadSheet();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function quickAddColumn(anchor) {
  const m = state.model;
  const name = el('input.input', { placeholder: tr('列名'), autofocus: true, value: uniqueName(tr('列'), m.columns.map((c) => c.name)) });
  const type = el('select.input', TYPES.map((t) => el('option', { value: t, selected: t === 'TEXT' }, t)));
  const nn = el('input', { type: 'checkbox' });
  const dflt = el('input.input.mono', { placeholder: tr('既定値（任意）例: 0 / 文字列 / =CURRENT_TIMESTAMP') });
  const fkSel = el('select.input', el('option', { value: '' }, tr('外部キーなし')), tableNames().map((t) => el('option', { value: t }, `→ ${t}`)));
  const err = el('div.field-error');
  const submit = async () => {
    const n = name.value.trim();
    if (!n) { err.textContent = tr('列名を入力してください'); return; }
    if (m.columns.some((c) => c.name === n)) { err.textContent = tr('「{0}」は既にあります', [n]); return; }
    let def = `${q(n)} ${type.value}`;
    if (nn.checked) def += ' NOT NULL';
    // セルのフォームと同じ書き方：普通の文字は値、= で始まれば式、空は既定値なし
    const d = formToDefault(dflt.value, type.value);
    if (d != null) def += ` DEFAULT ${d}`;
    if (fkSel.value) def += ` REFERENCES ${q(fkSel.value)}`;
    try {
      if (constantDefault(d)) await db.exec(`ALTER TABLE ${q(m.name)} ADD COLUMN ${def}`);
      else {
        // 式や CURRENT_* の既定値は ALTER TABLE ADD COLUMN で使えないので、データを保ったまま表を作り直す
        const next = JSON.parse(JSON.stringify(m));
        next.columns = next.columns.map((c) => ({ ...c, from: c.name }));
        next.columns.push({ name: n, type: type.value, notnull: nn.checked, defaultSql: d, check: null, collate: null, generated: null, from: null });
        if (fkSel.value) next.fks.push({ cols: [n], table: fkSel.value, refCols: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
        const stmts = migrationSql(m, next);
        // 単純な列の追加だと思っているはずなので、作り直すことと実行する SQL を見せてから
        const ok = await confirmDialog({
          title: tr('列を追加するために、テーブルを作り直しますか？'),
          body: tr('既定値が式や CURRENT_TIMESTAMP などの列は ALTER TABLE で追加できないため、新しい定義でテーブルを作り直し、データをコピーします。外部キー違反があれば元に戻します。'),
          code: stmts.join(';\n') + ';',
          okLabel: tr('作り直して追加'),
        });
        if (!ok) return;
        await db.rebuild(stmts.map((sql) => ({ sql })));
        undo.clear();
      }
      closePopover();
      await reloadSheet();
      state.grid?.moveTo(state.grid.cur.r, state.model.columns.length - 1);
    } catch (e) { err.textContent = friendlyError(e.message); }
  };
  popover(anchor, el('form.add-col', { on: { submit: (e) => { e.preventDefault(); submit(); } } },
    el('div.ask-title', tr('列を追加')),
    name, type,
    el('label.chk', nn, tr('必須（NOT NULL）')),
    dflt, fkSel, err,
    el('div.ask-actions',
      el('button.btn.link', { type: 'button', on: { click: () => { closePopover(); togglePanel(true); state.panel?.addColumn(); } } }, tr('詳細設定…')),
      el('span.grow'),
      el('button.btn.primary', { type: 'submit' }, tr('追加')))), { align: 'end' });
  setTimeout(() => name.select(), 0);
}

async function joinQuery(col) {
  const m = state.model;
  const ref = await readTable(col.fk.table);
  const a = 'a', b = 'b';
  const sel = [`${a}.*`, ...ref.columns.filter((c) => c.name !== col.fk.refCol).map((c) => `${b}.${q(c.name)} AS ${q(`${ref.name}.${c.name}`)}`)];
  const sql = `SELECT ${sel.join(',\n       ')}\nFROM ${q(m.name)} AS ${a}\nLEFT JOIN ${q(ref.name)} AS ${b} ON ${b}.${q(col.fk.refCol)} = ${a}.${q(col.name)}`;
  await newQuery(sql, `${m.name}×${ref.name}`);
}

async function jumpToRef(fk, value) {
  const key = 't:' + fk.table;
  state.views.set(key, { sorts: [], filters: [{ col: fk.refCol, op: 'eq', value: String(value) }] });
  await showSheet(key);
  toast(tr('「{0}」の {1} = {2} を表示しています（チップの × で解除）', [fk.table, fk.refCol, value]));
}

function fkPicker(r, c, anchor) {
  if (state.grid.editing) state.grid.cancelEdit();
  const col = state.source.columns[c];
  const fk = col.fk;
  const labelCol = state.source.labelCols.get(col.name);
  const input = el('input.input', { placeholder: tr('{0} を検索', [fk.table]), autofocus: true });
  const list = el('div.fk-list');
  let items = [], active = 0;
  const choose = async (v) => {
    closePopover();
    const g = state.grid;
    if (r === g.newRowIndex) { g.draftSet(c, formText(v)); g.render(); g.emitSelect(); }
    else await g.write([{ r, c, value: v == null ? null : String(v) }]);
    state.grid.focus();
  };
  const renderList = () => {
    list.replaceChildren(...items.map(([v, label], i) => el('button.fk-item', {
      class: i === active ? 'on' : '',
      on: { mousedown: (e) => { e.preventDefault(); choose(v); } },
    }, el('span.fk-v', String(v)), label != null ? el('span.fk-l', String(label)) : null)),
    !items.length ? el('div.muted.pad', tr('該当なし')) : '');
  };
  const search = async () => {
    const s = input.value.trim();
    const lsel = labelCol ? `, ${q(labelCol)}` : ', NULL';
    const where = s ? ` WHERE CAST(${q(fk.refCol)} AS TEXT) LIKE ?1${labelCol ? ` OR ${q(labelCol)} LIKE ?1` : ''}` : '';
    try {
      const res = await db.query(`SELECT ${q(fk.refCol)}${lsel} FROM ${q(fk.table)}${where} ORDER BY 1 LIMIT 100`, s ? [`%${s}%`] : undefined);
      items = res.rows; active = 0; renderList();
    } catch (e) { list.replaceChildren(el('div.field-error', friendlyError(e.message))); }
  };
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderList(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); list.children[active]?.scrollIntoView({ block: 'nearest' }); }
    if (isEnter(e)) { e.preventDefault(); if (items[active]) choose(items[active][0]); }
  });
  popover(anchor, el('div.fk-picker', el('div.ask-title', `→ ${fk.table}.${fk.refCol}`), input, list,
    col.readonly ? null : el('button.btn.sm.link', { on: { click: () => choose(null) } }, tr('NULL にする'))), { onClose: () => state.grid?.focus() });
  search();
}

/**
 * メニューの「貼り付け」。画像も読めるよう clipboard.read() を先に試し、
 * 使えない・許可されないときは readText() に戻す（Safari は read() に制限がある）
 */
async function pasteFromMenu(g) {
  if (navigator.clipboard?.read) {
    try {
      let image = null, text = '', html = '';
      for (const item of await navigator.clipboard.read()) {
        const it = item.types.find((t) => t.startsWith('image/'));
        if (it && !image) image = await item.getType(it);
        if (item.types.includes('text/plain') && !text) text = await (await item.getType('text/plain')).text();
        if (item.types.includes('text/html') && !html) html = await (await item.getType('text/html')).text();
      }
      if (image || text || html) return g.pasteClipboard({ file: image, text, html });
    } catch { /* 下の readText() に任せる */ }
  }
  try { g.paste(await navigator.clipboard.readText()); } catch { toast(tr('{0}V で貼り付けてください', [MOD])); }
}

/**
 * 選択範囲のセルへの書き込み（貼り付け・値のクリア・下へコピー）。テーブルのときだけ。
 * scope が 'col' / 'row' なら、列・行のメニューの「セル」の欄として出す（ラベルで削除と区別する）
 */
function rangeItems(scope) {
  if (state.key[0] !== 't') return [];
  const g = state.grid;
  const { r0, r1 } = g.range();
  const n = Math.max(0, Math.min(r1, g.rowCount - 1) - r0 + 1);
  const nc = g.range().c1 - g.range().c0 + 1;
  const clearLabel = scope === 'col' ? (nc > 1 ? tr('{0} 列の値をクリア（NULL）', [nc]) : tr('この列の値をクリア（NULL）'))
    : scope === 'row' ? (n > 1 ? tr('{0} 行の値をクリア（NULL）', [n]) : tr('この行の値をクリア（NULL）')) : tr('値をクリア（NULL）');
  const clear = async () => {
    if (n >= 1000 && !await confirmDialog({ title: tr('{0} 行の値を NULL にしますか？', [n]), body: tr('{0}Z で元に戻せます。', [MOD]), okLabel: tr('クリア'), danger: true })) return;
    g.clearSelection();
  };
  const items = [
    { label: tr('貼り付け'), icon: '📋', kbd: `${MOD}V`, action: () => pasteFromMenu(g) },
    { label: clearLabel, icon: '⌫', kbd: 'Delete', action: clear },
  ];
  const { c0, c1 } = g.range();
  // 1つのセルでは出さない。1行だけの範囲は出すが押せない（行のメニューでは意味がないので出さない）
  if (scope !== 'row' && !(r0 === r1 && c0 === c1)) items.push({ label: tr('下へコピー'), icon: '⇣', kbd: `${MOD}D`, disabled: r1 <= r0, action: () => g.fillDown() });
  return items;
}

/** 列・行のメニューに足す「セル」の欄（コピーはビュー・クエリでも出す） */
function cellSection(scope) {
  const g = state.grid;
  return ['-', { header: tr('セル') },
    { label: tr('コピー'), icon: '⧉', kbd: `${MOD}C`, action: () => g.copy() },
    ...rangeItems(scope)];
}

/**
 * 表の中の右クリック・長押しのメニュー。選び方ごとに、その対象に関することだけを出す
 * - 列ごと選んでいる → 列のメニュー（headerMenu）
 * - 行ごと選んでいる → 行のメニュー（1行 / n 行）
 * - それ以外 → セルのメニュー（1つのセル / 範囲）
 */
async function cellMenu(pos, range) {
  const g = state.grid;
  if (g.colSelect && !g.rowSelect) return headerMenu(range.c0, pos);
  const isTable = state.key[0] === 't';
  const copy = { label: tr('コピー'), icon: '⧉', kbd: `${MOD}C`, action: () => g.copy() };
  const unprotectHere = () => g.protAt(g.cur.r, g.cur.c)
    .map((p) => ({ label: tr('保護を外す：{0}', [p.note || describe(state.model, p)]), icon: '🔓', action: () => unprotect(p) }));
  if (g.rowSelect && !g.colSelect) {
    const rows = Math.min(range.r1, g.rowCount - 1) - range.r0 + 1;
    const many = rows > 1;
    const items = [many ? { header: tr('{0} 行', [rows]) } : null, rows >= 1 ? sizeItem('row', [range.r0], pos) : null];
    if (isTable) items.push('-',
      { label: many ? tr('{0} 行を複製', [rows]) : tr('行を複製'), icon: '⧉', disabled: rows < 1, action: async () => { try { await state.source.duplicateRows(await g.rowsBetween(range.r0, range.r0 + rows - 1)); await g.reload(); } catch (e) { toast(friendlyError(e.message), 'error'); } } },
      '-',
      { label: many ? tr('{0} 行を保護…', [rows]) : tr('行を保護…'), icon: '🔒', disabled: rows < 1, action: () => protectSelection(pos) },
      ...unprotectHere());
    items.push(...cellSection('row'));
    items.push(...linkItems());
    if (isTable) items.push('-',
      { label: many ? tr('{0} 行を削除', [rows]) : tr('行を削除'), icon: '🗑', kbd: `${MOD}-`, danger: true, disabled: rows < 1, action: () => deleteSelectedRows() });
    return menu(pos, items.filter(Boolean));
  }
  const single = range.r0 === range.r1 && range.c0 === range.c1;
  const items = [copy];
  const { r, c } = g.cur;
  if (single) {
    const cv = r === g.newRowIndex ? g.draft?.values[c] : g.rowAt(r)?.values[c];
    const blobItems = [];
    if (cv instanceof Uint8Array && r !== g.newRowIndex) {
      const a = blobActions(r, c);
      blobItems.push({ label: tr('BLOB を表示'), icon: '🔍', action: () => viewBlob(r, c) }, { label: tr('ダウンロード'), icon: '⤓', action: a.download });
    }
    // BLOB 型か型のない列なら、NULL のセルや新しい行でもファイルを入れられる
    if (g.acceptsBlob(c) && g.canEdit(r, c)) blobItems.push({ label: tr('ファイルから読み込む…'), icon: '⤒', action: () => loadFileInto(r, c) });
    if (blobItems.length) items.unshift(...blobItems, '-');
  }
  if (isTable) {
    items.push(...rangeItems());
    if (r !== g.newRowIndex) items.push('-', { label: single ? tr('セルを保護…') : tr('範囲を保護…'), icon: '🔒', action: () => protectSelection(pos) }, ...unprotectHere());
    const col = state.source.columns[c];
    const v = g.rowAt(r)?.values[c];
    if (single && col?.fk && v != null) items.push('-', { label: tr('参照先の行を開く（{0}）', [col.fk.table]), icon: '→', kbd: tr('{0}クリック', [MOD]), action: () => jumpToRef(col.fk, v) });
  }
  items.push(...linkItems());
  menu(pos, items);
}

// ---------- 保護（トリガーで書き込みを拒否する） ----------
/** 別のシートのタブから操作したときは、そのシートを開いてから */
async function withSheet(key, fn) {
  if (state.key !== key) await showSheet(key);
  if (state.key === key) fn();
}

/** 選択範囲から保護の対象を決める：列全体 → 列、行全体 → 行、それ以外 → 範囲 */
async function protectSelection(anchor) {
  const g = state.grid, m = state.model;
  const { r0, r1, c0, c1 } = g.range();
  const cols = m.columns.slice(c0, c1 + 1).map((c) => c.name);
  const wholeCols = g.colSelect || (r0 === 0 && r1 >= g.rowCount - 1 && g.rowCount > 1);
  if (wholeCols) return protect({ kind: 'cols', cols }, anchor);
  if (!canProtectRows(m)) { toast(tr('主キーのない表では、行や範囲は保護できません（列やシート全体は保護できます）'), 'error'); return; }
  const last = Math.min(r1, g.rowCount - 1);
  if (last < r0) return;
  if (last - r0 >= 1000) { toast(tr('一度に保護できるのは 1000 行までです'), 'error'); return; }
  const pkIdx = m.pk.map((p) => m.columns.findIndex((c) => c.name === p));
  const keys = (await g.rowsBetween(r0, last)).filter(Boolean)
    .map((row) => pkIdx.map((i) => { const v = row.values[i]; return typeof v === 'bigint' && Number.isSafeInteger(Number(v)) ? Number(v) : v; }));
  const wholeRows = c0 === 0 && c1 === m.columns.length - 1;
  return protect(wholeRows ? { kind: 'rows', keys } : { kind: 'range', cols, keys }, anchor);
}

async function protect(spec, anchor) {
  const what = describe(state.model, spec);
  const note = await ask(anchor, { title: tr('🔒 {0}を保護', [what]), placeholder: tr('説明（任意）例：4月分は確定済み'), okLabel: tr('保護する') });
  if (note === null) return;
  try {
    const names = (await db.query(`SELECT name FROM sqlite_schema WHERE type = 'trigger'`)).rows.map(([n]) => n);
    await db.batch(protectSql(state.model, { ...spec, note }, names));
    await refreshObjects();
    await reloadSheet();
    toast(tr('🔒 {0}を保護しました', [what]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function unprotect(p) {
  if (!p) return;
  const what = describe(state.model, p);
  const body = tr('{0} {1}{2}。外すと、この範囲を編集できるようになります。', [PROT_ICON[p.kind], what, p.note ? tr('「{0}」', [p.note]) : '']);
  if (!await confirmDialog({ title: tr('保護を外しますか？'), body, okLabel: tr('外す') })) return;
  try {
    await db.batch(unprotectSql(p));
    await refreshObjects();
    await reloadSheet();
    toast(tr('🔓 {0}の保護を外しました', [what]));
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function updateProtBtn(kind = state.key?.[0]) {
  const b = $('prot-btn'), n = kind === 't' ? state.prots?.length || 0 : 0;
  b.disabled = kind !== 't';
  b.title = kind === 't' ? tr('シートと範囲の保護') : tr('保護できるのはテーブルだけです');
  $('prot-n').hidden = !n;
  $('prot-n').textContent = n;
}

/** このシートの保護：一覧（クリックで範囲を選択、🔓 で外す）と、新しく保護する入口 */
function protPanel(anchor) {
  const name = state.key.slice(2), locked = state.lockedSheets?.has(name);
  popover(anchor, el('div.prot-panel',
    protSection(state.model),
    el('div.prot-actions',
      locked ? null : el('button.btn.sm', { on: { click: () => { closePopover(); protect({ kind: 'sheet' }, anchor); } } }, tr('🔒 シート全体を保護…')),
      el('button.btn.sm', { disabled: !state.grid, on: { click: () => { closePopover(); protectSelection(anchor); } } }, tr('▦ 選択範囲を保護…')))),
  { align: 'start' });
}

function protSection(m) {
  return el('div',
    el('div.ask-title', tr('🔒 保護されたシートと範囲')),
    state.prots?.length ? null : el('div.prot-empty', tr('このシートには保護がありません。')),
    el('div.prot-list', (state.prots || []).map((p) => el('div.prot-item', {
      title: tr('クリックで範囲を選択'),
      on: { click: (e) => { if (!e.target.closest('button')) { closePopover(); selectProtection(p); } } },
    },
    el('span.prot-icon', PROT_ICON[p.kind]),
    el('div.prot-text', el('div.prot-note', p.note || describe(m, p)), p.note ? el('div.prot-what', describe(m, p)) : null),
    el('button.btn.sm', { title: tr('保護を外す'), on: { click: () => { closePopover(); unprotect(p); } } }, tr('🔓 外す'))))),
    el('div.prot-foot', tr('範囲は、選んでから下のボタンか右クリック →「範囲を保護…」で')));
}

/** 保護の範囲をグリッドで選択する（先頭 5000 行の中で探す） */
async function selectProtection(p) {
  const g = state.grid, m = state.model;
  const cIdx = (p.cols || []).map((n) => m.columns.findIndex((c) => c.name === n)).filter((i) => i >= 0);
  const c0 = cIdx.length ? Math.min(...cIdx) : 0, c1 = cIdx.length ? Math.max(...cIdx) : m.columns.length - 1;
  let r0 = 0, r1 = Math.max(0, g.rowCount - 1);
  if (p.keys) {
    const rows = g.rowCount ? await g.rowsBetween(0, Math.min(g.rowCount, 5000) - 1) : [];
    const hits = rows.map((row, r) => (row && g.protAt(r, c0).includes(p) ? r : -1)).filter((r) => r >= 0);
    if (!hits.length) { toast(tr('保護された行が見つかりません（絞り込みで隠れているかもしれません）')); return; }
    r0 = Math.min(...hits); r1 = Math.max(...hits);
  }
  g.cur = { r: r0, c: c0 }; g.ext = { r: r1, c: c1 };
  g.ensureVisible(); g.render(); g.emitSelect(); g.focus();
}

async function deleteSelectedRows() {
  const g = state.grid;
  const { r0, r1 } = g.range();
  const last = Math.min(r1, g.rowCount - 1);
  if (last < r0) return;
  const rows = await g.rowsBetween(r0, last);
  try {
    await state.source.deleteRows(rows.filter(Boolean));
    await g.reload();
    g.moveTo(r0, g.cur.c);
    toast(tr('{0} 行を削除しました（{1}Z で元に戻せます）', [rows.length, MOD]));
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

/** BLOB のセルの操作（ファイルから読み込む・ダウンロード・NULL にする） */
function blobActions(r, c) {
  const g = state.grid;
  const row = g.rowAt(r);
  const v = row?.values[c];
  return {
    v,
    load: () => loadFileInto(r, c),
    download: () => { const k = sniff(v); download(v, `${state.source.columns[c].name}.${k.ext}`, k.mime); },
    clear: () => g.write([{ r, c, value: null }]),
  };
}

/** ファイルを選んで、そのセルに BLOB として入れる（新しい行なら下書きに入れるだけ） */
async function loadFileInto(r, c) {
  const f = await pickFile('');
  if (!f) return;
  const g = state.grid;
  await g.pasteBlob(new Uint8Array(await f.arrayBuffer()), [c], { r0: r, r1: r });
}

function blobMenu(r, c, anchor) {
  const g = state.grid;
  const a = blobActions(r, c);
  const cellEl = anchor || g.body.querySelector(`.gr[data-r="${r}"] .gc[data-c="${c}"]`) || g.sink;
  menu(cellEl, [
    { label: tr('表示'), icon: '🔍', disabled: !(a.v instanceof Uint8Array), action: () => viewBlob(r, c) },
    { label: tr('ファイルから読み込む…'), icon: '⤒', action: a.load },
    { label: tr('ダウンロード'), icon: '⤓', disabled: !(a.v instanceof Uint8Array), action: a.download },
    { label: tr('NULL にする'), icon: '⌫', action: a.clear },
  ]);
}

/** BLOB の中身を大きく見る（画像・動画・音声・PDF・テキスト・JSONB・16 進ダンプ） */
function viewBlob(r, c) {
  const g = state.grid;
  const a = blobActions(r, c);
  const v = a.v;
  if (!(v instanceof Uint8Array)) return;
  const k = sniff(v);
  const editable = g.canEdit(r, c);
  const meta = el('span.muted', `${v.length ? k.label : 'BLOB'} · ${fmtBytes(v.length)}`);
  let url;
  const body = el('div.blob-view-body');
  const objectUrl = () => (url ??= URL.createObjectURL(new Blob([v], { type: k.mime })));
  const showHex = () => body.replaceChildren(
    el('pre.blob-view-hex', hexDump(v, { max: 4096, width: innerWidth < 600 ? 8 : 16 })),
    v.length > 4096 ? el('p.muted', tr('先頭 4096 バイトだけを表示しています')) : '');
  const kind = k.mime.split('/')[0];
  if (!v.length) {
    body.append(el('p.muted', tr('空の BLOB です（0 バイト）')));
  } else if (k.image) {
    // SVG も <img> で見せる（<img> の中ではスクリプトも外部の読み込みも動かない）
    const img = el('img.blob-view-img', { src: objectUrl(), alt: '', title: tr('クリックで原寸 ↔ 画面に収める') });
    img.addEventListener('load', () => meta.textContent = `${k.label} · ${img.naturalWidth}×${img.naturalHeight} · ${fmtBytes(v.length)}`, { once: true });
    body.append(img);
    img.addEventListener('click', () => body.classList.toggle('actual'));
  } else if (kind === 'video' || kind === 'audio') {
    const media = el(`${kind}.blob-view-media`, { src: objectUrl(), controls: true, preload: 'metadata' });
    // ブラウザが再生できない形式なら 16 進ダンプに切り替える
    media.addEventListener('error', () => { showHex(); meta.textContent += tr('（このブラウザでは再生できません）'); }, { once: true });
    body.append(media);
  } else if (k.mime === 'application/pdf') {
    // Chrome の PDF ビューアは sandbox 付きの iframe では動かないので付けない（中身は PDF で、ページのスクリプトには触れない）
    body.classList.add('pdf');
    body.append(el('iframe.blob-view-pdf', { src: objectUrl(), title: 'PDF' }),
      el('p.muted', tr('表示されないときは「ダウンロード」で保存して開いてください')));
  } else if (k.text) {
    const text = asText(v) ?? '';
    const max = 16384;
    body.append(el('pre.blob-view-text', text.length > max ? text.slice(0, max) + '\n…' : text));
  } else {
    showHex();
    // JSONB には目印のバイトがないので、SQLite に読ませてみる（object / array のときだけ JSONB とみなす）
    if (k.ext === 'bin') {
      db.query('SELECT json_type(?1), json_pretty(?1)', [v]).then(({ rows: [[type, pretty]] }) => {
        if ((type !== 'object' && type !== 'array') || !body.isConnected) return;
        meta.textContent = `JSONB · ${fmtBytes(v.length)}`;
        body.replaceChildren(el('pre.blob-view-text', pretty));
      }).catch(() => { /* JSONB ではない */ });
    }
  }
  let dlg;
  const done = (fn) => () => { dlg.close(); fn(); };
  dlg = modal([
    el('div.blob-view-head', el('h2', state.source.columns[c].name), meta),
    body,
    el('div.modal-actions',
      editable ? el('button.btn', { on: { click: done(a.load) } }, tr('⤒ 読み込む…')) : null,
      el('button.btn', { on: { click: a.download } }, tr('⤓ ダウンロード')),
      editable ? el('button.btn', { on: { click: done(a.clear) } }, '⌫ NULL') : null,
      el('button.btn.primary', { autofocus: true, on: { click: () => dlg.close() } }, tr('閉じる'))),
  ], { className: 'blob-view', onClose: () => { if (url) URL.revokeObjectURL(url); g.focus(); } });
}

// ---------- 設計パネル ----------
function togglePanel(force, focusCol) {
  state.panelOpen = force ?? !state.panelOpen;
  updatePanel(focusCol);
}

function updatePanel(focusCol) {
  const panel = $('panel');
  const btn = $('panel-btn');
  const isTable = state.key?.[0] === 't' && state.model;
  btn.disabled = !isTable;
  btn.classList.toggle('on', state.panelOpen && !!isTable);
  if (!state.panelOpen || !isTable) { panel.hidden = true; state.panel = null; return; }
  panel.hidden = false;
  const prev = state.panel;
  if (prev && prev.model.name === state.model.name) {
    // 同じテーブル：未編集なら最新の定義に差し替える
    prev.ctx.tables = tableNames();
    if (!prev.dirty && prev.model.sql !== state.model.sql) { prev.setModel(state.model); prev.render(); }
    if (focusCol) prev.focusColumn(focusCol);
    return;
  }
  state.panel = new DesignPanel(panel, state.model, {
    tables: tableNames(),
    focusCol,
    tab: prev?.tab,
    onClose: () => togglePanel(false),
    // 名前だけの変更は元に戻せる（それ以外の設計の変更は、今までどおり記録を消す）
    onRename: async (r) => {
      await renameSchema(r);
      const back = { fromTable: r.toTable, toTable: r.fromTable, cols: r.cols.map(([a, b]) => [b, a]) };
      undo.push({
        label: r.cols.length
          ? tr('「{0}」の列名の変更（{1}）', [r.toTable, r.cols.map(([a, b]) => `${a}→${b}`).join(tr('、'))])
          : tr('テーブル「{0}」→「{1}」の名前の変更', [r.fromTable, r.toTable]),
        undoSheet: 't:' + r.fromTable, redoSheet: 't:' + r.toTable,
        undoCols: r.cols.map(([a]) => a), redoCols: r.cols.map(([, b]) => b),
        undoFn: () => renameSchema(back),
        redoFn: () => renameSchema(r),
      });
    },
    onApplied: async (newName, opts) => {
      if (!opts?.quiet) undo.clear();
      const key = 't:' + newName;
      if (key !== state.key) {
        const v = state.views.get(state.key); if (v) state.views.set(key, v);
        renameInOrder(state.key, key);
      }
      await refreshObjects();
      const v = viewOf(key);
      const valid = new Set(state.panel.model.columns.map((c) => c.name));
      v.sorts = v.sorts.filter((s) => valid.has(s.col));
      v.filters = v.filters.filter((f) => valid.has(f.col));
      await showSheet(key);
    },
  });
}

// ---------- CSV ----------
async function exportCsv(key) {
  const kind = key[0], name = key.slice(2);
  const sql = kind === 'q' ? state.queries.find((x) => x.name === name).sql : `SELECT * FROM ${q(name)}`;
  try {
    const r = await db.query(sql);
    const esc = (v) => { if (v == null) return ''; const s = v instanceof Uint8Array ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
    const csv = '﻿' + [r.columns.map(esc).join(','), ...r.rows.map((row) => row.map(esc).join(','))].join('\r\n');
    await exportFile(new TextEncoder().encode(csv), `${name}.csv`, 'text/csv');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function importCsv() {
  const f = await pickFile('.csv,.tsv,.txt,text/csv');
  if (!f) return;
  const text = (await f.text()).replace(/^﻿/, '');
  const { parseTsv } = await import('./grid.js');
  const tsv = f.name.endsWith('.tsv') || (text.split('\n')[0].includes('\t') && !text.split('\n')[0].includes(','));
  const rows = tsv ? parseTsv(text) : parseCsv(text);
  if (rows.length < 1) { toast(tr('データがありません'), 'error'); return; }
  const header = rows[0].map((h, i) => h.trim() || tr('列{0}', [i + 1]));
  const data = rows.slice(1).filter((r) => r.some((v) => v !== ''));
  // 列の型を推定
  const types = header.map((_, i) => {
    const vals = data.map((r) => r[i]).filter((v) => v != null && v !== '');
    if (vals.length && vals.every((v) => /^[-+]?\d+$/.test(v.trim()))) return 'INTEGER';
    if (vals.length && vals.every((v) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim()))) return 'REAL';
    return 'TEXT';
  });
  const name = await ask($('tabs'), { title: tr('{0} 行・{1} 列を新しいテーブルに', [data.length, header.length]), value: uniqueName(f.name.replace(/\.\w+$/, ''), objNames()), okLabel: tr('作成'), validate: (v) => !v ? tr('名前を入力してください') : objNames().includes(v) ? tr('「{0}」は既にあります', [v]) : null });
  if (!name) return;
  const cols = header.map((h, i) => `  ${q(h)} ${types[i]}`).join(',\n');
  const ins = `INSERT INTO ${q(name)} (${header.map(q).join(', ')}) VALUES (${header.map(() => '?').join(', ')})`;
  try {
    await db.batch([
      { sql: `CREATE TABLE ${q(name)} (\n${cols}\n) STRICT` },
      ...data.map((r) => ({ sql: ins, bind: header.map((_, i) => (r[i] == null || r[i] === '' ? null : convertInput(r[i], types[i]))) })),
    ]);
    await refreshObjects();
    await showSheet('t:' + name);
    toast(tr('{0} 行を読み込みました', [data.length]), 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- コマンドパレット ----------
function palette() {
  if (!state.dbName) return;
  const commands = [
    ...allKeys().map((k) => ({ label: k.slice(2), hint: KIND_NAME[k[0]], icon: KIND_ICON[k[0]], run: () => showSheet(k) })),
    { label: tr('新しいテーブル'), icon: tr('＋'), run: () => newTable($('tabs')) },
    { label: tr('新しいクエリ'), icon: tr('＋'), run: () => newQuery() },
    { label: tr('SQL コンソールを開く'), icon: '⌨', run: () => toggleConsole(true) },
    state.model ? { label: tr('テーブルの設計を開く'), icon: '⚙', run: () => togglePanel(true) } : null,
    state.manual ? null : { label: tr('DB をファイルに書き出す'), icon: '⤓', run: () => exportCurrent() },
    ...(state.inTx
      ? [{ label: tr('トランザクションを確定（COMMIT）'), icon: '✓', run: commitTx },
        { label: tr('トランザクションを取り消し（ROLLBACK）'), icon: '↶', run: rollbackTx }]
      : [{ label: tr('トランザクションを開始'), icon: '⧗', run: beginTx }]),
    { label: tr('CSV からテーブルを作成'), icon: '⤒', run: importCsv },
    { label: tr('共有…'), icon: '🔗', run: shareDialog },
    state.manual ? { label: state.manual.kind === 'url' ? tr('データベースとして保存') : tr('ファイルに保存'), icon: '💾', run: () => saveFile() } : null,
    ...state.dbs.filter((n) => n !== state.dbName).map((n) => ({ label: n, hint: tr('DB を開く'), icon: appIcon(), run: () => openDb(n) })),
  ].filter(Boolean);
  const input = el('input.input.palette-input', { placeholder: tr('シートやコマンドを検索…'), autofocus: true });
  const list = el('div.palette-list');
  let items = commands, active = 0;
  const render = () => list.replaceChildren(...items.map((c, i) => el('button.palette-item', {
    class: i === active ? 'on' : '',
    on: { mousedown: (e) => { e.preventDefault(); closePopover(); c.run(); } },
  }, el('span.mi-icon', c.icon), el('span.mi-label', c.label), c.hint ? el('span.muted.sm', c.hint) : null)));
  input.addEventListener('input', () => {
    const s = input.value.toLowerCase();
    items = commands.filter((c) => c.label.toLowerCase().includes(s) || (c.hint || '').toLowerCase().includes(s));
    active = 0; render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    if (isEnter(e) && items[active]) { e.preventDefault(); closePopover(); items[active].run(); }
  });
  render();
  popover({ x: innerWidth / 2 - 260, y: 72 }, el('div.palette', input, list), { className: 'palette-pop', onClose: () => state.grid?.focus() });
}

// PWA：アプリのファイルを端末に保存して電波なしでも起動できるようにする（sw.js）。
// あわせて、ブラウザが容量を空けるときに DB（OPFS）を消さないよう頼んでおく
if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
navigator.storage?.persist?.().catch(() => {});

boot();
