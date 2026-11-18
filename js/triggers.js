// テーブル・ビューのトリガーを GUI で一覧・追加・編集・削除する画面。
// 保護（protect_*）のトリガーは保護の機能が管理するので、ここには出さない。
// 変更はトリガーの一覧の「前」と「後」を丸ごと覚えておき、元に戻す・やり直すで入れ替える
import { t as tr } from './i18n.js';
import { db, q } from './db-client.js';
import { el, modal, confirmDialog, toast } from './ui.js';
import { friendlyError } from './sources.js';
import { undo } from './undo.js';

const isProtect = (n) => /^protect_\d+_/.test(n);

async function listTriggers(table) {
  const r = await db.query(`SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`, [table]);
  return r.rows.map(([name, sql]) => ({ name, sql })).filter((t) => !isProtect(t.name));
}

/** 「INSTEAD OF UPDATE」「AFTER INSERT」など、いつ動くか */
export function triggerEvent(sql) {
  const m = /\bTRIGGER\b[\s\S]*?\b(BEFORE|AFTER|INSTEAD\s+OF)?\s*\b(INSERT|UPDATE|DELETE)\b/i.exec(sql || '');
  if (!m) return '';
  return `${(m[1] || 'BEFORE').toUpperCase().replace(/\s+/, ' ')} ${m[2].toUpperCase()}`;
}

/** 1文の CREATE TRIGGER か確かめ、末尾を整えて返す（後ろに別の文を続けられないように） */
async function normalize(sql) {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(s)) throw new Error(tr('CREATE TRIGGER で始まる SQL を書いてください'));
  await db.checkTrigger(s + ';');
  return s;
}

/** 今のトリガーを全部消して、list のとおりに作る文 */
async function replaceStmts(table, list) {
  const now = await listTriggers(table);
  return [...now.map((t) => ({ sql: `DROP TRIGGER ${q(t.name)}` })), ...list.map((t) => ({ sql: t.sql }))];
}

const uniqueName = (base, names) => { let n = base, i = 2; while (names.includes(n)) n = `${base}_${i++}`; return n; };

/** 雛形は CREATE TRIGGER … BEGIN と END だけ。中身はユーザーが書く */
async function templates(table, isView) {
  const names = (await db.query(`SELECT name FROM sqlite_schema WHERE type = 'trigger'`)).rows.map(([n]) => n);
  const when = isView ? 'INSTEAD OF' : 'AFTER';
  const ops = isView ? ['UPDATE', 'INSERT', 'DELETE'] : ['INSERT', 'UPDATE', 'DELETE'];
  return ops.map((op) => {
    const name = uniqueName(isView ? `${table}_${op.toLowerCase()}` : `${table}_after_${op.toLowerCase()}`, names);
    return { op, sql: `CREATE TRIGGER ${q(name)} ${when} ${op} ON ${q(table)}\nBEGIN\n  \nEND` };
  });
}

/**
 * トリガーの画面を開く。kind: 't' | 'v'。onChanged: 変更後（元に戻す・やり直すの後も）に呼ぶ
 */
export async function triggerDialog(table, kind, onChanged) {
  const isView = kind === 'v';
  const body = el('div.trig-body');
  const dlg = modal([el('h2', tr('トリガー：{0}', [table])), body], { className: 'triggers' });

  const apply = async (label, after) => {
    const before = await listTriggers(table);
    await db.batch(await replaceStmts(table, after));
    const swap = async (list) => { await db.batch(await replaceStmts(table, list)); await onChanged?.(); };
    undo.push({ label, sheet: `${kind}:${table}`, undoFn: () => swap(before), redoFn: () => swap(after) });
    await onChanged?.();
  };

  async function showList() {
    const list = await listTriggers(table);
    const tpls = await templates(table, isView);
    const have = new Set(list.map((t) => triggerEvent(t.sql)));
    body.replaceChildren(
      isView ? el('p', tr('INSTEAD OF トリガーがあると、このビューのシートで値の変更・行の追加・行の削除ができます。'))
        : el('p', tr('行の追加・変更・削除のたびに自動で動く処理です。保護のトリガーはここには出ません。')),
      list.length ? el('div.trig-list', list.map((t) => el('div.idx-row',
        el('div', el('b', t.name), el('div.muted.mono.sm', triggerEvent(t.sql))),
        el('div.row-gap',
          el('button.btn.sm', { on: { click: () => showEditor(t) } }, tr('編集')),
          el('button.btn.sm.danger-text', { on: { click: () => remove(t) } }, tr('削除'))))))
        : el('p.muted', tr('トリガーはありません')),
      el('div.trig-add',
        el('span.muted.sm', tr('追加：')),
        tpls.map((tp) => el('button.btn.sm', {
          title: isView && have.has(`INSTEAD OF ${tp.op}`) ? tr('同じ種類のトリガーが既にあります') : '',
          on: { click: () => showEditor(null, tp.sql) },
        }, `＋ ${isView ? 'INSTEAD OF' : 'AFTER'} ${tp.op}`))),
      el('div.modal-actions', el('button.btn', { on: { click: () => dlg.close() } }, tr('閉じる'))),
    );
  }

  function showEditor(orig, initial) {
    const ta = el('textarea.query-input.mono.trig-sql', { value: orig ? orig.sql : initial, spellcheck: false, rows: 10 });
    const err = el('div.query-error');
    const save = async () => {
      try {
        const sql = await normalize(ta.value);
        const others = (await listTriggers(table)).filter((t) => !orig || t.name !== orig.name);
        await apply(orig ? tr('トリガー「{0}」の変更', [orig.name]) : tr('トリガーの追加'), [...others, { sql }]);
        // 別のテーブルに作ったものなどは一覧に出ないので、知らせる
        const r = await db.query(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND sql = ?`, [sql]);
        const made = r.rows[0]?.[0];
        const on = made && (await db.query(`SELECT tbl_name FROM sqlite_schema WHERE name = ?`, [made])).rows[0]?.[0];
        if (on && on !== table) toast(tr('トリガーは「{0}」に作られました', [on]));
        await showList();
      } catch (e) { err.textContent = friendlyError(e.message); }
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
    });
    body.replaceChildren(
      el('p', orig ? tr('「{0}」を編集しています。保存すると作り直します。', [orig.name]) : tr('新しいトリガーの SQL を書いて保存します。')),
      ta, err,
      el('div.modal-actions',
        el('button.btn', { on: { click: () => showList() } }, tr('戻る')),
        el('button.btn.primary', { on: { click: save } }, tr('保存'))),
    );
    ta.focus();
    // 雛形なら、BEGIN と END の間から書き始められるように
    if (!orig) { const i = ta.value.indexOf('BEGIN\n  '); if (i >= 0) ta.setSelectionRange(i + 8, i + 8); }
  }

  async function remove(t) {
    if (!await confirmDialog({ title: tr('トリガーを削除しますか？'), body: tr('「{0}」を削除します。元に戻す（{1}）で戻せます。', [t.name, 'Ctrl+Z']), code: t.sql, okLabel: tr('削除'), danger: true })) return;
    try {
      await apply(tr('トリガー「{0}」の削除', [t.name]), (await listTriggers(table)).filter((x) => x.name !== t.name));
      await showList();
    } catch (e) { toast(friendlyError(e.message), 'error'); }
  }

  await showList();
}
