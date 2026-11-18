// 右側の設計パネル：テーブルの列・キー・制約・インデックスを編集する
import { t as tr } from './i18n.js';
import { db, q } from './db-client.js';
import { el, confirmDialog, toast, menu } from './ui.js';
import { TYPES, FK_ACTIONS, createTableSql, migrationSql, columnDef, readTable, constantDefault } from './schema.js';
import { friendlyError, defaultToForm, formToDefault } from './sources.js';
import { txMarks } from './txmarks.js';
import { triggerDialog, triggerEvent } from './triggers.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const COLLATES = ['', 'BINARY', 'NOCASE', 'RTRIM'];
// 差分を見る列の項目
const COL_FIELDS = ['name', 'type', 'notnull', 'defaultSql', 'check', 'collate', 'generated'];

/**
 * host: パネル要素, model: readTable の結果
 * ctx: { tables: [名前], onApplied(newName), onClose(), focusCol }
 */
export class DesignPanel {
  constructor(host, model, ctx) {
    this.host = host;
    this.ctx = ctx;
    this.setModel(model);
    this.tab = ctx.tab || 'columns';
    this.expanded = new Set(ctx.focusCol ? [ctx.focusCol] : []);
    this.refCache = new Map();
    this.render();
    if (ctx.focusCol) {
      setTimeout(() => this.host.querySelector(`[data-col="${CSS.escape(ctx.focusCol)}"] input`)?.focus(), 0);
    }
  }

  setModel(model) {
    this.model = model;
    this.draft = clone(model);
    this.draft.columns.forEach((c) => { c.from = c.name; });
    this.draft.fks.forEach((f) => { f.onDelete ??= 'NO ACTION'; f.onUpdate ??= 'NO ACTION'; });
  }

  get dirty() {
    const strip = (m) => JSON.stringify({ ...m, columns: m.columns.map(({ from, pkOrder, ...c }) => c), indexes: null, triggers: null, sql: null, rowidAlias: null });
    return strip(this.draft) !== strip({ ...this.model, columns: this.model.columns.map((c) => ({ ...c, from: c.name })) });
  }

  // ---------- 未確定の変更の印 ----------
  // 変えた列・項目・節・タブに「未確定」の印（琥珀色の左の帯＋薄い色）を付ける。トランザクションでも同じ見た目を使う
  origOf(c) { return c.from == null ? null : this.model.columns.find((o) => o.name === c.from) ?? null; }

  /** 列の差分：{ state: 'new' | 'changed' | null, keys: {項目: 変わったか} } */
  diffCol(c) {
    const o = this.origOf(c);
    if (!o) return { state: 'new', keys: {} };
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const keys = {};
    for (const k of COL_FIELDS) keys[k] = !same(c[k], o[k]);
    keys.pk = this.draft.pk.includes(c.name) !== this.model.pk.includes(o.name);
    // 残った列どうしの並び順が変わったか
    const kept = this.draft.columns.filter((x) => this.origOf(x)).map((x) => x.from);
    const before = this.model.columns.map((x) => x.name).filter((n) => kept.includes(n));
    keys.order = kept.indexOf(c.from) !== before.indexOf(c.from);
    return { state: Object.values(keys).some(Boolean) ? 'changed' : null, keys };
  }

  /** 削除した元の列 */
  deletedCols() {
    const kept = new Set(this.draft.columns.map((c) => c.from).filter((n) => n != null));
    return this.model.columns.filter((o) => !kept.has(o.name));
  }

  /** キーと制約の節ごとに、変わったか */
  diffKeys() {
    const d = this.draft, m = this.model;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const fk = (f) => ({ ...f, onDelete: f.onDelete ?? 'NO ACTION', onUpdate: f.onUpdate ?? 'NO ACTION' });
    return {
      options: !same([d.strict, d.withoutRowid, d.autoincrement], [m.strict, m.withoutRowid, m.autoincrement]),
      pk: !same(d.pk, m.pk),
      uniques: !same(d.uniques, m.uniques),
      fks: !same(d.fks.map(fk), m.fks.map(fk)),
      checks: !same(d.checks, m.checks),
    };
  }

