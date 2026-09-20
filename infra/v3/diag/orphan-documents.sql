-- 条件も実績も付いていない決定済み文書の棚卸し。読み取りだけ。書き換え不要。
--
-- 使い方（予備系）
--   cd infra\local
--   docker compose run --rm ops sql /v3/diag/orphan-documents.sql
--
-- 対象は payment-floating-all.sql のセクション6 と同じ。決定済み（番号が
-- 出ている）検収書・計算書のうち、条件も実績も繋がっていないもの。
--
-- 見たいのは「捨ててよいか」ではない。番号が出ている文書は出した記録
-- なので捨てない。見たいのは次の3つの仕分け。
--
--   A 中身を繋ぎ直すべきもの … 条件を外した記録がある。元は繋がっていた
--   B 中身が別の場所にあるもの … 計算書の明細（statement_lines）は残っている
--   D 紙に中身はあるが繋がりが無い … rendered_values に明細が刷られている。
--       V2 の condition_lines が無かった文書は 040 で document_conditions が
--       作られない。紙は中身入り、V3 の繋がりだけ空という形になる。
--   C 空の紙            … 明細も無い。番号だけ。無効化して畳むのが素直
--
-- 相手先名・担当者名・連絡先・口座は一切引かない。相手先は ID だけ出す。
-- rendered_values も中身は出さず、金額と明細の行数だけを数える。

SET search_path = v3;

\pset pager off
\pset border 0

\echo ''
\echo '=== 1. 全体の輪郭（どこから来た文書か） ================================'
\echo '   legacy_id があれば V2 から移ってきた紙。無ければ V3 で作ったもの。'
\echo '   V3 で作ったものがここに居るなら、作りかけか、人が条件を外している。'
\echo ''

SELECT t.template_key AS "ひな形",
       CASE WHEN d.legacy_id IS NOT NULL THEN 'V2から移行' ELSE 'V3で作った' END AS "出どころ",
       count(*) AS "件数",
       min(d.issued_at)::date AS "いちばん古い",
       max(d.issued_at)::date AS "いちばん新しい"
  FROM documents d
  JOIN document_template_versions tv ON tv.id = d.template_version_id
  JOIN document_templates t ON t.id = tv.template_id
 WHERE d.status = 'issued'
   AND t.template_key IN ('inspection_certificate', 'royalty_statement')
   AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM condition_events x
                    WHERE x.document_id = d.id AND x.status = 'active')
 GROUP BY t.template_key, (d.legacy_id IS NOT NULL)
 ORDER BY t.template_key, 2;

\echo ''
\echo '=== 2. 1件ずつの台帳 ==================================================='
\echo '   金額は紙の合計欄。V2 の紙は合計欄を持たないので、明細行の'
\echo '   inspected_amount_ex_tax を足した額を出す。'
\echo '   明細行は納品明細・発注明細の行数。0 なら紙の中身も空。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
)
SELECT d.document_no AS "文書", t.template_key AS "ひな形",
       d.issued_at::date AS "決定日",
       CASE WHEN d.legacy_id IS NOT NULL THEN 'V2' ELSE 'V3' END AS "出どころ",
       COALESCE(m.matter_no, '（案件なし）') AS "案件",
       COALESCE(d.matter_id::text, '—') AS "案件ID",
       COALESCE(m.counterparty_id::text, '—') AS "相手先ID",
       -- V2 から移ってきた紙は合計欄を持たない。金額は明細の行に
       -- inspected_amount_ex_tax として入っているので、無ければ足して出す。
       COALESCE(
         NULLIF(NULLIF(regexp_replace(COALESCE(d.rendered_values ->> 'grandTotalExTax',''), '[^0-9]','','g'),'')::bigint, 0),
         NULLIF(NULLIF(regexp_replace(COALESCE(d.rendered_values ->> 'deliveredAmountExTax',''),'[^0-9]','','g'),'')::bigint, 0),
         NULLIF(NULLIF(regexp_replace(COALESCE(d.rendered_values ->> 'AMOUNT_EX_TAX',''),'[^0-9]','','g'),'')::bigint, 0),
         NULLIF((SELECT COALESCE(sum(COALESCE(NULLIF(regexp_replace(
                          COALESCE(li ->> 'inspected_amount_ex_tax', ''), '[^0-9]', '', 'g'), '')::bigint, 0)), 0)
                    FROM jsonb_array_elements(COALESCE(
                           CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                                THEN d.rendered_values -> 'delivery_line_items' END,
                           CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                                THEN d.rendered_values -> 'items' END,
                           '[]'::jsonb)) li), 0),
         NULLIF((SELECT COALESCE(sum(COALESCE(NULLIF(regexp_replace(
                          COALESCE(li ->> 'ordered_amount_ex_tax', ''), '[^0-9]', '', 'g'), '')::bigint, 0)), 0)
                    FROM jsonb_array_elements(COALESCE(
                           CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                                THEN d.rendered_values -> 'delivery_line_items' END,
                           CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                                THEN d.rendered_values -> 'items' END,
                           '[]'::jsonb)) li), 0)
       ) AS "刷られた金額",
       COALESCE(
         CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
              THEN jsonb_array_length(d.rendered_values -> 'delivery_line_items') END,
         CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
              THEN jsonb_array_length(d.rendered_values -> 'items') END,
         0) AS "明細行",
       COALESCE(d.issued_by, '—') AS "決定した人"
  FROM orphan o
  JOIN documents d ON d.id = o.id
  JOIN document_template_versions tv ON tv.id = d.template_version_id
  JOIN document_templates t ON t.id = tv.template_id
  LEFT JOIN matters m ON m.id = d.matter_id
 ORDER BY t.template_key, d.issued_at NULLS LAST, d.document_no;

