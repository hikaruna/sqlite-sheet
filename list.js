// DB一覧画面
import { h, promptDialog, menuDialog } from './ui.js';
import { listDbs, validateName, dbExists, createDb, withLock, deleteDb, renameDb, exportDb, importFile } from './db.js';

export const dbHash = (name) => '#/db/' + encodeURIComponent(name);

async function nameCheck(v, current) {
  const e = validateName(v);
  if (e) return e;
  if (v !== current && (await dbExists(v))) return `「${v}」は既にあります`;
  return null;
}

function fmt(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const busyMsg = (e) => (e.message === 'busy' ? '別のタブで使用中のため操作できません' : e.message || String(e));

export class ListView {
  constructor() {
    this.el = document.getElementById('list-view');
    this.tbody = this.el.querySelector('#db-list tbody');
    this.empty = document.getElementById('list-empty');
    document.getElementById('btn-new').onclick = () => this.create();
    const file = document.getElementById('import-file');
    document.getElementById('btn-import').onclick = () => { file.value = ''; file.click(); };
    file.onchange = () => { if (file.files[0]) this.import(file.files[0]); };
    // 他のタブでの開閉を反映
    document.addEventListener('visibilitychange', () => { if (!this.el.hidden && !document.hidden) this.render(); });
    window.addEventListener('focus', () => { if (!this.el.hidden) this.render(); });
  }

  async show() {
    document.title = 'SQLiteシート';
    this.el.hidden = false;
    await this.render();
  }

  hide() { this.el.hidden = true; }

  async render() {
    const dbs = await listDbs();
    this.empty.hidden = dbs.length > 0;
    this.tbody.replaceChildren(...dbs.map((d) => h('tr', null,
      h('td', null, h('a', { href: dbHash(d.name) }, d.name), d.inUse ? h('span', { class: 'in-use' }, '使用中') : null),
      h('td', null, fmt(d.updated)),
      h('td', null, h('button', { disabled: d.inUse, title: d.inUse ? '別のタブで使用中' : '', onclick: () => this.menu(d.name) }, '⋯')))));
  }

  async create() {
    const name = await promptDialog('新しいDB', 'DB名', '', (v) => nameCheck(v));
    if (name == null) return;
    await createDb(name);
    location.hash = dbHash(name);
  }

  async import(file) {
    const name = await promptDialog('DBを読み込み', 'DB名', file.name.replace(/\.(sqlite3?|db)$/i, ''), (v) => nameCheck(v));
    if (name == null) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await importFile(name, bytes);
    } catch (e) {
      alert('読み込みに失敗しました: ' + busyMsg(e));
    }
    await this.render();
  }

  async menu(name) {
    const act = await menuDialog(name, [['名前変更', 'rename'], ['削除', 'delete'], ['書き出し', 'export']]);
    try {
      if (act === 'rename') {
        const nn = await promptDialog('DBの名前変更', '新しい名前', name, (v) => nameCheck(v, name));
        if (nn == null || nn === name) return;
        await withLock(name, () => renameDb(name, nn));
      } else if (act === 'delete') {
        if (!confirm(`DB「${name}」を削除しますか？\nこの操作は元に戻せません。`)) return;
        await withLock(name, () => deleteDb(name));
      } else if (act === 'export') {
        const bytes = await withLock(name, () => exportDb(name));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-sqlite3' }));
        const a = h('a', { href: url, download: name + '.sqlite' });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      alert(busyMsg(e));
    } finally {
      await this.render();
    }
  }
}

export { nameCheck };