  /** 描き直さずに印だけ付け直す（入力中にフォーカスを失わないように）。未確定の変更の件数を返す */
  refreshMarks() {
    const d = this.draft;
    let count = 0, colsChanged = false;
    for (const row of this.host.querySelectorAll('.dp-col[data-i]')) {
      const c = d.columns[Number(row.dataset.i)];
      if (!c) continue;
      const { state, keys } = this.diffCol(c);
      row.classList.toggle('pending', !!state);
      const tag = row.querySelector('.pend-tag');
      if (tag) { tag.textContent = tr('新規'); tag.hidden = state !== 'new'; }
      for (const f of row.querySelectorAll('[data-k]')) f.classList.toggle('pend-field', state === 'changed' && !!keys[f.dataset.k]);
    }
    for (const c of d.columns) if (this.diffCol(c).state) { count++; colsChanged = true; }
    const deleted = this.deletedCols().length;
    count += deleted; if (deleted) colsChanged = true;
    const keys = this.diffKeys();
    for (const sec of this.host.querySelectorAll('.dp-sec[data-sec]')) sec.classList.toggle('pending', !!keys[sec.dataset.sec]);
    const keysChanged = Object.values(keys).filter(Boolean).length;
    count += keysChanged;
    const nameChanged = d.name !== this.model.name;
    if (nameChanged) count++;
    this.host.querySelector('.dp-name input')?.classList.toggle('pend-field', nameChanged);
    const tabs = { columns: colsChanged, keys: keysChanged > 0 };
    for (const t of this.host.querySelectorAll('.dp-tab[data-tab]')) t.classList.toggle('has-pending', !!tabs[t.dataset.tab]);
    return count;
  }

