-- Diagnostic (read only): a party's conditions with their rounds (schedules) and recorded results (events).
-- Shows why the pay-document board shows two rows (a round without results plus a loose result),
-- and which result rows are duplicates.
--
-- Pass the party name (or part of it) as :party. Japanese is given with \u escapes so PowerShell
-- does not re-encode it, e.g. for "Seto":
--   docker compose -f infra\local\docker-compose.yml exec -T db psql -U postgres -d legalbridge -v party="E'瀬戸'" -f - < infra\v3\tools\condition_events_check.sql
-- (PowerShell has no "<": use   Get-Content infra\v3\tools\condition_events_check.sql -Raw | docker compose ... -v party="E'瀬戸'" -f -   instead)

SET search_path = v3, public;

\echo === conditions of the party ===
SELECT c.id, c.condition_no, c.name, c.kind, c.pricing_model, c.contract_form, c.settlement_mode,
       c.settlement_count, c.time_settlement, c.status, p.name AS party
  FROM conditions c JOIN parties p ON p.id = c.counterparty_id
 WHERE p.name ILIKE '%' || :party || '%'
 ORDER BY c.id;

\echo === rounds (schedules): due_on NULL means "any time" ===
SELECT s.id AS schedule_id, s.condition_id, s.seq, s.label, s.due_on, s.pay_on, s.planned_amount, s.trigger_kind
  FROM condition_schedules s
 WHERE s.condition_id IN (SELECT c.id FROM conditions c JOIN parties p ON p.id = c.counterparty_id WHERE p.name ILIKE '%' || :party || '%')
 ORDER BY s.condition_id, s.seq;

\echo === results (events): schedule_id NULL means not tied to a round; status void means cancelled ===
SELECT e.id AS event_id, e.condition_id, e.schedule_id, e.event_type, e.occurred_on, e.amount, e.quantity, e.hours,
       e.status, e.document_id, d.document_no, e.created_at, e.created_by, e.note
  FROM condition_events e
  LEFT JOIN documents d ON d.id = e.document_id
 WHERE e.condition_id IN (SELECT c.id FROM conditions c JOIN parties p ON p.id = c.counterparty_id WHERE p.name ILIKE '%' || :party || '%')
 ORDER BY e.condition_id, e.occurred_on, e.id;

\echo === documents on those conditions: status draft means not decided yet; _eventIds is the result ids the draft carries ===
SELECT d.id AS document_id, d.document_no, d.status, t.template_key, d.title, d.issued_at::date AS issued_on, d.created_at::date AS created_on,
       dc.condition_id, d.manual_inputs->'_eventIds' AS draft_event_ids
  FROM documents d
  JOIN document_conditions dc ON dc.document_id = d.id
  LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id
 WHERE dc.condition_id IN (SELECT c.id FROM conditions c JOIN parties p ON p.id = c.counterparty_id WHERE p.name ILIKE '%' || :party || '%')
 ORDER BY d.id;
