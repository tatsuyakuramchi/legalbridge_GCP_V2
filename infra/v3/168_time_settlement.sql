-- =====================================================================
-- 168_time_settlement.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-073：準委任の時間精算（apps/legalbridge-v3/src/server/conditions/time-settlement.ts）。
--   中身は 004_amend.sql の A-073 と同じ（004 を流し直すなら、こちらは要らない）。
--
--     v3.conditions.time_settlement / hours_included / overage_unit_amount / shortfall_unit_amount
--       準委任の委託料で、月間包括枠（コアタイム）を持ち実績時間で精算するもの。
--       枠までは基本委託料（flat_amount）、超過は 超過単価 × 時間、未消化は 控除単価 × 時間（空なら減額なし）。
--     v3.condition_events.hours / report_received_on
--       実績時間と、月次業務報告書の受領日。役務提供完了通知書（169）に出す。
--
--   何度流しても同じ。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS time_settlement       boolean NOT NULL DEFAULT false;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS hours_included        numeric(8,2);
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS overage_unit_amount   bigint;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS shortfall_unit_amount bigint;
DO $a073$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_time_settlement_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_time_settlement_chk
      CHECK ((NOT time_settlement OR (hours_included IS NOT NULL AND hours_included > 0 AND overage_unit_amount IS NOT NULL))
         AND (hours_included IS NULL OR hours_included >= 0)
         AND (overage_unit_amount IS NULL OR overage_unit_amount >= 0)
         AND (shortfall_unit_amount IS NULL OR shortfall_unit_amount >= 0));
  END IF;
END $a073$;
COMMENT ON COLUMN v3.conditions.time_settlement IS
  '準委任の時間精算か。true なら包括枠（hours_included）までは基本委託料、超過は overage_unit_amount × 時間。A-073';
COMMENT ON COLUMN v3.conditions.hours_included IS '月間包括枠（時間）。時間精算のときだけ。A-073';
COMMENT ON COLUMN v3.conditions.overage_unit_amount IS '超過単価（最小通貨単位／時間）。A-073';
COMMENT ON COLUMN v3.conditions.shortfall_unit_amount IS '控除単価（最小通貨単位／時間）。空なら未消化でも減額しない。A-073';
ALTER TABLE v3.condition_events ADD COLUMN IF NOT EXISTS hours              numeric(8,2);
ALTER TABLE v3.condition_events ADD COLUMN IF NOT EXISTS report_received_on date;
COMMENT ON COLUMN v3.condition_events.hours IS '実績時間。時間精算の役務提供の回。A-073';
COMMENT ON COLUMN v3.condition_events.report_received_on IS '月次業務報告書の受領日。役務提供完了通知書に出す。A-073';

COMMIT;

-- 確認（列 6・CHECK 1 で 7 であること）
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='v3'
         AND ((table_name='conditions' AND column_name IN ('time_settlement', 'hours_included', 'overage_unit_amount', 'shortfall_unit_amount'))
           OR (table_name='condition_events' AND column_name IN ('hours', 'report_received_on'))))
     + (SELECT count(*) FROM pg_constraint WHERE conrelid='v3.conditions'::regclass AND conname='conditions_time_settlement_chk') AS 列とCHECK;
