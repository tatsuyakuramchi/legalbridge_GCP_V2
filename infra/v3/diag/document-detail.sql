-- =====================================================================
-- 文書1件の中身を見る（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   棚卸しで「この紙は何なのか」を決めるときに使う。番号の接頭辞では
--   発注書か検収書か決められないことがある（V2 から来た文書はひな形の版が
--   付いていないので、機械にも判別できない）。紙に刷られている明細と、
--   繋がっている条件・実績を並べれば、人には分かる。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/document-detail.sql doc=ARC-PO-2026-0092
--
--     Cloud SQL Studio は \ で始まる行が効かない。先頭の \ の行を消して、
--     :'doc' を 'ARC-PO-2026-0092' のように（引用符ごと）置き換えて流す。
-- =====================================================================

\pset pager off

\if :{?doc}
\else
\set doc '文書番号'
\endif

-- ---------------------------------------------------------------------
-- 1. 文書の輪郭
-- ---------------------------------------------------------------------
SELECT d.id                                              AS 文書id,
       d.document_no                                     AS 文書番号,
       COALESCE(t.template_key, '（版が無い）')          AS ひな形,
       d.status                                          AS 状態,
       d.issued_at::date                                 AS 発行日,
       d.issued_by                                       AS 発行者,
       m.matter_no                                       AS 案件番号,
       m.title                                           AS 案件名,
       CASE WHEN d.legacy_id IS NOT NULL THEN 'V2から移行' ELSE 'V3で作った' END AS 出どころ,
       (SELECT x.document_no FROM v3.documents x WHERE x.id = d.supersedes_id)   AS 訂正元,
       (SELECT string_agg(x.document_no, '／') FROM v3.documents x
         WHERE x.supersedes_id = d.id)                   AS この文書の訂正版,
       d.storage_url IS NOT NULL                         AS ファイルあり
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.matters m ON m.id = d.matter_id
 WHERE d.document_no = :'doc';

-- ---------------------------------------------------------------------
-- 2. 繋がっている条件（document_conditions）
-- ---------------------------------------------------------------------
SELECT dc.line_no                                        AS 行,
       c.condition_no                                    AS 条件番号,
       c.name                                            AS 条件名,
       c.status                                          AS 版,
       c.pricing_model                                   AS 計算方式,
       COALESCE(c.flat_amount, c.unit_amount)            AS 金額,
       c.term_start                                      AS 開始日,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active')  AS その条件の実績
  FROM v3.document_conditions dc
  JOIN v3.documents d ON d.id = dc.document_id
  JOIN v3.conditions c ON c.id = dc.condition_id
 WHERE d.document_no = :'doc'
 ORDER BY dc.line_no;

-- ---------------------------------------------------------------------
-- 3. この文書に結ばれた実績（condition_events.document_id）
-- ---------------------------------------------------------------------
SELECT c.condition_no                                    AS 条件番号,
       e.id                                              AS 実績id,
       e.occurred_on                                     AS 納品日,
       e.inspected_on                                    AS 検収日,
       e.quantity                                        AS 数量,
       e.amount                                          AS 金額,
       e.status                                          AS 状態
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
  JOIN v3.documents d ON d.id = e.document_id
 WHERE d.document_no = :'doc'
 ORDER BY e.occurred_on, e.id;

-- ---------------------------------------------------------------------
-- 4. 紙に刷られている明細。1行ずつ
--
--    発注書は items、検収書は delivery_line_items に入っている。
--    どちらに入っているかで、その紙がどちらなのかが決まる。
-- ---------------------------------------------------------------------
SELECT k.field                                           AS どの表,
       (r.ord)                                           AS 行,
       r.line ->> 'item_name'                            AS 品目,
       r.line ->> 'quantity'                             AS 数量,
       r.line ->> 'inspected_quantity'                   AS 検収数量,
       r.line ->> 'unit_price'                           AS 単価,
       COALESCE(r.line ->> 'amount_ex_tax',
                r.line ->> 'inspected_amount_ex_tax')    AS 金額,
       r.line ->> 'ordered_amount_ex_tax'                AS 予定額,
       r.line ->> 'delivery_date'                        AS 納品日,
       r.line ->> 'payment_date'                         AS 支払日,
       r.line ->> 'paid_date'                            AS 支払済日
  FROM v3.documents d
 CROSS JOIN LATERAL (VALUES ('items'), ('delivery_line_items')) AS k(field)
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(d.rendered_values -> k.field) = 'array'
              THEN d.rendered_values -> k.field ELSE '[]'::jsonb END)
       WITH ORDINALITY AS r(line, ord)
 WHERE d.document_no = :'doc'
 ORDER BY k.field, r.ord;

-- ---------------------------------------------------------------------
-- 5. 紙の合計。2節の条件の金額と突き合わせる
-- ---------------------------------------------------------------------
SELECT k.field                                           AS どの表,
       count(*)                                          AS 行の数,
       sum(COALESCE(NULLIF(regexp_replace(
             COALESCE(r.line ->> 'amount_ex_tax',
                      r.line ->> 'inspected_amount_ex_tax', '0'),
             '[^0-9-]', '', 'g'), '')::bigint, 0))       AS 金額の合計
  FROM v3.documents d
 CROSS JOIN LATERAL (VALUES ('items'), ('delivery_line_items')) AS k(field)
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(d.rendered_values -> k.field) = 'array'
              THEN d.rendered_values -> k.field ELSE '[]'::jsonb END)
       AS r(line)
 WHERE d.document_no = :'doc'
 GROUP BY k.field
 ORDER BY k.field;
