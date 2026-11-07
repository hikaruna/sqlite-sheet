// DB全体のSQL欄、ポップアップ
import { getHistory, setHistory } from './db.js';

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
export const isNumeric = (s) => NUM_RE.test(String(s).trim());
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
const HISTORY_LIMIT = { manual: 200, gui: 300 };
const SOURCE_LABEL = { manual: '手入力', gui: 'GUI' };
const LOG_HEIGHT_KEY = 'sqlite-sheet:sql-log-height';
const LOG_MIN = 28;

function clock(t) {
  const d = new Date(t);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${hm}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

export class SqlPanel {
  constructor({ sqlite3, getDb, dbName, onSchemaChange, onReload, onSelect }) {
    this.sqlite3 = sqlite3;
    this.getDb = getDb;
    this.dbName = dbName;
    this.onSchemaChange = onSchemaChange;
    this.onReload = onReload;
    this.onSelect = onSelect;
    this.input = document.getElementById('sql-input');
    this.log = document.getElementById('sql-log');
    this.errorEl = document.getElementById('sql-error');
    this.history = []; // 古い順
    this.filter = 'all';
    this.navIdx = null; // Ctrl+↑↓ で呼び出し中の位置（null = 呼び出していない）
    this.draft = ''; // 呼び出しを始める前の書きかけ
    this.input.value = '';
    this.showError('');

    this.buildTools();
    this.setupResize();
    this.render();
    getHistory(dbName).then((h) => {
      // 手入力の失敗は履歴に残さない（以前の版で保存されたものを取り除く）
      this.history = h.filter((e) => e.ok || e.source !== 'manual');
      if (this.history.length !== h.length) this.save();
      this.render();
    }).catch((e) => console.error(e));

    document.getElementById('sql-run').onclick = () => this.run();
    this.input.onkeydown = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'Enter') { e.preventDefault(); this.run(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.nav(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.nav(1); }
    };
    this.input.oninput = () => {
      this.showError('');
      if (this.navIdx !== null) { this.navIdx = null; this.render(false); }
    };
  }

  // 欄のすぐ下の赤い行（保存しない）。空文字で消す
  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.title = msg;
  }

  // ---------- 履歴の表示 ----------
  buildTools() {
    const tools = document.getElementById('sql-log-tools');
    this.segBtns = [['all', 'すべて'], ['manual', '手入力'], ['gui', 'GUI']].map(([v, label]) =>
      h('button', { type: 'button', 'data-v': v, onclick: () => { this.filter = v; this.render(); } }, label));
    tools.replaceChildren(
      h('span', { class: 'seg' }, this.segBtns),
      h('button', {
        type: 'button', class: 'clear', title: 'このDBのSQL履歴をすべて消す',
        onclick: () => {
          if (!this.history.length || !confirm('このDBのSQL履歴をすべて消しますか？')) return;
          this.history = [];
          this.navIdx = null;
          this.save();
          this.render();
        },
      }, '全削除'));
    // つまみのドラッグとボタンのクリックを区別する
    tools.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // つまみのドラッグで履歴の高さを変える。高さはブラウザに覚えさせる
  setupResize() {
    const bar = document.getElementById('sql-log-bar');
    let saved = null;
    try { saved = Number(localStorage.getItem(LOG_HEIGHT_KEY)) || null; } catch { /* 使えなくても動く */ }
    if (saved) this.log.style.height = saved + 'px';
    bar.onpointerdown = (e) => {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      document.body.style.userSelect = 'none'; // ドラッグ中に文字が選択されないように
      bar.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = this.log.getBoundingClientRect().height;
      const max = Math.max(LOG_MIN, window.innerHeight * 0.7);
      const move = (ev) => {
        const hgt = Math.min(Math.max(startH + ev.clientY - startY, LOG_MIN), max);
        this.log.style.height = hgt + 'px';
      };
      const up = () => {
        document.body.style.userSelect = '';
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        try { localStorage.setItem(LOG_HEIGHT_KEY, String(Math.round(this.log.getBoundingClientRect().height))); } catch { /* 無視 */ }
        this.scrollToEnd();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    };
  }

  scrollToEnd() { this.log.scrollTop = this.log.scrollHeight; }

  // scroll: true なら一番下（最新）までスクロール。呼び出し中はその件を見える位置に
  render(scroll = true) {
    this.segBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === this.filter));
    const cur = this.navIdx !== null ? this.history[this.navIdx] : null;
    const items = this.history.filter((e) => this.filter === 'all' || e.source === this.filter);
    this.log.replaceChildren(...(items.length ? items.map((e) => this.item(e, e === cur))
      : [h('li', { class: 'sql-log-empty' }, this.history.length ? 'この種類の履歴はありません' : 'まだ履歴はありません。実行したSQLとその結果がここに流れます')]));
    if (!scroll) return;
    const curEl = this.log.querySelector('.cur');
    if (curEl) curEl.scrollIntoView({ block: 'nearest' });
    else this.scrollToEnd();
  }

  item(e, isCur) {
    return h('li', {
      class: 'sql-log-item' + (isCur ? ' cur' : '') + (e.ok ? '' : ' ng'),
      title: 'クリックでSQL欄に入れる',
      onclick: () => {
        this.input.value = e.sql;
        this.navIdx = null;
        this.render(false);
        this.input.focus();
      },
    },
    h('div', { class: 'sql-log-head' },
      h('span', { class: 'hist-src ' + e.source }, SOURCE_LABEL[e.source]),
      h('span', { class: 'sql-log-time', title: new Date(e.at).toLocaleString() }, clock(e.at)),
      h('span', { class: 'hist-res ' + (e.ok ? 'ok' : 'ng'), title: e.message }, (e.ok ? '✓ ' : '✗ ') + e.message),
      h('button', {
        type: 'button', class: 'icon sql-log-del', title: 'この履歴を削除',
        onclick: (ev) => {
          ev.stopPropagation();
          const i = this.history.indexOf(e);
          if (i < 0) return;
          this.history.splice(i, 1);
          this.navIdx = null;
          this.save();
          this.render(false);
        },
      }, '×')),
    h('pre', { class: 'sql-log-sql' }, e.sql.trim()));
  }

  // 履歴に追加する。直前と同じ SQL・同じ種類なら日時と結果だけ更新
  record(sql, source, ok, message) {
    const hs = this.history;
    const last = hs[hs.length - 1];
    if (last && last.sql === sql && last.source === source) {
      Object.assign(last, { at: Date.now(), ok, message });
    } else {
      hs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sql, source, at: Date.now(), ok, message });
      // 種類ごとの上限を超えたら、その種類の古いものから消す
      let n = hs.filter((x) => x.source === source).length;
      for (let i = 0; n > HISTORY_LIMIT[source] && i < hs.length;) {
        if (hs[i].source === source) { hs.splice(i, 1); n--; } else i++;
      }
    }
    this.navIdx = null;
    if (ok) this.showError('');
    // 絞り込みで新しい件が見えないときは「すべて」に戻す
    if (this.filter !== 'all' && this.filter !== source) this.filter = 'all';
    this.save();
    this.render();
  }

  save() {
    setHistory(this.dbName, this.history).catch((e) => console.error('履歴の保存に失敗', e));
  }

  // Ctrl+↑（dir=-1）/ Ctrl+↓（dir=1）で履歴を呼び出す
  nav(dir) {
    const hs = this.history;
    if (this.navIdx === null) {
      if (dir > 0 || hs.length === 0) return;
      this.draft = this.input.value;
      this.navIdx = hs.length;
    }
    const i = Math.max(this.navIdx + dir, 0);
    if (i >= hs.length) {
      // 一番新しい位置を越えたら書きかけに戻す
      this.navIdx = null;
      this.input.value = this.draft;
      this.render();
      return;
    }
    this.navIdx = i;
    this.input.value = hs[i].sql;
    if (this.filter !== 'all' && this.filter !== hs[i].source) this.filter = 'all';
    this.render();
  }

  // ---------- 実行 ----------
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
        this.showError(e.message); // 手入力の失敗は履歴に入れない。欄の中身は残す
        return;
      }
      if (ro) {
        this.input.value = '';
        this.record(sql.trim(), 'manual', true, 'クエリシートを開きました');
        await this.onSelect(sql.trim());
        return;
      }
    }

    const before = this.schemaVersion();
    const tc0 = capi.sqlite3_total_changes(db.pointer);
    try {
      db.exec(sql);
      const n = capi.sqlite3_total_changes(db.pointer) - tc0;
      this.record(sql, 'manual', true, `成功、${n}行変更`);
    } catch (e) {
      this.showError(e.message); // 手入力の失敗は履歴に入れない。欄の中身は残す
    }
    if (this.schemaVersion() !== before) await this.onSchemaChange();
    else await this.onReload();
  }

  // GUI操作のSQLを実行する。成功したら履歴に追加する。
  // 失敗したときは、SQL欄が空ならそこに入れて失敗状態にし、空でなければ失敗の件として履歴に追加する
  // （入力中のSQLには触れない）。
  // 成功時 { ok: true, changes }、失敗時 { ok: false, error }
  gui(displaySql, fn) {
    const db = this.getDb();
    const tc0 = this.sqlite3.capi.sqlite3_total_changes(db.pointer);
    try {
      const r = fn();
      const n = this.sqlite3.capi.sqlite3_total_changes(db.pointer) - tc0;
      this.record(displaySql, 'gui', true, `成功、${n}行変更`);
      return { ok: true, changes: n, value: r };
    } catch (e) {
      if (this.input.value.trim() === '') {
        this.input.value = displaySql;
        this.navIdx = null;
        this.showError(e.message);
        this.render(false);
      } else {
        this.record(displaySql, 'gui', false, e.message);
      }
      return { ok: false, error: e };
    }
  }
}
