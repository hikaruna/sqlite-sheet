// Worker との Promise RPC。発行した SQL はログとして購読者に流す。
const worker = new Worker(new URL('./db-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
const logListeners = new Set();

worker.onmessage = (e) => {
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
  close: () => call('close'),
  create: (name) => call('create', name),
  remove: (name) => call('remove', name),
  rename: (a, b) => call('rename', a, b),
  copy: (a, b) => call('copy', a, b),
  exportDb: (name) => call('exportDb', name),
  importDb: (name, bytes) => call('importDb', name, bytes),
  /** 読み取り用。ログに出さない */
  query: (sql, bind) => call('run', sql, bind),
  /** 書き込み用。ログに出す */
  exec: (sql, bind, source = 'gui') => logged(() => call('run', sql, bind), [{ sql, bind }], source),
  batch: (stmts, source = 'gui') => logged(() => call('batch', stmts), stmts, source),
  rebuild: (stmts, source = 'gui') => logged(() => call('rebuild', stmts), stmts, source),
  onLog: (f) => logListeners.add(f),
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
