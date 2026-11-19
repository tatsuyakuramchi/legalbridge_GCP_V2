-- =====================================================================
-- 作品の権利包絡（作者から取った範囲）の確認（読むだけ。何も書き換えない）
--
--   取得条件（IN）の地域・言語に「全世界」「全言語」「日本を除く全世界」の行があるとき、
--   作品の上限（v_work_scope_envelope）の出し方が変わった。
--     これまで：行の名前がすべての取得条件にそろっているものだけを上限に残す。
--               → 「全世界」の条件と「日本」の条件がある作品は、そろう名前が無く、上限なし（無制限）に化けていた。
--     いま    ：「全世界」「全言語」の取得条件は、その次元を制約しない（行が無いのと同じ）。
--               「日本を除く全世界」は、日本以外のどの国も含む。
--
--   ① 出し方が変わる作品：「全世界／全言語」の取得条件と、国・言語を挙げた取得条件の両方がある作品。
--      上限なしだったものが、挙げた国・言語に絞られる（範囲の外の許諾（OUT）が「範囲外」と出るようになる）。
--   ② 「日本を除く全世界」の取得条件がある作品と、いまの上限。
--
--   ★ 使い方（予備系。infra\local で。ops upgrade の前でも後でも同じ答え）
--       docker compose run --rm ops sql /v3/diag/scope-envelope-check.sql
-- =====================================================================

\pset pager off
SET search_path = v3, public;

CREATE TEMP TABLE env_rows ON COMMIT PRESERVE ROWS AS
SELECT c.id, c.condition_no, c.work_id, s.scope_type, s.label, s.code,
       (s.scope_type = 'region' AND (upper(btrim(COALESCE(s.code, ''))) = 'WORLD' OR s.label = '全世界'))
         OR (s.scope_type = 'language' AND (upper(btrim(COALESCE(s.code, ''))) = 'ALL' OR s.label = '全言語')) AS is_all,
       s.scope_type = 'region'
         AND (upper(btrim(COALESCE(s.code, ''))) = 'WORLD_EX_JP'
              OR (btrim(COALESCE(s.code, '')) = '' AND s.label IN ('日本を除く全世界', '全世界（日本を除く）', '全世界(日本を除く)', '日本以外の全世界'))) AS is_ex_jp
  FROM conditions c
  JOIN condition_scopes s ON s.condition_id = c.id AND s.scope_type IN ('region', 'language')
 WHERE c.direction = 'in' AND c.status = 'active' AND c.work_id IS NOT NULL;

CREATE TEMP TABLE env_conds ON COMMIT PRESERVE ROWS AS
SELECT id, condition_no, work_id, scope_type, bool_or(is_all) AS is_all, bool_or(is_ex_jp) AS is_ex_jp,
       string_agg(label, '・' ORDER BY label) AS labels
  FROM env_rows GROUP BY id, condition_no, work_id, scope_type;

\echo
\echo '① 出し方が変わる作品（「全世界／全言語」の取得条件と、国・言語を挙げた取得条件の両方がある）'
SELECT w.work_code AS 作品コード, left(w.title, 30) AS 作品,
       CASE e.scope_type WHEN 'region' THEN '地域' ELSE '言語' END AS 次元,
       string_agg(COALESCE(e.condition_no, '#' || e.id) || '：' || left(e.labels, 40), ' ／ ' ORDER BY e.is_all DESC, e.id) AS 取得条件と範囲,
       COALESCE((SELECT string_agg(v.label, '・' ORDER BY v.label) FROM v_work_scope_envelope v
                  WHERE v.work_id = e.work_id AND v.scope_type = e.scope_type), '（上限なし）') AS いまの上限
  FROM env_conds e JOIN works w ON w.id = e.work_id
 GROUP BY w.work_code, w.title, e.work_id, e.scope_type
HAVING bool_or(e.is_all) AND bool_or(NOT e.is_all)
 ORDER BY w.work_code NULLS LAST, e.scope_type;

\echo
\echo '② 「日本を除く全世界」の取得条件がある作品と、いまの上限（地域）'
SELECT w.work_code AS 作品コード, left(w.title, 30) AS 作品,
       string_agg(COALESCE(e.condition_no, '#' || e.id) || '：' || left(e.labels, 40), ' ／ ' ORDER BY e.id) AS 取得条件と範囲,
       COALESCE((SELECT string_agg(v.label, '・' ORDER BY v.label) FROM v_work_scope_envelope v
                  WHERE v.work_id = e.work_id AND v.scope_type = 'region'), '（上限なし）') AS いまの上限
  FROM env_conds e JOIN works w ON w.id = e.work_id
 WHERE e.scope_type = 'region'
 GROUP BY w.work_code, w.title, e.work_id
HAVING bool_or(e.is_ex_jp)
 ORDER BY w.work_code NULLS LAST;
