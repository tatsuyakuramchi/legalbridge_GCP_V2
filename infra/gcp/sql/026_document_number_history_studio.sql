-- 026_document_number_history_studio.sql
-- LegalBridge V2: preserve document number changes and expose the latest prior number.
-- Idempotent / Cloud SQL Studio compatible.

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.documents is missing';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE IF NOT EXISTS document_number_history (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  previous_document_number text NOT NULL,
  new_document_number text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL DEFAULT current_user,
  source text NOT NULL DEFAULT 'document_update'
);

CREATE INDEX IF NOT EXISTS document_number_history_document_changed_idx
  ON document_number_history (document_id, changed_at DESC, id DESC);

CREATE OR REPLACE FUNCTION capture_document_number_history()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.document_number IS DISTINCT FROM NEW.document_number
     AND NULLIF(BTRIM(COALESCE(OLD.document_number, '')), '') IS NOT NULL
     AND NULLIF(BTRIM(COALESCE(NEW.document_number, '')), '') IS NOT NULL THEN
    INSERT INTO document_number_history (
      document_id, previous_document_number, new_document_number, changed_at, changed_by, source
    ) VALUES (
      NEW.id, OLD.document_number, NEW.document_number, now(), current_user, 'document_update'
    );
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS documents_capture_number_history ON documents;
CREATE TRIGGER documents_capture_number_history
AFTER UPDATE OF document_number ON documents
FOR EACH ROW
EXECUTE FUNCTION capture_document_number_history();

-- Backfill the latest known legacy/base number when it was already preserved in form_data.
INSERT INTO document_number_history (
  document_id, previous_document_number, new_document_number, changed_at, changed_by, source
)
SELECT
  d.id,
  prev.previous_number,
  d.document_number,
  COALESCE(d.created_at, now()),
  COALESCE(d.created_by, current_user),
  'legacy_form_data'
FROM documents d
CROSS JOIN LATERAL (
  SELECT COALESCE(
    NULLIF(BTRIM(d.form_data->>'PREVIOUS_DOCUMENT_NUMBER'), ''),
    NULLIF(BTRIM(d.form_data->>'旧文書番号'), ''),
    NULLIF(BTRIM(d.form_data->>'旧契約書番号'), ''),
    NULLIF(BTRIM(d.form_data->>'BASE_DOC_NO'), ''),
    NULLIF(BTRIM(d.form_data->>'元文書番号'), ''),
    NULLIF(BTRIM(d.form_data->>'元契約番号'), ''),
    NULLIF(BTRIM(d.form_data->>'previousDocumentNumber'), ''),
    NULLIF(BTRIM(d.form_data->>'baseDocumentNumber'), ''),
    NULLIF(BTRIM(d.form_data->>'originalDocumentNumber'), '')
  ) AS previous_number
) prev
WHERE prev.previous_number IS NOT NULL
  AND d.document_number IS NOT NULL
  AND prev.previous_number IS DISTINCT FROM d.document_number
  AND NOT EXISTS (
    SELECT 1
    FROM document_number_history h
    WHERE h.document_id = d.id
      AND h.previous_document_number = prev.previous_number
      AND h.new_document_number = d.document_number
  );

GRANT SELECT, INSERT ON document_number_history TO legalbridge_v2_runtime;
GRANT USAGE, SELECT ON SEQUENCE document_number_history_id_seq TO legalbridge_v2_runtime;

COMMIT;

-- Verification.
SELECT
  COUNT(*) AS history_rows,
  COUNT(DISTINCT document_id) AS documents_with_number_history
FROM document_number_history;

SELECT
  d.id,
  d.document_number AS current_number,
  h.previous_document_number,
  h.changed_at,
  h.source
FROM documents d
JOIN LATERAL (
  SELECT previous_document_number, changed_at, source
  FROM document_number_history x
  WHERE x.document_id = d.id
  ORDER BY x.changed_at DESC, x.id DESC
  LIMIT 1
) h ON true
ORDER BY h.changed_at DESC, d.id DESC
LIMIT 50;