  focusColumn(name) {
    this.tab = 'columns';
    this.expanded.add(name);
    this.render();
    setTimeout(() => this.host.querySelector(`[data-col="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
  }

  // ---------- 描画 ----------
  render() {
    const d = this.draft;
    const tabs = [['columns', tr('列')], ['keys', tr('キーと制約')], ['indexes', tr('インデックス')], ['sql', 'SQL']];
    const prevScroll = this.host.querySelector('.dp-body')?.scrollTop ?? 0;
    const prevTab = this.renderedTab;
    this.renderedTab = this.tab;
    const body = { columns: () => this.renderColumns(), keys: () => this.renderKeys(), indexes: () => this.renderIndexes(), sql: () => this.renderSql() }[this.tab]();
    this.host.replaceChildren(
      el('div.dp-head',
        el('div.dp-title', tr('テーブルの設計')),
        el('button.icon-btn', { title: tr('閉じる'), on: { click: () => this.ctx.onClose() } }, '×')),
      el('label.dp-name', el('span', tr('テーブル名')),
        el('input.input', { value: d.name, spellcheck: false, on: { input: (e) => { d.name = e.target.value; this.updateFooter(); } } })),
      el('div.dp-tabs', tabs.map(([id, label]) => el('button.dp-tab', {
        class: this.tab === id ? 'on' : '', dataset: { tab: id },
        on: { click: () => { this.tab = id; this.render(); } },
      }, label))),
      el('div.dp-body', body),
      this.footer = el('div.dp-foot'),
    );
    if (prevTab === this.tab) this.host.querySelector('.dp-body').scrollTop = prevScroll;
    this.updateFooter();
  }

  updateFooter() {
    const f = this.footer;
    f.replaceChildren();
    const count = this.refreshMarks();
    if (!this.dirty) { f.append(el('span.muted', tr('変更はありません'))); f.classList.remove('dirty'); return; }
    f.classList.add('dirty');
    f.append(
      el('span', count ? tr('未確定の変更 {0} 件', [count]) : tr('未確定の変更があります')),
      el('span.grow'),
      el('button.btn', { on: { click: () => { this.removedKeys = new Map(); this.setModel(this.model); this.render(); } } }, tr('破棄')),
      el('button.btn.primary', { on: { click: () => this.apply() } }, tr('確認して適用…')),
    );
  }

  changed() { this.updateFooter(); }
  rerender() { this.render(); }

  // ---------- 列 ----------
  renderColumns() {
    const d = this.draft;
    const strictTypes = TYPES;
    const list = el('div.dp-cols');
    d.columns.forEach((c, i) => {
      const open = this.expanded.has(c.from ?? c._id);
      const isPk = d.pk.includes(c.name);
      const typeSel = el('select.input.type-sel', {
        dataset: { k: 'type' },
        on: { change: (e) => { c.type = e.target.value; if (c.dfltForm !== undefined) c.defaultSql = formToDefault(c.dfltForm, c.type); this.changed(); } },
      }, [...new Set([...(d.strict ? strictTypes : ['', ...strictTypes, 'NUMERIC']), ...(c.type ? [c.type] : [])])]
        .map((t) => el('option', { value: t, selected: (c.type || '') === t }, t || tr('（型なし）'))));
      const row = el('div.dp-col', { class: open ? 'open' : '', dataset: { col: c.from ?? '', i } },
        el('div.dp-col-main',
          el('button.icon-btn.sm', { title: tr('詳細'), on: { click: () => { const k = c.from ?? (c._id ??= Math.random()); open ? this.expanded.delete(k) : this.expanded.add(k); this.render(); } } }, open ? '▾' : '▸'),
          el('input.input.col-name', {
            value: c.name, spellcheck: false, placeholder: tr('列名'), dataset: { k: 'name' },
            on: {
              input: (e) => {
                const old = c.name; c.name = e.target.value;
                // キー・制約内の列名も追従
                const ren = (arr) => arr.map((n) => (n === old ? c.name : n));
                d.pk = ren(d.pk); d.uniques = d.uniques.map(ren); d.fks.forEach((f) => { f.cols = ren(f.cols); });
                this.changed();
              },
            },
          }),
          typeSel,
          el('span.pend-tag', { hidden: true }),
          el('label.chk', { title: tr('主キー（複数選ぶと複合主キー）'), dataset: { k: 'pk' } },
            el('input', { type: 'checkbox', checked: isPk, on: { change: (e) => { e.target.checked ? d.pk.push(c.name) : d.pk = d.pk.filter((n) => n !== c.name); this.render(); } } }), '🔑'),
          el('label.chk', { title: tr('NOT NULL（必須）'), dataset: { k: 'notnull' } },
            el('input', { type: 'checkbox', checked: c.notnull, on: { change: (e) => { c.notnull = e.target.checked; this.changed(); } } }), tr('必須')),
          el('button.icon-btn.sm', {
            title: tr('その他'), on: {
              click: (e) => menu(e.currentTarget, [
                { label: tr('上へ移動'), icon: '↑', disabled: i === 0, action: () => { d.columns.splice(i - 1, 0, d.columns.splice(i, 1)[0]); this.render(); } },
                { label: tr('下へ移動'), icon: '↓', disabled: i === d.columns.length - 1, action: () => { d.columns.splice(i + 1, 0, d.columns.splice(i, 1)[0]); this.render(); } },
                '-',
                { label: tr('列を削除'), icon: '🗑', danger: true, disabled: d.columns.length <= 1, action: () => this.removeColumn(i) },
              ], { align: 'end' }),
            },
          }, '⋯')),
        open ? el('div.dp-col-detail',
          // セルのフォームと同じ書き方。触っていなければ元の DEFAULT 句をそのまま保つ
          field(tr('既定値（DEFAULT）'), el('input.input.mono', {
            value: c.dfltForm ?? defaultToForm(c.defaultSql), placeholder: tr('例: 0 / 文字列 / =CURRENT_TIMESTAMP'), spellcheck: false, disabled: !!c.generated, dataset: { k: 'defaultSql' },
            on: { input: (e) => { c.dfltForm = e.target.value; c.defaultSql = formToDefault(c.dfltForm, c.type); this.changed(); } },
          }), tr('普通に書けば値、= で始めると式（=CURRENT_TIMESTAMP、=\'\' など）。空なら既定値なし')),
          field(tr('CHECK 制約'), el('input.input.mono', {
            value: c.check ?? '', placeholder: tr('例: {0} > 0', [q(c.name)]), spellcheck: false, dataset: { k: 'check' },
            on: { input: (e) => { c.check = e.target.value || null; this.changed(); } },
          })),
          field(tr('照合順序（COLLATE）'), el('select.input', { dataset: { k: 'collate' }, on: { change: (e) => { c.collate = e.target.value || null; this.changed(); } } },
            COLLATES.map((x) => el('option', { value: x, selected: (c.collate || '') === x }, x || tr('既定'))))),
          field(tr('生成列（式から自動計算）'), el('div.row-gap',
            el('input.input.mono', {
              value: c.generated?.expr ?? '', placeholder: tr('例: price * qty'), spellcheck: false, dataset: { k: 'generated' },
              on: { input: (e) => { const v = e.target.value; c.generated = v ? { expr: v, stored: c.generated?.stored ?? false } : null; this.changed(); } },
            }),
            el('label.chk', el('input', { type: 'checkbox', checked: !!c.generated?.stored, on: { change: (e) => { if (c.generated) { c.generated.stored = e.target.checked; this.changed(); } } } }), tr('保存する'))),
          tr('空なら通常の列')),
        ) : null);
      list.append(row);
    });
    // 削除した列は、適用するまで取り消し線で残し、元に戻せるようにする
    for (const o of this.deletedCols()) {
      list.append(el('div.dp-col.pending.deleted',
        el('div.dp-col-main',
          el('span.col-name-del', o.name),
          el('span.muted.mono.sm', o.type || ''),
          el('span.pend-tag', tr('削除')),
          el('span.grow'),
          el('button.btn.sm', { title: tr('削除を取り消す'), on: { click: () => this.restoreColumn(o) } }, tr('↶ 戻す')))));
    }
    return [
      list,
      el('button.btn.add-row', { on: { click: () => this.addColumn() } }, tr('＋ 列を追加')),
      el('p.hint', tr('名前の変更や末尾への列追加は ALTER TABLE で、それ以外（型・キー・順序の変更など）はデータを保ったままテーブルを作り直して反映します。')),
    ];
  }

  addColumn() {
    const d = this.draft;
    let n = d.columns.length + 1, name;
    do { name = tr('列{0}', [n++]); } while (d.columns.some((c) => c.name === name));
    const col = { name, type: 'TEXT', notnull: false, defaultSql: null, check: null, collate: null, generated: null, from: null, _id: Math.random() };
    d.columns.push(col);
    this.expanded.add(col._id);
    this.render();
    const inputs = this.host.querySelectorAll('.col-name');
    inputs[inputs.length - 1]?.select();
  }

  removeColumn(i) {
    const d = this.draft;
    const [c] = d.columns.splice(i, 1);
    // 元からある列なら、戻すときのために列と、一緒に外れるキーを覚えておく
    if (c.from != null) {
      (this.removedKeys ??= new Map()).set(c.from, {
        col: c, pk: [...d.pk], uniques: d.uniques.filter((u) => u.includes(c.name)), fks: d.fks.filter((f) => f.cols.includes(c.name)),
      });
    }
    d.pk = d.pk.filter((n) => n !== c.name);
    d.uniques = d.uniques.map((u) => u.filter((n) => n !== c.name)).filter((u) => u.length);
    d.fks = d.fks.filter((f) => !f.cols.includes(c.name));
    this.render();
  }

  /** 削除した元の列を、元の位置（近く）に戻す。一緒に外れたキーも戻す */
  restoreColumn(o) {
    const d = this.draft;
    const saved = this.removedKeys?.get(o.name);
    const col = saved?.col ?? { ...clone(o), from: o.name };
    const at = Math.min(this.model.columns.findIndex((x) => x.name === o.name), d.columns.length);
    d.columns.splice(at, 0, col);
    if (saved) {
      if (saved.pk.includes(col.name)) d.pk = saved.pk.filter((n) => n === col.name || d.columns.some((c) => c.name === n));
      d.uniques.push(...saved.uniques); d.fks.push(...saved.fks);
      this.removedKeys.delete(o.name);
    }
    this.render();
  }

  // ---------- キーと制約 ----------
  renderKeys() {
    const d = this.draft;
    const names = d.columns.map((c) => c.name);
    const pkIsInt = d.pk.length === 1 && (d.columns.find((c) => c.name === d.pk[0])?.type || '').toUpperCase() === 'INTEGER';
    return [
      section({ title: tr('テーブルのオプション'), sec: 'options' },
        el('label.opt', el('input', { type: 'checkbox', checked: d.strict, on: { change: (e) => { d.strict = e.target.checked; this.render(); } } }),
          el('div', el('b', 'STRICT'), el('span.muted', tr('型の違う値を拒否します（INTEGER 列に文字列を入れない等）')))),
        el('label.opt', el('input', { type: 'checkbox', checked: d.withoutRowid, disabled: !d.pk.length && !d.withoutRowid, on: { change: (e) => { d.withoutRowid = e.target.checked; this.render(); } } }),
          el('div', el('b', 'WITHOUT ROWID'), el('span.muted', tr('主キーで行を格納します（主キー必須）')))),
        el('label.opt', el('input', { type: 'checkbox', checked: d.autoincrement, disabled: !pkIsInt || d.withoutRowid, on: { change: (e) => { d.autoincrement = e.target.checked; this.changed(); } } }),
          el('div', el('b', 'AUTOINCREMENT'), el('span.muted', tr('削除した番号を再利用しません（INTEGER の単一主キーのみ）'))))),
      section({ title: tr('主キー（PRIMARY KEY）'), sec: 'pk' },
        colsPicker(names, d.pk, (v) => { d.pk = v; this.render(); }, tr('主キーなし（rowid で識別）')),
        el('p.hint', tr('複数の列を選ぶと複合主キーになります。順序も意味を持ちます。'))),
      section({ title: tr('一意制約（UNIQUE）'), sec: 'uniques' },
        d.uniques.map((u, i) => el('div.con-row',
          colsPicker(names, u, (v) => { d.uniques[i] = v; this.changed(); this.render(); }),
          el('button.icon-btn.sm', { title: tr('削除'), on: { click: () => { d.uniques.splice(i, 1); this.render(); } } }, '×'))),
        el('button.btn.add-row', { on: { click: () => { d.uniques.push([]); this.render(); } } }, tr('＋ 一意制約を追加'))),
      section({ title: tr('外部キー（FOREIGN KEY）'), sec: 'fks' },
        d.fks.map((f, i) => this.renderFk(f, i, names)),
        el('button.btn.add-row', { on: { click: () => { d.fks.push({ cols: [], table: '', refCols: [], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }); this.render(); } } }, tr('＋ 外部キーを追加')),
        el('p.hint', tr('外部キー制約は常に有効（PRAGMA foreign_keys = ON）です。'))),
      section({ title: tr('CHECK 制約（表全体）'), sec: 'checks' },
        d.checks.map((ch, i) => el('div.con-row',
          el('input.input.mono', { value: ch, spellcheck: false, placeholder: tr('例: start_at <= end_at'), on: { input: (e) => { d.checks[i] = e.target.value; this.changed(); } } }),
          el('button.icon-btn.sm', { title: tr('削除'), on: { click: () => { d.checks.splice(i, 1); this.render(); } } }, '×'))),
        el('button.btn.add-row', { on: { click: () => { d.checks.push(''); this.render(); } } }, tr('＋ CHECK を追加'))),
    ];
  }

  renderFk(f, i, names) {
    const tables = this.ctx.tables;
    const refCols = this.refCache.get(f.table);
    if (f.table && !refCols) {
      readTable(f.table).then((m) => { this.refCache.set(f.table, m.columns.map((c) => c.name)); this.render(); }).catch(() => {});
    }
    const box = el('div.fk-box',
      el('div.fk-line', el('span.lbl', tr('この表の列')), colsPicker(names, f.cols, (v) => { f.cols = v; this.render(); })),
      el('div.fk-line', el('span.lbl', tr('参照先の表')),
        el('select.input', { on: { change: (e) => { f.table = e.target.value; f.refCols = []; this.render(); } } },
          el('option', { value: '' }, tr('選択…')),
          tables.map((t) => el('option', { value: t, selected: t === f.table }, t)))),
      f.table ? el('div.fk-line', el('span.lbl', tr('参照先の列')),
        colsPicker(refCols || [], f.refCols, (v) => { f.refCols = v; this.render(); }, tr('（参照先の主キー）'))) : null,
      el('div.fk-line', el('span.lbl', tr('削除時')),
        el('select.input', { on: { change: (e) => { f.onDelete = e.target.value; this.changed(); } } }, FK_ACTIONS.map((a) => el('option', { selected: a === f.onDelete }, a))),
        el('span.lbl', tr('更新時')),
        el('select.input', { on: { change: (e) => { f.onUpdate = e.target.value; this.changed(); } } }, FK_ACTIONS.map((a) => el('option', { selected: a === f.onUpdate }, a)))),
      f.refCols.length && f.refCols.length !== f.cols.length ? el('div.field-error', tr('列の数を参照先と揃えてください')) : null,
      el('button.icon-btn.sm.fk-del', { title: tr('外部キーを削除'), on: { click: () => { this.draft.fks.splice(i, 1); this.render(); } } }, '×'));
    return box;
  }

  // ---------- インデックス ----------
  renderIndexes() {
    const m = this.model;
    const names = m.columns.map((c) => c.name);
    const draft = this.newIndex ??= { cols: [], unique: false };
    return [
      section(tr('インデックス'),
        m.indexes.length ? m.indexes.map((ix) => el('div.idx-row',
          el('div', el('b', ix.name), ix.unique ? el('span.tag', 'UNIQUE') : null, el('div.muted.mono', ix.cols.join(', ') || ix.sql)),
          el('button.btn.sm.danger-text', { on: { click: () => this.dropIndex(ix) } }, tr('削除')))) : el('p.muted', tr('インデックスはありません')),
        el('p.hint', tr('主キー・一意制約が作る自動インデックスはここには出ません。'))),
      section(tr('インデックスを作成'),
        colsPicker(names, draft.cols, (v) => { draft.cols = v; this.render(); }),
        el('label.chk', el('input', { type: 'checkbox', checked: draft.unique, on: { change: (e) => { draft.unique = e.target.checked; } } }), 'UNIQUE'),
        el('button.btn.primary', { disabled: !draft.cols.length, on: { click: () => this.createIndex() } }, tr('作成')),
        el('p.hint', tr('インデックスはすぐに作成されます（テーブルの作り直しは不要）。'))),
      section(tr('トリガー'),
        m.triggers.filter((t) => !/^protect_\d+_/.test(t.name)).map((t) => el('div.idx-row', el('div', el('b', t.name)), el('span.muted.mono.sm', triggerEvent(t.sql)))),
        el('button.btn', { on: { click: () => triggerDialog(this.model.name, 't', () => this.reloadModel()) } }, tr('トリガーを管理…'))),
    ];
  }

  async createIndex() {
    const { cols, unique } = this.newIndex;
    const name = `idx_${this.model.name}_${cols.join('_')}`;
    try {
      await db.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(this.model.name)} (${cols.map(q).join(', ')})`);
      this.newIndex = null;
      toast(tr('インデックス {0} を作成しました', [name]));
      await this.reloadModel();
    } catch (e) { toast(friendlyError(e.message), 'error'); }
  }

