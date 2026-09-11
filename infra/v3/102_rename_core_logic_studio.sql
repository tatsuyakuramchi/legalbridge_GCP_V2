-- =====================================================================
-- 102_rename_core_logic_studio.sql（Cloud SQL Studio 用）
--
--   素材の名前の「原作ゲームデザイン」を Original_Core_Logic に揃える。
--
--   コアロジック（許諾の対象そのもの）を名前で見分けられるようにする。
--   V3 は構成上の役割（コア／サブ）を素材の種別 part_type から決めているが、
--   種別が入っていない素材（other）は名前で見るしかない。実際、作品「ito」の
--   「原作ゲームデザイン」は part_type='other' で入っている。
--
--   使い方（1つずつ、順に実行する）
--     【1】 報告。何も変えない
--     【2】 名前の中の「原作ゲームデザイン」を置き換える。(false) を (true) に
--     【3】 作品名と同じ名前のコアロジックに、規則どおりの名前を付ける。同上
--     【4】 確認
--
--   Studio は RAISE NOTICE を表示しないので、動かした行をそのまま返す。
--   何度流しても同じ結果になる（置き換え済みの行は対象から外れる）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
-- ---------------------------------------------------------------------
SELECT '2. 名前の置き換え' AS 区分,
       w.work_code || ' ' || w.title AS 作品,
       p.id::text || ' ' || p.name AS いまの名前,
       replace(p.name, '原作ゲームデザイン', 'Original_Core_Logic') AS 新しい名前,
       p.part_type AS 素材類型,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_part_id = p.id)::text AS 条件数
  FROM v3.work_parts p JOIN v3.works w ON w.id = p.work_id
 WHERE position('原作ゲームデザイン' in p.name) > 0
UNION ALL
-- 作品名がそのまま素材名になっているコアロジック。規則に沿わないので、
-- 一覧で「どれがコアロジックか」を名前から読めない。
SELECT '3. 規則どおりの名前を付ける',
       w.work_code || ' ' || w.title,
       p.id::text || ' ' || p.name,
       w.title || '_Original_Core_Logic',
       p.part_type,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_part_id = p.id)::text
  FROM v3.work_parts p JOIN v3.works w ON w.id = p.work_id
 WHERE p.part_type = 'game_design'
   AND lower(translate(p.name, ' 　_-', '')) = lower(translate(w.title, ' 　_-', ''))
 ORDER BY 1, 2, 3;


-- ---------------------------------------------------------------------
-- 【2】名前の中の「原作ゲームデザイン」を Original_Core_Logic に置き換える。
--      ★ (false) を (true) に書き換えてから実行。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
renamed AS (
  UPDATE v3.work_parts p
     SET name = replace(p.name, '原作ゲームデザイン', 'Original_Core_Logic')
    FROM go
   WHERE go.ok AND position('原作ゲームデザイン' in p.name) > 0
  RETURNING p.id, p.name, p.work_id
)
SELECT r.id::text AS パートid, w.work_code || ' ' || w.title AS 作品, r.name AS 新しい名前
  FROM renamed r JOIN v3.works w ON w.id = r.work_id
UNION ALL
SELECT '—', '', '0 件。(false) を (true) に書き換えて実行してください'
 WHERE NOT EXISTS (SELECT 1 FROM renamed);


-- ---------------------------------------------------------------------
-- 【3】作品名と同じ名前のコアロジックに、規則どおりの名前を付ける。
--
--      「ito クラシック」（作品名そのまま）→「ito クラシック_Original_Core_Logic」
--      名前が変わるだけで、所属も条件も動かない。
--      ★ (false) を (true) に書き換えてから実行。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
renamed AS (
  UPDATE v3.work_parts p
     SET name = w.title || '_Original_Core_Logic'
    FROM v3.works w, go
   WHERE w.id = p.work_id AND go.ok
     AND p.part_type = 'game_design'
     AND lower(translate(p.name, ' 　_-', '')) = lower(translate(w.title, ' 　_-', ''))
  RETURNING p.id, p.name, p.work_id
)
SELECT r.id::text AS パートid, w.work_code || ' ' || w.title AS 作品, r.name AS 新しい名前
  FROM renamed r JOIN v3.works w ON w.id = r.work_id
UNION ALL
SELECT '—', '', '0 件。(false) を (true) に書き換えて実行してください'
 WHERE NOT EXISTS (SELECT 1 FROM renamed);


-- ---------------------------------------------------------------------
-- 【4】確認。「原作ゲームデザイン」が残っていないこと。
-- ---------------------------------------------------------------------
SELECT (SELECT count(*) FROM v3.work_parts WHERE position('原作ゲームデザイン' in name) > 0)
         AS 残っている旧名,
       (SELECT count(*) FROM v3.work_parts WHERE position('Original_Core_Logic' in name) > 0)
         AS 新しい名前の素材,
       (SELECT count(*) FROM v3.work_parts p JOIN v3.works w ON w.id = p.work_id
         WHERE p.part_type = 'game_design'
           AND lower(translate(p.name, ' 　_-', '')) = lower(translate(w.title, ' 　_-', '')))
         AS 作品名のままのコアロジック;
