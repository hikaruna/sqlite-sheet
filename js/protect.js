// 保護（Google スプレッドシートの「保護されたシートと範囲」）。
// 保護はトリガーそのもの：書き込みを SQLite が拒否する。アプリはトリガーを読んで見た目を合わせるだけ。
// 1つの保護 = 同じ番号を持つトリガーの組（protect_<番号>_<種類>）。説明などはトリガー本体のコメントに書く。
import { q, lit } from './db-client.js';

const NAME_RE = /^protect_(\d+)_(ins|upd|del|key)$/;
const META_RE = /-- sqlite-sheet:protect (\{.*\})/;

/** model.triggers から保護の一覧を読む。[{id, kind, note, cols, keys, triggers}] */
export function readProtections(model) {
  const byId = new Map();
  for (const t of model.triggers) {
    const m = t.name.match(NAME_RE);
    if (!m) continue;
    const id = +m[1];
    if (!byId.has(id)) byId.set(id, { id, kind: 'sheet', note: '', cols: null, keys: null, triggers: [] });
    const p = byId.get(id);
    p.triggers.push(t.name);
    const meta = t.sql.match(META_RE);
    if (meta) { try { Object.assign(p, pickMeta(JSON.parse(meta[1]))); } catch { /* 壊れたコメントは無視 */ } }
    // 列は SQL から読む（列名を変えると SQLite がトリガーの SQL を書き換えるので、コメントより確か）
    if (m[2] === 'upd') { const cols = updateOfCols(t.sql); if (cols) p.cols = cols; }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

const pickMeta = ({ kind, note, keys }) => ({ kind, note: note || '', keys: keys || null });

/** CREATE TRIGGER … UPDATE OF "a", "b" ON … の列名 */
function updateOfCols(sql) {
  const m = sql.match(/\bUPDATE\s+OF\s+([\s\S]+?)\s+ON\s/i);
  if (!m) return null;
  return [...m[1].matchAll(/"((?:[^"]|"")*)"|([^\s,"]+)/g)].map((x) => (x[1] != null ? x[1].replaceAll('""', '"') : x[2]));
}

/** 行を識別できるか（主キーが必要。rowid は表の作り直しで振り直されることがある） */
export const canProtectRows = (model) => model.pk.length > 0;

/**
 * 保護を作る SQL。spec: {kind:'sheet'|'cols'|'rows'|'range', cols?:[列名], keys?:[[主キーの値…]], note?}
 * existing: DB 内の全トリガー名（番号の重複を避ける）
 */
export function protectSql(model, spec, existing) {
  let id = 1;
  for (const n of existing) { const m = n.match(NAME_RE); if (m) id = Math.max(id, +m[1] + 1); }
  const t = q(model.name);
  const meta = JSON.stringify({ kind: spec.kind, note: spec.note || '', keys: spec.keys || undefined });
  const msg = '保護されています' + (spec.note ? `：${spec.note}` : `（${describe(model, spec)}）`);
  const body = `BEGIN\n  -- sqlite-sheet:protect ${meta}\n  SELECT RAISE(ABORT, ${lit(msg)});\nEND`;
  const trig = (op, event, when) => `CREATE TRIGGER ${q(`protect_${id}_${op}`)} BEFORE ${event} ON ${t}${when ? `\nWHEN ${when}` : ''}\n${body}`;
  const ofCols = (cols) => `UPDATE OF ${cols.map(q).join(', ')}`;
  const keyIn = spec.keys ? keyInSql(model, spec.keys) : null;
  const stmts = [];
  if (spec.kind === 'sheet') {
    stmts.push(trig('ins', 'INSERT'), trig('upd', 'UPDATE'), trig('del', 'DELETE'));
  } else if (spec.kind === 'cols') {
    stmts.push(trig('upd', ofCols(spec.cols)));
  } else if (spec.kind === 'rows') {
    stmts.push(trig('upd', 'UPDATE', keyIn), trig('del', 'DELETE', keyIn));
  } else if (spec.kind === 'range') {
    stmts.push(trig('upd', ofCols(spec.cols), keyIn), trig('del', 'DELETE', keyIn));
    // 主キーが書き換わると保護が別の行へずれるので、保護した行の主キーも動かせないようにする
    if (!model.pk.every((p) => spec.cols.includes(p))) stmts.push(trig('key', ofCols(model.pk), keyIn));
  }
  return stmts.map((sql) => ({ sql }));
}

function keyInSql(model, keys) {
  if (model.pk.length === 1) return `OLD.${q(model.pk[0])} IN (${keys.map((k) => lit(k[0])).join(', ')})`;
  return `(${model.pk.map((p) => `OLD.${q(p)}`).join(', ')}) IN (VALUES ${keys.map((k) => `(${k.map(lit).join(', ')})`).join(', ')})`;
}

export const unprotectSql = (p) => p.triggers.map((n) => ({ sql: `DROP TRIGGER ${q(n)}` }));

/** 人が読む説明：「シート全体」「列 名前, メール」「3 行」「3 行 × 列 名前」 */
export function describe(model, p) {
  const keyCol = model.pk.join(', ');
  const rows = p.keys ? (p.keys.length <= 3 ? `${keyCol} が ${p.keys.map((k) => k.join('/')).join(', ')} の行` : `${p.keys.length} 行`) : '';
  if (p.kind === 'sheet') return 'シート全体';
  if (p.kind === 'cols') return `列 ${p.cols.join(', ')}`;
  if (p.kind === 'rows') return rows;
  return `${rows}の ${p.cols.join(', ')}`;
}

export const KIND_ICON = { sheet: '▦', cols: '▥', rows: '▤', range: '▣' };

/**
 * セルにかかっている保護を調べる関数を作る。(rowValues | null, 列番号) → 保護の配列
 * rowValues が null（新しい行）ならシート全体の保護だけを見る
 */
export function protectionChecker(model, prots) {
  if (!prots.length) return null;
  const pkIdx = model.pk.map((p) => model.columns.findIndex((c) => c.name === p));
  const keyOf = (vals) => JSON.stringify(pkIdx.map((i) => normKey(vals[i])));
  const prepared = prots.map((p) => ({
    p,
    cols: p.cols ? new Set(p.cols.map((n) => model.columns.findIndex((c) => c.name === n))) : null,
    keys: p.keys ? new Set(p.keys.map((k) => JSON.stringify(k.map(normKey)))) : null,
  }));
  return (vals, c) => {
    const out = [];
    let key;
    for (const x of prepared) {
      if (x.p.kind === 'sheet') { out.push(x.p); continue; }
      if (x.cols && !x.cols.has(c)) continue;
      if (x.keys) { if (!vals) continue; key ??= keyOf(vals); if (!x.keys.has(key)) continue; }
      out.push(x.p);
    }
    return out;
  };
}

// 主キーの値を JSON で比べられる形に（bigint は文字列化）
const normKey = (v) => (typeof v === 'bigint' ? v.toString() : v);
