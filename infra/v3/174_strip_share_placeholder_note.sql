-- 174: strip the import placeholder wording from condition notes.
--
-- Imported share conditions carry the note
--   "相手先（代表）は取り分最大の者を仮置き"
-- (the representative party was provisionally set to the largest share holder).
-- It was an import aid, not a contract term, but it prints in the 備考 column of
-- 出版等利用許諾条件書. Remove it (and a leading "／" separator) from conditions.notes.
--
-- Japanese inside statements is written with \u escapes so the file survives PowerShell re-encoding.
-- Run: Get-Content infra\v3\174_strip_share_placeholder_note.sql -Raw | docker compose -f infra\local\docker-compose.yml exec -T db psql -U postgres -d legalbridge -v ON_ERROR_STOP=1 -f -
-- Cloud SQL Studio: paste as is (no \set lines in this file).

SET search_path = v3, public;

BEGIN;

CREATE TEMP TABLE _placeholder_fix AS
SELECT c.id, c.notes AS before_notes,
       NULLIF(btrim(regexp_replace(
         c.notes,
         E'[\uff0f/]?\\s*\u76f8\u624b\u5148\uff08\u4ee3\u8868\uff09\u306f\u53d6\u308a\u5206\u6700\u5927\u306e\u8005\u3092\u4eee\u7f6e\u304d\\s*',
         '', 'g'), E' \uff0f/\u3000'), '') AS after_notes
  FROM conditions c
 WHERE c.notes LIKE E'%\u53d6\u308a\u5206\u6700\u5927\u306e\u8005\u3092\u4eee\u7f6e\u304d%';

UPDATE conditions c
   SET notes = f.after_notes, updated_at = now()
  FROM _placeholder_fix f
 WHERE c.id = f.id;

INSERT INTO audit_events (actor, action, target_type, target_id, detail)
SELECT 'migration:174', 'condition.note_cleanup', 'condition', f.id,
       jsonb_build_object('before', f.before_notes, 'after', f.after_notes)
  FROM _placeholder_fix f;

COMMIT;

SELECT count(*) AS cleaned FROM _placeholder_fix;
