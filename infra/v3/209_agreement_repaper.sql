-- =====================================================================
-- 209_agreement_repaper.sql（ops sql / Cloud Shell の psql / Cloud SQL Studio 用）
--
--   契約の巻き直し：いまの基本契約・単体契約を、新しい契約で置き換える。
--     ・v3.agreements.replaces_id … この契約が置き換えた旧契約（巻き直しで立てた新契約に入る）
--     ・トリガー … 新契約が「締結済み」になった時点で、旧契約を終了（terminated）にする
--       終了日は新契約の有効開始日（無ければ締結日）。新契約が未締結のあいだ、旧契約は有効のまま。
--       締結の記録は画面・クラウドサインの完了・SQL のどこから入っても同じように効く。
--   旧契約の文書・実績・支払は旧契約に残る。条件明細と下の個別契約を新契約へ引き継ぐかは
--   巻き直すときに選ぶ（アプリの POST /agreements/:id/repaper）。
--
--   208（契約の版）を先に流しておくと、旧契約の終了も版として残る。無くても動く。
--   何度流しても同じ結果。ローカルは docker compose run --rm ops sql /v3/209_agreement_repaper.sql
--   戻すときは 209_agreement_repaper_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.agreements ADD COLUMN IF NOT EXISTS replaces_id bigint REFERENCES v3.agreements(id);
COMMENT ON COLUMN v3.agreements.replaces_id IS
  '巻き直しで置き換えた旧契約。新契約が締結済みになると、旧契約は終了（terminated）になる（agreements_repaper_trg）。';
-- 1 本の旧契約を置き換える新契約は 1 本だけ。
CREATE UNIQUE INDEX IF NOT EXISTS agreements_replaces_uq ON v3.agreements (replaces_id) WHERE replaces_id IS NOT NULL;

CREATE OR REPLACE FUNCTION v3.agreements_repaper_trg() RETURNS trigger
LANGUAGE plpgsql AS $rep$
BEGIN
  IF NEW.replaces_id IS NULL OR NEW.status <> 'executed' THEN RETURN NEW; END IF;
  -- 版（208）に理由を残す。だれが、は呼んだ側が入れていればそのまま。
  PERFORM set_config('lb.reason', '巻き直し：' || COALESCE(NEW.agreement_no, '#' || NEW.id) || ' の締結で置き換え', true);
  UPDATE v3.agreements o
     SET status = 'terminated',
         terminated_on = COALESCE(NEW.effective_on, NEW.executed_on, current_date),
         updated_at = now()
   WHERE o.id = NEW.replaces_id AND o.terminated_on IS NULL;
  RETURN NEW;
END
$rep$;

DROP TRIGGER IF EXISTS agreements_repaper_aiu ON v3.agreements;
CREATE TRIGGER agreements_repaper_aiu AFTER INSERT OR UPDATE OF status, replaces_id ON v3.agreements
  FOR EACH ROW EXECUTE FUNCTION v3.agreements_repaper_trg();

COMMIT;

SELECT column_name AS 列 FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'agreements' AND column_name = 'replaces_id';
SELECT tgname AS トリガー FROM pg_trigger WHERE tgname = 'agreements_repaper_aiu' AND NOT tgisinternal;