\echo ''
\echo '=== 3. 外に出た形跡（送信・CloudSign・Drive） =========================='
\echo '   1件でも出ていれば、相手が持っている紙。中身が空でも畳むだけにする。'
\echo '   宛先・件名・本文は引かない（個人の連絡先が混ざるため）。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
)
SELECT d.document_no AS "文書", mc.channel AS "経路",
       CASE mc.direction WHEN 'out' THEN '送った' WHEN 'in' THEN '受け取った'
                         ELSE '記録' END AS "向き",
       count(*) AS "件数",
       max(mc.occurred_at)::date AS "最後に動いた日"
  FROM orphan o
  JOIN documents d ON d.id = o.id
  JOIN matter_communications mc ON mc.document_id = d.id
 GROUP BY d.document_no, mc.channel, mc.direction
 ORDER BY d.document_no, mc.channel;

\echo ''
\echo '=== 4. 計算書の中身（条件が外れていても明細は残る） ===================='
\echo '   statements / statement_lines は document_conditions とは別の入れ物。'
\echo '   ここに行があるなら、その計算書は空ではない。繋ぎ直しの対象。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
)
SELECT d.document_no AS "文書", s.period AS "対象期間",
       s.gross_amount AS "総額", s.net_amount AS "純額",
       count(sl.id) AS "明細行",
       count(sl.event_id) AS "実績を指す行",
       string_agg(DISTINCT c.condition_no, '・') AS "明細が指す条件"
  FROM orphan o
  JOIN documents d ON d.id = o.id
  JOIN statements s ON s.document_id = d.id
  LEFT JOIN statement_lines sl ON sl.statement_id = s.id
  LEFT JOIN conditions c ON c.id = sl.condition_id
 GROUP BY d.document_no, s.period, s.gross_amount, s.net_amount
 ORDER BY d.document_no;

\echo ''
\echo '=== 5. 条件・実績が外された記録があるか ================================'
\echo '   記録があれば「元は繋がっていた」＝繋ぎ直しの対象。'
\echo '   決定（document.issue）しか無ければ、最初から中身が無い紙。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
)
SELECT d.document_no AS "文書", ev.occurred_at AS "いつ", ev.actor AS "だれが",
       ev.action AS "何を",
       COALESCE(ev.detail ->> 'reason', '') AS "理由",
       COALESCE(ev.detail ->> 'eventIds', ev.detail ->> 'eventId', '') AS "実績"
  FROM orphan o
  JOIN documents d ON d.id = o.id
  JOIN audit_events ev ON
       (ev.target_type = 'document' AND ev.target_id = d.id)
    OR (ev.detail ? 'documentId' AND (ev.detail ->> 'documentId')::bigint = d.id)
 ORDER BY d.document_no, ev.id;

