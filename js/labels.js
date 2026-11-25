// ラベル列：シートの行を何と呼ぶか（外部キーで参照されたときに出す名前）
// シートごとに列を1つ選ぶ（端末側 label:<DB>/<シート>）。選んでいなければ自動（主キーでない最初の文字の列）。
// 外部キーの列を選んだら、参照先の行のラベルをたどる。たどり先は副問い合わせにして、行を読む SELECT の中に入れる
import { q } from './db-client.js';
import { affinity } from './schema.js';

const keyOf = (dbName, table) => `label:${dbName}/${table}`;

/** 選んだラベル列の名前（自動なら null） */
export function getLabelColumn(dbName, table) {
  try { return localStorage.getItem(keyOf(dbName, table)) || null; } catch { return null; }
}

export function setLabelColumn(dbName, table, col) {
  try { col ? localStorage.setItem(keyOf(dbName, table), col) : localStorage.removeItem(keyOf(dbName, table)); } catch { /* 無視 */ }
}

/** 表の列の情報：{ cols: [{name, type, pk}], fks: Map(列名 → {table, refCol}) } */
async function tableInfo(db, table, cache) {
  if (cache.has(table)) return cache.get(table);
  let info = null;
  try {
    const cols = (await db.query('SELECT name, type, pk FROM pragma_table_info(?) ORDER BY cid', [table])).rows
      .map(([name, type, pk]) => ({ name, type, pk: pk > 0 }));
    const fks = new Map();
    if (cols.length) {
      const rows = (await db.query('SELECT id, "from", "table", "to" FROM pragma_foreign_key_list(?)', [table])).rows;
      const byId = new Map();
      for (const [id, from, t, to] of rows) (byId.get(id) || byId.set(id, []).get(id)).push({ from, t, to });
      for (const parts of byId.values()) if (parts.length === 1) fks.set(parts[0].from, { table: parts[0].t, refCol: parts[0].to });
      info = { cols, fks };
    }
  } catch { /* 無い表 */ }
  cache.set(table, info);
  return info;
}

/** 自動で選ぶラベル列：主キーでなく、参照される列（except）でもない最初の文字の列 */
export function autoLabel(cols, except) {
  return cols.find((c) => !c.pk && c.name !== except && affinity(c.type) === 'TEXT')?.name ?? null;
}

/**
 * 表 table のラベル列の名前（設定が無いか、無い列なら自動）。except は自動のときに避ける列
 */
export async function labelColumnOf(db, dbName, table, except, cache = new Map()) {
  const info = await tableInfo(db, table, cache);
  if (!info) return null;
  const set = getLabelColumn(dbName, table);
  return set && info.cols.some((c) => c.name === set) ? set : autoLabel(info.cols, except);
}

/**
 * 表 table の行のラベルの SQL 式。alias はその表の別名（式はこの別名の列を指す）。
 * except は参照してきた列（自動のときに避ける）。たどれなければ null
 */
export async function labelExpr(db, dbName, table, alias, except, { cache = new Map(), seen = new Set(), depth = 0 } = {}) {
  const col = await labelColumnOf(db, dbName, table, except, cache);
  if (!col) return null;
  const own = `${alias}.${q(col)}`;
  const fk = (await tableInfo(db, table, cache))?.fks.get(col);
  // 外部キーなら参照先のラベルへ。循環したら（または深すぎたら）値そのもの
  if (!fk || seen.has(table) || depth >= 8) return own;
  const sub = `__l${depth + 1}`;
  const inner = await labelExpr(db, dbName, fk.table, sub, fk.refCol, { cache, seen: new Set([...seen, table]), depth: depth + 1 });
  if (!inner) return own;
  return `COALESCE((SELECT ${inner} FROM ${q(fk.table)} AS ${sub} WHERE ${sub}.${q(fk.refCol)} = ${own} LIMIT 1), ${own})`;
}
