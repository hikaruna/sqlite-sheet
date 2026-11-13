// グリッドのデータ元：テーブル（編集可）と、ビュー/クエリ（読み取り専用）
import { db, q, inline, lit } from './db-client.js';
import { affinity } from './schema.js';
import { pushChanges } from './undo.js';
import { txMarks } from './txmarks.js';

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

// ---------- フォーム（入力中の文字列）と DBの値 ----------
// 普通の文字は値、= で始まれば SQL の式、'= で始まれば先頭の ' を外した文字列

/** フォームの文字列を { expr }（式）か { value }（値）に分ける */
export function parseInput(text, type) {
  if (typeof text !== 'string') return { value: convertInput(text, type) };
  if (text.startsWith('=')) return { expr: text.slice(1) };
  if (/^'+=/.test(text)) return { value: text.slice(1) };
  return { value: convertInput(text, type) };
}

/** DBの値を、フォームを開いたときの文字列に */
export function formText(v) {
  if (v === null || v === undefined) return '=NULL';
  const s = String(v);
  return /^'*=/.test(s) ? "'" + s : s;
}

/** フォームの値の印（DBの値と区別するため、書き込みではこの形で渡す） */
export const form = (text) => ({ form: text });
const isForm = (v) => v !== null && typeof v === 'object' && !(v instanceof Uint8Array) && 'form' in v;

/** 外側の括弧が式全体を囲んでいるか（"(a) + (b)" は囲んでいない） */
function wrapsAll(d) {
  if (!d.startsWith('(') || !d.endsWith(')')) return false;
  let depth = 0, quote = null;
  for (let i = 0; i < d.length; i++) {
    const ch = d[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0 && i < d.length - 1) return false;
  }
  return true;
}

/** 列の既定値（DEFAULT 句）を、既定値のフォームの文字列に。既定値なしは空 */
export function defaultToForm(sql) {
  if (sql == null || sql === '') return '';
  const d = sql.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(d)) return d;
  const m = d.match(/^'((?:[^']|'')*)'$/s);
  if (m) {
    const v = m[1].replaceAll("''", "'");
    return v === '' ? "=''" : formText(v);
  }
  return '=' + (wrapsAll(d) ? d.slice(1, -1).trim() : d);
}

