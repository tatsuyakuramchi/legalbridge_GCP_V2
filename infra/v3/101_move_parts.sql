-- =====================================================================
-- 101_move_parts.sql
--   別作品の素材が、親作品のパートとして入っているものを移す。
--
--   作品「ito」のパートに、シリーズの別作品（New ito・ito レインボー）の
--   素材が混ざっている。条件書を作ると別作品の素材が同じ表に並び、作品の
--   権利包絡（v_work_scope_envelope）も親作品のものとして数えられている。
--
--   対象は名指し。規則で拾うと、パート名が自分の作品名と同じだけの行
--   （ito クラシック・神我狩 リプレイ…）まで当たる。
--
--   実行:
--     報告だけ  psql "$ADMIN_DSN" -f infra/v3/101_move_parts.sql
--     移す      psql "$ADMIN_DSN" -f infra/v3/101_move_parts.sql \
--                    -v confirm_move=MOVE_PARTS_TO_DERIVED_WORKS
--
--   何度流しても同じ結果になる（移し終えた行は対象から外れる）。
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------
-- 対象。パートIDと移し先の作品コードを名指しする。
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS move_plan;
CREATE TEMP TABLE move_plan (part_id bigint PRIMARY KEY, to_work_code text NOT NULL);
INSERT INTO move_plan (part_id, to_work_code) VALUES
  (24, 'W-2026-0001'),   -- NewIto_イラスト        → New ito
  (28, 'W-2026-0001'),   -- New ito 原作ゲームデザイン → New ito
  (26, 'W-2026-0012');   -- itoレインボー_イラスト → ito　レインボー

-- 名指しが実在するかを先に確かめる。IDがずれたまま流すと別の素材が動く。
DO $check$
DECLARE missing text;
BEGIN
  SELECT string_agg(m.part_id::text, ', ') INTO missing
    FROM move_plan m WHERE NOT EXISTS (SELECT 1 FROM v3.work_parts p WHERE p.id = m.part_id);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'パート % が見つかりません。IDを確かめてください', missing;
  END IF;
  SELECT string_agg(DISTINCT m.to_work_code, ', ') INTO missing
    FROM move_plan m WHERE NOT EXISTS (SELECT 1 FROM v3.works w WHERE w.work_code = m.to_work_code);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '移し先の作品 % が見つかりません', missing;
  END IF;
END
$check$;

\echo '--- 動かすパート ---'
SELECT p.id AS パートid, p.part_no AS 現番号, p.name AS パート名, p.part_type AS 素材類型,
       fw.work_code AS 現在の作品, tw.work_code AS 移し先,
       (SELECT count(*) FROM v3.conditions c WHERE c.work_part_id = p.id) AS 条件本数
  FROM move_plan m
  JOIN v3.work_parts p ON p.id = m.part_id
  JOIN v3.works fw ON fw.id = p.work_id
  JOIN v3.works tw ON tw.work_code = m.to_work_code
 ORDER BY fw.work_code, p.part_no;

\echo '--- 一緒に動く条件明細（work_id が移し先へ変わる）---'
SELECT c.condition_no AS 条件番号, c.direction AS 方向, c.kind AS 種類,
       c.rate_ppm / 10000.0 AS 料率pct, c.status AS 状態,
       p.name AS パート名, fw.work_code AS 現在の作品, m.to_work_code AS 移し先
  FROM move_plan m
  JOIN v3.work_parts p ON p.id = m.part_id
  JOIN v3.conditions c ON c.work_part_id = p.id
  JOIN v3.works fw ON fw.id = c.work_id
 ORDER BY fw.work_code, p.name, c.condition_no;

