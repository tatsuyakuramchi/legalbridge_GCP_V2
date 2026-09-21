-- =====================================================================
-- 案件1件の棚卸し（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   取引先が1社の案件は party-documents.sql で足りる。ひとつの案件に
--   相手が何社も入るとき（同じ紙で複数の外注先に出している、案件の中で
--   役割が分かれている）は、取引先から辿ると案件の全体が見えない。
--   ここは案件を軸に、その中の相手ごとに並べる。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/matter-inventory.sql m=MTR-2026-00216
--
--     Cloud SQL Studio は \ で始まる行が効かない。先頭の \ の行を消して、
--     :'m' を 'MTR-2026-00216' のように（引用符ごと）置き換えて流す。
-- =====================================================================

\pset pager off

\if :{?m}
\else
\set m '案件番号'
\endif

-- ---------------------------------------------------------------------
-- 1. 案件。ここが空なら番号の綴りが違う
-- ---------------------------------------------------------------------
SELECT m.id                                              AS 案件id,
       m.matter_no                                       AS 案件番号,
       m.title                                           AS 案件名,
       m.kind                                            AS 種類,
       m.status                                          AS 状態,
       p.name                                            AS 案件の取引先,
       m.merged_into_id                                  AS 統合先id,
       (SELECT count(*) FROM v3.matter_links l
         WHERE l.matter_id = m.id AND l.target_type = 'condition')  AS 繋がる条件,
       (SELECT count(*) FROM v3.documents d
         WHERE d.matter_id = m.id)                       AS 文書
  FROM v3.matters m
  LEFT JOIN v3.parties p ON p.id = m.counterparty_id
 WHERE m.matter_no = :'m';

-- ---------------------------------------------------------------------
-- 2. この案件に出てくる取引先。相手が何社いるのかをまず見る
--
--    条件の取引先を数える。案件そのものの取引先欄（1節）は1社しか
--    持てないので、複数社の案件では当てにならない。
-- ---------------------------------------------------------------------
WITH conds AS (
  SELECT c.* FROM v3.conditions c
   WHERE c.id::text IN (SELECT l.target_ref FROM v3.matter_links l
                         JOIN v3.matters m ON m.id = l.matter_id
                        WHERE m.matter_no = :'m' AND l.target_type = 'condition')
      OR c.id IN (SELECT dc.condition_id FROM v3.document_conditions dc
                    JOIN v3.documents d ON d.id = dc.document_id
                    JOIN v3.matters m ON m.id = d.matter_id
                   WHERE m.matter_no = :'m')
)
SELECT p.id                                              AS 取引先id,
       p.name                                            AS 取引先名,
       CASE p.kind WHEN 'corporate' THEN '法人' WHEN 'individual' THEN '個人'
                   ELSE p.kind END                       AS 区分,
       count(*)                                          AS 条件の数,
       count(*) FILTER (WHERE c.status = 'active')       AS うち有効,
       sum((SELECT count(*) FROM v3.condition_events e
             WHERE e.condition_id = c.id AND e.status = 'active'))  AS 実績,
       sum((SELECT count(*) FROM v3.condition_events e
             WHERE e.condition_id = c.id AND e.status = 'active'
               AND e.document_id IS NULL))               AS 浮いている実績
  FROM conds c
  JOIN v3.parties p ON p.id = c.counterparty_id
 GROUP BY p.id, p.name, p.kind
 ORDER BY p.name;

