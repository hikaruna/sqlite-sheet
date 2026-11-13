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

// ---------- 変更の記録（SQLite のセッション）と、記録の当て直し ----------
// 元に戻すために、実行の前後でどの行がどう変わったかを記録する。トリガーや CASCADE で変わった行も入る。
// 主キーのない表も記録できるよう、行の内部番号（rowid）を主キー代わりにする設定にする
const OBJCONFIG_ROWID = 2;     // SQLITE_SESSION_OBJCONFIG_ROWID（capi に定数がない）
const CHANGESET_ABORT = 2;     // 食い違いがあれば当てるのをやめる
const OP = { 18: 'insert', 9: 'delete', 23: 'update' };
const MAX_TRACKED_BYTES = 64 * 1024 * 1024; // これより大きい記録は持たない（元に戻せない扱い）

function check(rc, what) { if (rc) throw new Error(`${what} に失敗しました（${sqlite3.capi.sqlite3_js_rc_str(rc) || rc}）`); }

/** fn を実行し、その間に変わった行の記録（changeset）を一緒に返す。何も変わらなければ null */
function withSession(fn) {
  const { capi, wasm } = sqlite3, d = need();
  const sp = wasm.pstack.pointer;
  let ses = 0;
  try {
    const pp = wasm.pstack.allocPtr();
    check(capi.sqlite3session_create(d.pointer, 'main', pp), '変更の記録');
    ses = wasm.peekPtr(pp);
    const on = wasm.pstack.alloc(4); wasm.poke32(on, 1);
    capi.sqlite3session_object_config(ses, OBJCONFIG_ROWID, on);
    check(capi.sqlite3session_attach(ses, null), '変更の記録');
    const result = fn();
    let bytes = null;
    try {
      const pn = wasm.pstack.alloc(4), pc = wasm.pstack.allocPtr();
      check(capi.sqlite3session_changeset(ses, pn, pc), '変更の記録');
      const n = wasm.peek32(pn), p = wasm.peekPtr(pc);
      if (n && n <= MAX_TRACKED_BYTES) bytes = wasm.heap8u().slice(p, p + n);
      if (p) capi.sqlite3_free(p);
      if (n > MAX_TRACKED_BYTES) return { result, changeset: null, tooLarge: true };
    } catch { return { result, changeset: null, failed: true }; } // 途中で表の形が変わったなど
    return { result, changeset: bytes && summarize(bytes) };
  } finally {
    if (ses) capi.sqlite3session_delete(ses);
    wasm.pstack.restore(sp);
  }
}

/** 表の列名（changeset の列の順。生成列のうち保存しないものは入らない） */
function storedColumns(t) {
  const cols = [];
  need().exec({ sql: 'SELECT name, pk, hidden FROM pragma_table_xinfo(?)', bind: [t], rowMode: 'array', callback: (r) => { if (r[2] !== 1 && r[2] !== 2) cols.push({ name: r[0], pk: r[1] }); } });
  return cols;
}

/**
 * 記録を読んで、表ごとの件数と、変わった行の一覧を作る。
 * 行は主キー（主キーのない表は {_rowid_}）で表す。更新なら値が変わった列名も付ける
 */
function summarize(bytes) {
  const { capi, wasm } = sqlite3;
  const sp = wasm.pstack.pointer;
  const p = wasm.allocFromTypedArray(bytes);
  const tables = {}, rows = [], colCache = new Map();
  let it = 0;
  try {
    const pIt = wasm.pstack.allocPtr();
    check(capi.sqlite3changeset_start(pIt, bytes.length, p), '変更の記録の読み取り');
    it = wasm.peekPtr(pIt);
    const pTab = wasm.pstack.allocPtr(), pN = wasm.pstack.alloc(4), pOp = wasm.pstack.alloc(4), pInd = wasm.pstack.alloc(4);
    const pPk = wasm.pstack.allocPtr(), pV = wasm.pstack.allocPtr();
    const val = (getter, i) => { pV && wasm.pokePtr(pV, 0); getter(it, i, pV); const v = wasm.peekPtr(pV); return v ? { v: capi.sqlite3_value_to_js(v) } : null; };
    while (capi.sqlite3changeset_next(it) === capi.SQLITE_ROW) {
      capi.sqlite3changeset_op(it, pTab, pN, pOp, pInd);
      const t = wasm.cstrToJs(wasm.peekPtr(pTab)), n = wasm.peek32(pN), op = OP[wasm.peek32(pOp)];
      capi.sqlite3changeset_pk(it, pPk, pN);
      const pkFlags = wasm.peekPtr(pPk);
      if (!colCache.has(t)) colCache.set(t, storedColumns(t));
      let names = colCache.get(t).map((c) => c.name);
      // 主キーのない表は、先頭に rowid が主キーとして入る
      if (n === names.length + 1) names = ['_rowid_', ...names];
      const key = {}, cols = [];
      for (let i = 0; i < n; i++) {
        const name = names[i] ?? `#${i}`;
        if (wasm.peek8(pkFlags + i)) {
          const v = op === 'insert' ? val(capi.sqlite3changeset_new, i) : val(capi.sqlite3changeset_old, i);
          key[name] = v?.v ?? null;
        } else if (op === 'update' && val(capi.sqlite3changeset_new, i)) cols.push(name);
      }
      (tables[t] ??= { insert: 0, delete: 0, update: 0 })[op]++;
      rows.push({ t, op, key, cols });
    }
  } finally {
    if (it) capi.sqlite3changeset_finalize(it);
    wasm.dealloc(p);
    wasm.pstack.restore(sp);
  }
  return { bytes, tables, rows };
}

