// 「ローカルファイルを直接編集」モードの補助：最近開いたファイルと、読み書きの許可。
// 最近開いたファイルはファイルハンドルだけを IndexedDB に持つ（中身は持たない）。
//   { id: 連番, name: ファイル名, handle: FileSystemFileHandle, at: 開いた時刻 }
const DB_NAME = 'sqlite-sheet-recent', STORE = 'recent', MAX = 10;

/** File System Access API（ファイルの直接編集）が使えるか（Chrome / Edge） */
export const supported = typeof window.showOpenFilePicker === 'function';

export const PICKER_TYPES = [{ description: 'SQLite データベース', accept: { 'application/x-sqlite3': ['.sqlite', '.sqlite3', '.db'] } }];

// 最初の試作で使っていた、DB の一覧にファイルを混ぜる方式の保存先。もう使わないので消す
try { indexedDB.deleteDatabase('sqlite-sheet-files'); } catch { /* 無視 */ }

let opening = null;
function idb() {
  opening ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = null; reject(r.error); };
  });
  return opening;
}

async function tx(mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

/** 新しい順の [{id, name, handle, at}] */
export async function list() {
  if (!supported) return [];
  try {
    const rows = await tx('readonly', (s) => s.getAll());
    return rows.sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/** 先頭に加える（同じファイルがあれば入れ替える）。古いものは MAX 件を超えた分を消す */
export async function add(handle) {
  const rows = await list();
  const same = [];
  for (const r of rows) if (await r.handle.isSameEntry(handle).catch(() => false)) same.push(r.id);
  const drop = [...same, ...rows.filter((r) => !same.includes(r.id)).slice(MAX - 1).map((r) => r.id)];
  await tx('readwrite', (s) => {
    for (const id of drop) s.delete(id);
    return s.add({ name: handle.name, handle, at: Date.now() });
  });
}

export const remove = (id) => tx('readwrite', (s) => s.delete(id));

/**
 * 読み書きの許可を確かめ、まだなら尋ねる（ユーザーの操作の直後でないと尋ねられない）。
 * @returns {Promise<boolean>}
 */
export async function ensurePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}
