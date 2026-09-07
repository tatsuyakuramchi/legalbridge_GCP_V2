-- =====================================================================
-- V3移行 020：合意・条件・範囲・予定・実績・支払
--   ここが移行の中心。冪等。
--   実行: psql "$ADMIN_DSN" -f infra/v3/020_migrate_core.sql（010 の後）
--
--   金額の変換：V3 は最小通貨単位の整数で保持する。
--     JPY / KRW は小数部を持たないためそのまま、他通貨は ×100。
--     四捨五入で移すこと（切り上げは計算規則であって保存規則ではない）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- 通貨の最小単位へ寄せる関数（移行専用）
CREATE OR REPLACE FUNCTION v3.to_minor(v numeric, cur text)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN COALESCE(cur, 'JPY') IN ('JPY', 'KRW', 'VND') THEN round(v)::bigint
    ELSE round(v * 100)::bigint
  END
$$;
COMMENT ON FUNCTION v3.to_minor(numeric, text) IS '移行専用。切替後は削除してよい。';

-- ---------------------------------------------------------------------
-- 合意：contracts → agreements
--   direction は契約に列が無いため、ぶら下がる条件の向きから決める。
-- ---------------------------------------------------------------------
INSERT INTO v3.agreements (agreement_no, title, counterparty_id, direction, status,
                           executed_on, effective_on, expires_on, auto_renewal,
                           renewal_notice_months, source_system, source_url, legacy_id)
SELECT
  NULLIF(c.document_number, ''),
  COALESCE(NULLIF(c.contract_title, ''), NULLIF(c.document_number, ''), '（無題の契約）'),
  p.id,
  CASE WHEN EXISTS (
         SELECT 1 FROM public.condition_lines cl
           JOIN public.documents d ON d.id = cl.document_id
          WHERE d.contract_id = c.id AND cl.flow_direction = 'out')
       THEN 'out' ELSE 'in' END,
  CASE
    WHEN c.contract_status IN ('draft','negotiating','executed','expired','terminated')
         THEN c.contract_status
    WHEN c.contract_status IN ('awaiting_signature') THEN 'negotiating'
    WHEN c.expiration_date IS NOT NULL AND c.expiration_date < current_date THEN 'expired'
    ELSE 'executed'
  END,
  c.executed_at::date, c.effective_date, c.expiration_date,
  COALESCE(c.auto_renewal, false), c.renewal_notice_months,
  NULLIF(c.source_system, ''), NULLIF(c.document_url, ''), c.id
FROM public.contracts c
LEFT JOIN v3.parties p ON p.legacy_id = c.primary_vendor_id
WHERE p.id IS NOT NULL
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  agreement_no = EXCLUDED.agreement_no, title = EXCLUDED.title,
  counterparty_id = EXCLUDED.counterparty_id, direction = EXCLUDED.direction,
  status = EXCLUDED.status, executed_on = EXCLUDED.executed_on,
  effective_on = EXCLUDED.effective_on, expires_on = EXCLUDED.expires_on,
  auto_renewal = EXCLUDED.auto_renewal,
  renewal_notice_months = EXCLUDED.renewal_notice_months, updated_at = now();

-- ---------------------------------------------------------------------
-- 条件：condition_lines → conditions
--   向きは3列（direction / flow_direction / is_inbound）を1列に畳む。
--   歴史的にどれか1つしか入っていない行があるため、この優先順で決める。
-- ---------------------------------------------------------------------
INSERT INTO v3.conditions (
  condition_no, agreement_id, direction, kind, name, counterparty_id,
  work_id, work_part_id, exclusivity, sublicensable, term_start, term_end,
  currency, pricing_model, rate_ppm, unit_amount, flat_amount, mg_amount, ag_amount,
  royalty_base, deductible_costs, tax_category, payment_terms, cycle,
  status, notes, legacy_id)
