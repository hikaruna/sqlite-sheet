// サンプル DB：正規化された小さなカフェの販売データ。
// データは言語で分けず英語だけ（題材は日本でもなじみのあるカフェのメニュー）

// 保存クエリは DB の外（端末側）に置く
export const SAMPLE_QUERIES = [{
  name: 'sales_by_customer',
  sql: `SELECT customer, count(DISTINCT order_id) AS orders, sum(amount) AS sales
FROM sales
GROUP BY customer
ORDER BY sales DESC`,
}];

export async function createSample(db) {
  const sql = `
CREATE TABLE cities (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  city_id INTEGER REFERENCES cities (id),
  joined_on TEXT NOT NULL DEFAULT (date('now'))
) STRICT;

CREATE TABLE menu_items (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0)
) STRICT;

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  ordered_on TEXT NOT NULL
) STRICT;

CREATE TABLE order_items (
  order_id INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (order_id, item_code),
  FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  FOREIGN KEY (item_code) REFERENCES menu_items (code)
) STRICT, WITHOUT ROWID;

INSERT INTO cities (id, name) VALUES (1, 'Tokyo'), (2, 'Osaka'), (3, 'New York'), (4, 'London'), (5, 'Paris'), (6, 'Sydney');
INSERT INTO customers (name, email, city_id, joined_on) VALUES
  ('Emma Smith', 'emma@example.com', 1, '2026-01-12'),
  ('Liam Brown', 'liam@example.com', 3, '2026-02-03'),
  ('Olivia Jones', 'olivia@example.com', 4, '2026-02-20'),
  ('Noah Miller', NULL, 2, '2026-03-08'),
  ('Ava Wilson', 'ava@example.com', 5, '2026-04-15'),
  ('Lucas Taylor', 'lucas@example.com', 6, '2026-05-01');
INSERT INTO menu_items VALUES ('D-001', 'Espresso', 350), ('D-002', 'Cafe Latte', 480), ('D-003', 'Cappuccino', 480), ('F-010', 'Sandwich', 650), ('F-020', 'Cheesecake', 520);
INSERT INTO orders (customer_id, ordered_on) VALUES (1, '2026-06-01'), (2, '2026-06-03'), (1, '2026-06-10'), (3, '2026-07-02'), (5, '2026-07-15'), (6, '2026-08-01');
INSERT INTO order_items VALUES (1, 'D-002', 2), (1, 'F-020', 1), (2, 'D-001', 1), (3, 'D-003', 2), (4, 'D-002', 3), (4, 'F-010', 2), (5, 'D-001', 1), (6, 'F-010', 1), (6, 'D-003', 2);

CREATE VIEW sales AS
SELECT o.id AS order_id, o.ordered_on, c.name AS customer, m.name AS item, m.price, i.quantity, m.price * i.quantity AS amount
FROM order_items i
JOIN orders o ON o.id = i.order_id
JOIN customers c ON c.id = o.customer_id
JOIN menu_items m ON m.code = i.item_code;

`;
  await db.exec(sql, undefined, 'gui');
}