  async dropIndex(ix) {
    if (!await confirmDialog({ title: tr('インデックス {0} を削除しますか？', [ix.name]), okLabel: tr('削除'), danger: true })) return;
    try { await db.exec(`DROP INDEX ${q(ix.name)}`); await this.reloadModel(); } catch (e) { toast(friendlyError(e.message), 'error'); }
  }

  async reloadModel() {
    this.setModel(await readTable(this.model.name));
    this.render();
    this.ctx.onApplied(this.model.name, { quiet: true });
  }

  // ---------- SQL ----------
  renderSql() {
    const m = this.model;
    const all = [m.sql, ...m.indexes.map((i) => i.sql), ...m.triggers.map((t) => t.sql)].filter(Boolean).join(';\n\n') + ';';
    const out = [section(tr('現在の定義'), el('pre.code', all))];
    if (this.dirty) {
      const plan = this.plan();
      out.push(section(tr('適用される SQL'), plan.error ? el('div.field-error', plan.error) : el('pre.code', plan.stmts.join(';\n') + ';')));
    }
    return out;
  }

  // ---------- 適用 ----------
  validate() {
    const d = this.draft;
    if (!d.name.trim()) return tr('テーブル名を入力してください');
    if (d.name !== this.model.name && this.ctx.tables.includes(d.name)) return tr('「{0}」は既にあります', [d.name]);
    const names = d.columns.map((c) => c.name.trim());
    if (names.some((n) => !n)) return tr('名前のない列があります');
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return tr('列名「{0}」が重複しています', [dup]);
    if (d.withoutRowid && !d.pk.length) return tr('WITHOUT ROWID には主キーが必要です');
    for (const f of d.fks) {
      if (!f.cols.length || !f.table) return tr('外部キーの列と参照先を指定してください');
      if (f.refCols.length && f.refCols.length !== f.cols.length) return tr('外部キーの列数が参照先と一致しません');
    }
    if (d.uniques.some((u) => !u.length)) return tr('列が空の一意制約があります');
    return null;
  }