\echo ''
\echo '=== 6. 版のつながり（前任・後継） ======================================'
\echo '   訂正版の鎖の途中なら、中身は新しい版へ移っているのが正常。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
)
SELECT d.document_no AS "文書",
       COALESCE(prev.document_no, '—') AS "前の版",
       COALESCE(string_agg(next.document_no || '（' || next.status || '）', '・'), '—') AS "後の版"
  FROM orphan o
  JOIN documents d ON d.id = o.id
  LEFT JOIN documents prev ON prev.id = d.supersedes_id
  LEFT JOIN documents next ON next.supersedes_id = d.id
 GROUP BY d.document_no, prev.document_no
 HAVING COALESCE(prev.document_no, '') <> '' OR count(next.id) > 0
 ORDER BY d.document_no;

\echo ''
\echo '=== 7. 仕分け（機械的な見立て） ========================================'
\echo '   A 繋ぎ直す … 外された記録がある、または計算書の明細が残っている'
\echo '   D 紙に中身あり … 明細は刷られているが V3 の繋がりだけ無い（移行）'
\echo '   B 畳むだけ … 外に出た形跡があり、中身は無い（番号は記録として残す）'
\echo '   C 空の紙   … 明細も無く番号だけ。無効化して畳むのが素直'
\echo '   見立てであって決定ではない。2〜6・9・10 と突き合わせてから動かす。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
), facts AS (
  SELECT d.id, d.document_no, t.template_key, d.legacy_id,
         COALESCE(
           CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                THEN jsonb_array_length(d.rendered_values -> 'delivery_line_items') END,
           CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                THEN jsonb_array_length(d.rendered_values -> 'items') END,
           0) AS printed_lines,
         EXISTS (SELECT 1 FROM statement_lines sl
                   JOIN statements s ON s.id = sl.statement_id
                  WHERE s.document_id = d.id) AS has_lines,
         EXISTS (SELECT 1 FROM matter_communications mc
                  WHERE mc.document_id = d.id) AS went_out,
         EXISTS (SELECT 1 FROM audit_events ev
                  WHERE ev.action IN ('condition.unlink_document', 'document.void',
                                      'document.supersede')
                    AND ev.detail ? 'documentId'
                    AND (ev.detail ->> 'documentId')::bigint = d.id) AS was_detached,
         EXISTS (SELECT 1 FROM documents n WHERE n.supersedes_id = d.id) AS has_next
    FROM orphan o
    JOIN documents d ON d.id = o.id
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
)
SELECT document_no AS "文書", template_key AS "ひな形", printed_lines AS "明細行",
       CASE
         WHEN has_lines     THEN 'A 繋ぎ直す（計算書の明細が残っている）'
         WHEN was_detached  THEN 'A 繋ぎ直す（外された記録がある）'
         WHEN has_next      THEN '— 後の版あり（中身は新しい版へ）'
         WHEN printed_lines > 0 THEN 'D 紙に中身あり・繋がりだけ無い'
         WHEN went_out      THEN 'B 畳むだけ（外に出ている・中身は無い）'
         WHEN legacy_id IS NOT NULL THEN 'C 空の紙（V2 から番号だけ）'
         ELSE 'C 空の紙（V3 で作ったが中身が無い）'
       END AS "見立て"
  FROM facts
 ORDER BY template_key, document_no;

\echo ''
\echo '=== 8. 見立ての件数 ===================================================='
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
), facts AS (
  SELECT d.id,
         COALESCE(
           CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                THEN jsonb_array_length(d.rendered_values -> 'delivery_line_items') END,
           CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                THEN jsonb_array_length(d.rendered_values -> 'items') END,
           0) AS printed_lines,
         EXISTS (SELECT 1 FROM statement_lines sl
                   JOIN statements s ON s.id = sl.statement_id
                  WHERE s.document_id = d.id) AS has_lines,
         EXISTS (SELECT 1 FROM matter_communications mc
                  WHERE mc.document_id = d.id) AS went_out,
         EXISTS (SELECT 1 FROM audit_events ev
                  WHERE ev.action IN ('condition.unlink_document', 'document.void',
                                      'document.supersede')
                    AND ev.detail ? 'documentId'
                    AND (ev.detail ->> 'documentId')::bigint = d.id) AS was_detached,
         EXISTS (SELECT 1 FROM documents n WHERE n.supersedes_id = d.id) AS has_next,
         d.legacy_id
    FROM orphan o
    JOIN documents d ON d.id = o.id
)
SELECT CASE
         WHEN has_lines     THEN 'A 繋ぎ直す（計算書の明細）'
         WHEN was_detached  THEN 'A 繋ぎ直す（外された記録）'
         WHEN has_next      THEN '— 後の版あり'
         WHEN printed_lines > 0 THEN 'D 紙に中身あり・繋がりだけ無い'
         WHEN went_out      THEN 'B 畳むだけ'
         WHEN legacy_id IS NOT NULL THEN 'C 空の紙（V2）'
         ELSE 'C 空の紙（V3）'
       END AS "見立て",
       count(*) AS "件数"
  FROM facts
 GROUP BY 1
 ORDER BY 1;

