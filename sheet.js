// シートの表示と編集
import { h, qid, lit, typedLit, isNumeric, inlineSql, formDialog, promptDialog, menuDialog, chooseDialog } from './ui.js';
import { getQueries, setQueries } from './db.js';

const ICON = { table: '▦', view: '◈', query: '🔍' };
const TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB'];
const OPS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL'];
const RID = '__sheet_rowid__';

// 列見出しのアイコン（SVG）。色は currentColor で CSS から決める
const SVG_FUNNEL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12l-4.5 5.5v4.5l-3 1.5v-6z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const SVG_KEBAB = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="8" cy="3.5" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/></svg>';
function svgButton(cls, title, svg, onclick) {
  const b = h('button', { class: cls, title, 'aria-label': title, onclick });
  b.innerHTML = svg;
  return b;
}

export class Sheets {
  constructor({ sqlite3, db, dbName, panel }) {
    this.sqlite3 = sqlite3;
    this.db = db;
    this.dbName = dbName;
    this.panel = panel;
    this.sheets = [];
    this.queries = [];
    this.states = new Map(); // key -> { sort, filters }
    this.currentKey = null;
    this.sel = null; // { r, c }
    this.editing = null;

    this.tabsEl = document.getElementById('tabs');
    this.gridEl = document.getElementById('grid-wrap');
    this.queryEl = document.getElementById('sheet-query');
    this.queryRunEl = document.getElementById('sheet-query-run');
    this.errEl = document.getElementById('sheet-error');

    this.queryRunEl.onclick = () => this.runQuerySheet();
    this.queryEl.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !this.queryEl.readOnly) { e.preventDefault(); this.runQuerySheet(); }
    };
    this.gridEl.onkeydown = (e) => this.onGridKey(e);
  }

  // ---------- 一覧の読み込み ----------
  async loadAll() {
    const list = this.db.selectObjects(
      "SELECT name, type, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND type IN ('table','view','virtual') ORDER BY type = 'view', name");
    this.queries = await getQueries(this.dbName);
    this.sheets = [
      ...list.map((t) => ({
        kind: t.type === 'view' ? 'view' : 'table', name: t.name, wr: !!t.wr, strict: !!t.strict, virtual: t.type === 'virtual',
        key: (t.type === 'view' ? 'view:' : 'table:') + t.name,
      })),
      ...this.queries.map((q) => ({ kind: 'query', name: q.name, id: q.id, sql: q.sql, key: 'query:' + q.id })),
    ];
    if (!this.sheets.some((s) => s.key === this.currentKey)) {
      this.currentKey = this.sheets.length ? this.sheets[0].key : null;
      this.sel = null;
    }
    this.renderTabs();
    this.loadCurrent();
  }

  get current() { return this.sheets.find((s) => s.key === this.currentKey) || null; }

  state(key = this.currentKey) {
    if (!this.states.has(key)) this.states.set(key, { sort: null, filters: new Map() });
    return this.states.get(key);
  }

  select(key) {
    this.currentKey = key;
    this.sel = null;
    this.renderTabs();
    this.loadCurrent();
  }

  // ---------- タブ ----------
  renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.sheets.map((s) => {
        const active = s.key === this.currentKey;
        return h('button', {
          class: 'tab' + (active ? ' active' : ''),
          title: active ? 'ダブルクリックで名前変更' : s.name,
          onclick: () => { if (!active) this.select(s.key); },
          ondblclick: () => this.renameSheet(s),
        },
        h('span', null, ICON[s.kind]),
        h('span', null, s.name),
        s.kind === 'table' && !s.strict ? h('span', { class: 'badge' }, '非STRICT') : null,
        active ? h('span', { class: 'tabdel', title: 'シートを削除', onclick: (e) => { e.stopPropagation(); this.deleteSheet(s); } }, '×') : null);
      }),
      h('button', { class: 'tab-add', title: 'シートを追加', onclick: () => this.addSheet() }, '＋'));
  }

  // ---------- データ読み込み ----------
  tableCols(name) {
    return this.db.selectObjects(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(?) WHERE hidden <> 1 ORDER BY cid`, [name]);
  }

  whereOrder(st, colType) {
    const conds = [];
    for (const [col, f] of st.filters) {
      if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') conds.push(`${qid(col)} ${f.op}`);
      else if (f.op.includes('LIKE')) conds.push(`${qid(col)} ${f.op} ${lit(f.val)}`);
      else conds.push(`${qid(col)} ${f.op} ${typedLit(f.val, colType(col))}`);
    }
    let s = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
    if (st.sort) s += ` ORDER BY ${qid(st.sort.col)} ${st.sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    return s;
  }

  viewSelect(name) {
    const sql = this.db.selectValue("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = ?", [name]) || '';
    const m = /^\s*CREATE\s+(?:TEMP|TEMPORARY\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?[\s\S]*?\bAS\b\s*/i.exec(sql);
    return m ? sql.slice(m[0].length) : sql;
  }

  loadCurrent() {
    this.errEl.textContent = '';
    this.cancelEdit(false);
    const s = this.current;
    this.data = null;
    if (!s) {
      this.queryEl.value = '';
      this.queryEl.readOnly = true;
      this.queryEl.classList.add('ro');
      this.queryRunEl.hidden = true;
      this.gridEl.replaceChildren(h('div', { class: 'center muted' }, '「＋」からシートを追加してください'));
      return;
    }
    const st = this.state();
    const editable = s.kind === 'table';
    this.queryEl.readOnly = s.kind !== 'query';
    this.queryEl.classList.toggle('ro', s.kind !== 'query');
    this.queryRunEl.hidden = s.kind !== 'query';

    let meta = null;
    let display, execSql;
    if (s.kind === 'table') {
      const cols = this.tableCols(s.name);
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      const ipk = !s.wr && pkCols.length === 1 && String(cols.find((c) => c.name === pkCols[0]).type).toUpperCase() === 'INTEGER' ? pkCols[0] : null;
      meta = { cols: new Map(cols.map((c) => [c.name, c])), pkCols, ipk, wr: s.wr, strict: s.strict };
      const wo = this.whereOrder(st, (c) => meta.cols.get(c)?.type);
      display = `SELECT * FROM ${qid(s.name)}${wo}`;
      execSql = s.wr ? display : `SELECT rowid AS ${RID}, * FROM ${qid(s.name)}${wo}`;
    } else {
      const base = s.kind === 'view' ? this.viewSelect(s.name) : s.sql;
      display = base;
      const wo = this.whereOrder(st, () => null);
      const inner = s.kind === 'view' ? qid(s.name) : `(${String(base).replace(/[\s;]+$/, '')})`;
      execSql = wo ? `SELECT * FROM ${inner}${wo}` : (s.kind === 'view' ? `SELECT * FROM ${qid(s.name)}` : base);
    }
    if (document.activeElement !== this.queryEl || s.kind !== 'query') this.queryEl.value = display;
    if (s.kind === 'query' && this.queryEl.dataset.key !== s.key) this.queryEl.value = display;
    this.queryEl.dataset.key = s.key;

    let columns = [];
    let rows = [];
    if (String(execSql).trim()) {
      try {
        const out = [];
        const names = [];
        this.db.exec({ sql: execSql, rowMode: 'array', resultRows: out, columnNames: names });
        columns = names;
        rows = out;
      } catch (e) {
        this.errEl.textContent = e.message;
      }
    }
    // 行の識別子
    let keyed;
    if (s.kind === 'table') {
      if (!s.wr) {
        columns = columns.slice(1);
        keyed = rows.map((r) => ({ key: [r[0]], vals: r.slice(1) }));
      } else {
        keyed = rows.map((r) => ({ key: meta.pkCols.map((pc) => r[columns.indexOf(pc)]), vals: r }));
      }
    } else {
      keyed = rows.map((r) => ({ key: null, vals: r }));
    }
    this.data = { sheet: s, meta, columns, rows: keyed, editable };
    this.renderGrid();
  }

  // ---------- グリッド ----------
  renderGrid() {
    const { sheet: s, meta, columns, rows, editable } = this.data;
    const st = this.state();
    const thead = h('tr', null, h('th', { class: 'rowhead' }, ''),
      columns.map((name, ci) => {
        const info = meta?.cols.get(name);
        const sorted = st.sort && st.sort.col === name;
        const filtered = st.filters.has(name);
        return h('th', null, h('div', { class: 'colhead' },
          h('span', { class: 'colname', title: 'クリックで並べ替え', onclick: () => this.cycleSort(name) },
            name, info?.nn ? ' *' : '', ' ', h('span', { class: 'coltype' }, info ? info.type : '')),
          sorted ? h('span', { class: 'sortmark' }, st.sort.dir === 'asc' ? '▲' : '▼') : null,
          svgButton('icon funnel' + (filtered ? ' on' : ''), filtered ? '絞り込み中（クリックで条件を変更）' : '絞り込み', SVG_FUNNEL, () => this.filterPopup(name)),
          editable ? svgButton('icon', '列の操作', SVG_KEBAB, () => this.columnMenu(name, ci)) : null));
      }),
      editable ? h('th', { class: 'addcol', title: '列を追加', onclick: () => this.addColumn() }, '＋') : null);

    const body = rows.map((row, ri) => h('tr', null,
      h('td', { class: 'rowhead' },
        editable ? h('button', { class: 'icon rowdel', title: '行を削除', onclick: () => this.deleteRow(ri) }, '×') : null,
        String(ri + 1)),
      row.vals.map((v, ci) => this.cell(v, ri, ci))));
    if (editable) {
      body.push(h('tr', null, h('td', { class: 'rowhead addrow', title: '行を追加', onclick: () => this.addRow() }, '＋'),
        h('td', { class: 'addrow', colspan: Math.max(columns.length, 1), onclick: () => this.addRow() }, '')));
    }
    const table = h('table', { class: 'grid' + (editable ? '' : ' readonly') }, h('thead', null, thead), h('tbody', null, body));
    this.gridEl.replaceChildren(table);
    this.tbody = table.tBodies[0];
    this.applySel();
  }

  cell(v, ri, ci) {
    const td = h('td', {
      onclick: () => { this.setSel(ri, ci); if (this.isBlobCell(ri, ci) && this.data.editable) this.pickBlob(ri, ci); },
      ondblclick: () => this.startEdit(ri, ci),
    });
    this.fillCell(td, v);
    return td;
  }

  fillCell(td, v) {
    td.className = '';
    if (v === null || v === undefined) { td.textContent = 'NULL'; td.classList.add('null'); }
    else if (v instanceof Uint8Array) { td.textContent = `BLOB (${v.length} バイト)`; td.classList.add('blob'); }
    else td.textContent = String(v);
    td.title = td.textContent;
  }

  tdAt(ri, ci) { return this.tbody?.rows[ri]?.cells[ci + 1] || null; }

  setSel(ri, ci) {
    this.sel = { r: ri, c: ci };
    this.applySel();
    this.gridEl.focus({ preventScroll: true });
  }

  applySel() {
    this.gridEl.querySelectorAll('td.sel').forEach((t) => t.classList.remove('sel'));
    if (!this.sel || !this.data) return;
    const td = this.tdAt(this.sel.r, this.sel.c);
    if (td) { td.classList.add('sel'); td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  onGridKey(e) {
    if (this.editing || !this.data || !this.sel) return;
    const { rows, columns } = this.data;
    let { r, c } = this.sel;
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (mv) {
      e.preventDefault();
      r = Math.min(Math.max(r + mv[0], 0), rows.length - 1);
      c = Math.min(Math.max(c + mv[1], 0), columns.length - 1);
      this.setSel(r, c);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.startEdit(r, c);
    }
  }

  isBlobCell(ri, ci) {
    const { meta, columns, rows } = this.data;
    const v = rows[ri].vals[ci];
    if (v instanceof Uint8Array) return true;
    const t = meta?.cols.get(columns[ci])?.type;
    return String(t || '').toUpperCase() === 'BLOB';
  }

  // ---------- セル編集 ----------
  startEdit(ri, ci) {
    if (!this.data?.editable || this.editing) return;
    if (this.isBlobCell(ri, ci)) { this.pickBlob(ri, ci); return; }
    const td = this.tdAt(ri, ci);
    if (!td) return;
    this.setSel(ri, ci);
    const v = this.data.rows[ri].vals[ci];
    const notnull = !!this.data.meta.cols.get(this.data.columns[ci])?.nn;
    const input = h('input', { type: 'text', value: v === null ? '' : String(v) });
    td.className = 'editing sel';
    td.replaceChildren(input);
    this.editing = { ri, ci, td, input };
    input.focus();
    input.select();
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); this.commit(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(true); }
      else if (e.key === 'Backspace' && input.value === '') {
        e.preventDefault();
        if (!notnull) this.commit(null);
      }
    };
    input.onblur = () => { if (this.editing && this.editing.input === input && !this.committing) this.cancelEdit(false); };
  }

  cancelEdit(refocus) {
    if (!this.editing) return;
    const { ri, ci, td } = this.editing;
    this.editing = null;
    if (this.data && this.data.rows[ri]) { this.fillCell(td, this.data.rows[ri].vals[ci]); if (this.sel) this.applySel(); }
    if (refocus) this.gridEl.focus({ preventScroll: true });
  }

  keyWhere(row) {
    const { meta } = this.data;
    if (!meta.wr) return { sql: 'rowid = ?', bind: [row.key[0]] };
    return { sql: meta.pkCols.map((c) => `${qid(c)} = ?`).join(' AND '), bind: row.key };
  }

  // 値の更新後、その行を取り直す（並べ替え・絞り込み中でも行はその場に残す）
  refetchRow(ri, newKey) {
    const { sheet: s, meta } = this.data;
    const row = this.data.rows[ri];
    row.key = newKey;
    const kw = this.keyWhere(row);
    const sql = meta.wr ? `SELECT * FROM ${qid(s.name)} WHERE ${kw.sql}` : `SELECT rowid AS ${RID}, * FROM ${qid(s.name)} WHERE ${kw.sql}`;
    const r = this.db.selectArray(sql, kw.bind);
    if (!r) return;
    row.vals = meta.wr ? r : r.slice(1);
    const tr = this.tbody.rows[ri];
    row.vals.forEach((v, ci) => this.fillCell(tr.cells[ci + 1], v));
    this.applySel();
  }

  newKeyAfter(row, col, value) {
    const { meta } = this.data;
    if (!meta.wr) return col === meta.ipk && value !== null ? [value] : row.key;
    return meta.pkCols.map((pc, i) => (pc === col ? value : row.key[i]));
  }

  updateCell(ri, ci, value) {
    const { sheet: s, columns } = this.data;
    const row = this.data.rows[ri];
    const col = columns[ci];
    const kw = this.keyWhere(row);
    const sql = `UPDATE ${qid(s.name)} SET ${qid(col)} = ? WHERE ${kw.sql}`;
    const bind = [value, ...kw.bind];
    const res = this.panel.gui(inlineSql(sql, bind), () => this.db.exec({ sql, bind }));
    if (!res) return null;
    if (res.ok) {
      let k = this.newKeyAfter(row, col, value);
      // INTEGER PRIMARY KEY に文字列を入れた場合など、実際の値で取り直す
      if (!this.data.meta.wr && col === this.data.meta.ipk && value !== null) k = [this.db.selectValue(`SELECT ${qid(col)} FROM ${qid(s.name)} WHERE rowid = ?`, [Number(value)]) ?? value];
      this.refetchRow(ri, k);
    }
    return res;
  }

  commit(value) {
    const ed = this.editing;
    if (!ed) return;
    this.committing = true;
    const res = this.updateCell(ed.ri, ed.ci, value);
    this.committing = false;
    if (!res) { ed.input.focus(); return; } // キャンセル
    if (res.ok) {
      this.editing = null;
      const nr = Math.min(ed.ri + 1, this.data.rows.length - 1);
      this.setSel(nr, ed.ci);
    } else {
      ed.td.classList.add('bad');
      ed.input.title = res.error.message;
      ed.input.focus();
    }
  }

  pickBlob(ri, ci) {
    const inp = h('input', { type: 'file' });
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      this.updateCell(ri, ci, bytes);
    };
    inp.click();
  }

  // ---------- 行 ----------
  // 必須（NOT NULL）なのにデフォルト値がなく、行追加時に値が要る列
  requiredCols() {
    const { meta } = this.data;
    return [...meta.cols.values()].filter((c) =>
      c.dflt == null && c.hidden !== 2 && c.hidden !== 3 && c.name !== meta.ipk && (c.nn || (meta.wr && c.pk > 0)));
  }

  async addRow() {
    const { sheet: s, meta } = this.data;
    const req = this.requiredCols();
    let res;
    if (req.length === 0) {
      const sql = `INSERT INTO ${qid(s.name)} DEFAULT VALUES`;
      res = this.panel.gui(sql, () => this.db.exec(sql));
    } else {
      // 必須でデフォルトのない列の値を、先にポップアップで入力してもらう
      const inputs = req.map((c) => (String(c.type).toUpperCase() === 'BLOB'
        ? h('input', { type: 'file' })
        : h('input', { type: 'text', placeholder: '空欄のままなら空文字列' })));
      const r = await formDialog('行を追加', req.map((c, i) => [`${c.name}（${c.type || '型なし'}）`, inputs[i]]), '追加', async () => {
        const bind = [];
        for (const inp of inputs) {
          if (inp.type === 'file') {
            if (!inp.files[0]) return 'ファイルを選んでください';
            bind.push(new Uint8Array(await inp.files[0].arrayBuffer()));
          } else bind.push(inp.value);
        }
        const sql = `INSERT INTO ${qid(s.name)} (${req.map((c) => qid(c.name)).join(', ')}) VALUES (${req.map(() => '?').join(', ')})`;
        const g = this.panel.gui(inlineSql(sql, bind), () => this.db.exec({ sql, bind }));
        if (!g) return { cancelled: true };
        if (!g.ok) return g.error.message;
        return { res: g };
      });
      if (!r || r.cancelled) return;
      res = r.res;
    }
    if (!res?.ok) return;
    if (meta.wr) { this.loadCurrent(); return; }
    const rid = this.db.selectValue('SELECT last_insert_rowid()');
    const r = this.db.selectArray(`SELECT * FROM ${qid(s.name)} WHERE rowid = ?`, [rid]);
    this.data.rows.push({ key: [rid], vals: r });
    this.renderGrid();
    this.setSel(this.data.rows.length - 1, 0);
  }

  deleteRow(ri) {
    const { sheet: s } = this.data;
    const kw = this.keyWhere(this.data.rows[ri]);
    const sql = `DELETE FROM ${qid(s.name)} WHERE ${kw.sql}`;
    const res = this.panel.gui(inlineSql(sql, kw.bind), () => this.db.exec({ sql, bind: kw.bind }));
    if (!res?.ok) return;
    this.data.rows.splice(ri, 1);
    this.sel = null;
    this.renderGrid();
  }

  // ---------- 並べ替え・絞り込み ----------
  cycleSort(col) {
    const st = this.state();
    if (!st.sort || st.sort.col !== col) st.sort = { col, dir: 'asc' };
    else if (st.sort.dir === 'asc') st.sort.dir = 'desc';
    else st.sort = null;
    this.loadCurrent();
  }

  async filterPopup(col) {
    const st = this.state();
    const cur = st.filters.get(col) || { op: '=', val: '' };
    const op = h('select', null, OPS.map((o) => h('option', { value: o, selected: o === cur.op }, o)));
    const val = h('input', { type: 'text', value: cur.val });
    const sync = () => { val.disabled = op.value.startsWith('IS '); };
    op.onchange = sync;
    sync();
    let cleared = false;
    const clearBtn = h('button', { type: 'button', class: 'full', onclick: (e) => { cleared = true; e.target.form.requestSubmit(); } }, '絞り込みを解除');
    const r = await formDialog(`「${col}」で絞り込み`, [['条件', op], ['値', val], ['', clearBtn]], '適用', () => ({ op: op.value, val: val.value }));
    if (!r) return;
    if (cleared) st.filters.delete(col);
    else st.filters.set(col, r);
    this.loadCurrent();
  }

  // ---------- 列 ----------
  tableNames() {
    return this.sheets.filter((s) => s.kind === 'table').map((s) => s.name);
  }

  // 列の入力欄（4.2）
  //   withSheetName: シート名欄を加える（テーブルシート作成時）
  //   strict: 対象テーブルが STRICT か
  //   hasRows: 対象テーブルに行があるか（ADD COLUMN の制約がかかるのはこのときだけ）
  columnForm(title, { withSheetName = false, strict = true, hasRows = false } = {}) {
    const sheetName = h('input', { type: 'text' });
    const name = h('input', { type: 'text' });
    const type = h('select', null, TYPES.map((t) => h('option', { value: t }, t)));
    const nn = h('input', { type: 'checkbox' });
    const dflt = h('input', { type: 'text', disabled: true, placeholder: '指定しない（NULL）' });
    const hasD = h('input', { type: 'checkbox' });
    const dfltRow = h('span', { style: 'display:flex;gap:8px;align-items:center' },
      h('label', { style: 'white-space:nowrap' }, hasD, ' 指定する'), dflt);
    const fkT = h('select', null, h('option', { value: '' }, '（なし）'), this.tableNames().map((t) => h('option', { value: t }, t)));
    const fkC = h('select', { disabled: true });

    // 「指定する」のユーザー自身の選択。強制オン／オフが外れたらこれに戻す
    let userHasD = false;
    const sync = () => {
      const fk = !!fkT.value;
      if (hasRows) {
        // 行があるシートへの追加: NOT NULL には非NULLのデフォルトが要り、外部キー列のデフォルトは NULL のみ
        nn.disabled = fk;
        fkT.disabled = nn.checked;
        if (nn.checked) { hasD.checked = true; hasD.disabled = true; }
        else if (fk) { hasD.checked = false; hasD.disabled = true; }
        else { hasD.checked = userHasD; hasD.disabled = false; }
      }
      fkC.disabled = !fk || fkT.disabled;
      dflt.disabled = !hasD.checked;
      dflt.placeholder = hasD.checked ? '空欄のままなら空文字列' : '指定しない（NULL）';
    };
    hasD.onchange = () => {
      userHasD = hasD.checked;
      sync();
      if (hasD.checked) dflt.focus();
    };
    nn.onchange = sync;
    fkT.onchange = () => {
      fkC.replaceChildren(...(fkT.value ? this.tableCols(fkT.value).map((c) => h('option', { value: c.name }, c.name)) : []));
      sync();
    };
    sync();

    const rows = [];
    if (withSheetName) rows.push(['シート名', sheetName], '-');
    rows.push(['列名', name], ['型', type], ['必須（NOT NULL）', nn], ['デフォルト値', dfltRow], ['外部キー: 参照先テーブル', fkT], ['外部キー: 参照先列', fkC]);
    return formDialog(title, rows, '追加', () => {
      if (withSheetName && !sheetName.value.trim()) return 'シート名を入力してください';
      if (!name.value.trim()) return '列名を入力してください';
      const hasDefault = hasD.checked;
      // UI で防いでいるが念のため
      if (hasRows && nn.checked && !hasDefault) return '行があるシートに必須列を追加するには、デフォルト値の指定が必要です';
      if (hasRows && nn.checked && fkT.value) return '行があるシートへの列追加では、必須と外部キーは同時に指定できません';
      if (hasRows && fkT.value && hasDefault) return '行があるシートでは、外部キー列のデフォルト値は指定できません（NULLのみ）';
      if (strict && hasDefault && (type.value === 'INTEGER' || type.value === 'REAL') && !isNumeric(dflt.value)) {
        return `${type.value} の列には数値を入力してください`;
      }
      if (fkT.value && !fkC.value) return '参照先列を選んでください';
      let def = `${qid(name.value.trim())} ${type.value}`;
      if (nn.checked) def += ' NOT NULL';
      if (hasDefault) def += ' DEFAULT ' + typedLit(dflt.value, type.value);
      if (fkT.value) def += ` REFERENCES ${qid(fkT.value)}(${qid(fkC.value)})`;
      return { sheetName: sheetName.value.trim(), def };
    });
  }

  async addColumn() {
    const hasRows = !!this.db.selectValue(`SELECT EXISTS(SELECT 1 FROM ${qid(this.data.sheet.name)})`);
    const r = await this.columnForm('列を追加', { strict: this.data.meta.strict, hasRows });
    if (!r) return;
    const sql = `ALTER TABLE ${qid(this.data.sheet.name)} ADD COLUMN ${r.def}`;
    const res = this.panel.gui(sql, () => this.db.exec(sql));
    if (res?.ok) this.loadCurrent();
  }

  async columnMenu(col) {
    const s = this.data.sheet;
    const only = this.data.columns.length <= 1;
    const act = await menuDialog(`列「${col}」`, [['名前変更', 'rename'], [only ? '削除（列が1つだけのため不可）' : '削除', 'delete', only]]);
    if (act === 'rename') {
      const nn = await promptDialog('列の名前変更', '新しい名前', col, (v) => (v.trim() ? null : '名前を入力してください'));
      if (!nn || nn.trim() === col) return;
      const sql = `ALTER TABLE ${qid(s.name)} RENAME COLUMN ${qid(col)} TO ${qid(nn.trim())}`;
      const res = this.panel.gui(sql, () => this.db.exec(sql));
      if (res?.ok) {
        const st = this.state();
        if (st.sort?.col === col) st.sort.col = nn.trim();
        if (st.filters.has(col)) { st.filters.set(nn.trim(), st.filters.get(col)); st.filters.delete(col); }
        this.loadCurrent();
      }
    } else if (act === 'delete') {
      if (!confirm(`列「${col}」を削除しますか？`)) return;
      const sql = `ALTER TABLE ${qid(s.name)} DROP COLUMN ${qid(col)}`;
      const res = this.panel.gui(sql, () => this.db.exec(sql));
      if (res?.ok) {
        const st = this.state();
        if (st.sort?.col === col) st.sort = null;
        st.filters.delete(col);
        this.loadCurrent();
      }
    }
  }

  // ---------- シート ----------
  async addSheet() {
    const kind = await chooseDialog('シートを追加', [['▦ テーブル', 'table'], ['🔍 クエリ', 'query']]);
    if (kind === 'table') {
      const r = await this.columnForm('テーブルシートを追加', { withSheetName: true, strict: true, hasRows: false });
      if (!r) return;
      const sql = `CREATE TABLE ${qid(r.sheetName)} (${r.def}) STRICT`;
      const res = this.panel.gui(sql, () => this.db.exec(sql));
      if (res?.ok) { this.currentKey = 'table:' + r.sheetName; await this.loadAll(); }
    } else if (kind === 'query') {
      const name = await promptDialog('クエリシートを追加', 'シート名', `クエリ${this.queries.length + 1}`, (v) => (v.trim() ? null : '名前を入力してください'));
      if (!name) return;
      await this.addQuerySheet('', name.trim());
      this.queryEl.focus();
    }
  }

  async addQuerySheet(sql, name) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.queries.push({ id, name: name || `クエリ${this.queries.length + 1}`, sql });
    await setQueries(this.dbName, this.queries);
    this.currentKey = 'query:' + id;
    await this.loadAll();
  }

  async runQuerySheet() {
    const s = this.current;
    if (!s || s.kind !== 'query') return;
    const sql = this.queryEl.value;
    // SELECT 以外は実行しない
    if (sql.trim()) {
      try {
        const st = this.db.prepare(sql);
        let ro;
        try { ro = this.sqlite3.capi.sqlite3_stmt_readonly(st.pointer); } finally { st.finalize(); }
        if (!ro) { this.errEl.textContent = 'クエリシートでは SELECT のみ実行できます（それ以外は DB全体のSQL欄で）'; return; }
      } catch (e) {
        this.errEl.textContent = e.message;
        return;
      }
    }
    const q = this.queries.find((x) => x.id === s.id);
    q.sql = sql;
    s.sql = sql;
    await setQueries(this.dbName, this.queries);
    this.state().filters.clear();
    this.state().sort = null;
    this.loadCurrent();
  }

  async renameSheet(s) {
    const nn = await promptDialog('シートの名前変更', '新しい名前', s.name, (v) => (v.trim() ? null : '名前を入力してください'));
    if (!nn || nn.trim() === s.name) return;
    const name = nn.trim();
    if (s.kind === 'query') {
      this.queries.find((x) => x.id === s.id).name = name;
      await setQueries(this.dbName, this.queries);
      await this.loadAll();
      return;
    }
    let sql;
    if (s.kind === 'table') sql = `ALTER TABLE ${qid(s.name)} RENAME TO ${qid(name)}`;
    else sql = `DROP VIEW ${qid(s.name)};\nCREATE VIEW ${qid(name)} AS ${this.viewSelect(s.name)}`;
    const res = this.panel.gui(sql, () => {
      if (s.kind === 'table') this.db.exec(sql);
      else this.db.transaction(() => this.db.exec(sql));
    });
    if (res?.ok) {
      const old = this.states.get(s.key);
      const key = s.kind + ':' + name;
      if (old) this.states.set(key, old);
      this.currentKey = key;
      await this.loadAll();
    }
  }

  async deleteSheet(s) {
    if (!confirm(`シート「${s.name}」を削除しますか？` + (s.kind === 'table' ? '\nテーブルとそのデータが削除されます。' : ''))) return;
    if (s.kind === 'query') {
      this.queries = this.queries.filter((x) => x.id !== s.id);
      await setQueries(this.dbName, this.queries);
      await this.loadAll();
      return;
    }
    const sql = `DROP ${s.kind === 'table' ? 'TABLE' : 'VIEW'} ${qid(s.name)}`;
    const res = this.panel.gui(sql, () => this.db.exec(sql));
    if (res?.ok) { this.states.delete(s.key); await this.loadAll(); }
  }
}
