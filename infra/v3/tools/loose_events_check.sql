-- Diagnostic (read only), all parties.
--  1) conditions without rounds (schedules) that have results not tied to a round:
--     these were the ones shown as two rows on the pay-document board (result row + "1 / 1 any time").
--  2) possible duplicate results: same condition, same date, same amount, both active.
--
-- Run: Get-Content infra\v3\tools\loose_events_check.sql -Raw | docker compose -f infra\local\docker-compose.yml exec -T db psql -U postgres -d legalbridge -f -

SET search_path = v3, public;

\echo === 1) conditions without rounds that have loose results (board showed 2 rows before the fix) ===
SELECT c.id, c.condition_no, p.name AS party, c.name, c.settlement_mode, c.settlement_count,
       count(e.id) AS loose_results, sum(e.amount) AS total_amount,
       count(e.id) FILTER (WHERE e.document_id IS NOT NULL) AS with_document
  FROM conditions c
  JOIN parties p ON p.id = c.counterparty_id
  JOIN condition_events e ON e.condition_id = c.id AND e.schedule_id IS NULL AND e.status = 'active'
 WHERE c.status IN ('active', 'scheduled')
   AND c.settlement_mode IN ('once', 'fixed_count', 'term_bound')
   AND NOT EXISTS (SELECT 1 FROM condition_schedules s WHERE s.condition_id = c.id)
 GROUP BY c.id, c.condition_no, p.name, c.name, c.settlement_mode, c.settlement_count
 ORDER BY p.name, c.id;

\echo === 2) possible duplicate results (same condition, date, amount; both active) ===
SELECT c.condition_no, p.name AS party, c.name, e.occurred_on, e.amount,
       array_agg(e.id ORDER BY e.id) AS event_ids,
       array_agg(COALESCE(d.document_no, '-') ORDER BY e.id) AS documents,
       array_agg(e.created_at::text ORDER BY e.id) AS created
  FROM condition_events e
  JOIN conditions c ON c.id = e.condition_id
  JOIN parties p ON p.id = c.counterparty_id
  LEFT JOIN documents d ON d.id = e.document_id
 WHERE e.status = 'active'
 GROUP BY c.id, c.condition_no, p.name, c.name, e.occurred_on, e.amount
HAVING count(*) > 1
 ORDER BY p.name, e.occurred_on;
