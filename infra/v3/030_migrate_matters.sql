-- =====================================================================
-- V3移行 030：案件・タスク・リンク
--   案件は文書より先に移す（documents.matter_id を解決するため）。
--   フロー種別は matter_kind を手がかりにしつつ、実データ（紐づく条件）から決める。
--   実行: psql "$ADMIN_DSN" -f infra/v3/030_migrate_matters.sql（020 の後）
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- 案件
--   kind は制御列なので、名乗り（matter_kind）より実データを優先する。
--     ライセンス条件がぶら下がる         → work
--     条件はあるがライセンスではない     → outsourcing
--     条件が1件も無い                    → single
-- ---------------------------------------------------------------------
INSERT INTO v3.matters (matter_no, title, kind, status, owner_staff_id, counterparty_id,
                        due_on, blocked_reason, remarks, drive_folder_url,
                        legacy_id, created_by, created_at, closed_at)
SELECT
  NULLIF(m.matter_code, ''),
  COALESCE(NULLIF(m.title, ''), NULLIF(m.matter_code, ''), '（無題の案件）'),
  CASE
    WHEN EXISTS (SELECT 1 FROM public.documents d
                   JOIN public.condition_lines cl ON cl.document_id = d.id
                  WHERE d.matter_id = m.id AND cl.transaction_kind = 'license') THEN 'work'
    WHEN m.matter_kind IN ('license', 'work', 'ライセンス')                      THEN 'work'
    WHEN EXISTS (SELECT 1 FROM public.documents d
                   JOIN public.condition_lines cl ON cl.document_id = d.id
                  WHERE d.matter_id = m.id)                                      THEN 'outsourcing'
    WHEN m.matter_kind IN ('service', 'outsourcing', '業務委託')                 THEN 'outsourcing'
    ELSE 'single'
  END,
  CASE
    WHEN m.completed_at IS NOT NULL                       THEN 'done'
    WHEN m.status IN ('done', 'completed', '完了')         THEN 'done'
    WHEN m.status IN ('canceled', 'cancelled', '中止')     THEN 'canceled'
    WHEN NULLIF(m.blocked_reason, '') IS NOT NULL          THEN 'blocked'
    WHEN m.status IN ('waiting', '待ち', '回答待ち')        THEN 'waiting'
    ELSE 'open'
  END,
  st.id, pt.id,
  m.target_due_date,
  NULLIF(m.blocked_reason, ''), NULLIF(m.remarks, ''), NULLIF(m.drive_folder_url, ''),
  m.id, NULLIF(m.created_by, ''), COALESCE(m.created_at, now()), m.completed_at
FROM public.matters m
LEFT JOIN v3.staff   st ON st.legacy_id = m.owner_staff_id
LEFT JOIN v3.parties pt ON pt.legacy_id = m.vendor_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  matter_no = EXCLUDED.matter_no, title = EXCLUDED.title, kind = EXCLUDED.kind,
  status = EXCLUDED.status, owner_staff_id = EXCLUDED.owner_staff_id,
  counterparty_id = EXCLUDED.counterparty_id, due_on = EXCLUDED.due_on,
  blocked_reason = EXCLUDED.blocked_reason, remarks = EXCLUDED.remarks,
  drive_folder_url = EXCLUDED.drive_folder_url, closed_at = EXCLUDED.closed_at,
  updated_at = now();

-- 相手先が取引先マスタに無く名前だけ残っている案件は、備考へ退避して情報を落とさない
UPDATE v3.matters nm
   SET remarks = COALESCE(NULLIF(nm.remarks, '') || E'\n', '') || '相手先（未名寄せ）: ' || m.counterparty
  FROM public.matters m
 WHERE nm.legacy_id = m.id
   AND nm.counterparty_id IS NULL
   AND NULLIF(m.counterparty, '') IS NOT NULL
   AND COALESCE(nm.remarks, '') NOT LIKE '%相手先（未名寄せ）%';

-- ---------------------------------------------------------------------
-- タスク
-- ---------------------------------------------------------------------
INSERT INTO v3.tasks (matter_id, title, task_type, assignee_staff_id, due_at, status,
                      blocked_reason, legacy_id)
SELECT nm.id,
       COALESCE(NULLIF(t.title, ''), '（無題のタスク）'),
       NULLIF(t.task_type, ''), st.id, t.due_at,
       CASE
         WHEN t.status IN ('done', 'completed', '完了')      THEN 'done'
         WHEN NULLIF(t.blocked_reason, '') IS NOT NULL       THEN 'blocked'
         WHEN t.status IN ('doing', 'in_progress', '対応中')  THEN 'doing'
         ELSE 'todo'
       END,
       NULLIF(t.blocked_reason, ''), t.id
  FROM public.matter_tasks t
  JOIN v3.matters nm ON nm.legacy_id = t.matter_id
  LEFT JOIN v3.staff st ON st.legacy_id = t.assignee_staff_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  matter_id = EXCLUDED.matter_id, title = EXCLUDED.title,
  assignee_staff_id = EXCLUDED.assignee_staff_id, due_at = EXCLUDED.due_at,
  status = EXCLUDED.status, blocked_reason = EXCLUDED.blocked_reason;

-- ---------------------------------------------------------------------
-- リンク：課題・依頼・条件を1表に集約する
--   文書は 040 で入れる（documents がまだ無いため）。
-- ---------------------------------------------------------------------
INSERT INTO v3.matter_links (matter_id, target_type, target_ref, relation, snapshot)
SELECT nm.id, 'backlog_issue', mi.backlog_issue_key,
       COALESCE(NULLIF(mi.relation, ''), 'related'),
       jsonb_strip_nulls(jsonb_build_object('summary', NULLIF(mi.summary_snapshot, '')))
  FROM public.matter_issues mi
  JOIN v3.matters nm ON nm.legacy_id = mi.matter_id
 WHERE NULLIF(mi.backlog_issue_key, '') IS NOT NULL
ON CONFLICT (matter_id, target_type, target_ref) DO UPDATE SET
  relation = EXCLUDED.relation, snapshot = EXCLUDED.snapshot;

-- 依頼（legal_requests）は案件の起票元。トリガで作られた案件へ課題キーで結ぶ。
INSERT INTO v3.matter_links (matter_id, target_type, target_ref, relation, snapshot)
SELECT nm.id, 'backlog_issue', lr.backlog_issue_key, 'origin',
       jsonb_strip_nulls(jsonb_build_object(
         'summary',  NULLIF(lr.summary, ''),
         'deadline', lr.deadline))
  FROM public.legal_requests lr
  JOIN public.matters m  ON m.primary_issue_key = lr.backlog_issue_key
  JOIN v3.matters nm     ON nm.legacy_id = m.id
 WHERE NULLIF(lr.backlog_issue_key, '') IS NOT NULL
ON CONFLICT (matter_id, target_type, target_ref) DO UPDATE SET
  relation = 'origin', snapshot = EXCLUDED.snapshot;

-- 条件へのリンク（案件から条件を辿れるようにする）
INSERT INTO v3.matter_links (matter_id, target_type, target_ref, relation)
SELECT DISTINCT nm.id, 'condition', nc.id::text, 'related'
  FROM public.condition_lines cl
  JOIN public.documents d ON d.id = cl.document_id
  JOIN v3.matters nm      ON nm.legacy_id = d.matter_id
  JOIN v3.conditions nc   ON nc.legacy_id = cl.id
ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING;

COMMIT;