SELECT
  NULLIF(cl.line_code, ''),
  ag.id,
  COALESCE(
    NULLIF(cl.flow_direction, ''),
    CASE WHEN cl.direction = 'receivable' THEN 'out'
         WHEN cl.direction = 'payable'    THEN 'in' END,
    CASE WHEN cl.is_inbound THEN 'in' ELSE 'out' END,
    'in'),
  CASE
    WHEN cl.line_kind = 'expense' THEN 'expense'
    WHEN cl.line_kind = 'fee'     THEN 'fee'
    WHEN cl.transaction_kind = 'license' THEN 'license'
    WHEN cl.transaction_kind = 'product' THEN 'product'
    ELSE 'service'
  END,
  COALESCE(NULLIF(cl.condition_name, ''), '（無題の条件）'),
  cp.id,
  nw.id,
  np.id,
  CASE WHEN cl.exclusivity ILIKE '%non%' OR cl.exclusivity LIKE '%非独占%' THEN 'non_exclusive'
       WHEN NULLIF(cl.exclusivity, '') IS NOT NULL                        THEN 'exclusive' END,
  cl.sublicense_allowed,
  cl.term_start, cl.term_end,
  COALESCE(NULLIF(cl.currency, ''), 'JPY'),
  CASE
    WHEN upper(COALESCE(cl.calc_type, cl.calc_method, '')) = 'SUBSCRIPTION'        THEN 'subscription'
    WHEN upper(COALESCE(cl.calc_type, cl.calc_method, '')) IN ('BASE_RATE')        THEN 'revenue_rate'
    WHEN upper(COALESCE(cl.calc_type, cl.calc_method, '')) IN
         ('BASE_QTY_RATE','SUPPLY_QTY','PER_UNIT')                                 THEN 'unit_rate'
    WHEN upper(COALESCE(cl.calc_type, cl.calc_method, '')) = 'FIXED'               THEN 'fixed'
    WHEN cl.rate_pct IS NOT NULL AND cl.rate_pct > 0                               THEN 'revenue_rate'
    WHEN cl.amount_ex_tax IS NOT NULL AND cl.amount_ex_tax > 0                     THEN 'fixed'
    ELSE 'none'
  END,
  CASE WHEN cl.rate_pct IS NOT NULL THEN round(cl.rate_pct * 10000)::int END,
  v3.to_minor(cl.unit_amount,   cl.currency),
  v3.to_minor(cl.amount_ex_tax, cl.currency),
  v3.to_minor(cl.mg_amount,     cl.currency),
  v3.to_minor(cl.ag_amount,     cl.currency),
  NULLIF(cl.royalty_base, ''), NULLIF(cl.deductible_costs, ''),
  CASE WHEN cl.tax_category IN ('taxable','reduced','exempt') THEN cl.tax_category
       ELSE 'taxable' END,
  NULLIF(cl.payment_terms, ''), NULLIF(cl.cycle, ''),
  CASE
    WHEN d.lifecycle_status = 'voided'                THEN 'void'
    WHEN d.form_data->>'ledger_status' = 'draft'      THEN 'draft'
    ELSE 'active'
  END,
  NULLIF(cl.notes, ''),
  cl.id
FROM public.condition_lines cl
LEFT JOIN public.documents d ON d.id = cl.document_id
LEFT JOIN v3.agreements ag   ON ag.legacy_id = d.contract_id
LEFT JOIN v3.parties cp      ON cp.legacy_id = cl.counterparty_vendor_id
LEFT JOIN v3.works nw        ON nw.legacy_table = 'works'
                            AND nw.legacy_id = COALESCE(cl.work_id, cl.source_work_id)
LEFT JOIN v3.work_parts np   ON np.legacy_id = cl.source_material_id
WHERE cp.id IS NOT NULL          -- 相手先が解決できない行は取り込まない（090 で一覧化する）
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  agreement_id = EXCLUDED.agreement_id, direction = EXCLUDED.direction,
  kind = EXCLUDED.kind, name = EXCLUDED.name, counterparty_id = EXCLUDED.counterparty_id,
  work_id = EXCLUDED.work_id, work_part_id = EXCLUDED.work_part_id,
  exclusivity = EXCLUDED.exclusivity, sublicensable = EXCLUDED.sublicensable,
  term_start = EXCLUDED.term_start, term_end = EXCLUDED.term_end,
  currency = EXCLUDED.currency, pricing_model = EXCLUDED.pricing_model,
  rate_ppm = EXCLUDED.rate_ppm, unit_amount = EXCLUDED.unit_amount,
  flat_amount = EXCLUDED.flat_amount, mg_amount = EXCLUDED.mg_amount,
  ag_amount = EXCLUDED.ag_amount, tax_category = EXCLUDED.tax_category,
  status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now();

-- 親子（元IN条件 → OUT条件）は全行が入ってから結ぶ
UPDATE v3.conditions c
   SET parent_id = pc.id
  FROM public.condition_lines cl
  JOIN v3.conditions pc ON pc.legacy_id = cl.parent_license_condition_id
 WHERE c.legacy_id = cl.id
   AND cl.parent_license_condition_id IS NOT NULL
   AND c.id <> pc.id
   AND c.parent_id IS DISTINCT FROM pc.id;

-- ---------------------------------------------------------------------
-- 範囲：正規化テーブルを優先し、無ければテキスト列を分解する
--   現行の読取ロジック（COALESCE(サブクエリ, テキスト列)）と同じ規則。
-- ---------------------------------------------------------------------
INSERT INTO v3.condition_scopes (condition_id, scope_type, label, sort_order)
SELECT nc.id, 'region', btrim(r.country_name), COALESCE(r.sort_order, 0)
  FROM public.condition_line_regions r
  JOIN v3.conditions nc ON nc.legacy_id = r.condition_line_id
 WHERE btrim(COALESCE(r.country_name, '')) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO v3.condition_scopes (condition_id, scope_type, label, sort_order)
SELECT nc.id, 'language', btrim(l.language_name), COALESCE(l.sort_order, 0)
  FROM public.condition_line_languages l
  JOIN v3.conditions nc ON nc.legacy_id = l.condition_line_id
 WHERE btrim(COALESCE(l.language_name, '')) <> ''
ON CONFLICT DO NOTHING;

