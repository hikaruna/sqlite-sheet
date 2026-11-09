// スキーマの読み取りと、テーブル定義（モデル）から CREATE TABLE を生成する処理
import { db, q } from './db-client.js';

export const APP_PREFIX = '_sqlite_sheet_';
export const TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY'];
export const FK_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

/** シート一覧（テーブル・ビュー）。アプリ用・内部テーブルは除外 */
export async function listObjects() {
  const r = await db.query(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '${APP_PREFIX}%'
     ORDER BY rowid`);
  return r.rows.map(([type, name, sql]) => ({ type, name, sql }));
}

// ---------- CREATE TABLE の軽量パーサ（CHECK・COLLATE・生成列など pragma で取れない情報用） ----------

function tokenize(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) { if (close !== ']' && sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      out.push({ t: c === "'" ? 'str' : 'id', v: sql.slice(i, j + 1), s: i, e: j + 1 });
      i = j + 1; continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i; while (j < sql.length && /[\w$\u0080-￿]/.test(sql[j])) j++;
      out.push({ t: 'word', v: sql.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i; while (j < sql.length && /[0-9.eExX+a-fA-F]/.test(sql[j]) && !(/[+]/.test(sql[j]) && !/[eE]/.test(sql[j - 1]))) j++;
      out.push({ t: 'num', v: sql.slice(i, j), s: i, e: j }); i = j; continue;
    }
    out.push({ t: 'op', v: c, s: i, e: i + 1 }); i++;
  }
  return out;
}

const unq = (v) => {
  if (/^["`]/.test(v)) return v.slice(1, -1).replaceAll(v[0] + v[0], v[0]);
  if (v[0] === '[') return v.slice(1, -1);
  return v;
};
const kw = (tok, w) => tok && tok.t === 'word' && tok.v.toUpperCase() === w;

/** 括弧の対応を取りつつ、トップレベルのカンマで分割 */
function splitTop(tokens) {
  const items = []; let cur = []; let depth = 0;
  for (const t of tokens) {
    if (t.v === '(') depth++;
    if (t.v === ')') depth--;
    if (t.v === ',' && depth === 0) { items.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) items.push(cur);
  return items;
}

function parenEnd(tokens, i) {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j].v === '(') depth++;
    if (tokens[j].v === ')') { depth--; if (depth === 0) return j; }
  }
  return tokens.length - 1;
}

/** CREATE TABLE 文から列ごとの追加情報と表レベル CHECK を抜き出す */
export function parseCreateTable(sql) {
  const res = { columns: {}, checks: [], strict: false, withoutRowid: false, autoincrement: false };
  if (!sql) return res;
  const tokens = tokenize(sql);
  const open = tokens.findIndex((t) => t.v === '(');
  if (open < 0) return res;
  const close = parenEnd(tokens, open);
  const tail = tokens.slice(close + 1).map((t) => t.v.toUpperCase()).join(' ');
  res.strict = /\bSTRICT\b/.test(tail);
  res.withoutRowid = /\bWITHOUT\s+ROWID\b/.test(tail);
  const text = (a, b) => sql.slice(tokens[a].s, tokens[b].e);
  for (const item of splitTop(tokens.slice(open + 1, close))) {
    if (!item.length) continue;
    const head = item[0].v.toUpperCase();
    if (item[0].t === 'word' && ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(head)) {
      // 表レベル制約。CHECK だけ保持（PK/UNIQUE/FK は pragma から）
      let k = 0;
      if (head === 'CONSTRAINT') k = 2;
      if (kw(item[k], 'CHECK')) {
        const a = item.indexOf(item[k + 1]);
        const b = parenEnd(item, a);
        res.checks.push(sql.slice(item[a + 1].s, item[b - 1].e));
      }
      continue;
    }
    const name = unq(item[0].v);
    const col = { check: null, collate: null, generated: null, defaultSql: null };
    for (let k = 1; k < item.length; k++) {
      const t = item[k];
      if (kw(t, 'CHECK') && item[k + 1]?.v === '(') {
        const b = parenEnd(item, k + 1);
        col.check = sql.slice(item[k + 2].s, item[b - 1].e); k = b;
      } else if (kw(t, 'COLLATE') && item[k + 1]) {
        col.collate = unq(item[k + 1].v); k++;
      } else if (kw(t, 'AUTOINCREMENT')) {
        res.autoincrement = true;
      } else if (kw(t, 'DEFAULT') && item[k + 1]) {
        const n = item[k + 1];
        if (n.v === '(') { const b = parenEnd(item, k + 1); col.defaultSql = sql.slice(n.s, item[b].e); k = b; }
        else if ((n.v === '-' || n.v === '+') && item[k + 2]) { col.defaultSql = n.v + item[k + 2].v; k += 2; }
        else { col.defaultSql = n.v; k++; }
      } else if ((kw(t, 'AS') || kw(t, 'GENERATED')) && !col.generated) {
        let j = k; while (j < item.length && item[j].v !== '(') j++;
        if (j >= item.length) continue;
        const b = parenEnd(item, j);
        const stored = kw(item[b + 1], 'STORED');
        col.generated = { expr: sql.slice(item[j + 1].s, item[b - 1].e), stored };
        k = b;
      }
    }
    res.columns[name] = col;
  }
  void text;
  return res;
}

