-- =====================================================================
-- 173_terms_agreement_numbers.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   条件書を決定したときに自動で立った個別契約・単体契約の番号を、条件書の番号にそろえる。
--   いままでは 親番号-S01 ／ ARC-ILT-xxxx で採番していたので、取引先⇔基本契約 の図で
--   契約と紙の番号が食い違って見えた（agreements/auto.ts は今後、条件書の番号で立てる）。
--
--   対象：kind が supplement か standalone で、番号が -S<2桁> か ARC-ILT- で始まり、
--         条件書（出版条件書・個別利用許諾条件書・取り込んだ利用許諾契約書）が 1 本の番号だけ付いているもの。
--         付け替え先の番号が既に別の契約に使われていれば、そのまま残す。
--   記録：audit_events に agreement.renumber を残す（元の番号を detail に持つ）。
--
--   何度流しても同じ（2 回目は対象が無い）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TEMP TABLE renumber AS
WITH docs AS (
  SELECT d.agreement_id,
         regexp_replace(d.document_no, '-R[0-9]+$', '') AS base_no
    FROM documents d
    JOIN document_template_versions tv ON tv.id = d.template_version_id
    JOIN document_templates t ON t.id = tv.template_id
   WHERE d.agreement_id IS NOT NULL AND d.document_no IS NOT NULL
     AND d.status IN ('draft', 'issued', 'superseded')
     AND (t.template_key IN ('individual_license_terms_v3', 'individual_license_terms_v4',
                             'pub_license_terms_v3', 'pub_license_terms_v3_annex')
          OR d.manual_inputs->>'documentKind' = '利用許諾契約書')
), one AS (
  SELECT agreement_id, min(base_no) AS base_no
    FROM docs GROUP BY agreement_id HAVING count(DISTINCT base_no) = 1
)
SELECT a.id, a.agreement_no AS old_no, o.base_no AS new_no
  FROM agreements a JOIN one o ON o.agreement_id = a.id
 WHERE a.kind IN ('supplement', 'standalone')
   AND (a.agreement_no ~ '-S[0-9]{2}$' OR a.agreement_no LIKE 'ARC-ILT-%')
   AND a.agreement_no IS DISTINCT FROM o.base_no
   AND NOT EXISTS (SELECT 1 FROM agreements x WHERE x.agreement_no = o.base_no);

UPDATE agreements a SET agreement_no = r.new_no, updated_at = now()
  FROM renumber r WHERE a.id = r.id;

INSERT INTO audit_events (actor, action, target_type, target_id, detail, occurred_at)
SELECT 'system', 'agreement.renumber', 'agreement', r.id,
       jsonb_build_object('from', r.old_no, 'to', r.new_no, 'reason', '条件書の番号にそろえる（173）'), now()
  FROM renumber r;

\echo '--- 付け替えた個別契約・単体契約 ---'
SELECT old_no, new_no FROM renumber ORDER BY new_no;

COMMIT;
