-- =====================================================================
-- 複数の文書を並べて見比べる（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   「同じ紙が何枚もある」のか「回ごとの紙が並んでいる」のかを見分ける。
--   定期課金の月ごとの検収書は、金額も品目も毎月同じ。納品日が空欄だと
--   中身が完全に一致して見えるので、重複判定だけで畳むと本物を消す。
--
--   もっと危ないのは、同じ業務を複数の相手に出した紙。明細（品目・金額・回）
--   が全部同じで、違うのは相手先・発注番号・振込先だけ。明細だけを見て
--   重複と判じると、本物を消す（実際に3枚消した）。
--
--   そこで3節は、明細を除いた本文まるごとの指紋を取って見分ける。
--   4節は、文書ごとに値が違う差し込みの名前を並べる（何が違うのかが分かる）。
--   口座・連絡先にあたる名前の値は出さない。
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
                        ELSE '[]'::jsonb END) WITH ORDINALITY AS r(line, ord)) AS shape,
         -- 明細を抜いた本文まるごと。相手先・発注番号・振込先はここに入る。
         CASE WHEN jsonb_typeof(d.rendered_values) = 'object'
              THEN md5(((d.rendered_values - 'items') - 'delivery_line_items')::text)
              ELSE md5(d.rendered_values::text) END AS head
    FROM v3.documents d
   WHERE d.document_no = ANY(
           SELECT btrim(v) FROM unnest(string_to_array(:'docs', ',')) AS v
            WHERE btrim(v) <> '')
)
SELECT b.document_no                                     AS 文書番号,
       b.status                                          AS 状態,
       b.issued_on                                       AS 発行日,
       b.legacy_id                                       AS V2の元id,
       count(*) OVER (PARTITION BY b.shape)              AS 明細が同じ枚数,
       count(*) OVER (PARTITION BY b.head)               AS 本文も同じ枚数,
       CASE
         -- 本文まで同じなら、ほんとうに同じ紙。
         WHEN count(*) OVER (PARTITION BY b.head) > 1
           THEN '本文まで同じ。重複とみてよい'
         WHEN count(*) OVER (PARTITION BY b.shape) > 1
           THEN '明細は同じだが本文が違う。別の紙（4節で何が違うか見る）'
         ELSE '明細も本文も違う。別の紙'
       END                                               AS 見立て
  FROM body b
 ORDER BY b.issued_on NULLS LAST, b.document_no;

-- ---------------------------------------------------------------------
-- 4. 文書ごとに値が違う差し込み。何が違うのかを名前で出す
--
--    口座・連絡先にあたる名前（bank・account・holder・口座・tel・email・
--    address・住所・電話）の値は出さない。違うことだけを出す。
-- ---------------------------------------------------------------------
WITH body AS (
  SELECT d.document_no, d.rendered_values AS v
    FROM v3.documents d
   WHERE d.document_no = ANY(
           SELECT btrim(v) FROM unnest(string_to_array(:'docs', ',')) AS v
            WHERE btrim(v) <> '')
),
flat AS (
  SELECT b.document_no, kv.key, kv.value
    FROM body b
   CROSS JOIN LATERAL jsonb_each(
           CASE WHEN jsonb_typeof(b.v) = 'object' THEN b.v ELSE '{}'::jsonb END)
         AS kv(key, value)
   WHERE jsonb_typeof(kv.value) IN ('string', 'number', 'boolean')
),
varying AS (
  SELECT key FROM flat GROUP BY key HAVING count(DISTINCT value::text) > 1
)
SELECT f.key                                             AS 差し込み,
       f.document_no                                     AS 文書番号,
       CASE WHEN f.key ~* '(bank|account|holder|tel|phone|email|address|口座|名義|電話|住所)'
            THEN '（伏せる）'
            ELSE left(trim(both '"' from f.value::text), 60) END  AS 値
  FROM flat f
  JOIN varying x ON x.key = f.key
 ORDER BY f.key, f.document_no;