const CHANGESET_OMIT = 0;
const CONFLICT_DATA = 1, CONFLICT_NOTFOUND = 2;

/**
 * 食い違いが「もう当たっている」だけかどうか。当てている途中で外部キーの CASCADE が先に動くと、
 * 消すはずの子の行がもう無い（NOTFOUND）・直すはずの値がもう新しい値になっている（DATA）ことがある。
 * それは狙いどおりの状態なので飛ばしてよい
 */
function alreadyApplied(type, it) {
  const { capi, wasm } = sqlite3;
  const sp = wasm.pstack.pointer;
  try {
    const pTab = wasm.pstack.allocPtr(), pN = wasm.pstack.alloc(4), pOp = wasm.pstack.alloc(4), pInd = wasm.pstack.alloc(4);
    capi.sqlite3changeset_op(it, pTab, pN, pOp, pInd);
    const op = OP[wasm.peek32(pOp)], n = wasm.peek32(pN);
    if (type === CONFLICT_NOTFOUND) return op === 'delete';
    if (type !== CONFLICT_DATA || op !== 'update') return false;
    const pV = wasm.pstack.allocPtr();
    for (let i = 0; i < n; i++) {
      wasm.pokePtr(pV, 0); capi.sqlite3changeset_new(it, i, pV);
      const nv = wasm.peekPtr(pV);
      if (!nv) continue; // この列は変えない
      wasm.pokePtr(pV, 0); capi.sqlite3changeset_conflict(it, i, pV);
      const cv = wasm.peekPtr(pV);
      if (!cv || !sameValue(capi.sqlite3_value_to_js(nv), capi.sqlite3_value_to_js(cv))) return false;
    }
    return true;
  } finally { wasm.pstack.restore(sp); }
}

function sameValue(a, b) {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b || (typeof a !== typeof b && a != null && b != null && String(a) === String(b));
}

/**
 * 記録を当てる。list は changeset の配列（実行した順）。dir が 'undo' なら逆順に、それぞれ逆向きにして当てる。
 * 全部を1つの SAVEPOINT で当て、食い違いがあれば何も変えずに失敗する
 */
function applyChangeset(list, dir) {
  const d = need();
  const items = dir === 'undo' ? [...list].reverse() : list;
  // 記録にはトリガーが変えた行も入っているので、当てる間はトリガーを止める（動くと二重に変わる）
  const setTriggers = (on) => sqlite3.capi.sqlite3_db_config(d.pointer, DBCONFIG_ENABLE_TRIGGER, on ? 1 : 0, 0);
  setTriggers(false);
  try {
    d.exec('SAVEPOINT sheet_apply');
    try {
      for (const bytes of items) applyOne(bytes, dir);
      d.exec('RELEASE sheet_apply');
    } catch (e) {
      d.exec('ROLLBACK TO sheet_apply; RELEASE sheet_apply');
      throw e;
    }
  } finally { setTriggers(true); }
  markDirty();
  return true;
}
const DBCONFIG_ENABLE_TRIGGER = 1003;

function applyOne(bytes, dir) {
  const { capi, wasm } = sqlite3, d = need();
  const sp = wasm.pstack.pointer;
  const src = wasm.allocFromTypedArray(bytes);
  let p = src, n = bytes.length, inv = 0;
  try {
    if (dir === 'undo') {
      const pn = wasm.pstack.alloc(4), pp = wasm.pstack.allocPtr();
      check(capi.sqlite3changeset_invert(bytes.length, src, pn, pp), '変更の記録の反転');
      n = wasm.peek32(pn); p = inv = wasm.peekPtr(pp);
    }
    let conflict = false;
    const rc = capi.sqlite3changeset_apply(d.pointer, n, p, 0, (_, type, it) => {
      if (alreadyApplied(type, it)) return CHANGESET_OMIT;
      conflict = true; return CHANGESET_ABORT;
    }, 0);
    if (conflict) throw new Error('データが変わっていて元に戻せません');
    check(rc, '元に戻す');
  } finally {
    if (inv) capi.sqlite3_free(inv);
    wasm.dealloc(src);
    wasm.pstack.restore(sp);
  }
}

/** GUI 用：batch を変更の記録つきで実行する */
function batchTracked(stmts) {
  const r = withSession(() => batch(stmts));
  return { results: r.result, changes: r.changeset, untrackable: !!(r.tooLarge || r.failed) };
}

