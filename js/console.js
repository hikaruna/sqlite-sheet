// SQL コンソール：任意の SQL を実行。GUI が発行した SQL も履歴に流れる
import { db, inline } from './db-client.js';
import { el, modKey, toast, choiceDialog } from './ui.js';
import { pushChanges, tableSummary } from './undo.js';
import { Grid } from './grid.js';
import { friendlyError } from './sources.js';

export class SqlConsole {
  constructor(host, { onSchemaMaybeChanged, onDataChanged, onDataRecorded }) {
    this.host = host;
    this.cb = { onSchemaMaybeChanged, onDataChanged, onDataRecorded };
    this.history = loadHistory();
    this.hIdx = -1;
    this.log = [];
    this.tab = 'result';
    this.unseen = 0; // 途中を読んでいる間に増えた記録の数
    db.onLog((entry) => {
      if (entry.source === 'console') return;
      this.log.push(entry);
      const dropped = this.log.length > LOG_LIMIT ? this.log.shift() : null;
      if (this.tab === 'log' && !host.hidden) this.appendLog(entry, !!dropped);
    });
    this.build();
  }

  build() {
    this.input = el('textarea.console-input.mono', {
      spellcheck: false, rows: 4,
      placeholder: 'SQL を入力（Ctrl+Enter で実行、Ctrl+↑↓ で履歴）\n例: CREATE INDEX … / CREATE VIEW … AS SELECT … / UPDATE … SET …',
      on: { keydown: (e) => this.onKey(e) },
    });
    this.status = el('span.console-status');
    this.out = el('div.console-out', { on: { scroll: () => { if (this.atBottom()) this.setUnseen(0); } } });
    this.tabsEl = el('div.console-tabs');
    this.host.append(
      el('div.console-resize', { on: { mousedown: (e) => this.startResize(e) } }),
      el('div.console-head',
        el('b', 'SQL'),
        this.tabsEl,
        el('span.grow'),
        this.status,
        el('button.btn.primary.sm', { on: { click: () => this.run() } }, '▶ 実行'),
        el('button.icon-btn', { title: '閉じる（Ctrl+`）', on: { click: () => this.toggle(false) } }, '×')),
      el('div.console-body', this.input, this.out),
    );
    this.renderTabs();
  }

  startResize(e) {
    e.preventDefault();
    const startY = e.clientY, startH = this.host.offsetHeight;
    const move = (ev) => { this.host.style.height = Math.max(160, Math.min(innerHeight * 0.85, startH - (ev.clientY - startY))) + 'px'; };
    const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  }

  renderTabs() {
    this.tabsEl.replaceChildren(...[['result', '結果'], ['log', '実行履歴']].map(([id, label]) =>
      el('button.ctab', { class: this.tab === id ? 'on' : '', on: { click: () => { this.tab = id; this.renderTabs(); this.renderOut(); } } }, label)));
  }

  toggle(force) {
    const show = force ?? this.host.hidden;
    this.host.hidden = !show;
    document.body.classList.toggle('console-open', show);
    if (show) { this.input.focus(); this.renderOut(); }
    return show;
  }

  insert(text) {
    this.toggle(true);
    this.input.value = text;
    this.input.focus();
  }

  onKey(e) {
    if (modKey(e) && e.key === 'Enter') { e.preventDefault(); this.run(); return; }
    if (modKey(e) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (!this.history.length) return;
      if (e.key === 'ArrowUp') this.hIdx = Math.min(this.history.length - 1, this.hIdx + 1);
      else this.hIdx = Math.max(-1, this.hIdx - 1);
      this.input.value = this.hIdx < 0 ? '' : this.history[this.history.length - 1 - this.hIdx];
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.input.setRangeText('  ', this.input.selectionStart, this.input.selectionEnd, 'end');
    }
  }

  async run() {
    const sql = (this.input.selectionStart !== this.input.selectionEnd
      ? this.input.value.slice(this.input.selectionStart, this.input.selectionEnd) : this.input.value).trim();
    if (!sql) return;
    this.history = this.history.filter((h) => h !== sql);
    this.history.push(sql);
    if (this.history.length > 100) this.history.shift();
    saveHistory(this.history);
    this.hIdx = -1;
    const t0 = performance.now();
    this.tab = 'result'; this.renderTabs();
    // 1文ずつ確かめながら実行する。表や列を変えるなど元に戻せない文の手前で止まるので、確認してから続ける
    let opts = { from: 0, confirmAt: -1, confirmAll: false };
    let last = null, error = null, schema = false, untrackable = false, cancelled = false;
    const changes = [];
    try {
      for (;;) {
        const r = await db.consoleRun(sql, opts);
        if (r.columns.length || !last) last = r;
        else last = { ...last, changes: r.changes };
        schema ||= r.schemaChanged; untrackable ||= r.untrackable;
        if (r.changeset) changes.push(r.changeset);
        if (r.error) { error = r.error; break; }
        if (!r.paused) break;
        const c = await choiceDialog({
          title: '元に戻せない操作です',
          body: '次の文は表や列を変える・消すなどの操作で、元に戻せません。実行すると、これまでの「元に戻す」の記録も消えます。',
          code: r.text,
          choices: [
            { label: 'キャンセル', value: null },
            { label: '残りも確認せずに実行', value: 'all' },
            { label: '実行する', value: 'one', danger: true },
          ],
        });
        if (!c) { cancelled = true; break; }
        opts = { from: r.at, confirmAt: r.at, confirmAll: c === 'all' };
      }
    } catch (e) { error = e.message; }
    const ms = (performance.now() - t0).toFixed(1);
    const item = { sql, source: 'console', at: new Date(), error: error ?? undefined };
    this.log.push(item);
    // 実行した分の後始末：元に戻せない文を実行したら記録を消し、データの変更だけなら1操作として積む
    if (schema) this.cb.onSchemaMaybeChanged();
    else if (untrackable) this.cb.onDataChanged();
    else if (changes.length) {
      const short = sql.replace(/\s+/g, ' ').slice(0, 40) + (sql.length > 40 ? '…' : '');
      const entry = pushChanges(`SQL コンソールの実行（${short}、${tableSummary(changes.length === 1 ? changes[0].tables : mergeTables(changes))}）`, null, { changes }, {
        onUndo: () => { item.undone = true; this.refreshLog(); },
        onRedo: () => { item.undone = false; this.refreshLog(); },
      });
      if (entry) this.cb.onDataRecorded?.();
    }
    if (error) {
      this.lastResult = null;
      this.status.textContent = '';
      this.out.replaceChildren(el('div.console-error', friendlyError(error), error !== friendlyError(error) ? el('div.muted.mono', error) : null));
      return;
    }
    this.lastResult = last;
    this.status.textContent = cancelled
      ? `途中で止めました（${ms} ms）`
      : last.columns.length ? `${last.rows.length} 行（${ms} ms）` : `完了：${last.changes} 行に影響（${ms} ms）`;
    this.status.className = 'console-status ok';
    this.renderOut();
  }

