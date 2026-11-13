// Worker との Promise RPC。発行した SQL はログとして購読者に流す。
const worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
const logListeners = new Set();
const dirtyListeners = new Set();
const txListeners = new Set();
let inTx = false;

worker.onmessage = (e) => {
  // ファイル DB に未保存の変更があるかの知らせ（id のない通知）
  if (e.data.event === 'dirty') { for (const f of dirtyListeners) f(e.data.dirty); return; }
  if (e.data.event === 'tx') { inTx = e.data.inTx; for (const f of txListeners) f(e.data.inTx); return; }
  const { id, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  error !== undefined ? p.reject(new Error(error)) : p.resolve(result);
};

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });
}

function log(sql, bind, source, error) {
  for (const f of logListeners) f({ sql, bind, source, error, at: new Date() });
}

async function logged(fn, items, source) {
  try {
    const r = await fn();
    for (const s of items) log(s.sql, s.bind, source);
    return r;
  } catch (e) {
    for (const s of items) log(s.sql, s.bind, source, e.message);
    throw e;
  }
}

export const db = {
  init: () => call('init'),
  list: () => call('list'),
  open: (name) => call('open', name),
  /** 端末のファイル（FileSystemFileHandle）をメモリに読み込んで開く（読み直しにも使う） */
  openFile: (name, handle) => call('openFile', name, handle),
  close: () => call('close'),
  /** ファイルへ保存する。ほかのアプリで変更されていれば force でない限り 'CONFLICT' で失敗する */
  save: (force = false) => call('save', force),
  /** {changed: ほかのアプリで変更されたか, dirty: 未保存の変更があるか} */
  checkFile: () => call('checkFile'),
  create: (name) => call('create', name),
  remove: (name) => call('remove', name),
  rename: (a, b) => call('rename', a, b),
  copy: (a, b) => call('copy', a, b),
  exportDb: (name) => call('exportDb', name),
  importDb: (name, bytes) => call('importDb', name, bytes),
  /** 読み取り用。ログに出さない */
  query: (sql, bind) => call('run', sql, bind),
  /** 書き込み用。ログに出す */
  exec: (sql, bind, source = 'gui') => logged(() => call('exec', sql, bind), [{ sql, bind }], source),
  batch: (stmts, source = 'gui') => logged(() => call('batch', stmts), stmts, source),
  rebuild: (stmts, source = 'gui') => logged(() => call('rebuild', stmts), stmts, source),
  /** batch と同じ。変わった行の記録（{bytes, tables, rows}）も返す：{results, changes, untrackable} */
  batchTracked: (stmts, source = 'gui') => logged(() => call('batchTracked', stmts), stmts, source),
  /** 記録（changeset の配列、実行した順）を当てる（dir: 'undo' | 'redo'） */
  applyChangeset: (bytes, dir) => logged(() => call('applyChangeset', bytes, dir), [{ sql: dir === 'undo' ? '-- 元に戻す' : '-- やり直す' }], dir),
  /** SQL コンソール：1文ずつ確かめながら実行。元に戻せない文の手前で止まる（paused） */
  consoleRun: (sql, opts) => logged(() => call('consoleRun', sql, opts), [{ sql }], 'console'),
  onLog: (f) => logListeners.add(f),
  /** ファイル DB の未保存の変更の有無（true/false）の購読 */
  onDirty: (f) => dirtyListeners.add(f),
  /** トランザクション中か（true/false）の購読。SQL コンソールの BEGIN / COMMIT でも届く */
  onTx: (f) => txListeners.add(f),
  /** 今トランザクション中か */
  inTx: () => inTx,
  begin: () => logged(() => call('begin'), [{ sql: 'BEGIN' }], 'gui'),
  commit: () => logged(() => call('commit'), [{ sql: 'COMMIT' }], 'gui'),
  rollback: () => logged(() => call('rollback'), [{ sql: 'ROLLBACK' }], 'gui'),
};

/** 識別子のクォート */
export const q = (name) => '"' + String(name).replaceAll('"', '""') + '"';

/** 値をSQLリテラルに（ログ表示・生成SQL用） */
export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return "X'" + [...v].map((b) => b.toString(16).padStart(2, '0')).join('') + "'";
  return "'" + String(v).replaceAll("'", "''") + "'";
}

/** バインド値を埋め込んだ表示用SQL */
export function inline(sql, bind) {
  if (!bind || !bind.length) return sql;
  let i = 0;
  return sql.replace(/\?/g, () => lit(bind[i++]));
}
