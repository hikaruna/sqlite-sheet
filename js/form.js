// 詳細カード：シートの1行を1枚のカードにして、列を縦に並べて見る・直す（右側のパネルに入れる）
// 表（Grid）を裏で使う。行の読み込み・書き込み・元に戻す・保護・下書きの行は Grid のものをそのまま使い、
// カードは grid.cur.r の行を見せるだけ。表・ギャラリーで選んだ行がそのまま出る
// 既にある行は、まず読むだけ（show）で見せ、「編集」で入力欄（edit）にする。新しい行ははじめから edit
// 直した値はカードの中だけで持ち（edits）、「保存」でまとめて1回で書く。保存せずに離れるときは聞く
import { t as tr } from './i18n.js';
import { el, fmtBytes, modKey, isMac, icon, choiceDialog, menu } from './ui.js';
import { sniff } from './blob.js';
import { formText } from './sources.js';
import { NULL_LABEL } from './grid.js';

// 新しい行の下書きで、NULL・空文字をはっきり入れるときの式（何も入れなければ DEFAULT）。欄にもこの式のまま出る
const DRAFT_NULL = '=NULL';
const DRAFT_EMPTY = "=''";

export class FormView {
  /**
   * hooks: {
   *   fkPick(r, c, anchor): 参照先から選ぶ
   *   blobMenu(r, c, anchor): BLOB の操作（表示・読み込み・保存・NULL）
   *   deleteRow(): 今の行を削除
   *   onError(err): 知らせる
   *   onUndo(), onRedo(): 元に戻す・やり直す
   *   onClose(): パネルを閉じる
   * }
   */
  constructor(host, grid, hooks = {}) {
    this.host = host;
    this.grid = grid;
    this.hooks = hooks;
    this.urls = [];
    this.built = null; // 今の欄を作った行 { r, id }
    this.fields = [];  // 列ごとの { input, box, note }
    this.mode = 'show';  // 'show'（読むだけ）か 'edit'（入力欄）。modeId の行についての状態
    this.modeId = null;
    this.edits = new Map(); // まだ保存していない値：列 → { text }（打った文字）か { value }（NULL・BLOB・参照先から選んだ値）
    this.root = el('div.form-view', { tabIndex: -1, on: { keydown: (e) => this.onKey(e) } });
    host.replaceChildren(this.root);
  }

  destroy() {
    this.relatedBox?._cleanup?.();
    this.releaseUrls();
    this.root.remove();
  }

  /** Related のカードを描き直す（show のときだけ） */
  refreshRelated() {
    if (this.relatedBox && this.mode === 'show' && !this.isNew) this.hooks.renderRelated(this, this.relatedBox);
  }

  get r() { return this.grid.cur.r; }
  get isNew() { return this.r === this.grid.newRowIndex; }

  get dirtyAny() { return this.edits.size > 0; }

  /** カードに見せる値：保存していない値があればそれ */
  shownValue(c) {
    const e = this.edits.get(c);
    if (!e) return this.valueAt(c);
    return 'value' in e ? e.value : e.text;
  }

  releaseUrls() { for (const u of this.urls) URL.revokeObjectURL(u); this.urls = []; }

  /** 表示中の行の値。新しい行は下書き（フォームの文字列）、それ以外は読み込んだ値 */
  valueAt(c) {
    if (this.isNew) return this.grid.draft?.values[c];
    return this.grid.rowAt(this.r)?.values[c];
  }

