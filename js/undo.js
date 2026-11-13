// Undo/Redo。各操作は「元に戻す関数」と「やり直す関数」の組（undoFn / redoFn）で記録する。
// データの変更は、SQLite のセッションで取った変更の記録（changeset）を逆向き・そのままに当てる（pushChanges）。
// 列幅や名前の変更などは、それぞれの関数で戻す
import { db } from './db-client.js';
import { txMarks } from './txmarks.js';

const LIMIT = 200;
let past = [], future = [];
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());

export const undo = {
  push(entry) { past.push(entry); if (past.length > LIMIT) past.shift(); future = []; txMarks.onDo(entry); emit(); },
  clear() { past = []; future = []; emit(); },
  /** 今の記録の写し（トランザクションの開始時に取っておく） */
  snapshot: () => ({ past: [...past], future: [...future] }),
  /**
   * 写しの状態に戻す（トランザクションを取り消したとき）。DB は開始前に戻っているので、記録も開始前に揃える。
   * 開始後に積んだ記録は消え、開始後に元に戻した・やり直した記録は元の側に戻る
   */
  restore(snap) { past = [...snap.past]; future = [...snap.future]; this.resetTx(); emit(); },
  /** 各記録の「トランザクション中に付けた印」の状態を消す（確定・取り消しの後） */
  resetTx() { for (const e of [...past, ...future]) delete e.tx; },
  canUndo: () => past.length > 0,
  canRedo: () => future.length > 0,
  peekUndo: () => past.at(-1)?.label,
  peekRedo: () => future.at(-1)?.label,
  /** 戻した記録を返す（どのシートのどこを戻したかを見せるため。entry.sheet / entry.cells / entry.col） */
  async undo() {
    const e = past.pop();
    if (!e) return null;
    try { await e.undoFn(); } catch (err) { past.push(e); throw err; }
    txMarks.onUndo(e);
    future.push(e); emit();
    return e;
  },
  async redo() {
    const e = future.pop();
    if (!e) return null;
    try { await e.redoFn(); } catch (err) { future.push(e); throw err; }
    txMarks.onDo(e);
    past.push(e); emit();
    return e;
  },
  onChange: (f) => listeners.add(f),
};

/** 表ごとの件数の言い方（「商品」500 行・「注文」3 行）。多い順 */
export function tableSummary(tables) {
  return Object.entries(tables ?? {})
    .map(([t, n]) => [t, n.insert + n.delete + n.update])
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `「${t}」${n} 行`).join('・');
}

/**
 * 変更の記録（db.batchTracked / db.consoleRun が返す changes。複数なら配列）を、元に戻す1操作として積む。
 * r: { changes, untrackable }
 *  - 記録できなかった（大きすぎる等）なら、それより前の記録とも辻褄が合わなくなるので全部消す
 *  - 何も変わらなかったなら何もしない
 * sheet を省くと、一番多く変わった表のシートにする。extra.onUndo / onRedo は戻した・やり直した後に呼ぶ
 */
export function pushChanges(label, sheet, r, extra = {}) {
  if (r.untrackable) { undo.clear(); return null; }
  const list = (Array.isArray(r.changes) ? r.changes : [r.changes]).filter(Boolean);
  if (!list.length) return null;
  const tables = {}, rows = list.flatMap((c) => c.rows);
  for (const c of list) for (const [t, n] of Object.entries(c.tables)) {
    const m = (tables[t] ??= { insert: 0, delete: 0, update: 0 });
    m.insert += n.insert; m.delete += n.delete; m.update += n.update;
  }
  const top = Object.entries(tables).sort((a, b) => (b[1].insert + b[1].delete + b[1].update) - (a[1].insert + a[1].delete + a[1].update))[0]?.[0];
  // 戻した場所を見せる・未確定の印を付けるための、変わったセル（更新は列ごと、追加・削除は行全体）
  const cells = (op) => rows.filter((x) => x.op === op || x.op === 'update')
    .flatMap((x) => (x.op === 'update' ? x.cols.map((col) => ({ t: x.t, key: x.key, col })) : [{ t: x.t, key: x.key, col: null }]));
  const entry = {
    label, sheet: sheet ?? (top ? 't:' + top : null), tables,
    cells: { after: cells('insert'), before: cells('delete') },
    undoFn: async () => { await db.applyChangeset(list.map((c) => c.bytes), 'undo'); extra.onUndo?.(); },
    redoFn: async () => { await db.applyChangeset(list.map((c) => c.bytes), 'redo'); extra.onRedo?.(); },
  };
  undo.push(entry);
  return entry;
}
