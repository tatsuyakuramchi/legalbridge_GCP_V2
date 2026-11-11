-- =====================================================================
-- 205_agreement_hybrid.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   契約の種別に「ハイブリッド」を足す（業務委託とライセンスの両方の個別契約を持てる基本契約）。
--     agreements.domain … service 業務委託／license ライセンス／hybrid ハイブリッド／sale 売買／other その他
--   番号の頭（アプリの agreements/service.ts numberPrefix）
--     基本契約：ARC-HYB　単体契約：ARC-IHB
--
--   流すまでは、ハイブリッドを選んで登録すると「205 を先に流してください」と断る（ほかは今までどおり）。
--   何度流しても同じ結果。戻すときは 205_agreement_hybrid_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.agreements DROP CONSTRAINT IF EXISTS agreements_domain_chk;
ALTER TABLE v3.agreements ADD CONSTRAINT agreements_domain_chk
  CHECK (domain IS NULL OR domain IN ('service', 'license', 'hybrid', 'sale', 'other'));

COMMENT ON COLUMN v3.agreements.domain IS
  'service 業務委託／license ライセンス／hybrid ハイブリッド（業務委託とライセンスの両方）／sale 売買／other その他（覚書など）。番号の頭（SVC・LIC・HYB・SAL・OTH、単体は ISA・ILT・IHB・ISL・IOT）が決まる。';

COMMIT;

SELECT pg_get_constraintdef(oid) AS agreements_domain_chk FROM pg_constraint WHERE conname = 'agreements_domain_chk';
