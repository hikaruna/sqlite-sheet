"""手元・LAN で確かめるための配信サーバー（Python 標準ライブラリだけで動く）。

- 実在しないパス（拡張子なし／.html）には index.html を返す（SPA フォールバック。URL が /<DB 名>?sheet=… のため）
- すべての応答に Cache-Control: no-store を付ける
- sw.js と js/version.js を返すときだけ、版の 'dev' を「dev-年月日-時分秒」に差し替える。
  値はアプリのファイルの最新の更新日時なので、ファイルを保存するたびに sw.js の中身が変わり、
  ブラウザが新しい Service Worker を入れ直す。同じ値がホーム画面の版表示に出る。リポジトリのファイルは書き換えない

使い方:
  python tools/dev-server.py --port 8000
  python tools/dev-server.py --port 8767 --cert lan.crt --key lan.key   # HTTPS（スマホから確かめるとき）
"""
import argparse
import datetime
import http.server
import io
import os
import re
import ssl
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.git', '.github', '.claude', 'tools'}
# Windows ではレジストリ次第で .js が text/plain になり module が読めなくなるので明示する
TYPES = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
}
STAMPED = {
    '/sw.js': re.compile(r"^(const VERSION = )'dev'", re.M),
    '/js/version.js': re.compile(r"^(export const APP_VERSION = )'dev'", re.M),
}


def dev_version():
    latest = 0
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for f in files:
            latest = max(latest, os.path.getmtime(os.path.join(d, f)))
    return 'dev-' + datetime.datetime.fromtimestamp(latest).strftime('%Y%m%d-%H%M%S')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        local = self.translate_path(path)
        if not os.path.exists(local):
            ext = os.path.splitext(path)[1]
            if ext in ('', '.html'):
                self.path = '/index.html'
        elif path in STAMPED:
            return self.send_stamped(local, STAMPED[path])
        return super().send_head()

    def send_stamped(self, local, pattern):
        with open(local, encoding='utf-8') as f:
            text = pattern.sub(lambda m: f"{m.group(1)}'{dev_version()}'", f.read(), count=1)
        body = text.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/javascript; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--port', type=int, default=8000)
    p.add_argument('--bind', default='0.0.0.0')
    p.add_argument('--cert')
    p.add_argument('--key')
    a = p.parse_args()
    server = http.server.ThreadingHTTPServer((a.bind, a.port), Handler)
    scheme = 'http'
    if a.cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(a.cert, a.key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = 'https'
    print(f'{scheme}://localhost:{a.port}/ を配信中（{ROOT}）', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == '__main__':
    main()