// ---------- テーブル情報の読み取り ----------

/** テーブル定義をモデルとして読み取る */
export async function readTable(name) {
  const [{ rows: [[sql]] }, xinfo, fkl, idxl] = await Promise.all([
    db.query(`SELECT sql FROM sqlite_schema WHERE type='table' AND name=?`, [name]),
    db.query(`SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?)`, [name]),
    db.query(`SELECT id,seq,"table","from","to",on_update,on_delete FROM pragma_foreign_key_list(?) ORDER BY id,seq`, [name]),
    db.query(`SELECT name,"unique",origin,partial FROM pragma_index_list(?)`, [name]),
  ]);
  const parsed = parseCreateTable(sql);
  const columns = xinfo.rows.map(([cid, cname, type, notnull, dflt, pk, hidden]) => {
    const extra = parsed.columns[cname] || {};
    return {
      name: cname,
      type: type || '',
      notnull: !!notnull,
      defaultSql: hidden ? null : (dflt ?? null),
      check: extra.check ?? null,
      collate: extra.collate ?? null,
      generated: hidden === 2 || hidden === 3 ? (extra.generated || { expr: 'NULL', stored: hidden === 3 }) : null,
      pkOrder: pk,
    };
  });
  const pk = columns.filter((c) => c.pkOrder > 0).sort((a, b) => a.pkOrder - b.pkOrder).map((c) => c.name);

  const fkMap = new Map();
  for (const [id, , table, from, to, onUpdate, onDelete] of fkl.rows) {
    if (!fkMap.has(id)) fkMap.set(id, { cols: [], table, refCols: [], onUpdate, onDelete });
    const f = fkMap.get(id);
    f.cols.push(from); f.refCols.push(to);
  }
  const fks = [...fkMap.values()].reverse(); // pragma は宣言と逆順に id を振る
  // to が NULL（参照先の主キーを暗黙に指す）なら補う
  for (const f of fks) {
    if (f.refCols.some((c) => c == null)) {
      const ref = await db.query(`SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk`, [f.table]);
      f.refCols = ref.rows.map((r) => r[0]);
    }
  }

  const uniques = [];
  const indexes = [];
  for (const [iname, unique, origin, partial] of idxl.rows) {
    const cols = (await db.query(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, [iname])).rows.map((r) => r[0]);
    if (origin === 'u') uniques.push(cols);
    else if (origin === 'c') {
      const s = (await db.query(`SELECT sql FROM sqlite_schema WHERE name=?`, [iname])).rows[0]?.[0];
      indexes.push({ name: iname, unique: !!unique, cols, partial: !!partial, sql: s });
    }
  }
  uniques.reverse();

  const triggers = (await db.query(`SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?`, [name])).rows
    .map(([n, s]) => ({ name: n, sql: s }));

  const rowidAlias = pk.length === 1 && !parsed.withoutRowid
    && columns.find((c) => c.name === pk[0])?.type.toUpperCase() === 'INTEGER' ? pk[0] : null;

  return {
    name, sql, columns, pk, uniques, fks, indexes, triggers,
    checks: parsed.checks,
    strict: parsed.strict,
    withoutRowid: parsed.withoutRowid,
    autoincrement: parsed.autoincrement,
    rowidAlias,
  };
}

// ---------- モデル → SQL ----------

