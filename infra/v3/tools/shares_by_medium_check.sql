-- Diagnostic (read only): works whose print and digital conditions disagree on shares.
-- On a payee document, the medium without the payee's share prints the whole rate
-- instead of "2% (whole 10%)". Fix by adding the same shares to the other condition.
--
-- Run: Get-Content infra\v3\tools\shares_by_medium_check.sql -Raw | docker compose -f infra\local\docker-compose.yml exec -T db psql -U postgres -d legalbridge -f -

SET search_path = v3, public;

WITH own AS (
  SELECT c.id, c.condition_no, c.work_id, c.name, c.counterparty_id,
         CASE WHEN c.usage_type = 'pub_digital' THEN 'digital' ELSE 'print' END AS medium,
         (SELECT string_agg(p.name || ' ' || (s.share_ppm / 10000.0) || '%', ', ' ORDER BY s.sort_order, s.id)
            FROM condition_shares s JOIN parties p ON p.id = s.party_id WHERE s.condition_id = c.id) AS shares
    FROM conditions c
   WHERE c.pricing_model = 'revenue_rate' AND c.usage_type IN ('pub_print', 'pub_digital')
     AND c.status NOT IN ('void', 'superseded') AND c.work_id IS NOT NULL
)
SELECT w.title, a.counterparty_id, pt.name AS counterparty,
       p.condition_no AS print_no, p.shares AS print_shares,
       d.condition_no AS digital_no, d.shares AS digital_shares
  FROM own p
  JOIN own d ON d.work_id = p.work_id AND d.counterparty_id = p.counterparty_id AND d.medium = 'digital' AND p.medium = 'print'
  JOIN own a ON a.id = p.id
  JOIN works w ON w.id = p.work_id
  JOIN parties pt ON pt.id = p.counterparty_id
 WHERE COALESCE(p.shares, '') <> COALESCE(d.shares, '')
 ORDER BY pt.name, w.title;
