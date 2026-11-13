// トランザクション中の「未確定の変更」の印。どのセル（表・行のキー・列）と、どの行（足した・戻ってきた行）が
// 確定前の変更を持っているかを数えて覚える。
//
// 印は「元に戻す」の1操作ごとに付け外しする（undo.js から呼ぶ）。各操作は cells を持つ：
//   cells.after  … その操作をした後に、変わった状態で存在するセル・行
//   cells.before … その操作を元に戻した後に、変わった状態で存在するセル・行
//   cells.rekey  … 主キーを変えた行の [{t, from, to}]（印を新しいキーへ移す）
// トランザクション中に操作すると after の印を付け、それを元に戻すと外す。開始前の操作を
// トランザクション中に元に戻した場合は、それ自体が確定前の変更なので before の印を付ける。
// 同じセルを何度も変えたときは数で持つので、1回元に戻しても残りの変更の印は消えない。

const k = (key) => JSON.stringify(key);
const cellId = (key, col) => k(key) + '|' + (col ?? '');

export const txMarks = {
  on: false,
  /** 表の名前 → Map(「キー|列名」→ 数)。行そのものの印は列名を空にする */
  map: new Map(),

  has(t, key, col) { return this.on && key != null && (this.map.get(t)?.get(cellId(key, col)) ?? 0) > 0; },

  add(list) {
    for (const { t, key, col } of list ?? []) {
      if (key == null) continue;
      if (!this.map.has(t)) this.map.set(t, new Map());
      const m = this.map.get(t), id = cellId(key, col);
      m.set(id, (m.get(id) ?? 0) + 1);
    }
  },

  remove(list) {
    for (const { t, key, col } of list ?? []) {
      const m = this.map.get(t), id = cellId(key, col);
      if (!m?.has(id)) continue;
      const n = m.get(id) - 1;
      if (n > 0) m.set(id, n); else m.delete(id);
    }
  },

  /** 主キーが変わった行の印を、新しいキーへ移す（reverse なら戻す） */
  rekey(list, reverse = false) {
    const items = reverse ? [...(list ?? [])].reverse() : (list ?? []);
    for (const { t, from, to } of items) {
      const [a, b] = reverse ? [to, from] : [from, to];
      const m = this.map.get(t);
      if (!m) continue;
      const prefix = k(a) + '|';
      for (const [id, n] of [...m]) {
        if (!id.startsWith(prefix)) continue;
        m.delete(id);
        const nid = k(b) + '|' + id.slice(prefix.length);
        m.set(nid, (m.get(nid) ?? 0) + n);
      }
    }
  },

  /** 表の名前の変更に追従する */
  renameTable(from, to) {
    if (from === to || !this.map.has(from)) return;
    this.map.set(to, this.map.get(from));
    this.map.delete(from);
  },

  /** 列の名前の変更に追従する */
  renameColumn(t, from, to) {
    const m = this.map.get(t);
    if (!m || from === to) return;
    const suffix = '|' + from;
    for (const [id, n] of [...m]) {
      if (!id.endsWith(suffix)) continue;
      m.delete(id);
      m.set(id.slice(0, -from.length) + to, n);
    }
  },

  clear() { this.map.clear(); },

  // ---- 「元に戻す」の操作ごとの付け外し（undo.js から呼ぶ） ----
  /** 操作をした・やり直した */
  onDo(e) {
    if (!this.on || !e.cells) return;
    if (e.tx === 'before') { this.remove(e.cells.before); this.rekey(e.cells.rekey); e.tx = null; return; }
    this.rekey(e.cells.rekey); this.add(e.cells.after); e.tx = 'after';
  },
  /** 操作を元に戻した */
  onUndo(e) {
    if (!this.on || !e.cells) return;
    if (e.tx === 'after') { this.remove(e.cells.after); this.rekey(e.cells.rekey, true); e.tx = null; return; }
    this.rekey(e.cells.rekey, true); this.add(e.cells.before); e.tx = 'before';
  },
};
