// スプレッドシート風グリッド：仮想スクロール、セル選択、編集、コピー＆ペースト
import { t as tr } from './i18n.js';
import { el, modKey, fmtBytes } from './ui.js';
import { sniff } from './blob.js';
import { affinity } from './schema.js';
import { convertInput, formText, form, defaultToForm } from './sources.js';

// タッチ端末（指で操作する）か。行を高くし、タップ・長押し・つまみで操作する
export const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const RH = TOUCH ? 34 : 28; // 行の高さ
const LONG_PRESS = 500;
const HH = 34;          // 見出しの高さ
const RHW = 56;         // 行番号の幅
const PAGE = 200;
const DEFAULT_W = 150;
const MIN_W = 20;        // 列幅の最小（1文字のデータに合わせても使えるように）
const MIN_H = 18;        // 行の高さの最小
const MAX_WRAP_H = 600;  // 折り返した文字に合わせて伸ばす高さの上限
const MAX_TEXT = 5000;   // セルに表示する文字数の上限（表示を軽くするため）
const MAX_RESIZE_ROWS = 5000; // まとめて高さを変えられる行数の上限
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
    this.none = false;     // 何も選んでいない（スマホの通常時。枠・つまみを出さない）
    this.editing = null;   // { mode: 'enter'|'edit', r, c, start（開いたときのフォームの文字列） }
    this.draft = null;     // 新しい行の下書き { values: [列ごとの文字列|null|undefined(未入力)], errors: {c: msg} }
    this.widths = this.loadWidths();
    this.heights = this.loadHeights(); // 保存してある行の高さ {行の見分け方(JSON): 高さ}
    this.manualHeights = new Map(); // 自分で決めた高さ {何行目: 高さ}
    this.autoHeights = new Map();   // 折り返した文字に合わせた自動の高さ {何行目: 高さ}（保存しない）
    this.rowHeights = new Map(); this.hIdx = []; this.hCum = []; // 両方を合わせた {何行目: 高さ} と、位置計算用の累積
    this.formats = this.loadFormats(); // セルごとの書式 {書式名: 既定と違うセルのキー（[行の見分け方, 列名] の JSON）の Set}
    this.z = TOUCH ? loadZoom() : 1;
    this.build();
  }

  get cols() { return this.source.columns; }
  /** 行の追加・セルの変更ができるか（ビューはトリガーのある操作だけ。表は editable のとおり） */
  get canInsert() { return !!this.source.editable && this.source.ops?.insert !== false; }
  get canUpdate() { return !!this.source.editable && this.source.ops?.update !== false; }
  get totalRows() { return this.rowCount + (this.canInsert ? 1 : 0); }
  get newRowIndex() { return this.canInsert ? this.rowCount : -1; }
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
    if (col.auto) return tr('（自動採番）');
    if (col.dflt != null) return defaultToForm(col.dflt);
    return col.notnull ? '' : '=NULL';
  }

  /** フォームを開いたときの文字列。下書きは持っているフォームの文字列、未入力は空 */
  formAt(r, c) {
    if (r === this.newRowIndex) { const v = this.draft?.values[c]; return v instanceof Uint8Array ? '' : v ?? ''; }
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
        await this.source.insert([values.map(draftToValue)]);
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
    if (named != null && named >= 0) { out[named] = tr('必須です'); return out; }
    this.cols.forEach((col, c) => { if (col.required && (this.draft?.values[c] ?? null) === null) out[c] = tr('必須です'); });
    return out;
  }

  // ---------- 構築 ----------
  build() {
    this.host.replaceChildren();
    this.scroll = el('div.grid-scroll', { tabIndex: -1 });
    this.inner = el('div.grid-inner');
    this.header = el('div.grid-header');
    this.body = el('div.grid-body');
    this.sink = el('textarea.grid-sink', { spellcheck: false, autocomplete: 'off', rows: 1, 'aria-label': tr('セル入力') });
    // タッチ端末：選んでいるだけのときはキーボードを出さない（編集を始めたら出す）
    if (TOUCH) this.sink.inputMode = 'none';
    // 範囲を広げるつまみ（タッチ端末だけ。指でなぞるとスクロールになるので）
    this.handle = el('div.grid-handle', { hidden: true, on: { pointerdown: (e) => this.startHandleDrag(e) } });
    // 列ごと選んでいるときに左右の境目に出す、選ぶ列を広げるつまみ
    this.colHandles = TOUCH ? ['left', 'right'].map((side) => el('div.grid-handle', { hidden: true, on: { pointerdown: (e) => this.startColHandleDrag(e, side) } })) : [];
    // 行ごと選んでいるときに上下の境目に出す、選ぶ行を広げるつまみ
    this.rowHandles = TOUCH ? ['top', 'bottom'].map((side) => el('div.grid-handle', { hidden: true, on: { pointerdown: (e) => this.startRowHandleDrag(e, side) } })) : [];
    // 行ごと選んでいるときに、行番号の欄の右下の境目に出す高さを変えるつまみ
    this.heightKnob = TOUCH ? el('div.gh-knob.gr-knob', { hidden: true, title: tr('ドラッグで高さを変更・ダブルクリックで中身に合わせる'), on: {
      pointerdown: (e) => { this.lastTouch = Date.now(); this.startRowResize(e, this.range().r1, 'pointer'); },
    } }) : null;
    this.inner.append(this.body, this.sink, this.handle, ...this.colHandles, ...this.rowHandles, ...(this.heightKnob ? [this.heightKnob] : []));
    this.scroll.append(this.header, this.inner);
    // 長い表を一気に移動するつまみ（指で操作しているときだけ。電話帳の右端のつまみのようなもの）
    this.fastThumb = el('div.fs-thumb', { on: { pointerdown: (e) => this.startFastScroll(e) } });
    this.fastLabel = el('div.fs-label', { hidden: true });
    this.fast = el('div.fs-track', { hidden: true }, this.fastThumb, this.fastLabel);
    this.host.append(this.scroll, this.fast);
    this.empty = null;
    this.applyZoom();
    if (TOUCH) this.setupPinch();

    // つまみは「直前の操作が指（またはペン）だったか」で出し分ける。タッチ画面付きPCは
    // 端末としてはタッチと申告することがあるが、マウスで操作しているときは出さない
    this.byTouch = TOUCH;
    this.host.classList.toggle('grid-touch', this.byTouch);
    this.host.addEventListener('pointerdown', (e) => {
      const t = e.pointerType !== 'mouse';
      if (t === this.byTouch) return;
      this.byTouch = t;
      this.host.classList.toggle('grid-touch', t);
      this.placeHandle();
      this.syncFast(false);
    }, true);
    this.scroll.addEventListener('scroll', () => { this.render(); this.syncFast(true); }, { passive: true });
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
    this.sink.addEventListener('paste', (e) => {
      if (this.editing) return;
      e.preventDefault();
      const dt = e.clipboardData;
      // 画像だけでなく、エクスプローラーなどでコピーしたファイルも届く
      this.pasteClipboard({ file: dt.files[0] || null, text: dt.getData('text/plain'), html: dt.getData('text/html') });
    });
    // ファイルを BLOB のセルへドロップ（それ以外の場所へのドロップは main.js の .sqlite の読み込み）
    this.body.addEventListener('dragover', (e) => {
      const hit = e.dataTransfer?.types.includes('Files') && this.blobDropTarget(e);
      this.markDrop(hit);
      if (!hit) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.remove('dropping');
    });
    this.body.addEventListener('dragleave', (e) => { if (!this.body.contains(e.relatedTarget)) this.markDrop(null); });
    this.body.addEventListener('drop', (e) => {
      const hit = this.blobDropTarget(e);
      this.markDrop(null);
      const f = e.dataTransfer?.files?.[0];
      if (!hit || !f) return;
      e.preventDefault(); e.stopPropagation();
      document.body.classList.remove('dropping');
      this.moveTo(hit.r, hit.c); this.focus();
      f.arrayBuffer().then((b) => this.pasteBlob(new Uint8Array(b), [hit.c]));
    });
    // ほかのアプリへ移ったら、そこでコピーしたかもしれないので「同じ文字なら自分のコピー」とはみなさない
    window.addEventListener('blur', () => { if (this.lastCopy) this.lastCopy.left = true; });
    this.renderHeader();
  }

  async reload({ keepSelection = true } = {}) {
    const token = (this.reloadToken = (this.reloadToken || 0) + 1);
    const count = await this.source.count();
    if (token !== this.reloadToken) return; // 後から始まった再読み込みを優先
    // 保存してある行の高さが、今の並べ替え・絞り込みで何行目にあるか
    const heightMap = await this.heightMap(count);
    if (token !== this.reloadToken) return;
    this.pages.clear();
    this.loading.clear();
    this.rowCount = count;
    if (!keepSelection) { this.cur = { r: 0, c: 0 }; this.ext = { ...this.cur }; }
    this.clampCursor();
    this.autoHeights = new Map(); // 読み込み直すので、折り返しの高さも測り直す
    this.setHeightMap(heightMap);
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
  setColWidths(map) {
    for (const [name, w] of Object.entries(map)) { if (w == null) delete this.widths[name]; else this.widths[name] = w; }
    this.saveWidths(); this.renderHeader(); this.render(); this.afterWidthChange();
  }

  /** 列幅の変更をまとめて知らせる（元に戻すに1回分として積むため）。befores: {列名: 変更前}。変わっていなければ何もしない */
  emitWidths(befores) {
    const changes = Object.entries(befores).map(([name, before]) => ({ name, before, after: this.widths[name] })).filter((x) => x.after !== x.before);
    if (changes.length) this.hooks.onColumnWidth?.(this.source.widthKey, changes);
  }

  /** 境目を操作した列 c と一緒に変える列。列ごと選んでいて c がその中にあれば選んだ列すべて（スプレッドシートと同じ） */
  resizeCols(c) {
    const { c0, c1 } = this.range();
    if (!this.colSelect || c < c0 || c > c1) return [c];
    return Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i);
  }

  /**
   * 列幅を中身に合わせる（境界線のダブルクリック・ダブルタップ）。選んだ列が複数ならそれぞれを合わせる。
   * 読み込み済みの行の値がすべて収まる幅にする（見出しは数えない。まだ読んでいない行も数えない）
   */
  autoFit(c) {
    const targets = this.resizeCols(c);
    const befores = Object.fromEntries(targets.map((i) => [this.cols[i].name, this.widths[this.cols[i].name]]));
    for (const i of targets) this.widths[this.cols[i].name] = this.fitWidth(i);
    this.saveWidths(); this.renderHeader(); this.render(); this.afterWidthChange();
    this.emitWidths(befores);
  }

  /** 列 cols の幅を w にする（メニューの「数値で指定」）。元に戻すに1回分として積む */
  setColsWidth(cols, w) {
    w = Math.max(MIN_W, Math.round(w));
    const befores = Object.fromEntries(cols.map((i) => [this.cols[i].name, this.widths[this.cols[i].name]]));
    for (const i of cols) this.widths[this.cols[i].name] = w;
    this.saveWidths(); this.renderHeader(); this.render(); this.afterWidthChange();
    this.emitWidths(befores);
  }

  /** 列 c の中身がすべて収まる幅 */
  fitWidth(c) {
    const col = this.cols[c];
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
    return Math.ceil(w) + 2;
  }

  // ---------- 行の高さ ----------
  // 高さを変えた行だけを {何行目: 高さ} で持ち、位置は「r × 標準の高さ + それより上の行の差の合計」で求める
  // （行がいくらあっても重くならない）。保存は行のキー（主キー、なければ rowid）ごとにして、
  // 並べ替え・絞り込みをしても同じデータの行に付いてくるようにする。キーのないシートは何行目かで保存する
  loadHeights() {
    try { return JSON.parse(localStorage.getItem('h:' + this.source.widthKey) || '{}'); } catch { return {}; }
  }
  saveHeights() {
    try {
      const s = JSON.stringify(this.heights);
      if (s === '{}') localStorage.removeItem('h:' + this.source.widthKey); else localStorage.setItem('h:' + this.source.widthKey, s);
    } catch { /* 無視 */ }
  }
  /** 行 r の見分け方（保存のキー） */
  rowId(r, row) {
    const id = row && this.source.identOf ? this.source.identOf(row) : null;
    return id ? JSON.stringify(id) : '#' + r;
  }
  /** 保存してある高さを、今の並びの {何行目: 高さ} にする */
  async heightMap(count = this.rowCount) {
    const map = new Map();
    const keyed = [];
    for (const [id, h] of Object.entries(this.heights)) {
      if (id.startsWith('#')) { const r = +id.slice(1); if (r < count) map.set(r, h); } else keyed.push(id);
    }
    if (keyed.length && this.source.rowIndexesOf) {
      try {
        const idx = await this.source.rowIndexesOf(keyed.map((id) => JSON.parse(id)));
        idx.forEach((r, i) => { if (r != null) map.set(r, this.heights[keyed[i]]); });
      } catch { /* 高さが分からなくても表示はできる */ }
    }
    return map;
  }
  /** 自分で決めた高さ（{何行目: 高さ}）を入れ替える */
  setHeightMap(map) {
    this.manualHeights = map;
    this.applyHeights();
  }
  /**
   * 自分で決めた高さと、折り返しによる自動の高さを合わせて位置の表を作り直す（自分で決めた高さが優先）。
   * 画面より上の行の高さが変わっても今見ている行が動かないよう、スクロール位置を合わせる
   */
  applyHeights() {
    const z = this.z, st = this.scroll.scrollTop / z;
    const anchor = this.hIdx ? this.rowAtY(Math.max(0, st)) : 0, off = this.hIdx ? st - this.rowY(anchor) : 0;
    const map = new Map(this.autoHeights);
    for (const [r, h] of this.manualHeights) map.set(r, h);
    this.rowHeights = map;
    this.hIdx = [...map.keys()].sort((a, b) => a - b);
    let sum = 0;
    this.hCum = this.hIdx.map((r) => (sum += map.get(r) - RH));
    this.inner.style.height = this.rowY(this.totalRows) + 'px';
    if (st > 0) this.scroll.scrollTop = (this.rowY(anchor) + off) * z;
  }
  /** 行 r の、自分で決めていないときの高さ（折り返しによる自動の高さか標準） */
  autoH(r) { return this.autoHeights.get(r) ?? RH; }
  rowH(r) { return this.rowHeights.get(r) ?? RH; }
  /** 行 r の上端の位置 */
  rowY(r) {
    const a = this.hIdx;
    if (!a.length) return r * RH;
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < r) lo = m + 1; else hi = m; }
    return r * RH + (lo ? this.hCum[lo - 1] : 0);
  }
  /** 位置 y にある行 */
  rowAtY(y) {
    let lo = 0, hi = Math.max(0, this.totalRows - 1);
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.rowY(m) <= y) lo = m; else hi = m - 1; }
    return lo;
  }

  /** 境目を操作した行 r と一緒に変える行の範囲 [a, b]。行ごと選んでいて r がその中にあれば選んだ行すべて */
  resizeRows(r) {
    const { r0, r1 } = this.range();
    if (!this.rowSelect || r < r0 || r > r1) return [r, r];
    return [r0, Math.min(r1, this.rowCount - 1)];
  }

  /** 行の高さのドラッグ。選んだ行がすべて同じ高さになる */
  startRowResize(e, r, kind) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const [a, b] = this.resizeRows(r);
    if (b - a + 1 > MAX_RESIZE_ROWS) { this.hooks.onError?.(new Error(tr('一度に高さを変えられるのは {0} 行までです', [MAX_RESIZE_ROWS]))); return; }
    const startY = e.clientY, startH = this.rowH(r), base = new Map(this.manualHeights);
    let h = startH, moved = false;
    const move = (ev) => {
      moved = true;
      h = Math.max(MIN_H, Math.round(startH + (ev.clientY - startY) / this.z));
      const m = new Map(base);
      for (let i = a; i <= b; i++) m.set(i, h);
      this.setHeightMap(m); this.render();
    };
    const up = () => {
      removeEventListener(kind + 'move', move); removeEventListener(kind + 'up', up); removeEventListener('pointercancel', up);
      // 動かさずに離した（ダブルクリックの1回目など）なら何もしない。描き直すとダブルクリックが届かなくなる
      if (h === startH) { if (moved) { this.setHeightMap(base); this.render(); } return; }
      this.commitRowHeights(a, b, () => h);
    };
    addEventListener(kind + 'move', move); addEventListener(kind + 'up', up); addEventListener('pointercancel', up);
  }

  /** 行番号の欄の下の境目（ドラッグで高さを変える・ダブルクリックで中身に合わせる） */
  rowResizer(r) {
    return el('div.gr-resize', { title: tr('ドラッグで高さを変更・ダブルクリックで中身に合わせる'), on: {
      mousedown: (e) => { e.stopPropagation(); if (!this.touchRecent()) this.startRowResize(e, r, 'mouse'); },
      dblclick: (e) => { e.preventDefault(); e.stopPropagation(); if (!this.touchRecent()) this.autoFitRows(r); },
      // タッチ端末ではこの帯はタップを受け取らない（CSS）。高さは「▴▾」のつまみ、ダブルタップは borderDoubleTap で扱う
    } });
  }

  /** 行の高さを中身に合わせる（境目のダブルクリック・ダブルタップ）。選んだ行が複数ならそれぞれを合わせる */
  async autoFitRows(r) {
    const [a, b] = this.resizeRows(r);
    if (b - a + 1 > MAX_RESIZE_ROWS) { this.hooks.onError?.(new Error(tr('一度に高さを変えられるのは {0} 行までです', [MAX_RESIZE_ROWS]))); return; }
    const rows = await this.rowsBetween(a, b);
    // 折り返した文字が全部見える高さ。画像（BLOB・URL）は対象外で、セルの高さに合わせて縮めて出すだけ
    const text = this.measureRows(rows, a);
    const fits = rows.map((_, i) => text[i] ?? RH);
    await this.commitRowHeights(a, b, (i) => fits[i - a]);
  }

  /** 行 r（行ごと選んでいればその範囲）の高さを h にする（メニューの「数値で指定」） */
  async setRowsHeight(r, h) {
    const [a, b] = this.resizeRows(r);
    if (b - a + 1 > MAX_RESIZE_ROWS) { this.hooks.onError?.(new Error(tr('一度に高さを変えられるのは {0} 行までです', [MAX_RESIZE_ROWS]))); return; }
    h = Math.max(MIN_H, Math.round(h));
    await this.commitRowHeights(a, b, () => h);
  }

  /** 行 a〜b の高さを hOf(何行目) に決めて保存し、元に戻すに積む。自動の高さと同じなら、決めた高さを外して自動に戻す */
  async commitRowHeights(a, b, hOf) {
    const rows = await this.rowsBetween(a, b);
    const changes = [];
    rows.forEach((row, i) => {
      const r = a + i, id = this.rowId(r, row), h = hOf(r);
      const before = this.heights[id], after = h === this.autoH(r) ? undefined : h;
      if (before === after) return;
      changes.push({ id, before, after });
      if (after == null) delete this.heights[id]; else this.heights[id] = after;
    });
    this.saveHeights();
    this.setHeightMap(await this.heightMap());
    this.render();
    if (changes.length) this.hooks.onRowHeight?.(this.source.widthKey, changes);
  }

  // ---------- セルごとの書式（折り返し・画像表示など。定義は CELL_FORMATS） ----------
  // セルは「行のキー（主キー、なければ rowid）＋列名」で覚えるので、並べ替え・絞り込みをしても同じデータに付いてくる。
  // 覚えるのは既定と違うセルだけ（既定がオフの書式なら付けたセル）
  loadFormats() {
    const out = {};
    for (const [name, f] of Object.entries(CELL_FORMATS)) out[name] = this.loadCellSet(f.store);
    return out;
  }
  /** セルごとの書式を localStorage から読む・書く。prefix: 'wrapc:' など */
  loadCellSet(prefix) {
    try { const v = JSON.parse(localStorage.getItem(prefix + this.source.widthKey) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  }
  saveCellSet(prefix, set) {
    try {
      if (set.size) localStorage.setItem(prefix + this.source.widthKey, JSON.stringify([...set]));
      else localStorage.removeItem(prefix + this.source.widthKey);
    } catch { /* 無視 */ }
  }
  cellKey(r, row, c) { const col = this.cols[c]; return col ? JSON.stringify([this.rowId(r, row), col.name]) : null; }
  /** セルにその書式が効いているか */
  isFormat(name, r, row, c) {
    const f = CELL_FORMATS[name], set = this.formats[name];
    if (!set.size) return f.def;
    const k = this.cellKey(r, row, c);
    return k == null ? f.def : f.def !== set.has(k);
  }
  /** そのセルにその書式を付けられるか */
  canFormat(name, r, row, c) { return CELL_FORMATS[name].can(this, row?.values?.[c], r, row, c); }
  /** cells のその書式を切り替える（元に戻すに積む）。行の高さは自動では変えない（折り返しは測り直す） */
  setFormat(name, cells, on) {
    const f = CELL_FORMATS[name], set = this.formats[name], before = [...set];
    for (const { r, row, c } of cells) {
      const k = this.cellKey(r, row, c);
      if (k == null) continue;
      if (on !== f.def) set.add(k); else set.delete(k);
    }
    if (before.length === set.size && before.every((k) => set.has(k))) return;
    this.saveCellSet(f.store, set); this.remeasure();
    this.hooks.onFormat?.(name, this.source.widthKey, before, [...set]);
  }
  /** 元に戻す・やり直すから：その書式のセルをそのまま入れ替える */
  setFormatKeys(name, keys) {
    this.formats[name] = new Set(keys);
    this.saveCellSet(CELL_FORMATS[name].store, this.formats[name]); this.remeasure();
  }
  /**
   * セルに出す画像の URL。BLOB の画像なら Object URL、画像の書式を付けた URL の文字列ならその URL。
   * どちらでもなければ null（BLOB と URL で同じ表示の仕組みを使う）
   */
  imageSrc(v, r, row, c) {
    if (v instanceof Uint8Array) { const k = sniff(v); return k.image && v.length ? this.blobUrl(v, k.mime) : null; }
    return this.isFormat('image', r, row, c) ? imageUrlOf(v) : null;
  }
  /** そのセルにプレビューを出すか（今は画像だけ：BLOB の画像と、画像で表示する URL） */
  hasPreview(v, r, row, c) {
    if (v instanceof Uint8Array) return v.length > 0 && sniff(v).image;
    return imageUrlOf(v) != null && this.isFormat('image', r, row, c);
  }
  /** 選んでいるセルのうち、読み込み済みの行のもの（書式の対象）: [{r, row, c}] */
  selectedCells() {
    const { r0, r1, c0, c1 } = this.range();
    const out = [];
    for (let r = r0; r <= r1 && r < this.rowCount; r++) {
      const p = Math.floor(r / PAGE), row = this.pages.get(p)?.[r - p * PAGE];
      if (!row) continue;
      for (let c = c0; c <= c1; c++) if (this.cols[c]) out.push({ r, row, c });
    }
    return out;
  }

  /**
   * 行ごとの、折り返したセルの中身が全部見える高さ（折り返すセルがなければ空）。
   * 実際と同じ CSS のセルを、見えない所に並べて測る。r0: rows[0] が何行目か
   */
  measureRows(rows, r0) {
    if (!this.formats.wrap.size || !rows.length) return [];
    let any = false;
    const lines = rows.map((row, i) => {
      const line = el('div.gr-measure', { style: { display: 'flex', alignItems: 'flex-start' } });
      if (row) for (let c = 0; c < this.cols.length; c++) {
        if (!this.isFormat('wrap', r0 + i, row, c)) continue;
        const cell = el('div.gc', { style: { width: this.colW(c) + 'px', height: 'auto' } });
        this.fillCell(cell, row.values[c], this.cols[c], row, r0 + i, c);
        line.append(cell); any = true;
      }
      return line;
    });
    if (!any) return [];
    const probe = el('div.grid-measure', { style: { position: 'absolute', visibility: 'hidden', top: 0, left: 0, pointerEvents: 'none' } });
    probe.append(...lines);
    this.body.append(probe);
    const hs = lines.map((line) => Math.min(MAX_WRAP_H, Math.max(RH, Math.ceil(line.getBoundingClientRect().height / this.z))));
    probe.remove();
    return hs;
  }

  /** 読み込んだページの行を測って、自動の高さに入れる */
  measurePage(p, rows) {
    const hs = this.measureRows(rows, p * PAGE);
    let changed = false;
    rows.forEach((_, i) => {
      const r = p * PAGE + i, h = hs[i] ?? RH;
      if (h > RH) { if (this.autoHeights.get(r) !== h) { this.autoHeights.set(r, h); changed = true; } }
      else if (this.autoHeights.delete(r)) changed = true;
    });
    return changed;
  }

  /** 列幅が変わると折り返しの位置が変わるので、折り返すセルがあれば測り直す */
  afterWidthChange() { if (this.formats.wrap.size) this.remeasure(); }

  /** 折り返しや列幅が変わったときに、読み込み済みの行を測り直す */
  remeasure() {
    this.autoHeights = new Map();
    for (const [p, rows] of this.pages) this.measurePage(p, rows);
    this.applyHeights();
    this.renderHeader(); this.render(); this.placeSink();
  }

  /** 元に戻す・やり直すから：{行の見分け方: 高さ（undefined なら標準）} */
  async setRowHeights(map) {
    for (const [id, h] of Object.entries(map)) { if (h == null) delete this.heights[id]; else this.heights[id] = h; }
    this.saveHeights();
    this.setHeightMap(await this.heightMap());
    this.render(); this.placeSink();
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
    h.append(el('div.gh-corner', { style: { width: RHW + 'px' }, title: tr('すべて選択'), on: { mousedown: (e) => { e.preventDefault(); this.selectAll(); } } }));
    this.cols.forEach((col, c) => {
      const cell = el('div.gh-cell', {
        style: { width: this.colW(c) + 'px' },
        class: [col.readonly ? 'ro' : '', this.flash?.cols.has(c) && Date.now() < this.flash.until ? 'flash' : ''].join(' ').trim(),
        title: col.title || '',
        on: {
          pointerdown: (e) => {
            if (e.pointerType === 'mouse' || e.target.closest('.gh-btn, .gh-resize')) return;
            // 境目の近くを続けて2回タップしたら、その列の幅を中身に合わせる
            const near = [...h.querySelectorAll('.gh-cell')].findIndex((x) => Math.abs(x.getBoundingClientRect().right - e.clientX) <= 10);
            if (this.borderDoubleTap('col', near, e)) return;
            // タッチ（スプレッドシートと同じ）：タップで列を選ぶ。選んでいる列をもう一度タップするか、長押しで列メニュー
            // スクロールのために指を動かしたら何もしない
            this.tap(e, () => {
              const again = this.colSelect && !this.rowSelect && this.cur.c === c && this.ext.c === c;
              if (again) this.hooks.onHeaderMenu?.(c, cell);
              else this.selectCol(c, false);
            }, () => {
              const { c0, c1 } = this.range();
              if (!this.colSelect || this.rowSelect || c < c0 || c > c1) this.selectCol(c, false);
              navigator.vibrate?.(10);
              this.hooks.onHeaderMenu?.(c, cell);
            });
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
      col.sort ? el('span.gh-sort', { title: col.sort.total > 1 ? tr('並べ替えの第{0}基準', [col.sort.rank]) : tr('並べ替え中') },
        (col.sort.dir === 'asc' ? '↑' : '↓') + (col.sort.total > 1 ? col.sort.rank : '')) : null,
      col.filtered ? el('span.gh-filter', { title: tr('絞り込み中') }, '⏷') : null,
      el('button.gh-btn', { title: tr('列メニュー'), on: { click: (e) => { e.stopPropagation(); this.hooks.onHeaderMenu?.(c, e.currentTarget); } } }, '⋮')),
      el('div.gh-resize', { title: tr('ドラッグで幅を変更・ダブルクリックで中身に合わせる'), on: {
        mousedown: (e) => { if (!this.touchRecent()) this.startResize(e, c, 'mouse'); },
        dblclick: (e) => { e.preventDefault(); e.stopPropagation(); if (!this.touchRecent()) this.autoFit(c); },
        // タッチ端末ではこの帯はタップを受け取らない（CSS）。幅は「◂▸」のつまみ、ダブルタップは borderDoubleTap で扱う
      } }));
      h.append(cell);
    });
    // 列を選んでいるときの、幅を変えるつまみ（タッチ端末だけ。置き場所は placeHandle で決める）
    if (TOUCH) h.append(this.widthKnob = el('div.gh-knob', { hidden: true, title: tr('ドラッグで幅を変更・ダブルクリックで中身に合わせる'), on: {
      pointerdown: (e) => { this.lastTouch = Date.now(); this.startResize(e, this.range().c1, 'pointer'); },
    } }));
    if (this.hooks.onAddColumn) {
      h.append(el('button.gh-add', { title: tr('列を追加'), on: { click: (e) => this.hooks.onAddColumn(e.currentTarget) } }, tr('＋')));
    }
  }

  /** カーソルは列の先頭（extend なら始めの列のまま）、範囲は最後の行まで */
  selectCol(c, extend) {
    this.none = false;
    if (this.editing) this.commitEdit({ move: null });
    this.cur = { r: 0, c: extend ? this.cur.c : c };
    this.ext = { r: Math.max(0, this.rowCount - 1), c };
    this.colSelect = true; this.rowSelect = false;
    this.render(); this.emitSelect(); this.focus();
  }

  /** 列幅のドラッグ。マウスは mouse*、指は pointer* のイベントで追う */
  startResize(e, c, kind) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    // 列ごと複数選んでいれば、選んだ列すべてを同じ幅にする
    const targets = this.resizeCols(c).map((i) => this.cols[i].name);
    const startX = e.clientX, startW = this.colW(c);
    const befores = Object.fromEntries(targets.map((name) => [name, this.widths[name]]));
    const move = (ev) => {
      const w = Math.max(MIN_W, startW + (ev.clientX - startX) / this.z);
      for (const name of targets) this.widths[name] = w;
      this.renderHeader(); this.render();
    };
    const up = () => {
      removeEventListener(kind + 'move', move); removeEventListener(kind + 'up', up); removeEventListener('pointercancel', up);
      this.saveWidths(); this.afterWidthChange();
      this.emitWidths(befores);
    };
    addEventListener(kind + 'move', move); addEventListener(kind + 'up', up); addEventListener('pointercancel', up);
  }

  // ---------- 一気に移動するつまみ ----------
  /** つまみの位置を今のスクロール位置に合わせる。wake なら表示して、しばらく触らなければ消す */
  syncFast(wake) {
    const s = this.scroll, max = s.scrollHeight - s.clientHeight;
    // 画面の 4 倍に満たない表では出さない（普通のスクロールで足りる）
    const on = this.byTouch && max > s.clientHeight * 3;
    this.fast.hidden = !on;
    this.host.classList.toggle('fs-on', on); // つまみを出すときはブラウザのスクロールバーを隠す（二重に見えないように）
    if (!on) return;
    const track = this.fast.clientHeight - this.fastThumb.offsetHeight;
    if (!this.fastDragging) this.fastThumb.style.transform = `translateY(${(max ? s.scrollTop / max : 0) * track}px)`;
    if (!wake) return;
    this.fast.classList.add('show');
    clearTimeout(this.fastTimer);
    if (!this.fastDragging) this.fastTimer = setTimeout(() => this.fast.classList.remove('show'), 1500);
  }
  startFastScroll(e) {
    e.preventDefault(); e.stopPropagation();
    const t = this.fastThumb, top = this.fast.getBoundingClientRect().top, grab = e.clientY - t.getBoundingClientRect().top;
    try { t.setPointerCapture(e.pointerId); } catch { /* 指がもう離れている */ }
    this.fastDragging = true; this.fast.classList.add('dragging');
    const move = (ev) => {
      const s = this.scroll, track = this.fast.clientHeight - t.offsetHeight;
      const y = Math.min(track, Math.max(0, ev.clientY - top - grab)), ratio = track ? y / track : 0;
      t.style.transform = `translateY(${y}px)`;
      s.scrollTop = ratio * (s.scrollHeight - s.clientHeight);
      this.fastLabel.style.transform = `translateY(${y + t.offsetHeight / 2}px)`;
      // 一番上で先頭、一番下で最後の行になるよう、つまみの位置の割合から行を出す
      this.fastRow = Math.round(ratio * Math.max(0, this.rowCount - 1));
      this.showFastLabel(this.fastRow);
    };
    const up = () => {
      t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up);
      this.fastDragging = false; this.fast.classList.remove('dragging'); this.fastLabel.hidden = true;
      this.syncFast(true);
    };
    t.addEventListener('pointermove', move); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
    move(e);
  }
  /** 吹き出し：並べ替えているならその第1基準の列の値、そうでなければ何行目か */
  showFastLabel(r) {
    const total = this.rowCount;
    r = Math.min(r, Math.max(0, total - 1));
    const c = this.cols.findIndex((col) => col.sort && (col.sort.rank ?? 1) === 1);
    let text = `${(r + 1).toLocaleString()} / ${total.toLocaleString()}`;
    if (c >= 0) {
      const row = this.rowAt(r); // 読み込んでいなければ読み込みを始める
      if (row) {
        const v = row.values[c];
        text = v == null ? NULL_LABEL : v instanceof Uint8Array ? 'BLOB' : String(v).replace(/\s+/g, ' ').slice(0, 40);
      } else {
        const p = Math.floor(r / PAGE);
        this.loadPage(p)?.then(() => { if (this.fastDragging && !this.fastLabel.hidden) this.showFastLabel(this.fastRow); });
        text = '…';
      }
    }
    this.fastLabel.textContent = text;
    this.fastLabel.hidden = false;
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
      if (this.measurePage(p, rows)) this.applyHeights(); // 折り返した列があれば、行の高さを中身に合わせる
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
    const first = Math.max(0, this.rowAtY(st - HH) - 4);
    const last = Math.min(this.totalRows - 1, this.rowAtY(st + vh) + 4);
    const { r0, r1, c0, c1 } = this.range();
    const frag = document.createDocumentFragment();
    const widths = this.cols.map((_, c) => this.colW(c));
    this.blobUsed = new Set();
    for (let r = first; r <= last; r++) {
      const isNew = r === this.newRowIndex;
      if (isNew && !this.draft) {
        // 下書きを開いていないときは、行番号欄の「＋」だけ（列追加の「＋」と対になる見た目）
        const here = this.cur.r === r;
        // 行は表の幅いっぱいにする（行番号の欄と同じく、横にスクロールしても「＋」が左に残るように）
        frag.append(el('div.gr.row-adder', { class: here ? 'cur' : '', style: { top: this.rowY(r) + 'px', width: this.totalW() + 'px' }, dataset: { r } },
          el('div.gr-head', { style: { width: RHW + 'px' }, title: tr('行を追加（最後の行で ↓ でも開きます）') }, tr('＋'))));
        continue;
      }
      const row = isNew ? null : this.rowAt(r);
      const rowSel = r >= r0 && r <= r1;
      const draft = isNew ? this.draft : null;
      const h = this.rowH(r);
      const rowEl = el('div.gr', {
        class: [isNew ? 'new draft' : (row && this.source.isPendingRow?.(row) ? 'pending' : ''), h > RH ? 'tall' : ''].join(' ').trim(),
        // 行の高さを変えても文字が縦の真ん中に来るよう、行の line-height をセルが受け継ぐ
        style: { top: this.rowY(r) + 'px', width: this.totalW() + 'px', ...(h !== RH ? { height: h + 'px', lineHeight: (h - 1) + 'px' } : {}) },
        dataset: { r },
      });
      rowEl.append(el('div.gr-head', {
        class: rowSel ? 'hl' : '',
        style: { width: RHW + 'px' },
        title: isNew ? tr('新しい行（行を離れると保存・Esc で取り消し）') : '',
      }, isNew ? '✎' : String(r + 1), isNew ? null : this.rowResizer(r)));
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
          else if (v instanceof Uint8Array) this.fillCell(cell, v, col, { values: draft.values }, r, c);
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
            title: tr('参照先から選ぶ（Alt+↓）'),
            on: { mousedown: (e) => { e.preventDefault(); e.stopPropagation(); this.hooks.onFkPick(r, c, e.currentTarget); } },
          }, '▾'));
        }
        rowEl.append(cell);
      }
      frag.append(rowEl);
    }
    this.body.replaceChildren(frag);
    this.host.classList.toggle('no-sel', this.none);
    this.releaseBlobUrls();
    this.blobUsed = null;
    this.placeSink();
    this.renderEmpty();
  }

  renderEmpty() {
    const show = this.rowCount === 0 && !this.source.editable;
    if (show && !this.empty) {
      this.empty = el('div.grid-empty', tr('行がありません'));
      this.host.append(this.empty);
    } else if (!show && this.empty) { this.empty.remove(); this.empty = null; }
  }

  fillCell(cell, v, col, row, r, c) {
    const err = row.errors?.[c];
    if (err) { cell.classList.add('err'); cell.title = err; }
    if (v === null || v === undefined) { cell.classList.add('null'); cell.textContent = NULL_LABEL; return; }
    if (v instanceof Uint8Array) {
      const k = sniff(v);
      cell.classList.add('blob');
      const text = `${v.length ? k.label : 'BLOB'} ${fmtBytes(v.length)}`;
      const src = this.imageSrc(v, r, row, c);
      if (src) preview(cell, src, text, false, this.isFormat('info', r, row, c));
      else cell.append(text);
      return;
    }
    if (typeof v === 'number' || typeof v === 'bigint') { cell.classList.add('num'); }
    const s = String(v);
    if (s === '') { cell.classList.add('emptystr'); return; }
    const t = s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s;
    // 画像で表示する URL：BLOB と同じプレビュー。付加情報は URL の文字（読めなければ文字だけに戻る）
    const src = this.imageSrc(v, r, row, c);
    if (src) { cell.classList.add('imgurl'); preview(cell, src, t, true, this.isFormat('info', r, row, c)); return; }
    // 折り返すセルは改行をそのまま出す。折り返さないセルは1行なので、改行があることだけ ⏎ で見せる
    if (this.isFormat('wrap', r, row, c)) { cell.classList.add('wrap'); cell.textContent = t; }
    else cell.textContent = t.replaceAll('\n', ' ⏎ ');
    if (col.fk) {
      cell.classList.add('fk');
      const label = row.labels?.[c];
      if (label != null) cell.append(el('span.fk-label', String(label)));
    }
    void r;
  }

  /** 画像の BLOB の Object URL。描画中に使ったものだけを残し、ほかは render() の終わりで解放する */
  blobUrl(v, mime) {
    this.blobUrls ??= new Map();
    let url = this.blobUrls.get(v);
    if (!url) { url = URL.createObjectURL(new Blob([v], { type: mime })); this.blobUrls.set(v, url); }
    this.blobUsed?.add(v);
    return url;
  }

  releaseBlobUrls() {
    if (!this.blobUrls) return;
    for (const [v, url] of this.blobUrls) if (!this.blobUsed?.has(v)) { URL.revokeObjectURL(url); this.blobUrls.delete(v); }
  }

  placeSink() {
    const { r, c } = this.cur;
    if (!this.cols.length) return;
    const x = this.colX(c), y = this.rowY(r), rh = this.rowH(r);
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
    Object.assign(this.sink.style, { left: left + 'px', top: y + 'px', width: w + 'px', height: rh + 'px' });
    if (this.editing) this.sink.style.height = Math.max(rh, Math.min(200, this.sink.scrollHeight)) + 'px';
    this.sink.classList.toggle('editing', !!this.editing);
    if (TOUCH && !this.editing) this.sink.inputMode = 'none';
    this.placeHandle();
  }

  /** 範囲の右下に、範囲を広げるつまみを置く（タッチ端末・編集していないときだけ） */
  placeHandle() {
    const show = TOUCH && this.byTouch && !this.none && !this.editing && this.cols.length > 0 && this.rowCount > 0 && this.cur.r !== this.newRowIndex;
    // 列ごと選んでいるときは、右下のつまみの代わりに（スプレッドシートと同じ）
    // ・選んだ列の左右の境目に、範囲を広げるつまみ（見えている範囲の縦の真ん中）
    // ・見出しの右下の境目に、幅を変えるつまみ
    const head = show && this.colSelect && !this.rowSelect;
    // 行ごと選んでいるときも同じ：選んだ行の上下の境目に範囲を広げるつまみ（見えているデータの列の横の真ん中）
    const rowHead = show && this.rowSelect && !this.colSelect;
    const { r0, r1, c0, c1 } = this.range();
    this.handle.hidden = !show || head || rowHead;
    this.colHandles.forEach((h) => { h.hidden = !head; });
    this.rowHandles.forEach((h) => { h.hidden = !rowHead; });
    // 高さ・幅のつまみは、すべて選んでいるとき（行も列も選択）にも出す
    const knobH = show && this.rowSelect, knobW = show && this.colSelect;
    if (this.heightKnob) {
      this.heightKnob.hidden = !knobH;
      if (knobH) Object.assign(this.heightKnob.style, { left: (this.scroll.scrollLeft / this.z + RHW) + 'px', top: this.rowY(r1 + 1) + 'px' });
    }
    if (this.widthKnob) {
      this.widthKnob.hidden = !knobW;
      if (knobW) this.widthKnob.style.left = (this.colX(c1) + this.colW(c1)) + 'px';
    }
    if (rowHead) {
      const sl = this.scroll.scrollLeft / this.z, vw = this.scroll.clientWidth / this.z, right = this.colX(this.cols.length);
      // 列が画面の右端まで届かなければ、データのある所だけの真ん中
      const x0 = Math.min(sl + RHW, right), x1 = Math.min(sl + vw, right);
      const left = ((x0 + x1) / 2) + 'px';
      const [t, b] = this.rowHandles;
      Object.assign(t.style, { left, top: this.rowY(r0) + 'px' });
      Object.assign(b.style, { left, top: this.rowY(r1 + 1) + 'px' });
      return;
    }
    if (head) {
      const st = this.scroll.scrollTop / this.z, vh = this.scroll.clientHeight / this.z;
      // 見えているデータの行の縦の真ん中（行が画面の下まで届かなければ、データのある所だけの真ん中）
      const y0 = Math.min(st, this.rowY(this.rowCount)), y1 = Math.min(st + vh - HH, this.rowY(this.rowCount));
      const top = ((y0 + y1) / 2) + 'px';
      const [l, r] = this.colHandles;
      Object.assign(l.style, { left: this.colX(c0) + 'px', top });
      Object.assign(r.style, { left: (this.colX(c1) + this.colW(c1)) + 'px', top });
    }
    if (!show || head) return;
    Object.assign(this.handle.style, { left: (this.colX(c1) + this.colW(c1)) + 'px', top: this.rowY(r1 + 1) + 'px' });
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
    this.none = false;
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
    this.colSelect = false; this.rowSelect = false;
    this.ensureVisible(extend ? this.ext : this.cur);
    this.render();
    this.emitSelect();
  }

  selectAll() {
    this.none = false;
    this.cur = { r: 0, c: 0 };
    this.ext = { r: Math.max(0, this.rowCount - 1), c: this.cols.length - 1 };
    this.colSelect = this.rowSelect = true; // すべて選んでいれば、どの行・列の境目でもまとめて変えられる
    this.render(); this.emitSelect(); this.focus();
  }

  selectRows(r0, r1) {
    this.none = false;
    this.cur = { r: r0, c: 0 };
    this.ext = { r: r1, c: this.cols.length - 1 };
    this.colSelect = false; this.rowSelect = true;
    this.render(); this.emitSelect();
  }

  ensureVisible(target = this.cur) {
    const { r, c } = target;
    const s = this.scroll;
    const z = this.z;
    const top = this.rowY(r) * z, bottom = top + (this.rowH(r) + HH) * z;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (bottom > s.scrollTop + s.clientHeight) s.scrollTop = bottom - s.clientHeight;
    const x = this.colX(c) * z, w = this.colW(c) * z;
    if (x - RHW * z < s.scrollLeft) s.scrollLeft = x - RHW * z;
    else if (x + w > s.scrollLeft + s.clientWidth) s.scrollLeft = x + w - s.clientWidth;
  }

  /** 選択を解除する（スマホの上部バーの ✓）。編集中なら確定してから */
  async deselect() {
    if (this.editing) await this.commitEdit({ move: null });
    this.none = true;
    this.colSelect = this.rowSelect = false;
    this.sink.blur();
    this.render();
    this.emitSelect();
  }

  emitSelect() {
    if (this.none) { this.hooks.onSelect?.(null); return; }
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

  /**
   * タッチ：境目の近く（i は列か行の番号。近くなければ -1）を続けて2回タップしたかを見る。
   * 2回目なら中身に合わせて true（そのタップのふつうの動き＝メニューなどは出さない）。1回目はふつうのタップとして通す
   */
  borderDoubleTap(kind, i, e) {
    const t = this.lastBorderTap, now = Date.now();
    this.lastBorderTap = i >= 0 ? { kind, i, at: now } : null;
    if (i < 0 || !t || t.kind !== kind || t.i !== i || now - t.at >= 350) return false;
    this.lastBorderTap = null;
    this.lastTouch = now;
    e.preventDefault();
    if (kind === 'col') this.autoFit(i); else this.autoFitRows(i);
    return true;
  }

  onTouchDown(e) {
    if (e.pointerType === 'mouse') return;
    const hit = this.cellFromEvent(e);
    if (!hit || e.target.closest('.fk-drop')) { this.lastTouch = Date.now(); return; }
    const x = e.clientX, y = e.clientY;
    if (hit.head) {
      // 行番号の境目の近くを続けて2回タップしたら、その行の高さを中身に合わせる（上の境目は1つ上の行のもの）
      const b = e.target.closest('.gr')?.getBoundingClientRect();
      const near = !b ? -1 : Math.abs(b.bottom - y) <= 6 ? hit.r : Math.abs(y - b.top) <= 6 ? hit.r - 1 : -1;
      if (this.borderDoubleTap('row', near >= 0 && near < this.rowCount ? near : -1, e)) return;
    }
    this.tap(e, () => this.onTap(hit, { x, y }), () => {
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
  onTap(hit, at) {
    const again = !this.none && !hit.head && hit.r === this.cur.r && hit.c === this.cur.c
      && this.ext.r === this.cur.r && this.ext.c === this.cur.c && !this.colSelect;
    if (this.editing) {
      if (again) return; // 編集中のセルのタップ（入力欄の中のカーソル移動）はそのまま
      this.commitEdit({ move: null });
    }
    if (hit.r === this.newRowIndex && !this.draft) { this.focus(); this.addRow(); return; }
    if (hit.r === this.newRowIndex && hit.head) { this.moveTo(hit.r, 0); this.focus(); return; }
    if (hit.head) {
      // 選んでいる1行の行番号をもう一度タップしたら、行のメニュー（長押しと同じ。スプレッドシートと同じ）
      const sel = this.rowSelect && !this.colSelect && this.cur.r === hit.r && this.ext.r === hit.r;
      if (sel) { this.hooks.onContextMenu?.(at, { ...this.range(), head: true }); return; }
      this.selectRows(hit.r, hit.r); this.focus(); return;
    }
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

  /** 行の上下のつまみを縦にドラッグして、選ぶ行を広げる・狭める。反対側の端の行はそのまま */
  startRowHandleDrag(e, side) {
    e.preventDefault(); e.stopPropagation();
    this.lastTouch = Date.now();
    const { r0, r1 } = this.range();
    let anchor = side === 'top' ? r1 : r0, end = side === 'top' ? r0 : r1;
    const move = (ev) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const h = target && this.inner.contains(target) ? this.cellFromEvent({ target }) : null;
      if (!h || h.r >= this.rowCount || h.r === end) return;
      end = h.r;
      this.selectRows(Math.min(anchor, end), Math.max(anchor, end));
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      this.lastTouch = Date.now();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  /** 列の左右のつまみを横にドラッグして、選ぶ列を広げる・狭める。反対側の端の列はそのまま */
  startColHandleDrag(e, side) {
    e.preventDefault(); e.stopPropagation();
    this.lastTouch = Date.now();
    const { c0, c1 } = this.range();
    this.cur.c = side === 'left' ? c1 : c0;
    this.ext.c = side === 'left' ? c0 : c1;
    const move = (ev) => {
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const h = target && this.inner.contains(target) ? this.cellFromEvent({ target }) : null;
      if (h && !h.head && h.c !== this.ext.c) this.selectCol(h.c, true);
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
    // 範囲の外なら選択を移してからメニュー（長押しと同じ。メニューの中身は選び方で変わるので）
    if (this.editing) this.commitEdit({ move: null });
    const { r0, r1, c0, c1 } = this.range();
    const inside = hit.r >= r0 && hit.r <= r1 && (hit.head || (hit.c >= c0 && hit.c <= c1));
    if (!inside && hit.r !== this.newRowIndex) hit.head ? this.selectRows(hit.r, hit.r) : this.moveTo(hit.r, hit.c);
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
    if (r !== this.newRowIndex && !this.canUpdate) return false;
    const col = this.cols[c];
    if (!col || col.readonly) return false;
    if (r !== this.newRowIndex && !this.rowAt(r)) return false;
    if (this.protAt(r, c).length) return false;
    if (r === this.newRowIndex && !this.draft) return false; // 「＋」の上：行を作るまでは入力できない
    return true;
  }

  /** 入力なしでも記録として成り立つ表（必須の列がない）か */
  get canInsertEmpty() { return this.canInsert && !this.cols.some((c) => c.required); }

  /** 「＋」の操作：入力の要らない表は即 INSERT、それ以外は下書きの行を開く */
  async addRow() {
    if (!this.canInsert) return;
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
    if (this.none) { this.none = false; this.render(); this.emitSelect(); }
    const { r, c } = this.cur;
    // BLOB のダブルクリック・もう一度のタップ・Enter・F2 は、中身を表示する（読み取り専用でも見られる）
    if (mode === 'edit' && this.rowAt(r)?.values[c] instanceof Uint8Array && this.hooks.onBlobView) {
      this.sink.value = ''; this.hooks.onBlobView(r, c); return false;
    }
    if (!this.canEdit(r, c)) {
      this.sink.value = '';
      // 「＋」の上で打った文字は捨てる（行を作るのはクリックか Enter）
      const prots = this.protAt(r, c);
      if (prots.length) this.hooks.onProtectedEdit?.(prots);
      else if (this.source.editable && !(r === this.newRowIndex && !this.draft)) this.hooks.onReadonlyEdit?.(this.cols[c]);
      return false;
    }
    const v = this.currentValue();
    // 新しい行の下書きに入れた BLOB は、打てばそのまま文字に置き換えられる
    if (v instanceof Uint8Array && r !== this.newRowIndex) { this.hooks.onBlobEdit?.(r, c); this.sink.value = ''; return false; }
    // NULL のセルは空から始める。空のまま確定したら NULL のまま、一度でも打ってから空にしたら空文字列
    const isNull = r !== this.newRowIndex && v === null;
    const start = isNull ? '' : this.formAt(r, c);
    if (initial !== undefined) { /* 入力済みの文字をそのまま使う */ } else this.sink.value = start;
    this.editing = { mode, r, c, start, isNull, touched: this.sink.value !== '' };
    this.sink.placeholder = r === this.newRowIndex && v === undefined ? this.placeholderFor(c)
      : r !== this.newRowIndex && (this.cols[c].emptyIsNull || (isNull && !this.editing.touched)) ? 'NULL' : '';
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
    if (this.sink.value !== '' && !this.editing.touched) {
      this.editing.touched = true;
      // 空で確定すると空文字列になるので「NULL」の表示を消す（空なら NULL になる列は出したまま）
      if (this.editing.isNull && !this.cols[this.editing.c]?.emptyIsNull) this.sink.placeholder = '';
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
    const { r, c, start, isNull, touched } = this.editing;
    const text = this.sink.value;
    this.editing = null;
    this.sink.value = '';
    this.sink.placeholder = '';
    this.placeSink();
    this.hooks.onEditState?.(false);
    // フォームが開いたときと同じなら何もしない（NULL のセルで打ってから空にしたときは空文字列を入れる）
    const unchanged = text === start && !(isNull && touched);
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
    // STRICT の数値の列を空で確定したら NULL（元から NULL なら変更なし）
    const toNull = text === '' && this.cols[c]?.emptyIsNull;
    const skip = toNull ? isNull : unchanged;
    const pending = !skip ? this.write([{ r, c, value: toNull ? null : form(text) }]) : null;
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
        if (res == null) await this.reload(); // ビューなど、変えた行を見つけ直せない書き込み
        const touched = new Set();
        for (const { row, rowObj } of res ?? []) {
          const p = Math.floor(row / PAGE);
          const page = this.pages.get(p);
          if (page) { page[row - p * PAGE] = rowObj; touched.add(p); }
        }
        // 書き換えた値に合わせて、折り返した列の行の高さを測り直す
        let grew = false;
        for (const p of touched) if (this.measurePage(p, this.pages.get(p))) grew = true;
        if (grew) { this.applyHeights(); this.placeSink(); }
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
      // 1セルの入力なら、失敗した値を残して再編集できるようにする
      const ch = changes.length === 1 ? changes[0] : null;
      const reopened = ch?.value?.form !== undefined;
      if (ch) {
        this.cur = { r: ch.r, c: ch.c }; this.ext = { ...this.cur };
        this.render(); this.emitSelect();
      }
      if (reopened) {
        this.sink.value = ch.value.form;
        const wasNull = ch.r < this.rowCount && this.rowAt(ch.r)?.values[ch.c] === null;
        this.editing = { mode: 'edit', r: ch.r, c: ch.c, start: wasNull ? '' : this.formAt(ch.r, ch.c), isNull: wasNull, touched: true };
        this.placeSink();
        this.sink.classList.add('invalid');
        this.hooks.onEditState?.(true, ch.value.form);
        // 知らせ方とカーソルの置き場所を引き受けてくれたら任せる（スマホは数式バーのまま直す）
        if (this.hooks.onEditError?.(err)) return false;
        setTimeout(() => this.sink.classList.remove('invalid'), 1500);
      }
      this.hooks.onError?.(err);
      if (ch) this.focus();
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
    const values = rows.map((row) => { const vals = []; for (let c = c0; c <= c1; c++) vals.push(row?.values[c] ?? null); return vals; });
    const tsv = values.map((vals) => vals.map(toTsvCell).join('\t')).join('\n');
    // BLOB は文字にできないので、アプリ内で貼るときのために元の値を覚えておく（目印を HTML に入れる）
    const hasBlob = values.some((vals) => vals.some((v) => v instanceof Uint8Array));
    const id = hasBlob ? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` : null;
    this.lastCopy = hasBlob ? { id, tsv, values, left: false } : null;
    const n = (last - r0 + 1) * (c1 - c0 + 1);
    const single = n === 1 && values[0][0] instanceof Uint8Array ? values[0][0] : null;
    const image = single && single.length && sniff(single).image ? single : null;
    try {
      if (hasBlob && window.ClipboardItem && navigator.clipboard.write) {
        const items = {
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
          'text/html': new Blob([toHtmlTable(values, id)], { type: 'text/html' }),
        };
        // 画像のセル1つなら、ほかのアプリにも画像として貼れるよう PNG も載せる（Safari のため Promise のまま渡す）
        if (image) items['image/png'] = toPng(image, sniff(image).mime);
        await navigator.clipboard.write([new ClipboardItem(items)]);
      } else {
        await navigator.clipboard.writeText(tsv);
      }
      this.hooks.onInfo?.(image ? tr('画像をコピーしました') : tr('{0} セルをコピーしました', [n]));
    } catch { this.hooks.onError?.(new Error(tr('クリップボードに書き込めませんでした'))); }
  }

  /** 貼ろうとしている中身が、直前にこのアプリでコピーしたものか（そうなら BLOB を含む元の値を返す） */
  ownCopy({ text, html }) {
    const lc = this.lastCopy;
    if (!lc) return null;
    if (html && html.includes(`data-sqlite-sheet="${lc.id}"`)) return lc.values;
    // 目印が届かない環境（HTML が消毒される・HTML を読めない）向け：
    // 文字が同じで、そのあとほかのアプリへ移っていなければ同じコピーとみなす
    if (!lc.left && (text ?? '') === lc.tsv) return lc.values;
    return null;
  }

  /** 画像（BLOB）を入れられる列か：BLOB 型か型なし */
  acceptsBlob(c) {
    const col = this.cols[c];
    if (!col || col.readonly) return false;
    const a = affinity(col.type);
    return a === 'BLOB' || a === 'ANY';
  }

  /**
   * クリップボードの中身を貼る。image は画像の Blob（なければ null）。
   * 選択中の列が BLOB を受け付けるなら画像を、そうでなければ文字を貼る
   * （Excel などはセルのコピーに画像も付けるので、BLOB でない列では文字を優先する）
   */
  async pasteClipboard({ file, text, html }) {
    const own = this.ownCopy({ text, html });
    if (own) return this.paste(null, own);
    const { c0, c1 } = this.range();
    const blobCols = [];
    for (let c = c0; c <= c1; c++) if (this.acceptsBlob(c)) blobCols.push(c);
    if (file && blobCols.length) return this.pasteBlob(new Uint8Array(await file.arrayBuffer()), blobCols);
    if (text) return this.paste(text);
    if (file) this.hooks.onError?.(new Error(tr('ファイルや画像は BLOB の列（または型のない列）にだけ貼り付けられます')));
  }

  /** ドロップ先が、ファイルを入れられるセルなら {r, c} */
  blobDropTarget(e) {
    if (!this.source.editable) return null;
    const hit = this.cellFromEvent(e);
    return hit && !hit.head && hit.r <= this.newRowIndex && this.acceptsBlob(hit.c) ? hit : null;
  }

  markDrop(hit) {
    this.body.querySelector('.gc.drop')?.classList.remove('drop');
    if (hit) this.body.querySelector(`.gr[data-r="${hit.r}"] .gc[data-c="${hit.c}"]`)?.classList.add('drop');
  }

  /**
   * 行 r0〜r1（省略時は選択範囲）の cols の列に、同じバイト列を入れる。
   * 新しい行には下書きのそのセルに入れるだけで、行は確定しない（保存は行を離れたとき）
   */
  async pasteBlob(bytes, cols, { r0, r1 } = this.range()) {
    if (!this.source.editable) { this.hooks.onReadonlyEdit?.(); return; }
    const what = sniff(bytes).image ? tr('画像') : tr('ファイル');
    const changes = [];
    let toDraft = 0;
    for (let r = r0; r <= r1; r++) {
      for (const c of cols) {
        if (r === this.newRowIndex) { this.draftSet(c, bytes); toDraft++; }
        else if (r < this.newRowIndex) changes.push({ r, c, value: bytes });
      }
    }
    if (toDraft) { this.render(); this.emitSelect(); }
    if (!changes.length) { if (toDraft) this.hooks.onInfo?.(tr('{0}を新しい行に入れました（行を離れると保存されます）', [what])); return; }
    const ok = await this.write(changes);
    if (ok) this.hooks.onInfo?.(changes.length > 1 ? tr('{0} セルに{1}を入れました', [changes.length, what]) : tr('{0}を入れました（{1}）', [what, fmtBytes(bytes.length)]));
  }

  /** 文字（TSV）を貼る。values（行×列の値）を渡したときはそれをそのまま貼る */
  async paste(text, values) {
    if (!this.source.editable) { this.hooks.onReadonlyEdit?.(); return; }
    const data = values ?? parseTsv(text);
    if (!data.length) return;
    let { r0, c0, r1, c1 } = this.range();
    // 1セルのコピーを範囲に貼ると全体に繰り返す
    const single = data.length === 1 && data[0].length === 1 && (r1 > r0 || c1 > c0);
    const changes = [];
    const rows = single ? r1 - r0 + 1 : data.length;
    const cols = single ? c1 - c0 + 1 : Math.max(...data.map((d) => d.length));
    if (!single && c0 + cols > this.cols.length) {
      this.hooks.onError?.(new Error(tr('貼り付けるデータが {0} 列あり、右端からはみ出します', [cols])));
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
        if (v !== undefined && !changes.some((ch) => ch.r === this.newRowIndex && ch.c === c)) changes.push({ r: this.newRowIndex, c, value: draftToValue(v) });
      });
    }
    const ok = await this.write(changes);
    if (ok && draft) { this.draft = null; this.render(); }
    if (ok) {
      this.cur = { r: r0, c: c0 };
      this.ext = { r: Math.min(r0 + rows - 1, this.totalRows - 1), c: c0 + cols - 1 };
      this.render(); this.emitSelect();
      if (changes.length > 1) this.hooks.onInfo?.(tr('{0} セルを貼り付けました', [changes.length]));
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
          if (had) this.hooks.onInfo?.(tr('新しい行の入力を取り消しました'));
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

/**
 * セルごとの書式の定義。書式を足すときはここ（と main.js の FORMAT_UI）に1つ足す。
 * store: localStorage の接頭辞 / def: 何もしないときに効いているか / can: そのセルに付けられるか
 */
export const CELL_FORMATS = {
  // テキストの折り返し：空でない文字列
  wrap: { store: 'wrapc:', def: false, can: (g, v) => typeof v === 'string' && v !== '' },
  // URL を画像で表示：値全体が1つの画像の URL の文字列
  image: { store: 'imgc:', def: false, can: (g, v) => imageUrlOf(v) != null },
  // プレビューの付加情報（URL・BLOB の種類と大きさなど）を出す：プレビューを出しているセル。既定は出す
  info: { store: 'infoc:', def: true, can: (g, v, r, row, c) => g.hasPreview(v, r, row, c) },
};

/** 値全体が1つの画像の URL（http(s) か data:image/）ならその URL。前後の空白は無視する */
export function imageUrlOf(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // data: の URL は中に空白があってもブラウザが読める（SVG を直接書いたものなど）
  if (/^data:image\//i.test(s)) return s;
  if (/\s/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try { new URL(s); return s; } catch { return null; }
}

/**
 * セルのプレビュー（BLOB と URL で共通）：サムネイルと付加情報の文字。
 * showInfo が false なら文字は出さない（画像が読めなかったときだけ文字に戻す）。
 * 置き場所（右・絵の下・絵に重ねる）は placeInfo() で決める
 */
function preview(cell, src, text, external, showInfo) {
  const img = thumb(src, external);
  if (!img) { cell.append(text); return; }
  const info = el('span.gc-info', text);
  cell.append(img);
  if (showInfo) cell.append(info);
  img.addEventListener('error', () => { if (!showInfo) cell.append(text); }, { once: true });
  if (!showInfo) return;
  if (img.complete && img.naturalWidth) placeInfo(cell, img, info);
  else img.addEventListener('load', () => placeInfo(cell, img, info), { once: true });
}
const INFO_ROOM = 40; // 画像の横に付加情報の文字を置くのに要る幅
const INFO_LINE = 16; // 付加情報の文字1行の高さ

/**
 * 付加情報の置き場所を決める。判定は object-fit: contain で縮めたあとの、実際に描かれている絵の位置で行う。
 * 右に余白がある → そのまま右に並べる / 絵の下に1行分の空きがある → 絵のすぐ下（.info-below）/
 * どちらもない → 絵の下の方に黒縁取りの白文字で重ねる（.info-over。動画の字幕と同じく、どんな絵でも読める）
 */
function placeInfo(cell, img, info) {
  requestAnimationFrame(() => {
    if (!img.isConnected || !img.naturalWidth) return;
    const W = img.offsetWidth, H = img.offsetHeight;
    const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    const x = img.offsetLeft + (W - w) / 2, y = img.offsetTop + (H - h) / 2;
    cell.classList.remove('info-below', 'info-over');
    if (cell.clientWidth - (x + w) >= INFO_ROOM) { info.removeAttribute('style'); return; }
    const below = cell.clientHeight - (y + h) >= INFO_LINE;
    Object.assign(info.style, { left: x + 'px', width: w + 'px', top: (below ? y + h : y + h - INFO_LINE) + 'px' });
    cell.classList.add(below ? 'info-below' : 'info-over');
  });
}


/** セルのサムネイル（BLOB と URL で共通）。大きさは CSS でセルの高さに合わせる。読めなければ消して文字だけにする */
function thumb(src, external = false) {
  if (external && failedImages.has(src)) return '';
  const img = el('img.blob-thumb', { src, alt: '', draggable: false });
  // lazy にはしない：描くのは見えている行の前後だけで、表に掛けた CSS の zoom と合わさると読み始めないことがある
  if (external) img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => { if (external) failedImages.add(src); img.remove(); }, { once: true });
  return img;
}
// 読めなかった URL（描画のたびに読み直さない。ページを開き直せば試し直す）
const failedImages = new Set();


/** 下書きの値を INSERT に渡す形へ（文字はフォームとして解釈し、BLOB はそのまま） */
function draftToValue(v) {
  if (v === undefined) return undefined;
  return v instanceof Uint8Array ? v : form(v);
}

/** コピーした範囲の HTML（ほかの表計算ソフトにも表として貼れる。data-sqlite-sheet は自分のコピーの目印） */
function toHtmlTable(values, id) {
  const esc = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const td = (v) => `<td>${v == null || v instanceof Uint8Array ? '' : esc(String(v))}</td>`;
  return `<table data-sqlite-sheet="${id}">${values.map((vals) => `<tr>${vals.map(td).join('')}</tr>`).join('')}</table>`;
}

/** 画像のバイト列を PNG の Blob に（PNG 以外は canvas に描いて変換する） */
async function toPng(bytes, mime) {
  if (mime === 'image/png') return new Blob([bytes], { type: 'image/png' });
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 300; c.height = img.naturalHeight || 150;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error(tr('PNG に変換できませんでした')))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

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
