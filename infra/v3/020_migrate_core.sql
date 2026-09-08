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
-- 価格方式の決定
--   V1 の calc_type / calc_method は「そう宣言されている」だけで、
--   必要な値が入っているとは限らない（unit_rate なのに unit_amount が
--   空、など）。V3 は CHECK でその整合を要求するので、宣言をそのまま
--   信じると1行のために移行全体が止まる。
--   宣言は必要な値が実在するときだけ採用し、食い違う場合は実際にある
--   値から決め直す。決め直した行は CONDITION_PRICING_RECLASSIFIED として
--   記録するので、V1 側の入力漏れとして追える。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION v3.pricing_model_of(
  calc_type text, calc_method text, rate_pct numeric,
  unit_amount numeric, amount_ex_tax numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN upper(COALESCE(calc_type, calc_method, '')) = 'SUBSCRIPTION'    THEN 'subscription'
    WHEN upper(COALESCE(calc_type, calc_method, '')) = 'BASE_RATE'
         AND rate_pct IS NOT NULL                                        THEN 'revenue_rate'
    WHEN upper(COALESCE(calc_type, calc_method, '')) IN
         ('BASE_QTY_RATE', 'SUPPLY_QTY', 'PER_UNIT')
         AND unit_amount IS NOT NULL                                     THEN 'unit_rate'
    WHEN upper(COALESCE(calc_type, calc_method, '')) = 'FIXED'
         AND amount_ex_tax IS NOT NULL                                   THEN 'fixed'
    -- 宣言に必要な値が無い。実データから決め直す。
    WHEN rate_pct      IS NOT NULL AND rate_pct > 0                      THEN 'revenue_rate'
    WHEN unit_amount   IS NOT NULL                                       THEN 'unit_rate'
    WHEN amount_ex_tax IS NOT NULL AND amount_ex_tax > 0                 THEN 'fixed'
    ELSE 'none'
  END
$$;
COMMENT ON FUNCTION v3.pricing_model_of(text, text, numeric, numeric, numeric)
  IS '移行専用。切替後は削除してよい。';

-- ---------------------------------------------------------------------
-- 合意：contracts → agreements
--   direction は契約に列が無いため、ぶら下がる条件の向きから決める。
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- 期間の正規化
--   V1 には開始 > 終了の行が入りうる（年の打ち間違い）。V3 は
--   CHECK (終了 >= 開始) を持つので、そのまま入れると1行のために
--   380件の取り込みが全部止まる。並行稼働中の流し直しに耐えないので、
--   矛盾する側だけを落として取り込む。日付は作り直さない（捏造しない）。
--     - ありえない年（1990年より前・2100年より後）が原因ならその側を落とす
--     - 両方ありえる値なら開始を落とす（終了は期限管理に効くので残す）
--   元の値は data_quality_issues に残すので、失われる情報は無い。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION v3.term_implausible(d date) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS
$$ SELECT d IS NOT NULL AND (d < DATE '1990-01-01' OR d > DATE '2100-01-01') $$;

CREATE OR REPLACE FUNCTION v3.term_start_ok(s date, e date) RETURNS date
  LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE
     WHEN s IS NULL OR e IS NULL OR e >= s THEN s
     WHEN v3.term_implausible(s) OR NOT v3.term_implausible(e) THEN NULL
     ELSE s END $$;

CREATE OR REPLACE FUNCTION v3.term_end_ok(s date, e date) RETURNS date
  LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE
     WHEN s IS NULL OR e IS NULL OR e >= s THEN e
     WHEN v3.term_implausible(e) THEN NULL
     ELSE e END $$;

INSERT INTO v3.agreements (agreement_no, title, counterparty_id, direction, status,
                           executed_on, effective_on, expires_on, auto_renewal,
                           renewal_notice_months, source_system, source_url, legacy_id)
SELECT
  NULLIF(c.document_number, ''),
  COALESCE(NULLIF(c.contract_title, ''), NULLIF(c.document_number, ''), '（無題の契約）'),
  COALESCE(p.id, un.id),
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
  c.executed_at::date,
  v3.term_start_ok(c.effective_date, c.expiration_date),
  v3.term_end_ok(c.effective_date, c.expiration_date),
  COALESCE(c.auto_renewal, false), c.renewal_notice_months,
  NULLIF(c.source_system, ''), NULLIF(c.document_url, ''), c.id
FROM public.contracts c
LEFT JOIN v3.parties p  ON p.legacy_id = c.primary_vendor_id
CROSS JOIN v3.parties un
 WHERE un.party_code = 'UNRESOLVED'
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  agreement_no = EXCLUDED.agreement_no, title = EXCLUDED.title,
  counterparty_id = CASE
    WHEN EXCLUDED.counterparty_id
         = (SELECT id FROM v3.parties WHERE party_code = 'UNRESOLVED')
    THEN agreements.counterparty_id      -- UI で割り当てた相手先を残す
    ELSE EXCLUDED.counterparty_id END,
  direction = EXCLUDED.direction,
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
  COALESCE(cp.id, un.id),
  nw.id,
  np.id,
  CASE WHEN cl.exclusivity ILIKE '%non%' OR cl.exclusivity LIKE '%非独占%' THEN 'non_exclusive'
       WHEN NULLIF(cl.exclusivity, '') IS NOT NULL                        THEN 'exclusive' END,
  cl.sublicense_allowed,
  v3.term_start_ok(cl.term_start, cl.term_end),
  v3.term_end_ok(cl.term_start, cl.term_end),
  COALESCE(NULLIF(cl.currency, ''), 'JPY'),
  v3.pricing_model_of(cl.calc_type, cl.calc_method, cl.rate_pct,
                      cl.unit_amount, cl.amount_ex_tax),
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
LEFT JOIN public.contracts ct ON ct.id = d.contract_id
LEFT JOIN v3.agreements ag   ON ag.legacy_id = d.contract_id
-- 相手先は条件が直に持っていないことがある（実データで376件中176件が空）。
-- その場合は文書→契約に1ホップして引く。契約の相手先は同じ取引の相手なので、
-- 推測ではなくデータ上の同値。これで89件・¥10,660,807 が回収できる。
LEFT JOIN v3.parties cp      ON cp.legacy_id = COALESCE(cl.counterparty_vendor_id,
                                                        ct.primary_vendor_id)
LEFT JOIN v3.works nw        ON nw.legacy_table = 'works'
                            AND nw.legacy_id = COALESCE(cl.work_id, cl.source_work_id)
LEFT JOIN v3.work_parts np   ON np.legacy_id = cl.source_material_id
CROSS JOIN v3.parties un
 WHERE un.party_code = 'UNRESOLVED'   -- 解決できない行は受け皿へ（090 で一覧化する）
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  agreement_id = EXCLUDED.agreement_id, direction = EXCLUDED.direction,
  kind = EXCLUDED.kind, name = EXCLUDED.name,
  counterparty_id = CASE
    WHEN EXCLUDED.counterparty_id
         = (SELECT id FROM v3.parties WHERE party_code = 'UNRESOLVED')
    THEN conditions.counterparty_id
    ELSE EXCLUDED.counterparty_id END,
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
-- 期間が逆転していた行を記録する（元の値をここに残す）
--   V1 側を直したら再実行で detail が更新され、直った行は消える。
-- ---------------------------------------------------------------------
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'AGREEMENT_TERM_INVERTED', 'legacy_contract', c.id, 'high',
       jsonb_build_object('document_number', c.document_number,
                          'title', c.contract_title,
                          'original_effective_date', c.effective_date,
                          'original_expiration_date', c.expiration_date,
                          'kept_effective_on', v3.term_start_ok(c.effective_date, c.expiration_date),
                          'kept_expires_on',   v3.term_end_ok(c.effective_date, c.expiration_date))
  FROM public.contracts c
 WHERE c.effective_date IS NOT NULL AND c.expiration_date IS NOT NULL
   AND c.expiration_date < c.effective_date
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now(), status = 'open';

INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'CONDITION_TERM_INVERTED', 'legacy_condition_line', cl.id, 'high',
       jsonb_build_object('condition_name', cl.condition_name,
                          'original_term_start', cl.term_start,
                          'original_term_end', cl.term_end,
                          'kept_term_start', v3.term_start_ok(cl.term_start, cl.term_end),
                          'kept_term_end',   v3.term_end_ok(cl.term_start, cl.term_end))
  FROM public.condition_lines cl
 WHERE cl.term_start IS NOT NULL AND cl.term_end IS NOT NULL
   AND cl.term_end < cl.term_start
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now(), status = 'open';

-- 宣言と実データが食い違って価格方式を決め直した行を記録する。
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'CONDITION_PRICING_RECLASSIFIED', 'legacy_condition_line', cl.id, 'medium',
       jsonb_build_object('condition_name', cl.condition_name,
                          'declared', upper(COALESCE(cl.calc_type, cl.calc_method, '')),
                          'applied', v3.pricing_model_of(cl.calc_type, cl.calc_method,
                                       cl.rate_pct, cl.unit_amount, cl.amount_ex_tax),
                          'rate_pct', cl.rate_pct,
                          'unit_amount', cl.unit_amount,
                          'amount_ex_tax', cl.amount_ex_tax)
  FROM public.condition_lines cl
 WHERE upper(COALESCE(cl.calc_type, cl.calc_method, '')) <> ''
   AND v3.pricing_model_of(cl.calc_type, cl.calc_method, cl.rate_pct,
                           cl.unit_amount, cl.amount_ex_tax)
       IS DISTINCT FROM CASE upper(COALESCE(cl.calc_type, cl.calc_method, ''))
            WHEN 'SUBSCRIPTION'   THEN 'subscription'
            WHEN 'BASE_RATE'      THEN 'revenue_rate'
            WHEN 'BASE_QTY_RATE'  THEN 'unit_rate'
            WHEN 'SUPPLY_QTY'     THEN 'unit_rate'
            WHEN 'PER_UNIT'       THEN 'unit_rate'
            WHEN 'FIXED'          THEN 'fixed' END
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now(), status = 'open', resolved_at = NULL;

UPDATE v3.data_quality_issues q
   SET status = 'resolved', resolved_at = now()
 WHERE q.rule_code = 'CONDITION_PRICING_RECLASSIFIED' AND q.status = 'open'
   AND NOT EXISTS (
     SELECT 1 FROM public.condition_lines cl
      WHERE cl.id = q.target_id
        AND v3.pricing_model_of(cl.calc_type, cl.calc_method, cl.rate_pct,
                                cl.unit_amount, cl.amount_ex_tax)
            IS DISTINCT FROM CASE upper(COALESCE(cl.calc_type, cl.calc_method, ''))
                 WHEN 'SUBSCRIPTION'   THEN 'subscription'
                 WHEN 'BASE_RATE'      THEN 'revenue_rate'
                 WHEN 'BASE_QTY_RATE'  THEN 'unit_rate'
                 WHEN 'SUPPLY_QTY'     THEN 'unit_rate'
                 WHEN 'PER_UNIT'       THEN 'unit_rate'
                 WHEN 'FIXED'          THEN 'fixed' END);

-- V1 側が直っていれば閉じる（流し直すたびに現状へ追従させる）。
UPDATE v3.data_quality_issues q
   SET status = 'resolved', resolved_at = now()
 WHERE q.rule_code = 'AGREEMENT_TERM_INVERTED' AND q.status = 'open'
   AND NOT EXISTS (
     SELECT 1 FROM public.contracts c
      WHERE c.id = q.target_id
        AND c.effective_date IS NOT NULL AND c.expiration_date IS NOT NULL
        AND c.expiration_date < c.effective_date);

UPDATE v3.data_quality_issues q
   SET status = 'resolved', resolved_at = now()
 WHERE q.rule_code = 'CONDITION_TERM_INVERTED' AND q.status = 'open'
   AND NOT EXISTS (
     SELECT 1 FROM public.condition_lines cl
      WHERE cl.id = q.target_id
        AND cl.term_start IS NOT NULL AND cl.term_end IS NOT NULL
        AND cl.term_end < cl.term_start);

-- ---------------------------------------------------------------------
-- 予定：condition_line_installments → condition_schedules
-- ---------------------------------------------------------------------
-- 移行元から消えた予定が残っていると番号がぶつかる。先に片付ける。
-- 実績から参照されている行は消さず、記録だけ残す。
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'SCHEDULE_ORPHAN_IN_USE', 'condition_schedule', sc.id, 'medium',
       jsonb_build_object('seq', sc.seq, 'legacy_id', sc.legacy_id)
  FROM v3.condition_schedules sc
 WHERE sc.legacy_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.condition_line_installments i WHERE i.id = sc.legacy_id)
   AND EXISTS (SELECT 1 FROM v3.condition_events e WHERE e.schedule_id = sc.id)
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now();

