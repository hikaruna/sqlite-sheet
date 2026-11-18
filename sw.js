// Service Worker：アプリのファイルを端末に保存して、電波がなくても起動できるようにする。
// DB（OPFS）には触れない。保存先は Cache Storage
const VERSION = 'dev';         // 公開時は pages.yml がコミットハッシュに、検証用サーバーは dev-更新日時 に差し替える
const APP = `app-${VERSION}`;   // 自前のファイル（ネット優先。つながらないときだけ保存分を使う）
const CDN = 'cdn-v1';           // jsDelivr の sqlite-wasm（URL に版が入っていて中身が変わらないので保存分を優先）

const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'docs/examples/met.sqlitesheet', 'docs/examples/met.sqlite', // 「サンプル」の中身（オフラインでも作れるように）
  ...['blob', 'console', 'db-client', 'db-worker', 'design-panel', 'files', 'grid', 'i18n', 'locales/en', 'main', 'project', 'protect',
    'schema', 'sources', 'store', 'triggers', 'txmarks', 'ui', 'undo', 'version'].map((f) => `js/${f}.js`),
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(APP);
    await cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== APP && k !== CDN) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'cdn.jsdelivr.net') return e.respondWith(cacheFirst(req));
  if (url.origin !== location.origin) return;
  // 画面遷移（/<DB 名> など）はどれもアプリの入口。オフラインなら保存した index.html を返す
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, 'index.html'));
  e.respondWith(networkFirst(req));
});

async function networkFirst(req, fallback) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (res.ok && !fallback) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (fallback && await cache.match(fallback));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
