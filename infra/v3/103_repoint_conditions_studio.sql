-- =====================================================================
-- 103_repoint_conditions_studio.sql（Cloud SQL Studio 用）
--
--   ito シリーズの取得条件を、自分のコアロジックへ付け替える。
--
--   ito・ito クラシック・ito レインボー・New ito は、1つの原作に作品が
--   増えているのではなく、各々が独立した原作であり作品（契約も別々）。
--   ところが移行後のデータは、クラシック・レインボー・New ito の取得条件が
--   ito の素材を指している。自分のコアロジックの取得として登録し直す。
--
--   これで作品の権利包絡（パートの取得条件の積）が作品ごとに立つ。
--   いまは ito の上限に他作品の21本が混ざっている。
--
--   含めないもの：
--     クイックショット! → レースメイカー（2本）
--     タイムボム       → TimeBombEvolution（2本）
--   こちらは原作名が作品名と違い、原作から許諾を受けた形に見える。
--   同じ扱いにするなら、下の plan に行を足すこと。
--
--   使い方（1つずつ、順に実行する）
--     【1】 報告。何も変えない。どの条件がどこへ動くかを目で見る
--     【2】 付け替える。(false) を (true) に書き換えてから
--     【3】 確認
--
--   何度流しても同じ結果になる（付け替え済みの条件は対象から外れる）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
-- ---------------------------------------------------------------------
WITH plan(work_code, from_part, to_part) AS (
  VALUES ('W-2026-0011', 22::bigint, 32::bigint),  -- ito クラシック：ito のコアロジック → 自分のコアロジック
         ('W-2026-0012', 22::bigint, 33::bigint),  -- ito レインボー：同上
         ('W-2026-0001', 21::bigint, 28::bigint),  -- New ito：ito のコアロジック → 自分のコアロジック
         ('W-2026-0001', 23::bigint, 24::bigint)   -- New ito：ito のイラスト   → 自分のイラスト
)
SELECT '1. 付け替える条件' AS 区分,
       w.work_code || ' ' || w.title AS 条件の作品,
       c.condition_no AS 条件番号,
       COALESCE((c.rate_ppm / 10000.0)::text, '—') || '%' AS 料率,
       fp.id::text || ' ' || fp.name AS いまの素材,
       tp.id::text || ' ' || tp.name AS 新しい素材
  FROM plan m
  JOIN v3.works w      ON w.work_code = m.work_code
  JOIN v3.conditions c ON c.work_id = w.id AND c.work_part_id = m.from_part
  JOIN v3.work_parts fp ON fp.id = m.from_part
  JOIN v3.work_parts tp ON tp.id = m.to_part
UNION ALL
-- 移し先が、その作品のものであること。よその素材へ付け替えたら意味が無い。
SELECT '2. 移し先の確かめ',
       w.work_code || ' ' || w.title,
       tp.id::text || ' ' || tp.name,
       CASE WHEN tp.work_id = w.id THEN 'この作品の素材です'
            ELSE '！よその作品の素材です。plan を見直してください' END,
       tp.part_type,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_part_id = tp.id)::text || ' 本（いま）'
  FROM (SELECT DISTINCT work_code, to_part FROM plan) m
  JOIN v3.works w       ON w.work_code = m.work_code
  JOIN v3.work_parts tp ON tp.id = m.to_part
UNION ALL
-- 権利包絡がどう動くか。ito から抜け、各作品に移る。
SELECT '3. 権利包絡（いまの取得条件）',
       w.work_code || ' ' || w.title, '', '', '',
       (SELECT count(*) FROM v3.conditions c
         WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active')::text || ' 本'
  FROM v3.works w
 WHERE w.work_code IN ('LO-2026-0021', 'W-2026-0001', 'W-2026-0011', 'W-2026-0012')
 ORDER BY 1, 2, 3;


-- ---------------------------------------------------------------------
-- 【2】付け替える。★ (false) を (true) に書き換えてから実行。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
plan(work_code, from_part, to_part) AS (
  VALUES ('W-2026-0011', 22::bigint, 32::bigint),
         ('W-2026-0012', 22::bigint, 33::bigint),
         ('W-2026-0001', 21::bigint, 28::bigint),
         ('W-2026-0001', 23::bigint, 24::bigint)
),
moved AS (
  UPDATE v3.conditions c
     SET work_part_id = m.to_part, updated_at = now()
    FROM plan m, v3.works w, v3.work_parts tp, go
   WHERE go.ok
     AND w.work_code = m.work_code
     AND c.work_id = w.id
     AND c.work_part_id = m.from_part
     -- 移し先がその作品の素材であることを、更新の条件そのものに入れる。
     -- 報告で見落としても、よその素材へは動かない。
     AND tp.id = m.to_part AND tp.work_id = w.id
  RETURNING c.id, c.condition_no, c.work_part_id
)
SELECT v.condition_no AS 条件番号, p.id::text || ' ' || p.name AS 新しい素材
  FROM moved v JOIN v3.work_parts p ON p.id = v.work_part_id
UNION ALL
SELECT '—', '0 件。(false) を (true) に書き換えて実行してください'
 WHERE NOT EXISTS (SELECT 1 FROM moved);


-- ---------------------------------------------------------------------
-- 【3】確認。
--      ・各作品の取得条件が自分のぶんだけになっていること
--      ・パートと条件の作品が食い違う行が、残り4本（クイックショット!・
--        タイムボム）だけになっていること
-- ---------------------------------------------------------------------
SELECT w.work_code AS 作品, w.title AS 作品名,
       (SELECT count(*) FROM v3.work_parts p WHERE p.work_id = w.id) AS パート数,
       (SELECT count(*) FROM v3.conditions c
         WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active') AS 取得条件,
       (SELECT count(*) FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
         WHERE c.work_id = w.id AND c.work_id IS DISTINCT FROM p.work_id) AS よその素材を指す条件
  FROM v3.works w
 WHERE w.work_code IN ('LO-2026-0021', 'W-2026-0001', 'W-2026-0011', 'W-2026-0012')
 ORDER BY w.work_code;
