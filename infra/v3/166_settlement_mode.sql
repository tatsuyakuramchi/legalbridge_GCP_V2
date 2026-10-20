-- =====================================================================
-- 166_settlement_mode.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-071：決済の型（apps/legalbridge-v3/src/server/conditions/settlement-mode.ts）。
--   中身は 004_amend.sql の A-071 と同じ（004 を流し直すなら、こちらは要らない）。
--
--     v3.conditions.settlement_mode
--       once        … 一回きり（成果物ありの業務委託、買い切り）
--       fixed_count … 回数固定。settlement_count 回（分割払い）
--       term_bound  … 期間で決まる。契約期間 ÷ settlement_cycle（顧問・保守、時限式の許諾料）
--       open        … 回数無制限。出来事のたび（製造・増刷）。終了後 settlement_grace_days（空は 60）まで
--
--   既存の条件は「2. 埋める」の規則で埋める（空のものだけ）。流す前に「1. 見る」で
--   どう埋まるかを確かめ、流したあと違う条件は条件明細の画面で直す。
--   何度流しても同じ。人が直した値は触らない。
-- =====================================================================

\set ON_ERROR_STOP on

-- 1. 見る（流す前に。Studio なら \ の行を消して流す。列はまだ無くてよい）
WITH s AS (
  SELECT condition_id, count(*) AS n, count(*) FILTER (WHERE trigger_kind = 'periodic') AS periodic_n
    FROM v3.condition_schedules GROUP BY condition_id
)
SELECT c.condition_no, c.kind, c.usage_type, c.statement_timing, c.cycle, COALESCE(s.n, 0) AS 予定行数,
       CASE
         WHEN c.statement_timing = 'event'
           OR (c.kind IN ('license', 'product') AND c.usage_type IN ('pub_print', 'oem')) THEN 'open'
         WHEN c.statement_timing = 'periodic' OR COALESCE(s.periodic_n, 0) > 0 THEN 'term_bound'
         WHEN COALESCE(s.n, 0) >= 2 THEN 'fixed_count'
         ELSE 'once'
       END AS 推した型
  FROM v3.conditions c LEFT JOIN s ON s.condition_id = c.id
 WHERE c.status IN ('active', 'scheduled', 'draft')
 ORDER BY 推した型, c.condition_no;

-- 2. 埋める
BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS settlement_mode       text;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS settlement_count      integer;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS settlement_cycle      text;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS settlement_grace_days integer;
DO $a071$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_settlement_mode_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_settlement_mode_chk
      CHECK (settlement_mode IS NULL OR settlement_mode IN ('once', 'fixed_count', 'term_bound', 'open'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_settlement_cycle_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_settlement_cycle_chk
      CHECK (settlement_cycle IS NULL OR settlement_cycle IN ('month', 'quarter', 'half_year', 'year'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_settlement_shape_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_settlement_shape_chk
      CHECK ((settlement_mode IS DISTINCT FROM 'fixed_count' OR (settlement_count IS NOT NULL AND settlement_count >= 2))
         AND (settlement_mode IS DISTINCT FROM 'term_bound' OR settlement_cycle IS NOT NULL)
         AND (settlement_grace_days IS NULL OR settlement_grace_days BETWEEN 0 AND 3650));
  END IF;
END $a071$;
COMMENT ON COLUMN v3.conditions.settlement_mode IS
  '決済の型。once=一回きり / fixed_count=回数固定 / term_bound=期間で決まる / open=回数無制限。A-071';
COMMENT ON COLUMN v3.conditions.settlement_count IS '回数固定のときの回数。A-071';
COMMENT ON COLUMN v3.conditions.settlement_cycle IS '期間で決まるときの周期。month / quarter / half_year / year。A-071';
COMMENT ON COLUMN v3.conditions.settlement_grace_days IS
  '終了日の後いつまで回を立ててよいか（日）。空は 60。回数無制限と期間で決まる型に効く。A-071';

WITH s AS (
  SELECT condition_id, count(*) AS n, count(*) FILTER (WHERE trigger_kind = 'periodic') AS periodic_n
    FROM v3.condition_schedules GROUP BY condition_id
), d AS (
  SELECT c.id,
         CASE
           WHEN c.statement_timing = 'event'
             OR (c.kind IN ('license', 'product') AND c.usage_type IN ('pub_print', 'oem')) THEN 'open'
           WHEN c.statement_timing = 'periodic' OR COALESCE(s.periodic_n, 0) > 0 THEN 'term_bound'
           WHEN COALESCE(s.n, 0) >= 2 THEN 'fixed_count'
           ELSE 'once'
         END AS mode,
         COALESCE(s.n, 0)::int AS n,
         CASE
           WHEN c.cycle ~* '四半期|quarter|3[かヶカ]月' THEN 'quarter'
           WHEN c.cycle ~* '半年|半期|6[かヶカ]月|half' THEN 'half_year'
           WHEN c.cycle ~* '年|annual|year' THEN 'year'
           WHEN c.cycle ~* '月|month' THEN 'month'
           WHEN c.kind IN ('license', 'product') THEN 'quarter'
           ELSE 'month'
         END AS cyc
    FROM v3.conditions c LEFT JOIN s ON s.condition_id = c.id
   WHERE c.settlement_mode IS NULL
)
UPDATE v3.conditions c
   SET settlement_mode  = d.mode,
       settlement_count = CASE WHEN d.mode = 'fixed_count' THEN d.n END,
       settlement_cycle = CASE WHEN d.mode = 'term_bound' THEN d.cyc END
  FROM d WHERE d.id = c.id;

COMMIT;

-- 3. 確認（型ごとの件数。空は 0 であること）
SELECT COALESCE(settlement_mode, '(空)') AS 型, count(*) AS 件数
  FROM v3.conditions GROUP BY 1 ORDER BY 1;