-- ---------------------------------------------------------------------
-- 3. 条件ごとの棚卸し。取引先ごとに並べる
-- ---------------------------------------------------------------------
WITH conds AS (
  SELECT c.* FROM v3.conditions c
   WHERE c.id::text IN (SELECT l.target_ref FROM v3.matter_links l
                         JOIN v3.matters m ON m.id = l.matter_id
                        WHERE m.matter_no = :'m' AND l.target_type = 'condition')
      OR c.id IN (SELECT dc.condition_id FROM v3.document_conditions dc
                    JOIN v3.documents d ON d.id = dc.document_id
                    JOIN v3.matters m ON m.id = d.matter_id
                   WHERE m.matter_no = :'m')
),
doc AS (
  SELECT dc.condition_id, d.document_no, d.status, tv.id AS version_id, t.template_key
    FROM v3.document_conditions dc
    JOIN v3.documents d ON d.id = dc.document_id
    LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN v3.document_templates t ON t.id = tv.template_id
   WHERE d.status <> 'void'
)
SELECT p.name                                            AS 取引先,
       c.condition_no                                    AS 条件番号,
       c.id                                              AS 条件id,
       c.name                                            AS 条件名,
       c.status                                          AS 版,
       c.pricing_model                                   AS 計算方式,
       COALESCE(c.flat_amount, c.unit_amount)            AS 金額,
       (SELECT count(*) FROM v3.condition_schedules s
         WHERE s.condition_id = c.id)                    AS 予定明細,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active')       AS 実績,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active'
           AND e.document_id IS NOT NULL)                AS 結ばれた実績,
       (SELECT string_agg(x.document_no, '／' ORDER BY x.document_no)
          FROM doc x WHERE x.condition_id = c.id
           AND x.template_key IN ('purchase_order', 'intl_purchase_order'))   AS 発注書,
       (SELECT string_agg(x.document_no, '／' ORDER BY x.document_no)
          FROM doc x WHERE x.condition_id = c.id
           AND x.template_key IN ('inspection_certificate', 'royalty_statement')) AS 決済文書,
       (SELECT string_agg(x.document_no, '／' ORDER BY x.document_no)
          FROM doc x WHERE x.condition_id = c.id AND x.version_id IS NULL)    AS 種別不明の文書,
       (SELECT count(*) FROM v3.payment_allocations al
         WHERE al.condition_id = c.id)                   AS 支払の割当
  FROM conds c
  JOIN v3.parties p ON p.id = c.counterparty_id
 ORDER BY p.name, c.condition_no;

-- ---------------------------------------------------------------------
-- 4. この案件の文書
-- ---------------------------------------------------------------------
SELECT d.document_no                                     AS 文書番号,
       COALESCE(t.template_key, '（版が無い）')          AS ひな形,
       d.status                                          AS 状態,
       d.issued_at::date                                 AS 発行日,
       (SELECT count(*) FROM v3.document_conditions dc
         WHERE dc.document_id = d.id)                    AS 繋がっている条件,
       (SELECT string_agg(DISTINCT p.name, '／')
          FROM v3.document_conditions dc
          JOIN v3.conditions c ON c.id = dc.condition_id
          JOIN v3.parties p ON p.id = c.counterparty_id
         WHERE dc.document_id = d.id)                    AS 相手,
       (SELECT string_agg(c.condition_no, '／' ORDER BY c.condition_no)
          FROM v3.document_conditions dc
          JOIN v3.conditions c ON c.id = dc.condition_id
         WHERE dc.document_id = d.id)                    AS 繋がり先,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.document_id = d.id AND e.status = 'active')        AS 結ばれた実績,
       CASE WHEN d.supersedes_id IS NOT NULL THEN '訂正版' ELSE '' END AS 版
  FROM v3.documents d
  JOIN v3.matters m ON m.id = d.matter_id
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE m.matter_no = :'m'
 ORDER BY COALESCE(t.template_key, 'zz'), d.document_no NULLS LAST;

