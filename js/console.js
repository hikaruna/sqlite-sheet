// SQL コンソール：任意の SQL を実行。GUI が発行した SQL も履歴に流れる
import { db, inline } from './db-client.js';
import { el, modKey, toast } from './ui.js';
import { Grid } from './grid.js';
import { friendlyError } from './sources.js';

export class SqlConsole {
  constructor(host, { onSchemaMaybeChanged, onDataChanged }) {
    this.host = host;
    this.cb = { onSchemaMaybeChanged, onDataChanged };
    this.history = loadHistory();
    this.hIdx = -1;
    this.log = [];
    this.tab = 'result';
    db.onLog((entry) => {
      if (entry.source === 'console') return;
      this.log.push(entry);
      if (this.log.length > 500) this.log.shift();
      if (this.tab === 'log' && !host.hidden) this.renderOut();
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
    this.out = el('div.console-out');
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
    try {
      const r = await db.exec(sql, undefined, 'console');
      const ms = (performance.now() - t0).toFixed(1);
      this.log.push({ sql, source: 'console', at: new Date() });
      this.lastResult = r;
      this.status.textContent = r.columns.length
        ? `${r.rows.length} 行（${ms} ms）`
        : `完了：${r.changes} 行に影響（${ms} ms）`;
      this.status.className = 'console-status ok';
      this.renderOut();
      const isRead = /^\s*(select|with|pragma\s+\w+\s*;?\s*$|explain|values)/i.test(sql) && !/;\s*\S/.test(sql.replace(/;\s*$/, ''));
      if (!isRead) {
        if (/\b(create|drop|alter)\b/i.test(sql)) this.cb.onSchemaMaybeChanged();
        else this.cb.onDataChanged();
      }
    } catch (e) {
      this.log.push({ sql, source: 'console', error: e.message, at: new Date() });
      this.lastResult = null;
      this.status.textContent = '';
      this.out.replaceChildren(el('div.console-error', friendlyError(e.message), e.message !== friendlyError(e.message) ? el('div.muted.mono', e.message) : null));
    }
  }

  renderOut() {
    if (this.tab === 'log') {
      const items = this.log.slice().reverse();
      this.out.replaceChildren(items.length ? el('div.log-list', items.map((it) => el('div.log-item', {
        class: it.error ? 'err' : '',
        title: 'クリックで入力欄にコピー',
        on: { click: () => { this.input.value = inline(it.sql, it.bind); this.input.focus(); } },
      },
      el('span.log-src', { gui: 'GUI', console: 'SQL', undo: '元に戻す', redo: 'やり直し' }[it.source] || it.source),
      el('span.log-time', it.at.toLocaleTimeString()),
      el('code.log-sql', inline(it.sql, it.bind)),
      it.error ? el('div.log-err', friendlyError(it.error)) : null))) : el('p.muted.pad', 'まだ何も実行していません。GUI で行った操作の SQL もここに記録されます。'));
      return;
    }
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
}

function loadHistory() { try { return JSON.parse(localStorage.getItem('sql-history') || '[]'); } catch { return []; } }
function saveHistory(h) { try { localStorage.setItem('sql-history', JSON.stringify(h)); } catch { /* 無視 */ } }
