-- =====================================================================
-- 案件の紐づけが改訂前の条件（旧版）を指しているものを確かめる（読むだけ）
--
--   条件を改訂すると新しい id ができるが、以前のアプリは案件の紐づけを旧版に
--   残していた（dd495ec で改訂時に移すように直した）。それ以前に改訂した案件は
--   旧版に紐づいたままなので、案件の条件明細タブに改訂前の番号が並ぶ。
--   工程バーの件数は系列で数えるので数は合っている。
--
--   ここは対象を見るだけ。移すのは 115_matter_links_current_apply.sql。
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/114_matter_links_current_check.sql
-- =====================================================================

-- 旧版 → 今の版（superseded_by_id を末端まで辿る）
WITH RECURSIVE chain AS (
  SELECT c.id AS old_id, c.id AS cur_id, c.superseded_by_id, 0 AS depth
    FROM v3.conditions c
   WHERE c.status = 'superseded' AND c.superseded_by_id IS NOT NULL
  UNION ALL
  SELECT ch.old_id, n.id, n.superseded_by_id, ch.depth + 1
    FROM chain ch JOIN v3.conditions n ON n.id = ch.superseded_by_id
   WHERE ch.depth < 20
),
latest AS (
  SELECT DISTINCT ON (old_id) old_id, cur_id
    FROM chain WHERE superseded_by_id IS NULL
   ORDER BY old_id, depth DESC
)
SELECT ml.matter_id,
       m.matter_no                         AS 案件番号,
       m.title                             AS 案件,
       o.condition_no                      AS 旧版,
       o.status                            AS 旧版の状態,
       n.condition_no                      AS 今の版,
       n.status                            AS 今の版の状態,
       EXISTS (SELECT 1 FROM v3.matter_links x
                WHERE x.matter_id = ml.matter_id AND x.target_type = 'condition'
                  AND x.target_ref = l.cur_id::text)  AS 今の版も紐づいている
  FROM v3.matter_links ml
  JOIN latest l          ON l.old_id::text = ml.target_ref
  JOIN v3.conditions o   ON o.id = l.old_id
  JOIN v3.conditions n   ON n.id = l.cur_id
  JOIN v3.matters m      ON m.id = ml.matter_id
 WHERE ml.target_type = 'condition'
 ORDER BY ml.matter_id, o.condition_no;

-- 件数だけ
WITH RECURSIVE chain AS (
  SELECT c.id AS old_id, c.id AS cur_id, c.superseded_by_id, 0 AS depth
    FROM v3.conditions c
   WHERE c.status = 'superseded' AND c.superseded_by_id IS NOT NULL
  UNION ALL
  SELECT ch.old_id, n.id, n.superseded_by_id, ch.depth + 1
    FROM chain ch JOIN v3.conditions n ON n.id = ch.superseded_by_id
   WHERE ch.depth < 20
),
latest AS (
  SELECT DISTINCT ON (old_id) old_id, cur_id FROM chain WHERE superseded_by_id IS NULL
   ORDER BY old_id, depth DESC
)
SELECT count(*) AS 旧版に紐づいている件数,
       count(DISTINCT ml.matter_id) AS 案件数
  FROM v3.matter_links ml JOIN latest l ON l.old_id::text = ml.target_ref
 WHERE ml.target_type = 'condition';
