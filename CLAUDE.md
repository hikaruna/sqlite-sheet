# CLAUDE.md

## 公開版

- アプリ: https://www.hikaruna.net/sqlite-sheet/ （main への push で GitHub Pages に公開される）
- ブランチ上のプロジェクトファイルを公開版で確かめる URL:
  `https://www.hikaruna.net/sqlite-sheet/?project=https://raw.githubusercontent.com/hikaruna/sqlite-sheet/<ブランチ>/docs/examples/<名前>.sqlitesheet`

## サンプル

- `docs/examples/sample.*`: 小さな商品の例
- `docs/examples/orders.*`: 顧客 → 注文 → 注文明細（＋商品）の3段の例。JOIN のビュー（明細一覧）、LEFT JOIN のビュー（顧客の注文。注文のない顧客がいる）、サブクエリのビュー（注文一覧）、注文明細のテーブルに、フォームのグループ（`groupBy`）を付けてある。明細一覧と顧客の注文は INSTEAD OF トリガーで書ける
- `docs/examples/met.*`: メトロポリタン美術館のオープンアクセス（ハイライト作品・パブリックドメイン）から作った所蔵品の DB。`時代` の区分（古代〜近代と世紀）はこのサンプルでの決め事
  - 日本語の名前：作品・作者・タグは Wikidata の日本語ラベル（なければ英語のまま）。部門・素材・種類・役割はこのサンプルで付けた訳。元の英語は `原名`・`原題` 列に残す
  - Wikidata のラベルの誤りを手で直したもの：Timothy H. O'Sullivan →「ティモシー・H・オサリバン」、Tunic with Confronting Catfish →「向かい合うナマズの上着」
  - `作品.画像` は長辺 160px の JPEG の BLOB。Met の画像サーバーに負荷をかけないよう、URL の画像は使わない