\echo ''
\echo '=== 9. 紙に刷られた明細の手がかり ======================================'
\echo '   rendered_values は V2 の form_data をそのまま持っている。値は出さず、'
\echo '   行数・金額の合計・項目名（キー）だけを見る。項目名から、その紙が'
\echo '   V2 の金額は明細の行に inspected_amount_ex_tax として入っている。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
), lines AS (
  SELECT d.id, d.document_no,
         COALESCE(
           CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                THEN d.rendered_values -> 'delivery_line_items' END,
           CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                THEN d.rendered_values -> 'items' END,
           '[]'::jsonb) AS arr
    FROM orphan o JOIN documents d ON d.id = o.id
)
SELECT document_no AS "文書",
       jsonb_array_length(arr) AS "明細行",
       (SELECT COALESCE(sum(COALESCE(NULLIF(regexp_replace(
                 COALESCE(li ->> 'inspected_amount_ex_tax', ''), '[^0-9]', '', 'g'), '')::bigint, 0)), 0)
          FROM jsonb_array_elements(arr) li) AS "検収額の合計",
       (SELECT COALESCE(sum(COALESCE(NULLIF(regexp_replace(
                 COALESCE(li ->> 'ordered_amount_ex_tax', ''), '[^0-9]', '', 'g'), '')::bigint, 0)), 0)
          FROM jsonb_array_elements(arr) li) AS "発注額の合計",
       (SELECT string_agg(DISTINCT k, '・' ORDER BY k)
          FROM jsonb_array_elements(arr) li, jsonb_object_keys(li) k) AS "明細の項目名"
  FROM lines
 WHERE jsonb_array_length(arr) > 0
 ORDER BY document_no;

\echo ''
\echo '=== 10. 繋ぎ直す先の候補（その案件にある条件と実績） ==================='
\echo '   紙に中身があるのに繋がりが無い文書は、同じ案件の条件に結び直せる'
\echo '   ことが多い。「文書未付与の実績」が立っている条件が第一候補。'
\echo '   条件名は出さない（案件番号と条件番号でアプリ側を開いて確かめる）。'
\echo ''

WITH orphan AS (
  SELECT d.id
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.status = 'issued'
     AND t.template_key IN ('inspection_certificate', 'royalty_statement')
     AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
     AND NOT EXISTS (SELECT 1 FROM condition_events x
                      WHERE x.document_id = d.id AND x.status = 'active')
)
SELECT d.document_no AS "文書",
       NULLIF((SELECT COALESCE(sum(COALESCE(NULLIF(regexp_replace(
                       COALESCE(li ->> 'inspected_amount_ex_tax', ''), '[^0-9]', '', 'g'), '')::bigint, 0)), 0)
                 FROM jsonb_array_elements(COALESCE(
                        CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                             THEN d.rendered_values -> 'delivery_line_items' END,
                        CASE WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                             THEN d.rendered_values -> 'items' END,
                        '[]'::jsonb)) li), 0) AS "紙の金額",
       m.matter_no AS "案件",
       c.condition_no AS "案件にある条件", c.status AS "条件の状態",
       c.flat_amount AS "条件の金額",
       (SELECT count(*) FROM condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active') AS "実績",
       (SELECT count(*) FROM condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active'
           AND e.document_id IS NULL) AS "文書未付与の実績"
  FROM orphan o
  JOIN documents d ON d.id = o.id
  JOIN matters m ON m.id = d.matter_id
  -- 条件は案件に属さない（参照されるだけ）。繋がりは matter_links にある。
  JOIN matter_links ml ON ml.matter_id = m.id AND ml.target_type = 'condition'
  JOIN conditions c ON c.id = ml.target_ref::bigint
 ORDER BY d.document_no, c.condition_no;