DELETE FROM v3.condition_schedules sc
 WHERE sc.legacy_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.condition_line_installments i WHERE i.id = sc.legacy_id)
   AND NOT EXISTS (SELECT 1 FROM v3.condition_events e WHERE e.schedule_id = sc.id);

--   installment_no は条件内で一意とは限らない。work_parts と同じ扱いで、
--   全件そろって重複が無いときだけ元の番号を残し、それ以外は振り直す。
WITH src AS (
  SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.condition_line_id
                                 ORDER BY i.installment_no NULLS LAST, i.id) AS rn
    FROM public.condition_line_installments i
), clean AS (
  SELECT condition_line_id FROM src
   GROUP BY condition_line_id HAVING count(*) = count(DISTINCT installment_no)
)
INSERT INTO v3.condition_schedules (condition_id, seq, trigger_kind, planned_amount, due_on, legacy_id)
SELECT nc.id,
       (CASE WHEN c.condition_line_id IS NOT NULL THEN i.installment_no ELSE i.rn END)::int,
       CASE WHEN i.trigger_kind IN ('on_execution','on_delivery','on_inspection','periodic')
            THEN i.trigger_kind ELSE 'on_execution' END,
       COALESCE(v3.to_minor(i.planned_amount_ex_tax, nc.currency), 0),
       i.due_date, i.id
  FROM src i
  JOIN v3.conditions nc ON nc.legacy_id = i.condition_line_id
  LEFT JOIN clean c ON c.condition_line_id = i.condition_line_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  condition_id = EXCLUDED.condition_id, seq = EXCLUDED.seq,
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
  COALESCE(pt.id, un.id),
  COALESCE(NULLIF(p.currency, ''), 'JPY'),
  COALESCE(v3.to_minor(COALESCE(p.amount_ex_tax, p.total_amount), p.currency), 0),
  p.due_date, p.paid_date,
  CASE WHEN p.status IN ('planned','approved','paid','canceled') THEN p.status
       WHEN p.paid_date IS NOT NULL THEN 'paid'
       ELSE 'planned' END,
  p.id
FROM public.payments p
LEFT JOIN v3.parties pt ON pt.legacy_id = p.counterparty_vendor_id
CROSS JOIN v3.parties un
 WHERE un.party_code = 'UNRESOLVED'
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  direction = EXCLUDED.direction,
  party_id = CASE
    WHEN EXCLUDED.party_id
         = (SELECT id FROM v3.parties WHERE party_code = 'UNRESOLVED')
    THEN payments.party_id                -- UI で割り当てた相手先を残す
    ELSE EXCLUDED.party_id END,
  currency = EXCLUDED.currency, amount = EXCLUDED.amount,
  due_on = EXCLUDED.due_on, paid_on = EXCLUDED.paid_on,
  status = EXCLUDED.status, updated_at = now();

COMMIT;