  /** 表の選択が変わった・書き込みが終わったときに呼ぶ。同じ行なら値だけ入れ替え、入力中の欄は触らない */
  async render() {
    const g = this.grid;
    // 行が1つもなく追加もできないとき
    if (!g.rowCount && !g.canInsert) { this.built = null; this.root.replaceChildren(el('div.form-empty.muted', tr('行がありません'))); return; }
    // 行がなければ新しい行の下書きを開く
    if (!g.rowCount && !this.isNew) { g.cur = { r: g.newRowIndex, c: 0 }; g.ext = { ...g.cur }; }
    if (this.isNew) g.openDraft();
    else if (!g.rowAt(this.r)) {
      const r = this.r;
      await g.rowsBetween(r, r);
      if (this.r !== r || this.grid !== g) return; // 読み込む間に移った
    }
    const row = this.isNew ? null : g.rowAt(this.r);
    const id = this.isNew ? 'new' : JSON.stringify(row?.key ?? null);
    // 別の行を開いたら show から（新しい行は edit）
    if (this.modeId !== id) {
      const moved = this.modeId != null;
      this.mode = this.isNew ? 'edit' : 'show'; this.modeId = id;
      if (moved) this.hooks.onRowChange?.();
    }
    if (this.built && this.built.r === this.r && this.built.id === id && this.built.mode === this.mode) this.refresh();
    else this.build(id);
  }

  build(id) {
    const g = this.grid;
    const focused = this.fields.findIndex((f) => f.input && f.input === document.activeElement);
    this.releaseUrls();
    const show = this.mode === 'show';
    this.built = { r: this.r, id, mode: this.mode };
    this.edits = new Map();
    this.fields = g.cols.map((col, c) => (show ? this.showField(col, c) : this.field(col, c)));
    const total = g.rowCount;
    const canEdit = g.cols.some((col, c) => g.canEdit(this.r, c));
    const expanded = !!this.hooks.expanded?.();
    // タイトル：行ラベル（広げた表示では「テーブル名 > 行ラベル」）
    this.titleEl = el('span.form-title');
    const close = el('button.btn.sm.form-close', { title: tr('閉じる（Esc）'), 'aria-label': tr('閉じる'), on: { click: () => this.hooks.onClose?.() } },
      el('span.fc-pc', '✕'), el('span.fc-sp', icon('back')));
    // ‹ › は show だけ（スマホの show では出さない）
    const steps = show && this.hooks.steps !== false ? [
      el('span.form-sep'),
      el('button.btn.sm.form-step', { title: tr('前の行（Alt+←）'), disabled: this.r <= 0, on: { click: () => this.go(this.r - 1) } }, '‹'),
      el('button.btn.sm.form-step', { title: tr('次の行（Alt+→）'), disabled: this.r >= total - 1, on: { click: () => this.go(this.r + 1) } }, '›'),
    ] : [];
    // PC の show：広げる ⇔ 並べて表示に戻る
    const expandBtn = show && this.hooks.onExpand
      ? el('button.btn.sm.form-expand', { title: expanded ? tr('並べて表示に戻す') : tr('広げて表示'), 'aria-label': expanded ? tr('並べて表示に戻す') : tr('広げて表示'),
        on: { click: () => this.hooks.onExpand(!expanded) } }, expanded ? '⤡' : '⤢')
      : null;
    // 参考（AppSheet）の並び：タイトル ／ 削除 編集 ｜ ‹ › ⤢ ✕（✕ は PC では右端、スマホでは左端の ←。CSS の order で入れ替える）
    const nav = el('div.form-nav', { class: (show ? 'is-show' : 'is-edit') + (expanded ? ' is-expanded' : '') },
      close,
      this.titleEl,
      el('span.grow'),
      show
        ? [this.hooks.deleteRow ? el('button.btn.sm.danger-text.form-del', { title: tr('削除'), 'aria-label': tr('削除'), on: { click: () => this.hooks.deleteRow() } },
            el('span.fd-pc', tr('削除')), el('span.fd-sp', icon('trash'))) : null,
          canEdit ? el('button.btn.sm.primary.form-edit', { on: { click: () => this.setMode('edit') } }, tr('編集')) : null,
          ...steps,
          expandBtn]
        : this.isNew
        ? [total || this.hooks.onCancelNew ? el('button.btn.sm', { on: { click: () => this.cancelNew() } }, tr('やめる')) : null,
          el('button.btn.sm.primary', { title: tr('保存（{0}）', [isMac ? '⌘S' : 'Ctrl+S']), on: { click: () => this.saveNew() } }, tr('保存'))]
        : [el('button.btn.sm', { on: { click: () => this.cancelEdit() } }, tr('やめる')),
          el('button.btn.sm.primary', { title: tr('保存（{0}）', [isMac ? '⌘S' : 'Ctrl+S']), on: { click: () => this.save() } }, tr('保存'))],
    );
    // スマホの show：編集は右下の丸いボタン
    const fab = show && canEdit ? el('button.form-fab', { title: tr('編集'), 'aria-label': tr('編集'), on: { click: () => this.setMode('edit') } }, '✎') : null;
    // show では、この行を外部キーで指している行（Related）を列の後ろに並べる
    this.relatedBox?._cleanup?.();
    this.relatedBox = show && this.hooks.renderRelated ? el('div.form-related') : null;
    const body = el('div.form-body', el('div.form-fields', this.fields.map((f) => f.box)), this.relatedBox);
    this.root.replaceChildren(el('div.form-card', { class: show ? 'form-show' : '' }, nav, body), ...(fab ? [fab] : []));
    this.refreshRelated();
    this.refresh();
    this.updateSave();
    this.updateTitle();
    const f = this.fields[focused];
    if (f?.input && !f.input.disabled) f.input.focus({ preventScroll: true });
  }

