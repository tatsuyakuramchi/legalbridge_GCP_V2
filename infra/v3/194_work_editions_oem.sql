-- =====================================================================
-- 194_work_editions_oem.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   刊行物（193）をボードゲームの製品にも使う（docs/work-editions.md §6）。
--     relation に oem（自社製造・他社販売）を足す。販売元との OEM の条件（OUT）を out_condition_id で指す。
--     isbn の列には JAN（EAN-13・短縮 8 桁）も入る（列名は変えない）。
--
--   193 の後に流す。何度流しても同じ結果。戻すときは 194_work_editions_oem_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.work_editions DROP CONSTRAINT IF EXISTS work_editions_relation_check;
ALTER TABLE v3.work_editions ADD CONSTRAINT work_editions_relation_check
  CHECK (relation IN ('own', 'group', 'sublicense', 'oem'));
COMMENT ON COLUMN v3.work_editions.isbn IS 'ISBN（出版）または JAN（ボードゲーム）。数字だけ。生きた刊行物・製品の間で一意。';
COMMENT ON TABLE v3.work_editions IS
  '作品の刊行物・製品（版元／販売元・ISBN／JAN・刊行日／発売日・本体価格）。relation：own=自社／group=グループ会社（料率なし）／sublicense=再許諾／oem=他社販売（out_condition_id が根拠の OUT 条件）。';

COMMIT;

-- 確かめ：制約に oem がある
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'work_editions_relation_check';
