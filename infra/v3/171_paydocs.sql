-- =====================================================================
-- 171_paydocs.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-074：支払文書（apps/legalbridge-v3/src/server/paydocs/）。
--   中身は 004_amend.sql の A-074 と同じ（004 を流し直すなら、こちらは要らない）。
--
--     v3.document_delivery(id) … 送付・受領・過去分を監査記録から導く関数
--     v3.documents.inbound     … 相手から受け取った文書（送付・受領を追わない）
--     v3.production_plans      … 製造・印刷の予定（手入力＋発注書からの候補）
--     v3.conditions.report_due_days … 締めから報告期限までの日数（空なら 30 日）
--
--   何度流しても同じ。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- A-074 支払文書の送付・受領・過去分、製造予定、報告期限（paydocs/）
--   送付済みかどうかは、これまで画面ごとに gmail.send / cloudsign.send だけを見ていた。
--   CloudSign の画面から送ったもの・郵送・手渡し・別のメールで送ったもの・V1 から移した
--   ものが「未送付」に見えていた。送付と受領を 1 つの関数（document_delivery）で導く。
--     送付：gmail.send / cloudsign.send / cloudsign.applied(sent・executed) / document.sent_manual
--           （document.send_cleared・cloudsign.applied(unsent) で取り消し。新しい方が勝つ）
--     受領：document.received / document.confirmed / cloudsign.applied(executed)
--           （document.receipt_cleared で取り消し）
--     過去分：document.sent_manual の detail.via = 'past'（一括で送付済み扱い）
--   documents.inbound … 相手から受け取った文書（取込）。送付・受領を追わない。
--   production_plans … 製造・印刷の予定（能動の回の記録漏れを防ぐ）。手で入れるか、
--                      印刷・製造の発注書から候補を出して入れる（source='order'）。
--   conditions.report_due_days … 締めから報告期限までの日数。空なら 30 日。
-- ---------------------------------------------------------------------
ALTER TABLE v3.documents ADD COLUMN IF NOT EXISTS inbound boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN v3.documents.inbound IS
  '相手から受け取った文書（取込）。送付・受領を追わない（未送付に数えない）。A-074';

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS report_due_days int;
DO $a074$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_report_due_days_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_report_due_days_chk
      CHECK (report_due_days IS NULL OR (report_due_days >= 0 AND report_due_days <= 366));
  END IF;
END $a074$;
COMMENT ON COLUMN v3.conditions.report_due_days IS
  '締めから報告（売上報告・月次報告）の期限までの日数。空なら 30 日。過ぎたら督促の対象。A-074';

CREATE TABLE IF NOT EXISTS v3.production_plans (
  id                 bigserial PRIMARY KEY,
  condition_id       bigint NOT NULL REFERENCES v3.conditions(id),
  planned_on         date NOT NULL,
  quantity           numeric(14,4),
  label              text,
  note               text,
  source             text NOT NULL DEFAULT 'manual',
  source_document_id bigint REFERENCES v3.documents(id),
  status             text NOT NULL DEFAULT 'open',
  event_id           bigint REFERENCES v3.condition_events(id),
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT production_plans_source_chk CHECK (source IN ('manual', 'order')),
  CONSTRAINT production_plans_status_chk CHECK (status IN ('open', 'done', 'dropped'))
);
CREATE INDEX IF NOT EXISTS production_plans_condition_idx ON v3.production_plans (condition_id, planned_on);
CREATE UNIQUE INDEX IF NOT EXISTS production_plans_order_uq
  ON v3.production_plans (condition_id, source_document_id) WHERE source_document_id IS NOT NULL;
COMMENT ON TABLE v3.production_plans IS
  '製造・印刷の予定。実績（製造）が入ったら done（event_id）。取りやめは dropped。A-074';
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.production_plans TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.production_plans_id_seq TO legalbridge_v3_runtime;

CREATE OR REPLACE FUNCTION v3.document_delivery(p_document_id bigint)
RETURNS TABLE (sent_at timestamptz, sent_via text, received_at timestamptz, received_via text, past boolean)
LANGUAGE sql STABLE AS $fn$
  WITH ev AS (
    SELECT a.id, a.occurred_at, a.action, a.detail,
           CASE
             WHEN a.action IN ('gmail.send', 'cloudsign.send', 'document.sent_manual') THEN 'sent'
             WHEN a.action = 'cloudsign.applied' AND a.detail->>'status' IN ('sent', 'executed') THEN 'sent'
             WHEN a.action = 'document.send_cleared' THEN 'unsent'
             WHEN a.action = 'cloudsign.applied' AND a.detail->>'status' = 'unsent' THEN 'unsent'
           END AS send_kind,
           CASE
             WHEN a.action IN ('document.received', 'document.confirmed') THEN 'received'
             WHEN a.action = 'cloudsign.applied' AND a.detail->>'status' = 'executed' THEN 'received'
             WHEN a.action = 'document.receipt_cleared' THEN 'unreceived'
           END AS recv_kind
      FROM v3.audit_events a
     WHERE a.target_type = 'document' AND a.target_id = p_document_id
       AND a.action IN ('gmail.send', 'cloudsign.send', 'cloudsign.applied', 'document.sent_manual',
                        'document.send_cleared', 'document.received', 'document.confirmed', 'document.receipt_cleared')
  ),
  s AS (SELECT * FROM ev WHERE send_kind IS NOT NULL ORDER BY occurred_at DESC, id DESC LIMIT 1),
  r AS (SELECT * FROM ev WHERE recv_kind IS NOT NULL ORDER BY occurred_at DESC, id DESC LIMIT 1)
  SELECT CASE WHEN s.send_kind = 'sent' THEN s.occurred_at END,
         CASE WHEN s.send_kind <> 'sent' OR s.send_kind IS NULL THEN NULL
              WHEN s.action = 'gmail.send' THEN 'gmail'
              WHEN s.action IN ('cloudsign.send', 'cloudsign.applied') THEN 'cloudsign'
              ELSE COALESCE(NULLIF(s.detail->>'via', ''), 'other') END,
         CASE WHEN r.recv_kind = 'received' THEN r.occurred_at END,
         CASE WHEN r.recv_kind IS DISTINCT FROM 'received' THEN NULL
              WHEN r.action = 'cloudsign.applied' THEN 'cloudsign'
              WHEN r.action = 'document.confirmed' THEN 'confirmed'
              ELSE COALESCE(NULLIF(r.detail->>'via', ''), 'other') END,
         COALESCE(s.send_kind = 'sent' AND s.action = 'document.sent_manual' AND s.detail->>'via' = 'past', false)
    FROM (SELECT 1) one
    LEFT JOIN s ON true
    LEFT JOIN r ON true
$fn$;
COMMENT ON FUNCTION v3.document_delivery(bigint) IS
  '文書の送付・受領（監査記録から導く。新しい記録が勝つ）。sent_via: gmail / cloudsign / post / hand / email_other / past / other。A-074';
GRANT EXECUTE ON FUNCTION v3.document_delivery(bigint) TO legalbridge_v3_runtime;

COMMIT;

-- 確認（列 2・表 1・関数 1・CHECK 1 で 5 であること）
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='v3'
         AND ((table_name='documents' AND column_name='inbound') OR (table_name='conditions' AND column_name='report_due_days')))
     + (SELECT count(*) FROM information_schema.tables WHERE table_schema='v3' AND table_name='production_plans')
     + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname='v3' AND p.proname='document_delivery')
     + (SELECT count(*) FROM pg_constraint WHERE conrelid='v3.conditions'::regclass AND conname='conditions_report_due_days_chk') AS 列と表と関数;