  /** 行ラベル（シートのラベル列の値。外部キーなら参照先の名前）。新しい行は「新しい行」 */
  rowLabel() {
    if (this.isNew) return tr('新しい行');
    const g = this.grid, row = g.rowAt(this.r);
    const c = g.cols.findIndex((col) => col.name === this.hooks.labelColumn);
    if (c < 0 || !row) return '';
    const v = row.labels?.[c] ?? row.values[c];
    // NULL は表のセルと同じく「NULL」と出す（空文字は空のまま）
    return v == null ? NULL_LABEL : v instanceof Uint8Array ? 'BLOB' : String(v);
  }

  updateTitle() {
    if (!this.titleEl) return;
    const label = this.rowLabel();
    // 広げた表示は「テーブル名 > たどってきた行 > 行ラベル」。行ラベルが空でも > は残す。途中の行は押すとそこへ戻る
    if (this.hooks.expanded?.() && this.mode === 'show') {
      const crumbs = this.hooks.crumbs?.() ?? [{ text: this.hooks.sheetName }];
      this.titleEl.replaceChildren(...crumbs.flatMap((x) => [
        x.go ? el('button.form-crumb', { on: { click: x.go } }, x.text) : el('span', x.text), el('span.form-crumb-sep', ' > ')]), el('span', label));
    } else this.titleEl.textContent = label;
    this.titleEl.title = this.titleEl.textContent;
  }

  /** show の列1つ：名前と値（読むだけ） */
  showField(col, c) {
    const value = el('div.form-value');
    const box = el('div.form-field', el('div.form-label', el('span.form-name', col.name)), value);
    return { box, value, note: el('div') };
  }

  /** show の値を入れる（表のセルと同じ見せ方：NULL は薄く、空文字は何も出さない、外部キーは参照先の名前） */
  fillShow() {
    const g = this.grid, row = g.rowAt(this.r);
    this.fields.forEach((f, c) => {
      const v = row?.values[c];
      f.value.classList.toggle('is-null', v == null);
      if (v == null) { f.value.textContent = NULL_LABEL; return; }
      if (v instanceof Uint8Array) {
        const btn = el('button.form-blob', { on: { click: () => this.hooks.viewBlob?.(this.r, c) } });
        this.fillBlob(btn, v);
        f.value.replaceChildren(btn);
        return;
      }
      const label = row?.labels?.[c];
      f.value.textContent = label != null ? String(label) : String(v);
      // 外部キー：参照先の行の show を開く「›」
      const fk = g.cols[c].fk;
      if (fk && this.hooks.onRef) f.value.append(el('button.form-ref', { title: tr('参照先を開く（{0}）', [fk.table]), 'aria-label': tr('参照先を開く（{0}）', [fk.table]), on: { click: () => this.hooks.onRef(fk, v) } }, icon('ref')));
    });
  }

