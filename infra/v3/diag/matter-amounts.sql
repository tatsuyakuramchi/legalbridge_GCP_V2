-- =====================================================================
-- 案件1件の金額を突き合わせる（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   「発注書と検収書は出してあるが、金額が一部違うらしい」を、取引先ごとに
--   1行で見るための照会。紙に刷られた金額・条件の予定額・実績の額・支払の額を
--   横に並べ、食い違うところにだけ印を付ける。
--
--   全部を作り直す前に、これを流して「本当に違うのは何人ぶんか」を見る。
--   違っていない紙まで作り直すと、相手に送った番号と台帳の番号が食い違う。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/matter-amounts.sql matter=RR241
--
--     matter= は案件番号でも件名の一部でもよい。
--
--     Cloud SQL Studio は \ で始まる行が効かない。先頭の \ の行を消して、
--     :'matter' を 'RR241' のように（引用符ごと）置き換えて流す。
--
--   ★ 出すもの
--     0. 探した語と当たった案件
--     1. 取引先ごとの突き合わせ（★ が付いた行だけ見ればよい）
--     2. 食い違った取引先の内訳（どの紙のどの行か）
--     3. 支払の状況（立てただけか、払ったか）
--
--   ★ 口座番号・名義・電話・住所は出さない。
-- =====================================================================

\pset pager off

\if :{?matter}
\else
\set matter '案件番号'
\endif

-- ---------------------------------------------------------------------
-- 0. 探した語と、当たった案件
-- ---------------------------------------------------------------------
SELECT :'matter'                                         AS 探した語,
       count(*)                                          AS 当たった案件
  FROM v3.matters m
 WHERE m.matter_no ILIKE '%' || :'matter' || '%'
    OR m.title     ILIKE '%' || :'matter' || '%';

SELECT m.id                                              AS 案件id,
       m.matter_no                                       AS 案件番号,
       m.title                                           AS 件名,
       m.status                                          AS 状態
  FROM v3.matters m
 WHERE m.matter_no ILIKE '%' || :'matter' || '%'
    OR m.title     ILIKE '%' || :'matter' || '%'
 ORDER BY m.id;

-- ---------------------------------------------------------------------
-- 1. 取引先ごとの突き合わせ
--
--    紙の金額は rendered_values の明細を足したもの（税抜）。
--    発注書は items、検収書は delivery_line_items を持つ。
--    条件・実績・支払は台帳の値。
--
--    判定は「紙（検収）＝実績＝支払」が揃っているか。揃っていれば「一致」。
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT m.id FROM v3.matters m
   WHERE m.matter_no ILIKE '%' || :'matter' || '%'
      OR m.title     ILIKE '%' || :'matter' || '%'
),
cond AS (
  SELECT c.id, c.condition_no, c.name, c.counterparty_id, c.status,
         COALESCE((SELECT sum(s.planned_amount) FROM v3.condition_schedules s
                    WHERE s.condition_id = c.id), 0)     AS 予定額,
         COALESCE((SELECT sum(e.amount) FROM v3.condition_events e
                    WHERE e.condition_id = c.id AND e.status = 'active'), 0) AS 実績額
    FROM v3.conditions c
   WHERE EXISTS (SELECT 1 FROM v3.matter_links ml
                  WHERE ml.matter_id IN (SELECT id FROM target)
                    AND ml.target_type = 'condition'
                    AND ml.target_ref = c.id::text)
),
-- 紙の金額。明細の amount_ex_tax（検収書は inspected_amount_ex_tax）を足す。
paper AS (
  SELECT d.id, d.document_no, d.status,
         -- delivery_line_items があれば検収書、items しか無ければ発注書。
         CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
              THEN '検収' ELSE '発注' END                AS 種別,
         (SELECT COALESCE(sum(COALESCE(NULLIF(regexp_replace(
                    COALESCE(r.line ->> 'amount_ex_tax',
                             r.line ->> 'inspected_amount_ex_tax', '0'),
                    '[^0-9-]', '', 'g'), '')::bigint, 0)), 0)
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                        THEN d.rendered_values -> 'delivery_line_items'
                        WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                        THEN d.rendered_values -> 'items'
                        ELSE '[]'::jsonb END) AS r(line))  AS 紙の金額,
         (SELECT dc.condition_id FROM v3.document_conditions dc
           WHERE dc.document_id = d.id ORDER BY dc.condition_id LIMIT 1) AS 条件id
    FROM v3.documents d
   WHERE d.matter_id IN (SELECT id FROM target)
     AND d.status <> 'void'
),
pay AS (
  SELECT c.id AS condition_id,
         COALESCE(sum(a.amount), 0)                      AS 支払額,
         count(DISTINCT y.id)                            AS 支払件数,
         count(DISTINCT y.id) FILTER (WHERE y.status = 'paid') AS 支払済
    FROM cond c
    LEFT JOIN v3.condition_events e ON e.condition_id = c.id AND e.status = 'active'
    LEFT JOIN v3.payment_allocations a ON a.event_id = e.id
    LEFT JOIN v3.payments y ON y.id = a.payment_id AND y.status <> 'canceled'
   GROUP BY c.id
)
SELECT p.name                                            AS 取引先,
       c.condition_no                                    AS 条件番号,
       c.status                                          AS 条件の状態,
       c.予定額,
       c.実績額,
       COALESCE((SELECT sum(pp.紙の金額) FROM paper pp
                  WHERE pp.条件id = c.id AND pp.種別 = '発注'), 0) AS 発注書の額,
       COALESCE((SELECT sum(pp.紙の金額) FROM paper pp
                  WHERE pp.条件id = c.id AND pp.種別 = '検収'), 0) AS 検収書の額,
       COALESCE(y.支払額, 0)                             AS 支払額,
       COALESCE(y.支払済, 0)                             AS 支払済の件数,
       -- 判定は3つに分ける。「金額が違う」だけが作り直しの話で、
       -- 「検収書がまだ」「支払がまだ」は続きをやれば済む。
       CASE
         WHEN c.実績額 = 0 THEN '実績なし'
         WHEN COALESCE((SELECT sum(pp.紙の金額) FROM paper pp
                         WHERE pp.条件id = c.id AND pp.種別 = '検収'), 0) = 0
           THEN '検収書がまだ'
         WHEN c.実績額 <> COALESCE((SELECT sum(pp.紙の金額) FROM paper pp
                                     WHERE pp.条件id = c.id AND pp.種別 = '検収'), 0)
           THEN '★ 紙と実績で金額が違う'
         WHEN COALESCE(y.支払額, 0) = 0 THEN '支払がまだ'
         WHEN c.実績額 <> COALESCE(y.支払額, 0) THEN '★ 支払額が違う'
         ELSE '一致'
       END                                               AS 判定,
       (SELECT string_agg(pp.document_no, ' / ' ORDER BY pp.document_no)
          FROM paper pp WHERE pp.条件id = c.id)          AS 紙
  FROM cond c
  LEFT JOIN v3.parties p ON p.id = c.counterparty_id
  LEFT JOIN pay y ON y.condition_id = c.id
 -- 食い違いを上に出す。
 ORDER BY (CASE
             WHEN c.実績額 = 0 THEN 3
             WHEN c.実績額 <> COALESCE((SELECT sum(pp.紙の金額) FROM paper pp
                                         WHERE pp.条件id = c.id AND pp.種別 = '検収'), 0)
               THEN 0
             WHEN c.実績額 <> COALESCE(y.支払額, 0) THEN 1
             ELSE 2
           END),
          p.name, c.condition_no;

