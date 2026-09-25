-- 支払が検収書を止めているときの調査（1件を詳しく）。読み取りだけ。
--
-- 使い方（予備系）
--   1. infra\v3\diag\payment-block.sql の頭の2行を書き換える
--   2. cd infra\local
--      docker compose run --rm ops sql /v3/diag/payment-block.sql
--
-- 使い方（本番）
--   Cloud SQL Studio に貼る（\set は使えないので、:payment_id と :'doc_no' を
--   直に書き換えてから貼る）。
--
-- どれを見ればよいか分からないときは、先に payment-blocks.sql（全体の見取り）。
--
-- 「この検収書の実績には、すでに支払 #26 があります」で止まったときに、
-- その支払が何者で、どの実績と重なっていて、いま有効な文書と繋がっているかを見る。
--
-- 口座も連絡先も引かない（この調査に要らない）。
--
-- ↓ 2行だけ書き換える（文字列は :'doc_no' の形で差すので、ここは素で書く）。
\set payment_id 26
\set doc_no 'ARC-INS-2026-1003'

SET search_path = v3;

-- 1) 支払そのもの。番号・状態・金額・期日。
SELECT 'この支払' AS "見るもの", p.id, p.payment_no, p.status, p.direction,
       p.amount, p.tax_amount, p.due_on, p.paid_on, p.created_at, p.legacy_id
  FROM payments p
 WHERE p.id = :payment_id;

-- 2) 何に割り当てているか。実績が「いま」どの文書に付いているかまで。
--    支払は文書への列を持たないので、繋がりはこの辿り方しかない。
--    実績の document_id は訂正版を出せば移り、元を無効にすれば外れる。
SELECT '割当' AS "見るもの", a.id AS alloc_id, a.amount,
       c.condition_no, c.name AS condition_name,
       a.event_id, e.status AS event_status, e.occurred_on, e.amount AS event_amount,
       e.document_id AS "実績がいま付いている文書",
       d.document_no, d.status AS document_status
  FROM payment_allocations a
  LEFT JOIN conditions c ON c.id = a.condition_id
  LEFT JOIN condition_events e ON e.id = a.event_id
  LEFT JOIN documents d ON d.id = e.document_id
 WHERE a.payment_id = :payment_id
 ORDER BY a.id;

-- 3) 止められている検収書の側。どの実績が載っているか。
SELECT 'この検収書' AS "見るもの", d.id, d.document_no, d.status, d.issued_at,
       e.id AS event_id, e.status AS event_status, e.occurred_on, e.amount
  FROM documents d
  LEFT JOIN condition_events e ON e.document_id = d.id
 WHERE d.document_no = :'doc_no'
 ORDER BY e.id;

-- 4) 重なっている実績。ここが空でないから止まっている。
SELECT '重なり' AS "見るもの", e.id AS event_id, e.occurred_on, e.amount, e.status
  FROM condition_events e
  JOIN documents d ON d.id = e.document_id AND d.document_no = :'doc_no'
  JOIN payment_allocations a ON a.event_id = e.id
  JOIN payments p ON p.id = a.payment_id
 WHERE p.id = :payment_id;

-- 5) この支払がどう立ったか。監査記録。
--    payment.create      … 条件に宛てて人が立てた（元から文書は無い）
--    payment.create_from_* … 文書から立てた
SELECT '経緯' AS "見るもの", a.occurred_at, a.actor, a.action, a.detail
  FROM audit_events a
 WHERE a.target_type = 'payment' AND a.target_id = :payment_id
 ORDER BY a.id;

-- 6) 同じ形のものが他にもあるか。
--    有効な支払なのに、割当の実績がどの文書にも付いていないもの。
--    （元の文書を無効にすると実績が外れ、支払だけが残る）
SELECT '同じ形の支払' AS "見るもの", p.id, p.payment_no, p.status, p.amount, p.due_on,
       count(*) AS "宙に浮いた割当"
  FROM payments p
  JOIN payment_allocations a ON a.payment_id = p.id
  JOIN condition_events e ON e.id = a.event_id
 WHERE p.status <> 'canceled' AND e.document_id IS NULL
 GROUP BY p.id, p.payment_no, p.status, p.amount, p.due_on
 ORDER BY p.id;
