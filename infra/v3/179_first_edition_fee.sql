-- =====================================================================
-- 179_first_edition_fee.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-077：初版の利用許諾料を委託報酬として払う発注（仮計算 → 納品後 60 日以内に確定）。
--
--   175（A-075）の「保証利用許諾料に代える（AG 相殺）」を、この運用に一本化する。
--   発注時は見込みの本体価格・初版部数・料率（・非加算部数）で仮計算した額を委託料の行の
--   確定額にし、納品後に本体価格と初版部数を確定して検収書で払う（確定額が仮計算額を
--   下回れば仮計算額）。2 版目以降は出版基本契約の個別契約による印税で、初版は計算書の対象外。
--
--     conditions.first_edition_price      … 見込み（確定後は確定）本体価格（最小通貨単位）
--     conditions.first_edition_copies     … 見込み（確定後は確定）初版発行部数
--     conditions.first_edition_rate_ppm   … 初版の料率（百万分率）。2 版目以降の料率（rate_ppm）とは別
--     conditions.confirm_within_days      … 受領から何日以内に本体価格・部数を確定するか（60 以内）
--     conditions.royalty_exempt_first_copies（175）… 初版の非加算部数（献本・見本等）。0／空なら全部数
--     conditions.royalty_exempt_later_pct（175）   … 2 版目以降の非加算（発行部数の %）
--   いずれも利用許諾条件（license_fee_basis = in_lieu）の先頭の 1 本が持つ。
--   AG（ag_amount）はこの運用では使わない（175 で入れた AG は 2 版目以降の計算書で相殺されて
--   しまうので、既存の in_lieu 条件があれば ag_amount を空にする）。
--
--   何度流しても同じ。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS first_edition_price    bigint;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS first_edition_copies   integer;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS first_edition_rate_ppm integer;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS confirm_within_days    integer;
DO $a077$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_first_edition_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_first_edition_chk
      CHECK ((first_edition_price IS NULL OR first_edition_price >= 0)
         AND (first_edition_copies IS NULL OR first_edition_copies >= 0)
         AND (first_edition_rate_ppm IS NULL OR (first_edition_rate_ppm >= 0 AND first_edition_rate_ppm <= 1000000))
         AND (confirm_within_days IS NULL OR (confirm_within_days >= 1 AND confirm_within_days <= 60)));
  END IF;
END $a077$;
COMMENT ON COLUMN v3.conditions.first_edition_price    IS '初版の本体価格（最小通貨単位）。発注時は見込み、確定後は確定値。A-077';
COMMENT ON COLUMN v3.conditions.first_edition_copies   IS '初版発行部数。発注時は見込み、確定後は確定値。A-077';
COMMENT ON COLUMN v3.conditions.first_edition_rate_ppm IS '初版の料率（百万分率）。2 版目以降の rate_ppm とは別。A-077';
COMMENT ON COLUMN v3.conditions.confirm_within_days    IS '受領から何日以内に本体価格・初版部数を確定するか（60 以内）。A-077';
COMMENT ON COLUMN v3.conditions.license_fee_basis IS
  '許諾料の扱い（separate=別途 / included=業務委託報酬に含む / free=無償 / in_lieu=初版の利用許諾料を委託報酬として支払済み）。許諾条件だけが意味を持つ。';

-- 175 で AG に入れた保証額は、この運用では 2 版目以降の計算書で相殺されてしまうので外す。
UPDATE v3.conditions SET ag_amount = NULL, updated_at = now()
 WHERE license_fee_basis = 'in_lieu' AND ag_amount IS NOT NULL;

COMMIT;

-- 確認
SELECT count(*) AS 列 FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='conditions'
   AND column_name IN ('first_edition_price', 'first_edition_copies', 'first_edition_rate_ppm', 'confirm_within_days');
