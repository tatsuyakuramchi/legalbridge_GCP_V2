-- =====================================================================
-- 101_move_parts_studio.sql（Cloud SQL Studio 用）
--
--   別作品の素材が、親作品のパートとして入っているものを移す。
--   psql が使えるなら infra/v3/101_move_parts.sql のほうを流すこと。
--   Studio は psql のクライアント機能（\set・\echo・\if）を解釈せず、
--   RAISE NOTICE も表示しない。そこでブロックごとに分け、実行したぶんは
--   結果の行として返す（何も動かなかったときも、その旨を1行返す）。
--
--   使い方（1つずつ、順に実行する）
--     【1】   報告。何も変えない
--     【2-a】 パートを移す。(false) を (true) に書き換えてから
--     【2-b】 条件明細の作品を合わせる。同じく書き換えてから
--     【3】   確認。New ito のパート数が増えていれば済んでいる
--
--   何度流しても同じ結果になる（移し終えた行は対象から外れる）。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
-- ---------------------------------------------------------------------
WITH plan(part_id, to_work_code) AS (
  VALUES (24::bigint, 'W-2026-0001'),   -- NewIto_イラスト            → New ito
         (28::bigint, 'W-2026-0001'),   -- New ito 原作ゲームデザイン → New ito
         (26::bigint, 'W-2026-0012')    -- itoレインボー_イラスト     → ito　レインボー
),
-- 名指ししたパートが実在するか。ID がずれていたら、ここが「見つかりません」になる。
missing AS (
  SELECT 1 AS n, '確認' AS 区分,
         'パート ' || m.part_id || ' が見つかりません' AS 対象, '' AS 詳細
    FROM plan m WHERE NOT EXISTS (SELECT 1 FROM v3.work_parts p WHERE p.id = m.part_id)
  UNION ALL
  SELECT 1, '確認', '移し先の作品 ' || m.to_work_code || ' が見つかりません', ''
    FROM plan m WHERE NOT EXISTS (SELECT 1 FROM v3.works w WHERE w.work_code = m.to_work_code)
),
parts AS (
  SELECT 2 AS n, '動かすパート' AS 区分,
         p.id || ' ' || p.name AS 対象,
         fw.work_code || ' → ' || tw.work_code
         || '（' || p.part_type || '・条件 '
         || (SELECT count(*) FROM v3.conditions c WHERE c.work_part_id = p.id) || ' 本）' AS 詳細
    FROM plan m
    JOIN v3.work_parts p ON p.id = m.part_id
    JOIN v3.works fw ON fw.id = p.work_id
    JOIN v3.works tw ON tw.work_code = m.to_work_code
   WHERE p.work_id <> tw.id
),
conds AS (
  SELECT 3 AS n, '一緒に動く条件明細' AS 区分,
         c.condition_no || ' ' || p.name AS 対象,
         c.direction || '／' || c.kind || '／'
         || COALESCE((c.rate_ppm / 10000.0)::text, '—') || '%／' || c.status
         || '　' || fw.work_code || ' → ' || m.to_work_code AS 詳細
    FROM plan m
    JOIN v3.work_parts p ON p.id = m.part_id
    JOIN v3.conditions c ON c.work_part_id = p.id
    JOIN v3.works fw ON fw.id = c.work_id
),
impact AS (
  SELECT 4 AS n, '権利包絡（いまの取得条件の本数）' AS 区分,
         w.work_code || ' ' || w.title AS 対象,
         (SELECT count(*) FROM v3.conditions c
           WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active')::text || ' 本' AS 詳細
    FROM v3.works w
   WHERE w.id IN (SELECT p.work_id FROM plan m JOIN v3.work_parts p ON p.id = m.part_id)
      OR w.work_code IN (SELECT to_work_code FROM plan)
),
lineage AS (
  SELECT 5 AS n, '系譜' AS 区分,
         pw.work_code || ' → ' || cw.work_code AS 対象, l.relation_type AS 詳細
    FROM v3.work_lineage l
    JOIN v3.works pw ON pw.id = l.parent_work_id
    JOIN v3.works cw ON cw.id = l.child_work_id
   WHERE cw.work_code IN (SELECT to_work_code FROM plan)
      OR pw.work_code IN (SELECT to_work_code FROM plan)
),
twisted AS (
  SELECT 6 AS n, 'いまねじれている行' AS 区分,
         count(*)::text || ' 件' AS 対象,
         'パートの作品と条件の作品が食い違う行。今回の対象（下の条件明細）のぶんは移動で解消する。'
         || '残りは別の素材の話なので、この作業では減らない' AS 詳細
    FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
   WHERE c.work_id IS DISTINCT FROM p.work_id
)
SELECT 区分, 対象, 詳細 FROM (
  SELECT * FROM missing UNION ALL SELECT * FROM parts UNION ALL SELECT * FROM conds
  UNION ALL SELECT * FROM impact UNION ALL SELECT * FROM lineage UNION ALL SELECT * FROM twisted
) s ORDER BY n, 対象;


-- ---------------------------------------------------------------------
-- 【2-a】パートを移す。
--
--   ★ 下の (false) を (true) に書き換えてから実行する。
--     false のままなら1行も動かない。
--
--   Studio は RAISE NOTICE を表示しないので、動かした行をそのまま返す。
--   0 行で終わらないよう、何も動かなかったときもその旨を1行返す。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
plan(part_id, to_work_code) AS (
  VALUES (24::bigint, 'W-2026-0001'),     -- NewIto_イラスト            → New ito
         (28::bigint, 'W-2026-0001'),     -- New ito 原作ゲームデザイン → New ito
         (26::bigint, 'W-2026-0012')      -- itoレインボー_イラスト     → ito　レインボー
),
target AS (
  -- 番号は移し先の続きに振り直す（作品内で一意のため）。
  -- UNIQUE(work_id, part_no) は DEFERRABLE なので途中ですれ違っても通る。
  SELECT m.part_id, tw.id AS to_work_id,
         (SELECT COALESCE(max(p2.part_no), 0) FROM v3.work_parts p2 WHERE p2.work_id = tw.id)
         + row_number() OVER (PARTITION BY tw.id ORDER BY p.part_no, p.id) AS new_no
    FROM plan m
    JOIN v3.work_parts p ON p.id = m.part_id
    JOIN v3.works tw ON tw.work_code = m.to_work_code
   WHERE p.work_id <> tw.id
),
moved AS (
  UPDATE v3.work_parts p
     SET work_id = t.to_work_id, part_no = t.new_no
    FROM target t, go
   WHERE p.id = t.part_id AND go.ok
  RETURNING p.id, p.name, p.work_id, p.part_no
)
SELECT m.id::text AS パートid, m.name AS パート名,
       w.work_code || ' ' || w.title AS 移し先, m.part_no::text AS 新番号
  FROM moved m JOIN v3.works w ON w.id = m.work_id
UNION ALL
SELECT '—', '0 件。上の (false) を (true) に書き換えて実行してください', '', ''
 WHERE NOT EXISTS (SELECT 1 FROM moved);


-- ---------------------------------------------------------------------
-- 【2-b】条件明細の作品を、パートの作品に合わせる。
--
--   本番のデータは条件のほうが既に正しい作品を指しているので、たいてい 0 件。
--   それでも要る。パートだけ動かすと「作品Aの条件なのにパートは作品Bのもの」
--   というねじれた行が残り、これを禁じる制約はスキーマに無い。
--   【2-a】を流したあとに実行すること（パートの移動を見てから合わせる）。
--
--   ★ 下の (false) を (true) に書き換えてから実行する。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
fixed AS (
  UPDATE v3.conditions c
     SET work_id = p.work_id, updated_at = now()
    FROM v3.work_parts p, go
   WHERE c.work_part_id = p.id
     AND p.id IN (24, 28, 26)
     AND c.work_id IS DISTINCT FROM p.work_id
     AND go.ok
  RETURNING c.condition_no, c.work_id
)
SELECT f.condition_no AS 条件番号, w.work_code || ' ' || w.title AS 新しい作品
  FROM fixed f JOIN v3.works w ON w.id = f.work_id
UNION ALL
SELECT '—', '0 件（条件は既に正しい作品を指しています。異常ではありません）'
 WHERE NOT EXISTS (SELECT 1 FROM fixed);


-- ---------------------------------------------------------------------
-- 【3】確認。移動が済んでいるかはこれで見る。
--      New ito が パート数 3 になっていれば済んでいる。
-- ---------------------------------------------------------------------
SELECT w.work_code AS 作品, w.title AS 作品名,
       (SELECT count(*) FROM v3.work_parts p WHERE p.work_id = w.id) AS パート数,
       (SELECT count(*) FROM v3.conditions c
         WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active') AS 取得条件,
       (SELECT count(*) FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
         WHERE p.id IN (24, 28, 26) AND c.work_id IS DISTINCT FROM p.work_id) AS 対象のねじれ,
       (SELECT count(*) FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
         WHERE c.work_id IS DISTINCT FROM p.work_id) AS ねじれ全体
  FROM v3.works w
 WHERE w.work_code IN ('LO-2026-0021', 'W-2026-0001', 'W-2026-0012')
 ORDER BY w.work_code;