\echo '--- 権利包絡への影響（移す前の取得条件の本数）---'
SELECT w.work_code AS 作品, w.title AS 作品名,
       (SELECT count(*) FROM v3.conditions c
         WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active') AS 取得条件
  FROM v3.works w
 WHERE w.work_code IN (
   SELECT fw.work_code FROM move_plan m JOIN v3.work_parts p ON p.id = m.part_id
     JOIN v3.works fw ON fw.id = p.work_id)
    OR w.work_code IN (SELECT to_work_code FROM move_plan)
 ORDER BY w.work_code;

\echo '--- 系譜（移したあとも親子の関係は残るか）---'
SELECT pw.work_code AS 親, cw.work_code AS 子, l.relation_type AS 関係
  FROM v3.work_lineage l
  JOIN v3.works pw ON pw.id = l.parent_work_id
  JOIN v3.works cw ON cw.id = l.child_work_id
 WHERE cw.work_code IN (SELECT to_work_code FROM move_plan)
    OR pw.work_code IN (SELECT to_work_code FROM move_plan);

\if :{?confirm_move}
\else
  \echo ''
  \echo '報告だけで終わりました。移すには -v confirm_move=MOVE_PARTS_TO_DERIVED_WORKS を付けてください。'
  \quit
\endif

SELECT :'confirm_move' = 'MOVE_PARTS_TO_DERIVED_WORKS' AS confirmed
\gset
\if :confirmed
\else
  \echo '確認の値が違います。何も変えていません。'
  \quit 2
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- パートを移す。番号は移し先の続きに振り直す（作品内で一意のため）。
-- UNIQUE(work_id, part_no) は DEFERRABLE なので、途中ですれ違っても
-- COMMIT 時に一意なら通る。
WITH target AS (
  SELECT m.part_id, tw.id AS to_work_id,
         (SELECT COALESCE(max(p2.part_no), 0) FROM v3.work_parts p2 WHERE p2.work_id = tw.id)
         + row_number() OVER (PARTITION BY tw.id ORDER BY p.part_no, p.id) AS new_no
    FROM move_plan m
    JOIN v3.work_parts p ON p.id = m.part_id
    JOIN v3.works tw ON tw.work_code = m.to_work_code
   WHERE p.work_id <> tw.id
)
UPDATE v3.work_parts p
   SET work_id = t.to_work_id, part_no = t.new_no
  FROM target t WHERE p.id = t.part_id;

-- 条件明細も一緒に動かす。パートだけ動かすと
-- 「作品Aの条件なのにパートは作品Bのもの」というねじれた行が残る
-- （この組み合わせを禁じる制約はスキーマに無い）。
UPDATE v3.conditions c
   SET work_id = p.work_id, updated_at = now()
  FROM v3.work_parts p
 WHERE c.work_part_id = p.id
   AND p.id IN (SELECT part_id FROM move_plan)
   AND c.work_id IS DISTINCT FROM p.work_id;

-- 確認：今回動かしたパートについて、食い違う行が残っていないこと。
--
-- 全体で見てはいけない。台帳には今回の対象以外にも、パートと条件の作品が
-- 食い違う行が残っている（本番で39件）。全体を条件にすると、直したぶんまで
-- 巻き戻る。残りの件数は下に出すが、止める理由にはしない。
DO $verify$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
   WHERE p.id IN (SELECT part_id FROM move_plan)
     AND c.work_id IS DISTINCT FROM p.work_id;
  IF bad > 0 THEN
    RAISE EXCEPTION '動かしたパートで、作品の食い違う条件が % 件残っています', bad;
  END IF;
END
$verify$;

COMMIT;

\echo '--- 移したあと ---'
SELECT w.work_code AS 作品, w.title AS 作品名,
       (SELECT count(*) FROM v3.work_parts p WHERE p.work_id = w.id) AS パート数,
       (SELECT count(*) FROM v3.conditions c
         WHERE c.work_id = w.id AND c.direction = 'in' AND c.status = 'active') AS 取得条件
  FROM v3.works w
 WHERE w.work_code IN ('LO-2026-0021', 'W-2026-0001', 'W-2026-0012')
 ORDER BY w.work_code;

\echo '--- 台帳全体に残っているねじれ（今回の対象以外。別途の整理が要る）---'
SELECT count(*) AS 残っているねじれ
  FROM v3.conditions c JOIN v3.work_parts p ON p.id = c.work_part_id
 WHERE c.work_id IS DISTINCT FROM p.work_id;
