// DBの開閉、kvvfs と IndexedDB の保存・復元、Web Locks
import sqlite3InitModule from 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.54.1-build1/dist/index.mjs';

const LOCK_PREFIX = 'sqlite-sheet:';
const IDB_NAME = 'sqlite-sheet';

export let sqlite3 = null;

export async function initSqlite() {
  sqlite3 = await sqlite3InitModule();
  return sqlite3;
}

// ---------- IndexedDB ----------
// meta:    key = DB名, value = { name, updated }
// pages:   key = [DB名, kvvfsキー], value = kvvfs の値（エンコード済み文字列）
// queries: key = DB名, value = [{ id, name, sql }]
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('meta', { keyPath: 'name' });
        d.createObjectStore('pages');
        d.createObjectStore('queries');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const pageRange = (name) => IDBKeyRange.bound([name, ''], [name, '￿']);

async function getMeta(name) {
  const d = await idb();
  return reqP(d.transaction('meta').objectStore('meta').get(name));
}

async function readPages(name) {
  const d = await idb();
  const st = d.transaction('pages').objectStore('pages');
  const [keys, vals] = await Promise.all([reqP(st.getAllKeys(pageRange(name))), reqP(st.getAll(pageRange(name)))]);
  const m = new Map();
  keys.forEach((k, i) => m.set(k[1], vals[i]));
  return m;
}

async function writeAllPages(name, map) {
  const d = await idb();
  const tx = d.transaction(['pages', 'meta'], 'readwrite');
  const st = tx.objectStore('pages');
  st.delete(pageRange(name));
  for (const [k, v] of map) st.put(v, [name, k]);
  tx.objectStore('meta').put({ name, updated: Date.now() });
  await txDone(tx);
}

export async function getQueries(name) {
  const d = await idb();
  return (await reqP(d.transaction('queries').objectStore('queries').get(name))) || [];
}
export async function setQueries(name, arr) {
  const d = await idb();
  const tx = d.transaction('queries', 'readwrite');
  tx.objectStore('queries').put(arr, name);
  await txDone(tx);
}

// ---------- 名前 ----------
export function validateName(name) {
  if (!name) return '名前を入力してください';
  if (new TextEncoder().encode(name).length > 119) return '名前は119バイト以下にしてください';
  if (/[\x00-\x1f]/.test(name)) return '制御文字は使えません';
  if (/-(journal|wal|shm)$/.test(name)) return '-journal / -wal / -shm で終わる名前は使えません';
  if (name === 'local' || name === 'session' || name === '.') return 'この名前は使えません';
  return null;
}

// ---------- 一覧 ----------
export async function listDbs() {
  const d = await idb();
  const metas = await reqP(d.transaction('meta').objectStore('meta').getAll());
  const held = new Set(((await navigator.locks.query()).held || []).map((l) => l.name));
  return metas
    .map((m) => ({ ...m, inUse: held.has(LOCK_PREFIX + m.name) }))
    .sort((a, b) => b.updated - a.updated);
}

export async function dbExists(name) {
  return !!(await getMeta(name));
}

export async function createDb(name) {
  const d = await idb();
  const tx = d.transaction('meta', 'readwrite');
  tx.objectStore('meta').add({ name, updated: Date.now() });
  await txDone(tx);
}

// ロックが取れたら fn を実行。取れなければ 'busy' を投げる。
export function withLock(name, fn) {
  return navigator.locks.request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('busy');
    return fn();
  });
}

// ---------- kvvfs ----------
function buildExport(name, pages) {
  const n = Number(pages.get('sz') || 0);
  const arr = [];
  for (let i = 1; pages.has(String(i)); i++) arr.push(pages.get(String(i)));
  return { name, timestamp: Date.now(), size: n, pages: arr };
}

// IndexedDB の内容を kvvfs のストレージに入れる。
async function restoreToKvvfs(name) {
  const pages = await readPages(name);
  if (pages.size === 0) return false;
  sqlite3.kvvfs.import(buildExport(name, pages), true);
  return true;
}

function exportToMap(name) {
  const ex = sqlite3.kvvfs.export({ name });
  const m = new Map();
  m.set('sz', String(ex.size));
  ex.pages.forEach((p, i) => m.set(String(i + 1), p));
  return m;
}

function openKvvfsDb(name) {
  return new sqlite3.oo1.DB({ filename: name, vfs: 'kvvfs', flags: 'c' });
}

// DBを開く。別タブが使用中なら null。
export function openDb(name) {
  return new Promise((resolve, reject) => {
    let release;
    const held = new Promise((r) => (release = r));
    const req = navigator.locks.request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve(null); return; }
      try {
        // close はロックが実際に解放されるまで待つ
        resolve(await doOpen(name, () => { release(); return req; }));
      } catch (e) {
        release();
        reject(e);
      }
      return held; // close まで保持
    });
    req.catch(reject);
  });
}

