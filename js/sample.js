// サンプル DB：正規化された小さな販売データ
export async function createSample(db) {
  const sql = `
CREATE TABLE "都道府県" (
  "id" INTEGER PRIMARY KEY,
  "名前" TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE "顧客" (
  "id" INTEGER PRIMARY KEY,
  "名前" TEXT NOT NULL,
  "メール" TEXT UNIQUE,
  "都道府県_id" INTEGER REFERENCES "都道府県" ("id"),
  "登録日" TEXT NOT NULL DEFAULT (date('now'))
) STRICT;

CREATE TABLE "商品" (
  "コード" TEXT PRIMARY KEY,
  "名前" TEXT NOT NULL,
  "単価" INTEGER NOT NULL CHECK ("単価" >= 0)
) STRICT;

CREATE TABLE "注文" (
  "id" INTEGER PRIMARY KEY,
  "顧客_id" INTEGER NOT NULL REFERENCES "顧客" ("id"),
  "注文日" TEXT NOT NULL
) STRICT;

CREATE TABLE "注文明細" (
  "注文_id" INTEGER NOT NULL,
  "商品コード" TEXT NOT NULL,
  "数量" INTEGER NOT NULL DEFAULT 1 CHECK ("数量" > 0),
  PRIMARY KEY ("注文_id", "商品コード"),
  FOREIGN KEY ("注文_id") REFERENCES "注文" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("商品コード") REFERENCES "商品" ("コード")
) STRICT, WITHOUT ROWID;

INSERT INTO "都道府県" ("id", "名前") VALUES (1, '北海道'), (13, '東京都'), (14, '神奈川県'), (23, '愛知県'), (27, '大阪府'), (40, '福岡県');
INSERT INTO "顧客" ("名前", "メール", "都道府県_id", "登録日") VALUES
  ('佐藤 花子', 'hanako@example.com', 13, '2026-01-12'),
  ('鈴木 一郎', 'ichiro@example.com', 27, '2026-02-03'),
  ('高橋 美咲', 'misaki@example.com', 14, '2026-02-20'),
  ('田中 健', NULL, 1, '2026-03-08'),
  ('伊藤 さくら', 'sakura@example.com', 40, '2026-04-15'),
  ('渡辺 翔', 'sho@example.com', 23, '2026-05-01');
INSERT INTO "商品" VALUES ('A-001', 'ノート', 220), ('A-002', 'ボールペン', 150), ('B-010', '付箋', 330), ('C-100', 'ファイル', 480), ('C-200', 'デスクライト', 3980);
INSERT INTO "注文" ("顧客_id", "注文日") VALUES (1, '2026-06-01'), (2, '2026-06-03'), (1, '2026-06-10'), (3, '2026-07-02'), (5, '2026-07-15'), (6, '2026-08-01');
INSERT INTO "注文明細" VALUES (1, 'A-001', 3), (1, 'A-002', 5), (2, 'C-200', 1), (3, 'B-010', 2), (4, 'A-001', 10), (4, 'C-100', 2), (5, 'A-002', 1), (6, 'C-200', 2), (6, 'B-010', 4);

CREATE VIEW "売上明細" AS
SELECT o."id" AS "注文", o."注文日", c."名前" AS "顧客", p."名前" AS "商品", p."単価", d."数量", p."単価" * d."数量" AS "金額"
FROM "注文明細" d
JOIN "注文" o ON o."id" = d."注文_id"
JOIN "顧客" c ON c."id" = o."顧客_id"
JOIN "商品" p ON p."コード" = d."商品コード";

CREATE TABLE "_sqlite_sheet_queries" (name TEXT PRIMARY KEY, sql TEXT NOT NULL) STRICT;
INSERT INTO "_sqlite_sheet_queries" VALUES ('顧客別の売上', 'SELECT "顧客", count(DISTINCT "注文") AS "注文数", sum("金額") AS "売上"
FROM "売上明細"
GROUP BY "顧客"
ORDER BY "売上" DESC');
`;
  await db.exec(sql, undefined, 'gui');
}