-- 正規化行が無い条件だけ、テキスト列を区切って取り込む
INSERT INTO v3.condition_scopes (condition_id, scope_type, label, sort_order)
SELECT nc.id, 'region', btrim(part.v), part.ord - 1
  FROM public.condition_lines cl
  JOIN v3.conditions nc ON nc.legacy_id = cl.id
  CROSS JOIN LATERAL regexp_split_to_table(COALESCE(cl.region_territory, ''), '[・,、/／|]')
             WITH ORDINALITY AS part(v, ord)
 WHERE btrim(part.v) <> ''
   AND NOT EXISTS (SELECT 1 FROM public.condition_line_regions r WHERE r.condition_line_id = cl.id)
ON CONFLICT DO NOTHING;

INSERT INTO v3.condition_scopes (condition_id, scope_type, label, sort_order)
SELECT nc.id, 'language', btrim(part.v), part.ord - 1
  FROM public.condition_lines cl
  JOIN v3.conditions nc ON nc.legacy_id = cl.id
  CROSS JOIN LATERAL regexp_split_to_table(COALESCE(cl.region_language, ''), '[・,、/／|]')
             WITH ORDINALITY AS part(v, ord)
 WHERE btrim(part.v) <> ''
   AND NOT EXISTS (SELECT 1 FROM public.condition_line_languages l WHERE l.condition_line_id = cl.id)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- 予定：condition_line_installments → condition_schedules
-- ---------------------------------------------------------------------
INSERT INTO v3.condition_schedules (condition_id, seq, trigger_kind, planned_amount, due_on, legacy_id)
SELECT nc.id, i.installment_no,
       CASE WHEN i.trigger_kind IN ('on_execution','on_delivery','on_inspection','periodic')
            THEN i.trigger_kind ELSE 'on_execution' END,
       COALESCE(v3.to_minor(i.planned_amount_ex_tax, nc.currency), 0),
       i.due_date, i.id
  FROM public.condition_line_installments i
  JOIN v3.conditions nc ON nc.legacy_id = i.condition_line_id
ON CONFLICT (condition_id, seq) DO UPDATE SET
  trigger_kind = EXCLUDED.trigger_kind, planned_amount = EXCLUDED.planned_amount,
  due_on = EXCLUDED.due_on, legacy_id = EXCLUDED.legacy_id;

-- ---------------------------------------------------------------------
-- 実績：condition_events → condition_events
--   製造・売上・納品・受領の各表は本番0行のため、ここでは条件イベントのみ移す。
--   実データが入っていた場合に備え、090 で件数を突き合わせる。
-- ---------------------------------------------------------------------
INSERT INTO v3.condition_events (condition_id, schedule_id, event_type, occurred_on, period,
                                 amount, status, legacy_id)
SELECT nc.id, ns.id,
       CASE
         WHEN e.event_type IN ('manufacturing','sales','inspection','delivery') THEN e.event_type
         WHEN e.event_type IN ('sublicense_receipt','receipt')                  THEN 'sublicense_receipt'
         WHEN e.event_type IN ('service_period')                                THEN 'service_period'
         ELSE 'adjustment'
       END,
       COALESCE(e.occurred_at::date, current_date),
       NULLIF(e.period, ''),
       COALESCE(v3.to_minor(e.amount_ex_tax, nc.currency), 0),
       CASE WHEN e.voided_at IS NOT NULL THEN 'void' ELSE 'active' END,
       e.id
  FROM public.condition_events e
  JOIN v3.conditions nc          ON nc.legacy_id = e.condition_line_id
  LEFT JOIN v3.condition_schedules ns ON ns.legacy_id = e.installment_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  event_type = EXCLUDED.event_type, occurred_on = EXCLUDED.occurred_on,
  period = EXCLUDED.period, amount = EXCLUDED.amount, status = EXCLUDED.status;

-- ---------------------------------------------------------------------
-- 支払：payments → payments
--   割当（payment_allocations）は現行に相当物が無いため、条件が特定できる行だけ結ぶ。
-- ---------------------------------------------------------------------
INSERT INTO v3.payments (direction, party_id, currency, amount, due_on, paid_on, status, legacy_id)
SELECT
  CASE WHEN p.direction ILIKE '%receiv%' OR p.direction = 'in' THEN 'in' ELSE 'out' END,
  pt.id,
  COALESCE(NULLIF(p.currency, ''), 'JPY'),
  COALESCE(v3.to_minor(COALESCE(p.amount_ex_tax, p.total_amount), p.currency), 0),
  p.due_date, p.paid_date,
  CASE WHEN p.status IN ('planned','approved','paid','canceled') THEN p.status
       WHEN p.paid_date IS NOT NULL THEN 'paid'
       ELSE 'planned' END,
  p.id
FROM public.payments p
JOIN v3.parties pt ON pt.legacy_id = p.counterparty_vendor_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  direction = EXCLUDED.direction, party_id = EXCLUDED.party_id,
  currency = EXCLUDED.currency, amount = EXCLUDED.amount,
  due_on = EXCLUDED.due_on, paid_on = EXCLUDED.paid_on,
  status = EXCLUDED.status, updated_at = now();

COMMIT;
