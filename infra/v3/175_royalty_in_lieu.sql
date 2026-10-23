-- =====================================================================
-- 175_royalty_in_lieu.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-075：原稿・イラストなど受注者帰属の成果物の制作対価を、別途の制作報酬ではなく
--   利用許諾料（印税）で払う発注（docs/v3-request-inbox.md T17）。
--
--   委託料の行の確定額は「保証利用許諾料」（発行の有無にかかわらず受領後 60 日以内に払う
--   最低保証）で、利用許諾条件の MG と同じ額。料率型の利用許諾料はその超過分だけ計算書で
--   払う。取適法・フリーランス法の 60 日以内・買いたたき・一方的決定の受け皿がこの保証額。
--
--     conditions.license_fee_basis        in_lieu を追加（保証利用許諾料に代える）
--     conditions.reward_label             委託料の行の報酬名の上書き（紙の「保証利用許諾料（利用許諾料は別途）」）
--     conditions.royalty_exempt_first_copies   印税対象外（初版の献本等。部数）
--     conditions.royalty_exempt_later_pct      印税対象外（2 版目以降の献本等。発行部数の %）
--     v3.condition_fee_covers             利用許諾条件 × その利用許諾料が対価を兼ねる委託料の条件
--
--   何度流しても同じ。データは書き換えない。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- 許諾料の扱い（A-048）に in_lieu（保証利用許諾料に代える）を足す。
ALTER TABLE v3.conditions DROP CONSTRAINT IF EXISTS conditions_license_fee_basis_chk;
ALTER TABLE v3.conditions ADD CONSTRAINT conditions_license_fee_basis_chk
  CHECK (license_fee_basis IN ('separate', 'included', 'free', 'in_lieu'));
COMMENT ON COLUMN v3.conditions.license_fee_basis IS
  '許諾料の扱い（separate=別途 / included=業務委託報酬に含む / free=無償 / in_lieu=保証利用許諾料が制作対価を兼ねる）。許諾条件だけが意味を持つ。';

-- 委託料の行の報酬名。空なら計算方式と帰属先から導く（core/reward.ts）。
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS reward_label text;
COMMENT ON COLUMN v3.conditions.reward_label IS
  '報酬名の上書き（保証利用許諾料 など）。発注書・検収書の金額欄の小さな行に出る。空なら導く。';

-- 印税対象外（献本等）。許諾条件だけが持つ。初版は部数、2 版目以降は発行部数の %。
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS royalty_exempt_first_copies integer;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS royalty_exempt_later_pct numeric(5,2);
DO $a076$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_royalty_exempt_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_royalty_exempt_chk
      CHECK ((royalty_exempt_first_copies IS NULL OR royalty_exempt_first_copies >= 0)
         AND (royalty_exempt_later_pct IS NULL OR (royalty_exempt_later_pct >= 0 AND royalty_exempt_later_pct <= 100)));
  END IF;
END
$a076$;
COMMENT ON COLUMN v3.conditions.royalty_exempt_first_copies IS '印税対象外の部数（初版の献本等）。空なら対象外なし。';
COMMENT ON COLUMN v3.conditions.royalty_exempt_later_pct IS '印税対象外の割合（2 版目以降、発行部数の %）。空なら対象外なし。';

-- 利用許諾条件が対価を兼ねる委託料の条件。発注書の「■ 利用許諾条件」が対象の行番号を出す。
CREATE TABLE IF NOT EXISTS v3.condition_fee_covers (
  license_condition_id bigint NOT NULL REFERENCES v3.conditions(id) ON DELETE CASCADE,
  service_condition_id bigint NOT NULL REFERENCES v3.conditions(id) ON DELETE CASCADE,
  PRIMARY KEY (license_condition_id, service_condition_id)
);
CREATE INDEX IF NOT EXISTS condition_fee_covers_service_idx ON v3.condition_fee_covers (service_condition_id);
COMMENT ON TABLE v3.condition_fee_covers IS
  '利用許諾条件（in_lieu）× その利用許諾料が制作対価を兼ねる委託料の条件。A-075';
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.condition_fee_covers TO legalbridge_v3_runtime;

COMMIT;

-- 確認
SELECT pg_get_constraintdef(oid) AS license_fee_basis_chk
  FROM pg_constraint WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_license_fee_basis_chk';