export function columnDef(c, model) {
  let s = q(c.name);
  if (c.type) s += ' ' + c.type;
  const singlePk = model && model.pk.length === 1 && model.pk[0] === c.name;
  if (singlePk) {
    s += ' PRIMARY KEY';
    if (model.autoincrement && c.type.toUpperCase() === 'INTEGER') s += ' AUTOINCREMENT';
  }
  if (c.notnull && !singlePk) s += ' NOT NULL';
  else if (c.notnull && singlePk && c.type.toUpperCase() !== 'INTEGER') s += ' NOT NULL';
  if (c.collate) s += ' COLLATE ' + c.collate;
  if (c.generated) {
    s += ` GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
  } else if (c.defaultSql != null && c.defaultSql !== '') {
    const d = c.defaultSql.trim();
    s += ' DEFAULT ' + (/^[-+]?[\d.]+$|^'.*'$|^\(.*\)$|^NULL$|^CURRENT_(TIME|DATE|TIMESTAMP)$|^TRUE$|^FALSE$|^X'[0-9a-f]*'$/is.test(d) ? d : `(${d})`);
  }
  if (c.check) s += ` CHECK (${c.check})`;
  return s;
}

export function createTableSql(model, name = model.name) {
  const lines = model.columns.map((c) => '  ' + columnDef(c, model));
  if (model.pk.length > 1) lines.push(`  PRIMARY KEY (${model.pk.map(q).join(', ')})`);
  for (const u of model.uniques) if (u.length) lines.push(`  UNIQUE (${u.map(q).join(', ')})`);
  for (const f of model.fks) {
    if (!f.cols.length || !f.table) continue;
    let s = `  FOREIGN KEY (${f.cols.map(q).join(', ')}) REFERENCES ${q(f.table)}`;
    if (f.refCols.length && f.refCols.every(Boolean)) s += ` (${f.refCols.map(q).join(', ')})`;
    if (f.onUpdate && f.onUpdate !== 'NO ACTION') s += ' ON UPDATE ' + f.onUpdate;
    if (f.onDelete && f.onDelete !== 'NO ACTION') s += ' ON DELETE ' + f.onDelete;
    lines.push(s);
  }
  for (const ch of model.checks) if (ch.trim()) lines.push(`  CHECK (${ch})`);
  const opts = [];
  if (model.withoutRowid) opts.push('WITHOUT ROWID');
  if (model.strict) opts.push('STRICT');
  return `CREATE TABLE ${q(name)} (\n${lines.join(',\n')}\n)${opts.length ? ' ' + opts.join(', ') : ''}`;
}

/**
 * 旧モデル → 新モデルへの変更 SQL を作る。
 * 名前変更だけ・列追加だけなら ALTER TABLE、それ以外は公式手順のテーブル再作成。
 * columns の各要素は from（元の列名、新規列なら null）を持つ。
 */
export function migrationSql(oldM, newM, origName = oldM.name) {
  const stmts = [];
  const tmp = APP_PREFIX + 'new_' + newM.name;
  stmts.push(createTableSql(newM, tmp));
  const kept = newM.columns.filter((c) => c.from && !c.generated && oldM.columns.find((o) => o.name === c.from && !o.generated));
  if (kept.length) {
    stmts.push(`INSERT INTO ${q(tmp)} (${kept.map((c) => q(c.name)).join(', ')}) SELECT ${kept.map((c) => q(c.from)).join(', ')} FROM ${q(oldM.name)}`);
  }
  stmts.push(`DROP TABLE ${q(oldM.name)}`);
  stmts.push(`ALTER TABLE ${q(tmp)} RENAME TO ${q(newM.name)}`);
  // 列名変更に合わせてインデックス・トリガーを作り直す（単純な置換で対応できるものだけ）
  const renames = new Map(newM.columns.filter((c) => c.from && c.from !== c.name).map((c) => [c.from, c.name]));
  const dropped = new Set(oldM.columns.map((c) => c.name).filter((n) => !newM.columns.some((c) => c.from === n)));
  for (const idx of oldM.indexes) {
    if (!idx.sql || idx.cols.some((c) => dropped.has(c))) continue;
    stmts.push(renameIdents(idx.sql, renames, origName, newM.name));
  }
  for (const tr of oldM.triggers) stmts.push(renameIdents(tr.sql, renames, origName, newM.name));
  return stmts;
}

function renameIdents(sql, renames, oldTable, newTable) {
  const tokens = tokenize(sql);
  let out = ''; let pos = 0;
  for (const t of tokens) {
    if (t.t !== 'id' && t.t !== 'word') continue;
    const name = unq(t.v);
    let rep = null;
    if (renames.has(name)) rep = q(renames.get(name));
    else if (name === oldTable && oldTable !== newTable) rep = q(newTable);
    if (rep) { out += sql.slice(pos, t.s) + rep; pos = t.e; }
  }
  return out + sql.slice(pos);
}

/** テーブル名変更・ビューの作成などで使う、型名の簡易分類 */
export function affinity(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'TEXT';
  if (t.includes('BLOB') || t === '') return t === '' ? 'ANY' : 'BLOB';
  if (/REAL|FLOA|DOUB/.test(t)) return 'REAL';
  if (t === 'ANY') return 'ANY';
  return 'NUMERIC';
}
