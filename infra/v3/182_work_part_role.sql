-- =====================================================================
-- 182_work_part_role.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-078：作品の構成要素（work_parts）の役割：コアロジック／サブコンポーネント。
--
--   ゲームでは原作のゲームデザインがコア、追加のイラスト等がサブ。出版では原稿がコア、
--   イラスト・装丁等がサブ。これまで役割は素材の種別（part_type）から読んでいて（102）、
--   出版の素材には読める種別が無かった。part_role に明示で持ち、空なら種別から導く
--   （core/part-role.ts：game_design・text はコア、それ以外はサブ）。
--   業務委託フォームの受注者帰属の行は構成要素を持ち、利用許諾条件は 作品 × パート × 利用形態 で立つ。
--
--   何度流しても同じ。既存の行は game_design だけ core を入れる（他は導出のまま）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.work_parts ADD COLUMN IF NOT EXISTS part_role text;
DO $a078$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.work_parts'::regclass AND conname = 'work_parts_part_role_chk') THEN
    ALTER TABLE v3.work_parts ADD CONSTRAINT work_parts_part_role_chk
      CHECK (part_role IS NULL OR part_role IN ('core', 'sub'));
  END IF;
END $a078$;
COMMENT ON COLUMN v3.work_parts.part_role IS
  '役割（core=コアロジック / sub=サブコンポーネント）。空なら種別から導く（game_design・text はコア）。A-078';

UPDATE v3.work_parts SET part_role = 'core' WHERE part_role IS NULL AND part_type = 'game_design';

COMMIT;

-- 確認
SELECT count(*) AS 列 FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='work_parts' AND column_name = 'part_role';
