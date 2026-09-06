-- 025_request_deadline_and_flow_direction_backfill_studio.sql
-- LegalBridge V2: normalize request deadlines and legacy condition flow direction.
-- Idempotent and Cloud SQL Studio compatible.

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.legal_requests') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.legal_requests is missing';
  END IF;
  IF to_regclass('public.condition_lines') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.condition_lines is missing';
  END IF;
END
$guard$;

BEGIN;

-- 1. Preserve existing semantics observed in production:
--    payable = inbound obligation, receivable = outbound entitlement.
UPDATE condition_lines
SET flow_direction = 'in',
    updated_at = now()
WHERE flow_direction IS NULL
  AND direction = 'payable';

UPDATE condition_lines
SET flow_direction = 'out',
    updated_at = now()
WHERE flow_direction IS NULL
  AND direction = 'receivable';

-- 2. Recover only explicit ISO calendar dates embedded in legacy notes.
--    Store midnight in Asia/Tokyo; the API exposes this field as YYYY-MM-DD.
UPDATE legal_requests
SET deadline = (
  substring(notes FROM '"deadline"\s*:\s*"(\d{4}-\d{2}-\d{2})"')::date::timestamp
  AT TIME ZONE 'Asia/Tokyo'
)
WHERE deadline IS NULL
  AND notes ~ '"deadline"\s*:\s*"\d{4}-\d{2}-\d{2}"';

COMMIT;

-- Verification.
SELECT
  COUNT(*) AS requests_total,
  COUNT(*) FILTER (WHERE deadline IS NOT NULL) AS with_deadline,
  COUNT(*) FILTER (WHERE deadline IS NULL) AS missing_deadline
FROM legal_requests;

SELECT
  COALESCE(flow_direction, '(null)') AS flow_direction,
  COALESCE(direction, '(null)') AS direction,
  COUNT(*) AS rows
FROM condition_lines
GROUP BY flow_direction, direction
ORDER BY flow_direction, direction;

SELECT COUNT(*) AS invalid_direction_pairs
FROM condition_lines
WHERE
  (direction = 'payable' AND flow_direction IS DISTINCT FROM 'in')
  OR
  (direction = 'receivable' AND flow_direction IS DISTINCT FROM 'out');