async function doOpen(name, release) {
  if (!(await getMeta(name))) throw new Error(`DB「${name}」はありません`);
  sqlite3.kvvfs.reserve(name);
  await restoreToKvvfs(name);

  // 変更ページを IndexedDB へ保存
  const pending = new Map(); // key -> value | null(削除)
  let timer = null;
  let chain = Promise.resolve();
  const flush = () => {
    timer = null;
    if (pending.size === 0) return chain;
    const batch = new Map(pending);
    pending.clear();
    chain = chain.then(async () => {
      const d = await idb();
      const tx = d.transaction(['pages', 'meta'], 'readwrite');
      const st = tx.objectStore('pages');
      for (const [k, v] of batch) {
        if (v === null) st.delete([name, k]); else st.put(v, [name, k]);
      }
      tx.objectStore('meta').put({ name, updated: Date.now() });
      await txDone(tx);
    }).catch((e) => console.error('IndexedDBへの保存に失敗', e));
    return chain;
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 0); };
  const listener = {
    storage: name,
    events: {
      write: ({ data: [k, v] }) => { if (k !== 'jrnl') { pending.set(k, v); schedule(); } },
      delete: ({ data: k }) => { if (k !== 'jrnl') { pending.set(k, null); schedule(); } },
    },
  };
  sqlite3.kvvfs.listen(listener);

  let db;
  try {
    db = openKvvfsDb(name);
    db.exec('PRAGMA foreign_keys = ON');
  } catch (e) {
    sqlite3.kvvfs.unlisten(listener);
    sqlite3.kvvfs.unlink(name);
    throw e;
  }

  const onHide = () => { clearTimeout(timer); flush(); };
  window.addEventListener('pagehide', onHide);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('pagehide', onHide);
    try { db.close(); } catch (e) { console.error(e); }
    // 通知は非同期なので少し待ってから止める
    await new Promise((r) => setTimeout(r, 50));
    clearTimeout(timer);
    await flush();
    sqlite3.kvvfs.unlisten(listener);
    try { sqlite3.kvvfs.unlink(name); } catch (e) { console.error(e); }
    await release();
  };
  return { db, name, close };
}

// ---------- 一覧からの操作（呼び出し側で withLock 済みのこと） ----------
export async function deleteDb(name) {
  const d = await idb();
  const tx = d.transaction(['meta', 'pages', 'queries'], 'readwrite');
  tx.objectStore('pages').delete(pageRange(name));
  tx.objectStore('meta').delete(name);
  tx.objectStore('queries').delete(name);
  await txDone(tx);
}

export async function renameDb(oldName, newName) {
  if (await getMeta(newName)) throw new Error(`「${newName}」は既にあります`);
  return withLock(newName, async () => {
    const pages = await readPages(oldName);
    const queries = await getQueries(oldName);
    const old = await getMeta(oldName);
    const d = await idb();
    const tx = d.transaction(['meta', 'pages', 'queries'], 'readwrite');
    const ps = tx.objectStore('pages');
    ps.delete(pageRange(oldName));
    for (const [k, v] of pages) ps.put(v, [newName, k]);
    tx.objectStore('meta').delete(oldName);
    tx.objectStore('meta').put({ name: newName, updated: old ? old.updated : Date.now() });
    tx.objectStore('queries').delete(oldName);
    tx.objectStore('queries').put(queries, newName);
    await txDone(tx);
  });
}

// 通常の .sqlite ファイルのバイト列を返す
export async function exportDb(name) {
  sqlite3.kvvfs.reserve(name);
  try {
    if (!(await restoreToKvvfs(name))) return new Uint8Array(0);
    const db = openKvvfsDb(name);
    try {
      return sqlite3.capi.sqlite3_js_db_export(db.pointer);
    } finally {
      db.close();
    }
  } finally {
    sqlite3.kvvfs.unlink(name);
  }
}

// .sqlite ファイルを新しいDBとして取り込む
export async function importFile(name, bytes) {
  if (await getMeta(name)) throw new Error(`「${name}」は既にあります`);
  return withLock(name, async () => {
    const { capi, wasm } = sqlite3;
    const mem = new sqlite3.oo1.DB(':memory:');
    try {
      const p = wasm.allocFromTypedArray(bytes);
      const rc = capi.sqlite3_deserialize(mem.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
        capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
      mem.checkRc(rc);
      mem.exec('PRAGMA schema_version'); // ファイルとして正しいか確認
      sqlite3.kvvfs.reserve(name);
      try {
        const uri = 'file:' + encodeURIComponent(name) + '?vfs=kvvfs';
        mem.exec({ sql: 'VACUUM INTO ?', bind: [uri] });
        await writeAllPages(name, exportToMap(name));
      } finally {
        sqlite3.kvvfs.unlink(name);
      }
    } finally {
      mem.close();
    }
  });
}