// ---------- SQL コンソール：1文ずつ用意して、何をする文かを確かめてから実行する ----------
// 1 読み取り、2 データの変更（記録して元に戻せる）、3 表や列を変える・消すなど元に戻せない操作。
// 3 の文に来たら、確認が済むまで実行せずに止めて返す
const AUTH = { DELETE: 9, INSERT: 18, UPDATE: 23, PRAGMA: 19, TRANSACTION: 22, SAVEPOINT: 32 };
const UNDOABLE_SCHEMA = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 24, 25, 26, 27, 28, 29, 30]);

function classify(codes, stmt) {
  const { capi } = sqlite3;
  if (codes.some((c) => UNDOABLE_SCHEMA.has(c.code))) return 3;
  if (codes.some((c) => c.code === AUTH.PRAGMA && c.arg != null)) return 3; // 値を書き換える PRAGMA
  if (codes.some((c) => c.code === AUTH.INSERT || c.code === AUTH.UPDATE || c.code === AUTH.DELETE)) return 2;
  if (codes.some((c) => c.code === AUTH.TRANSACTION || c.code === AUTH.SAVEPOINT)) return 0;
  if (!capi.sqlite3_stmt_readonly(stmt)) return 3; // VACUUM など
  return 1;
}

/**
 * opts: { from: 何文字目から, confirmAt: 確認が済んだ文の位置, confirmAll: 残りも確認しない }
 * 返り値: { columns, rows, changes, schemaChanged, changeset, untrackable, paused?, at?, text? }
 */
function consoleRun(sql, { from = 0, confirmAt = -1, confirmAll = false } = {}) {
  const { capi, wasm } = sqlite3, d = need();
  const before = capi.sqlite3_total_changes(d.pointer);
  const out = { columns: [], rows: [], changes: 0, schemaChanged: false };
  const tracked = withSession(() => {
    const enc = new TextEncoder().encode(sql);
    const dec = new TextDecoder();
    const sp = wasm.pstack.pointer;
    const base = wasm.allocFromTypedArray(new Uint8Array([...enc, 0]));
    try {
      const startByte = new TextEncoder().encode(sql.slice(0, from)).length;
      let pos = base + startByte;
      const end = base + enc.length;
      const ppStmt = wasm.pstack.allocPtr(), ppTail = wasm.pstack.allocPtr();
      // 途中の文で失敗しても、それより前に実行した文の記録は残す（out.error に入れて返す）
      try {
      while (pos < end) {
        const codes = [];
        capi.sqlite3_set_authorizer(d.pointer, (_, code, a, b) => {
          const s = (x) => (typeof x === 'number' ? (x ? wasm.cstrToJs(x) : null) : x);
          codes.push({ code, name: s(a), arg: s(b) }); return 0;
        }, 0);
        let rc;
        try { rc = capi.sqlite3_prepare_v3(d.pointer, pos, end - pos, 0, ppStmt, ppTail); }
        finally { capi.sqlite3_set_authorizer(d.pointer, 0, 0); }
        if (rc) throw new Error(capi.sqlite3_errmsg(d.pointer));
        const stmt = wasm.peekPtr(ppStmt), tail = wasm.peekPtr(ppTail);
        const at = dec.decode(enc.subarray(0, pos - base)).length;
        if (!stmt) { pos = tail; continue; } // 空白やコメントだけ
        try {
          const cat = classify(codes, stmt);
          if (cat === 3 && !confirmAll && at !== confirmAt) {
            out.paused = true; out.at = at; out.text = capi.sqlite3_sql(stmt).trim();
            return;
          }
          if (cat === 3) out.schemaChanged = true;
          const nCol = capi.sqlite3_column_count(stmt);
          const rows = [];
          for (;;) {
            const s = capi.sqlite3_step(stmt);
            if (s === capi.SQLITE_ROW) {
              const row = [];
              for (let i = 0; i < nCol; i++) row.push(capi.sqlite3_column_js(stmt, i));
              rows.push(row);
            } else if (s === capi.SQLITE_DONE) break;
            else throw new Error(capi.sqlite3_errmsg(d.pointer));
          }
          if (nCol > 0) {
            out.columns = Array.from({ length: nCol }, (_, i) => capi.sqlite3_column_name(stmt, i));
            out.rows = rows;
          }
          out.changes = capi.sqlite3_changes(d.pointer);
        } finally { capi.sqlite3_finalize(stmt); }
        pos = tail;
      }
      } catch (e) {
        out.error = String(e?.message ?? e).replace(/^SQLITE_\w+: (sqlite3 result code \d+: )?/, '');
      }
    } finally {
      wasm.dealloc(base);
      wasm.pstack.restore(sp);
    }
  });
  const changed = capi.sqlite3_total_changes(d.pointer) !== before;
  if (changed || out.schemaChanged) markDirty();
  out.changeset = out.schemaChanged ? null : tracked.changeset;
  // 行は変わったのに記録できなかった（大きすぎる・仮想表など）なら、元に戻せない
  out.untrackable = !out.schemaChanged && changed && !tracked.changeset;
  return out;
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

const api = { init, list, open, openFile, close, save, checkFile, begin, commit, rollback, run, exec, batch, batchTracked, applyChangeset, consoleRun, rebuild, create, exportDb, importDb, remove, rename, copy };

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