  /** show と edit を切り替える。c を渡せば edit でその欄へ */
  async setMode(mode, c) {
    if (mode === this.mode) return;
    if (mode === 'show' && !(await this.confirmLeave())) return;
    this.mode = mode;
    this.built = null;
    await this.render();
    this.focus(c);
  }

  /** edit の「やめる」：直した値を捨てて show へ（新しい行は下書きを捨てる） */
  async cancelEdit() {
    if (this.isNew) return this.cancelNew();
    this.discard();
    await this.setMode('show');
  }

  /** 列1つの欄（名前・型の印・入力欄・補足） */
  field(col, c) {
    const g = this.grid;
    const editable = this.isNew ? g.canInsert && !col.readonly : g.canEdit(this.r, c);
    const badges = el('span.form-badges', (col.badges || []).map((b) => el('span.gh-badge', { class: b.cls || '', title: b.title || '' }, b.icon ? icon(b.icon) : b.text)));
    const label = el('label.form-label', el('span.form-name', col.name), badges);
    const note = el('div.form-note');
    const box = el('div.form-field', label);
    const f = { box, note, input: null, preview: null, editable };
    const blobCol = col.type && /BLOB/i.test(col.type);
    if (blobCol) {
      f.preview = el('button.form-blob', { disabled: !editable && !(this.valueAt(c) instanceof Uint8Array), on: { click: (e) => this.hooks.blobMenu?.(this.r, c, e.currentTarget) } });
      box.append(f.preview);
    } else {
      // Enter は改行（次の欄へは Tab）。どの欄も中身に合わせて高さが伸びる
      const input = el('textarea.input.form-input', {
        disabled: !editable, spellcheck: false, autocomplete: 'off', rows: 1,
        on: {
          input: () => { this.fit(input); if (this.isNew) this.commit(c); else this.edited(c); },
          keydown: (e) => {
            // Esc でこの欄を元の値に戻す（直していなければパネルの Esc へ）
            if (e.key === 'Escape' && this.dirty(c)) { e.preventDefault(); e.stopPropagation(); this.resetField(c); }
            // 打ちかけていなければ、Ctrl+Z / Ctrl+Y はアプリの元に戻す・やり直す（打ちかけなら入力欄の取り消し）
            const k = e.key.toLowerCase();
            if (modKey(e) && (k === 'z' || k === 'y') && !this.dirty(c)) {
              e.preventDefault();
              if (k === 'y' || e.shiftKey) this.hooks.onRedo?.(); else this.hooks.onUndo?.();
            }
          },
        },
      });
      label.htmlFor = input.id = `form-f${c}`;
      f.input = input;
      const row = el('div.form-input-row', input);
      if (col.fk && editable) row.append(el('button.btn.sm', { title: tr('参照先から選ぶ'), on: { click: (e) => this.hooks.fkPick?.(this.r, c, e.currentTarget) } }, tr('選ぶ ▾')));
      // ∅：NULL・空文字・既定値（新しい行）／元の値（既にある行）を選ぶ
      if (editable && !col.auto) row.append(el('button.btn.sm.form-null', { title: tr('NULL・空文字にする'), on: { click: (e) => this.nullMenu(c, e.currentTarget) } }, '∅'));
      box.append(row);
    }
    box.append(note);
    return f;
  }

