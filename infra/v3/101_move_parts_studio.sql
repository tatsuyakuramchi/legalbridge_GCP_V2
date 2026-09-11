-- =====================================================================
-- 101_move_parts_studio.sql（Cloud SQL Studio 用）
--
--   別作品の素材が、親作品のパートとして入っているものを移す。
--   psql が使えるなら infra/v3/101_move_parts.sql のほうを流すこと。
--   Studio は psql のクライアント機能（\set・\echo・\if）を解釈しないので、
--   報告と実行を2つのブロックに分け、確認は DO ブロックの中の真偽値で行う。
--
--   使い方
--     1. 【1】を貼って実行し、動くものを目で見る
--     2. 納得したら【2】の confirm を true に書き換えて実行する
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
-- 【2】移す。confirm を true に書き換えてから実行する。
--      false のあいだは何も変えずに終わる。
-- ---------------------------------------------------------------------
DO $move$
DECLARE
  -- ★ ここを true にすると動く。
  confirm     boolean := false;
  missing     text;
  moved_parts int;
  moved_conds int;
  bad         int;
BEGIN
  IF NOT confirm THEN
    RAISE NOTICE '確認が false のままです。何も変えていません。'
                 ' 上の【1】の結果を見てから true に書き換えてください。';
    RETURN;
  END IF;

  -- 名指しが実在するか。ID がずれたまま流すと別の素材が動く。
  SELECT string_agg(m.part_id::text, ', ') INTO missing
    FROM (VALUES (24::bigint), (28::bigint), (26::bigint)) AS m(part_id)
   WHERE NOT EXISTS (SELECT 1 FROM v3.work_parts p WHERE p.id = m.part_id);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'パート % が見つかりません。ID を確かめてください', missing;
  END IF;

  -- パートを移す。番号は移し先の続きに振り直す（作品内で一意のため）。
  -- UNIQUE(work_id, part_no) は DEFERRABLE なので、途中ですれ違っても
  -- COMMIT 時に一意なら通る。
  WITH plan(part_id, to_work_code) AS (
    VALUES (24::bigint, 'W-2026-0001'), (28::bigint, 'W-2026-0001'), (26::bigint, 'W-2026-0012')
  ), target AS (
    SELECT m.part_id, tw.id AS to_work_id,
           (SELECT COALESCE(max(p2.part_no), 0) FROM v3.work_parts p2 WHERE p2.work_id = tw.id)
           + row_number() OVER (PARTITION BY tw.id ORDER BY p.part_no, p.id) AS new_no
      FROM plan m
      JOIN v3.work_parts p ON p.id = m.part_id
      JOIN v3.works tw ON tw.work_code = m.to_work_code
     WHERE p.work_id <> tw.id
  )
  UPDATE v3.work_parts p
     SET work_id = t.to_work_id, part_no = t.new_no
    FROM target t WHERE p.id = t.part_id;
  GET DIAGNOSTICS moved_parts = ROW_COUNT;

  -- 条件明細も一緒に動かす。パートだけ動かすと「作品Aの条件なのにパートは
  -- 作品Bのもの」というねじれた行が残る（これを禁じる制約はスキーマに無い）。
  UPDATE v3.conditions c
     SET work_id = p.work_id, updated_at = now()
    FROM v3.work_parts p
   WHERE c.work_part_id = p.id
     AND p.id IN (24, 28, 26)
     AND c.work_id IS DISTINCT FROM p.work_id;
  GET DIAGNOSTICS moved_conds = ROW_COUNT;

  -- 確認は「今回動かしたパート」だけを見る。
  -- 台帳全体には対象外のねじれも残っている（本番で39件）。全体を条件にすると、
  -- 直したぶんまで巻き戻る。残りは知らせるだけにして、止める理由にはしない。
  SELECT count(*) INTO bad
    FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
   WHERE p.id IN (24, 28, 26) AND c.work_id IS DISTINCT FROM p.work_id;
  IF bad > 0 THEN
    RAISE EXCEPTION '動かしたパートで、作品の食い違う条件が % 件残っています。巻き戻しました', bad;
  END IF;

  SELECT count(*) INTO bad
    FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
   WHERE c.work_id IS DISTINCT FROM p.work_id;
  RAISE NOTICE 'パート % 件、条件明細 % 件を移しました。台帳全体に残っているねじれ: % 件（今回の対象外。別途の整理が要る）',
               moved_parts, moved_conds, bad;
END
$move$;


-- ---------------------------------------------------------------------
-- 【3】移したあとの確認。
-- ---------------------------------------------------------------------
SELECT w.work_code AS 作品, w.title AS 作品名,
       (SELECT count(*) FROM v3.work_parts p WHERE p.work_id = w.id) AS パート数,
       (SELECT count(*) FROM v3.conditions c
         WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active') AS 取得条件,
       (SELECT count(*) FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
         WHERE c.work_id IS DISTINCT FROM p.work_id) AS ねじれた行_全体
  FROM v3.works w
 WHERE w.work_code IN ('LO-2026-0021', 'W-2026-0001', 'W-2026-0012')
 ORDER BY w.work_code;
