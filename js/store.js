// DB ごとの端末側データ（localStorage）。DB の中にはアプリ用のデータを書かない。
//   queries:<DB>     保存クエリ [{name, sql}]
//   order:<DB>       シートの並び順
//   last-sheet:<DB>  最後に開いたシート
//   w:<DB>/<表>      列の幅
// DB の名前変更・複製・削除・作り直しに合わせて、ここでまとめて付け替える・消す。
import { toast } from './ui.js';

const exact = ['queries:', 'order:', 'last-sheet:'];

/** その DB に属するキー（w: は「w:<DB>/」で一致させ、別 DB 名の前方一致を拾わない） */
function keysOf(db) {
  const own = new Set(exact.map((p) => p + db));
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (own.has(k) || k.startsWith(`w:${db}/`)) keys.push(k);
  }
  return keys;
}

function renameKey(k, from, to) {
  return k.startsWith('w:') ? `w:${to}/` + k.slice(`w:${from}/`.length) : k.slice(0, k.length - from.length) + to;
}

export function getQueries(db) {
  try {
    const v = JSON.parse(localStorage.getItem('queries:' + db) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && typeof x.sql === 'string') : [];
  } catch { return []; }
}

export function setQueries(db, list) {
  try {
    localStorage.setItem('queries:' + db, JSON.stringify(list.map(({ name, sql }) => ({ name, sql }))));
  } catch (e) {
    toast('クエリを保存できませんでした（ブラウザの保存領域がいっぱいかもしれません）', 'error');
    throw e;
  }
}

export function removeDb(db) {
  try { for (const k of keysOf(db)) localStorage.removeItem(k); } catch { /* 無視 */ }
}

export function copyDb(from, to) {
  try {
    removeDb(to);
    for (const k of keysOf(from)) localStorage.setItem(renameKey(k, from, to), localStorage.getItem(k));
  } catch { /* 見た目の設定なので失敗しても続ける */ }
}

export function renameDb(from, to) {
  copyDb(from, to);
  removeDb(from);
}
