-- =====================================================================
-- 199_condition_archived.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   過去分の条件を「追跡しない完了」で閉じる（マップの「過去分として完了」）。
--
--   これまで人が閉じる口は 1 つ（完了扱い：closed_at・closed_reason。V2 で支払済み など）。
--   過去の検収・支払を V3 で追いきれない条件をまとめて閉じたいが、「払い終えたことを確かめて閉じた」
--   完了扱いと混ざると、後から見て払ったのか追うのをやめたのかが分からない。
--     conditions.closed_kind … NULL＝完了扱い（従来どおり）、'archived'＝過去分（追跡しない）
--   閉じた日時・理由・閉じた人は従来の closed_at・closed_reason・closed_by に入る。
--   取り消し（reopen）で closed_kind も空に戻る。
--
--   アプリはこの列が無くても動く（読むときは無い列を NULL として読む）。「過去分として完了」の
--   ボタンだけ、この列が無いと「199 を先に流してください」と断る。
--
--   何度流しても同じ結果。戻すときは 199_condition_archived_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS closed_kind text;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_closed_kind_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_closed_kind_chk
      CHECK (closed_kind IS NULL OR (closed_kind = 'archived' AND closed_at IS NOT NULL));
  END IF;
END
$chk$;
COMMENT ON COLUMN v3.conditions.closed_kind IS
  '閉じた種類。NULL＝完了扱い（払い終えたことを確かめて閉じた）、archived＝過去分（検収・支払を V3 で追わないと決めて閉じた）。';

COMMIT;

-- 確かめ：列と制約がある
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'conditions' AND column_name = 'closed_kind';
SELECT conname FROM pg_constraint WHERE conname = 'conditions_closed_kind_chk';
