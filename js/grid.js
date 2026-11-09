// スプレッドシート風グリッド：仮想スクロール、セル選択、編集、コピー＆ペースト
import { el, modKey, fmtBytes } from './ui.js';

const RH = 28;          // 行の高さ
const HH = 34;          // 見出しの高さ
const RHW = 56;         // 行番号の幅
const PAGE = 200;
const DEFAULT_W = 150;

export const NULL_LABEL = 'NULL';

/**
 * source: {
 *   columns: [{name, type, badges:[], readonly, align}],
 *   editable, widthKey,
 *   count(): Promise<number>,
 *   fetch(offset, limit): Promise<{key, values}[]>,
 *   update(changes[{row, col, value, rowObj}]): Promise<{row, rowObj}[]>,
 *   insert(rows: Array<Array<any|undefined>>): Promise<void>,
 * }
 */
export class Grid {
  constructor(host, source, hooks = {}) {
    this.host = host;
    this.source = source;
    this.hooks = hooks;
    this.pages = new Map();
    this.loading = new Map();
    this.rowCount = 0;
    this.cur = { r: 0, c: 0 };
    this.anchor = { r: 0, c: 0 };
    this.editing = null;   // { mode: 'enter'|'edit', r, c, original }
    this.widths = this.loadWidths();
    this.build();
  }

  get cols() { return this.source.columns; }
  get totalRows() { return this.rowCount + (this.source.editable ? 1 : 0); }
  get newRowIndex() { return this.source.editable ? this.rowCount : -1; }

  // ---------- 構築 ----------
  build() {
    this.host.replaceChildren();
    this.scroll = el('div.grid-scroll', { tabIndex: -1 });
    this.inner = el('div.grid-inner');
    this.header = el('div.grid-header');
    this.body = el('div.grid-body');
    this.sink = el('textarea.grid-sink', { spellcheck: false, autocomplete: 'off', rows: 1, 'aria-label': 'セル入力' });
    this.inner.append(this.body, this.sink);
    this.scroll.append(this.header, this.inner);
    this.host.append(this.scroll);
    this.empty = null;

    this.scroll.addEventListener('scroll', () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.scroll);
    this.body.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.body.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.body.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.sink.addEventListener('keydown', (e) => this.onKey(e));
    this.sink.addEventListener('input', () => this.onSinkInput());
    this.sink.addEventListener('compositionstart', () => { if (!this.editing) this.beginEdit('enter', ''); });
    this.sink.addEventListener('blur', () => { if (this.editing && !this.sinkFocusKeep) this.commitEdit({ move: null }); });
    this.sink.addEventListener('copy', (e) => { if (!this.editing) { e.preventDefault(); this.copy(); } });
    this.sink.addEventListener('cut', (e) => { if (!this.editing) { e.preventDefault(); this.copy().then(() => this.clearSelection()); } });
    this.sink.addEventListener('paste', (e) => { if (!this.editing) { e.preventDefault(); this.paste(e.clipboardData.getData('text/plain')); } });
    this.renderHeader();
  }

  async reload({ keepSelection = true } = {}) {
    const token = (this.reloadToken = (this.reloadToken || 0) + 1);
    const count = await this.source.count();
    if (token !== this.reloadToken) return; // 後から始まった再読み込みを優先
    this.pages.clear();
    this.loading.clear();
    this.rowCount = count;
    if (!keepSelection) { this.cur = { r: 0, c: 0 }; this.anchor = { ...this.cur }; }
    this.clampCursor();
    this.inner.style.height = (this.totalRows * RH) + 'px';
    this.renderHeader();
    this.render();
    this.emitSelect();
  }

  focus() { this.sink.focus({ preventScroll: true }); }

  // ---------- 列幅 ----------
  loadWidths() {
    try { return JSON.parse(localStorage.getItem('w:' + this.source.widthKey) || '{}'); } catch { return {}; }
  }
  saveWidths() {
    try { localStorage.setItem('w:' + this.source.widthKey, JSON.stringify(this.widths)); } catch { /* 無視 */ }
  }
  colW(c) { const col = this.cols[c]; return this.widths[col.name] ?? col.width ?? (col.width = autoWidth(col)); }
  colX(c) { let x = RHW; for (let i = 0; i < c; i++) x += this.colW(i); return x; }
  totalW() { return this.colX(this.cols.length) + (this.hooks.onAddColumn ? 48 : 0); }

