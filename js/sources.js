// グリッドのデータ元：テーブル（編集可）と、ビュー/クエリ（読み取り専用）
import { db, q, inline } from './db-client.js';
import { affinity } from './schema.js';
import { undo } from './undo.js';

export const FILTER_OPS = [
  { id: 'eq', label: '＝ 等しい', sql: (c) => `${c} = ?` },
  { id: 'ne', label: '≠ 等しくない', sql: (c) => `${c} IS NOT ?` },
  { id: 'contains', label: '含む', sql: (c) => `instr(${c}, ?) > 0` },
  { id: 'starts', label: 'で始まる', sql: (c) => `substr(${c}, 1, length(?1)) = ?1`, named: true },
  { id: 'gt', label: '＞ より大きい', sql: (c) => `${c} > ?` },
  { id: 'ge', label: '≧ 以上', sql: (c) => `${c} >= ?` },
  { id: 'lt', label: '＜ より小さい', sql: (c) => `${c} < ?` },
  { id: 'le', label: '≦ 以下', sql: (c) => `${c} <= ?` },
  { id: 'null', label: 'NULL である', sql: (c) => `${c} IS NULL`, noValue: true },
  { id: 'notnull', label: 'NULL でない', sql: (c) => `${c} IS NOT NULL`, noValue: true },
  { id: 'empty', label: '空（NULL か空文字）', sql: (c) => `coalesce(${c}, '') = ''`, noValue: true },
];