/** 既定値のフォームの文字列を、DEFAULT 句に書ける形に。空は既定値なし（null） */
export function formToDefault(text, type) {
  if (text === '') return null;
  const p = parseInput(text, type);
  if (!('expr' in p)) return lit(p.value);
  const e = p.expr.trim();
  return /^(NULL|TRUE|FALSE|CURRENT_(TIME|DATE|TIMESTAMP)|[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?|'(?:[^']|'')*'|X'[0-9a-f]*')$/is.test(e) || wrapsAll(e) ? e : `(${e})`;
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

/** 式を計算したときのエラーを、ユーザーが書いた式に合わせた言葉に */
function exprError(msg, newRow) {
  const m = String(msg);
  let r;
  if (/incomplete input/.test(m)) return '式が途中で終わっています（括弧や引用符が閉じているか確かめてください）';
  if ((r = m.match(/near "(.+?)": syntax error/))) {
    // ) や FROM はアプリが式のあとに足したもの。そこで止まるのは、式の書き方そのものの誤り
    return r[1] === ')' || /^from$/i.test(r[1]) ? '式の書き方が正しくありません' : `"${r[1]}" 付近の書き方が正しくありません`;
  }
  if ((r = m.match(/no such column: (.+)/))) return newRow ? `新しい行の式では列（${r[1]}）を使えません` : `列 ${r[1]} がありません`;
  if ((r = m.match(/no such function: (.+)/))) return `関数 ${r[1]} はありません`;
  return friendlyError(m);
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
        dflt: c.defaultSql ?? null,
        notnull: !!c.notnull,
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

  /** 今の並べ替え・絞り込みで、その行（キーか、identOf の見分け方）が何行目か（0 始まり）。絞り込みで見えなければ null */
  async rowIndexOf(key) {
    const w = this.where(), kw = this.keyWhere(key);
    const keyCols = Object.keys(key).map((c) => (c === '_rowid_' ? '_rowid_' : q(c)));
    const r = await db.query(
      `SELECT rn FROM (SELECT ${keyCols.map((c) => `${this.t}.${c} AS ${c}`).join(', ')}, ROW_NUMBER() OVER (${this.orderBy().trim()}) - 1 AS rn FROM ${this.t}${w.sql}) WHERE ${kw.sql}`,
      [...w.bind, ...kw.bind]);
    return r.rows[0] ? Number(r.rows[0][0]) : null;
  }

  async fetchByKey(key) {
    const kw = this.keyWhere(key);
    const r = await db.query(`SELECT ${this.selectList()} FROM ${this.t} WHERE ${kw.sql}`, kw.bind);
    return r.rows[0] ? this.toRow(r.rows[0]) : null;
  }

  insertableCols() { return this.model.columns.filter((c) => !c.generated); }

  deleteStmt(key) {
    const kw = this.keyWhere(key);
    return { sql: `DELETE FROM ${this.t} WHERE ${kw.sql}`, bind: kw.bind };
  }

  /**
   * 書き込む値を SQL の部品に。フォームの =式 は文にそのまま埋め込み、DB が UPDATE / INSERT の中で計算する。
   * それ以外の値は ? で渡す。newRow なら式から列は参照できない
   */
  toSqlPart(v, col, newRow) {
    if (isForm(v)) {
      const p = parseInput(v.form, col.type);
      // 末尾の -- コメントで閉じ括弧が消えないように、改行してから閉じる
      if ('expr' in p) return { sql: `(${p.expr}\n)`, check: `SELECT (${p.expr}\n)${newRow ? '' : ` FROM ${this.t}`}`, col };
      return { sql: '?', bind: [p.value] };
    }
    return { sql: '?', bind: [convertInput(v, col.type)] };
  }

  /** 式を含む文が失敗したとき、式の誤りならユーザーが書いた式の言葉で、列を添えて伝える */
  exprFailure(e, parts, newRow) {
    const exprs = parts.filter((p) => p.check);
    if (!exprs.length || !/incomplete input|syntax error|no such column|no such function|unrecognized token|wrong number of arguments|式は1つだけ|式で DB/.test(e.message)) return e;
    const one = exprs.length === 1 ? exprs[0].col : null;
    const err = new Error(`${one ? `「${one.name}」の` : ''}式を計算できません：${exprError(e.message, newRow)}`);
    err.col = one ? this.model.columns.indexOf(one) : -1;
    return err;
  }

  /** RETURNING で返すキーの列 */
  returningKey() { return this.keyCols().map((k) => (k === '_rowid_' ? '_rowid_' : q(k))); }

  /** トランザクション中に変えたセル・足した行か（未確定の印のため） */
  isPendingCell(rowObj, c) { return !!rowObj && txMarks.has(this.model.name, this.identOf(rowObj), this.model.columns[c]?.name); }
  isPendingRow(rowObj) { return !!rowObj && txMarks.has(this.model.name, this.identOf(rowObj), null); }

  /**
   * 行の「見分け方」。変更の記録（セッション）と同じく主キーの値で、主キーのない表は rowid。
   * rowid は元に戻すと変わることがあるので、未確定の印や戻した場所はこれで覚える
   */
  identOf(rowObj) {
    if (!this.model.pk.length) return { _rowid_: rowObj.key._rowid_ };
    return Object.fromEntries(this.model.pk.map((p) => [p, rowObj.values[this.model.columns.findIndex((c) => c.name === p)]]));
  }

  async update(changes) {
    const byRow = new Map();
    for (const ch of changes) {
      if (!byRow.has(ch.row)) byRow.set(ch.row, { rowObj: ch.rowObj, cols: [], parts: [] });
      const col = this.model.columns[ch.col];
      const r = byRow.get(ch.row);
      r.cols.push(col); r.parts.push(this.toSqlPart(ch.value, col, false));
    }
    const plans = [...byRow.entries()].map(([row, r]) => ({ row, ...r }));
    const allParts = plans.flatMap((p) => p.parts);
    // 式はこの UPDATE の中で計算され、RETURNING で計算結果と新しいキーを受け取る
    const stmts = plans.map(({ rowObj, cols, parts }) => {
      const kw = this.keyWhere(rowObj.key);
      return {
        sql: `UPDATE ${this.t} SET ${cols.map((c, i) => `${q(c.name)} = ${parts[i].sql}`).join(', ')} WHERE ${kw.sql} RETURNING ${[...this.returningKey(), ...cols.map((c) => q(c.name))].join(', ')}`,
        bind: [...parts.flatMap((p) => p.bind ?? []), ...kw.bind],
        checks: parts.filter((p) => p.check).map((p) => p.check),
      };
    });
    let r;
    try { r = await db.batchTracked(stmts); } catch (e) { throw this.exprFailure(e, allParts, false); }
    const out = [];
    plans.forEach((p, i) => {
      const ret = r.results[i].rows[0];
      if (ret) p.newKey = Object.fromEntries(this.keyCols().map((k, j) => [k, ret[j]]));
    });
    pushChanges(`「${this.model.name}」の${changes.length > 1 ? `${changes.length} セルの変更` : 'セルの変更'}`, 't:' + this.model.name, r);
    for (const p of plans) {
      const fresh = p.newKey && await this.fetchByKey(p.newKey);
      if (fresh) out.push({ row: p.row, rowObj: fresh });
    }
    return out;
  }

  async insert(rows) {
    const allParts = [];
    const stmts = rows.map((vals) => {
      const cols = [], parts = [];
      vals.forEach((v, c) => {
        if (v === undefined) return;
        const col = this.model.columns[c];
        cols.push(col); parts.push(this.toSqlPart(v, col, true));
      });
      allParts.push(...parts);
      const ret = ` RETURNING ${this.returningKey().join(', ')}`;
      return {
        sql: cols.length
          ? `INSERT INTO ${this.t} (${cols.map((c) => q(c.name)).join(', ')}) VALUES (${parts.map((p) => p.sql).join(', ')})${ret}`
          : `INSERT INTO ${this.t} DEFAULT VALUES${ret}`,
        bind: parts.flatMap((p) => p.bind ?? []),
        checks: parts.filter((p) => p.check).map((p) => p.check),
      };
    });
    let r;
    try { r = await db.batchTracked(stmts); } catch (e) { throw this.exprFailure(e, allParts, true); }
    const n = r.results.filter((x) => x.rows[0]).length;
    pushChanges(`「${this.model.name}」の${n > 1 ? `${n} 行の追加` : '行の追加'}`, 't:' + this.model.name, r);
  }

  async deleteRows(rowObjs) {
    const r = await db.batchTracked(rowObjs.map((x) => this.deleteStmt(x.key)));
    pushChanges(`「${this.model.name}」の${rowObjs.length > 1 ? `${rowObjs.length} 行の削除` : '行の削除'}`, 't:' + this.model.name, r);
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
