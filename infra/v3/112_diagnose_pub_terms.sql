-- =====================================================================
-- 出版等利用許諾条件書（pub_license_terms）が何を差しているかを見る
-- （ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   V2 から移した本文。条件登録の値がこの本文の名前に届いているかを確かめる
--   ために、本文が差す名前と、項目の宣言（variables）を出す。
--   ついでに出版の一式（pub_*）4本ぶん。
-- =====================================================================

\pset pager off
\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------
-- 1. 本文が差す名前（ひな形ごと）
-- ---------------------------------------------------------------------
SELECT E'\n========== ' || t.template_key || '　' || t.label || E' ==========\n' ||
       string_agg(DISTINCT m[1], E'\n' ORDER BY m[1])
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー.]+)', 'g') AS m
 WHERE t.template_key LIKE 'pub\_%'
   AND m[1] NOT IN ('each', 'if', 'unless', 'with', 'else', 'this', 'log', 'lookup', 'eq', 'or', 'and', 'not')
 GROUP BY t.template_key, t.label
 ORDER BY t.template_key;

-- ---------------------------------------------------------------------
-- 2. 項目の宣言（名前・見出し・型・区分・供給元）
-- ---------------------------------------------------------------------
SELECT E'\n========== 宣言 ' || t.template_key || E' ==========\n' ||
       COALESCE(string_agg(
         x.ord::text || E'\t' || COALESCE(x.f->>'name','') || E'\t' || COALESCE(x.f->>'label','')
           || E'\t' || COALESCE(x.f->>'type','text') || E'\t' || COALESCE(x.f->>'group','')
           || E'\t' || COALESCE(x.f->>'dbField',''),
         E'\n' ORDER BY x.ord), '（宣言なし）')
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(v.variables, '[]'::jsonb)) WITH ORDINALITY AS x(f, ord) ON true
 WHERE t.template_key LIKE 'pub\_%'
 GROUP BY t.template_key
 ORDER BY t.template_key;

-- ---------------------------------------------------------------------
-- 3. 出版条件書の本文の先頭 3000 字（表の作りを見る）
-- ---------------------------------------------------------------------
SELECT E'\n========== 本文の先頭（pub_license_terms） ==========\n' || substring(v.html_source from 1 for 3000)
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'pub_license_terms';