  /** 実行履歴を開いていれば描き直す（「元に戻しました」の印のため） */
  refreshLog() { if (this.tab === 'log' && !this.host.hidden) this.renderOut(); }

  renderOut() {
    if (this.tab === 'log') {
      // 古い順に下へ積む（ターミナルと同じ向き）。開いたときは最新が見える一番下から
      this.logList = el('div.log-list', this.log.map((it) => this.logItem(it)));
      this.jumpBtn = el('button.log-jump', { hidden: true, on: { click: () => this.scrollToBottom() } });
      this.out.replaceChildren(this.log.length ? this.logList : el('p.muted.pad', 'まだ何も実行していません。GUI で行った操作の SQL もここに記録されます。'),
        el('div.log-jump-wrap', this.jumpBtn));
      this.setUnseen(0);
      this.scrollToBottom();
      return;
    }
    this.logList = this.jumpBtn = null;
    const r = this.lastResult;
    if (!r) { if (!this.out.querySelector('.console-error')) this.out.replaceChildren(el('p.muted.pad', '結果はここに表示されます。')); return; }
    if (!r.columns.length) { this.out.replaceChildren(el('p.muted.pad', '実行しました。')); return; }
    const host = el('div.console-grid');
    this.out.replaceChildren(host);
    const rows = r.rows;
    const g = new Grid(host, {
      columns: r.columns.map((name, i) => ({ name, align: rows.slice(0, 50).every((row) => row[i] == null || typeof row[i] === 'number') ? 'right' : 'left' })),
      editable: false,
      widthKey: 'console',
      count: async () => rows.length,
      fetch: async (o, l) => rows.slice(o, o + l).map((values) => ({ values })),
    }, { onInfo: (m) => toast(m), onError: (e) => toast(e.message, 'error') });
    g.reload();
  }

  logItem(it) {
    return el('div.log-item', {
      class: [it.error ? 'err' : '', it.undone ? 'undone' : ''].join(' ').trim(),
      title: 'クリックで入力欄にコピー',
      on: { click: () => { this.input.value = inline(it.sql, it.bind); this.input.focus(); } },
    },
    el('span.log-src', { gui: 'GUI', console: 'SQL', undo: '元に戻す', redo: 'やり直し' }[it.source] || it.source),
    el('span.log-time', it.at.toLocaleTimeString()),
    el('code.log-sql', inline(it.sql, it.bind)),
    it.undone ? el('span.log-undone', '元に戻しました') : null,
    it.error ? el('div.log-err', friendlyError(it.error)) : null);
  }

  /** 実行履歴の末尾に1件足す。下端にいれば追いかけ、途中を読んでいれば位置を保って新着を知らせる */
  appendLog(entry, dropFirst) {
    if (!this.logList?.isConnected) { this.renderOut(); return; }
    const follow = this.atBottom();
    if (dropFirst && this.logList.firstChild) {
      const first = this.logList.firstChild;
      const h = first.offsetHeight;
      first.remove();
      if (!follow) this.out.scrollTop -= h; // 上が消えた分だけ戻して、読んでいる行を動かさない
    }
    this.logList.append(this.logItem(entry));
    if (follow) this.scrollToBottom();
    else this.setUnseen(this.unseen + 1);
  }

  atBottom() { const o = this.out; return o.scrollHeight - o.scrollTop - o.clientHeight < 8; }

  scrollToBottom() { this.out.scrollTop = this.out.scrollHeight; this.setUnseen(0); }

  setUnseen(n) {
    this.unseen = n;
    if (!this.jumpBtn) return;
    this.jumpBtn.hidden = !n;
    this.jumpBtn.textContent = `↓ 新しい記録 ${n} 件`;
  }
}

const LOG_LIMIT = 500;

function loadHistory() { try { return JSON.parse(localStorage.getItem('sql-history') || '[]'); } catch { return []; } }
function saveHistory(h) { try { localStorage.setItem('sql-history', JSON.stringify(h)); } catch { /* 無視 */ } }

/** 複数の記録の、表ごとの件数を足し合わせる */
function mergeTables(list) {
  const out = {};
  for (const c of list) for (const [t, n] of Object.entries(c.tables)) {
    const m = (out[t] ??= { insert: 0, delete: 0, update: 0 });
    m.insert += n.insert; m.delete += n.delete; m.update += n.update;
  }
  return out;
}