  /** ALTER TABLE で済むか判定し、実行する SQL を作る */
  plan() {
    const err = this.validate();
    if (err) return { error: err };
    const o = this.model, d = this.draft;
    const fixedName = d.name !== o.name;
    const kept = d.columns.filter((c) => c.from);
    const appended = d.columns.filter((c) => !c.from);
    const orderSame = kept.every((c, i) => o.columns[i]?.name === c.from) && kept.length === o.columns.length
      && d.columns.slice(0, kept.length).every((c) => c.from);
    // 名前を元に戻した draft と元のモデルを比較
    const back = new Map(kept.map((c) => [c.name, c.from]));
    const unren = (arr) => arr.map((n) => back.get(n) ?? n);
    const norm = (m, cols) => JSON.stringify({
      cols: cols.map((c) => [c.type, c.notnull, c.defaultSql ?? null, c.check ?? null, c.collate ?? null, c.generated ?? null]),
      pk: m.pk, uq: m.uniques, fk: m.fks.map((f) => [f.cols, f.table, f.refCols, f.onDelete || 'NO ACTION', f.onUpdate || 'NO ACTION']),
      ch: m.checks, s: m.strict, w: m.withoutRowid, a: m.autoincrement,
    });
    const dBack = { ...d, pk: unren(d.pk), uniques: d.uniques.map(unren), fks: d.fks.filter((f) => !f.cols.some((c) => appended.some((a) => a.name === c))).map((f) => ({ ...f, cols: unren(f.cols) })) };
    const appendedFks = d.fks.filter((f) => f.cols.length === 1 && appended.some((a) => a.name === f.cols[0]));
    const appendedOk = appended.every((c) => !d.pk.includes(c.name) && !d.uniques.some((u) => u.includes(c.name))
      && !(c.notnull && (c.defaultSql == null || /^null$/i.test(c.defaultSql)) && !c.generated)
      && !(c.generated?.stored)
      && constantDefault(c.defaultSql) // 式や CURRENT_* の既定値は ALTER TABLE ADD COLUMN では足せない
      && !(appendedFks.some((f) => f.cols[0] === c.name) && c.defaultSql != null && !/^null$/i.test(c.defaultSql)));
    const multiFkOnAppended = d.fks.some((f) => f.cols.length > 1 && f.cols.some((n) => appended.some((a) => a.name === n)));
    const simple = orderSame && appendedOk && !multiFkOnAppended && norm(dBack, kept) === norm(o, o.columns);

    const stmts = [];
    if (fixedName) stmts.push(`ALTER TABLE ${q(o.name)} RENAME TO ${q(d.name)}`);
    if (simple) {
      for (const c of kept) if (c.name !== c.from) stmts.push(`ALTER TABLE ${q(d.name)} RENAME COLUMN ${q(c.from)} TO ${q(c.name)}`);
      for (const c of appended) {
        let def = columnDef(c, { pk: [], autoincrement: false });
        const fk = appendedFks.find((f) => f.cols[0] === c.name);
        if (fk) def += ` REFERENCES ${q(fk.table)}${fk.refCols.length ? ` (${q(fk.refCols[0])})` : ''}${fk.onDelete !== 'NO ACTION' ? ' ON DELETE ' + fk.onDelete : ''}${fk.onUpdate !== 'NO ACTION' ? ' ON UPDATE ' + fk.onUpdate : ''}`;
        stmts.push(`ALTER TABLE ${q(d.name)} ADD COLUMN ${def}`);
      }
      return { kind: 'alter', stmts, renameFirst: false };
    }
    const oldRenamed = { ...o, name: d.name };
    const rebuild = migrationSql(oldRenamed, d, o.name);
    return { kind: 'rebuild', stmts: [...stmts, ...rebuild], renameStmt: fixedName ? stmts[0] : null, rebuild };
  }

