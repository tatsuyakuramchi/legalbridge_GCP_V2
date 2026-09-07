-- =====================================================================
-- LegalBridge V3 ビュー
--   派生値は列に持たず、ここに集約する（設計原則2）。
--   実行: psql "$ADMIN_DSN" -f infra/v3/002_views.sql（001 の後）
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- 条件の残高（MG下限・AG充当）
--   MG は毎期独立の下限で消化しない。AG は累積で充当する。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v3.v_condition_balance AS
SELECT
  c.id                                            AS condition_id,
  c.condition_no,
  c.direction,
  c.currency,
  COALESCE(c.mg_amount, 0)                        AS mg_amount,
  COALESCE(c.ag_amount, 0)                        AS ag_amount,
  COALESCE(s.planned_total, 0)                    AS planned_total,
  COALESCE(e.consumed_total, 0)                   AS consumed_total,
  GREATEST(COALESCE(c.ag_amount, 0) - COALESCE(e.consumed_total, 0), 0) AS ag_remaining,
  CASE WHEN COALESCE(c.ag_amount, 0) > 0
       THEN LEAST(COALESCE(e.consumed_total, 0)::numeric / c.ag_amount, 1)
  END                                             AS ag_consumption_rate
FROM v3.conditions c
LEFT JOIN LATERAL (
  SELECT SUM(planned_amount) AS planned_total
    FROM v3.condition_schedules WHERE condition_id = c.id
) s ON true
LEFT JOIN LATERAL (
  SELECT SUM(amount) AS consumed_total
    FROM v3.condition_events WHERE condition_id = c.id AND status = 'active'
) e ON true;

COMMENT ON VIEW v3.v_condition_balance IS
  '条件ごとの予定と実績。AG は累積充当のため残高を出す。MG は下限なので残高の概念を持たない。';

-- ---------------------------------------------------------------------
-- 作品の権利包絡：スカラー次元
--   期間・独占・再許諾は、構成パートのIN条件の最も狭いものが上限になる。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v3.v_work_rights_envelope AS
WITH acquired AS (
  SELECT c.*
    FROM v3.conditions c
   WHERE c.direction = 'in'
     AND c.status = 'active'
     AND c.work_id IS NOT NULL
)
SELECT
  w.id                                        AS work_id,
  w.work_code,
  w.title,
  COUNT(a.id)                                 AS acquired_count,
  -- 期間の上限＝最も早く切れる取得条件。NULL は無期限。
  MIN(a.term_end)                             AS term_limit,
  (ARRAY_AGG(a.condition_no ORDER BY a.term_end, a.condition_no)
     FILTER (WHERE a.term_end IS NOT NULL))[1] AS term_limited_by,
  -- 非独占で取得したものが1つでもあれば、独占では許諾できない。
  CASE WHEN BOOL_OR(a.exclusivity = 'non_exclusive') THEN 'non_exclusive'
       WHEN BOOL_AND(a.exclusivity = 'exclusive')    THEN 'exclusive'
  END                                         AS exclusivity_limit,
  (ARRAY_AGG(a.condition_no ORDER BY a.condition_no)
     FILTER (WHERE a.exclusivity = 'non_exclusive'))[1]
                                              AS exclusivity_limited_by,
  -- 再許諾は全取得条件で可のときだけ可。
  BOOL_AND(COALESCE(a.sublicensable, true))   AS sublicensable,
  (ARRAY_AGG(a.condition_no ORDER BY a.condition_no)
     FILTER (WHERE a.sublicensable IS FALSE))[1]
                                              AS sublicense_limited_by
FROM v3.works w
LEFT JOIN acquired a ON a.work_id = w.id
GROUP BY w.id, w.work_code, w.title;

COMMENT ON VIEW v3.v_work_rights_envelope IS
  '作品ごとに許諾できる上限（スカラー次元）。個々のIN条件ではなく、その積で照合するためのビュー。';

-- ---------------------------------------------------------------------
-- 作品の権利包絡：範囲次元
--   condition_scopes は「行が無ければ無制限」。したがって
--   その次元を制約している取得条件すべてに現れるラベルだけが上限に残る（＝積）。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v3.v_work_scope_envelope AS
WITH acquired AS (
  SELECT c.id, c.work_id, c.condition_no
    FROM v3.conditions c
   WHERE c.direction = 'in' AND c.status = 'active' AND c.work_id IS NOT NULL
),
restricting AS (
  SELECT a.work_id, s.scope_type, COUNT(DISTINCT a.id) AS n_restricting
    FROM acquired a
    JOIN v3.condition_scopes s ON s.condition_id = a.id
   GROUP BY a.work_id, s.scope_type
),
label_counts AS (
  SELECT a.work_id, s.scope_type, s.label,
         MIN(s.code) AS code,
         COUNT(DISTINCT a.id) AS n_present
    FROM acquired a
    JOIN v3.condition_scopes s ON s.condition_id = a.id
   GROUP BY a.work_id, s.scope_type, s.label
)
SELECT lc.work_id, lc.scope_type, lc.label, lc.code
  FROM label_counts lc
  JOIN restricting r
    ON r.work_id = lc.work_id AND r.scope_type = lc.scope_type
 WHERE lc.n_present = r.n_restricting;

