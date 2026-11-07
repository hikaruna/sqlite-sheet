// 入口: ルーティング（#/ = 一覧、#/db/<名前> = DB画面）
import { initSqlite, openDb, renameDb, dbExists } from './db.js';
import { ListView, dbHash, nameCheck } from './list.js';
import { SqlPanel, promptDialog } from './ui.js';
import { Sheets } from './sheet.js';

const $ = (id) => document.getElementById(id);
let sqlite3;
let list;
let opened = null; // { db, name, close }
let routing = Promise.resolve();

async function closeCurrent() {
  if (opened) {
    const o = opened;
    opened = null;
    await o.close();
  }
}

async function route() {
  const m = /^#\/db\/(.+)$/.exec(location.hash);
  const name = m ? decodeURIComponent(m[1]) : null;
  if (opened && opened.name === name) return;
  await closeCurrent();
  $('db-view').hidden = true;
  $('busy-view').hidden = true;
  list.hide();

  if (name == null) { await list.show(); return; }
  if (!(await dbExists(name))) { location.hash = '#/'; return; }
  const o = await openDb(name);
  if (!o) { document.title = name + ' - SQLiteシート'; $('busy-view').hidden = false; return; }
  opened = o;
  showDb(o);
}

function showDb(o) {
  document.title = o.name + ' - SQLiteシート';
  $('db-view').hidden = false;
  $('db-name').textContent = o.name;
  const panel = new SqlPanel({
    sqlite3,
    getDb: () => o.db,
    dbName: o.name,
    onSchemaChange: () => sheets.loadAll(),
    onReload: () => sheets.loadCurrent(),
    onSelect: (sql) => sheets.addQuerySheet(sql),
  });
  const sheets = new Sheets({ sqlite3, db: o.db, dbName: o.name, panel });
  sheets.loadAll();
}

$('btn-back').onclick = () => { location.hash = '#/'; };
$('db-name').onclick = async () => {
  if (!opened) return;
  const old = opened.name;
  const nn = await promptDialog('DBの名前変更', '新しい名前', old, (v) => nameCheck(v, old));
  if (nn == null || nn === old) return;
  routing = routing.then(async () => {
    await closeCurrent();
    try {
      await renameDb(old, nn);
      location.hash = dbHash(nn);
    } catch (e) {
      alert(e.message === 'busy' ? '別のタブで使用中のため操作できません' : e.message);
    }
    await route();
  });
};

window.addEventListener('hashchange', () => { routing = routing.then(route).catch(showError); });

function showError(e) {
  console.error(e);
  alert(e.message || String(e));
}

(async () => {
  try {
    sqlite3 = await initSqlite();
  } catch (e) {
    $('loading').textContent = 'sqlite-wasm の読み込みに失敗しました: ' + e.message;
    return;
  }
  $('loading').hidden = true;
  list = new ListView();
  routing = routing.then(route).catch(showError);
})();
