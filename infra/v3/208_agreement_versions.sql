-- =====================================================================
-- 208_agreement_versions.sql（ops sql / Cloud Shell の psql / Cloud SQL Studio 用）
--
--   契約の記録（v3.agreements）に版を持たせ、変更の履歴を残す。
--     これまで契約の記録は 1 行を上書きしていて、締結日・期間・状態・親の契約を直すと
--     前の値は画面から見えなくなっていた（契約のまき直し・更新・訂正）。
--
--   しくみ
--     ・v3.agreement_versions … 契約ごとに第 1 版・第 2 版 … と、その時点の中身（snapshot）を持つ
--     ・v3.agreements のトリガー … 登録・変更・削除のたびに 1 版ぶん書き足す（中身が変わったときだけ）
--       画面からの編集も、文書の決定・締結で自動に動く分も、SQL で直した分も同じように残る
--     ・だれが・なぜ … アプリが変更の前に lb.actor／lb.reason を入れる（入っていなければ空＝自動）
--     ・いまある契約 … 第 1 版として、流した時点の中身を入れる（ここから履歴を取り始める）
--   契約の記録そのもの（番号・条件・文書のつながり）は変えない。追記だけの表。
--
--   何度流しても同じ結果。ローカルは docker compose run --rm ops sql /v3/208_agreement_versions.sql
--   戻すときは 208_agreement_versions_rollback.sql（履歴の表ごと消える）。
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TABLE IF NOT EXISTS v3.agreement_versions (
  id             bigserial PRIMARY KEY,
  -- 契約を消しても履歴は残す（外部キーにしない）。
  agreement_id   bigint NOT NULL,
  version_no     integer NOT NULL,
  -- baseline 履歴を取り始めた時点／created 登録／changed 変更／deleted 削除
  change_kind    text NOT NULL CHECK (change_kind IN ('baseline', 'created', 'changed', 'deleted')),
  -- その版の中身（agreements の行。created_at・updated_at は除く）。deleted は消す直前の中身。
  snapshot       jsonb NOT NULL,
  -- 前の版から変わった列の名前。
  changed_fields text[] NOT NULL DEFAULT '{}',
  changed_by     text,
  reason         text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, version_no)
);
COMMENT ON TABLE v3.agreement_versions IS
  '契約の記録の版。agreements の登録・変更・削除のたびにトリガーが 1 行足す（追記だけ）。snapshot はその版の中身。';

CREATE OR REPLACE FUNCTION v3.agreements_version_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = v3, pg_temp AS $ver$
DECLARE
  v_old   jsonb;
  v_new   jsonb;
  v_next  integer;
  v_by    text := NULLIF(current_setting('lb.actor', true), '');
  v_why   text := NULLIF(current_setting('lb.reason', true), '');
  v_keys  text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO v3.agreement_versions (agreement_id, version_no, change_kind, snapshot, changed_by, reason)
    VALUES (NEW.id, 1, 'created', to_jsonb(NEW) - 'created_at' - 'updated_at', v_by, v_why)
    ON CONFLICT (agreement_id, version_no) DO NOTHING;
    RETURN NEW;
  END IF;

  v_old := to_jsonb(OLD) - 'created_at' - 'updated_at';
  SELECT COALESCE(max(version_no), 0) INTO v_next FROM v3.agreement_versions WHERE agreement_id = OLD.id;
  -- 履歴を取り始める前からある契約は、変わる前の中身を第 1 版として先に残す。
  IF v_next = 0 THEN
    INSERT INTO v3.agreement_versions (agreement_id, version_no, change_kind, snapshot, changed_at, reason)
    VALUES (OLD.id, 1, 'baseline', v_old, COALESCE(OLD.updated_at, OLD.created_at, now()), '履歴を取り始めた時点の内容');
    v_next := 1;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO v3.agreement_versions (agreement_id, version_no, change_kind, snapshot, changed_by, reason)
    VALUES (OLD.id, v_next + 1, 'deleted', v_old, v_by, v_why);
    RETURN OLD;
  END IF;

  v_new := to_jsonb(NEW) - 'created_at' - 'updated_at';
  IF v_new = v_old THEN RETURN NEW; END IF;
  SELECT COALESCE(array_agg(k ORDER BY k), '{}') INTO v_keys
    FROM (SELECT key AS k FROM jsonb_each(v_new) n WHERE n.value IS DISTINCT FROM v_old -> n.key) x;
  INSERT INTO v3.agreement_versions (agreement_id, version_no, change_kind, snapshot, changed_fields, changed_by, reason)
  VALUES (NEW.id, v_next + 1, 'changed', v_new, v_keys, v_by, v_why);
  RETURN NEW;
END
$ver$;

DROP TRIGGER IF EXISTS agreements_version_aiud ON v3.agreements;
CREATE TRIGGER agreements_version_aiud AFTER INSERT OR UPDATE OR DELETE ON v3.agreements
  FOR EACH ROW EXECUTE FUNCTION v3.agreements_version_trg();

-- いまある契約：流した時点の中身を第 1 版に。
INSERT INTO v3.agreement_versions (agreement_id, version_no, change_kind, snapshot, changed_at, reason)
SELECT a.id, 1, 'baseline', to_jsonb(a) - 'created_at' - 'updated_at',
       COALESCE(a.updated_at, a.created_at, now()), '履歴を取り始めた時点の内容'
  FROM v3.agreements a
 WHERE NOT EXISTS (SELECT 1 FROM v3.agreement_versions v WHERE v.agreement_id = a.id);

-- アプリのロールには読むことだけ（書くのはトリガー）。ロールが無い環境（手元の検証）は飛ばす。
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v3_runtime') THEN
    GRANT SELECT ON v3.agreement_versions TO legalbridge_v3_runtime;
  END IF;
END
$grant$;

COMMIT;

SELECT count(DISTINCT agreement_id) AS 契約, count(*) AS 版の行,
       count(*) FILTER (WHERE change_kind = 'baseline') AS うち取り始めの版
  FROM v3.agreement_versions;
SELECT tgname AS トリガー FROM pg_trigger WHERE tgname = 'agreements_version_aiud' AND NOT tgisinternal;
