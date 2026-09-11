-- =====================================================================
-- ひな形の「項目の宣言」を見る（Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
-- なぜ要るか:
--   V3 の入力フォームは document_template_versions.variables（V1・V2 の
--   field_schema）から作る。ところが V1・V2 は、いくつかの書類の項目一覧を
--   **コードの中** に持っていて、この列は空だった。移行は列だけを引き継いだ
--   ので、そういう書類は V3 で入力欄が1つも出ない。
--   個別利用許諾条件書（individual_license_terms_v3）が実際にそれだった。
--   同じ穴が他のひな形にも無いかを、ここで一度に見る。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ひな形ごとの項目の数
--
--    「項目の数」が 0 なら、その書類の入力フォームは空で出る。
--    「本文が差す名前」より極端に少ないときも、埋まらない欄が残る。
-- ---------------------------------------------------------------------
WITH ver AS (
  SELECT t.template_key, t.label, t.is_active, t.number_prefix,
         v.id AS version_id, v.html_source, v.variables
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
),
used AS (
  SELECT ver.template_key,
         count(DISTINCT m[1]) AS 本文が差す名前
    FROM ver,
         LATERAL regexp_matches(ver.html_source,
           '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー]+)', 'g') AS m
   GROUP BY ver.template_key
)
SELECT ver.template_key                                   AS ひな形,
       ver.label                                          AS 名前,
       ver.is_active                                      AS 有効,
       jsonb_array_length(COALESCE(ver.variables, '[]'::jsonb)) AS 項目の数,
       COALESCE(used.本文が差す名前, 0)                    AS 本文が差す名前,
       length(ver.html_source)                            AS 本文の長さ,
       CASE
         WHEN jsonb_array_length(COALESCE(ver.variables, '[]'::jsonb)) = 0
              AND COALESCE(used.本文が差す名前, 0) > 0
           THEN '★ 項目が空。フォームに入力欄が出ない'
         ELSE ''
       END                                                AS 判定
  FROM ver LEFT JOIN used ON used.template_key = ver.template_key
 ORDER BY 判定 DESC, ひな形;

-- ---------------------------------------------------------------------
-- 2. 個別利用許諾条件書だけを見る
--
--    項目の数 = 0 なら、こちらが用意したコードの一覧（24項目）で補われる。
--    0 でなければ、データベースの宣言のほうが勝つので、その中身に合わせる
--    必要がある。中身も出しておく。
-- ---------------------------------------------------------------------
SELECT t.template_key                                            AS ひな形,
       v.id                                                      AS 版,
       jsonb_array_length(COALESCE(v.variables, '[]'::jsonb))    AS 項目の数,
       COALESCE(
         (SELECT string_agg(x->>'name', '、' ORDER BY x->>'name')
            FROM jsonb_array_elements(v.variables) AS x),
         '（空）')                                               AS 項目の名前
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'individual_license_terms_v3';

-- ---------------------------------------------------------------------
-- 3. 条件書の本文が差している名前
--
--    こちらが供給する 30 個（conds・lcs・addonConds・scopeColCount …）で
--    足りているかの突き合わせ。ここに出て供給に無い名前があれば、その欄は
--    空のまま出る。
-- ---------------------------------------------------------------------
SELECT DISTINCT m[1] AS 本文が差す名前
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '\{\{[#/]?\s*([A-Za-z0-9_一-龠ぁ-んァ-ヶー]+)', 'g') AS m
 WHERE t.template_key = 'individual_license_terms_v3'
   -- Handlebars の構文語は差し込みではないので落とす。
   AND m[1] NOT IN ('each', 'if', 'unless', 'with', 'else', 'this', 'log', 'lookup')
 ORDER BY 本文が差す名前;

-- ---------------------------------------------------------------------
-- 4. ひとつのひな形の項目を、出し分けの条件つきで並べる
--
--    項目が宣言されているのに画面に出ないときは、ここで理由が分かる。
--      hidden = true         … 最初から出さない項目
--      showWhen あり          … 他の項目の値が条件に合うときだけ出る
--      type = array           … 明細。専用の編集欄で扱うので一覧には出ない
--    ひな形を変えるときは下の template_key を書き換える。
-- ---------------------------------------------------------------------
SELECT x.ord                                        AS 番号,
       x.f->>'name'                                 AS 項目,
       x.f->>'label'                                AS 名前,
       x.f->>'group'                                AS 区分,
       COALESCE(x.f->>'type', 'text')               AS 型,
       COALESCE(x.f->>'dbField', '')                AS 供給元,
       (x.f->>'required')::boolean                  AS 必須,
       COALESCE((x.f->>'hidden')::boolean, false)   AS 隠し,
       COALESCE((x.f->'showWhen')::text, '')        AS 出し分けの条件
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL jsonb_array_elements(v.variables) WITH ORDINALITY AS x(f, ord)
 WHERE t.template_key = 'royalty_statement'
 ORDER BY x.ord;

-- ---------------------------------------------------------------------
-- 5. 出し分けの条件がどの項目を見ているか（4 のまとめ）
--
--    「この項目が入るまで、他の項目が出ない」という鎖の起点が分かる。
--    起点になっている項目が V3 で誰も入れない値なら、画面は空のままになる。
-- ---------------------------------------------------------------------
SELECT COALESCE(w->>'field', '(条件なし)')          AS 見ている項目,
       count(*)                                     AS その条件で出る項目の数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL jsonb_array_elements(v.variables) AS f
  LEFT JOIN LATERAL (
    SELECT CASE jsonb_typeof(f->'showWhen')
             WHEN 'array'  THEN f->'showWhen'
             WHEN 'object' THEN jsonb_build_array(f->'showWhen')
             ELSE '[]'::jsonb
           END AS arr
  ) AS s ON true
  LEFT JOIN LATERAL jsonb_array_elements(s.arr) AS w ON true
 WHERE t.template_key = 'royalty_statement'
 GROUP BY 1
 ORDER BY 2 DESC;
