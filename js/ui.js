import { t as tr } from './i18n.js';
// 小さな UI 部品：要素生成、トースト、メニュー、ポップオーバー、確認ダイアログ

/** el('div.cls#id', {attrs, on:{click}}, ...children) */
export function el(spec, props = {}, ...children) {
  const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m[1] || 'div');
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1)); else node.id = part.slice(1);
  }
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) { children.unshift(props); props = {}; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, f] of Object.entries(v)) node.addEventListener(ev, f);
    else if (k === 'class') node.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && (typeof v !== 'string' || k === 'value')) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------- トースト ----------
export function toast(message, kind = 'info', ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div#toasts'); document.body.append(box); }
  const t = el('div.toast', { class: kind }, message);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? ms * 2 : ms);
  return t;
}

// ---------- ポップオーバー（同時に1つ） ----------
let current = null;
export function closePopover() {
  if (current) { const c = current; current = null; c.node.remove(); c.onClose?.(); }
}

/**
 * タッチの長押し。pointerdown から呼ぶ。指を動かさずに押し続けたら onLong を呼び、離したときの click は捨てる。
 * iOS は長押しで contextmenu を出さないので、右クリックの代わりにこれを使う
 */
export function touchHold(e, onLong, ms = 500) {
  if (e.pointerType === 'mouse') return;
  const x0 = e.clientX, y0 = e.clientY;
  let fired = false;
  const end = () => {
    clearTimeout(timer);
    removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', end);
  };
  const up = () => {
    end();
    if (!fired) return;
    // 長押しの後に指を離したときの click（あれば）を捨てる
    const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', eat, { capture: true }), 300);
  };
  const move = (ev) => { if (!fired && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) end(); };
  const timer = setTimeout(() => { fired = true; navigator.vibrate?.(10); onLong(); }, ms);
  addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', end);
}

/** 狭い画面（スマホ）か。CSS の @media (max-width: 760px) と揃える */
export const narrow = matchMedia('(max-width: 760px)');
/** スマホ用のシート画面にするか：狭い画面かつタッチ端末。CSS の同じ @media と揃える */
export const phone = matchMedia('(max-width: 760px) and (hover: none) and (pointer: coarse)');

// ソフトキーボードが出ると見える範囲が狭まる。その高さを CSS に渡し、画面全体と下から出すシートを見える範囲に収める
if (window.visualViewport) {
  const vv = visualViewport;
  const root = document.documentElement.style;
  // キーボードが出ているか（html.kb-open）。Android は innerHeight ごと縮むので、同じ横幅で見た一番高い高さと比べる
  let baseW = 0, baseH = 0;
  const syncKb = () => {
    if (innerWidth !== baseW) { baseW = innerWidth; baseH = 0; }
    baseH = Math.max(baseH, innerHeight, vv.height);
    document.documentElement.classList.toggle('kb-open', vv.scale <= 1.01 && baseH - vv.height > 150);
  };
  const sync = () => {
    syncKb();
    // ページが拡大されているとき（iOS がアプリへ戻ったときなどに勝手に拡大する）は、見える範囲が狭いのは
    // キーボードのせいではない。それで画面全体を縮めると表示がおかしくなるので、ふつうの高さに戻す
    if (vv.scale > 1.01) { root.removeProperty('--vvh'); root.removeProperty('--kb'); root.removeProperty('--vvtop'); return; }
    root.setProperty('--vvh', vv.height + 'px');
    // iPhone は下の方の入力欄にフォーカスすると、ページごと上へずらして見せる。画面全体をその位置に付いていかせる
    root.setProperty('--vvtop', Math.max(0, vv.pageTop) + 'px');
    root.setProperty('--kb', Math.max(0, innerHeight - vv.height - vv.offsetTop) + 'px');
  };
  // 画面が縮んだら、入力中の欄をスクロールして見せる。iPhone は画面全体を縮めると自分ではスクロールしてくれない
  // （キーボードが出たまま別の欄へ移ったときも同じ）
  let lastH = vv.height;
  const reveal = (a = document.activeElement) => {
    if (a?.matches?.('input, textarea, select, [contenteditable]') && !a.classList.contains('grid-sink')) {
      requestAnimationFrame(() => a.scrollIntoView({ block: 'nearest' }));
    }
  };
  vv.addEventListener('resize', () => { sync(); if (vv.height < lastH) reveal(); lastH = vv.height; });
  document.addEventListener('focusin', (e) => { if (document.documentElement.classList.contains('kb-open')) reveal(e.target); });
  vv.addEventListener('scroll', sync); addEventListener('scroll', sync); sync();
  // アプリへ戻った直後は見える範囲の値が落ち着くまで少しかかるので、少し待ってからも取り直す
  const resync = () => { sync(); requestAnimationFrame(sync); setTimeout(sync, 300); };
  addEventListener('pageshow', resync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });
}

