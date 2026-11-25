// グリッドのデータ元：テーブル（編集可）と、ビュー/クエリ（読み取り専用）
import { t as tr } from './i18n.js';
import { db, q, inline, lit } from './db-client.js';
import { affinity } from './schema.js';
import { pushChanges } from './undo.js';
import { txMarks } from './txmarks.js';

export const FILTER_OPS = [
  { id: 'eq', label: tr('＝ 等しい'), sql: (c) => `${c} = ?` },
  { id: 'ne', label: tr('≠ 等しくない'), sql: (c) => `${c} IS NOT ?` },
  { id: 'contains', label: tr('含む'), sql: (c) => `instr(${c}, ?) > 0` },
  { id: 'starts', label: tr('で始まる'), sql: (c) => `substr(${c}, 1, length(?1)) = ?1`, named: true },
  { id: 'gt', label: tr('＞ より大きい'), sql: (c) => `${c} > ?` },
  { id: 'ge', label: tr('≧ 以上'), sql: (c) => `${c} >= ?` },
  { id: 'lt', label: tr('＜ より小さい'), sql: (c) => `${c} < ?` },
  { id: 'le', label: tr('≦ 以下'), sql: (c) => `${c} <= ?` },
  { id: 'null', label: tr('NULL である'), sql: (c) => `${c} IS NULL`, noValue: true },
  { id: 'notnull', label: tr('NULL でない'), sql: (c) => `${c} IS NOT NULL`, noValue: true },
  { id: 'empty', label: tr('空（NULL か空文字）'), sql: (c) => `coalesce(${c}, '') = ''`, noValue: true },
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
/** バインドする値が同じか（バイト列は中身で比べる） */
function sameValue(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  return false;
}
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
  if ((r = m.match(/UNIQUE constraint failed: (.+)/))) return tr('重複しています（一意制約: {0}）', [r[1]]);
  if ((r = m.match(/NOT NULL constraint failed: (.+)/))) return tr('空（NULL）にできません: {0}', [r[1]]);
  if (/FOREIGN KEY constraint failed/.test(m)) return tr('外部キー制約違反：参照先に存在しない値か、他の行から参照されています');
  if ((r = m.match(/CHECK constraint failed: (.+)/))) return tr('CHECK 制約に違反しています: {0}', [r[1]]);
  if ((r = m.match(/cannot store (\w+) value in (\w+) column (.+)/))) return tr('{0} は {1} 型です（{2} は入れられません）', [r[3], r[2], r[1]]);
  if ((r = m.match(/no such table: (.+)/))) return tr('テーブル {0} がありません', [r[1]]);
  if ((r = m.match(/no such column: (.+)/))) return tr('列 {0} がありません', [r[1]]);
  if ((r = m.match(/near "(.+?)": syntax error/))) return tr('SQL の構文エラー（"{0}" 付近）', [r[1]]);
  // Worker（db-worker.js）が出す日本語のエラーも、英語のときは訳す
  if (m === 'BUSY' || m.endsWith(': BUSY')) return tr('ほかのタブでブラウザの DB を使っています。そのタブで一覧やブラウザに保存した DB を閉じてから、もう一度お試しください');
  if (m.includes('クエリシートでは読み取り（SELECT）だけ使えます。データを変更する SQL は SQL コンソールで実行してください')) return tr('クエリシートでは読み取り（SELECT）だけ使えます。データを変更する SQL は SQL コンソールで実行してください');
  if (m.includes('クエリシートには SQL を1文だけ書けます')) return tr('クエリシートには SQL を1文だけ書けます');
  if ((r = m.match(/^「(.+)」は既にあります$/))) return tr('「{0}」は既にあります', [r[1]]);
  if ((r = m.match(/^ファイルに保存できませんでした：(.*)$/s))) return tr('ファイルに保存できませんでした：{0}', [r[1]]);
  if ((r = m.match(/^外部キー制約に違反する行が (\d+) 件あるため適用できません（例: (.+)）$/))) return tr('外部キー制約に違反する行が {0} 件あるため適用できません（例: {1}）', [r[1], r[2]]);
  if ((r = m.match(/^(.+) に失敗しました（(.+)）$/))) return tr('{0} に失敗しました（{1}）', [tr(r[1]), r[2]]);
  return tr(m);
}

