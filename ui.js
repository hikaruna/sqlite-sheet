// DB全体のSQL欄、ポップアップ

// ---------- DOM ヘルパー ----------
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ---------- SQL ヘルパー ----------
export const qid = (s) => '"' + String(s).replace(/"/g, '""') + '"';

export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) {
    let s = '';
    for (const b of v) s += b.toString(16).padStart(2, '0');
    return "X'" + s + "'";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
// 入力文字列を、列の型に合わせたリテラルにする（デフォルト値・絞り込み条件用）
export function typedLit(str, type) {
  const t = String(type || '').toUpperCase();
  if (!/TEXT|CHAR|CLOB/.test(t) && NUM_RE.test(str.trim())) return str.trim();
  if (/BLOB/.test(t) && /^x'[0-9a-f]*'$/i.test(str.trim())) return str.trim();
  return lit(str);
}

// バインド付きSQLを表示用に値を埋め込んだ文字列にする
export function inlineSql(sql, bind = []) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = bind[i++];
    if (v instanceof Uint8Array && v.length > 32) return `X'…'/*${v.length}バイト*/`;
    return lit(v);
  });
}

// ---------- ポップアップ ----------
export function openDialog(title, build) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'popup' });
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.append(h('h3', null, title), build(done));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(null); }); // 外側クリック
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input:not([type=checkbox]),select,textarea');
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}

// フォーム: rows は [ラベル, 要素] の配列。onSubmit が文字列を返したらエラー表示、それ以外なら閉じてその値を返す
export function formDialog(title, rows, submitLabel, onSubmit) {
  return openDialog(title, (done) => {
    const err = h('div', { class: 'form-err' });
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'form' }, rows.map((r) => (r === '-' ? h('div', { class: 'sep' }) : [h('label', null, r[0]), r[1]]))),
      err,
      h('div', { class: 'form-buttons' },
        h('button', { type: 'button', onclick: () => done(null) }, 'キャンセル'),
        h('button', { type: 'submit' }, submitLabel)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await onSubmit();
        if (typeof r === 'string') err.textContent = r;
        else done(r === undefined ? true : r);
      } catch (ex) {
        err.textContent = ex.message || String(ex);
      }
    });
    return form;
  });
}

export function promptDialog(title, label, initial, validate) {
  const input = h('input', { type: 'text', value: initial || '' });
  return formDialog(title, [[label, input]], 'OK', async () => {
    const v = input.value;
    const e = validate ? await validate(v) : null;
    return e || { value: v };
  }).then((r) => (r ? r.value : null));
}

// メニュー: items は [ラベル, 値, 無効?]
export function menuDialog(title, items) {
  return openDialog(title, (done) =>
    h('div', { class: 'menu' },
      items.map(([label, val, disabled]) => h('button', { type: 'button', disabled, onclick: () => done(val) }, label)),
      h('button', { type: 'button', onclick: () => done(null) }, 'キャンセル')));
}

export function chooseDialog(title, items) {
  return openDialog(title, (done) =>
    h('div', { class: 'form-buttons', style: 'justify-content:flex-start' },
      items.map(([label, val]) => h('button', { type: 'button', onclick: () => done(val) }, label))));
}

// ---------- DB全体のSQL欄 ----------
export class SqlPanel {
  constructor({ sqlite3, getDb, onSchemaChange, onReload, onSelect }) {
    this.sqlite3 = sqlite3;
    this.getDb = getDb;
    this.onSchemaChange = onSchemaChange;
    this.onReload = onReload;
    this.onSelect = onSelect;
    this.input = document.getElementById('sql-input');
    this.result = document.getElementById('sql-result');
    this.saved = ''; // 前回の成功実行（またはGUI操作）直後の欄の内容
    this.input.value = '';
    this.setResult('', false);
    document.getElementById('sql-run').onclick = () => this.run();
    this.input.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.run(); }
    };
  }

  setResult(text, isErr) {
    this.result.textContent = text;
    this.result.title = text;
    this.result.classList.toggle('err', !!isErr);
  }

  schemaVersion() {
    return this.getDb().selectValue('PRAGMA schema_version');
  }

  async run() {
    const db = this.getDb();
    const sql = this.input.value;
    if (!sql.trim()) return;
    const { capi } = this.sqlite3;

    // SELECT は新しいクエリシートで開く
    if (/^\s*(SELECT|WITH|VALUES)\b/i.test(sql)) {
      let ro = false;
      try {
        const st = db.prepare(sql);
        try { ro = !!capi.sqlite3_stmt_readonly(st.pointer); } finally { st.finalize(); }
      } catch (e) {
        this.setResult(e.message, true);
        return;
      }
      if (ro) {
        this.input.value = '';
        this.saved = '';
        this.setResult('クエリシートを開きました', false);
        await this.onSelect(sql.trim());
        return;
      }
    }

    const before = this.schemaVersion();
    const tc0 = capi.sqlite3_total_changes(db.pointer);
    try {
      db.exec(sql);
      const n = capi.sqlite3_total_changes(db.pointer) - tc0;
      this.setResult(`成功、${n}行変更`, false);
      this.saved = this.input.value;
    } catch (e) {
      this.setResult(e.message, true);
    }
    if (this.schemaVersion() !== before) await this.onSchemaChange();
    else await this.onReload();
  }

  // GUI操作のSQLを実行し、欄と結果表示に反映する。キャンセル時は null、成功時 { ok: true, changes }、失敗時 { ok: false, error }
  gui(displaySql, fn) {
    if (this.input.value !== this.saved && this.input.value.trim() !== '') {
      if (!confirm('SQL欄の内容が上書きされます。続けますか？')) return null;
    }
    this.input.value = displaySql;
    this.saved = displaySql;
    const db = this.getDb();
    const tc0 = this.sqlite3.capi.sqlite3_total_changes(db.pointer);
    try {
      const r = fn();
      const n = this.sqlite3.capi.sqlite3_total_changes(db.pointer) - tc0;
      this.setResult(`成功、${n}行変更`, false);
      return { ok: true, changes: n, value: r };
    } catch (e) {
      this.setResult(e.message, true);
      return { ok: false, error: e };
    }
  }
}
