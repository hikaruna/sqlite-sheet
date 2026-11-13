// Undo/Redo。データの編集は「元に戻す SQL」と「やり直す SQL」の組で、
// 列幅のような表示の変更は「元に戻す関数」と「やり直す関数」の組（undoFn / redoFn）で記録する
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
  async undo() {
    const e = past.pop();
    if (!e) return null;
    try { await (e.undoFn ? e.undoFn() : db.batch(e.undo, 'undo')); } catch (err) { past.push(e); throw err; }
    txMarks.onUndo(e);
    future.push(e); emit();
    return e.label;
  },
  async redo() {
    const e = future.pop();
    if (!e) return null;
    try { await (e.redoFn ? e.redoFn() : db.batch(e.redo, 'redo')); } catch (err) { future.push(e); throw err; }
    txMarks.onDo(e);
    past.push(e); emit();
    return e.label;
  },
  onChange: (f) => listeners.add(f),
};