/** 式を計算したときのエラーを、ユーザーが書いた式に合わせた言葉に */
function exprError(msg, newRow) {
  const m = String(msg);
  let r;
  if (/incomplete input/.test(m)) return tr('式が途中で終わっています（括弧や引用符が閉じているか確かめてください）');
  if ((r = m.match(/near "(.+?)": syntax error/))) {
    // ) や FROM はアプリが式のあとに足したもの。そこで止まるのは、式の書き方そのものの誤り
    return r[1] === ')' || /^from$/i.test(r[1]) ? tr('式の書き方が正しくありません') : tr('"{0}" 付近の書き方が正しくありません', [r[1]]);
  }
  if ((r = m.match(/no such column: (.+)/))) return newRow ? tr('新しい行の式では列（{0}）を使えません', [r[1]]) : tr('列 {0} がありません', [r[1]]);
  if ((r = m.match(/no such function: (.+)/))) return tr('関数 {0} はありません', [r[1]]);
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
    // 複合外部キーでは、各列が自分の参照先の列（refCol）と、組になる列全体（cols・refCols）を持つ
    for (const f of model.fks) {
      f.cols.forEach((col, i) => {
        if (!this.fkByCol.has(col)) this.fkByCol.set(col, { table: f.table, refCol: f.refCols[i], cols: f.cols, refCols: f.refCols });
      });
    }
    this.labelCols = labelCols; // 列名 → 参照先の行のラベルの SQL 式（参照先の別名は __l0）
    const uniq = new Set(model.uniques.filter((u) => u.length === 1).map((u) => u[0]));
    this.columns = model.columns.map((c) => {
      const badges = [];
      const t = c.type || 'ANY';
      badges.push({ text: t, cls: 'type', title: tr('型') });
      if (model.pk.includes(c.name)) badges.push({ text: model.pk.length > 1 ? `🔑${model.pk.indexOf(c.name) + 1}` : '🔑', cls: 'pk', title: model.pk.length > 1 ? tr('複合主キー（{0}）', [model.pk.join(', ')]) : (model.rowidAlias === c.name ? tr('主キー（自動採番）') : tr('主キー')) });
      if (uniq.has(c.name)) badges.push({ text: '◇', cls: 'uq', title: tr('一意（UNIQUE）') });
      const fk = model.fks.find((f) => f.cols.includes(c.name));
      if (fk) badges.push({ text: '→', cls: 'fk', title: tr('外部キー → {0}({1})', [fk.table, fk.refCols.join(', ')]) });
      if (c.notnull && !model.pk.includes(c.name)) badges.push({ text: tr('必須'), cls: 'nn', title: 'NOT NULL' });
      if (c.generated) badges.push({ text: 'ƒ', cls: 'gen', title: tr('生成列: {0}', [c.generated.expr]) });
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
        // STRICT の数値の列は空文字列を入れられないので、入力を空で確定したら NULL にする
        strict: !!model.strict,
        emptyIsNull: !!model.strict && (a === 'INTEGER' || a === 'REAL' || a === 'NUMERIC'),
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
      const lx = c.fk && this.labelCols.get(c.name);
      return lx ? `(SELECT ${lx} FROM ${q(c.fk.table)} AS __l0 WHERE __l0.${q(c.fk.refCol)} = ${this.t}.${q(c.name)} LIMIT 1) AS __l${i}` : null;
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

  /** rowIndexOf をまとめて（行の高さの復元用）。keys と同じ順に、何行目か（見えなければ null）を返す */
  async rowIndexesOf(keys) {
    if (!keys.length) return [];
    const w = this.where();
    const cols = [...new Set(keys.flatMap((k) => Object.keys(k)))];
    const sqlCols = cols.map((c) => (c === '_rowid_' ? '_rowid_' : q(c)));
    const out = new Array(keys.length).fill(null);
    const index = new Map(keys.map((k, i) => [JSON.stringify(cols.map((c) => k[c] ?? null)), i]));
    // 番号付きの並びから、目的の行だけを取り出す（まとめすぎて SQL が長くならないよう分ける）
    for (let s = 0; s < keys.length; s += 200) {
      const part = keys.slice(s, s + 200);
      const cond = part.map((k) => `(${cols.map((c) => `${c === '_rowid_' ? '_rowid_' : q(c)} IS ?`).join(' AND ')})`).join(' OR ');
      const r = await db.query(
        `SELECT rn, ${sqlCols.join(', ')} FROM (SELECT ${sqlCols.map((c) => `${this.t}.${c} AS ${c}`).join(', ')}, ROW_NUMBER() OVER (${this.orderBy().trim()}) - 1 AS rn FROM ${this.t}${w.sql}) WHERE ${cond}`,
        [...w.bind, ...part.flatMap((k) => cols.map((c) => k[c] ?? null))]);
      for (const [rn, ...vals] of r.rows) {
        const i = index.get(JSON.stringify(vals));
        if (i != null) out[i] = Number(rn);
      }
    }
    return out;
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
    const err = new Error(tr('{0}式を計算できません：{1}', [one ? tr('「{0}」の', [one.name]) : '', exprError(e.message, newRow)]));
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

  /**
   * セルの変更と行の追加を、1つのトランザクション（SAVEPOINT）・1つの元に戻す操作として書く。
   * changes: [{row, col, value, rowObj}]、rows: 追加する行の値の配列。更新した行の新しい姿（{row, rowObj}）を返す
   */
  async write(changes, rows) {
    const u = this.updatePlan(changes), i = this.insertPlan(rows);
    const stmts = [...u.stmts, ...i.stmts];
    if (!stmts.length) return [];
    let r;
    try { r = await db.batchTracked(stmts); } catch (e) { throw this.exprFailure(e, [...u.parts, ...i.parts], !changes.length); }
    const out = [];
    if (u.uniform) {
      for (const p of u.plans) {
        const fresh = await this.fetchByKey(p.rowObj.key);
        if (fresh) out.push({ row: p.row, rowObj: fresh });
      }
    } else {
      for (const [k, p] of u.plans.entries()) {
        const ret = r.results[k].rows[0];
        const fresh = ret && await this.fetchByKey(Object.fromEntries(this.keyCols().map((c, j) => [c, ret[j]])));
        if (fresh) out.push({ row: p.row, rowObj: fresh });
      }
    }
    const n = r.results.slice(u.stmts.length).filter((x) => x.rows[0]).length;
    const what = [
      changes.length && (changes.length > 1 ? tr('{0} セルの変更', [changes.length]) : tr('セルの変更')),
      n && (n > 1 ? tr('{0} 行の追加', [n]) : tr('行の追加')),
    ].filter(Boolean).join(tr('・'));
    pushChanges(tr('「{0}」の{1}', [this.model.name, what]), 't:' + this.model.name, r);
    return out;
  }

  update(changes) { return this.write(changes, []); }
  async insert(rows) { await this.write([], rows); }

  /** セルの変更の文。plans は行ごとの変更、uniform は同じ値を複数行にまとめた UPDATE のとき真 */
  updatePlan(changes) {
    const byRow = new Map();
    for (const ch of changes) {
      if (!byRow.has(ch.row)) byRow.set(ch.row, { rowObj: ch.rowObj, cols: [], parts: [] });
      const col = this.model.columns[ch.col];
      const r = byRow.get(ch.row);
      r.cols.push(col); r.parts.push(this.toSqlPart(ch.value, col, false));
    }
    const plans = [...byRow.entries()].map(([row, r]) => ({ row, ...r }));
    const parts = plans.flatMap((p) => p.parts);
    const uniform = this.uniformUpdate(plans);
    if (uniform) return { plans, parts, stmts: uniform.stmts, uniform: true };
    // 式はこの UPDATE の中で計算され、RETURNING で計算結果と新しいキーを受け取る
    const stmts = plans.map(({ rowObj, cols, parts }) => {
      const kw = this.keyWhere(rowObj.key);
      return {
        sql: `UPDATE ${this.t} SET ${cols.map((c, i) => `${q(c.name)} = ${parts[i].sql}`).join(', ')} WHERE ${kw.sql} RETURNING ${[...this.returningKey(), ...cols.map((c) => q(c.name))].join(', ')}`,
        bind: [...parts.flatMap((p) => p.bind ?? []), ...kw.bind],
        checks: parts.filter((p) => p.check).map((p) => p.check),
      };
    });
    return { plans, parts, stmts, uniform: false };
  }

  /**
   * 複数行に、列ごとに同じ値を入れる変更なら、WHERE キー IN (…) の UPDATE にまとめた文を返す（行数が多ければ分ける）。
   * キー列を変える・行ごとに値や列が違うときは null（行ごとの文にする）
   */
  uniformUpdate(plans) {
    if (plans.length < 2) return null;
    const [first] = plans;
    const keyCols = this.keyCols();
    if (first.cols.some((c) => this.model.pk.includes(c.name))) return null;
    const samePart = (a, b) => a.sql === b.sql && (a.bind ?? []).length === (b.bind ?? []).length
      && (a.bind ?? []).every((v, i) => sameValue(v, b.bind[i]));
    for (const p of plans.slice(1)) {
      if (p.cols.length !== first.cols.length || p.cols.some((c, i) => c !== first.cols[i])) return null;
      if (p.parts.some((part, i) => !samePart(part, first.parts[i]))) return null;
    }
    const set = first.cols.map((c, i) => `${q(c.name)} = ${first.parts[i].sql}`).join(', ');
    const setBind = first.parts.flatMap((p) => p.bind ?? []);
    const checks = first.parts.filter((p) => p.check).map((p) => p.check);
    const keySql = keyCols.map((k) => (k === '_rowid_' ? '_rowid_' : q(k)));
    const CHUNK = 500;
    const stmts = [];
    for (let s = 0; s < plans.length; s += CHUNK) {
      const part = plans.slice(s, s + CHUNK);
      const keyBind = part.flatMap((p) => keyCols.map((k) => p.rowObj.key[k]));
      const where = keyCols.length === 1
        ? `${keySql[0]} IN (${part.map(() => '?').join(', ')})`
        : `(${keySql.join(', ')}) IN (VALUES ${part.map(() => `(${keyCols.map(() => '?').join(', ')})`).join(', ')})`;
      stmts.push({ sql: `UPDATE ${this.t} SET ${set} WHERE ${where}`, bind: [...setBind, ...keyBind], checks: s === 0 ? checks : [] });
    }
    return { stmts };
  }

  /** 行の追加の文 */
  insertPlan(rows) {
    const parts = [];
    const stmts = rows.map((vals) => {
      const cols = [], ps = [];
      vals.forEach((v, c) => {
        if (v === undefined) return;
        const col = this.model.columns[c];
        cols.push(col); ps.push(this.toSqlPart(v, col, true));
      });
      parts.push(...ps);
      const ret = ` RETURNING ${this.returningKey().join(', ')}`;
      return {
        sql: cols.length
          ? `INSERT INTO ${this.t} (${cols.map((c) => q(c.name)).join(', ')}) VALUES (${ps.map((p) => p.sql).join(', ')})${ret}`
          : `INSERT INTO ${this.t} DEFAULT VALUES${ret}`,
        bind: ps.flatMap((p) => p.bind ?? []),
        checks: ps.filter((p) => p.check).map((p) => p.check),
      };
    });
    return { parts, stmts };
  }

  async deleteRows(rowObjs) {
    const r = await db.batchTracked(rowObjs.map((x) => this.deleteStmt(x.key)));
    pushChanges(tr('「{0}」の{1}', [this.model.name, rowObjs.length > 1 ? tr('{0} 行の削除', [rowObjs.length]) : tr('行の削除')]), 't:' + this.model.name, r);
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
    // 包む前に、ユーザーの SQL そのものが読み取りの1文か確かめる（UPDATE などに分かりやすいエラーを出す）
    await db.checkQuery(this.sql);
    const r = await db.readQuery(`SELECT * FROM (${this.sql}\n) LIMIT 0`);
    this.columns = r.columns.map((name) => ({
      name, badges: [],
      sort: sortInfo(this.view.sorts, name),
      filtered: this.view.filters.some((f) => f.col === name),
    }));
    // 先頭行から数値列を推定して右寄せ
    const s = await db.readQuery(`SELECT * FROM (${this.sql}\n) LIMIT 50`);
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
    const r = await db.readQuery(`SELECT count(*) FROM (${this.sql}\n)${w.sql}`, w.bind);
    return Number(r.rows[0][0]);
  }

  async fetch(offset, limit) {
    const w = this.where();
    const r = await db.readQuery(`SELECT * FROM (${this.sql}\n)${w.sql}${this.orderBy()} LIMIT ? OFFSET ?`, [...w.bind, limit, offset]);
    return r.rows.map((values) => ({ values }));
  }
}

// ------------------------------------------------------------------------

/** ビューの INSTEAD OF トリガーの種類。{update, insert, delete, triggers:[{name, op}]} */
export async function viewWriteOps(name) {
  const r = await db.query(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?`, [name]);
  const ops = { update: false, insert: false, delete: false, triggers: [] };
  for (const [tname, sql] of r.rows) {
    const m = /\bINSTEAD\s+OF\s+(UPDATE|INSERT|DELETE)\b/i.exec(sql || '');
    if (!m) continue;
    const op = m[1].toLowerCase();
    ops[op] = true;
    ops.triggers.push({ name: tname, op });
  }
  return ops;
}

/**
 * INSTEAD OF トリガーのあるビュー。書き込みはビューへの UPDATE / INSERT / DELETE で、中身はトリガーに任せる。
 * ビューには行の鍵がないので、行は全列の値で見分ける（同じ値の行が複数あればまとめて変わる）
 */
export class ViewSource extends QuerySource {
  constructor(widthKey, name, view, ops) {
    super(widthKey, `SELECT * FROM ${q(name)}`, view);
    this.name = name;
    this.t = q(name);
    this.ops = ops;
    this.editable = ops.update || ops.insert || ops.delete;
  }

  async init() {
    await super.init();
    const info = await db.query(`SELECT name, type FROM pragma_table_info(?)`, [this.name]);
    const types = new Map(info.rows.map(([n, t]) => [n, t]));
    for (const c of this.columns) c.type = types.get(c.name) || '';
    return this;
  }

  rowWhere(rowObj) {
    return { sql: this.columns.map((c) => `${q(c.name)} IS ?`).join(' AND '), bind: rowObj.values.slice(0, this.columns.length) };
  }

  toSqlPart(v, col, newRow) { return TableSource.prototype.toSqlPart.call(this, v, col, newRow); }

  async run(stmts, what, n) {
    const r = await db.batchTracked(stmts);
    pushChanges(tr('「{0}」の{1}', [this.name, what(n)]), 'v:' + this.name, r);
  }

  /** 書き込み後はどの行がどこへ行ったか分からないので null（読み直してもらう） */
  async update(changes) {
    if (!this.ops.update) throw new Error(tr('このビューは編集できません'));
    const byRow = new Map();
    for (const ch of changes) {
      if (!byRow.has(ch.row)) byRow.set(ch.row, { rowObj: ch.rowObj, cols: [], parts: [] });
      const col = this.columns[ch.col];
      const r = byRow.get(ch.row);
      r.cols.push(col); r.parts.push(this.toSqlPart(ch.value, col, false));
    }
    const stmts = [...byRow.values()].map(({ rowObj, cols, parts }) => {
      const w = this.rowWhere(rowObj);
      return {
        sql: `UPDATE ${this.t} SET ${cols.map((c, i) => `${q(c.name)} = ${parts[i].sql}`).join(', ')} WHERE ${w.sql}`,
        bind: [...parts.flatMap((p) => p.bind ?? []), ...w.bind],
        checks: parts.filter((p) => p.check).map((p) => p.check),
      };
    });
    // 元の行がそのまま残っていれば、トリガーがその変更を扱わなかった（同じ値の行の数で比べる）
    const plans = [...byRow.values()].filter(({ rowObj, cols, parts }) => cols.some((c, i) =>
      parts[i].sql !== '?' || !sameValue(parts[i].bind[0], rowObj.values[this.columns.indexOf(c)])));
    const before = await Promise.all(plans.map((p) => this.countLike(p.rowObj)));
    await this.run(stmts, (n) => (n > 1 ? tr('{0} セルの変更', [n]) : tr('セルの変更')), changes.length);
    const after = await Promise.all(plans.map((p) => this.countLike(p.rowObj)));
    if (plans.some((p, i) => after[i] >= before[i])) this.onNotice?.(tr('変更がビューに反映されませんでした（トリガーがこの列を扱っていない可能性があります）'));
    return null;
  }

  /** ビューは変更と追加を別々に書く（それぞれ元に戻す1操作）。戻り値は update と同じ（変更があれば null） */
  async write(changes, rows) {
    const res = changes.length ? await this.update(changes) : [];
    if (rows.length) await this.insert(rows);
    return res;
  }

  async insert(rows) {
    if (!this.ops.insert) throw new Error(tr('このビューには行を追加できません'));
    const stmts = rows.map((vals) => {
      const cols = [], parts = [];
      vals.forEach((v, c) => {
        if (v === undefined) return;
        cols.push(this.columns[c]); parts.push(this.toSqlPart(v, this.columns[c], true));
      });
      return {
        sql: cols.length
          ? `INSERT INTO ${this.t} (${cols.map((c) => q(c.name)).join(', ')}) VALUES (${parts.map((p) => p.sql).join(', ')})`
          : `INSERT INTO ${this.t} DEFAULT VALUES`,
        bind: parts.flatMap((p) => p.bind ?? []),
        checks: parts.filter((p) => p.check).map((p) => p.check),
      };
    });
    const before = await this.countAll();
    await this.run(stmts, (n) => (n > 1 ? tr('{0} 行の追加', [n]) : tr('行の追加')), rows.length);
    if (await this.countAll() - before < rows.length) this.onNotice?.(tr('追加した行は、このビューの条件に合わないため表示されていません'));
  }

  /** ビュー全体（絞り込みなし）の行数 */
  async countAll() { return Number((await db.readQuery(`SELECT count(*) FROM ${this.t}`)).rows[0][0]); }

  /** その行と全列が同じ値の行の数 */
  async countLike(rowObj) {
    const w = this.rowWhere(rowObj);
    return Number((await db.readQuery(`SELECT count(*) FROM ${this.t} WHERE ${w.sql}`, w.bind)).rows[0][0]);
  }

  async deleteRows(rowObjs) {
    if (!this.ops.delete) throw new Error(tr('このビューの行は削除できません'));
    const stmts = rowObjs.map((x) => { const w = this.rowWhere(x); return { sql: `DELETE FROM ${this.t} WHERE ${w.sql}`, bind: w.bind }; });
    await this.run(stmts, (n) => (n > 1 ? tr('{0} 行の削除', [n]) : tr('行の削除')), rowObjs.length);
  }

  async duplicateRows(rowObjs) {
    await this.insert(rowObjs.map((r) => r.values.slice(0, this.columns.length)));
  }
}
