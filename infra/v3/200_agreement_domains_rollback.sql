-- =====================================================================
-- 200_agreement_domains_rollback.sql
--
--   200 を戻す。売買・その他の契約が残っていると戻せない（種別を直してから流す）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM v3.agreements WHERE domain IN ('sale', 'other')) THEN
    RAISE EXCEPTION '売買・その他の契約が残っています。種別を業務委託かライセンスに直してから戻してください';
  END IF;
END
$chk$;

ALTER TABLE v3.agreements DROP CONSTRAINT IF EXISTS agreements_domain_chk;
ALTER TABLE v3.agreements ADD CONSTRAINT agreements_domain_chk
  CHECK (domain IS NULL OR domain IN ('service', 'license'));

COMMENT ON COLUMN v3.agreements.domain IS 'service 業務委託／license ライセンス。番号の頭（SVC・LIC・ISA・ILT）が決まる。';

COMMIT;