  /** 欄に今の値を入れる（入力中の欄はそのまま） */
  refresh() {
    this.updateTitle();
    if (this.mode === 'show') { this.releaseUrls(); this.fillShow(); return; }
    const g = this.grid;
    const row = this.isNew ? null : g.rowAt(this.r);
    this.fields.forEach((f, c) => {
      const col = g.cols[c];
      const v = this.valueAt(c);
      const edit = this.edits.get(c);
      f.box.classList.toggle('pending', !!edit);
      f.box.classList.remove('invalid');
      const err = this.isNew ? g.draft?.errors?.[c] : edit?.failed ? tr('保存できませんでした。値を直してください') : null;
      if (err) { f.box.classList.add('invalid'); f.note.textContent = err; }
      if (f.preview) { this.fillBlob(f.preview, this.shownValue(c)); return; }
      if (edit && 'value' in edit) {
        // 参照先から選んだ値・NULL：欄の文字を入れ替える（保存はまだ）
        f.input.value = f.shown = edit.value === null ? '' : formText(edit.value);
        f.input.placeholder = edit.value === null ? NULL_LABEL : '';
        f.input.classList.toggle('is-null', edit.value === null);
        this.fit(f.input);
      } else if (!edit && (f.shown == null || f.input !== document.activeElement || f.input.value === f.shown)) {
        f.input.value = f.shown = this.shownText(c);
        // 薄い字は表のセルの編集と同じ：新しい行は INSERT で入るもの、既にある行は NULL の印
        f.touched = false;
        f.input.placeholder = this.isNew ? (v === undefined ? g.placeholderFor(c) : '') : g.nullHint(c, v === null, false);
        f.input.classList.toggle('is-null', !this.isNew && v === null);
        this.fit(f.input);
      }
      // 外部キーは参照先の名前、ほかは書けない理由を添える
      const label = row?.labels?.[c];
      if (!err) f.note.textContent = col.fk ? (edit ? edit.label : label) != null ? `→ ${edit ? edit.label : label}` : `→ ${col.fk.table}.${col.fk.refCol}`
        : !f.editable && col.readonly ? tr('自動で決まる列です') : '';
      f.note.classList.toggle('fk-note', !!col.fk && !err);
    });
  }

  fillBlob(btn, v) {
    if (!(v instanceof Uint8Array)) { btn.replaceChildren(el('span.muted', v == null ? NULL_LABEL : String(v))); return; }
    const k = sniff(v);
    const text = `${v.length ? k.label : 'BLOB'} ${fmtBytes(v.length)}`;
    if (k.mime.startsWith('image/') && v.length) {
      const url = URL.createObjectURL(new Blob([v], { type: k.mime }));
      this.urls.push(url);
      btn.replaceChildren(el('img', { src: url, alt: '' }), el('span.muted', text));
    } else btn.replaceChildren(el('span', text));
  }

  /** 新しい行：欄の文字を下書きに入れる（保存は「追加」で） */
  async commit(c) {
    const g = this.grid, f = this.fields[c];
    if (!f?.input || !f.editable || !this.isNew) return;
    const text = f.input.value;
    g.draftText(c, text);
    f.shown = text;
    f.box.classList.remove('invalid'); f.note.textContent = '';
  }

  /** 欄に打った：元の値と違えば、保存していない値として持つ */
  edited(c) {
    if (this.isNew) return;
    const f = this.fields[c], g = this.grid;
    if (f.input.value !== '') f.touched = true;
    const opts = { start: this.shownText(c), isNull: this.valueAt(c) === null, touched: !!f.touched };
    if (g.textToValue(c, f.input.value, opts) === undefined) this.edits.delete(c);
    else this.edits.set(c, { text: f.input.value, touched: opts.touched });
    f.input.placeholder = g.nullHint(c, opts.isNull, opts.touched);
    f.box.classList.toggle('pending', this.edits.has(c));
    f.box.classList.remove('invalid');
    this.updateSave();
  }

  /** NULL・BLOB・参照先から選んだ値を、保存していない値として入れる */
  async stage(c, value, label) {
    if (this.isNew) return;
    if (this.mode === 'show') await this.setMode('edit', c);
    this.edits.set(c, { value, label });
    this.refresh();
    this.updateSave();
  }

