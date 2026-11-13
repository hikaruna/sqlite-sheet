// スプレッドシート風グリッド：仮想スクロール、セル選択、編集、コピー＆ペースト
import { el, modKey, fmtBytes } from './ui.js';
import { convertInput, formText, form, defaultToForm } from './sources.js';

// タッチ端末（指で操作する）か。行を高くし、タップ・長押し・つまみで操作する
export const TOUCH = matchMedia('(pointer: coarse)').matches;
const RH = TOUCH ? 34 : 28; // 行の高さ
const LONG_PRESS = 500;
const HH = 34;          // 見出しの高さ
const RHW = 56;         // 行番号の幅
const PAGE = 200;
const DEFAULT_W = 150;
const MIN_W = 20;        // 列幅の最小（1文字のデータに合わせても使えるように）
// 表の拡大率（タッチ端末で二本指でつまむ）。見出しと表の中身に CSS の zoom を掛ける。
// スクロール位置・表示の大きさは拡大後の値なので、行や列の位置と比べるときは z で割る
const ZOOM_MIN = 0.5, ZOOM_MAX = 2;
const loadZoom = () => { try { const v = Number(localStorage.getItem('grid-zoom')); return v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1; } catch { return 1; } };

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
    this.ext = { r: 0, c: 0 };
    this.editing = null;   // { mode: 'enter'|'edit', r, c, start（開いたときのフォームの文字列） }
    this.draft = null;     // 新しい行の下書き { values: [列ごとの文字列|null|undefined(未入力)], errors: {c: msg} }
    this.widths = this.loadWidths();
    this.z = TOUCH ? loadZoom() : 1;
    this.build();
  }

  get cols() { return this.source.columns; }
  get totalRows() { return this.rowCount + (this.source.editable ? 1 : 0); }
  get newRowIndex() { return this.source.editable ? this.rowCount : -1; }
  get hasDraft() { return !!this.draft && this.draft.values.some((v) => v !== undefined); }

  openDraft() {
    this.draft ??= { values: new Array(this.cols.length).fill(undefined), errors: {} };
  }

  draftSet(c, value) {
    this.openDraft();
    this.draft.values[c] = value;
    delete this.draft.errors[c];
  }

  /** 下書きの未入力のセルに薄く見せる文字（INSERT で何が入るか） */
  placeholderFor(c) {
    const col = this.cols[c];
    if (!col || col.readonly) return '';
    if (col.auto) return '（自動採番）';
    if (col.dflt != null) return defaultToForm(col.dflt);
    return col.notnull ? '' : '=NULL';
  }

  /** フォームを開いたときの文字列。下書きは持っているフォームの文字列、未入力は空 */
  formAt(r, c) {
    if (r === this.newRowIndex) return this.draft?.values[c] ?? '';
    return formText(this.rowAt(r)?.values[c]);
  }

  discardDraft() {
    if (!this.draft) return;
    this.draft = null;
    this.render(); this.emitSelect();
  }

  /** 下書きの行を1回の INSERT で保存する。成功（または下書きなし）なら true */
  flushDraft() {
    if (!this.hasDraft) { this.draft = null; return Promise.resolve(true); }
    if (this.flushing) return this.flushing;
    const values = this.draft.values.slice();
    const draftRow = this.newRowIndex;
    this.flushing = (async () => {
      try {
        await this.source.insert([values.map((v) => (v === undefined ? undefined : form(v)))]);
        this.draft = null;
        const onNew = this.cur.r === draftRow;
        const editingNew = this.editing && this.editing.r === draftRow;
        await this.reload();
        // 新しい行に居続ける操作（最後の列で Tab など）なら、次の下書きの行を開いて続けて入力できるように
        if (onNew) { this.cur = { r: this.newRowIndex, c: this.cur.c }; this.ext = { ...this.cur }; this.openDraft(); }
        if (editingNew) this.editing.r = this.newRowIndex;
        this.ensureVisible(); this.render(); this.emitSelect();
        return true;
      } catch (err) {
        this.hooks.onError?.(err);
        this.draft ??= { values, errors: {} };
        // 式を計算できなかった列が分かれば、その列に印を付ける
        this.draft.errors = err.col >= 0 ? { [err.col]: err.message } : this.draftErrors(err.message);
        const firstErr = Object.keys(this.draft.errors).map(Number)[0];
        this.cur = { r: this.newRowIndex, c: firstErr ?? Math.min(this.cur.c, this.cols.length - 1) };
        this.ext = { ...this.cur };
        this.ensureVisible(); this.render(); this.emitSelect(); this.focus();
        return false;
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }

  /** INSERT 失敗の原因になった列（分かる範囲で）→ {c: msg} */
  draftErrors(msg) {
    const out = {};
    const m = String(msg).match(/NOT NULL constraint failed: (?:[^.]+\.)?(.+)/);
    const named = m && this.cols.findIndex((c) => c.name === m[1].trim());
    if (named != null && named >= 0) { out[named] = '必須です'; return out; }
    this.cols.forEach((col, c) => { if (col.required && (this.draft?.values[c] ?? null) === null) out[c] = '必須です'; });
    return out;
  }

  // ---------- 構築 ----------
  build() {
    this.host.replaceChildren();
    this.scroll = el('div.grid-scroll', { tabIndex: -1 });
    this.inner = el('div.grid-inner');
    this.header = el('div.grid-header');
    this.body = el('div.grid-body');
    this.sink = el('textarea.grid-sink', { spellcheck: false, autocomplete: 'off', rows: 1, 'aria-label': 'セル入力' });
    // タッチ端末：選んでいるだけのときはキーボードを出さない（編集を始めたら出す）
    if (TOUCH) this.sink.inputMode = 'none';
    // 範囲を広げるつまみ（タッチ端末だけ。指でなぞるとスクロールになるので）
    this.handle = el('div.grid-handle', { hidden: true, on: { pointerdown: (e) => this.startHandleDrag(e) } });
    this.inner.append(this.body, this.sink, this.handle);
    this.scroll.append(this.header, this.inner);
    this.host.append(this.scroll);
    this.empty = null;
    this.applyZoom();
    if (TOUCH) this.setupPinch();

    this.scroll.addEventListener('scroll', () => this.render(), { passive: true });
    new ResizeObserver(() => this.render()).observe(this.scroll);
    this.body.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.body.addEventListener('pointerdown', (e) => this.onTouchDown(e));
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
    if (!keepSelection) { this.cur = { r: 0, c: 0 }; this.ext = { ...this.cur }; }
    this.clampCursor();
    this.inner.style.height = (this.totalRows * RH) + 'px';
    this.renderHeader();
    this.render();
    this.emitSelect();
  }

  focus() { this.sink.focus({ preventScroll: true }); }

  // ---------- 拡大（タッチ端末） ----------
  applyZoom() { this.header.style.zoom = this.inner.style.zoom = String(this.z); }

  /** 二本指でつまんで表だけを拡大縮小する。指の間にある位置が動かないようにスクロールを合わせる */
  setupPinch() {
    const s = this.scroll;
    let start = null;
    const mid = (t) => {
      const rect = s.getBoundingClientRect();
      return { x: (t[0].clientX + t[1].clientX) / 2 - rect.left, y: (t[0].clientY + t[1].clientY) / 2 - rect.top };
    };
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    s.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches);
      this.pinching = true;
      start = { d: dist(e.touches), z: this.z, cx: (s.scrollLeft + m.x) / this.z, cy: (s.scrollTop + m.y) / this.z };
    }, { passive: true });
    s.addEventListener('touchmove', (e) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault(); // ページ全体の拡大・スクロールをさせない
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, start.z * dist(e.touches) / start.d));
      const m = mid(e.touches);
      this.z = z; this.applyZoom();
      s.scrollLeft = start.cx * z - m.x; s.scrollTop = start.cy * z - m.y;
    }, { passive: false });
    const end = (e) => {
      if (!start || e.touches.length >= 2) return;
      start = null; this.pinching = false;
      this.z = Math.round(this.z * 100) / 100;
      this.applyZoom(); this.render();
      try { localStorage.setItem('grid-zoom', String(this.z)); } catch { /* 無視 */ }
    };
    s.addEventListener('touchend', end); s.addEventListener('touchcancel', end);
    // iPhone：つまむ操作でページ全体が拡大されないようにする
    s.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  // ---------- スクロール位置と選択（シートを行き来しても続きから） ----------
  getPos() { return { top: this.scroll.scrollTop, left: this.scroll.scrollLeft, cur: { ...this.cur }, ext: { ...this.ext } }; }
  setPos(p) {
    this.cur = { ...p.cur }; this.ext = { ...p.ext };
    this.clampCursor();
    this.scroll.scrollTop = p.top; this.scroll.scrollLeft = p.left;
    this.render(); this.emitSelect();
  }

  // ---------- 元に戻した場所を見せる ----------
  /**
   * 元に戻す・やり直すで変わったセル・行・列を選び、見える所までスクロールして一瞬光らせる。
   * cells: [{key, col}]（col が null なら行全体）、cols: 光らせる列名（見出し）。
   * 絞り込みで見えない行があれば true を返す
   */
  async reveal({ cells = [], cols = [] } = {}) {
    const colIdx = (name) => this.cols.findIndex((c) => c.name === name);
    const spots = [];
    let hidden = false;
    const rowOf = new Map();
    for (const { key, col } of cells) {
      const id = JSON.stringify(key);
      if (!rowOf.has(id)) rowOf.set(id, this.source.rowIndexOf ? await this.source.rowIndexOf(key) : null);
      const r = rowOf.get(id);
      if (r == null) { hidden = true; continue; }
      spots.push({ r, c: col == null ? -1 : colIdx(col) });
    }
    const flashCols = cols.map(colIdx).filter((c) => c >= 0);
    this.flash = { cells: new Set(spots.map((p) => `${p.r}|${p.c}`)), cols: new Set(flashCols), until: Date.now() + 1100 };
    if (spots.length) {
      // 戻したセルを囲む範囲を選ぶ（行全体なら先頭の列から最後の列まで）
      const rs = spots.map((p) => p.r), cs = spots.flatMap((p) => (p.c < 0 ? [0, this.cols.length - 1] : [p.c]));
      this.moveTo(Math.min(...rs), Math.max(0, Math.min(...cs)));
      this.moveTo(Math.max(...rs), Math.max(0, Math.max(...cs)), true);
      this.ensureVisible({ r: Math.min(...rs), c: Math.max(0, Math.min(...cs)) });
    } else if (flashCols.length) {
      this.ensureVisible({ r: this.cur.r, c: flashCols[0] });
    }
    this.renderHeader(); this.render();
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flash = null; this.renderHeader(); this.render(); }, 1100);
    return hidden;
  }

  isFlash(r, c) {
    const f = this.flash;
    return !!f && Date.now() < f.until && (f.cells.has(`${r}|${c}`) || f.cells.has(`${r}|-1`));
  }

  // ---------- 列幅 ----------
  loadWidths() {
    try { return JSON.parse(localStorage.getItem('w:' + this.source.widthKey) || '{}'); } catch { return {}; }
  }
  saveWidths() {
    try { localStorage.setItem('w:' + this.source.widthKey, JSON.stringify(this.widths)); } catch { /* 無視 */ }
  }
  /** 列幅を変える（undefined なら自動の幅に戻す）。元に戻す・やり直すからも呼ぶ */
  setColWidth(name, w) {
    if (w == null) delete this.widths[name]; else this.widths[name] = w;
    this.saveWidths(); this.renderHeader(); this.render();
  }

  /** 列幅の変更を知らせる（元に戻すに積むため）。変わっていなければ何もしない */
  emitWidth(name, before) {
    const after = this.widths[name];
    if (after !== before) this.hooks.onColumnWidth?.(this.source.widthKey, name, before, after);
  }

  /**
   * 列幅を中身に合わせる（境界線のダブルクリック・ダブルタップ）。
   * 読み込み済みの行の値がすべて収まる幅にする（見出しは数えない。まだ読んでいない行も数えない）
   */
  autoFit(c) {
    const col = this.cols[c];
    if (!col) return;
    const before = this.widths[col.name];
    // 実際と同じ CSS で、幅を決めずに並べて測る
    const probe = el('div.gr', { style: { position: 'absolute', visibility: 'hidden', top: 0, left: 0, width: 'max-content', display: 'block' } });
    const cells = [];
    for (const [p, rows] of this.pages) {
      rows.forEach((row, i) => {
        if (!row) return;
        const cell = el('div.gc', { style: { width: 'max-content', display: 'block' } });
        this.fillCell(cell, row.values[c], col, row, p * PAGE + i, c);
        cells.push(cell);
      });
    }
    probe.append(...cells);
    this.body.append(probe);
    const w = Math.max(MIN_W, ...cells.map((x) => x.offsetWidth));
    probe.remove();
    this.widths[col.name] = Math.ceil(w) + 2;
    this.saveWidths(); this.renderHeader(); this.render();
    this.emitWidth(col.name, before);
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
        class: [col.readonly ? 'ro' : '', this.flash?.cols.has(c) && Date.now() < this.flash.until ? 'flash' : ''].join(' ').trim(),
        title: col.title || '',
        on: {
          pointerdown: (e) => {
            if (e.pointerType === 'mouse' || e.target.closest('.gh-btn, .gh-resize')) return;
            // タッチ：タップで列を選び、列メニューを出す（スクロールのために指を動かしたら何もしない）
            this.tap(e, () => { this.selectCol(c, false); this.hooks.onHeaderMenu?.(c, cell); });
          },
          mousedown: (e) => {
            if (e.button !== 0 || e.target.closest('.gh-btn, .gh-resize')) return;
            if (this.touchRecent()) return;
            e.preventDefault();
            this.selectCol(c, e.shiftKey);
          },
          contextmenu: (e) => { e.preventDefault(); if (!this.touchRecent()) this.hooks.onHeaderMenu?.(c, { x: e.clientX, y: e.clientY }); },
        },
      },
      // 中身は .gh-inner に入れて、はみ出た分を切る（境界線のつまみは外に置いて切らない）
      el('div.gh-inner',
      el('span.gh-name', col.name),
      ...(col.badges || []).map((b) => el('span.gh-badge', { class: b.cls || '', title: b.title || '' }, b.text)),
      el('span.gh-spacer'),
      col.sort ? el('span.gh-sort', { title: col.sort.total > 1 ? `並べ替えの第${col.sort.rank}基準` : '並べ替え中' },
        (col.sort.dir === 'asc' ? '↑' : '↓') + (col.sort.total > 1 ? col.sort.rank : '')) : null,
      col.filtered ? el('span.gh-filter', { title: '絞り込み中' }, '⏷') : null,
      el('button.gh-btn', { title: '列メニュー', on: { click: (e) => { e.stopPropagation(); this.hooks.onHeaderMenu?.(c, e.currentTarget); } } }, '⋮')),
      el('div.gh-resize', { title: 'ドラッグで幅を変更・ダブルクリックで中身に合わせる', on: {
        mousedown: (e) => { if (!this.touchRecent()) this.startResize(e, c, 'mouse'); },
        dblclick: (e) => { e.preventDefault(); e.stopPropagation(); if (!this.touchRecent()) this.autoFit(c); },
        pointerdown: (e) => {
          if (e.pointerType === 'mouse') return;
          this.lastTouch = Date.now();
          // ダブルタップで中身に合わせる
          const t = this.lastResizeTap;
          this.lastResizeTap = { c, at: Date.now() };
          if (t && t.c === c && Date.now() - t.at < 350) { e.preventDefault(); this.lastResizeTap = null; this.autoFit(c); return; }
          this.startResize(e, c, 'pointer');
        },
      } }));
      h.append(cell);
    });
    if (this.hooks.onAddColumn) {
      h.append(el('button.gh-add', { title: '列を追加', on: { click: (e) => this.hooks.onAddColumn(e.currentTarget) } }, '＋'));
    }
  }

  /** カーソルは列の先頭（extend なら始めの列のまま）、範囲は最後の行まで */
  selectCol(c, extend) {
    if (this.editing) this.commitEdit({ move: null });
    this.cur = { r: 0, c: extend ? this.cur.c : c };
    this.ext = { r: Math.max(0, this.rowCount - 1), c };
    this.colSelect = true;
    this.render(); this.emitSelect(); this.focus();
  }

  /** 列幅のドラッグ。マウスは mouse*、指は pointer* のイベントで追う */
  startResize(e, c, kind) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = this.colW(c), name = this.cols[c].name, before = this.widths[name];
    const move = (ev) => {
      this.widths[this.cols[c].name] = Math.max(MIN_W, startW + (ev.clientX - startX) / this.z);
      this.renderHeader(); this.render();
    };
    const up = () => {
      removeEventListener(kind + 'move', move); removeEventListener(kind + 'up', up); removeEventListener('pointercancel', up);
      this.saveWidths();
      this.emitWidth(name, before);
    };
    addEventListener(kind + 'move', move); addEventListener(kind + 'up', up); addEventListener('pointercancel', up);
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
    // つまんでいる間は描き直さない。指の下のセルを作り直すと、iPhone はその指の続きの操作を届けなくなる
    if (this.pinching) return;
    const st = this.scroll.scrollTop / this.z;
    const vh = this.scroll.clientHeight / this.z;
    const first = Math.max(0, Math.floor((st - HH) / RH) - 4);
    const last = Math.min(this.totalRows - 1, Math.ceil((st + vh) / RH) + 4);
    const { r0, r1, c0, c1 } = this.range();
    const frag = document.createDocumentFragment();
    const widths = this.cols.map((_, c) => this.colW(c));
    for (let r = first; r <= last; r++) {
      const isNew = r === this.newRowIndex;
      if (isNew && !this.draft) {
        // 下書きを開いていないときは、行番号欄の「＋」だけ（列追加の「＋」と対になる見た目）
        const here = this.cur.r === r;
        // 行は表の幅いっぱいにする（行番号の欄と同じく、横にスクロールしても「＋」が左に残るように）
        frag.append(el('div.gr.row-adder', { class: here ? 'cur' : '', style: { top: (r * RH) + 'px', width: this.totalW() + 'px' }, dataset: { r } },
          el('div.gr-head', { style: { width: RHW + 'px' }, title: '行を追加（最後の行で ↓ でも開きます）' }, '＋')));
        continue;
      }
      const row = isNew ? null : this.rowAt(r);
      const rowSel = r >= r0 && r <= r1;
      const draft = isNew ? this.draft : null;
      const rowEl = el('div.gr', { class: isNew ? 'new draft' : (row && this.source.isPendingRow?.(row) ? 'pending' : ''), style: { top: (r * RH) + 'px', width: this.totalW() + 'px' }, dataset: { r } });
      rowEl.append(el('div.gr-head', {
        class: rowSel ? 'hl' : '',
        style: { width: RHW + 'px' },
        title: isNew ? '新しい行（行を離れると保存・Esc で取り消し）' : '',
      }, isNew ? '✎' : String(r + 1)));
      for (let c = 0; c < this.cols.length; c++) {
        const cell = el('div.gc', { style: { width: widths[c] + 'px' }, dataset: { c } });
        const col = this.cols[c];
        if (col.align === 'right') cell.classList.add('num');
        if (col.readonly || !this.source.editable) cell.classList.add('ro');
        if (rowSel && c >= c0 && c <= c1) cell.classList.add('sel');
        if (r === this.cur.r && c === this.cur.c) cell.classList.add('cur');
        if (draft) {
          const v = draft.values[c];
          // 未入力は INSERT で入るものを薄く、それ以外はフォームの文字列をそのまま
          if (v === undefined) { cell.classList.add('ph'); cell.textContent = this.placeholderFor(c); }
          else cell.textContent = v.replaceAll('\n', ' ⏎ ');
          if (draft.errors[c]) { cell.classList.add('err'); cell.title = draft.errors[c]; }
        } else if (!row) {
          cell.classList.add('loading');
        } else {
          this.fillCell(cell, row.values[c], col, row, r, c);
          if (this.source.isPendingCell?.(row, c)) cell.classList.add('pending');
          if (this.isFlash(r, c)) cell.classList.add('flash');
          if (this.source.protect?.(row.values, c).length) cell.classList.add('prot');
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
    const cw = this.colW(c);
    let w = cw, left = x, num = false;
    if (this.editing) {
      // スプレッドシートと同じく、最初はセルの大きさ。文字が入りきらなくなったら広げる。
      // 文字列は右へ広げ、表示エリアの右端で折り返す。数値として保存される入力は右寄せで左へ伸ばす
      const type = this.cols[c]?.type;
      const conv = type != null && this.sink.value !== '' ? convertInput(this.sink.value, type) : null;
      num = typeof conv === 'number' || typeof conv === 'bigint';
      const need = Math.max(cw, this.textWidth(this.sink.value) + 20);
      if (num) {
        const maxW = Math.max(cw, x + cw - (this.scroll.scrollLeft / this.z + RHW));
        w = Math.min(maxW, need); left = x + cw - w;
      } else {
        const maxW = Math.max(cw, (this.scroll.scrollLeft + this.scroll.clientWidth) / this.z - x - 4);
        w = Math.min(maxW, need);
      }
    }
    this.sink.classList.toggle('num', num);
    Object.assign(this.sink.style, { left: left + 'px', top: y + 'px', width: w + 'px', height: RH + 'px' });
    if (this.editing) this.sink.style.height = Math.max(RH, Math.min(200, this.sink.scrollHeight)) + 'px';
    this.sink.classList.toggle('editing', !!this.editing);
    if (TOUCH && !this.editing) this.sink.inputMode = 'none';
    this.placeHandle();
  }

  /** 範囲の右下に、範囲を広げるつまみを置く（タッチ端末・編集していないときだけ） */
  placeHandle() {
    const show = TOUCH && !this.editing && this.cols.length > 0 && this.rowCount > 0 && this.cur.r !== this.newRowIndex;
    this.handle.hidden = !show;
    if (!show) return;
    const { r1, c1 } = this.range();
    Object.assign(this.handle.style, { left: (this.colX(c1) + this.colW(c1)) + 'px', top: ((r1 + 1) * RH) + 'px' });
  }

  /** 入力欄のフォントで測った、いちばん長い行の幅 */
  textWidth(text) {
    const ctx = (this._measure ??= document.createElement('canvas').getContext('2d'));
    ctx.font = getComputedStyle(this.sink).font;
    return Math.max(0, ...String(text).split('\n').map((l) => ctx.measureText(l).width));
  }

  // ---------- 選択 ----------
  range() {
    return {
      r0: Math.min(this.ext.r, this.cur.r), r1: Math.max(this.ext.r, this.cur.r),
      c0: Math.min(this.ext.c, this.cur.c), c1: Math.max(this.ext.c, this.cur.c),
    };
  }

  clampCursor() {
    // 「＋」の行には下書きを開いているときだけカーソルを置ける（キー移動では乗らない）
    const maxR = Math.max(0, (this.draft ? this.totalRows : this.rowCount) - 1), maxC = Math.max(0, this.cols.length - 1);
    for (const p of [this.cur, this.ext]) { p.r = Math.min(Math.max(0, p.r), maxR); p.c = Math.min(Math.max(0, p.c), maxC); }
  }

  /** extend なら範囲の端（ext）だけを動かし、カーソル（cur）は選択を始めたセルに留める（スプレッドシートと同じ） */
  moveTo(r, c, extend = false) {
    if (extend) {
      this.ext = { r, c };
      this.clampCursor();
    } else {
      const fromNew = this.cur.r === this.newRowIndex;
      this.cur = { r, c };
      this.clampCursor();
      // 下書きの行から別の行へ出たら保存（失敗したら flushDraft がカーソルを戻す）。空の下書きは閉じるだけ
      if (fromNew && this.cur.r !== this.newRowIndex) { if (this.hasDraft) this.flushDraft(); else this.draft = null; }
      this.ext = { ...this.cur };
    }
    this.colSelect = false;
    this.ensureVisible(extend ? this.ext : this.cur);
    this.render();
    this.emitSelect();
  }

  selectAll() {
    this.cur = { r: 0, c: 0 };
    this.ext = { r: Math.max(0, this.rowCount - 1), c: this.cols.length - 1 };
    this.render(); this.emitSelect(); this.focus();
  }

  selectRows(r0, r1) {
    this.cur = { r: r0, c: 0 };
    this.ext = { r: r1, c: this.cols.length - 1 };
    this.render(); this.emitSelect();
  }

  ensureVisible(target = this.cur) {
    const { r, c } = target;
    const s = this.scroll;
    const z = this.z;
    const top = r * RH * z, bottom = top + (RH + HH) * z;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (bottom > s.scrollTop + s.clientHeight) s.scrollTop = bottom - s.clientHeight;
    const x = this.colX(c) * z, w = this.colW(c) * z;
    if (x - RHW * z < s.scrollLeft) s.scrollLeft = x - RHW * z;
    else if (x + w > s.scrollLeft + s.clientWidth) s.scrollLeft = x + w - s.clientWidth;
  }

  emitSelect() {
    const { r, c } = this.cur;
    const isNew = r === this.newRowIndex;
    const row = isNew ? (this.hasDraft ? { values: this.draft.values } : null) : this.rowAt(r);
    this.hooks.onSelect?.({ r, c, row, isNew, draft: isNew && this.hasDraft, range: this.range(), col: this.cols[c] });
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
    if (this.touchRecent()) { e.preventDefault(); return; } // タッチの後にブラウザが出すマウスのイベント
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
    if (hit.r === this.newRowIndex && !this.draft) {
      // 「＋」を押した：行を作る
      this.focus(); this.addRow();
    } else if (hit.r === this.newRowIndex && hit.head) {
      this.moveTo(hit.r, 0); this.focus();
    } else if (hit.head) {
      this.selectRows(e.shiftKey ? this.cur.r : hit.r, hit.r);
      this.focus();
    } else {
      if (modKey(e) && this.hooks.onCellCtrlClick) {
        const row = this.rowAt(hit.r);
        if (row && this.hooks.onCellCtrlClick(hit.r, hit.c, row)) return;
      }
      this.moveTo(hit.r, hit.c, e.shiftKey);
      this.focus();
      // ダブルクリックで編集。1回目のクリックで行が描き直されて dblclick が届かないので、連続クリック数で判定する
      if (e.detail === 2 && !e.shiftKey) { this.beginEdit('edit'); return; }
      // ドラッグで範囲選択
      const move = (ev) => {
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const h = target && this.body.contains(target) ? this.cellFromEvent({ target }) : null;
        if (h && !h.head && (h.r !== this.ext.r || h.c !== this.ext.c)) this.moveTo(h.r, h.c, true);
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    }
  }

  // ---------- タッチ ----------
  /** 直前の操作がタッチだったか（タッチの後にブラウザが出すマウスのイベント・contextmenu を無視するため） */
  touchRecent() { return Date.now() - (this.lastTouch || 0) < 800; }

  /**
   * タッチの1回の操作を見分ける：指を動かさずに離したら onTap、押し続けたら onLong。
   * 指が動いたらスクロールなので、ブラウザに任せて何もしない
   */
  tap(e, onTap, onLong) {
    this.lastTouch = Date.now();
    const x0 = e.clientX, y0 = e.clientY;
    let done = false;
    const end = () => {
      done = true; clearTimeout(timer);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', end);
      this.lastTouch = Date.now();
    };
    const move = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) end(); };
    const up = () => { if (done) return; end(); onTap(); };
    const timer = onLong ? setTimeout(() => { if (done) return; end(); onLong(); }, LONG_PRESS) : 0;
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', end);
  }

  onTouchDown(e) {
    if (e.pointerType === 'mouse') return;
    const hit = this.cellFromEvent(e);
    if (!hit || e.target.closest('.fk-drop')) { this.lastTouch = Date.now(); return; }
    const x = e.clientX, y = e.clientY;
    this.tap(e, () => this.onTap(hit), () => {
      // 長押し：右クリックと同じ。範囲の外なら選択を移してからメニュー
      if (this.editing) this.commitEdit({ move: null });
      const { r0, r1, c0, c1 } = this.range();
      const inside = hit.r >= r0 && hit.r <= r1 && (hit.head || (hit.c >= c0 && hit.c <= c1));
      if (!inside && hit.r !== this.newRowIndex) hit.head ? this.selectRows(hit.r, hit.r) : this.moveTo(hit.r, hit.c);
      navigator.vibrate?.(10);
      this.hooks.onContextMenu?.({ x, y }, { ...this.range(), head: hit.head });
    });
  }

  /** タップ：セルを選ぶ。選んでいる1つのセルをもう一度タップしたら編集（キーボードを出す） */
  onTap(hit) {
    const again = !hit.head && hit.r === this.cur.r && hit.c === this.cur.c
      && this.ext.r === this.cur.r && this.ext.c === this.cur.c && !this.colSelect;
    if (this.editing) {
      if (again) return; // 編集中のセルのタップ（入力欄の中のカーソル移動）はそのまま
      this.commitEdit({ move: null });
    }
    if (hit.r === this.newRowIndex && !this.draft) { this.focus(); this.addRow(); return; }
    if (hit.r === this.newRowIndex && hit.head) { this.moveTo(hit.r, 0); this.focus(); return; }
    if (hit.head) { this.selectRows(hit.r, hit.r); this.focus(); return; }
    if (again) { this.editByTouch(); return; }
    this.moveTo(hit.r, hit.c);
    this.focus();
  }

  /** タッチで編集を始める：キーボードが出るよう、入力の種類を戻してからフォーカスし直す */
  editByTouch() {
    if (!this.beginEdit('edit')) { this.focus(); return false; }
    this.sinkFocusKeep = true;
    this.sink.blur();
    this.sinkFocusKeep = false;
    this.sink.inputMode = 'text';
    this.sink.focus({ preventScroll: true });
    return true;
  }

  /** つまみをドラッグして範囲の端を動かす */
  startHandleDrag(e) {
    e.preventDefault(); e.stopPropagation();
    this.lastTouch = Date.now();
    const move = (ev) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const h = target && this.body.contains(target) ? this.cellFromEvent({ target }) : null;
      if (h && !h.head && h.r !== this.newRowIndex && (h.r !== this.ext.r || h.c !== this.ext.c)) this.moveTo(h.r, h.c, true);
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      this.lastTouch = Date.now();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  onContextMenu(e) {
    e.preventDefault();
    if (this.touchRecent()) return; // タッチの長押しは onTouchDown で扱う
    const hit = this.cellFromEvent(e);
    if (!hit) return;
    this.hooks.onContextMenu?.({ x: e.clientX, y: e.clientY }, { ...this.range(), head: hit.head });
  }

  // ---------- 編集 ----------
  /** セルにかかっている保護（なければ空配列） */
  protAt(r, c) {
    const check = this.source.protect;
    if (!check) return [];
    if (r === this.newRowIndex) return check(null, c);
    const row = this.rowAt(r);
    return row ? check(row.values, c) : [];
  }

  canEdit(r, c) {
    if (!this.source.editable) return false;
    const col = this.cols[c];
    if (!col || col.readonly) return false;
    if (r !== this.newRowIndex && !this.rowAt(r)) return false;
    if (this.protAt(r, c).length) return false;
    if (r === this.newRowIndex && !this.draft) return false; // 「＋」の上：行を作るまでは入力できない
    return true;
  }

  /** 入力なしでも記録として成り立つ表（必須の列がない）か */
  get canInsertEmpty() { return this.source.editable && !this.cols.some((c) => c.required); }

  /** 「＋」の操作：入力の要らない表は即 INSERT、それ以外は下書きの行を開く */
  async addRow() {
    if (!this.source.editable) return;
    if (this.editing) await this.commitEdit({ move: null });
    if (!this.canInsertEmpty) {
      this.openDraft();
      this.cur = { r: this.newRowIndex, c: 0 }; this.ext = { ...this.cur };
      this.ensureVisible(); this.render(); this.emitSelect();
      return;
    }
    try {
      await this.source.insert([new Array(this.cols.length).fill(undefined)]);
      await this.reload();
      // 自動採番・生成列を飛ばして、最初に入力しそうな列へ
      let c = this.cols.findIndex((col) => !col.readonly && !col.auto);
      if (c < 0) c = 0;
      // 並べ替えがなければ追加した行は末尾（rowid 順）。並べ替え中は末尾に来るとは限らない
      this.moveTo(this.rowCount - 1, c);
    } catch (err) { this.hooks.onError?.(err); }
  }

  currentValue() {
    const { r, c } = this.cur;
    if (r === this.newRowIndex) return this.draft?.values[c];
    return this.rowAt(r)?.values[c];
  }

  beginEdit(mode, initial) {
    const { r, c } = this.cur;
    if (!this.canEdit(r, c)) {
      this.sink.value = '';
      // 「＋」の上で打った文字は捨てる（行を作るのはクリックか Enter）
      const prots = this.protAt(r, c);
      if (prots.length) this.hooks.onProtectedEdit?.(prots);
      else if (this.source.editable && !(r === this.newRowIndex && !this.draft)) this.hooks.onReadonlyEdit?.(this.cols[c]);
      return false;
    }
    const v = this.currentValue();
    if (v instanceof Uint8Array) { this.hooks.onBlobEdit?.(r, c); this.sink.value = ''; return false; }
    const start = this.formAt(r, c);
    this.editing = { mode, r, c, start };
    if (initial !== undefined) { /* 入力済みの文字をそのまま使う */ } else this.sink.value = start;
    this.sink.placeholder = r === this.newRowIndex && v === undefined ? this.placeholderFor(c) : '';
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
    this.sink.placeholder = '';
    this.placeSink();
    this.hooks.onEditState?.(false);
  }

  /** 外部（数式バー）からの値設定 */
  async setCurrent(text) {
    const { r, c } = this.cur;
    if (!this.canEdit(r, c)) return false;
    if (text === this.formAt(r, c)) return true;
    if (r === this.newRowIndex) { this.draftSet(c, text === '' ? undefined : text); this.render(); this.emitSelect(); return true; }
    return this.write([{ r, c, value: form(text) }]);
  }

  async commitEdit({ move = 'down' } = {}) {
    if (!this.editing) return;
    const { r, c, start } = this.editing;
    const text = this.sink.value;
    this.editing = null;
    this.sink.value = '';
    this.sink.placeholder = '';
    this.placeSink();
    this.hooks.onEditState?.(false);
    // フォームが開いたときと同じなら何もしない
    const unchanged = text === start;
    if (r === this.newRowIndex) {
      // 新しい行は下書きにためるだけ。Enter/Tab は右へ進み、最後の列で保存して次の新しい行へ
      // 下書きはフォームの文字列のまま持つ。空は未入力
      if (!unchanged) this.draftSet(c, text === '' ? undefined : text);
      if (move === 'down' || move === 'right') {
        if (c >= this.cols.length - 1) {
          this.moveTo(r, 0);
          await this.flushDraft();
          return;
        }
        this.moveTo(r, c + 1);
      } else if (move === 'left') this.moveTo(r, c - 1);
      else if (move === 'up') this.moveTo(r - 1, c);
      else { this.render(); this.emitSelect(); }
      return;
    }
    // 先に移動してから書き込む（書き込み待ちの間の入力を取りこぼさない）。失敗したら write がセルに戻す
    // 新しい行で Enter → 確定後も次の新しい行へ。Tab など横移動 → 追加された行に留まって続けて入力
    this.afterInsert = move === 'down' ? 'newrow' : 'stay';
    const pending = !unchanged ? this.write([{ r, c, value: form(text) }]) : null;
    // 最後の行の最後の列で Tab：入力の要らない表なら次の行を作る（Excel のテーブルと同じ）
    if (move === 'right' && r === this.rowCount - 1 && c === this.cols.length - 1 && this.canInsertEmpty) {
      if (pending) await pending;
      return this.addRow();
    }
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
        const keepExt = { ...this.ext };
        await this.reload();
        if (keep.r >= oldCount && changes.length === 1) {
          // 1セル入力で行を追加した場合
          keep.r = intent === 'newrow' ? this.newRowIndex : oldCount;
          this.cur = keep; this.ext = { ...keep };
        } else { this.cur = keep; this.ext = keepExt; }
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
        this.cur = { r: ch.r, c: ch.c }; this.ext = { ...this.cur };
        this.render(); this.emitSelect();
        if (ch.value?.form !== undefined) {
          this.sink.value = ch.value.form;
          this.editing = { mode: 'edit', r: ch.r, c: ch.c, start: this.formAt(ch.r, ch.c) };
          this.placeSink();
          this.sink.classList.add('invalid');
          setTimeout(() => this.sink.classList.remove('invalid'), 1500);
          this.hooks.onEditState?.(true, ch.value.form);
        }
        this.focus();
      }
      return false;
    }
  }

  async clearSelection() {
    const { r0, r1, c0, c1 } = this.range();
    if (r1 >= this.newRowIndex && this.draft) {
      for (let c = c0; c <= c1; c++) if (!this.cols[c].readonly) this.draftSet(c, '=NULL');
      this.render(); this.emitSelect();
    }
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
    // 下書きがあれば、新しい行への貼り付けにまとめて入れる
    const draft = this.hasDraft && changes.some((ch) => ch.r === this.newRowIndex) ? this.draft : null;
    if (draft) {
      draft.values.forEach((v, c) => {
        if (v !== undefined && !changes.some((ch) => ch.r === this.newRowIndex && ch.c === c)) changes.push({ r: this.newRowIndex, c, value: form(v) });
      });
    }
    const ok = await this.write(changes);
    if (ok && draft) { this.draft = null; this.render(); }
    if (ok) {
      this.cur = { r: r0, c: c0 };
      this.ext = { r: Math.min(r0 + rows - 1, this.totalRows - 1), c: c0 + cols - 1 };
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
    const ext = e.shiftKey;
    // Shift で範囲を伸ばすときは、範囲の端から動かす（カーソルは始めたセルのまま）
    const { r, c } = ext ? this.ext : this.cur;
    const jump = (dr, dc) => {
      if (mod) {
        if (dr) return this.moveTo(dr < 0 ? 0 : Math.max(0, this.rowCount - 1), c, ext);
        return this.moveTo(r, dc < 0 ? 0 : this.cols.length - 1, ext);
      }
      this.moveTo(r + dr, c + dc, ext);
    };
    const pageRows = Math.max(1, Math.floor(this.scroll.clientHeight / this.z / RH) - 2);
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
      case 'Tab':
        e.preventDefault();
        if (!e.shiftKey && r === this.rowCount - 1 && c === this.cols.length - 1 && this.canInsertEmpty) return this.addRow();
        return this.moveTo(this.cur.r, this.cur.c + (e.shiftKey ? -1 : 1));
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) return this.moveTo(this.cur.r - 1, this.cur.c);
        if (r === this.newRowIndex && !this.draft) return this.addRow();
        return this.beginEdit('edit');
      case 'F2': e.preventDefault(); return this.beginEdit('edit');
      case 'Delete': case 'Backspace': e.preventDefault(); return this.clearSelection();
      case 'Escape':
        if (r === this.newRowIndex && this.draft) {
          const had = this.hasDraft;
          this.draft = null;
          // 下書きを閉じて、最後の行へ戻る（行がなければ「＋ 行を追加」の上に留まる）
          this.cur = { r: Math.max(0, this.rowCount - 1), c }; this.ext = { ...this.cur };
          this.ensureVisible(); this.render(); this.emitSelect();
          if (had) this.hooks.onInfo?.('新しい行の入力を取り消しました');
          return;
        }
        this.ext = { ...this.cur }; this.render(); return;
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