  // ---------- 見出し ----------
  renderHeader() {
    const h = this.header;
    h.replaceChildren();
    h.style.width = this.totalW() + 'px';
    this.inner.style.width = this.totalW() + 'px';
    h.append(el('div.gh-corner', { style: { width: RHW + 'px' }, title: 'すべて選択', on: { mousedown: (e) => { e.preventDefault(); this.selectAll(); } } }));
    this.cols.forEach((col, c) => {
      const cell = el('div.gh-cell', {
        style: { width: this.colW(c) + 'px' },
        class: col.readonly ? 'ro' : '',
        title: col.title || '',
        on: {
          mousedown: (e) => {
            if (e.button !== 0 || e.target.closest('.gh-btn, .gh-resize')) return;
            e.preventDefault();
            if (e.shiftKey) { this.cur = { r: this.cur.r, c }; } else { this.anchor = { r: 0, c }; this.cur = { r: Math.max(0, this.rowCount - 1), c }; }
            this.anchor = { r: 0, c: e.shiftKey ? this.anchor.c : c };
            this.cur = { r: Math.max(0, this.rowCount - 1), c };
            this.colSelect = true;
            this.render(); this.emitSelect(); this.focus();
          },
          contextmenu: (e) => { e.preventDefault(); this.hooks.onHeaderMenu?.(c, { x: e.clientX, y: e.clientY }); },
        },
      },
      el('span.gh-name', col.name),
      ...(col.badges || []).map((b) => el('span.gh-badge', { class: b.cls || '', title: b.title || '' }, b.text)),
      el('span.gh-spacer'),
      col.sort ? el('span.gh-sort', col.sort === 'asc' ? '↑' : '↓') : null,
      col.filtered ? el('span.gh-filter', { title: '絞り込み中' }, '⏷') : null,
      el('button.gh-btn', { title: '列メニュー', on: { click: (e) => { e.stopPropagation(); this.hooks.onHeaderMenu?.(c, e.currentTarget); } } }, '⋮'),
      el('div.gh-resize', { on: { mousedown: (e) => this.startResize(e, c) } }));
      h.append(cell);
    });
    if (this.hooks.onAddColumn) {
      h.append(el('button.gh-add', { title: '列を追加', on: { click: (e) => this.hooks.onAddColumn(e.currentTarget) } }, '＋'));
    }
  }