  async apply() {
    const p = this.plan();
    if (p.error) { toast(p.error, 'error'); return; }
    // 作り直しはトランザクション中にはできない。名前の変更だけ先に通ってしまわないよう、何もする前に止める
    if (p.kind !== 'alter' && db.inTx()) { toast(tr('この変更はテーブルを作り直すため、トランザクション中には適用できません。先に確定か取り消しをしてください'), 'error'); return; }
    const ok = await confirmDialog({
      title: tr('テーブルの変更を適用しますか？'),
      body: p.kind === 'rebuild'
        ? tr('この変更は ALTER TABLE では行えないため、新しい定義でテーブルを作り直し、データをコピーします。外部キー違反があれば元に戻します。')
        : tr('次の SQL を実行します。'),
      code: p.stmts.join(';\n') + ';',
      okLabel: tr('適用'),
    });
    if (!ok) return;
    try {
      // 名前だけの変更（表の名前・列名）は、元に戻せる形で main に任せる
      const renames = this.draft.columns.filter((c) => c.from != null && c.from !== c.name).map((c) => [c.from, c.name]);
      const renameOnly = p.kind === 'alter' && this.draft.columns.every((c) => c.from != null)
        && p.stmts.length === (this.draft.name !== this.model.name ? 1 : 0) + renames.length;
      if (renameOnly && this.ctx.onRename) {
        const name = this.draft.name;
        await this.ctx.onRename({ fromTable: this.model.name, toTable: name, cols: renames });
        toast(tr('テーブルを変更しました'), 'success');
        // 表の名前が変わると、main が新しいパネルに差し替える。差し替えられていなければ（列名だけ）自分で描き直す
        if (this.footer.isConnected) { this.setModel(await readTable(name)); this.render(); }
        return;
      }
      if (p.kind === 'alter') {
        await db.batch(p.stmts.map((sql) => ({ sql })));
        // トランザクション中の未確定の印を、表・列の名前の変更に追従させる
        txMarks.renameTable(this.model.name, this.draft.name);
        for (const c of this.draft.columns) if (c.from != null && c.from !== c.name) txMarks.renameColumn(this.draft.name, c.from, c.name);
      } else {
        if (p.renameStmt) await db.exec(p.renameStmt);
        await db.rebuild(p.rebuild.map((sql) => ({ sql })));
      }
      toast(tr('テーブルを変更しました'), 'success');
      this.setModel(await readTable(this.draft.name));
      this.render();
      this.ctx.onApplied(this.model.name);
    } catch (e) {
      toast(friendlyError(e.message), 'error');
    }
  }
}

