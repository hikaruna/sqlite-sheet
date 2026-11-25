// ギャラリー：シートの行をカードにして縦1列に並べる（左にサムネイル、題名・いくつかの列）
// 表（Grid）を裏で使う。行の読み込みは Grid のページをそのまま使い、選んだ行は grid.cur.r。
// 見えている分のカードだけを描く。上のバー（スマホでは右下の丸いボタン）から行を足す
import { t as tr } from './i18n.js';
import { el, fmtBytes } from './ui.js';
import { sniff } from './blob.js';
import { NULL_LABEL } from './grid.js';

const THUMB = 64;    // サムネイルの一辺
const SUB = 2;       // 題名の下に出す列の数
const SAMPLE = 50;   // サムネイルの列を決めるために見る行の数

export class GalleryView {
  /** hooks: { beforeMove(): 別の行へ移ってよいか（詳細カードの未保存の確認）, onOpen(r): カードを開く（新しい行は newRowIndex）, labelColumn: 題名にする列の名前（シートのラベル列。無ければ題名なし） } */
  constructor(host, grid, hooks = {}) {
    this.host = host;
    this.grid = grid;
    this.hooks = hooks;
    this.urls = new Map(); // BLOB → Object URL（描いたカードの分だけ残す）
    this.layout = null;
    this.inner = el('div.gallery-inner');
    this.list = el('div.g-list', { tabIndex: 0, on: { scroll: () => this.render(), keydown: (e) => this.onKey(e) } }, this.inner);
    const add = () => this.open(grid.newRowIndex);
    this.countEl = el('span.g-count.muted');
    this.root = el('div.gallery',
      el('div.g-head', this.countEl, el('span.grow'),
        grid.canInsert ? el('button.btn.sm.primary.g-add', { on: { click: add } }, tr('＋ 追加')) : null,
        // PC：リストを最大にする（並べた表示のときだけ出す）
        hooks.onExpand ? el('button.btn.sm.g-expand', { title: tr('リストを最大にする'), 'aria-label': tr('リストを最大にする'), on: { click: () => hooks.onExpand() } }, '⤢') : null),
      this.list,
      grid.canInsert ? el('button.g-fab', { title: tr('行を追加'), 'aria-label': tr('行を追加'), on: { click: add } }, '＋') : null);
    host.append(this.root);
    host.classList.add('gallery-mode');
    // 数式バーは表のときの道具なので、ギャラリーでは出さない
    document.body.classList.add('in-gallery');
    this.ro = new ResizeObserver(() => { this.layout = null; this.render(); });
    this.ro.observe(this.list);
  }

  destroy() {
    this.ro.disconnect();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.root.remove();
    this.host.classList.remove('gallery-mode');
    document.body.classList.remove('in-gallery');
  }

  focus() { this.list.focus({ preventScroll: true }); }

  /** カードの中身にする列：サムネイル・題名・その下の列 */
  async pickColumns() {
    const g = this.grid, cols = g.cols;
    const n = Math.min(g.rowCount, SAMPLE);
    const rows = n ? (await g.rowsBetween(0, n - 1)).filter(Boolean) : [];
    const isBlobCol = (col) => /BLOB/i.test(col.type || '');
    let thumb = cols.findIndex((col, c) => rows.some((row, r) => g.hasPreview(row.values[c], r, row, c)));
    // まだ行がなくても、BLOB の列があればサムネイルの枠を取っておく
    if (thumb < 0 && !rows.length) thumb = cols.findIndex(isBlobCol);
    const usable = cols.map((col, c) => c).filter((c) => c !== thumb && !isBlobCol(cols[c]) && !cols[c].auto);
    // 題名はシートのラベル列（自動の選び方も含めてラベル列に任せる。外部キーなら参照先のラベルが出る）
    const title = cols.findIndex((col) => col.name === this.hooks.labelColumn);
    return { thumb, title, sub: usable.filter((c) => c !== title).slice(0, SUB) };
  }

  measure() {
    const text = 12 + 22 + this.pick.sub.length * 20 + 12;
    this.layout = { ch: Math.max(text, this.pick.thumb >= 0 ? THUMB + 20 : 0) };
  }

  get count() { return this.grid.rowCount; }