/** 入力文字列を列の型に合わせた値に */
export function convertInput(value, type) {
  if (value === null || value === undefined || value instanceof Uint8Array) return value ?? null;
  if (typeof value !== 'string') return value;
  const a = affinity(type);
  if (a === 'TEXT' || a === 'BLOB') return value;
  let t = value.trim();
  // スプレッドシートからの貼り付けに多い桁区切り（1,200）も数値として扱う
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replaceAll(',', '');
  if (/^[-+]?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : BigInt(t);
  }
  if (a !== 'INTEGER' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  return value;
}

/** SQLite のエラーを日本語に */
export function friendlyError(msg) {
  const m = String(msg);
  let r;
  if ((r = m.match(/UNIQUE constraint failed: (.+)/))) return `重複しています（一意制約: ${r[1]}）`;
  if ((r = m.match(/NOT NULL constraint failed: (.+)/))) return `空（NULL）にできません: ${r[1]}`;
  if (/FOREIGN KEY constraint failed/.test(m)) return '外部キー制約違反：参照先に存在しない値か、他の行から参照されています';
  if ((r = m.match(/CHECK constraint failed: (.+)/))) return `CHECK 制約に違反しています: ${r[1]}`;
  if ((r = m.match(/cannot store (\w+) value in (\w+) column (.+)/))) return `${r[3]} は ${r[2]} 型です（${r[1]} は入れられません）`;
  if ((r = m.match(/no such table: (.+)/))) return `テーブル ${r[1]} がありません`;
  if ((r = m.match(/no such column: (.+)/))) return `列 ${r[1]} がありません`;
  if ((r = m.match(/near "(.+?)": syntax error/))) return `SQL の構文エラー（"${r[1]}" 付近）`;
  return m;
}

function whereClause(filters, colExpr) {
  const parts = [], bind = [];
  for (const f of filters) {
    const op = FILTER_OPS.find((o) => o.id === f.op);
    if (!op) continue;
    let sql = op.sql(colExpr(f.col));
    if (op.named) {
      // ?1 を使うものは位置引数に展開
      sql = sql.replaceAll('?1', '?');
      bind.push(f.value, f.value);
    } else if (!op.noValue) bind.push(f.value);
    parts.push(sql);
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', bind };
}

/** 並べ替え基準（先頭が一番強い）を ORDER BY の項目列に */
function sortTerms(sorts, colExpr) {
  return (sorts || []).map((s) => `${colExpr(s.col)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
}

/** 列の並べ替え状態 { dir, rank, total } か null */
function sortInfo(sorts, name) {
  const i = (sorts || []).findIndex((s) => s.col === name);
  return i < 0 ? null : { dir: sorts[i].dir, rank: i + 1, total: sorts.length };
}

function filterValue(f, type) {
  const op = FILTER_OPS.find((o) => o.id === f.op);
  if (['contains', 'starts'].includes(f.op)) return { ...f };
  return op?.noValue ? f : { ...f, value: convertInput(f.value, type) };
}

// ------------------------------------------------------------------------

export class TableSource {
  /** model: schema.readTable の結果、view: {sorts:[{col,dir}]（先頭が一番強い）, filters:[]} */
  constructor(dbName, model, view, labelCols) {
    this.model = model;
    this.view = view;
    this.editable = true;
    this.widthKey = `${dbName}/${model.name}`;
    this.t = q(model.name);
    this.hasRowid = !model.withoutRowid;
    this.fkByCol = new Map();
    for (const f of model.fks) if (f.cols.length === 1) this.fkByCol.set(f.cols[0], { table: f.table, refCol: f.refCols[0] });
    this.labelCols = labelCols; // 列名 → 参照先の表示用列
    const uniq = new Set(model.uniques.filter((u) => u.length === 1).map((u) => u[0]));
    this.columns = model.columns.map((c) => {
      const badges = [];
      const t = c.type || 'ANY';
      badges.push({ text: t, cls: 'type', title: '型' });
      if (model.pk.includes(c.name)) badges.push({ text: model.pk.length > 1 ? `🔑${model.pk.indexOf(c.name) + 1}` : '🔑', cls: 'pk', title: model.pk.length > 1 ? `複合主キー（${model.pk.join(', ')}）` : (model.rowidAlias === c.name ? '主キー（自動採番）' : '主キー') });
      if (uniq.has(c.name)) badges.push({ text: '◇', cls: 'uq', title: '一意（UNIQUE）' });
      const fk = model.fks.find((f) => f.cols.includes(c.name));
      if (fk) badges.push({ text: '→', cls: 'fk', title: `外部キー → ${fk.table}(${fk.refCols.join(', ')})` });
      if (c.notnull && !model.pk.includes(c.name)) badges.push({ text: '必須', cls: 'nn', title: 'NOT NULL' });
      if (c.generated) badges.push({ text: 'ƒ', cls: 'gen', title: `生成列: ${c.generated.expr}` });
      const a = affinity(c.type);
      return {
        name: c.name,
        type: c.type,
        badges,
        readonly: !!c.generated,
        auto: model.rowidAlias === c.name, // 自動採番（rowid の別名）
        // INSERT 時に値が要る列（NOT NULL・既定値なし・自動採番でない）
        required: !!c.notnull && c.defaultSql == null && !c.generated && model.rowidAlias !== c.name,
        align: a === 'INTEGER' || a === 'REAL' || a === 'NUMERIC' ? 'right' : 'left',
        fk: this.fkByCol.get(c.name) || null,
        sort: sortInfo(view.sorts, c.name),
        filtered: view.filters.some((f) => f.col === c.name),
        title: c.check ? `CHECK (${c.check})` : '',
      };
    });
  }

  keyCols() { return this.hasRowid ? ['_rowid_'] : this.model.pk; }

  selectList() {
    const cols = this.model.columns.map((c) => `${this.t}.${q(c.name)}`);
    const labels = this.columns.map((c, i) => {
      const lc = c.fk && this.labelCols.get(c.name);
      return lc ? `(SELECT ${q(lc)} FROM ${q(c.fk.table)} WHERE ${q(c.fk.refCol)} = ${this.t}.${q(c.name)} LIMIT 1) AS __l${i}` : null;
    });
    this.labelIdx = labels.map((l) => !!l);
    const key = this.hasRowid ? [`${this.t}._rowid_`] : [];
    return [...key, ...cols, ...labels.filter(Boolean)].join(', ');
  }

  where() {
    const filters = this.view.filters.map((f) => filterValue(f, this.model.columns.find((c) => c.name === f.col)?.type));
    return whereClause(filters, (c) => `${this.t}.${q(c)}`);
  }

  orderBy() {
    const tie = this.hasRowid ? `${this.t}._rowid_` : this.model.pk.map((c) => `${this.t}.${q(c)}`).join(', ');
    return ' ORDER BY ' + [...sortTerms(this.view.sorts, (c) => `${this.t}.${q(c)}`), tie].join(', ');
  }

  /** グリッドに見せている SELECT（表示用） */
  displaySql() {
    const w = this.where();
    const terms = sortTerms(this.view.sorts, q);
    return inline(`SELECT * FROM ${this.t}${w.sql}${terms.length ? ' ORDER BY ' + terms.join(', ') : ''}`, w.bind);
  }

  async count() {
    const w = this.where();
    const r = await db.query(`SELECT count(*) FROM ${this.t}${w.sql}`, w.bind);
    return Number(r.rows[0][0]);
  }

  toRow(raw) {
    const n = this.model.columns.length;
    let i = 0;
    const key = this.hasRowid ? { _rowid_: raw[i++] } : null;
    const values = raw.slice(i, i + n);
    const labels = {};
    let li = i + n;
    this.labelIdx.forEach((has, c) => { if (has) labels[c] = raw[li++]; });
    const row = { values, labels };
    row.key = key || Object.fromEntries(this.model.pk.map((p) => [p, values[this.model.columns.findIndex((c) => c.name === p)]]));
    return row;
  }

  async fetch(offset, limit) {
    const w = this.where();
    const r = await db.query(`SELECT ${this.selectList()} FROM ${this.t}${w.sql}${this.orderBy()} LIMIT ? OFFSET ?`, [...w.bind, limit, offset]);
    return r.rows.map((raw) => this.toRow(raw));
  }

  keyWhere(key) {
    const cols = Object.keys(key);
    return { sql: cols.map((c) => `${c === '_rowid_' ? '_rowid_' : q(c)} IS ?`).join(' AND '), bind: cols.map((c) => key[c]) };
  }

  async fetchByKey(key) {
    const kw = this.keyWhere(key);
    const r = await db.query(`SELECT ${this.selectList()} FROM ${this.t} WHERE ${kw.sql}`, kw.bind);
    return r.rows[0] ? this.toRow(r.rows[0]) : null;
  }

  insertableCols() { return this.model.columns.filter((c) => !c.generated); }

  /** 行の全値を復元する INSERT */
  restoreStmt(row) {
    const cols = this.insertableCols();
    const names = cols.map((c) => q(c.name));
    const vals = cols.map((c) => row.values[this.model.columns.indexOf(c)]);
    if (this.hasRowid) { names.unshift('_rowid_'); vals.unshift(row.key._rowid_); }
    return { sql: `INSERT INTO ${this.t} (${names.join(', ')}) VALUES (${vals.map(() => '?').join(', ')})`, bind: vals };
  }

  deleteStmt(key) {
    const kw = this.keyWhere(key);
    return { sql: `DELETE FROM ${this.t} WHERE ${kw.sql}`, bind: kw.bind };
  }

  newKeyAfter(row, setCols) {
    const key = { ...row.key };
    if (this.hasRowid) {
      if (this.model.rowidAlias && this.model.rowidAlias in setCols) key._rowid_ = setCols[this.model.rowidAlias];
    } else {
      for (const p of this.model.pk) if (p in setCols) key[p] = setCols[p];
    }
    return key;
  }

  async update(changes) {
    const byRow = new Map();
    for (const ch of changes) {
      if (!byRow.has(ch.row)) byRow.set(ch.row, { rowObj: ch.rowObj, set: {} });
      const col = this.model.columns[ch.col];
      byRow.get(ch.row).set[col.name] = convertInput(ch.value, col.type);
    }
    const redo = [], undoStmts = [], targets = [];
    for (const [row, { rowObj, set }] of byRow) {
      const names = Object.keys(set);
      const kw = this.keyWhere(rowObj.key);
      redo.push({ sql: `UPDATE ${this.t} SET ${names.map((n) => `${q(n)} = ?`).join(', ')} WHERE ${kw.sql}`, bind: [...names.map((n) => set[n]), ...kw.bind] });
      const newKey = this.newKeyAfter(rowObj, set);
      const nkw = this.keyWhere(newKey);
      const old = names.map((n) => rowObj.values[this.model.columns.findIndex((c) => c.name === n)]);
      undoStmts.unshift({ sql: `UPDATE ${this.t} SET ${names.map((n) => `${q(n)} = ?`).join(', ')} WHERE ${nkw.sql}`, bind: [...old, ...nkw.bind] });
      targets.push({ row, newKey });
    }
    await db.batch(redo);
    undo.push({ label: changes.length > 1 ? `${changes.length} セルの変更` : 'セルの変更', undo: undoStmts, redo });
    const out = [];
    for (const t of targets) {
      const fresh = await this.fetchByKey(t.newKey);
      if (fresh) out.push({ row: t.row, rowObj: fresh });
    }
    return out;
  }

  async insert(rows) {
    const stmts = [];
    for (const vals of rows) {
      const names = [], bind = [];
      vals.forEach((v, c) => {
        if (v === undefined) return;
        const col = this.model.columns[c];
        names.push(q(col.name)); bind.push(convertInput(v, col.type));
      });
      stmts.push(names.length
        ? { sql: `INSERT INTO ${this.t} (${names.join(', ')}) VALUES (${bind.map(() => '?').join(', ')})`, bind }
        : { sql: `INSERT INTO ${this.t} DEFAULT VALUES` });
    }
    const results = await db.batch(stmts);
    // Undo/Redo 用に、挿入された行を丸ごと取得
    const inserted = [];
    for (let i = 0; i < results.length; i++) {
      let key;
      if (this.hasRowid) key = { _rowid_: results[i].lastId };
      else {
        key = {};
        for (const p of this.model.pk) {
          const ci = this.model.columns.findIndex((c) => c.name === p);
          key[p] = convertInput(rows[i][ci], this.model.columns[ci].type);
        }
      }
      const row = await this.fetchByKey(key);
      if (row) inserted.push(row);
    }
    undo.push({
      label: inserted.length > 1 ? `${inserted.length} 行の追加` : '行の追加',
      undo: inserted.map((r) => this.deleteStmt(r.key)).reverse(),
      redo: inserted.map((r) => this.restoreStmt(r)),
    });
  }

  async deleteRows(rowObjs) {
    const stmts = rowObjs.map((r) => this.deleteStmt(r.key));
    await db.batch(stmts);
    undo.push({
      label: rowObjs.length > 1 ? `${rowObjs.length} 行の削除` : '行の削除',
      undo: rowObjs.map((r) => this.restoreStmt(r)),
      redo: stmts,
    });
  }

  async duplicateRows(rowObjs) {
    const cols = this.insertableCols().filter((c) => c.name !== this.model.rowidAlias);
    const rows = rowObjs.map((r) => this.model.columns.map((c, i) => (cols.includes(c) ? r.values[i] : undefined)));
    await this.insert(rows);
  }

  async setBlob(rowObj, colIdx, bytes) {
    const col = this.model.columns[colIdx];
    await this.update([{ row: -1, col: colIdx, value: bytes, rowObj }]);
    void col;
  }
}

// ------------------------------------------------------------------------

export class QuerySource {
  /** sql: ユーザーの SELECT（末尾の ; は除去）。view: {sorts, filters} */
  constructor(widthKey, sql, view) {
    this.sql = sql.trim().replace(/;+\s*$/, '');
    this.view = view;
    this.editable = false;
    this.widthKey = widthKey;
    this.columns = [];
  }

  async init() {
    const r = await db.query(`SELECT * FROM (${this.sql}) LIMIT 0`);
    this.columns = r.columns.map((name) => ({
      name, badges: [],
      sort: sortInfo(this.view.sorts, name),
      filtered: this.view.filters.some((f) => f.col === name),
    }));
    // 先頭行から数値列を推定して右寄せ
    const s = await db.query(`SELECT * FROM (${this.sql}) LIMIT 50`);
    this.columns.forEach((c, i) => {
      const vals = s.rows.map((row) => row[i]).filter((v) => v != null);
      if (vals.length && vals.every((v) => typeof v === 'number' || typeof v === 'bigint')) c.align = 'right';
    });
    return this;
  }

  where() { return whereClause(this.view.filters.map((f) => filterValue(f, 'ANY')), (c) => q(c)); }
  orderBy() { const t = sortTerms(this.view.sorts, q); return t.length ? ' ORDER BY ' + t.join(', ') : ''; }

  async count() {
    const w = this.where();
    const r = await db.query(`SELECT count(*) FROM (${this.sql})${w.sql}`, w.bind);
    return Number(r.rows[0][0]);
  }

  async fetch(offset, limit) {
    const w = this.where();
    const r = await db.query(`SELECT * FROM (${this.sql})${w.sql}${this.orderBy()} LIMIT ? OFFSET ?`, [...w.bind, limit, offset]);
    return r.rows.map((values) => ({ values }));
  }
}
