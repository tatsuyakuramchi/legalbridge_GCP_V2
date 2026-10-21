-- Fix (writes): tie one result (condition_events) to an already issued settlement document.
-- Use when a 検収書 / 役務提供完了通知書 / 計算書 was decided without picking the result,
-- so the result still has document_id NULL and the board keeps saying "作れる".
--
-- Check first with infra\v3\tools\condition_events_check.sql, then pass the ids:
--   Get-Content infra\v3\tools\link_event_to_document.sql -Raw | docker compose -f infra\local\docker-compose.yml exec -T db psql -U postgres -d legalbridge -v ON_ERROR_STOP=1 -v event_id=4167 -v document_id=2088 -f -
--
-- Refuses when the result is already tied to another document, or the document is not issued.

SET search_path = v3, public;

BEGIN;

DO $do$
DECLARE
  ev record;
  doc record;
BEGIN
  SELECT id, condition_id, document_id, status INTO ev FROM condition_events WHERE id = :event_id;
  IF ev.id IS NULL THEN RAISE EXCEPTION 'event % not found', :event_id; END IF;
  IF ev.status <> 'active' THEN RAISE EXCEPTION 'event % is %', :event_id, ev.status; END IF;
  IF ev.document_id IS NOT NULL AND ev.document_id <> :document_id THEN
    RAISE EXCEPTION 'event % is already tied to document %', :event_id, ev.document_id;
  END IF;
  SELECT d.id, d.status, d.document_no INTO doc FROM documents d WHERE d.id = :document_id;
  IF doc.id IS NULL THEN RAISE EXCEPTION 'document % not found', :document_id; END IF;
  IF doc.status <> 'issued' THEN RAISE EXCEPTION 'document % is %, not issued', doc.document_no, doc.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = :document_id AND dc.condition_id = ev.condition_id) THEN
    RAISE EXCEPTION 'document % is not on condition %', doc.document_no, ev.condition_id;
  END IF;

  UPDATE condition_events SET document_id = :document_id WHERE id = :event_id;
  INSERT INTO audit_events (actor, action, target_type, target_id, detail)
  VALUES ('tool:link_event_to_document', 'condition_event.link_document', 'condition_event', :event_id,
          jsonb_build_object('documentId', :document_id, 'documentNo', doc.document_no));
  RAISE NOTICE 'event % tied to document %', :event_id, doc.document_no;
END $do$;

COMMIT;

SELECT e.id AS event_id, e.document_id, d.document_no FROM condition_events e LEFT JOIN documents d ON d.id = e.document_id WHERE e.id = :event_id;