  /** ∅ のメニュー：NULL・空文字にする。新しい行は既定値に、既にある行は元の値に戻せる */
  nullMenu(c, anchor) {
    const g = this.grid, col = g.cols[c];
    const set = (draft, value) => {
      if (this.isNew) { g.draftSet(c, draft); const f = this.fields[c]; f.shown = null; this.refresh(); }
      else this.stage(c, value);
      this.fields[c]?.input?.focus();
    };
    menu(anchor, [
      this.isNew
        ? { label: tr('既定値に戻す'), kbd: g.placeholderFor(c) || '', action: () => set(undefined) }
        : { label: tr('元の値に戻す'), disabled: !this.dirty(c), action: () => this.resetField(c) },
      { label: 'NULL', disabled: !!col.notnull, action: () => set(DRAFT_NULL, null) },
      { label: tr('空文字'), action: () => set(DRAFT_EMPTY, '') },
    ]);
  }

  updateSave() {
    this.host.classList.toggle('dirty', this.dirtyAny);
  }

  fit(input) {
    if (!input?.isConnected) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  }

  /** 保存していない値をまとめて1回で書く。書けたら true */
  async save() {
    if (this.isNew) return this.saveNew();
    if (!this.dirtyAny) return true;
    const g = this.grid, r = this.r, cells = [];
    for (const [c, e] of this.edits) {
      const v = this.valueAt(c);
      if ('value' in e) { if (e.value !== v) cells.push({ r, c, value: e.value }); continue; }
      // 打った文字は表のセルと同じ決まりで値にする
      const value = g.textToValue(c, e.text, { start: this.shownText(c), isNull: v === null, touched: e.touched });
      if (value !== undefined) cells.push({ r, c, value });
    }
    if (!cells.length) { this.discard(); return true; }
    const edits = this.edits;
    const ok = await g.write(cells, { reopen: false });
    if (this.edits !== edits) return ok; // 書いている間に作り直した
    if (!ok) {
      for (const e of edits.values()) e.failed = true;
      this.refresh();
      return false;
    }
    this.discard(); // 書いた値で入れ直す
    await this.setMode('show');
    this.hooks.onChanged?.();
    return true;
  }

  /** 保存していない値を捨てて、元の値に戻す */
  discard() {
    this.edits = new Map();
    for (const f of this.fields) if (f.input) f.shown = null;
    this.refresh();
    this.updateSave();
  }

  /** 別の行・別の見方へ移ってよいか。保存していない値があれば、保存するか聞く */
  async confirmLeave() {
    await this.commitFocused();
    // 新しい行は、何か入れていれば聞く
    const dirty = this.isNew ? this.grid.hasDraft : this.dirtyAny;
    if (!dirty) return true;
    const ans = await choiceDialog({
      title: this.isNew ? tr('新しい行を保存しますか？') : tr('この行の変更を保存しますか？'),
      body: this.isNew ? tr('入力した値はまだ保存されていません。') : tr('保存していない変更があります。'),
      choices: [
        { label: tr('戻る'), value: 'back' },
        { label: tr('保存しない'), value: 'discard', danger: true },
        { label: tr('保存する'), value: 'save', primary: true },
      ],
    });
    if (ans === 'save') return this.isNew ? this.saveNew({ stay: true }) : this.save();
    if (ans === 'discard') { if (this.isNew) this.grid.discardDraft(); else this.discard(); return true; }
    this.focus();
    return false;
  }

  /** 欄の文字が、保存されている値から変わっているか */
  dirty(c) {
    const f = this.fields[c];
    return this.edits.has(c) || (!!f?.input && f.input.value !== f.shown);
  }

  /** 欄に見せる文字（新しい行は下書きの文字、それ以外は値のフォームの文字） */
  shownText(c) {
    const v = this.valueAt(c);
    // NULL は空の欄に薄く NULL と見せる（=NULL の文字は入れない）
    if (this.isNew) return v instanceof Uint8Array ? '' : v ?? '';
    return v === null ? '' : formText(v);
  }

