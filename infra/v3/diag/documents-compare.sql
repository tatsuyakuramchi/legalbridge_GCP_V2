-- =====================================================================
-- 複数の文書を並べて見比べる（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   「同じ紙が何枚もある」のか「回ごとの紙が並んでいる」のかを見分ける。
--   定期課金の月ごとの検収書は、金額も品目も毎月同じ。納品日が空欄だと
--   中身が完全に一致して見えるので、重複判定だけで畳むと本物を消す。
--
--   見分ける手がかりは、紙の中身ではなく外側にある。
--     ・発行日が月ごとにずれているか（ずれていれば月ごとの紙）
--     ・V2 の元 id（legacy_id）が連番か
--     ・結ばれていた実績が違う回か
--   3節にそれを並べる。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/documents-compare.sql \
--       docs=ARC-INS-2026-0059,ARC-INS-2026-0060,ARC-INS-2026-0061,ARC-INS-2026-0062
-- =====================================================================

\pset pager off

\if :{?docs}
\else
\set docs ''
\endif

-- ---------------------------------------------------------------------
-- 1. 輪郭。発行日と元 id が手がかり
-- ---------------------------------------------------------------------
WITH want AS (
  SELECT btrim(v) AS no FROM unnest(string_to_array(:'docs', ',')) AS v
   WHERE btrim(v) <> ''
)
SELECT w.no                                              AS 文書番号,
       d.id                                              AS 文書id,
       COALESCE(t.template_key, '（版が無い）')          AS ひな形,
       d.status                                          AS 状態,
       d.issued_at::date                                 AS 発行日,
       m.matter_no                                       AS 案件番号,
       d.legacy_id                                       AS V2の元id,
       (SELECT count(*) FROM v3.document_conditions dc
         WHERE dc.document_id = d.id)                    AS 繋がる条件,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.document_id = d.id)                     AS 結ばれた実績,
       (SELECT string_agg(c.condition_no, '／' ORDER BY c.condition_no)
          FROM v3.document_conditions dc
          JOIN v3.conditions c ON c.id = dc.condition_id
         WHERE dc.document_id = d.id)                    AS 繋がり先
  FROM want w
  LEFT JOIN v3.documents d ON d.document_no = w.no
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.matters m ON m.id = d.matter_id
 ORDER BY w.no;

-- ---------------------------------------------------------------------
-- 2. 紙の中身。文書ごとに1行ずつ並べる
-- ---------------------------------------------------------------------
SELECT d.document_no                                     AS 文書番号,
       k.field                                           AS どの表,
       r.ord                                             AS 行,
       r.line ->> 'item_name'                            AS 品目,
       COALESCE(r.line ->> 'inspected_quantity',
                r.line ->> 'quantity')                   AS 数量,
       COALESCE(r.line ->> 'inspected_amount_ex_tax',
                r.line ->> 'amount_ex_tax')              AS 金額,
       r.line ->> 'delivery_date'                        AS 納品日,
       r.line ->> 'paid_date'                            AS 支払日
  FROM v3.documents d
 CROSS JOIN LATERAL (VALUES ('items'), ('delivery_line_items')) AS k(field)
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(d.rendered_values -> k.field) = 'array'
              THEN d.rendered_values -> k.field ELSE '[]'::jsonb END)
       WITH ORDINALITY AS r(line, ord)
 WHERE d.document_no = ANY(
         SELECT btrim(v) FROM unnest(string_to_array(:'docs', ',')) AS v
          WHERE btrim(v) <> '')
 ORDER BY d.document_no, k.field, r.ord;

-- ---------------------------------------------------------------------
-- 3. 見分け。中身が同じでも、外側が違えば別の紙
--
--    同じ中身   … 明細の品目と金額の並びが一致する
--    同じ発行日 … 発行日まで同じなら、重複の疑いが濃い
--    違う発行日 … 回ごとの紙。畳んではいけない
-- ---------------------------------------------------------------------
WITH body AS (
  SELECT d.id, d.document_no, d.status, d.issued_at::date AS issued_on, d.legacy_id,
         (SELECT string_agg((r.line ->> 'item_name') || '|'
                            || COALESCE(r.line ->> 'inspected_amount_ex_tax',
                                        r.line ->> 'amount_ex_tax', ''),
                            '／' ORDER BY r.ord)
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                        THEN d.rendered_values -> 'delivery_line_items'
                        WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                        THEN d.rendered_values -> 'items'
                        ELSE '[]'::jsonb END) WITH ORDINALITY AS r(line, ord)) AS shape
    FROM v3.documents d
   WHERE d.document_no = ANY(
           SELECT btrim(v) FROM unnest(string_to_array(:'docs', ',')) AS v
            WHERE btrim(v) <> '')
)
SELECT b.document_no                                     AS 文書番号,
       b.status                                          AS 状態,
       b.issued_on                                       AS 発行日,
       b.legacy_id                                       AS V2の元id,
       count(*) OVER (PARTITION BY b.shape)              AS 同じ中身の枚数,
       count(*) OVER (PARTITION BY b.shape, b.issued_on) AS うち発行日も同じ,
       CASE
         WHEN count(*) OVER (PARTITION BY b.shape) = 1
           THEN '中身が違う。別の紙'
         WHEN count(*) OVER (PARTITION BY b.shape, b.issued_on) > 1
           THEN '中身も発行日も同じ。重複の疑い'
         ELSE '中身は同じだが発行日が違う。回ごとの紙とみる'
       END                                               AS 見立て
  FROM body b
 ORDER BY b.issued_on NULLS LAST, b.document_no;