  startResize(e, c) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = this.colW(c);
    const move = (ev) => {
      this.widths[this.cols[c].name] = Math.max(48, startW + ev.clientX - startX);
      this.renderHeader(); this.render();
    };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); this.saveWidths(); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }

  // ---------- データ取得 ----------
  rowAt(r) {
    const p = Math.floor(r / PAGE);
    const page = this.pages.get(p);
    if (page) return page[r - p * PAGE];
    this.loadPage(p);
    return undefined;
  }

  loadPage(p) {
    if (this.loading.has(p)) return this.loading.get(p);
    const gen = this.reloadToken;
    const pr = this.source.fetch(p * PAGE, PAGE).then((rows) => {
      if (gen !== this.reloadToken) return rows; // 古い読み込み結果は捨てる
      this.pages.set(p, rows);
      this.loading.delete(p);
      this.render();
      if (Math.floor(this.cur.r / PAGE) === p) this.emitSelect();
      return rows;
    }).catch((err) => { this.loading.delete(p); this.hooks.onError?.(err); });
    this.loading.set(p, pr);
    return pr;
  }

  async rowsBetween(r0, r1) {
    const out = [];
    for (let p = Math.floor(r0 / PAGE); p <= Math.floor(r1 / PAGE); p++) {
      if (!this.pages.has(p)) await this.loadPage(p);
    }
    for (let r = r0; r <= r1; r++) out.push(this.rowAt(r));
    return out;
  }

  // ---------- 描画 ----------
  render() {
    const st = this.scroll.scrollTop;
    const vh = this.scroll.clientHeight;
    const first = Math.max(0, Math.floor((st - HH) / RH) - 4);
    const last = Math.min(this.totalRows - 1, Math.ceil((st + vh) / RH) + 4);
    const { r0, r1, c0, c1 } = this.range();
    const frag = document.createDocumentFragment();
    const widths = this.cols.map((_, c) => this.colW(c));
    for (let r = first; r <= last; r++) {
      const isNew = r === this.newRowIndex;
      const row = isNew ? null : this.rowAt(r);
      const rowSel = r >= r0 && r <= r1;
      const rowEl = el('div.gr', { class: isNew ? 'new' : '', style: { top: (r * RH) + 'px', width: this.totalW() + 'px' }, dataset: { r } });
      rowEl.append(el('div.gr-head', {
        class: rowSel ? 'hl' : '',
        style: { width: RHW + 'px' },
        title: isNew ? '新しい行' : '',
      }, isNew ? '＊' : String(r + 1)));
      for (let c = 0; c < this.cols.length; c++) {
        const cell = el('div.gc', { style: { width: widths[c] + 'px' }, dataset: { c } });
        const col = this.cols[c];
        if (col.align === 'right') cell.classList.add('num');
        if (col.readonly || !this.source.editable) cell.classList.add('ro');
        if (rowSel && c >= c0 && c <= c1) cell.classList.add('sel');
        if (r === this.cur.r && c === this.cur.c) cell.classList.add('cur');
        if (isNew) {
          if (c === 0) cell.append(el('span.placeholder', 'ここに入力して行を追加'));
        } else if (!row) {
          cell.classList.add('loading');
        } else {
          this.fillCell(cell, row.values[c], col, row, r, c);
        }
        if (col.fk && this.source.editable && r === this.cur.r && c === this.cur.c && this.hooks.onFkPick) {
          cell.append(el('button.fk-drop', {
            title: '参照先から選ぶ（Alt+↓）',
            on: { mousedown: (e) => { e.preventDefault(); e.stopPropagation(); this.hooks.onFkPick(r, c, e.currentTarget); } },
          }, '▾'));
        }
        rowEl.append(cell);
      }
      frag.append(rowEl);
    }
    this.body.replaceChildren(frag);
    this.placeSink();
    this.renderEmpty();
  }

  renderEmpty() {
    const show = this.rowCount === 0 && !this.source.editable;
    if (show && !this.empty) {
      this.empty = el('div.grid-empty', '行がありません');
      this.host.append(this.empty);
    } else if (!show && this.empty) { this.empty.remove(); this.empty = null; }
  }

  fillCell(cell, v, col, row, r, c) {
    const err = row.errors?.[c];
    if (err) { cell.classList.add('err'); cell.title = err; }
    if (v === null || v === undefined) { cell.classList.add('null'); cell.textContent = NULL_LABEL; return; }
    if (v instanceof Uint8Array) { cell.classList.add('blob'); cell.textContent = `BLOB ${fmtBytes(v.length)}`; return; }
    if (typeof v === 'number' || typeof v === 'bigint') { cell.classList.add('num'); }
    const s = String(v);
    if (s === '') { cell.classList.add('emptystr'); return; }
    cell.textContent = s.length > 300 ? s.slice(0, 300) + '…' : s.replaceAll('\n', ' ⏎ ');
    if (col.fk) {
      cell.classList.add('fk');
      const label = row.labels?.[c];
      if (label != null) cell.append(el('span.fk-label', String(label)));
    }
    void r;
  }

  placeSink() {
    const { r, c } = this.cur;
    if (!this.cols.length) return;
    const x = this.colX(c), y = r * RH;
    Object.assign(this.sink.style, {
      left: x + 'px', top: y + 'px',
      width: (this.editing ? Math.max(this.colW(c), 220) : this.colW(c)) + 'px',
      height: (this.editing ? Math.max(RH, Math.min(200, this.sink.scrollHeight)) : RH) + 'px',
    });
    this.sink.classList.toggle('editing', !!this.editing);
  }

  // ---------- 選択 ----------
  range() {
    return {
      r0: Math.min(this.anchor.r, this.cur.r), r1: Math.max(this.anchor.r, this.cur.r),
      c0: Math.min(this.anchor.c, this.cur.c), c1: Math.max(this.anchor.c, this.cur.c),
    };
  }

  clampCursor() {
    const maxR = Math.max(0, this.totalRows - 1), maxC = Math.max(0, this.cols.length - 1);
    for (const p of [this.cur, this.anchor]) { p.r = Math.min(Math.max(0, p.r), maxR); p.c = Math.min(Math.max(0, p.c), maxC); }
  }

  moveTo(r, c, extend = false) {
    this.cur = { r, c };
    this.clampCursor();
    if (!extend) this.anchor = { ...this.cur };
    this.colSelect = false;
    this.ensureVisible();
    this.render();
    this.emitSelect();
  }

  selectAll() {
    this.anchor = { r: 0, c: 0 };
    this.cur = { r: Math.max(0, this.rowCount - 1), c: this.cols.length - 1 };
    this.render(); this.emitSelect(); this.focus();
  }

  selectRows(r0, r1) {
    this.anchor = { r: r0, c: 0 };
    this.cur = { r: r1, c: this.cols.length - 1 };
    this.render(); this.emitSelect();
  }

  ensureVisible() {
    const { r, c } = this.cur;
    const s = this.scroll;
    const top = r * RH, bottom = top + RH + HH;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (bottom > s.scrollTop + s.clientHeight) s.scrollTop = bottom - s.clientHeight;
    const x = this.colX(c), w = this.colW(c);
    if (x - RHW < s.scrollLeft) s.scrollLeft = x - RHW;
    else if (x + w > s.scrollLeft + s.clientWidth) s.scrollLeft = x + w - s.clientWidth;
  }

  emitSelect() {
    const { r, c } = this.cur;
    const row = r === this.newRowIndex ? null : this.rowAt(r);
    this.hooks.onSelect?.({ r, c, row, isNew: r === this.newRowIndex, range: this.range(), col: this.cols[c] });
  }

  cellFromEvent(e) {
    const cellEl = e.target.closest('.gc, .gr-head');
    const rowEl = e.target.closest('.gr');
    if (!rowEl) return null;
    const r = +rowEl.dataset.r;
    if (cellEl?.classList.contains('gr-head')) return { r, head: true };
    if (!cellEl) return null;
    return { r, c: +cellEl.dataset.c };
  }

  onMouseDown(e) {
    const hit = this.cellFromEvent(e);
    if (!hit) return;
    if (e.button === 2) {
      // 右クリックは選択範囲外のときだけ選択を移す
      const { r0, r1, c0, c1 } = this.range();
      const inside = hit.r >= r0 && hit.r <= r1 && (hit.head || (hit.c >= c0 && hit.c <= c1));
      if (!inside) hit.head ? this.selectRows(hit.r, hit.r) : this.moveTo(hit.r, hit.c);
      return;
    }
    e.preventDefault();
    if (this.editing) this.commitEdit({ move: null });
    if (hit.head) {
      if (hit.r === this.newRowIndex) { this.moveTo(hit.r, 0); this.focus(); return; }
      this.selectRows(e.shiftKey ? this.anchor.r : hit.r, hit.r);
      this.focus();
    } else {
      if (modKey(e) && this.hooks.onCellCtrlClick) {
        const row = this.rowAt(hit.r);
        if (row && this.hooks.onCellCtrlClick(hit.r, hit.c, row)) return;
      }
      this.moveTo(hit.r, hit.c, e.shiftKey);
      this.focus();
      // ドラッグで範囲選択
      const move = (ev) => {
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const h = target && this.body.contains(target) ? this.cellFromEvent({ target }) : null;
        if (h && !h.head && (h.r !== this.cur.r || h.c !== this.cur.c)) this.moveTo(h.r, h.c, true);
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    }
  }

  onDblClick(e) {
    const hit = this.cellFromEvent(e);
    if (!hit || hit.head) return;
    this.moveTo(hit.r, hit.c);
    this.beginEdit('edit');
  }

  onContextMenu(e) {
    e.preventDefault();
    const hit = this.cellFromEvent(e);
    if (!hit) return;
    this.hooks.onContextMenu?.({ x: e.clientX, y: e.clientY }, { ...this.range(), head: hit.head });
  }

  // ---------- 編集 ----------
  canEdit(r, c) {
    if (!this.source.editable) return false;
    const col = this.cols[c];
    if (!col || col.readonly) return false;
    if (r !== this.newRowIndex && !this.rowAt(r)) return false;
    return true;
  }

  currentValue() {
    const { r, c } = this.cur;
    if (r === this.newRowIndex) return undefined;
    return this.rowAt(r)?.values[c];
  }

  beginEdit(mode, initial) {
    const { r, c } = this.cur;
    if (!this.canEdit(r, c)) {
      this.sink.value = '';
      if (this.source.editable) this.hooks.onReadonlyEdit?.(this.cols[c]);
      return false;
    }
    const v = this.currentValue();
    if (v instanceof Uint8Array) { this.hooks.onBlobEdit?.(r, c); this.sink.value = ''; return false; }
    this.editing = { mode, r, c, original: v };
    if (initial !== undefined) { /* 入力済みの文字をそのまま使う */ } else this.sink.value = v == null ? '' : String(v);
    this.placeSink();
    if (mode === 'edit') { const n = this.sink.value.length; this.sink.setSelectionRange(n, n); }
    this.hooks.onEditState?.(true, this.sink.value);
    return true;
  }

  onSinkInput() {
    if (!this.editing) {
      const typed = this.sink.value;
      if (!this.beginEdit('enter', typed)) return;
    }
    this.placeSink();
    this.hooks.onEditState?.(true, this.sink.value);
  }

  cancelEdit() {
    this.editing = null;
    this.sink.value = '';
    this.placeSink();
    this.hooks.onEditState?.(false);
  }

  /** 外部（数式バー）からの値設定 */
  async setCurrent(text) {
    const { r, c } = this.cur;
    if (!this.canEdit(r, c)) return false;
    return this.write([{ r, c, value: text }]);
  }

  async commitEdit({ move = 'down' } = {}) {
    if (!this.editing) return;
    const { r, c, original, mode } = this.editing;
    const text = this.sink.value;
    this.editing = null;
    this.sink.value = '';
    this.placeSink();
    this.hooks.onEditState?.(false);
    // 変化なしなら書かない。NULL のセルを開いて何も打たずに確定した場合も NULL のまま
    const unchanged = original == null ? (text === '' && mode === 'edit') : String(original) === text;
    const emptyNewRow = r === this.newRowIndex && text === '';
    // 先に移動してから書き込む（書き込み待ちの間の入力を取りこぼさない）。失敗したら write がセルに戻す
    // 新しい行で Enter → 確定後も次の新しい行へ。Tab など横移動 → 追加された行に留まって続けて入力
    this.afterInsert = move === 'down' ? 'newrow' : 'stay';
    const pending = !unchanged && !emptyNewRow ? this.write([{ r, c, value: text }]) : null;
    if (move === 'down') this.moveTo(this.cur.r + 1, this.cur.c);
    else if (move === 'right') this.moveTo(this.cur.r, this.cur.c + 1);
    else if (move === 'left') this.moveTo(this.cur.r, this.cur.c - 1);
    else if (move === 'up') this.moveTo(this.cur.r - 1, this.cur.c);
    if (pending) await pending;
  }

  /** 書き込み。changes: [{r, c, value(文字列 or null)}] 新しい行へのものは INSERT */
  async write(changes) {
    const updates = [], inserts = new Map();
    for (const ch of changes) {
      if (this.cols[ch.c]?.readonly) continue;
      if (ch.r >= this.rowCount) {
        const k = ch.r - this.rowCount;
        if (!inserts.has(k)) inserts.set(k, new Array(this.cols.length).fill(undefined));
        inserts.get(k)[ch.c] = ch.value;
      } else {
        const row = this.rowAt(ch.r);
        if (row) updates.push({ row: ch.r, col: ch.c, value: ch.value, rowObj: row });
      }
    }
    try {
      if (updates.length) {
        const res = await this.source.update(updates);
        for (const { row, rowObj } of res) {
          const p = Math.floor(row / PAGE);
          const page = this.pages.get(p);
          if (page) page[row - p * PAGE] = rowObj;
        }
      }
      if (inserts.size) {
        const oldCount = this.rowCount;
        const intent = this.afterInsert;
        this.afterInsert = null;
        await this.source.insert([...inserts.keys()].sort((a, b) => a - b).map((k) => inserts.get(k)));
        const keep = { ...this.cur };
        const keepAnchor = { ...this.anchor };
        await this.reload();
        if (keep.r >= oldCount && changes.length === 1) {
          // 1セル入力で行を追加した場合
          keep.r = intent === 'newrow' ? this.newRowIndex : oldCount;
          this.cur = keep; this.anchor = { ...keep };
        } else { this.cur = keep; this.anchor = keepAnchor; }
        // 追加を待つ間に次の新しい行へ打ち始めていたら、その編集も新しい行へ付け替える
        if (this.editing && this.editing.r >= oldCount) this.editing.r = this.newRowIndex;
        this.ensureVisible();
      }
      this.render(); this.emitSelect();
      return true;
    } catch (err) {
      this.hooks.onError?.(err);
      // 失敗した値を残して再編集できるように
      if (changes.length === 1) {
        const ch = changes[0];
        this.cur = { r: ch.r, c: ch.c }; this.anchor = { ...this.cur };
        this.render(); this.emitSelect();
        if (ch.value !== null) {
          this.sink.value = ch.value;
          this.editing = { mode: 'edit', r: ch.r, c: ch.c, original: this.currentValue() };
          this.placeSink();
          this.sink.classList.add('invalid');
          setTimeout(() => this.sink.classList.remove('invalid'), 1500);
          this.hooks.onEditState?.(true, ch.value);
        }
        this.focus();
      }
      return false;
    }
  }

  async clearSelection() {
    const { r0, r1, c0, c1 } = this.range();
    const changes = [];
    for (let r = r0; r <= Math.min(r1, this.rowCount - 1); r++) {
      for (let c = c0; c <= c1; c++) if (!this.cols[c].readonly) changes.push({ r, c, value: null });
    }
    if (changes.length && this.source.editable) await this.write(changes);
  }

  // ---------- クリップボード ----------
  async copy() {
    const { r0, r1, c0, c1 } = this.range();
    const last = Math.min(r1, this.rowCount - 1);
    if (last < r0) return;
    const rows = await this.rowsBetween(r0, last);
    const tsv = rows.map((row) => {
      const vals = [];
      for (let c = c0; c <= c1; c++) vals.push(toTsvCell(row?.values[c]));
      return vals.join('\t');
    }).join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      this.hooks.onInfo?.(`${(last - r0 + 1) * (c1 - c0 + 1)} セルをコピーしました`);
    } catch { this.hooks.onError?.(new Error('クリップボードに書き込めませんでした')); }
  }

  async paste(text) {
    if (!this.source.editable) { this.hooks.onReadonlyEdit?.(); return; }
    const data = parseTsv(text);
    if (!data.length) return;
    let { r0, c0, r1, c1 } = this.range();
    // 1セルのコピーを範囲に貼ると全体に繰り返す
    const single = data.length === 1 && data[0].length === 1 && (r1 > r0 || c1 > c0);
    const changes = [];
    const rows = single ? r1 - r0 + 1 : data.length;
    const cols = single ? c1 - c0 + 1 : Math.max(...data.map((d) => d.length));
    if (!single && c0 + cols > this.cols.length) {
      this.hooks.onError?.(new Error(`貼り付けるデータが ${cols} 列あり、右端からはみ出します`));
      return;
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const v = single ? data[0][0] : data[i][j];
        if (v === undefined) continue;
        changes.push({ r: r0 + i, c: c0 + j, value: v });
      }
    }
    const ok = await this.write(changes);
    if (ok) {
      this.anchor = { r: r0, c: c0 };
      this.cur = { r: Math.min(r0 + rows - 1, this.totalRows - 1), c: c0 + cols - 1 };
      this.render(); this.emitSelect();
      if (changes.length > 1) this.hooks.onInfo?.(`${changes.length} セルを貼り付けました`);
    }
  }

  // ---------- キーボード ----------
  onKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const k = e.key, mod = modKey(e);
    if (this.editing) {
      const enterMode = this.editing.mode === 'enter';
      if (k === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
      if (k === 'Enter' && (e.altKey || e.ctrlKey && !isMacCtrl())) {
        e.preventDefault();
        const s = this.sink, p = s.selectionStart;
        s.setRangeText('\n', p, s.selectionEnd, 'end'); this.onSinkInput(); return;
      }
      if (k === 'Enter') { e.preventDefault(); this.commitEdit({ move: e.shiftKey ? 'up' : 'down' }); return; }
      if (k === 'Tab') { e.preventDefault(); this.commitEdit({ move: e.shiftKey ? 'left' : 'right' }); return; }
      if (enterMode && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
        e.preventDefault();
        this.commitEdit({ move: { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[k] });
        return;
      }
      if (k === 'F2') { e.preventDefault(); this.editing.mode = this.editing.mode === 'enter' ? 'edit' : 'enter'; return; }
      return;
    }
    const { r, c } = this.cur;
    const ext = e.shiftKey;
    const jump = (dr, dc) => {
      if (mod) {
        if (dr) return this.moveTo(dr < 0 ? 0 : Math.max(0, this.rowCount - 1), c, ext);
        return this.moveTo(r, dc < 0 ? 0 : this.cols.length - 1, ext);
      }
      this.moveTo(r + dr, c + dc, ext);
    };
    const pageRows = Math.max(1, Math.floor(this.scroll.clientHeight / RH) - 2);
    if (k === 'ArrowDown' && e.altKey && this.cols[c]?.fk && this.hooks.onFkPick) {
      e.preventDefault();
      const cellEl = this.body.querySelector(`.gr[data-r="${r}"] .gc[data-c="${c}"]`);
      return this.hooks.onFkPick(r, c, cellEl || this.sink);
    }
    if (mod && k === '-' && this.hooks.onDeleteRows) { e.preventDefault(); return this.hooks.onDeleteRows(); }
    switch (k) {
      case 'ArrowUp': e.preventDefault(); return jump(-1, 0);
      case 'ArrowDown': e.preventDefault(); return jump(1, 0);
      case 'ArrowLeft': e.preventDefault(); return jump(0, -1);
      case 'ArrowRight': e.preventDefault(); return jump(0, 1);
      case 'PageUp': e.preventDefault(); return this.moveTo(r - pageRows, c, ext);
      case 'PageDown': e.preventDefault(); return this.moveTo(r + pageRows, c, ext);
      case 'Home': e.preventDefault(); return mod ? this.moveTo(0, 0, ext) : this.moveTo(r, 0, ext);
      case 'End': e.preventDefault(); return mod ? this.moveTo(this.totalRows - 1, this.cols.length - 1, ext) : this.moveTo(r, this.cols.length - 1, ext);
      case 'Tab': e.preventDefault(); return this.moveTo(r, c + (e.shiftKey ? -1 : 1));
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) return this.moveTo(r - 1, c);
        return this.beginEdit('edit');
      case 'F2': e.preventDefault(); return this.beginEdit('edit');
      case 'Delete': case 'Backspace': e.preventDefault(); return this.clearSelection();
      case 'Escape': this.anchor = { ...this.cur }; this.render(); return;
    }
    if (mod && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'a') { e.preventDefault(); return this.selectAll(); }
      if (lk === 'z') { e.preventDefault(); return e.shiftKey ? this.hooks.onRedo?.() : this.hooks.onUndo?.(); }
      if (lk === 'y') { e.preventDefault(); return this.hooks.onRedo?.(); }
      if (lk === 'd') { e.preventDefault(); return this.fillDown(); }
      return; // c / x / v はネイティブイベントに任せる
    }
    if (k === ' ' && e.shiftKey) { e.preventDefault(); const { r0, r1 } = this.range(); return this.selectRows(r0, r1); }
    // 印字可能文字は sink の input イベントで編集開始
  }

  async fillDown() {
    const { r0, r1, c0, c1 } = this.range();
    if (r1 <= r0 || !this.source.editable) return;
    const [top] = await this.rowsBetween(r0, r0);
    const changes = [];
    for (let r = r0 + 1; r <= Math.min(r1, this.rowCount - 1); r++) {
      for (let c = c0; c <= c1; c++) {
        const v = top.values[c];
        changes.push({ r, c, value: v == null ? null : v instanceof Uint8Array ? v : String(v) });
      }
    }
    await this.write(changes);
  }
}

function autoWidth(col) {
  const ctx = (autoWidth.ctx ??= document.createElement('canvas').getContext('2d'));
  ctx.font = '600 13px system-ui, sans-serif';
  let w = ctx.measureText(col.name).width + 44;
  ctx.font = '600 10px system-ui, sans-serif';
  for (const b of col.badges || []) w += ctx.measureText(b.text).width + 14;
  return Math.round(Math.min(360, Math.max(DEFAULT_W - 50, w)));
}

function isMacCtrl() { return /Mac/.test(navigator.platform); }

function toTsvCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Uint8Array) return '';
  const s = String(v);
  return /[\t\n"]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

/** Excel / Google スプレッドシート形式の TSV を解析 */
export function parseTsv(text) {
  if (text.endsWith('\n')) text = text.replace(/\r?\n$/, '');
  const rows = []; let row = []; let cell = ''; let i = 0; let quoted = false;
  text = text.replace(/\r\n/g, '\n');
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell); rows.push(row);
  return rows;
}
