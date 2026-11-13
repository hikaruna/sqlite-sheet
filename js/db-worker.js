// SQLite を独占する Worker。opfs-sahpool VFS を使うので COOP/COEP ヘッダー不要。
import sqlite3InitModule from 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.54.1-build1/dist/index.mjs';

let sqlite3, pool, db = null, currentName = null;
// 開いている DB の種類。'file' は端末のファイルをメモリに読み込んだもので、保存（save）したときだけファイルへ書く
let kind = null, handle = null, dirty = false;
let stamp = null; // 最後に読み書きしたときのファイルの { lastModified, size }。ほかのアプリによる変更を見つけるため

// sahpool はパスを URL のパス名として正規化（パーセントエンコード）して保存する
const fileOf = (name) => new URL(`/${name}.sqlite3`, 'file://irrelevant').pathname;

async function init() {
  sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'sqlite-sheet', initialCapacity: 8 });
  return { version: sqlite3.version.libVersion };
}

function list() {
  return pool.getFileNames()
    .filter((f) => f.endsWith('.sqlite3'))
    .map((f) => decodeURIComponent(f.slice(1, -'.sqlite3'.length)))
    .sort((a, b) => a.localeCompare(b));
}

/** 未保存の変更ができたことを main に知らせる（OPFS の DB では何もしない） */
function markDirty() {
  if (kind !== 'file' || dirty) return;
  dirty = true;
  self.postMessage({ event: 'dirty', dirty: true });
}

// トランザクション中か（GUI からでも SQL コンソールの BEGIN でも）。呼び出しのたびに確かめ、変わったら main に知らせる
let lastTx = false;
const inTx = () => !!db && !sqlite3.capi.sqlite3_get_autocommit(db.pointer);
function notifyTx() {
  const v = inTx();
  if (v !== lastTx) { lastTx = v; self.postMessage({ event: 'tx', inTx: v }); }
}
const TX_BLOCK = 'トランザクション中です。先に確定か取り消しをしてください';

function begin() { need().exec('BEGIN'); return true; }
function commit() { if (inTx()) need().exec('COMMIT'); return true; }
function rollback() { if (inTx()) need().exec('ROLLBACK'); return true; }

function setDirty(v) {
  if (dirty === v) return;
  dirty = v;
  self.postMessage({ event: 'dirty', dirty: v });
}

const stampOf = (f) => ({ lastModified: f.lastModified, size: f.size });

/** 開いた（保存した）後に、ファイルがほかのアプリで変更されたか */
async function checkFile() {
  if (kind !== 'file') return { changed: false, dirty: false };
  const f = await handle.getFile();
  return { changed: f.lastModified !== stamp.lastModified || f.size !== stamp.size, dirty };
}

// ファイルへ書き込む。ほかのアプリで変更されていたら、force でない限り書かずに CONFLICT を返す。
// createWritable は一時ファイルに書いて close で差し替えるので、途中で落ちても元のファイルは壊れない
async function save(force = false) {
  if (kind !== 'file') throw new Error('ファイルを開いていません');
  // 確定していない変更をファイルに書かないように
  if (inTx()) throw new Error(TX_BLOCK);
  if (!force && (await checkFile()).changed) throw new Error('CONFLICT');
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  const w = await handle.createWritable();
  try { await w.write(bytes); await w.close(); } catch (e) {
    await w.abort().catch(() => {});
    throw new Error('ファイルに保存できませんでした：' + (e?.message ?? e));
  }
  stamp = stampOf(await handle.getFile());
  setDirty(false);
  return true;
}

// 未保存の変更は捨てる（保存するかどうかは main が先に尋ねる）
async function close() {
  if (!db) return true;
  db.close(); db = null; currentName = null; kind = null; handle = null; stamp = null;
  setDirty(false);
  return true;
}

async function open(name) {
  await close();
  await pool.reserveMinimumCapacity(pool.getFileNames().length + 4);
  db = new pool.OpfsSAHPoolDb(fileOf(name));
  db.exec('PRAGMA foreign_keys = ON');
  currentName = name; kind = 'opfs';
  return true;
}

// 端末のファイルを開く（中身をメモリに読み込む。読み直しにも使う）
async function openFile(name, h) {
  const f = await h.getFile();
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (bytes.length && new TextDecoder().decode(bytes.subarray(0, 15)) !== 'SQLite format 3') {
    throw new Error('SQLite のデータベースファイルではありません');
  }
  await close();
  const d = new sqlite3.oo1.DB(':memory:');
  try {
    if (bytes.length) {
      const p = sqlite3.wasm.allocFromTypedArray(bytes);
      const { capi } = sqlite3;
      d.checkRc(capi.sqlite3_deserialize(d.pointer, 'main', p, bytes.length, bytes.length,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE));
    }
    d.exec('PRAGMA foreign_keys = ON');
  } catch (e) { d.close(); throw e; }
  db = d; currentName = name; kind = 'file'; handle = h; stamp = stampOf(f);
  return true;
}

function need() {
  if (!db) throw new Error('DB が開かれていません');
  return db;
}

