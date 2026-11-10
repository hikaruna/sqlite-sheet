// アプリ本体：DB・シートの管理、画面の組み立て
import { db, q } from './db-client.js';
import { el, toast, menu, popover, closePopover, ask, confirmDialog, pickFile, download, modKey, isMac } from './ui.js';
import { listObjects, readTable, createTableSql, APP_PREFIX, TYPES, affinity } from './schema.js';
import { Grid } from './grid.js';
import { TableSource, QuerySource, FILTER_OPS, friendlyError, convertInput, formText, formToDefault } from './sources.js';
import { DesignPanel } from './design-panel.js';
import { SqlConsole } from './console.js';
import { undo } from './undo.js';
import { createSample } from './sample.js';
import { readProtections, protectSql, unprotectSql, protectionChecker, canProtectRows, describe, KIND_ICON as PROT_ICON } from './protect.js';

const QT = APP_PREFIX + 'queries';
const MOD = isMac ? '⌘' : 'Ctrl+';

const $ = (id) => document.getElementById(id);
const state = {
  dbName: null,
  dbs: [],
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
    if (!navigator.storage?.getDirectory) throw new Error('このブラウザは OPFS（Origin Private File System）に対応していません。');
    const info = await db.init();
    $('version').textContent = `SQLite ${info.version}`;
  } catch (e) {
    return showFatal(e);
  }
  state.dbs = await db.list();
  addEventListener('hashchange', route);
  await route();
}

function showFatal(e) {
  const msg = String(e?.message || e);
  const busy = /access handle|NoModificationAllowed|locked|InvalidState/i.test(msg);
  $('app').replaceChildren(el('div.fatal',
    el('h1', busy ? '別のタブで開かれています' : '起動できませんでした'),
    el('p', busy
      ? 'SQLiteシートは同時に1つのタブでしか使えません。他のタブを閉じてから再試行してください。'
      : msg),
    busy ? null : el('p.muted', 'http(s) で配信されたページを、最近の Chrome / Edge / Firefox / Safari で開いてください。'),
    el('button.btn.primary', { on: { click: () => location.reload() } }, '再試行')));
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { dbName: parts[0] || null, key: parts[1] || null };
}

function setHash() {
  const h = '#/' + [state.dbName, state.key].filter(Boolean).map(encodeURIComponent).join('/');
  if (location.hash !== h) history.replaceState(null, '', h);
  document.title = [state.key?.slice(2), state.dbName, 'SQLiteシート'].filter(Boolean).join(' · ');
}

async function route() {
  let { dbName, key } = parseHash();
  if (!dbName) dbName = localStorage.getItem('last-db');
  if (!dbName || !state.dbs.includes(dbName)) {
    if (parseHash().dbName && !state.dbs.includes(parseHash().dbName)) toast(`DB「${parseHash().dbName}」は見つかりません`, 'error');
    return showWelcome();
  }
  if (dbName !== state.dbName) await openDb(dbName, key);
  else if (key && key !== state.key) await showSheet(key);
}

// ======================================================================
// 画面の骨組み
// ======================================================================
function buildChrome() {
  $('app').replaceChildren(
    el('header.topbar',
      el('button#db-btn.db-btn', { title: 'データベース', on: { click: (e) => dbMenu(e.currentTarget) } },
        el('span.db-icon', '◆'), el('span#db-name', '—'), el('span.caret', '▾')),
      el('div.fx',
        el('span#fx-ref.fx-ref', ''),
        el('input#fx-input.fx-input', { spellcheck: false, placeholder: '', on: { keydown: onFxKey, focus: (e) => e.target.select() } })),
      el('div.top-actions',
        el('button#undo-btn.icon-btn', { title: '元に戻す', disabled: true, on: { click: doUndo } }, '↶'),
        el('button#redo-btn.icon-btn', { title: 'やり直す', disabled: true, on: { click: doRedo } }, '↷'),
        el('span.vsep'),
        el('button#panel-btn.tool-btn', { title: 'テーブルの設計（列・キー・制約）', on: { click: () => togglePanel() } }, '⚙ 設計'),
        el('button#console-btn.tool-btn', { title: `SQL コンソール（${MOD}\`）`, on: { click: () => toggleConsole() } }, '⌨ SQL'),
        el('button.tool-btn', { title: `コマンド（${MOD}K）`, on: { click: () => palette() } }, `${MOD}K`))),
    el('main.workspace',
      el('section#sheet.sheet',
        el('div#sheet-head.sheet-head'),
        el('div#grid-host.grid-host')),
      el('aside#panel.panel', { hidden: true })),
    el('section#console.console', { hidden: true }),
    el('footer.bottombar',
      el('div#tabs.tabs'),
      el('button.tab-add', { title: 'シートを追加', on: { click: (e) => addSheetMenu(e.currentTarget) } }, '＋'),
      el('span.grow'),
      el('span#status.status'),
      el('span#version.version')),
  );
  sqlConsole = new SqlConsole($('console'), {
    onSchemaMaybeChanged: async () => { undo.clear(); await refreshObjects(); await showSheet(state.key, { keepView: true }); },
    onDataChanged: async () => { undo.clear(); await state.grid?.reload(); },
  });
  undo.onChange(updateUndoButtons);
  db.onLog(() => {});
  addEventListener('keydown', onGlobalKey);
  // 未保存の新しい行があるまま閉じようとしたら確認
  addEventListener('beforeunload', (e) => { if (state.grid?.hasDraft) { e.preventDefault(); e.returnValue = ''; } });
  // .sqlite ファイルのドラッグ＆ドロップ
  addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  addEventListener('drop', (e) => {
    document.body.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (f) { e.preventDefault(); importFile(f); }
  });
}