/** anchor（要素 or {x,y}）の近くに content を出す */
export function popover(anchor, content, { onClose, className = '', align = 'start' } = {}) {
  closePopover();
  const node = el('div.popover', { class: className }, content);
  document.body.append(node);
  current = { node, onClose };
  // 狭い画面：スマホのスプレッドシートと同じく、画面の下から出すシートにする
  if (narrow.matches) {
    node.classList.add('as-sheet');
    node.querySelector('[autofocus], input, textarea, select')?.focus();
    return node;
  }
  let x, y;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    x = align === 'end' ? r.right - node.offsetWidth : r.left; y = r.bottom + 4;
    if (y + node.offsetHeight > innerHeight - 8) y = r.top - node.offsetHeight - 4;
  } else { x = anchor.x; y = anchor.y; if (y + node.offsetHeight > innerHeight - 8) y = anchor.y - node.offsetHeight; }
  x = Math.max(8, Math.min(x, innerWidth - node.offsetWidth - 8));
  y = Math.max(8, y);
  node.style.left = x + 'px'; node.style.top = y + 'px';
  current = { node, onClose };
  const f = node.querySelector('[autofocus], input, textarea, select');
  f?.focus();
  setTimeout(() => { if (current?.node === node && !node.contains(document.activeElement)) f?.focus(); }, 0);
  return node;
}

// ポップオーバーの上で開いた確認ダイアログを操作しても、ポップオーバー（と入力中の内容）は閉じない
const modalOpen = () => !!document.querySelector('dialog.modal[open]');
// pointerdown で閉じる：タッチではメニューを開いた後にブラウザが mousedown を出すので、mousedown だと開いた直後に閉じてしまう
addEventListener('pointerdown', (e) => {
  if (current && !current.node.contains(e.target) && !e.target.closest?.('dialog.modal')) closePopover();
}, true);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current && !modalOpen()) { e.stopPropagation(); e.preventDefault(); closePopover(); }
}, true);

/** メニュー。items: [{label, icon, kbd, danger, disabled, action}] または '-' */
export function menu(anchor, items, opts) {
  const list = el('div.menu', { role: 'menu' }, items.map((it) => {
    if (it === '-') return el('div.menu-sep');
    if (it.header) return el('div.menu-header', it.header);
    return el('button.menu-item', {
      class: it.danger ? 'danger' : '', disabled: it.disabled,
      on: { click: () => { closePopover(); it.action?.(); } },
    }, el('span.mi-icon', it.icon || ''), el('span.mi-label', it.label), it.kbd ? el('kbd', it.kbd) : null);
  }));
  return popover(anchor, list, opts);
}

/** 1行入力のポップオーバー。Promise<string|null> */
export function ask(anchor, { title, value = '', placeholder = '', okLabel = 'OK', validate } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = el('input.input', { value, placeholder, autofocus: true, spellcheck: false });
    const err = el('div.field-error');
    const finish = (v) => { if (done) return; done = true; closePopover(); resolve(v); };
    const submit = () => {
      const v = input.value.trim();
      const msg = validate?.(v);
      if (msg) { err.textContent = msg; input.focus(); return; }
      finish(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    });
    popover(anchor, el('form.ask', { on: { submit: (e) => { e.preventDefault(); submit(); } } },
      title ? el('div.ask-title', title) : null, input, err,
      el('div.ask-actions', el('button.btn', { type: 'button', on: { click: () => finish(null) } }, tr('キャンセル')),
        el('button.btn.primary', { type: 'submit' }, okLabel))),
    { onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => input.select(), 0);
  });
}

