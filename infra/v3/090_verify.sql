-- =====================================================================
-- V3移行 090：検算
--   件数の突き合わせと、取り込めなかった行の一覧化。
--   落ちた行は v3.data_quality_issues に登録して人手で潰す。
--   実行: psql "$ADMIN_DSN" -f infra/v3/090_verify.sql（040 の後）
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;
SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- 取り込めなかった行を記録する
-- ---------------------------------------------------------------------

-- 相手先が解決できず条件を取り込めなかった行
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'MIGRATION_CONDITION_NO_PARTY', 'legacy_condition_line', cl.id, 'high',
       jsonb_build_object('condition_name', cl.condition_name,
                          'vendor_id', cl.counterparty_vendor_id,
                          'document_id', cl.document_id)
  FROM public.condition_lines cl
 WHERE NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.legacy_id = cl.id)
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now(), status = 'open';

-- 主取引先が解決できず合意を取り込めなかった契約
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'MIGRATION_AGREEMENT_NO_PARTY', 'legacy_contract', c.id, 'high',
       jsonb_build_object('contract_title', c.contract_title,
                          'primary_vendor_id', c.primary_vendor_id)
  FROM public.contracts c
 WHERE NOT EXISTS (SELECT 1 FROM v3.agreements a WHERE a.legacy_id = c.id)
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now(), status = 'open';

-- 作品に紐づかない条件（V1移行データに多い）
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'CONDITION_NO_WORK', 'condition', c.id, 'medium',
       jsonb_build_object('condition_no', c.condition_no, 'name', c.name)
  FROM v3.conditions c
 WHERE c.work_id IS NULL AND c.kind IN ('license', 'product')
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now();

-- 条件に割り当てられていない支払（現行の royalty_payments 由来の負債）
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'PAYMENT_UNALLOCATED', 'payment', p.id, 'high',
       jsonb_build_object('payment_no', p.payment_no, 'amount', p.amount)
  FROM v3.payments p
 WHERE NOT EXISTS (SELECT 1 FROM v3.payment_allocations a WHERE a.payment_id = p.id)
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now();

-- 発行済みなのにテンプレートも保管先も無い文書
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'DOCUMENT_NO_SOURCE', 'document', d.id, 'medium',
       jsonb_build_object('document_no', d.document_no)
  FROM v3.documents d
 WHERE d.status = 'issued' AND d.template_version_id IS NULL AND d.storage_url IS NULL
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now();

COMMIT;

BEGIN READ ONLY;

\echo '--- 件数の突き合わせ（差が出たら理由を説明できること）---'
SELECT '取引先'   AS entity, (SELECT count(*) FROM public.vendors)          AS src,
                             (SELECT count(*) FROM v3.parties)              AS dst
UNION ALL SELECT '担当者',   (SELECT count(*) FROM public.staff),           (SELECT count(*) FROM v3.staff)
-- 作品だけは src 列に「移行元の件数」ではなく期待値を置く。
--   works と source_ips を1表に統合するとき、
--     (a) works と同じコードの source_ips は二重登録なので取り込まない
--     (b) source_ips 内で同じコードが重複していれば1行に寄せる
--     (c) タイトルが空の行は両方とも取り込まない
--   ため、単純な足し算では合わない。ここを期待値にしておけば
--   差が出た＝移行のバグ、と読める。
UNION ALL SELECT '作品',
  (SELECT count(*) FROM public.works w
    WHERE COALESCE(NULLIF(w.title,''), '') <> '')
+ (SELECT count(DISTINCT COALESCE(NULLIF(s.source_code,''), 'id:' || s.id))
     FROM public.source_ips s
    WHERE COALESCE(NULLIF(s.title,''), '') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.works w
                       WHERE NULLIF(w.work_code,'') = NULLIF(s.source_code,''))),
                                                                           (SELECT count(*) FROM v3.works)
UNION ALL SELECT 'パート',   (SELECT count(*) FROM public.work_materials),  (SELECT count(*) FROM v3.work_parts)
UNION ALL SELECT '合意',     (SELECT count(*) FROM public.contracts),       (SELECT count(*) FROM v3.agreements)
UNION ALL SELECT '条件',     (SELECT count(*) FROM public.condition_lines), (SELECT count(*) FROM v3.conditions)
UNION ALL SELECT '予定',     (SELECT count(*) FROM public.condition_line_installments),
                                                                           (SELECT count(*) FROM v3.condition_schedules)
UNION ALL SELECT '実績',     (SELECT count(*) FROM public.condition_events),(SELECT count(*) FROM v3.condition_events)
UNION ALL SELECT '支払',     (SELECT count(*) FROM public.payments),        (SELECT count(*) FROM v3.payments)
UNION ALL SELECT '案件',     (SELECT count(*) FROM public.matters),         (SELECT count(*) FROM v3.matters)
UNION ALL SELECT 'タスク',   (SELECT count(*) FROM public.matter_tasks),    (SELECT count(*) FROM v3.tasks)
UNION ALL SELECT '文書',     (SELECT count(*) FROM public.documents),       (SELECT count(*) FROM v3.documents)
ORDER BY 1;

\echo '--- 金額の突き合わせ（JPY のみ・最小単位＝円なので一致すること）---'
SELECT
  (SELECT COALESCE(sum(amount_ex_tax), 0) FROM public.condition_lines
    WHERE COALESCE(currency, 'JPY') = 'JPY')                       AS src_amount_ex_tax,
  (SELECT COALESCE(sum(flat_amount), 0) FROM v3.conditions
    WHERE currency = 'JPY')                                        AS dst_flat_amount,
  (SELECT COALESCE(sum(mg_amount), 0) FROM public.condition_lines
    WHERE COALESCE(currency, 'JPY') = 'JPY')                       AS src_mg,
  (SELECT COALESCE(sum(mg_amount), 0) FROM v3.conditions
    WHERE currency = 'JPY')                                        AS dst_mg;

\echo '--- 向きの分布（3列を1列に畳んだ結果）---'
SELECT direction, count(*) FROM v3.conditions GROUP BY 1 ORDER BY 1;

\echo '--- 案件のフロー種別 ---'
SELECT kind, count(*) FROM v3.matters GROUP BY 1 ORDER BY 1;

\echo '--- 未解決の移行課題 ---'
SELECT rule_code, severity, count(*) AS rows
  FROM v3.data_quality_issues WHERE status = 'open'
 GROUP BY 1, 2 ORDER BY 2, 3 DESC;

COMMIT;