// 複数文を実行し、最後に行を返した文の結果を返す
function run(sql, bind) {
  const d = need();
  const before = sqlite3.capi.sqlite3_total_changes(d.pointer);
  let lastStmt = null, columns = [], rows = [];
  d.exec({
    sql, bind,
    rowMode: 'array',
    callback: (row, stmt) => {
      if (stmt !== lastStmt) {
        lastStmt = stmt;
        columns = stmt.getColumnNames();
        rows = [];
      }
      rows.push(row);
    },
  });
  // 結果行0件の SELECT でも列名を返す
  if (!lastStmt && bind === undefined && /^\s*(select|with|pragma|values)/i.test(sql) && !sql.trim().replace(/;\s*$/, '').includes(';')) {
    const st = d.prepare(sql);
    // WITH … INSERT など行を返さない文は列が0個（getColumnNames は例外になる）
    try { if (st.columnCount > 0) columns = st.getColumnNames(); } finally { st.finalize(); }
  }
  if (sqlite3.capi.sqlite3_total_changes(d.pointer) !== before) markDirty();
  return { columns, rows, changes: d.changes(), lastId: Number(sqlite3.capi.sqlite3_last_insert_rowid(d.pointer)) };
}

// セルに入れる式（SELECT (式) …）を、実行せずに用意だけして確かめる。
// 1文だけ・読み取り専用・列が1つなら、式は自分の ( ) の中に収まっていて、UPDATE や INSERT に埋め込んでも外へ漏れない
function checkExpr(sql) {
  const st = need().prepare(sql);
  try {
    // prepare は最初の文だけを用意して残りを捨てるので、余りがあればエラーにする
    if (sqlite3.capi.sqlite3_sql(st.pointer).trim() !== sql.trim()) throw new Error('式は1つだけ書けます');
    if (!sqlite3.capi.sqlite3_stmt_readonly(st.pointer)) throw new Error('式で DB を変更することはできません');
    if (sqlite3.capi.sqlite3_column_count(st.pointer) !== 1) throw new Error('式は1つだけ書けます');
  } finally { st.finalize(); }
}

// 文の配列を1トランザクション（SAVEPOINT）で実行。失敗したら全部戻す
function batch(stmts) {
  const d = need();
  const results = [];
  d.exec('SAVEPOINT sheet_batch');
  try {
    for (const s of stmts) {
      // 式を埋め込んだ文は、先に式だけを確かめてから実行する
      for (const e of s.checks ?? []) checkExpr(e);
      results.push(run(s.sql, s.bind));
    }
    d.exec('RELEASE sheet_batch');
    markDirty();
  } catch (e) {
    d.exec('ROLLBACK TO sheet_batch; RELEASE sheet_batch');
    throw e;
  }
  return results;
}

// テーブル再作成など、foreign_keys を一時的に切る必要がある処理
function rebuild(stmts) {
  const d = need();
  // 外部キーの検査を一時的に切る必要があり、それはトランザクション中にはできない
  if (inTx()) throw new Error(TX_BLOCK);
  d.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON');
  try {
    d.exec('BEGIN');
    try {
      for (const s of stmts) d.exec({ sql: s.sql, bind: s.bind });
      const bad = [];
      d.exec({ sql: 'PRAGMA foreign_key_check', rowMode: 'object', callback: (r) => { bad.push(r); } });
      if (bad.length) {
        throw new Error(`外部キー制約に違反する行が ${bad.length} 件あるため適用できません（例: ${bad[0].table} の rowid ${bad[0].rowid} → ${bad[0].parent}）`);
      }
      d.exec('COMMIT');
      markDirty();
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  } finally {
    d.exec('PRAGMA foreign_keys = ON; PRAGMA legacy_alter_table = OFF');
  }
  return true;
}

async function create(name) {
  if (list().includes(name)) throw new Error(`「${name}」は既にあります`);
  await open(name);
  return true;
}

// 書き込み用：行の変更がなくても（CREATE TABLE など）未保存の印を付ける
function exec(sql, bind) {
  const r = run(sql, bind);
  markDirty();
  return r;
}

function exportDb(name) {
  if (name === currentName && kind === 'file') return sqlite3.capi.sqlite3_js_db_export(db);
  if (name === currentName) need().exec('PRAGMA wal_checkpoint');
  const bytes = pool.exportFile(fileOf(name));
  return bytes;
}

async function importDb(name, bytes) {
  if (name === currentName) await close();
  await pool.reserveMinimumCapacity(pool.getFileNames().length + 4);
  // 作ったばかりでまだ何も書いていない DB は 0 バイト。importDb は受け付けないので、空の DB として作る
  if (!bytes.length) { new pool.OpfsSAHPoolDb(fileOf(name)).close(); return true; }
  await pool.importDb(fileOf(name), bytes);
  return true;
}

async function remove(name) {
  if (name === currentName) await close();
  pool.unlink(fileOf(name));
  return true;
}

async function rename(from, to) {
  if (list().includes(to)) throw new Error(`「${to}」は既にあります`);
  const bytes = exportDb(from);
  await importDb(to, bytes);
  await remove(from);
  return true;
}

async function copy(from, to) {
  if (list().includes(to)) throw new Error(`「${to}」は既にあります`);
  await importDb(to, exportDb(from));
  return true;
}

const api = { init, list, open, openFile, close, save, checkFile, begin, commit, rollback, run, exec, batch, rebuild, create, exportDb, importDb, remove, rename, copy };

// 呼び出しは1つずつ順に処理する（ファイルの読み書きを待つ間に、次の呼び出しが割り込まないように）
let queue = Promise.resolve();
self.onmessage = (e) => { queue = queue.then(() => dispatch(e)); };

async function dispatch(e) {
  const { id, method, args } = e.data;
  try {
    const result = await api[method](...args);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    notifyTx();
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    notifyTx();
    self.postMessage({ id, error: String(err?.message ?? err).replace(/^SQLITE_\w+: (sqlite3 result code \d+: )?/, '') });
  }
}
