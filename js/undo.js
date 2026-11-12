// Undo/Redo。データの編集は「元に戻す SQL」と「やり直す SQL」の組で、
// 列幅のような表示の変更は「元に戻す関数」と「やり直す関数」の組（undoFn / redoFn）で記録する
import { db } from './db-client.js';

const LIMIT = 200;
let past = [], future = [];
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());

export const undo = {
  push(entry) { past.push(entry); if (past.length > LIMIT) past.shift(); future = []; emit(); },
  clear() { past = []; future = []; emit(); },
  canUndo: () => past.length > 0,
  canRedo: () => future.length > 0,
  peekUndo: () => past.at(-1)?.label,
  peekRedo: () => future.at(-1)?.label,
  async undo() {
    const e = past.pop();
    if (!e) return null;
    try { await (e.undoFn ? e.undoFn() : db.batch(e.undo, 'undo')); } catch (err) { past.push(e); throw err; }
    future.push(e); emit();
    return e.label;
  },
  async redo() {
    const e = future.pop();
    if (!e) return null;
    try { await (e.redoFn ? e.redoFn() : db.batch(e.redo, 'redo')); } catch (err) { future.push(e); throw err; }
    past.push(e); emit();
    return e.label;
  },
  onChange: (f) => listeners.add(f),
};
