-- 080_matter_kind.sql
-- 案件を「レビュー / 法務相談 / ライセンス / 業務委託」等に分類し、画面から編集できるようにする。
-- 既存案件は誤分類を避けて unclassified（未分類）とし、利用者が画面で確定する。
-- Cloud SQL Studio に全文を貼り付けて実行可能（psql 専用メタコマンドなし）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.matters') IS NULL OR to_regclass('public.matter_overview_v') IS NULL THEN
    RAISE EXCEPTION 'Required relation matters or matter_overview_v is missing';
  END IF;
END
$guard$;

ALTER TABLE public.matters
  ADD COLUMN IF NOT EXISTS matter_kind text NOT NULL DEFAULT 'unclassified';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.matters'::regclass
       AND conname = 'matters_matter_kind_check'
  ) THEN
    ALTER TABLE public.matters ADD CONSTRAINT matters_matter_kind_check CHECK (
      matter_kind IN (
        'unclassified','contract_review','legal_consultation','license','service',
        'sales_purchase','nda','document_creation','other'
      )
    );
  END IF;
END
$constraint$;

-- 023 の現行ビュー定義を維持し、末尾に matter_kind を追加する。
CREATE OR REPLACE VIEW public.matter_overview_v AS
SELECT
  m.id, m.matter_code, m.title, m.status, m.vendor_id, m.counterparty,
  m.primary_issue_key, m.created_at, m.updated_at,
  COALESCE(iss.issue_count, 0)::int AS issue_count,
  COALESCE(doc.document_count, 0)::int AS document_count,
  COALESCE(doc.condition_count, 0)::int AS condition_count,
  snd.last_sent_at, m.lifecycle_stage, m.owner_staff_id,
  os.staff_name AS owner_name, m.target_due_date, m.blocked_reason, m.completed_at,
  nx.id AS next_task_id, nx.title AS next_task_title, nx.due_at AS next_task_due_at,
  nx.status AS next_task_status, nx.blocked_reason AS next_task_blocked_reason,
  ns.staff_name AS next_task_assignee_name,
  COALESCE(tsk.open_task_count, 0)::int AS open_task_count,
  m.created_by AS requester_email,
  m.matter_kind
FROM public.matters m
LEFT JOIN (
  SELECT matter_id, COUNT(*)::int AS issue_count FROM public.matter_issues GROUP BY matter_id
) iss ON iss.matter_id = m.id
LEFT JOIN (
  SELECT d.matter_id, COUNT(DISTINCT d.id)::int AS document_count, COUNT(cl.id)::int AS condition_count
    FROM public.documents d LEFT JOIN public.condition_lines cl ON cl.document_id = d.id
   WHERE d.matter_id IS NOT NULL GROUP BY d.matter_id
) doc ON doc.matter_id = m.id
LEFT JOIN (
  SELECT matter_id, MAX(sent_at) AS last_sent_at FROM public.document_sends
   WHERE matter_id IS NOT NULL GROUP BY matter_id
) snd ON snd.matter_id = m.id
LEFT JOIN public.staff os ON os.id = m.owner_staff_id
LEFT JOIN public.matter_tasks nx
  ON nx.matter_id = m.id AND nx.is_primary AND nx.status IN ('open','in_progress')
LEFT JOIN public.staff ns ON ns.id = nx.assignee_staff_id
LEFT JOIN (
  SELECT matter_id, COUNT(*)::int AS open_task_count FROM public.matter_tasks
   WHERE status IN ('open','in_progress') GROUP BY matter_id
) tsk ON tsk.matter_id = m.id;

GRANT SELECT ON public.matter_overview_v TO legalbridge_v2_runtime;

COMMIT;

SELECT matter_kind, COUNT(*) AS matters
  FROM public.matters GROUP BY matter_kind ORDER BY matter_kind;
