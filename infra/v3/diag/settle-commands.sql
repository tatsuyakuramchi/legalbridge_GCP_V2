-- =====================================================================
-- 決済文書（検収書・計算書）を月ごとに起こすコマンドを組み立てる
--
--   何度流しても読むだけ。出てくるのは「流すためのコマンド」で、
--   流すかどうかは人が決める。
--
--   定期課金の条件は、実績が回ごとに溜まる。過ぎた月のぶんを遡って
--   検収書にするとき、画面では 1枚ごとに 文書を作る → 条件を選ぶ →
--   実績を選ぶ → 決定 を繰り返す。6か月ぶんで24手。
--
--   ここは、まだ決済文書に結ばれていない実績を月ごとにまとめ、
--   1か月＝1枚として「下書きを作る」「決定する」の2行を出す。
--   決定日は、その月の検収日（無ければ納品日）のいちばん遅い日を入れる。
--   別の日にしたければ、貼る前に issuedOn を書き換える。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/settle-commands.sql \
--       conds=CL-2026-00661,CL-2026-00662,CL-2026-00663 matter=MTR-2026-00257
--
--     matter= は省ける（省くと案件に紐づかない文書になる）。
--     template= で計算書（royalty_statement）にもできる。既定は検収書。
--
--   ★ 先に予備系を書ける状態にしておくこと（READ_ONLY=false）
-- =====================================================================

\pset pager off

\if :{?conds}
\else
\set conds ''
\endif
\if :{?matter}
\else
\set matter ''
\endif
\if :{?template}
\else
\set template 'inspection_certificate'
\endif
\if :{?api}
\else
\set api 'http://localhost:8080/api/v3'
\endif

-- ---------------------------------------------------------------------
-- 1. 相手。条件と案件が引けているか
-- ---------------------------------------------------------------------
SELECT c.condition_no                                    AS 条件番号,
       c.id                                              AS 条件id,
       c.name                                            AS 条件名,
       c.status                                          AS 版,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active'
           AND e.document_id IS NULL)                    AS 浮いている実績
  FROM v3.conditions c
 WHERE c.condition_no = ANY(
         SELECT btrim(v) FROM unnest(string_to_array(:'conds', ',')) AS v
          WHERE btrim(v) <> '')
 ORDER BY c.condition_no;

SELECT m.id                                              AS 案件id,
       m.matter_no                                       AS 案件番号,
       m.title                                           AS 案件名,
       m.status                                          AS 状態
  FROM v3.matters m
 WHERE :'matter' <> '' AND m.matter_no = :'matter';

-- ---------------------------------------------------------------------
-- 2. 月ごとのまとめ。1行が1枚になる
-- ---------------------------------------------------------------------
SELECT to_char(e.occurred_on, 'YYYY-MM')                 AS 月,
       count(*)                                          AS 明細,
       sum(e.amount)                                     AS 金額,
       max(COALESCE(e.inspected_on, e.occurred_on))      AS 決定日,
       -- 決定日に先の日付は置けない（issue-service が弾く）。
       -- 検収日が未来のまま入っている実績があると、ここで気づける。
       CASE WHEN max(COALESCE(e.inspected_on, e.occurred_on)) > CURRENT_DATE
            THEN '決定日が未来。貼る前に issuedOn を書き換える'
            ELSE '' END                                  AS 注意,
       string_agg(DISTINCT c.condition_no, '／')         AS 条件
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
 WHERE c.condition_no = ANY(
         SELECT btrim(v) FROM unnest(string_to_array(:'conds', ',')) AS v
          WHERE btrim(v) <> '')
   AND e.status = 'active'
   AND e.document_id IS NULL
 GROUP BY 1
 ORDER BY 1;

-- ここから下は貼り付ける用。枠線と見出しを外す。
\pset format unaligned
\pset tuples_only on

\echo ''
\echo '--- 3. 月ごとに1枚。2行で1組。上から順に流す -------------------------'
\echo '---    1行目で下書きを作り、2行目でその下書きを決定する'
\echo '---    （$d は1組ごとに入れ替わるので、まとめて貼っても順に処理される）'
WITH per_month AS (
  SELECT to_char(e.occurred_on, 'YYYY-MM')                       AS ym,
         max(COALESCE(e.inspected_on, e.occurred_on))            AS issued_on,
         array_to_string(array_agg(DISTINCT c.id), ',')          AS condition_ids,
         string_agg(e.id::text, ',' ORDER BY e.id)               AS event_ids
    FROM v3.condition_events e
    JOIN v3.conditions c ON c.id = e.condition_id
   WHERE c.condition_no = ANY(
           SELECT btrim(v) FROM unnest(string_to_array(:'conds', ',')) AS v
            WHERE btrim(v) <> '')
     AND e.status = 'active'
     AND e.document_id IS NULL
   GROUP BY 1
),
target_matter AS (
  SELECT m.id FROM v3.matters m WHERE :'matter' <> '' AND m.matter_no = :'matter'
)
SELECT format(
         '# %s' || E'\n'
         || '$d = Invoke-RestMethod -Method Post -Uri "%s/documents"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body (''%s'')' || E'\n'
         || 'Invoke-RestMethod -Method Post -Uri "%s/documents/$($d.id)/issue"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body (''%s'')',
         p.ym,
         :'api',
         '{"templateKey":' || to_jsonb(:'template'::text)::text
           || ',"conditionIds":[' || p.condition_ids || ']'
           || COALESCE((SELECT ',"matterId":' || id FROM target_matter), '')
           || ',"manualInputs":{}}',
         :'api',
         '{"eventIds":[' || p.event_ids || '],"issuedOn":"' || p.issued_on || '"}')
  FROM per_month p
 ORDER BY p.ym;

\echo ''
\echo '--- 流したあと -------------------------------------------------------'
\echo '  もう一度この照会を流すと、1節の「浮いている実績」が減り、'
\echo '  2節からその月が消える。全部消えれば終わり'
\echo '  決定すると実績は自動で文書に結ばれる（link-commands は要らない）'
\echo ''