-- ---------------------------------------------------------------------
-- 2. 紙の明細を1行ずつ（どの行の金額が違うのか）
--
--    1節で ★ が付いた取引先だけ見ればよい。
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT m.id FROM v3.matters m
   WHERE m.matter_no ILIKE '%' || :'matter' || '%'
      OR m.title     ILIKE '%' || :'matter' || '%'
)
SELECT p.name                                            AS 取引先,
       d.document_no                                     AS 文書番号,
       CASE WHEN k.field = 'delivery_line_items' THEN '検収' ELSE '発注' END AS 種別,
       r.ord                                             AS 行,
       r.line ->> 'item_name'                            AS 品目,
       r.line ->> 'quantity'                             AS 数量,
       r.line ->> 'unit_price'                           AS 単価,
       COALESCE(r.line ->> 'amount_ex_tax',
                r.line ->> 'inspected_amount_ex_tax')    AS 金額,
       r.line ->> 'ordered_amount_ex_tax'                AS 当初の額
  FROM v3.documents d
  LEFT JOIN v3.document_conditions dc ON dc.document_id = d.id
  LEFT JOIN v3.conditions c ON c.id = dc.condition_id
  LEFT JOIN v3.parties p ON p.id = c.counterparty_id
 CROSS JOIN LATERAL (VALUES ('items'), ('delivery_line_items')) AS k(field)
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(d.rendered_values -> k.field) = 'array'
              THEN d.rendered_values -> k.field ELSE '[]'::jsonb END)
       WITH ORDINALITY AS r(line, ord)
 WHERE d.matter_id IN (SELECT id FROM target)
   AND d.status <> 'void'
 ORDER BY p.name, d.document_no, k.field, r.ord;

-- ---------------------------------------------------------------------
-- 3. 支払の状況
--
--    立てただけか、払ったか。払ってあるものは作り直さない
--    （払った事実は銀行にしかない。台帳だけ作り直すと突き合わせが壊れる）。
-- ---------------------------------------------------------------------
WITH target AS (
  SELECT m.id FROM v3.matters m
   WHERE m.matter_no ILIKE '%' || :'matter' || '%'
      OR m.title     ILIKE '%' || :'matter' || '%'
)
SELECT p.name                                            AS 取引先,
       y.payment_no                                      AS 支払番号,
       y.amount                                          AS 金額,
       y.status                                          AS 状態,
       y.due_on                                          AS 期日,
       y.paid_on                                         AS 支払済日,
       string_agg(DISTINCT c.condition_no, ' / ')        AS 条件
  FROM v3.payments y
  JOIN v3.payment_allocations a ON a.payment_id = y.id
  JOIN v3.condition_events e ON e.id = a.event_id
  JOIN v3.conditions c ON c.id = e.condition_id
  LEFT JOIN v3.parties p ON p.id = y.party_id
 WHERE EXISTS (SELECT 1 FROM v3.matter_links ml
                WHERE ml.matter_id IN (SELECT id FROM target)
                  AND ml.target_type = 'condition'
                  AND ml.target_ref = c.id::text)
 GROUP BY p.name, y.payment_no, y.amount, y.status, y.due_on, y.paid_on
 ORDER BY p.name, y.payment_no;