// ---------- 部品 ----------
/** title は文字列か {title, sec}（sec は未確定の印を付けるための節の名前） */
function section(title, ...children) {
  const { title: t, sec } = typeof title === 'string' ? { title } : title;
  return el('section.dp-sec', { dataset: sec ? { sec } : {} }, el('h3', t), ...children);
}

function field(label, control, hint) {
  return el('label.field', el('span.field-label', label), control, hint ? el('span.field-hint', hint) : null);
}

/** 順序付きの複数列選択（チップ） */
function colsPicker(all, selected, onChange, emptyText = tr('列を選択')) {
  const box = el('div.cols-picker');
  if (!selected.length) box.append(el('span.muted.sm', emptyText));
  selected.forEach((n, i) => box.append(el('span.chip',
    selected.length > 1 ? el('span.chip-n', String(i + 1)) : null, n,
    el('button.chip-x', { title: tr('外す'), on: { click: () => onChange(selected.filter((_, j) => j !== i)) } }, '×'))));
  const rest = all.filter((n) => !selected.includes(n));
  if (rest.length) {
    box.append(el('button.chip-add', {
      on: { click: (e) => menu(e.currentTarget, rest.map((n) => ({ label: n, action: () => onChange([...selected, n]) }))) },
    }, tr('＋')));
  }
  return box;
}

export { createTableSql };