  resetField(c) {
    const f = this.fields[c];
    if (!f?.input) return;
    this.edits.delete(c);
    f.touched = false;
    f.input.value = f.shown = this.shownText(c);
    if (!this.isNew) f.input.placeholder = this.grid.nullHint(c, this.valueAt(c) === null, false);
    f.input.classList.toggle('is-null', !this.isNew && this.valueAt(c) === null);
    f.box.classList.remove('invalid', 'pending');
    this.fit(f.input);
    this.updateSave();
  }

  focusNext(c) {
    const next = this.fields.slice(c + 1).find((f) => f.input && !f.input.disabled);
    next?.input.focus();
  }

  /** 別の行へ。新しい行の下書きを残したまま離れるなら保存を試す（失敗したら留まる） */
  async go(r) {
    const g = this.grid;
    await this.commitFocused();
    if (!(await this.confirmLeave())) return;
    if (this.hooks.beforeMove && !(await this.hooks.beforeMove())) return;
    if (this.isNew && r !== g.newRowIndex && g.hasDraft) { if (!(await this.saveNew({ stay: true }))) return; }
    r = Math.max(0, Math.min(r, g.canInsert ? g.newRowIndex : g.rowCount - 1));
    // 「＋」の行には下書きを開いてからでないと移れない
    if (r === g.newRowIndex) g.openDraft();
    g.moveTo(r, g.cur.c);
    await this.render();
  }

  async commitFocused() {
    const c = this.fields.findIndex((f) => f.input && f.input === document.activeElement);
    if (c >= 0) await this.commit(c);
  }

  /** 新しい行を1回の INSERT で保存し、追加した行を表示する */
  async saveNew({ stay = false } = {}) {
    const g = this.grid;
    await this.commitFocused();
    if (!g.hasDraft) {
      // 何も入れていない：入力の要らない表ならそのまま1行足す
      if (!g.canInsertEmpty) { this.hooks.onError?.(new Error(tr('値を入れてから追加してください'))); return false; }
      await g.addRow();
      if (this.hooks.onSavedNew) { await this.hooks.onSavedNew(); return true; }
      await this.render();
      this.hooks.onChanged?.();
      return true;
    }
    const before = g.rowCount;
    const ok = await g.flushDraft();
    if (!ok) { this.built = null; await this.render(); return false; }
    // Related の「Add」：保存したら元のページへ戻る
    if (this.hooks.onSavedNew) { await this.hooks.onSavedNew(); return true; }
    this.hooks.onChanged?.();
    if (!stay) {
      // 並べ替えがなければ追加した行は末尾。並べ替え中は末尾とは限らないので、末尾の行を見せる
      g.moveTo(Math.max(0, Math.min(g.rowCount - 1, before)), g.cur.c);
      await this.render();
    }
    return true;
  }

  async cancelNew() {
    this.grid.discardDraft();
    if (this.hooks.onCancelNew) return this.hooks.onCancelNew();
    this.grid.moveTo(Math.max(0, this.grid.rowCount - 1), this.grid.cur.c);
    await this.render();
  }

  onKey(e) {
    // 欄の Esc は欄を元に戻す。欄の外の Esc でパネルを閉じる
    if (modKey(e) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); this.commitFocused().then(() => this.save()); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      // edit の Esc は show へ（新しい行は閉じる）。show の Esc で閉じる
      if (this.mode === 'edit' && !this.isNew) this.setMode('show'); else this.hooks.onClose?.();
      return;
    }
    // Alt+← / Alt+→ で前後の行へ（show だけ）
    if (!e.altKey || modKey(e) || this.mode !== 'show') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.r - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.r + 1); }
  }

  /** c を渡せばその列の欄、なければ最初に書ける欄へ */
  focus(c) {
    const f = this.fields[c]?.input && !this.fields[c].input.disabled ? this.fields[c] : this.fields.find((x) => x.input && !x.input.disabled);
    (f?.input || this.root).focus({ preventScroll: true });
  }
}
