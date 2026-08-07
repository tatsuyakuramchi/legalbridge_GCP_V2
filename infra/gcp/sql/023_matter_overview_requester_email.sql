\set ON_ERROR_STOP on
\pset pager off

-- 023_matter_overview_requester_email.sql
-- gap ⑥：matter_overview_v に依頼者メール（requester_email）を露出する。
--   V2 の mapSummary は requester_email → created_by → requester の順で読む。
--   スライス5-3 で「全メールを null 化する正規表現バグ」は修正済みのため、
--   ビューが依頼者メールを実際に露出すれば Slack 候補フローの宛先解決が機能する。
--
--   派生元：matters.created_by（V1 では x-user-email＝案件作成者＝依頼者のメールが入る）。
--   非メール値（staff_name / slack_id 等）は V2 の optionalEmail が null 化するため安全。
--
--   本体の SELECT は V1 migration 0126（matter_overview_v の最新定義）を**逐語再現**し、
--   末尾に requester_email を1列追加する（CREATE OR REPLACE VIEW は末尾追加のみ可）。
--
--   ⚠ 適用前提：021_matter_overview_requester_introspect.sql を実行し、本番の現行定義が
--     下記（0126 由来）と一致することを確認すること。ドリフトしている場合は既存列を
--     壊さないよう、実定義に合わせて本 SELECT を差し替えてから適用する。

\if :{?confirm_matter_overview_requester}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_matter_overview_requester=EXTEND_PRODUCTION_MATTER_OVERVIEW_REQUESTER'
  \quit 2
\endif

SELECT :'confirm_matter_overview_requester' = 'EXTEND_PRODUCTION_MATTER_OVERVIEW_REQUESTER' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; the view was not changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.matter_overview_v') IS NULL THEN
    RAISE EXCEPTION 'View public.matter_overview_v is missing';
  END IF;
END
$guard$;

-- 既存列の順序・型・名前は一切変えず、末尾に requester_email を追加する。
CREATE OR REPLACE VIEW matter_overview_v AS
SELECT
  m.id,
  m.matter_code,
  m.title,
  m.status,
  m.vendor_id,
  m.counterparty,
  m.primary_issue_key,
  m.created_at,
  m.updated_at,
  COALESCE(iss.issue_count, 0)::int      AS issue_count,
  COALESCE(doc.document_count, 0)::int   AS document_count,
  COALESCE(doc.condition_count, 0)::int  AS condition_count,
  snd.last_sent_at,
  m.lifecycle_stage,
  m.owner_staff_id,
  os.staff_name                          AS owner_name,
  m.target_due_date,
  m.blocked_reason,
  m.completed_at,
  nx.id                                  AS next_task_id,
  nx.title                               AS next_task_title,
  nx.due_at                              AS next_task_due_at,
  nx.status                              AS next_task_status,
  nx.blocked_reason                      AS next_task_blocked_reason,
  ns.staff_name                          AS next_task_assignee_name,
  COALESCE(tsk.open_task_count, 0)::int  AS open_task_count,
  -- 追加：依頼者メール（案件作成者。非メールは V2 側で null 扱い）
  m.created_by                           AS requester_email
FROM matters m
LEFT JOIN (
  SELECT matter_id, COUNT(*)::int AS issue_count
    FROM matter_issues GROUP BY matter_id
) iss ON iss.matter_id = m.id
LEFT JOIN (
  SELECT d.matter_id,
         COUNT(DISTINCT d.id)::int  AS document_count,
         COUNT(cl.id)::int          AS condition_count
    FROM documents d
    LEFT JOIN condition_lines cl ON cl.document_id = d.id
   WHERE d.matter_id IS NOT NULL
   GROUP BY d.matter_id
) doc ON doc.matter_id = m.id
LEFT JOIN (
  SELECT matter_id, MAX(sent_at) AS last_sent_at
    FROM document_sends WHERE matter_id IS NOT NULL GROUP BY matter_id
) snd ON snd.matter_id = m.id
LEFT JOIN staff os ON os.id = m.owner_staff_id
LEFT JOIN matter_tasks nx
  ON nx.matter_id = m.id AND nx.is_primary AND nx.status IN ('open','in_progress')
LEFT JOIN staff ns ON ns.id = nx.assignee_staff_id
LEFT JOIN (
  SELECT matter_id, COUNT(*)::int AS open_task_count
    FROM matter_tasks WHERE status IN ('open','in_progress') GROUP BY matter_id
) tsk ON tsk.matter_id = m.id;

-- ビュー再作成で権限は保持されるが、明示的に再付与（V2 runtime の読取）。
GRANT SELECT ON public.matter_overview_v TO legalbridge_v2_runtime;

COMMIT;
