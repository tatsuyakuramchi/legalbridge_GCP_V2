-- =====================================================================
-- 200_agreement_domains.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   契約の種別に「売買」「その他（覚書など）」を足す。
--     agreements.domain … service 業務委託／license ライセンス／sale 売買／other その他（覚書など）
--   番号の頭（アプリの agreements/service.ts numberPrefix）
--     基本契約：ARC-SVC／ARC-LIC／ARC-SAL／ARC-OTH
--     単体契約：ARC-ISA／ARC-ILT／ARC-ISL／ARC-IOT
--
--   流すまでは、売買・その他を選んで登録すると「200 を先に流してください」と断る（ほかは今までどおり）。
--   何度流しても同じ結果。戻すときは 200_agreement_domains_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.agreements DROP CONSTRAINT IF EXISTS agreements_domain_chk;
ALTER TABLE v3.agreements ADD CONSTRAINT agreements_domain_chk
  CHECK (domain IS NULL OR domain IN ('service', 'license', 'sale', 'other'));

COMMENT ON COLUMN v3.agreements.domain IS
  'service 業務委託／license ライセンス／sale 売買／other その他（覚書など）。番号の頭（SVC・LIC・SAL・OTH、単体は ISA・ILT・ISL・IOT）が決まる。';

COMMIT;
