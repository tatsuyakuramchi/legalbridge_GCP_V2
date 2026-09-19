-- =====================================================================
-- 発注書などの「決済しない文書」に結びついてしまった実績を解放する
--
--   実績（納品・検収・売上）の出どころは発注書だが、実績に基づいて作るのは
--   検収書・納品書・利用許諾料計算書で、実績が結びつく（document_id を持つ）のは
--   その決済文書だけ。これまでは実績を選んで発注書を作ると発注書が実績を占有し、
--   本来の検収書が「別の文書に結びついている」と弾かれて作れなかった。
--   アプリは 232ac31 以降、決済文書のときだけ結ぶ。ここは過去のぶんを外す。
--
--   外すのは document_id だけ。文書も実績も消えない。監査に残す。
--   何度流しても同じ結果（対象が無ければ 0 件）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/121_release_events_from_orders.sql
-- =====================================================================
\pset pager off

-- 1. 対象（読むだけ）
SELECT e.id AS 実績, e.condition_id AS 条件, c.condition_no AS 条件番号, e.occurred_on AS 発生日,
       e.amount AS 実額, d.document_no AS 結びついた文書, t.template_key AS ひな形
  FROM v3.condition_events e
  JOIN v3.documents d ON d.id = e.document_id
  JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  JOIN v3.document_templates t ON t.id = tv.template_id
  JOIN v3.conditions c ON c.id = e.condition_id
 WHERE t.template_key !~ '(inspection|acceptance|delivery|statement|royalty)'
 ORDER BY e.id;

-- 2. 外す（監査つき）
BEGIN;
WITH released AS (
  UPDATE v3.condition_events e
     SET document_id = NULL
    FROM v3.documents d
    JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
    JOIN v3.document_templates t ON t.id = tv.template_id
   WHERE d.id = e.document_id
     AND t.template_key !~ '(inspection|acceptance|delivery|statement|royalty)'
  RETURNING e.id AS event_id, e.condition_id, d.id AS document_id, d.document_no, t.template_key
)
INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
SELECT 'migration', 'condition.unlink_document', 'condition', r.condition_id,
       jsonb_build_object('documentId', r.document_id, 'documentNo', r.document_no,
                          'eventIds', jsonb_build_array(r.event_id), 'unlinked', 1,
                          'reason', '121: 決済しない文書（' || r.template_key || '）は実績を占有しない')
  FROM released r;
COMMIT;

-- 3. 残っていないことを確かめる（0 行が正）
SELECT count(*) AS 決済しない文書に結びついた実績
  FROM v3.condition_events e
  JOIN v3.documents d ON d.id = e.document_id
  JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE t.template_key !~ '(inspection|acceptance|delivery|statement|royalty)';