COMMENT ON VIEW v3.v_work_scope_envelope IS
  '作品ごとに許諾できる範囲（地域・言語・媒体）。ある次元にこの作品の行が1件も無ければ無制限。';

-- ---------------------------------------------------------------------
-- 表示の解決：件名と相手先
--   documents は件名も相手先も持たない。合意と条件から解決する。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v3.v_document_display AS
SELECT
  d.id                                        AS document_id,
  d.document_no,
  d.status,
  d.issued_at,
  d.matter_id,
  COALESCE(a.title, m.title, fc.name, d.document_no) AS title,
  COALESCE(ap.name, fp.name, mp.name)         AS counterparty,
  COALESCE(ap.id, fp.id, mp.id)               AS counterparty_id,
  dt.label                                    AS template_label,
  dc.condition_count
FROM v3.documents d
LEFT JOIN v3.agreements a  ON a.id = d.agreement_id
LEFT JOIN v3.parties ap    ON ap.id = a.counterparty_id
LEFT JOIN v3.matters m     ON m.id = d.matter_id
LEFT JOIN v3.parties mp    ON mp.id = m.counterparty_id
LEFT JOIN v3.document_template_versions dtv ON dtv.id = d.template_version_id
LEFT JOIN v3.document_templates dt          ON dt.id = dtv.template_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS condition_count FROM v3.document_conditions WHERE document_id = d.id
) dc ON true
LEFT JOIN LATERAL (
  SELECT c.name, c.counterparty_id
    FROM v3.document_conditions x
    JOIN v3.conditions c ON c.id = x.condition_id
   WHERE x.document_id = d.id
   ORDER BY x.line_no
   LIMIT 1
) fc ON true
LEFT JOIN v3.parties fp ON fp.id = fc.counterparty_id;

COMMENT ON VIEW v3.v_document_display IS
  '文書の件名・相手先の解決を1箇所に集約する。現行は解決キー配列が4本に分裂していた。';

-- ---------------------------------------------------------------------
-- 期限の統合
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v3.v_deadlines AS
SELECT 'matter'::text AS source, m.id AS ref_id, m.matter_no AS ref_no,
       m.title, m.due_on AS due_on, m.status
  FROM v3.matters m
 WHERE m.due_on IS NOT NULL AND m.status NOT IN ('done', 'canceled')
UNION ALL
SELECT 'agreement', a.id, a.agreement_no, a.title,
       CASE WHEN a.auto_renewal AND a.renewal_notice_months IS NOT NULL
            THEN a.expires_on - (a.renewal_notice_months || ' months')::interval
            ELSE a.expires_on END::date,
       a.status
  FROM v3.agreements a
 WHERE a.expires_on IS NOT NULL AND a.status = 'executed'
UNION ALL
SELECT 'payment', p.id, p.payment_no,
       COALESCE(pt.name, '') || ' への支払', p.due_on, p.status
  FROM v3.payments p
  LEFT JOIN v3.parties pt ON pt.id = p.party_id
 WHERE p.due_on IS NOT NULL AND p.status IN ('planned', 'approved')
UNION ALL
SELECT 'schedule', s.id, c.condition_no, c.name, s.due_on, c.status
  FROM v3.condition_schedules s
  JOIN v3.conditions c ON c.id = s.condition_id
 WHERE s.due_on IS NOT NULL AND c.status = 'active';

COMMENT ON VIEW v3.v_deadlines IS
  '案件・契約満了（更新通告日を考慮）・支払・予定を1本に。現行は都度CTEで組んでいた。';

-- ---------------------------------------------------------------------
-- 権利の出所（現 material_rights_sources の代替）
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v3.v_rights_sources AS
SELECT c.work_id, c.work_part_id, c.id AS condition_id, c.condition_no,
       c.counterparty_id AS rights_holder_id, p.name AS rights_holder,
       c.term_start, c.term_end, c.agreement_id
  FROM v3.conditions c
  JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE c.direction = 'in' AND c.status = 'active';

COMMENT ON VIEW v3.v_rights_sources IS
  '権利の出所は独立した表ではなく IN 条件そのもの。条件を直せばここも直る。';

COMMIT;
