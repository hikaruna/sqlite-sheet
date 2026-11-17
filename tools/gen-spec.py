"""docs/openapi.json から、人が読む仕様書 docs/project-format.md を作る（Python の標準ライブラリだけで動く）。

    python tools/gen-spec.py          # docs/project-format.md を書き出す
    python tools/gen-spec.py --check  # 書き出したものと違えば失敗する（GitHub Actions で使う）

仕様を変えるときは docs/openapi.json を直し、このスクリプトで作り直して、両方を同じコミットに入れる。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'docs' / 'openapi.json'
OUT = ROOT / 'docs' / 'project-format.md'

PLACE = {'path': 'パス', 'query': '`?`', 'fragment': '`#`'}
SCOPE = {'project': 'プロジェクト', 'state': '開いたときの状態'}


def cell(text):
    """表のセルに入れる文字（| と改行を逃がす）"""
    return str(text).replace('|', '\\|').replace('\n', '<br>')


def anchor(title):
    """GitHub の見出しのアンカー（小文字にし、英数字・かな漢字・-・_ 以外を消し、空白を - に）"""
    t = title.strip().lower()
    t = ''.join(ch for ch in t if ch.isalnum() or ch in ' -_')
    return t.replace(' ', '-')


def code(v):
    return '`' + json.dumps(v, ensure_ascii=False) + '`'


def type_of(s):
    """スキーマ → 短い型の表記"""
    if s is None or s is False:
        return ''
    if '$ref' in s:
        name = s['$ref'].rsplit('/', 1)[-1]
        return f'[{name}](#{name.lower()})'
    if 'const' in s:
        return code(s['const'])
    if 'enum' in s:
        return ' / '.join(code(v) for v in s['enum'])
    if 'oneOf' in s:
        return ' か '.join(f'（{t}）' if (' / ' in t or ' か ' in t) and not t.startswith('（') else t for t in map(type_of, s['oneOf']))
    t = s.get('type')
    if isinstance(t, list):
        return ' / '.join(type_of({**s, 'type': x}) for x in t)
    if t == 'array':
        if 'prefixItems' in s:
            return '[' + ', '.join(type_of(x) for x in s['prefixItems']) + ']'
        t = type_of(s.get('items'))
        return f'（{t}）の配列' if ' ' in t else f'{t}の配列'
    if t == 'object' and isinstance(s.get('additionalProperties'), dict):
        return f'{{ 名前: {type_of(s["additionalProperties"])} }}'
    return {'string': '文字列', 'integer': '整数', 'number': '数値', 'boolean': '真偽値', 'object': 'オブジェクト', 'null': 'null'}.get(t, t or '')


def pretty(v, indent=''):
    """JSON を整形する。短いもの（1行で 60 文字まで）は1行にまとめる"""
    flat = json.dumps(v, ensure_ascii=False, separators=(', ', ': '))
    if len(indent) + len(flat) <= 60 or not isinstance(v, (list, dict)) or not v:
        return flat
    inner = indent + '  '
    if isinstance(v, list):
        items = [inner + pretty(x, inner) for x in v]
        return '[\n' + ',\n'.join(items) + '\n' + indent + ']'
    items = [inner + json.dumps(k, ensure_ascii=False) + ': ' + pretty(x, inner) for k, x in v.items()]
    return '{\n' + ',\n'.join(items) + '\n' + indent + '}'


def json_block(v):
    return ['```json', pretty(v), '```']


def render(spec):
    info = spec['info']
    out = [
        f'# {info["title"]}',
        '',
        '<!-- このファイルは生成物です。docs/openapi.json を直して、python tools/gen-spec.py で作り直してください -->',
        f'> このファイルは [`openapi.json`](openapi.json) から `python tools/gen-spec.py` で作った生成物です。直すときは `openapi.json` を直してください。形式の版：{info["version"]}',
        '',
        info['description'],
        '',
    ]
    sections = spec.get('x-sections', [])
    schemas = spec['components']['schemas']
    toc = ['ファイル（.sqlitesheet）']
    toc += [f'URL：{m.upper()} {p}' for p, ops in spec['paths'].items() for m in ops]
    toc += [x['title'] for x in sections] + ['スキーマ']
    out += ['## 目次', '']
    out += [f'{i}. [{t}](#{anchor(t)})' for i, t in enumerate(toc, 1)]
    out.append('')

    # ---- ファイル ----
    f = spec['x-file']
    out += ['## ファイル（.sqlitesheet）', '',
            '| 項目 | 値 |', '|---|---|',
            f'| 拡張子 | `{f["extension"]}` |',
            f'| MIME タイプ | `{f["mediaType"]}` |',
            f'| 中身 | [{f["schema"]}](#{f["schema"].lower()}) |', '',
            f['description'], '', '例：', '']
    out += json_block(f['example']) + ['']

    # ---- URL ----
    for path, ops in spec['paths'].items():
        for method, op in ops.items():
            out += [f'## URL：{method.upper()} {path}', '', f'**{op["summary"]}**', '', op['description'], '']
            params = op.get('parameters', [])
            for title, ps in (('パラメーター', [p for p in params if not p.get('deprecated')]),
                              ('以前の書き方（読み込みだけ）', [p for p in params if p.get('deprecated')])):
                if not ps:
                    continue
                out += [f'### {title}', '', '| 名前 | 置き場所 | 種類 | 型 | 説明 | 例 |', '|---|---|---|---|---|---|']
                for p in ps:
                    place = PLACE[p.get('x-in', p['in'])]
                    if p.get('style') == 'deepObject':
                        place += '（ブラケット記法）'
                    ex = f'`{p["example"]}`' if 'example' in p else ''
                    out.append('| ' + ' | '.join(cell(x) for x in (
                        f'`{p["name"]}`', place, SCOPE.get(p.get('x-scope'), ''), type_of(p.get('schema')), p.get('description', ''), ex)) + ' |')
                out.append('')
            if op.get('x-examples'):
                out += ['### 例', '']
                for ex in op['x-examples']:
                    out += [f'**{ex["summary"]}**', '', '```', ex['value'], '```', '']
                    if ex.get('description'):
                        out += [ex['description'], '']
            out += ['### 結果', '', '| | 説明 |', '|---|---|']
            for k, r in op.get('responses', {}).items():
                out.append(f'| {"成功" if k.startswith("2") else "失敗"} | {cell(r["description"])} |')
            out.append('')

    # ---- 補足の決まり ----
    for x in sections:
        out += [f'## {x["title"]}', '', x['body'], '']

    # ---- スキーマ ----
    out += ['## スキーマ', '']
    for name, s in schemas.items():
        out += [f'### {name}', '', s.get('description', ''), '']
        props = s.get('properties')
        if props:
            req = set(s.get('required', []))
            out += ['| 名前 | 型 | 必須 | 説明 |', '|---|---|---|---|']
            for k, p in props.items():
                desc = p.get('description') or schemas.get(p.get('$ref', '').rsplit('/', 1)[-1], {}).get('description', '')
                out.append('| ' + ' | '.join(cell(x) for x in (f'`{k}`', type_of(p), '○' if k in req else '', desc.split('\n')[0] if '$ref' in p and not p.get('description') else desc)) + ' |')
            out.append('')
        else:
            out += [f'型：{type_of(s)}', '']
        if 'example' in s:
            out += ['例：', ''] + json_block(s['example']) + ['']
    return '\n'.join(out).rstrip('\n') + '\n'


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    text = render(json.loads(SRC.read_text(encoding='utf-8')))
    if '--check' in sys.argv:
        now = OUT.read_text(encoding='utf-8').replace('\r\n', '\n') if OUT.exists() else ''
        if now != text:
            print(f'{OUT.relative_to(ROOT)} が {SRC.relative_to(ROOT)} と合っていません。python tools/gen-spec.py で作り直してコミットしてください', file=sys.stderr)
            sys.exit(1)
        print('ok')
        return
    OUT.write_bytes(text.encode('utf-8'))
    print(f'{OUT.relative_to(ROOT)} を書き出しました')


if __name__ == '__main__':
    main()
