// SQLite を独占する Worker。opfs-sahpool VFS を使うので COOP/COEP ヘッダー不要。
import sqlite3InitModule from 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.54.1-build1/dist/index.mjs';

let sqlite3, pool, db = null, currentName = null;

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

function close() {
  if (db) { db.close(); db = null; currentName = null; }
}

async function open(name) {
  close();
  await pool.reserveMinimumCapacity(pool.getFileNames().length + 4);
  db = new pool.OpfsSAHPoolDb(fileOf(name));
  db.exec('PRAGMA foreign_keys = ON');
  currentName = name;
  return true;
}

function need() {
  if (!db) throw new Error('DB が開かれていません');
  return db;
}

// 複数文を実行し、最後に行を返した文の結果を返す
function run(sql, bind) {
  const d = need();
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
  } catch (e) {
    d.exec('ROLLBACK TO sheet_batch; RELEASE sheet_batch');
    throw e;
  }
  return results;
}

// テーブル再作成など、foreign_keys を一時的に切る必要がある処理
function rebuild(stmts) {
  const d = need();
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

function exportDb(name) {
  if (name === currentName) need().exec('PRAGMA wal_checkpoint');
  const bytes = pool.exportFile(fileOf(name));
  return bytes;
}

async function importDb(name, bytes) {
  if (name === currentName) close();
  await pool.reserveMinimumCapacity(pool.getFileNames().length + 4);
  // 作ったばかりでまだ何も書いていない DB は 0 バイト。importDb は受け付けないので、空の DB として作る
  if (!bytes.length) { new pool.OpfsSAHPoolDb(fileOf(name)).close(); return true; }
  await pool.importDb(fileOf(name), bytes);
  return true;
}

function remove(name) {
  if (name === currentName) close();
  pool.unlink(fileOf(name));
  return true;
}

async function rename(from, to) {
  if (list().includes(to)) throw new Error(`「${to}」は既にあります`);
  const bytes = exportDb(from);
  await importDb(to, bytes);
  remove(from);
  return true;
}

async function copy(from, to) {
  if (list().includes(to)) throw new Error(`「${to}」は既にあります`);
  await importDb(to, exportDb(from));
  return true;
}

const api = { init, list, open, close, run, batch, rebuild, create, exportDb, importDb, remove, rename, copy };

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const result = await api[method](...args);
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err).replace(/^SQLITE_\w+: (sqlite3 result code \d+: )?/, '') });
  }
};