function onGlobalKey(e) {
  if (modKey(e) && e.key === '`') { e.preventDefault(); toggleConsole(); return; }
  if (modKey(e) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  const inField = e.target.closest?.('input, textarea, select, [contenteditable]') && !e.target.classList.contains('grid-sink');
  if (!inField && modKey(e) && e.key.toLowerCase() === 'z' && !e.target.classList?.contains('grid-sink')) {
    e.preventDefault(); e.shiftKey ? doRedo() : doUndo();
  }
}

function updateUndoButtons() {
  const u = $('undo-btn'), r = $('redo-btn');
  if (!u) return;
  u.disabled = !undo.canUndo(); r.disabled = !undo.canRedo();
  u.title = undo.canUndo() ? `元に戻す: ${undo.peekUndo()}（${MOD}Z）` : '元に戻す';
  r.title = undo.canRedo() ? `やり直す: ${undo.peekRedo()}（${MOD}Y）` : 'やり直す';
}

async function doUndo() {
  try {
    const label = await undo.undo();
    if (label) { toast(`元に戻しました：${label}`); await state.grid?.reload(); }
  } catch (e) { toast('元に戻せませんでした：' + friendlyError(e.message), 'error'); }
}
async function doRedo() {
  try {
    const label = await undo.redo();
    if (label) { toast(`やり直しました：${label}`); await state.grid?.reload(); }
  } catch (e) { toast('やり直せませんでした：' + friendlyError(e.message), 'error'); }
}

function toggleConsole(force) {
  const open = sqlConsole.toggle(force);
  $('console-btn').classList.toggle('on', open);
  if (!open) state.grid?.focus();
}

// ======================================================================
// ようこそ画面
// ======================================================================
function showWelcome() {
  state.dbName = null; state.key = null; state.grid = null; state.source = null; state.model = null;
  $('db-name').textContent = 'DB を選択';
  $('fx-ref').textContent = ''; $('fx-input').value = ''; $('status').textContent = '';
  $('tabs').replaceChildren();
  $('sheet-head').replaceChildren();
  $('panel').hidden = true;
  setHash();
  $('grid-host').replaceChildren(el('div.welcome',
    el('div.welcome-card',
      el('h1', 'SQLiteシート'),
      el('p.lead', 'スプレッドシートの手軽さで、正規化された SQLite データベースを。'),
      el('p.muted', 'すべてブラウザの中で動き、データはこの端末（OPFS）に保存されます。'),
      el('div.welcome-actions',
        el('button.btn.primary.lg', { on: { click: newDb } }, '＋ 新しいデータベース'),
        el('button.btn.lg', { on: { click: async () => { const f = await pickFile('.sqlite,.sqlite3,.db,application/x-sqlite3'); if (f) importFile(f); } } }, '📂 ファイルを開く'),
        el('button.btn.lg', { on: { click: makeSample } }, '✨ サンプルで試す')),
      state.dbs.length ? el('div.welcome-list',
        el('h2', 'データベース'),
        state.dbs.map((n) => el('button.welcome-db', { on: { click: () => openDb(n) } }, el('span.db-icon', '◆'), n))) : null,
      el('p.muted.sm', '.sqlite ファイルをこの画面にドラッグ＆ドロップしても開けます。'))));
}

// ======================================================================
// DB 操作
// ======================================================================
async function openDb(name, key) {
  // 未保存の新しい行があれば先に保存（失敗したら切り替えない）
  if (state.grid && !(await state.grid.flushDraft())) return;
  try {
    await db.open(name);
  } catch (e) { toast(friendlyError(e.message), 'error'); return showWelcome(); }
  state.dbName = name;
  state.views = new Map();
  state.key = null;
  undo.clear();
  localStorage.setItem('last-db', name);
  $('db-name').textContent = name;
  await refreshObjects();
  const keys = allKeys();
  const last = localStorage.getItem('last-sheet:' + name);
  await showSheet(keys.includes(key) ? key : keys.includes(last) ? last : keys[0] || null);
}

function validDbName(v) {
  if (!v) return '名前を入力してください';
  if (/[\\/:*?"<>|]/.test(v)) return '使えない文字が含まれています（\\ / : * ? " < > |）';
  return null;
}

async function newDb(anchor) {
  const name = await ask(anchor instanceof Element ? anchor : $('db-btn'), {
    title: '新しいデータベース', placeholder: '名前', okLabel: '作成',
    validate: (v) => validDbName(v) || (state.dbs.includes(v) ? `「${v}」は既にあります` : null),
  });
  if (!name) return;
  try {
    await db.create(name);
    state.dbs = await db.list();
    await openDb(name);
    toast(`「${name}」を作成しました`, 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function makeSample() {
  let name = 'サンプル', i = 2;
  while (state.dbs.includes(name)) name = `サンプル${i++}`;
  try {
    await db.create(name);
    await createSample(db);
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(name);
    toast('サンプルの DB を作成しました', 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function importFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = new TextDecoder().decode(bytes.slice(0, 15));
  if (header !== 'SQLite format 3') { toast('SQLite のデータベースファイルではありません', 'error'); return; }
  let name = file.name.replace(/\.(sqlite3?|db)$/i, '') || 'imported';
  const base = name; let i = 2;
  while (state.dbs.includes(name)) name = `${base} (${i++})`;
  name = await ask($('db-btn'), { title: 'このファイルを読み込む名前', value: name, okLabel: '読み込む', validate: (v) => validDbName(v) || (state.dbs.includes(v) ? `「${v}」は既にあります` : null) });
  if (!name) return;
  try {
    await db.importDb(name, bytes);
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(name);
    toast(`「${name}」を読み込みました`, 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function exportCurrent() {
  try {
    const bytes = await db.exportDb(state.dbName);
    download(bytes, `${state.dbName}.sqlite`, 'application/x-sqlite3');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function dbMenu(anchor) {
  const items = [{ header: 'データベース' }];
  for (const n of state.dbs) items.push({ label: n, icon: n === state.dbName ? '✓' : '', action: () => { if (n !== state.dbName) openDb(n); } });
  items.push('-', { label: '新しいデータベース…', icon: '＋', action: () => newDb(anchor) },
    { label: 'ファイルを開く…', icon: '📂', action: async () => { const f = await pickFile('.sqlite,.sqlite3,.db'); if (f) importFile(f); } },
    { label: 'サンプルを作成', icon: '✨', action: makeSample });
  if (state.dbName) {
    items.push('-', { header: state.dbName },
      { label: '書き出し（.sqlite）', icon: '⤓', action: exportCurrent },
      { label: '名前を変更…', icon: '✎', action: renameDb },
      { label: '複製…', icon: '⧉', action: copyDb },
      { label: '削除…', icon: '🗑', danger: true, action: deleteDb });
  }
  menu(anchor, items);
}

async function renameDb() {
  const from = state.dbName;
  const to = await ask($('db-btn'), { title: 'データベースの名前を変更', value: from, okLabel: '変更', validate: (v) => validDbName(v) || (v !== from && state.dbs.includes(v) ? `「${v}」は既にあります` : null) });
  if (!to || to === from) return;
  try {
    await db.rename(from, to);
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(to, state.key);
  } catch (e) { toast(friendlyError(e.message), 'error'); await openDb(from); }
}

async function copyDb() {
  const from = state.dbName;
  let def = `${from} のコピー`, i = 2;
  while (state.dbs.includes(def)) def = `${from} のコピー ${i++}`;
  const to = await ask($('db-btn'), { title: '複製先の名前', value: def, okLabel: '複製', validate: (v) => validDbName(v) || (state.dbs.includes(v) ? `「${v}」は既にあります` : null) });
  if (!to) return;
  try {
    await db.copy(from, to);
    state.dbs = await db.list();
    state.dbName = null;
    await openDb(to);
    toast(`「${to}」を作成しました`, 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function deleteDb() {
  const name = state.dbName;
  if (!await confirmDialog({ title: `「${name}」を削除しますか？`, body: 'データベースのすべてのデータが失われ、元に戻せません。必要なら先に書き出してください。', okLabel: '削除', danger: true })) return;
  try {
    await db.remove(name);
    state.dbs = await db.list();
    localStorage.removeItem('last-db');
    toast(`「${name}」を削除しました`);
    state.dbName = null;
    if (state.dbs.length) await openDb(state.dbs[0]); else showWelcome();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ======================================================================
// シート一覧
// ======================================================================
async function refreshObjects() {
  state.objects = await listObjects();
  state.queries = [];
  const hasQ = (await db.query(`SELECT 1 FROM sqlite_schema WHERE name = ?`, [QT])).rows.length;
  if (hasQ) state.queries = (await db.query(`SELECT name, sql FROM ${q(QT)} ORDER BY rowid`)).rows.map(([name, sql]) => ({ name, sql }));
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
const KIND_NAME = { t: 'テーブル', v: 'ビュー', q: 'クエリ' };

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...allKeys().map((key) => {
    const kind = key[0], name = key.slice(2);
    return el('button.tab', {
      class: (key === state.key ? 'on ' : '') + 'k-' + kind,
      title: `${KIND_NAME[kind]}：${name}`,
      on: {
        click: () => showSheet(key),
        dblclick: (e) => renameSheet(key, e.currentTarget),
        contextmenu: (e) => { e.preventDefault(); tabMenu(key, e.currentTarget); },
      },
    }, el('span.tab-icon', KIND_ICON[kind]), name, kind === 't' && state.lockedSheets?.has(name) ? el('span.tab-lock', { title: 'シート全体が保護されています' }, '🔒') : null);
  }));
  tabs.querySelector('.tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function tabMenu(key, anchor) {
  const kind = key[0], name = key.slice(2);
  menu(anchor, [
    { header: `${KIND_NAME[kind]}：${name}` },
    { label: '名前を変更…', icon: '✎', action: () => renameSheet(key, anchor) },
    kind === 't' ? { label: '複製…', icon: '⧉', action: () => duplicateTable(name, anchor) } : null,
    kind === 't' ? (state.lockedSheets?.has(name)
      ? { label: 'シートの保護を外す…', icon: '🔓', action: () => withSheet(key, () => unprotect(state.prots.find((p) => p.kind === 'sheet'))) }
      : { label: 'シートを保護…', icon: '🔒', action: () => withSheet(key, () => protect({ kind: 'sheet' }, anchor)) }) : null,
    kind !== 'q' ? { label: 'SQL コンソールで SELECT', icon: '⌨', action: () => sqlConsole.insert(`SELECT * FROM ${q(name)};`) } : null,
    kind === 't' ? { label: 'CSV で書き出し', icon: '⤓', action: () => exportCsv(key) } : { label: 'CSV で書き出し', icon: '⤓', action: () => exportCsv(key) },
    '-',
    { label: '削除…', icon: '🗑', danger: true, action: () => deleteSheet(key) },
  ].filter(Boolean), { });
}

function addSheetMenu(anchor) {
  if (!state.dbName) return;
  menu(anchor, [
    { label: '新しいテーブル', icon: '▦', action: () => newTable(anchor) },
    { label: '新しいクエリ', icon: '⌕', action: () => newQuery() },
    { label: 'ファイルから表を作成（CSV/TSV）…', icon: '⤒', action: () => importCsv() },
  ]);
}

function uniqueName(base, taken) {
  let n = base, i = 2;
  while (taken.includes(n)) n = `${base}${i++}`;
  return n;
}

const takenNames = () => [...state.objects.map((o) => o.name), ...state.queries.map((x) => x.name)];

async function newTable(anchor) {
  const name = await ask(anchor, {
    title: '新しいテーブル', value: uniqueName('テーブル', takenNames()), okLabel: '作成',
    validate: (v) => !v ? '名前を入力してください' : takenNames().includes(v) ? `「${v}」は既にあります` : null,
  });
  if (!name) return;
  try {
    await db.exec(`CREATE TABLE ${q(name)} (\n  "id" INTEGER PRIMARY KEY,\n  "名前" TEXT\n) STRICT`);
    await refreshObjects();
    await showSheet('t:' + name);
    toast('テーブルを作成しました。列は見出しの ＋ か「⚙ 設計」から追加できます。');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function ensureQueryTable() {
  await db.exec(`CREATE TABLE IF NOT EXISTS ${q(QT)} (name TEXT PRIMARY KEY, sql TEXT NOT NULL) STRICT`);
}

async function newQuery(sql, base = 'クエリ') {
  const name = uniqueName(base, takenNames());
  const first = tableNames()[0];
  sql ??= first ? `SELECT *\nFROM ${q(first)}\nLIMIT 100` : 'SELECT 1';
  try {
    await ensureQueryTable();
    await db.exec(`INSERT INTO ${q(QT)} (name, sql) VALUES (?, ?)`, [name, sql]);
    await refreshObjects();
    await showSheet('q:' + name);
    $('sheet-head').querySelector('textarea')?.focus();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function viewSelect(sql) {
  const m = sql.match(/^\s*CREATE\s+(?:TEMP\w*\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[\w\u0080-￿.]+)(\s*\([^)]*\))?\s+AS\s+([\s\S]*)$/i);
  return m ? { cols: m[1] || '', select: m[2].trim() } : { cols: '', select: sql };
}

async function renameSheet(key, anchor) {
  const kind = key[0], name = key.slice(2);
  const to = await ask(anchor, {
    title: `${KIND_NAME[kind]}の名前を変更`, value: name, okLabel: '変更',
    validate: (v) => !v ? '名前を入力してください' : v !== name && takenNames().includes(v) ? `「${v}」は既にあります` : null,
  });
  if (!to || to === name) return;
  try {
    if (kind === 't') await db.exec(`ALTER TABLE ${q(name)} RENAME TO ${q(to)}`);
    else if (kind === 'v') {
      const v = state.objects.find((o) => o.name === name);
      const { cols, select } = viewSelect(v.sql);
      await db.batch([{ sql: `DROP VIEW ${q(name)}` }, { sql: `CREATE VIEW ${q(to)}${cols} AS ${select}` }]);
    } else await db.exec(`UPDATE ${q(QT)} SET name = ? WHERE name = ?`, [to, name]);
    const view = state.views.get(key);
    if (view) state.views.set(kind + ':' + to, view);
    renameInOrder(key, kind + ':' + to);
    await refreshObjects();
    await showSheet(kind + ':' + to, { keepView: true });
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function deleteSheet(key) {
  const kind = key[0], name = key.slice(2);
  let body = '';
  if (kind === 't') {
    const n = (await db.query(`SELECT count(*) FROM ${q(name)}`)).rows[0][0];
    body = `${n} 行のデータとインデックス・トリガーも削除されます。元に戻せません。`;
  }
  if (!await confirmDialog({ title: `${KIND_NAME[kind]}「${name}」を削除しますか？`, body, okLabel: '削除', danger: true })) return;
  try {
    if (kind === 't') await db.exec(`DROP TABLE ${q(name)}`);
    else if (kind === 'v') await db.exec(`DROP VIEW ${q(name)}`);
    else await db.exec(`DELETE FROM ${q(QT)} WHERE name = ?`, [name]);
    undo.clear();
    const keys = allKeys(); const idx = keys.indexOf(key);
    await refreshObjects();
    const rest = allKeys();
    await showSheet(rest[Math.min(idx, rest.length - 1)] || null);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function duplicateTable(name, anchor) {
  const to = await ask(anchor, { title: 'テーブルを複製', value: uniqueName(name + '_copy', takenNames()), okLabel: '複製', validate: (v) => !v ? '名前を入力してください' : takenNames().includes(v) ? `「${v}」は既にあります` : null });
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
  // 消えたシート（コンソールでの DROP/RENAME、古いハッシュ等）は近くのシートに切り替える
  const keys = allKeys();
  if (key && !keys.includes(key)) {
    const prev = state.order?.indexOf(key) ?? -1;
    key = keys[Math.min(Math.max(prev, 0), keys.length - 1)] || null;
  }
  state.order = keys;
  state.key = key;
  setHash();
  renderTabs();
  if (!key) {
    state.grid = null; state.source = null; state.model = null;
    updateStatus();
    $('sheet-head').replaceChildren();
    $('grid-host').replaceChildren(el('div.empty-db',
      el('h2', 'まだシートがありません'),
      el('p.muted', 'テーブルを作るか、SQL コンソールから CREATE TABLE を実行してください。'),
      el('div.row-gap', el('button.btn.primary', { on: { click: (e) => newTable(e.currentTarget) } }, '＋ 新しいテーブル'),
        el('button.btn', { on: { click: () => toggleConsole(true) } }, '⌨ SQL を書く'))));
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
  state.grid.focus();
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
    view.sorts.length ? el('span.sort-chips', { title: '並べ替え（左ほど優先）' },
      view.sorts.flatMap((s, i) => [
        i ? el('span.sort-sep', '›') : null,
        el('span.chip.sort', {
          class: i === 0 && state.justSorted === s.col ? 'flash' : '',
          title: view.sorts.length > 1 ? 'クリックで昇順／降順を切り替え・ドラッグで優先順位を変更' : 'クリックで昇順／降順を切り替え',
          dataset: { i },
          on: { pointerdown: (e) => sortChipPointer(e, i) },
        }, view.sorts.length > 1 ? el('span.chip-grip', '⋮⋮') : null, `${s.dir === 'asc' ? '↑' : '↓'} ${s.col}`,
        el('button.chip-x', { title: 'この並べ替えを解除', on: { click: () => removeSort(s.col) } }, '×')),
      ])) : null,
    view.filters.map((f, i) => el('span.chip.filter', {
      title: 'クリックで編集',
      on: { click: (e) => { if (!e.target.closest('.chip-x')) filterPopover(e.currentTarget, f.col, i); } },
    }, `${f.col} ${FILTER_OPS.find((o) => o.id === f.op)?.label.replace(/^\S+ /, '') ?? f.op}${FILTER_OPS.find((o) => o.id === f.op)?.noValue ? '' : ' 「' + f.value + '」'}`,
    el('button.chip-x', { title: '絞り込みを解除', on: { click: () => { view.filters.splice(i, 1); reloadSheet(); } } }, '×'))),
    el('span.grow'),
    kind === 't' && state.prots?.length ? el('button.chip.prot', { title: 'このシートの保護', on: { click: (e) => protPanel(e.currentTarget) } },
      `🔒 保護 ${state.prots.length}`) : null,
    kind === 't' && state.source ? el('code.sheet-sql', { title: 'このシートが実行している SQL' }, state.source.displaySql()) : null,
  );
  // 何もかかっていないクエリ／ビューではバーごと出さない
  if (view.sorts.length || view.filters.length || kind === 't') parts.push(chips);
  head.replaceChildren(...parts);
}

function queryEditor(kind, name, error) {
  const isView = kind === 'v';
  const obj = isView ? state.objects.find((o) => o.name === name) : state.queries.find((x) => x.name === name);
  const viewParts = isView ? viewSelect(obj.sql) : null;
  const original = isView ? viewParts.select : obj.sql;
  const ta = el('textarea.query-input.mono', {
    value: original, spellcheck: false, readOnly: isView,
    rows: Math.min(10, Math.max(3, original.split('\n').length)),
    on: {
      keydown: (e) => {
        if (modKey(e) && e.key === 'Enter') { e.preventDefault(); run(); }
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
        if (e.key === 'Escape') state.grid?.focus();
      },
      input: () => { ta.rows = Math.min(14, Math.max(3, ta.value.split('\n').length)); dirtyMark.hidden = ta.value === original; },
    },
  });
  const dirtyMark = el('span.dirty-dot', { hidden: true, title: '未実行の変更' }, '●');
  const err = el('div.query-error', error ? friendlyError(error.message) : '');
  async function run() {
    const sql = ta.value.trim().replace(/;+\s*$/, '');
    if (!sql) return;
    try {
      if (isView) {
        await db.rebuild([{ sql: `DROP VIEW ${q(name)}` }, { sql: `CREATE VIEW ${q(name)}${viewParts.cols} AS ${sql}` }]);
      } else {
        // 保存する前に実行できるか確かめる
        await db.query(`SELECT * FROM (${sql}) LIMIT 0`);
        await db.exec(`UPDATE ${q(QT)} SET sql = ? WHERE name = ?`, [sql, name]);
      }
      state.views.set(state.key, { sorts: [], filters: [] });
      await refreshObjects();
      await showSheet(state.key);
    } catch (e) { err.textContent = friendlyError(e.message); }
  }
  const actions = isView
    ? el('div.query-actions',
      el('span.muted.sm', 'ビューの定義'),
      el('span.grow'),
      el('button.btn.sm', { on: { click: (e) => { ta.readOnly = false; ta.focus(); e.currentTarget.remove(); saveBtn.hidden = false; } } }, '✎ 編集'),
      el('button.btn.sm', { on: { click: () => newQuery(original, name + 'のクエリ') } }, 'クエリとして複製'),
      Object.assign(el('button.btn.primary.sm', { hidden: true, on: { click: run } }, 'ビューを更新'), {}))
    : el('div.query-actions',
      el('span.muted.sm', `${MOD}Enter で実行`), dirtyMark,
      el('span.grow'),
      el('button.btn.sm', { on: { click: () => saveAsView(name, ta.value) } }, '◫ ビューとして保存'),
      el('button.btn.primary.sm', { on: { click: run } }, '▶ 実行'));
  const saveBtn = actions.querySelector('.btn.primary');
  return el('div.query-box', { class: isView ? 'readonly' : '' }, ta, actions, err);
}

async function saveAsView(queryName, sql) {
  sql = sql.trim().replace(/;+\s*$/, '');
  const name = await ask($('sheet-head'), { title: 'ビューの名前', value: uniqueName(queryName, state.objects.map((o) => o.name)), okLabel: '作成', validate: (v) => !v ? '名前を入力してください' : state.objects.some((o) => o.name === v) ? `「${v}」は既にあります` : null });
  if (!name) return;
  try {
    await db.batch([
      { sql: `CREATE VIEW ${q(name)} AS ${sql}` },
      ...(name === queryName ? [{ sql: `DELETE FROM ${q(QT)} WHERE name = ?`, bind: [queryName] }] : []),
    ]);
    if (name !== queryName && await confirmDialog({ title: 'ビューを作成しました', body: `元のクエリ「${queryName}」は削除しますか？`, okLabel: '削除する' })) {
      await db.exec(`DELETE FROM ${q(QT)} WHERE name = ?`, [queryName]);
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
  const val = el('input.input', { value: cur.value ?? '', placeholder: '値', autofocus: true });
  const sync = () => { val.hidden = FILTER_OPS.find((o) => o.id === opSel.value)?.noValue; };
  opSel.addEventListener('change', sync); sync();
  const apply = () => {
    const f = { col: colSel.value, op: opSel.value, value: val.value };
    if (index != null) view.filters[index] = f; else view.filters.push(f);
    closePopover();
    reloadSheet();
  };
  popover(anchor, el('form.filter-form', { on: { submit: (e) => { e.preventDefault(); apply(); } } },
    el('div.ask-title', '絞り込み'), colSel, opSel, val,
    el('div.ask-actions',
      index != null ? el('button.btn.danger-text', { type: 'button', on: { click: () => { view.filters.splice(index, 1); closePopover(); reloadSheet(); } } }, '解除') : null,
      el('span.grow'),
      el('button.btn.primary', { type: 'submit' }, '適用'))));
}

// ---------- グリッドのフック ----------
function gridHooks(kind) {
  const isTable = kind === 't';
  return {
    onSelect: (s) => updateFx(s),
    onEditState: (editing, text) => {
      const fx = $('fx-input');
      if (editing) { fx.value = text; fx.placeholder = state.grid.sink.placeholder; } else updateFx();
    },
    onError: (e) => toast(friendlyError(e.message), 'error'),
    onInfo: (m) => toast(m),
    onUndo: doUndo,
    onRedo: doRedo,
    onHeaderMenu: (c, anchor) => headerMenu(c, anchor),
    onAddColumn: isTable ? (anchor) => quickAddColumn(anchor) : null,
    onContextMenu: (pos, range) => cellMenu(pos, range),
    onReadonlyEdit: (col) => toast(isTable ? (col ? `「${col.name}」は生成列のため編集できません` : '編集できません') : `${KIND_NAME[kind]}の結果は編集できません。元のテーブルで編集してください`),
    onBlobEdit: (r, c) => blobMenu(r, c),
    onProtectedEdit: (prots) => toast(`🔒 ${prots[0].note || '保護されています'}（${describe(state.model, prots[0])}）`),
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
  ref.textContent = col ? (s.isNew ? (g.draft ? `✎ ${draft ? '未保存' : '新しい行'} · ${col.name}` : '＋ 行を追加（クリックか Enter）') : `${s.r + 1} · ${col.name}`) : '';
  const v = s.isNew ? (g.draft ? g.draft.values[s.c] : undefined) : s.row?.values[s.c];
  fx.readOnly = !state.source.editable || col?.readonly || v instanceof Uint8Array;
  fx.classList.toggle('null', false);
  // グリッドでフォームを開いたときと同じ文字列（下書きの未入力は空で、INSERT で入るものを placeholder に）
  fx.value = v instanceof Uint8Array ? `BLOB（${v.length} バイト）` : !col ? '' : s.isNew ? (g.draft ? g.formAt(s.r, s.c) : '') : s.row ? formText(v) : '';
  fx.placeholder = s.isNew && g.draft && v === undefined ? g.placeholderFor(s.c) : '';
  updateStatus(s.range);
}

function updateStatus(range) {
  const g = state.grid;
  const st = $('status');
  if (!g) { st.textContent = ''; return; }
  let text = `${g.rowCount.toLocaleString()} 行`;
  if (range) {
    const cells = (Math.min(range.r1, g.rowCount - 1) - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (cells > 1 && cells <= 20000) {
      let sum = 0, n = 0;
      for (let r = range.r0; r <= Math.min(range.r1, g.rowCount - 1); r++) {
        const row = g.rowAt(r);
        if (!row) continue;
        for (let c = range.c0; c <= range.c1; c++) { const v = row.values[c]; if (typeof v === 'number') { sum += v; n++; } }
      }
      text = `選択 ${cells.toLocaleString()} セル` + (n ? ` · 合計 ${+sum.toFixed(10)} · 平均 ${+(sum / n).toFixed(4)}` : '') + ' · ' + text;
    }
  }
  st.textContent = text;
}

function onFxKey(e) {
  const g = state.grid;
  if (!g) return;
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (!e.target.readOnly) {
      const onNew = g.cur.r === g.newRowIndex;
      g.setCurrent(e.target.value).then(() => { onNew ? g.moveTo(g.cur.r, g.cur.c + 1) : g.moveTo(g.cur.r + 1, g.cur.c); g.focus(); });
    }
  } else if (e.key === 'Escape') { updateFx(); g.focus(); }
}

function headerMenu(c, anchor) {
  const col = state.source.columns[c];
  const isTable = state.key[0] === 't';
  const items = [
    { header: col.name },
    { label: '昇順に並べ替え', icon: '↑', action: () => pushSort(col.name, 'asc') },
    { label: '降順に並べ替え', icon: '↓', action: () => pushSort(col.name, 'desc') },
    viewOf(state.key).sorts.some((s) => s.col === col.name) ? { label: 'この列の並べ替えを解除', icon: '⇅', action: () => removeSort(col.name) } : null,
    { label: '絞り込み…', icon: '⏷', action: () => filterPopover(anchor instanceof Element ? anchor : $('sheet-head'), col.name) },
  ];
  if (isTable) {
    items.push('-',
      { label: '列の設定…', icon: '⚙', action: () => togglePanel(true, col.name) },
      { label: '名前を変更…', icon: '✎', action: () => renameColumn(col.name, anchor) },
      { label: '列を保護…', icon: '🔒', action: () => protect({ kind: 'cols', cols: [col.name] }, anchor instanceof Element ? anchor : $('sheet-head')) },
      { label: '列を追加…', icon: '＋', action: () => quickAddColumn(anchor instanceof Element ? anchor : $('sheet-head')) });
    if (col.fk) {
      items.push('-',
        { label: `参照先「${col.fk.table}」を開く`, icon: '→', action: () => showSheet('t:' + col.fk.table) },
        { label: `「${col.fk.table}」を結合したクエリを作成`, icon: '⋈', action: () => joinQuery(col) });
    }
    items.push('-', { label: '列を削除…', icon: '🗑', danger: true, disabled: state.model.columns.length <= 1, action: () => dropColumn(col.name) });
  }
  menu(anchor, items.filter(Boolean));
}

async function renameColumn(name, anchor) {
  const to = await ask(anchor instanceof Element ? anchor : $('sheet-head'), {
    title: '列名を変更', value: name, okLabel: '変更',
    validate: (v) => !v ? '名前を入力してください' : v !== name && state.model.columns.some((c) => c.name === v) ? `「${v}」は既にあります` : null,
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

async function dropColumn(name) {
  if (!await confirmDialog({ title: `列「${name}」を削除しますか？`, body: 'この列のデータはすべて失われ、元に戻せません。', okLabel: '削除', danger: true })) return;
  const m = state.model;
  try {
    // キー・制約に含まれる列は ALTER TABLE DROP COLUMN できないので作り直す
    const inKey = m.pk.includes(name) || m.uniques.some((u) => u.includes(name)) || m.fks.some((f) => f.cols.includes(name)) || m.indexes.some((i) => i.cols.includes(name));
    if (inKey) {
      const { migrationSql } = await import('./schema.js');
      const next = JSON.parse(JSON.stringify(m));
      next.columns = next.columns.filter((c) => c.name !== name).map((c) => ({ ...c, from: c.name }));
      next.pk = next.pk.filter((n) => n !== name);
      next.uniques = next.uniques.map((u) => u.filter((n) => n !== name)).filter((u) => u.length);
      next.fks = next.fks.filter((f) => !f.cols.includes(name));
      if (!next.pk.length) next.withoutRowid = false;
      await db.rebuild(migrationSql(m, next).map((sql) => ({ sql })));
    } else {
      await db.exec(`ALTER TABLE ${q(m.name)} DROP COLUMN ${q(name)}`);
    }
    undo.clear();
    const v = viewOf(state.key);
    v.sorts = v.sorts.filter((s) => s.col !== name);
    v.filters = v.filters.filter((f) => f.col !== name);
    await reloadSheet();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function quickAddColumn(anchor) {
  const m = state.model;
  const name = el('input.input', { placeholder: '列名', autofocus: true, value: uniqueName('列', m.columns.map((c) => c.name)) });
  const type = el('select.input', TYPES.map((t) => el('option', { value: t, selected: t === 'TEXT' }, t)));
  const nn = el('input', { type: 'checkbox' });
  const dflt = el('input.input.mono', { placeholder: '既定値（任意）例: 0 / 文字列 / =CURRENT_TIMESTAMP' });
  const fkSel = el('select.input', el('option', { value: '' }, '外部キーなし'), tableNames().map((t) => el('option', { value: t }, `→ ${t}`)));
  const err = el('div.field-error');
  const submit = async () => {
    const n = name.value.trim();
    if (!n) { err.textContent = '列名を入力してください'; return; }
    if (m.columns.some((c) => c.name === n)) { err.textContent = `「${n}」は既にあります`; return; }
    let def = `${q(n)} ${type.value}`;
    if (nn.checked) def += ' NOT NULL';
    // セルのフォームと同じ書き方：普通の文字は値、= で始まれば式、空は既定値なし
    const d = formToDefault(dflt.value, type.value);
    if (d != null) def += ` DEFAULT ${d}`;
    if (fkSel.value) def += ` REFERENCES ${q(fkSel.value)}`;
    try {
      await db.exec(`ALTER TABLE ${q(m.name)} ADD COLUMN ${def}`);
      closePopover();
      await reloadSheet();
      state.grid?.moveTo(state.grid.cur.r, state.model.columns.length - 1);
    } catch (e) { err.textContent = friendlyError(e.message); }
  };
  popover(anchor, el('form.add-col', { on: { submit: (e) => { e.preventDefault(); submit(); } } },
    el('div.ask-title', '列を追加'),
    name, type,
    el('label.chk', nn, '必須（NOT NULL）'),
    dflt, fkSel, err,
    el('div.ask-actions',
      el('button.btn.link', { type: 'button', on: { click: () => { closePopover(); togglePanel(true); state.panel?.addColumn(); } } }, '詳細設定…'),
      el('span.grow'),
      el('button.btn.primary', { type: 'submit' }, '追加'))), { align: 'end' });
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
  toast(`「${fk.table}」の ${fk.refCol} = ${value} を表示しています（チップの × で解除）`);
}

function fkPicker(r, c, anchor) {
  if (state.grid.editing) state.grid.cancelEdit();
  const col = state.source.columns[c];
  const fk = col.fk;
  const labelCol = state.source.labelCols.get(col.name);
  const input = el('input.input', { placeholder: `${fk.table} を検索`, autofocus: true });
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
    !items.length ? el('div.muted.pad', '該当なし') : '');
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
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (items[active]) choose(items[active][0]); }
  });
  popover(anchor, el('div.fk-picker', el('div.ask-title', `→ ${fk.table}.${fk.refCol}`), input, list,
    col.readonly ? null : el('button.btn.sm.link', { on: { click: () => choose(null) } }, 'NULL にする')), { onClose: () => state.grid?.focus() });
  search();
}

async function cellMenu(pos, range) {
  const g = state.grid;
  const isTable = state.key[0] === 't';
  const rows = Math.min(range.r1, g.rowCount - 1) - range.r0 + 1;
  const items = [
    { label: 'コピー', icon: '⧉', kbd: `${MOD}C`, action: () => g.copy() },
  ];
  if (isTable) {
    items.push(
      { label: '貼り付け', icon: '📋', kbd: `${MOD}V`, action: async () => { try { g.paste(await navigator.clipboard.readText()); } catch { toast(`${MOD}V で貼り付けてください`); } } },
      { label: '値をクリア（NULL）', icon: '⌫', kbd: 'Delete', action: () => g.clearSelection() },
      { label: '下へコピー', icon: '⇣', kbd: `${MOD}D`, disabled: range.r1 <= range.r0, action: () => g.fillDown() },
      '-',
      { label: rows > 1 ? `${rows} 行を複製` : '行を複製', icon: '⧉', disabled: rows < 1, action: async () => { try { await state.source.duplicateRows(await g.rowsBetween(range.r0, range.r0 + rows - 1)); await g.reload(); } catch (e) { toast(friendlyError(e.message), 'error'); } } },
      { label: rows > 1 ? `${rows} 行を削除` : '行を削除', icon: '🗑', kbd: `${MOD}-`, danger: true, disabled: rows < 1, action: () => deleteSelectedRows() });
    const here = g.protAt(g.cur.r, g.cur.c);
    items.push('-', { label: '範囲を保護…', icon: '🔒', action: () => protectSelection(pos) },
      ...here.map((p) => ({ label: `保護を外す：${p.note || describe(state.model, p)}`, icon: '🔓', action: () => unprotect(p) })));
    const col = state.source.columns[g.cur.c];
    const v = g.rowAt(g.cur.r)?.values[g.cur.c];
    if (col?.fk && v != null) items.push('-', { label: `参照先の行を開く（${col.fk.table}）`, icon: '→', kbd: `${MOD}クリック`, action: () => jumpToRef(col.fk, v) });
  }
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
  if (!canProtectRows(m)) { toast('主キーのない表では、行や範囲は保護できません（列やシート全体は保護できます）', 'error'); return; }
  const last = Math.min(r1, g.rowCount - 1);
  if (last < r0) return;
  if (last - r0 >= 1000) { toast('一度に保護できるのは 1000 行までです', 'error'); return; }
  const pkIdx = m.pk.map((p) => m.columns.findIndex((c) => c.name === p));
  const keys = (await g.rowsBetween(r0, last)).filter(Boolean)
    .map((row) => pkIdx.map((i) => { const v = row.values[i]; return typeof v === 'bigint' && Number.isSafeInteger(Number(v)) ? Number(v) : v; }));
  const wholeRows = c0 === 0 && c1 === m.columns.length - 1;
  return protect(wholeRows ? { kind: 'rows', keys } : { kind: 'range', cols, keys }, anchor);
}

async function protect(spec, anchor) {
  const what = describe(state.model, spec);
  const note = await ask(anchor, { title: `🔒 ${what}を保護`, placeholder: '説明（任意）例：4月分は確定済み', okLabel: '保護する' });
  if (note === null) return;
  try {
    const names = (await db.query(`SELECT name FROM sqlite_schema WHERE type = 'trigger'`)).rows.map(([n]) => n);
    await db.batch(protectSql(state.model, { ...spec, note }, names));
    await refreshObjects();
    await reloadSheet();
    toast(`🔒 ${what}を保護しました`, 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function unprotect(p) {
  if (!p) return;
  const what = describe(state.model, p);
  const body = `${PROT_ICON[p.kind]} ${what}${p.note ? `「${p.note}」` : ''}。外すと、この範囲を編集できるようになります。`;
  if (!await confirmDialog({ title: '保護を外しますか？', body, okLabel: '外す' })) return;
  try {
    await db.batch(unprotectSql(p));
    await refreshObjects();
    await reloadSheet();
    toast(`🔓 ${what}の保護を外しました`);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

/** このシートの保護の一覧。クリックで範囲を選択、🔓 で外す */
function protPanel(anchor) {
  const m = state.model;
  popover(anchor, el('div.prot-panel',
    el('div.ask-title', '🔒 保護されたシートと範囲'),
    el('div.prot-list', state.prots.map((p) => el('div.prot-item', {
      title: 'クリックで範囲を選択',
      on: { click: (e) => { if (!e.target.closest('button')) { closePopover(); selectProtection(p); } } },
    },
    el('span.prot-icon', PROT_ICON[p.kind]),
    el('div.prot-text', el('div.prot-note', p.note || describe(m, p)), p.note ? el('div.prot-what', describe(m, p)) : null),
    el('button.btn.sm', { title: '保護を外す', on: { click: () => { closePopover(); unprotect(p); } } }, '🔓 外す')))),
    el('div.prot-foot', 'セルを選んで右クリック →「範囲を保護…」で追加できます')), { align: 'end' });
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
    if (!hits.length) { toast('保護された行が見つかりません（絞り込みで隠れているかもしれません）'); return; }
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
    toast(`${rows.length} 行を削除しました（${MOD}Z で元に戻せます）`);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function blobMenu(r, c) {
  const g = state.grid;
  const row = g.rowAt(r);
  const v = row?.values[c];
  const cellEl = g.body.querySelector(`.gr[data-r="${r}"] .gc[data-c="${c}"]`) || g.sink;
  menu(cellEl, [
    { label: 'ファイルから読み込む…', icon: '⤒', action: async () => {
      const f = await pickFile('');
      if (!f) return;
      try { const res = await state.source.update([{ row: r, col: c, value: new Uint8Array(await f.arrayBuffer()), rowObj: row }]); if (res[0]) g.pages.get(Math.floor(r / 200))[r % 200] = res[0].rowObj; g.render(); } catch (e) { toast(friendlyError(e.message), 'error'); }
    } },
    { label: 'ダウンロード', icon: '⤓', disabled: !(v instanceof Uint8Array), action: () => download(v, `${state.source.columns[c].name}.bin`) },
    { label: 'NULL にする', icon: '⌫', action: () => g.write([{ r, c, value: null }]) },
  ]);
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
    download(new TextEncoder().encode(csv), `${name}.csv`, 'text/csv');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function importCsv() {
  const f = await pickFile('.csv,.tsv,.txt,text/csv');
  if (!f) return;
  const text = (await f.text()).replace(/^﻿/, '');
  const { parseTsv } = await import('./grid.js');
  const tsv = f.name.endsWith('.tsv') || (text.split('\n')[0].includes('\t') && !text.split('\n')[0].includes(','));
  const rows = tsv ? parseTsv(text) : parseCsv(text);
  if (rows.length < 1) { toast('データがありません', 'error'); return; }
  const header = rows[0].map((h, i) => h.trim() || `列${i + 1}`);
  const data = rows.slice(1).filter((r) => r.some((v) => v !== ''));
  // 列の型を推定
  const types = header.map((_, i) => {
    const vals = data.map((r) => r[i]).filter((v) => v != null && v !== '');
    if (vals.length && vals.every((v) => /^[-+]?\d+$/.test(v.trim()))) return 'INTEGER';
    if (vals.length && vals.every((v) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim()))) return 'REAL';
    return 'TEXT';
  });
  const name = await ask($('tabs'), { title: `${data.length} 行・${header.length} 列を新しいテーブルに`, value: uniqueName(f.name.replace(/\.\w+$/, ''), takenNames()), okLabel: '作成', validate: (v) => !v ? '名前を入力してください' : takenNames().includes(v) ? `「${v}」は既にあります` : null });
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
    toast(`${data.length} 行を読み込みました`, 'success');
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
    { label: '新しいテーブル', icon: '＋', run: () => newTable($('tabs')) },
    { label: '新しいクエリ', icon: '＋', run: () => newQuery() },
    { label: 'SQL コンソールを開く', icon: '⌨', run: () => toggleConsole(true) },
    state.model ? { label: 'テーブルの設計を開く', icon: '⚙', run: () => togglePanel(true) } : null,
    { label: 'DB を書き出し（.sqlite）', icon: '⤓', run: exportCurrent },
    { label: 'CSV からテーブルを作成', icon: '⤒', run: importCsv },
    ...state.dbs.filter((n) => n !== state.dbName).map((n) => ({ label: n, hint: 'DB を開く', icon: '◆', run: () => openDb(n) })),
  ].filter(Boolean);
  const input = el('input.input.palette-input', { placeholder: 'シートやコマンドを検索…', autofocus: true });
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
    if (e.key === 'Enter' && !e.isComposing && items[active]) { e.preventDefault(); closePopover(); items[active].run(); }
  });
  render();
  popover({ x: innerWidth / 2 - 260, y: 72 }, el('div.palette', input, list), { className: 'palette-pop', onClose: () => state.grid?.focus() });
}

boot();