  async render() {
    const g = this.grid;
    if (!this.pick) {
      // スクロールや選択の変化で続けて呼ばれても、列を決めるのは1回だけ
      this.picking ??= this.pickColumns().then((p) => { this.pick = p; this.layout = null; });
      await this.picking;
      if (!this.root.isConnected) return;
    }
    if (!this.layout) this.measure();
    const { ch } = this.layout;
    const total = this.count;
    this.countEl.textContent = tr('{0} 行', [total]);
    if (!total) { this.inner.style.height = ''; this.inner.replaceChildren(el('div.form-empty.muted', tr('行がありません'))); return; }
    this.inner.style.height = `${total * ch}px`;
    // 見えている行（＋上下に1画面ぶん）
    const top = this.list.scrollTop, h = this.list.clientHeight;
    const r0 = Math.max(0, Math.floor((top - h) / ch));
    const r1 = Math.min(total - 1, Math.floor((top + 2 * h) / ch));
    if (!g.cachedRows(r0, r1)) {
      const token = (this.token = (this.token || 0) + 1);
      await g.rowsBetween(r0, r1);
      if (token !== this.token || !this.root.isConnected) return;
    }
    const used = new Set();
    const cards = [];
    for (let r = r0; r <= r1; r++) {
      const style = { top: `${r * ch}px`, height: `${ch}px` };
      cards.push(this.card(r, style, used));
    }
    this.inner.replaceChildren(...cards);
    // 描かなくなったカードの画像を解放する
    for (const [v, u] of this.urls) if (!used.has(v)) { URL.revokeObjectURL(u); this.urls.delete(v); }
  }

  card(r, style, used) {
    const g = this.grid, row = g.rowAt(r), { thumb, title, sub } = this.pick;
    const on = r === g.cur.r && !g.none;
    const card = el('button.g-card', { style, class: on ? 'on' : '', dataset: { r }, on: { click: () => this.open(r) } });
    if (!row) return card;
    if (thumb >= 0) card.append(el('div.g-thumb', this.thumb(row, r, thumb, used)));
    card.append(el('div.g-body',
      el('div.g-title', title >= 0 ? this.text(row, title) : ''),
      sub.map((c) => el('div.g-sub', el('span.g-key', g.cols[c].name), el('span.g-val', this.text(row, c))))));
    return card;
  }

  thumb(row, r, c, used) {
    const g = this.grid, v = row.values[c];
    if (v instanceof Uint8Array) {
      const k = sniff(v);
      if (!k.image || !v.length) return el('span.muted', v.length ? `${k.label} ${fmtBytes(v.length)}` : '');
      used.add(v);
      let url = this.urls.get(v);
      if (!url) { url = URL.createObjectURL(new Blob([v], { type: k.mime })); this.urls.set(v, url); }
      return el('img', { src: url, alt: '', loading: 'lazy' });
    }
    // 「画像で表示」にしている URL（外の URL は許可されているときだけ。判断は Grid に任せる）
    const src = v == null ? null : g.imageSrc(v, r, row, c);
    return src ? el('img', { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }) : el('span.muted', v == null ? '' : String(v));
  }

  /** セルの文字（外部キーは参照先の名前、BLOB は種類と大きさ） */
  text(row, c) {
    const v = row.values[c];
    if (v == null) return el('span.g-null', NULL_LABEL);
    if (v instanceof Uint8Array) return `${sniff(v).label} ${fmtBytes(v.length)}`;
    const label = row.labels?.[c];
    return label != null ? String(label) : String(v);
  }

  async open(r) {
    const g = this.grid;
    if (r !== g.cur.r && this.hooks.beforeMove && !(await this.hooks.beforeMove())) return;
    if (r === g.newRowIndex) g.openDraft();
    g.moveTo(r, g.cur.c);
    this.hooks.onOpen?.(r);
  }

  /** 選んだ行が見えるようにスクロールする */
  reveal(r = this.grid.cur.r) {
    if (!this.layout) return;
    const { ch } = this.layout;
    const y = r * ch;
    const s = this.list;
    if (y < s.scrollTop) s.scrollTop = y;
    else if (y + ch > s.scrollTop + s.clientHeight) s.scrollTop = y + ch - s.clientHeight;
  }

  async onKey(e) {
    const g = this.grid;
    if (!this.layout || e.altKey || e.ctrlKey || e.metaKey) return;
    const max = g.rowCount - 1;
    const move = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (move) {
      e.preventDefault();
      const r = Math.max(0, Math.min(max, g.cur.r + move));
      if (r !== g.cur.r && this.hooks.beforeMove && !(await this.hooks.beforeMove())) return;
      g.moveTo(r, g.cur.c);
      this.reveal(r);
    } else if (e.key === 'Enter') { e.preventDefault(); this.open(g.cur.r); }
  }
}
