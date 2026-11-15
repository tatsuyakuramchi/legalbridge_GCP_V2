-- =====================================================================
-- 210_event_stores.sql（ops sql / Cloud Shell の psql / Cloud SQL Studio 用）
--
--   店舗イベント審判業務の発注書を作るための店舗マスタ。
--     ・v3.event_stores       … イベントを開く店舗（発注書の「場所」と、品目名に入る略称）
--     ・v3.event_store_judges … 店舗ごとに審判業務をお願いする取引先と、その既定額
--                               （委託料・交通費。どちらも税込。作成画面の初期値で、毎回直せる）
--     ・v3.event_judge_settings … 人ごとの基本契約の扱い（自動／この契約／なし）
--   取引先そのもの（住所・振込先・登録番号・メール）は v3.parties のものを使う。ここは持たない。
--   既存の表は変えない。足すだけ。
--
--   何度流しても同じ結果。ローカルは docker compose run --rm ops sql /v3/210_event_stores.sql
--   戻すときは 210_event_stores_rollback.sql（3 つの表ごと消える）。
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TABLE IF NOT EXISTS v3.event_stores (
  id          bigserial PRIMARY KEY,
  -- 発注書の「場所：」に出る名前（ホビーステーション大宮店）。
  name        text NOT NULL,
  -- 品目名「審判業務（2026/11/29‗HBST大宮）」の略称。
  short_name  text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS event_stores_name_uq ON v3.event_stores (name);
COMMENT ON TABLE v3.event_stores IS
  '店舗イベント審判業務の店舗。name は発注書の場所、short_name は品目名の略称。';

CREATE TABLE IF NOT EXISTS v3.event_store_judges (
  store_id               bigint NOT NULL REFERENCES v3.event_stores(id) ON DELETE CASCADE,
  party_id               bigint NOT NULL REFERENCES v3.parties(id),
  -- 既定の委託料（税込・1 日あたり）。紙には税抜（切り捨て）で出る。
  default_fee_inc_tax    integer CHECK (default_fee_inc_tax IS NULL OR default_fee_inc_tax >= 0),
  -- 既定の交通費（税込の実費・1 日あたり）。0 か空なら交通費なし。
  default_travel_inc_tax integer CHECK (default_travel_inc_tax IS NULL OR default_travel_inc_tax >= 0),
  sort_order             integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, party_id)
);
CREATE INDEX IF NOT EXISTS event_store_judges_party_idx ON v3.event_store_judges (party_id);
COMMENT ON TABLE v3.event_store_judges IS
  '店舗ごとの審判業務の担当取引先と既定額（税込）。作成画面はここに載る取引先だけを出す。';

-- 人ごとの基本契約の扱い（店舗をまたいで同じ）。行が無ければ auto。
--   auto  … 締結済みの業務委託の基本契約（イン）が 1 本ならそれに載せる。無い・複数なら基本契約なし
--   fixed … agreement_id の契約に載せる
--   none  … 基本契約なし（発注書に標準約款が付く）
CREATE TABLE IF NOT EXISTS v3.event_judge_settings (
  party_id       bigint PRIMARY KEY REFERENCES v3.parties(id),
  agreement_mode text NOT NULL DEFAULT 'auto' CHECK (agreement_mode IN ('auto', 'fixed', 'none')),
  agreement_id   bigint REFERENCES v3.agreements(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (agreement_mode <> 'fixed' OR agreement_id IS NOT NULL)
);
COMMENT ON TABLE v3.event_judge_settings IS
  '店舗イベント審判の人ごとの設定。基本契約の扱い（auto / fixed / none）。';

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legalbridge_v3_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON v3.event_stores, v3.event_store_judges, v3.event_judge_settings
      TO legalbridge_v3_runtime;
    GRANT USAGE, SELECT ON SEQUENCE v3.event_stores_id_seq TO legalbridge_v3_runtime;
  END IF;
END
$grant$;

COMMIT;

-- 確かめ：表がある
SELECT to_regclass('v3.event_stores') AS event_stores, to_regclass('v3.event_store_judges') AS event_store_judges,
       to_regclass('v3.event_judge_settings') AS event_judge_settings;
