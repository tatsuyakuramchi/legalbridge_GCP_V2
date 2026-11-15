-- 210_event_stores.sql を戻す。店舗マスタ（店舗・担当取引先・人ごとの設定）の 3 表を消す。
-- 発注書・条件明細・取引先には触れない（表から参照されていないので、作った発注書はそのまま残る）。
\set ON_ERROR_STOP on
BEGIN;
DROP TABLE IF EXISTS v3.event_judge_settings;
DROP TABLE IF EXISTS v3.event_store_judges;
DROP TABLE IF EXISTS v3.event_stores;
COMMIT;
