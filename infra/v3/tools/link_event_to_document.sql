-- Fix (writes): tie one result (condition_events) to an already issued settlement document.
-- Use when a 検収書 / 役務提供完了通知書 / 計算書 was decided without picking the result,
-- so the result still has document_id NULL and the board keeps saying "作れる".
--
-- Check first with infra\v3\tools\condition_events_check.sql, then pass the ids:
--   Get-Content infra\v3\tools\link_event_to_document.sql -Raw | docker compose -f infra\local\docker-compose.yml exec -T db psql -U postgres -d legalbridge -v ON_ERROR_STOP=1 -v event_id=4167 -v document_id=2088 -f -
--
-- Refuses when the result is already tied to another document, or the document is not issued.

SET search_path = v3, public;
-- psql variables are not expanded inside DO blocks, so pass them through session settings.
SELECT set_config('lb.event_id', :'event_id', false), set_config('lb.document_id', :'document_id', false);

BEGIN;

DO $do$
DECLARE
  ev record;
  doc record;
  v_event bigint := current_setting('lb.event_id')::bigint;
  v_doc bigint := current_setting('lb.document_id')::bigint;
BEGIN
  SELECT id, condition_id, document_id, status INTO ev FROM condition_events WHERE id = v_event;
  IF ev.id IS NULL THEN RAISE EXCEPTION 'event % not found', v_event; END IF;
  IF ev.status <> 'active' THEN RAISE EXCEPTION 'event % is %', v_event, ev.status; END IF;
  IF ev.document_id IS NOT NULL AND ev.document_id <> v_doc THEN
    RAISE EXCEPTION 'event % is already tied to document %', v_event, ev.document_id;
  END IF;
  SELECT d.id, d.status, d.document_no INTO doc FROM documents d WHERE d.id = v_doc;
  IF doc.id IS NULL THEN RAISE EXCEPTION 'document % not found', v_doc; END IF;
  IF doc.status <> 'issued' THEN RAISE EXCEPTION 'document % is %, not issued', doc.document_no, doc.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = v_doc AND dc.condition_id = ev.condition_id) THEN
    RAISE EXCEPTION 'document % is not on condition %', doc.document_no, ev.condition_id;
  END IF;

  UPDATE condition_events SET document_id = v_doc WHERE id = v_event;
  INSERT INTO audit_events (actor, action, target_type, target_id, detail)
  VALUES ('tool:link_event_to_document', 'condition_event.link_document', 'condition_event', v_event,
          jsonb_build_object('documentId', v_doc, 'documentNo', doc.document_no));
  RAISE NOTICE 'event % tied to document %', v_event, doc.document_no;
END $do$;

COMMIT;

SELECT e.id AS event_id, e.document_id, d.document_no FROM condition_events e LEFT JOIN documents d ON d.id = e.document_id WHERE e.id = current_setting('lb.event_id')::bigint;
