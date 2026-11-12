# SQLiteシート

**JOIN や正規化ができる、1シート＝1テーブルの Google スプレッドシート。**
ブラウザだけで動く SQLite クライアントです。サーバー不要、データは端末の OPFS に保存されます。

## できること

- **スプレッドシートの操作感**：セルを選んで打てば即 `UPDATE`。矢印/Tab/Enter 移動、範囲選択、`Ctrl+C / V`（Excel・Google スプレッドシートと TSV で相互にコピペ）、`Ctrl+D` 下へコピー、`Ctrl+Z / Y` 元に戻す・やり直し
- **最下行に打てば行の追加**、貼り付けがはみ出せば複数行をまとめて `INSERT`（1トランザクション。1つでも失敗すれば全部取り消し）
- **3種類のシート**：テーブル ▦（編集可）／ビュー ◫／クエリ ⌕（任意の `SELECT`。「ビューとして保存」で昇格）
- **設計パネル（⚙ 設計）**：列の型・NOT NULL・DEFAULT・CHECK・COLLATE・生成列、**複合 PRIMARY KEY、複数の UNIQUE、複数列の FOREIGN KEY（ON DELETE/UPDATE）**、表の CHECK、`STRICT` / `WITHOUT ROWID` / `AUTOINCREMENT`、インデックス
  - ALTER TABLE でできない変更（型やキーの変更など）も、データを保ったまま公式手順でテーブルを作り直して反映。実行前に SQL を確認できます
- **外部キーが見える**：参照先の名前をセルに併記、`Alt+↓` で参照先から選択、`Ctrl+クリック` で参照先へジャンプ、列メニューから JOIN 済みのクエリを作成
- **SQL コンソール（`Ctrl+\``）**：GUI でできないことは SQL で。GUI が発行した SQL もすべて「実行履歴」に残ります
- 並べ替え・絞り込み（チップで表示）、CSV の読み込み/書き出し、`Ctrl+K` コマンドパレット
- **ローカルファイルを直接編集**（Chrome / Edge）：別のモードとして、パソコンの `.sqlite` ファイルをそのまま開いて編集できます。保存は手動（`Ctrl+S`）。開いた後にほかのアプリでファイルが変更されていれば、保存するときやタブに戻ったときに知らせて「上書き保存／読み直す」を選べます。未保存のまま閉じようとすると確認します。閉じたら何も残らず、「ローカルファイルを直接編集」の「最近開いたファイル」から開き直せます
- **複数 DB**：作成・切替・名前変更・複製・削除、`.sqlite` ファイルの取り込み（ドラッグ＆ドロップ可）とファイルへの書き出し（保存先を選べます）
- **スマホでも使えます**：表は二本指でつまむと、上下のバーはそのままで表だけを拡大縮小できます
- 外部キー制約は常に有効（`PRAGMA foreign_keys = ON`）、GUI で作るテーブルは既定で `STRICT`

## 動かし方

ビルド不要のバニラ JS（ES Modules）です。静的ファイルとして配信するだけで動きます。

URL は `/<DB 名>?sheet=<シート名>` の形で、DB をパスで表します（保存クエリは `?sheet=~<名前>`。名前自体の先頭の `~` は `~~` と重ねて書きます）。存在しないパスにも `index.html` を返す（SPA フォールバック）サーバーで配信してください。ローカルでは [miniserve](https://github.com/svenstaro/miniserve) を使います（初回だけ `cargo install miniserve`。プロジェクトにはファイルを追加しません）。

```sh
miniserve --spa --index index.html -p 8000 .
# → http://localhost:8000/
```

### GitHub Pages で公開

リポジトリの Settings → Pages で、このブランチのルートを公開するだけです。
GitHub Pages は SPA フォールバックを設定できないため、`404.html` が元の URL を預けてアプリの入口へ転送し、アプリ側で元の URL に戻します。
COOP/COEP ヘッダーは不要です（SharedArrayBuffer を使わない `opfs-sahpool` VFS を採用）。

## しくみ

| ファイル | 役割 |
|---|---|
| `js/db-worker.js` | Worker 内で sqlite-wasm を動かし、`opfs-sahpool` に DB ごとのファイルを置く |
| `js/db-client.js` | Worker との RPC。発行した SQL を履歴に流す |
| `js/store.js` | DB ごとの端末側データ（保存クエリ・並び順・列幅）。DB の名前変更・複製・削除に追従 |
| `js/files.js` | ファイルの直接編集の補助：最近開いたファイル（ファイルハンドルだけを IndexedDB に保存）と読み書きの許可 |
| `js/schema.js` | スキーマの読み取り、CREATE TABLE の生成、テーブル再作成 SQL |
| `js/grid.js` | 仮想スクロールのグリッド（選択・編集・コピペ） |
| `js/sources.js` | テーブル／クエリをグリッドにつなぐ（UPDATE/INSERT/DELETE と Undo 記録） |
| `js/design-panel.js` | 設計パネル |
| `js/console.js` | SQL コンソール |
| `js/main.js` | 画面全体・DB/シート管理 |
| （外部）| 公式 [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm) 3.54.1-build1 を jsDelivr から ES module として import（`js/db-worker.js`） |

DB の中にはアプリ用のデータを書き込みません。クエリシートの SQL・シートの並び順・列の幅などは端末の localStorage に DB ごとに保存されるので（`js/store.js`）、書き出した `.sqlite` ファイルには含まれません。

## 注意

- 同時に開けるのは 1 タブだけです（`opfs-sahpool` の制約）
- Undo はデータ編集（セル・行の追加/削除・貼り付け）が対象です。構造の変更や SQL コンソールでの変更は取り消せません。大事なデータは書き出してバックアップしてください
- データベースは OPFS（ブラウザのサイトデータ）に保存されます。サイトデータを消すと DB も消えます。大事なものは「ファイルに書き出す」で保存してください
- ローカルファイルを直接編集するときは中身をメモリに読み込むので、保存しないままブラウザが落ちると変更は失われます。保存のたびにファイル全体を書き直すので（一時ファイルに書いてから差し替えるため、保存中に落ちても元のファイルは壊れません）、数百 MB を超えるような大きな DB には向きません
