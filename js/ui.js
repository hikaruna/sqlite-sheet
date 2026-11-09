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
}

// ---------- ポップオーバー（同時に1つ） ----------
let current = null;
export function closePopover() {
  if (current) { const c = current; current = null; c.node.remove(); c.onClose?.(); }
}

/** anchor（要素 or {x,y}）の近くに content を出す */
export function popover(anchor, content, { onClose, className = '', align = 'start' } = {}) {
  closePopover();
  const node = el('div.popover', { class: className }, content);
  document.body.append(node);
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

addEventListener('mousedown', (e) => {
  if (current && !current.node.contains(e.target)) closePopover();
}, true);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current) { e.stopPropagation(); e.preventDefault(); closePopover(); }
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
      el('div.ask-actions', el('button.btn', { type: 'button', on: { click: () => finish(null) } }, 'キャンセル'),
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
        el('button.btn', { on: { click: () => close(false) } }, 'キャンセル'),
        el('button.btn', { class: danger ? 'danger' : 'primary', autofocus: true, on: { click: () => close(true) } }, okLabel)),
    ].filter(Boolean));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/** ファイル選択 */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const i = el('input', { type: 'file', accept });
    i.addEventListener('change', () => resolve(i.files[0] || null));
    i.click();
  });
}

export function download(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);
export const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
