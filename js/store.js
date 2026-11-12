// DB ごとの端末側データ（localStorage）。DB の中にはアプリ用のデータを書かない。
//   queries:<DB>     保存クエリ [{name, sql}]
//   order:<DB>       シートの並び順
//   last-sheet:<DB>  最後に開いたシート
//   w:<DB>/<表>      列の幅
//   meta:<DB>        {created, viewed, updated}：作成・最後に開いた・最後に書き込んだ時刻（ミリ秒）
// DB の名前変更・複製・削除・作り直しに合わせて、ここでまとめて付け替える・消す。
import { toast } from './ui.js';

const exact = ['queries:', 'order:', 'last-sheet:', 'meta:'];

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
    if (!Array.isArray(v)) return [];
    // 壊れた要素は捨て、同じ名前が重なっていたら最初の1つだけ残す
    const seen = new Set();
    return v.filter((x) => x && typeof x.name === 'string' && typeof x.sql === 'string' && !seen.has(x.name) && seen.add(x.name));
  } catch { return []; }
}

/** キー → 持ち主の DB 名（DB に属さないキーは null）。DB 名に「/」は使えないので w: は最初の「/」まで */
function dbOfKey(k) {
  for (const p of exact) if (k.startsWith(p)) return k.slice(p.length);
  const m = k.match(/^w:([^/]*)\//);
  return m ? m[1] : null;
}

function allKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return keys;
}

/** 起動時：もう存在しない DB の値を消す（アプリを通さない削除や途中終了の残り） */
export function sweep(dbs) {
  try {
    const live = new Set(dbs);
    for (const k of allKeys()) { const db = dbOfKey(k); if (db != null && !live.has(db)) localStorage.removeItem(k); }
  } catch { /* 無視 */ }
}

/** DB を開いたとき：もう無い表・シートの列幅を消す。keep(rest) は「w:<DB>/」より後ろを受け取る */
export function sweepWidths(db, keep) {
  try {
    const prefix = `w:${db}/`;
    for (const k of allKeys()) if (k.startsWith(prefix) && !keep(k.slice(prefix.length))) localStorage.removeItem(k);
  } catch { /* 無視 */ }
}

export function setQueries(db, list) {
  try {
    localStorage.setItem('queries:' + db, JSON.stringify(list.map(({ name, sql }) => ({ name, sql }))));
  } catch (e) {
    toast('クエリを保存できませんでした（ブラウザの保存領域がいっぱいかもしれません）', 'error');
    throw e;
  }
}

/** {created, viewed, updated}（無いものは undefined） */
export function getMeta(db) {
  try { const v = JSON.parse(localStorage.getItem('meta:' + db) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** 時刻を記録する。field は 'created' | 'viewed' | 'updated' */
export function touch(db, field, at = Date.now()) {
  try { localStorage.setItem('meta:' + db, JSON.stringify({ ...getMeta(db), [field]: at })); } catch { /* 無視 */ }
}

/**
 * まだ記録のない DB に作成時刻を付ける。新しく作った・取り込んだ DB はここで記録される。
 * 記録を始める前からある DB は、本当の作成時刻がわからないので、初めて見つけた時刻にする
 */
export function ensureCreated(dbs) {
  for (const db of dbs) if (getMeta(db).created == null) touch(db, 'created');
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

/** 複製：設定は引き継ぎ、時刻は新しく作った DB として付け直す */
export function duplicateDb(from, to) {
  copyDb(from, to);
  try { localStorage.setItem('meta:' + to, JSON.stringify({ created: Date.now() })); } catch { /* 無視 */ }
}

export function renameDb(from, to) {
  copyDb(from, to);
  removeDb(from);
}
