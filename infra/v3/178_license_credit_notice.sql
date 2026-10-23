-- =====================================================================
-- 178_license_credit_notice.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-076：利用許諾条件のクレジット表記。
--
--   受注者帰属の成果物を当社が使うとき（出版・再許諾・自社製造）に表示するクレジット。
--   条件ごとに文言を持つか、作品のクレジット表記（work_credits。A-031）を引用する。
--   引用のときは文書を作る日時点の作品の表記（適用開始日が当日以前で最新の行）を差す。
--
--     conditions.credit_notice     … クレジット表記の文言（引用しないとき、または引用の控え）
--     conditions.credit_from_work  … 作品のクレジット表記を引用する（true なら作品の表記が勝つ）
--
--   何度流しても同じ。データは書き換えない。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS credit_notice text;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS credit_from_work boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN v3.conditions.credit_notice IS
  'クレジット表記（成果物を利用するときの表示。© 2026 著作者名／イラスト：◯◯ など）。許諾条件だけが意味を持つ。A-076';
COMMENT ON COLUMN v3.conditions.credit_from_work IS
  '作品のクレジット表記（work_credits）を引用するか。true なら文書は作品の今の表記を差す。A-076';

COMMIT;

-- 確認
SELECT count(*) AS 列 FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='conditions' AND column_name IN ('credit_notice', 'credit_from_work');
