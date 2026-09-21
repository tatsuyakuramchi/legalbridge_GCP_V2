-- =====================================================================
-- 文書に実績と条件明細を結ぶコマンドを組み立てる（ops sql 用）
--
--   何度流しても読むだけ。出てくるのは「流すためのコマンド」で、
--   流すかどうかは人が決める。
--
--   棚卸しで見つかった紙を台帳に繋ぎ直すとき、画面では
--     1) 文書 → 対象の実績 → 結ぶものを選ぶ（実績の数だけチェック）
--     2) つながり → 条件明細 →「繋ぐ」（条件の数だけ）
--   の2手順を踏む。実績が21件あると現実的でない。ここは実績 id を渡すと、
--   条件ごとにまとめた API 呼び出しにして出す。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/link-commands.sql \
--       doc=ARC-INS-2026-0065 events=234,241,248
--
--     条件明細は実績から自動で決まる（その実績が付いている条件）。
--     実績を結ばずに条件だけ繋ぎたいときは conds= で条件番号を渡す。
--
--   ★ 先に予備系を書ける状態にしておくこと（READ_ONLY=false）
-- =====================================================================

\pset pager off

\if :{?doc}
\else
\set doc '文書番号'
\endif
\if :{?events}
\else
\set events ''
\endif
\if :{?conds}
\else
\set conds ''
\endif
\if :{?api}
\else
\set api 'http://localhost:8080/api/v3'
\endif

-- ---------------------------------------------------------------------
-- 1. 相手の文書。ここが空なら番号の綴りが違う
-- ---------------------------------------------------------------------
SELECT d.id                                              AS 文書id,
       d.document_no                                     AS 文書番号,
       COALESCE(t.template_key, '（版が無い）')          AS ひな形,
       d.status                                          AS 状態,
       (SELECT count(*) FROM v3.document_conditions dc
         WHERE dc.document_id = d.id)                    AS いまの条件,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.document_id = d.id AND e.status = 'active')  AS いまの実績
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE d.document_no = :'doc';

-- ---------------------------------------------------------------------
-- 2. 結ぶ実績。すでに別の文書に結ばれているものは「先に外す」と出る
-- ---------------------------------------------------------------------
SELECT c.condition_no                                    AS 条件番号,
       e.id                                              AS 実績id,
       e.occurred_on                                     AS 納品日,
       e.inspected_on                                    AS 検収日,
       e.amount                                          AS 金額,
       CASE
         WHEN e.status <> 'active' THEN '取り消し済み。結べない'
         WHEN e.document_id IS NULL THEN '結べる'
         WHEN x.document_no = :'doc' THEN 'すでにこの文書に結ばれている'
         ELSE '別の文書（' || COALESCE(x.document_no, '下書き') || '）に結ばれている。先に外す'
       END                                               AS 見込み
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
  LEFT JOIN v3.documents x ON x.id = e.document_id
 WHERE e.id = ANY(
         SELECT btrim(v)::bigint FROM unnest(string_to_array(:'events', ',')) AS v
          WHERE btrim(v) <> '')
 ORDER BY e.occurred_on, e.id;

-- ---------------------------------------------------------------------
-- 3. 繋ぐ条件明細。実績から出た条件と、conds= で足した条件
-- ---------------------------------------------------------------------
WITH want AS (
  SELECT DISTINCT c.id, c.condition_no, c.name, c.status
    FROM v3.condition_events e
    JOIN v3.conditions c ON c.id = e.condition_id
   WHERE e.id = ANY(
           SELECT btrim(v)::bigint FROM unnest(string_to_array(:'events', ',')) AS v
            WHERE btrim(v) <> '')
  UNION
  SELECT c.id, c.condition_no, c.name, c.status
    FROM v3.conditions c
   WHERE c.condition_no = ANY(
           SELECT btrim(v) FROM unnest(string_to_array(:'conds', ',')) AS v
            WHERE btrim(v) <> '')
)
SELECT w.condition_no                                    AS 条件番号,
       w.name                                            AS 条件名,
       w.status                                          AS 版,
       CASE WHEN EXISTS (SELECT 1 FROM v3.document_conditions dc
                           JOIN v3.documents d ON d.id = dc.document_id
                          WHERE dc.condition_id = w.id AND d.document_no = :'doc')
            THEN 'すでに繋がっている' ELSE '繋ぐ' END    AS 見込み
  FROM want w
 ORDER BY w.condition_no;

-- ここから下は貼り付ける用。枠線と見出しを外す。
\pset format unaligned
\pset tuples_only on

\echo ''
\echo '--- 4. 実績を結ぶ。条件ごとに1行 -------------------------------------'
SELECT format(
         'Invoke-RestMethod -Method Post -Uri "%s/conditions/%s/events/link-document"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body (''%s'')',
         :'api', e.condition_id,
         '{"documentId":' || d.id || ',"eventIds":['
           || string_agg(e.id::text, ',' ORDER BY e.id) || ']}')
  FROM v3.condition_events e
  JOIN v3.documents d ON d.document_no = :'doc'
 WHERE e.id = ANY(
         SELECT btrim(v)::bigint FROM unnest(string_to_array(:'events', ',')) AS v
          WHERE btrim(v) <> '')
   AND e.status = 'active'
   AND e.document_id IS DISTINCT FROM d.id
 GROUP BY e.condition_id, d.id
 ORDER BY e.condition_id;

\echo ''
\echo '--- 5. 条件明細を繋ぐ。条件1本につき1行 ------------------------------'
WITH want AS (
  SELECT DISTINCT c.id
    FROM v3.condition_events e
    JOIN v3.conditions c ON c.id = e.condition_id
   WHERE e.id = ANY(
           SELECT btrim(v)::bigint FROM unnest(string_to_array(:'events', ',')) AS v
            WHERE btrim(v) <> '')
  UNION
  SELECT c.id FROM v3.conditions c
   WHERE c.condition_no = ANY(
           SELECT btrim(v) FROM unnest(string_to_array(:'conds', ',')) AS v
            WHERE btrim(v) <> '')
)
SELECT format(
         'Invoke-RestMethod -Method Post -Uri "%s/links/document/%s/conditions"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body (''{"targetId":%s}'')',
         :'api', d.id, w.id)
  FROM want w
  JOIN v3.documents d ON d.document_no = :'doc'
 WHERE NOT EXISTS (SELECT 1 FROM v3.document_conditions dc
                    WHERE dc.document_id = d.id AND dc.condition_id = w.id)
 ORDER BY w.id;

\echo ''
\echo '--- 流したあと -------------------------------------------------------'
\echo '  もう一度この照会を流すと、1節の「いまの条件」「いまの実績」が増え、'
\echo '  2節・3節が「すでに結ばれている」に変わる'
\echo ''