/** モーダル確認。Promise<boolean> */
export function confirmDialog({ title, body, okLabel = 'OK', danger = false, code } = {}) {
  return new Promise((resolve) => {
    const dlg = el('dialog.modal');
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(...[
      el('h2', title),
      body ? el('p', body) : null,
      code ? el('pre.code', code) : null,
      el('div.modal-actions',
        el('button.btn', { on: { click: () => close(false) } }, tr('キャンセル')),
        el('button.btn', { class: danger ? 'danger' : 'primary', autofocus: true, on: { click: () => close(true) } }, okLabel)),
    ].filter(Boolean));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/**
 * 3つ以上の選択肢があるダイアログ。choices: [{label, value, hint?, primary?, danger?}]。
 * 選んだ value（Esc は null）を返す
 */
export function choiceDialog({ title, body, code, note, choices }) {
  return new Promise((resolve) => {
    const dlg = el('dialog.modal');
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(...[
      el('h2', title),
      body ? el('p', body) : null,
      code ? el('pre.code', code) : null,
      note ? el('p.muted', note) : null,
      el('div.modal-actions.choice-actions', choices.map((c) => el('button.btn', {
        class: c.danger ? 'danger' : c.primary ? 'primary' : '', autofocus: !!c.primary,
        title: c.hint || '', on: { click: () => close(c.value ?? null) },
      }, c.label, c.hint ? el('span.btn-hint', c.hint) : null))),
    ].filter(Boolean));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** 中身を自由に組むモーダル。{close} を返す（Esc・外側のクリックでも閉じる） */
export function modal(children, { className = '', onClose } = {}) {
  const dlg = el('dialog.modal' + (className ? '.' + className : ''));
  const close = () => { if (!dlg.isConnected) return; if (dlg.open) dlg.close(); dlg.remove(); onClose?.(); };
  dlg.append(...children.filter(Boolean));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // 外側（::backdrop）のクリック
  document.body.append(dlg);
  dlg.showModal();
  return { close };
}

/** ファイル選択 */
export function pickFile(accept) {
  return new Promise((resolve) => {
    // iOS はページに置いていない input から change を送らないことがあるので、見えないまま置いて終わったら外す
    const i = el('input', { type: 'file', accept, hidden: true });
    const done = (f) => { i.remove(); resolve(f); };
    i.addEventListener('change', () => done(i.files[0] || null));
    i.addEventListener('cancel', () => done(null));
    document.body.append(i);
    i.click();
  });
}

export function download(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** アプリのアイコン（icons/icon.svg）。ページの URL は /DB名 のように変わるので、このファイルからの位置で指す */
const APP_ICON_URL = new URL('../icons/icon.svg', import.meta.url).href;
export const appIcon = () => el('img.app-icon', { src: APP_ICON_URL, alt: '', draggable: false });

/** スマホ・タブレットなど、指で操作する端末 */
export const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;

/**
 * ファイルの書き出し。指で操作する端末では共有シート（「ファイルに保存」「ドライブ」など）、
 * それ以外や共有できないときはダウンロード
 */
export async function exportFile(bytes, filename, type = 'application/octet-stream') {
  // 共有できる種類は端末ごとに違う。指定の種類がだめなら汎用の種類で試す
  const file = isTouch && [type, 'application/octet-stream']
    .map((t) => new File([bytes], filename, { type: t })).find((f) => navigator.canShare?.({ files: [f] }));
  if (file) {
    try {
      try { await navigator.share({ files: [file] }); } catch (e) {
        // iOS は、書き出しに時間がかかるとユーザー操作の有効期限が切れる。ボタンを押してもらってやり直す
        if (e.name !== 'NotAllowedError') throw e;
        if (await confirmDialog({ title: tr('書き出しの準備ができました'), body: filename, okLabel: tr('共有…') })) await navigator.share({ files: [file] });
      }
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(bytes, filename, type);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);
export const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// ---------- アイコン（線の SVG、16px） ----------
const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  design: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  terminal: '<path d="m5 8 4 4-4 4"/><path d="M12 17h7"/><rect x="2" y="3" width="20" height="18" rx="2"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  tx: '<path d="M6 2h12M6 22h12"/><path d="M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-5"/><path d="m15 15.5-2.5 2.5 2.5 2.5"/><path d="M3 18h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>',
  gallery: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
  // ラベル列（塗りつぶしの札）
  label: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h10.3l5.2 7-5.2 7H5.5A2.5 2.5 0 0 1 3 16.5z" fill="currentColor" stroke="none"/>',
  // 参照先を開く（丸の中の矢印）
  ref: '<circle cx="12" cy="12" r="9"/><path d="m10.5 8 4 4-4 4"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ico');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}