-- ---------------------------------------------------------------------
-- 5. 浮いている実績（決済文書に結ばれていないもの）
-- ---------------------------------------------------------------------
WITH conds AS (
  SELECT c.* FROM v3.conditions c
   WHERE c.id::text IN (SELECT l.target_ref FROM v3.matter_links l
                         JOIN v3.matters m ON m.id = l.matter_id
                        WHERE m.matter_no = :'m' AND l.target_type = 'condition')
      OR c.id IN (SELECT dc.condition_id FROM v3.document_conditions dc
                    JOIN v3.documents d ON d.id = dc.document_id
                    JOIN v3.matters m ON m.id = d.matter_id
                   WHERE m.matter_no = :'m')
)
SELECT p.name                                            AS 取引先,
       c.condition_no                                    AS 条件番号,
       e.id                                              AS 実績id,
       e.occurred_on                                     AS 納品日,
       e.inspected_on                                    AS 検収日,
       e.quantity                                        AS 数量,
       e.amount                                          AS 金額
  FROM v3.condition_events e
  JOIN conds c ON c.id = e.condition_id
  JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE e.status = 'active' AND e.document_id IS NULL
 ORDER BY p.name, c.condition_no, e.occurred_on, e.id;

-- ---------------------------------------------------------------------
-- 6. 仕分け。取引先ごと・条件ごとに、次に何をすればよいか
-- ---------------------------------------------------------------------
WITH conds AS (
  SELECT c.* FROM v3.conditions c
   WHERE c.id::text IN (SELECT l.target_ref FROM v3.matter_links l
                         JOIN v3.matters m ON m.id = l.matter_id
                        WHERE m.matter_no = :'m' AND l.target_type = 'condition')
      OR c.id IN (SELECT dc.condition_id FROM v3.document_conditions dc
                    JOIN v3.documents d ON d.id = dc.document_id
                    JOIN v3.matters m ON m.id = d.matter_id
                   WHERE m.matter_no = :'m')
),
state AS (
  SELECT p.name AS party, c.condition_no, c.name, c.id,
         (SELECT count(*) FROM v3.condition_events e
           WHERE e.condition_id = c.id AND e.status = 'active')     AS events,
         (SELECT count(*) FROM v3.condition_events e
           WHERE e.condition_id = c.id AND e.status = 'active'
             AND e.document_id IS NOT NULL)                         AS tied,
         (SELECT count(*) FROM v3.document_conditions dc
            JOIN v3.documents d ON d.id = dc.document_id
            LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
            LEFT JOIN v3.document_templates t ON t.id = tv.template_id
           WHERE dc.condition_id = c.id AND d.status <> 'void'
             AND t.template_key IN ('purchase_order', 'intl_purchase_order'))  AS orders,
         (SELECT count(*) FROM v3.document_conditions dc
            JOIN v3.documents d ON d.id = dc.document_id
            LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
           WHERE dc.condition_id = c.id AND d.status <> 'void'
             AND tv.id IS NULL)                                     AS unknown_docs,
         (SELECT count(*) FROM v3.payment_allocations al
           WHERE al.condition_id = c.id)                            AS allocs
    FROM conds c
    JOIN v3.parties p ON p.id = c.counterparty_id
   WHERE c.status = 'active'
)
SELECT party                                             AS 取引先,
       condition_no                                      AS 条件番号,
       name                                              AS 条件名,
       events                                            AS 実績,
       tied                                              AS 結ばれた実績,
       allocs                                            AS 支払の割当,
       CASE
         WHEN orders > 0 THEN '発注書あり'
         WHEN unknown_docs > 0 THEN '版の無い文書が付いている。発注書かどうか確かめる'
         ELSE '発注書なし（遡及で作るか、検収書だけで通すか）'
       END                                               AS 発注の側,
       CASE
         WHEN events = 0 THEN 'A 実績を足す'
         WHEN tied < events
           THEN format('B 実績 %s 件が決済文書に結ばれていない（検収書を作るか、'
                       || 'すでにある検収書に結ぶ）', events - tied)
         WHEN allocs = 0 THEN 'C 検収書まで繋がった。支払を立てる'
         ELSE 'D 繋がっている'
       END                                               AS 次にすること
  FROM state
 ORDER BY party, condition_no;
