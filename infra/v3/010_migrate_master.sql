-- =====================================================================
-- V3移行 010：マスタ（取引先・担当者・作品・パート・系譜）
--   冪等。legacy_id をキーに ON CONFLICT DO UPDATE で何度でも流し直せる。
--   実行: psql "$ADMIN_DSN" -f infra/v3/010_migrate_master.sql
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- 取引先：vendors → parties
--   trade_name / pen_name は別名の配列に畳む（名前解決の順序ロジックが消える）。
-- ---------------------------------------------------------------------
INSERT INTO v3.parties (party_code, kind, name, aliases, invoice_no, corporate_no,
                        withholding, status, legacy_id)
SELECT
  NULLIF(v.vendor_code, ''),
  CASE WHEN v.entity_type IN ('個人', 'individual', 'personal') THEN 'individual'
       ELSE 'corporate' END,
  v.vendor_name,
  ARRAY(SELECT DISTINCT a FROM unnest(ARRAY[NULLIF(v.trade_name,''), NULLIF(v.pen_name,'')]) a
         WHERE a IS NOT NULL AND a <> v.vendor_name),
  NULLIF(v.invoice_registration_number, ''),
  NULLIF(v.corporate_number, ''),
  COALESCE(v.withholding_enabled, false),
  CASE WHEN COALESCE(v.is_active, true) THEN 'active' ELSE 'archived' END,
  v.id
FROM public.vendors v
WHERE COALESCE(NULLIF(v.vendor_name, ''), '') <> ''
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  party_code   = EXCLUDED.party_code,
  kind         = EXCLUDED.kind,
  name         = EXCLUDED.name,
  aliases      = EXCLUDED.aliases,
  invoice_no   = EXCLUDED.invoice_no,
  corporate_no = EXCLUDED.corporate_no,
  withholding  = EXCLUDED.withholding,
  status       = EXCLUDED.status,
  updated_at   = now();

-- 連絡先（主担当・署名者）
INSERT INTO v3.party_contacts (party_id, role, name, email, phone, department)
SELECT p.id, 'primary', NULLIF(v.contact_name,''),
       COALESCE(NULLIF(v.contact_email,''), NULLIF(v.email,'')),
       NULLIF(v.phone,''), NULLIF(v.contact_department,'')
  FROM public.vendors v JOIN v3.parties p ON p.legacy_id = v.id
 WHERE COALESCE(v.contact_name, v.contact_email, v.email, v.phone, v.contact_department) IS NOT NULL
ON CONFLICT (party_id, role) DO UPDATE SET
  name = EXCLUDED.name, email = EXCLUDED.email,
  phone = EXCLUDED.phone, department = EXCLUDED.department;

INSERT INTO v3.party_contacts (party_id, role, email)
SELECT p.id, 'signer', v.signer_email
  FROM public.vendors v JOIN v3.parties p ON p.legacy_id = v.id
 WHERE NULLIF(v.signer_email, '') IS NOT NULL
ON CONFLICT (party_id, role) DO UPDATE SET email = EXCLUDED.email;

-- 口座（機微情報は別表へ隔離）
INSERT INTO v3.party_bank_accounts (party_id, bank_name, branch_name, account_type,
                                    account_number, account_holder_kana)
SELECT p.id, NULLIF(v.bank_name,''), NULLIF(v.branch_name,''), NULLIF(v.account_type,''),
       NULLIF(v.account_number,''), NULLIF(v.account_holder_kana,'')
  FROM public.vendors v JOIN v3.parties p ON p.legacy_id = v.id
 WHERE COALESCE(v.bank_name, v.branch_name, v.account_number) IS NOT NULL
ON CONFLICT (party_id) DO UPDATE SET
  bank_name = EXCLUDED.bank_name, branch_name = EXCLUDED.branch_name,
  account_type = EXCLUDED.account_type, account_number = EXCLUDED.account_number,
  account_holder_kana = EXCLUDED.account_holder_kana, updated_at = now();

-- ---------------------------------------------------------------------
-- 担当者
-- ---------------------------------------------------------------------
INSERT INTO v3.staff (name, email, department, legacy_id)
SELECT s.staff_name, NULLIF(s.email,''), NULLIF(s.department,''), s.id
  FROM public.staff s
 WHERE COALESCE(NULLIF(s.staff_name,''), '') <> ''
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  name = EXCLUDED.name, email = EXCLUDED.email, department = EXCLUDED.department;

-- ---------------------------------------------------------------------
-- 作品：works と source_ips を1表に統合（kind で区別）
-- ---------------------------------------------------------------------
INSERT INTO v3.works (work_code, title, title_kana, kind, business_line, status,
                      remarks, legacy_id, legacy_table)
SELECT
  NULLIF(w.work_code, ''), w.title, NULLIF(w.title_kana, ''),
  CASE WHEN w.parent_work_id IS NOT NULL THEN 'derivative' ELSE 'own' END,
  NULLIF(w.business_line, ''),
  CASE
    WHEN NOT COALESCE(w.is_active, true)                    THEN 'archived'
    WHEN w.status IN ('planning','in_production','released') THEN w.status
    WHEN w.status IN ('企画中')                              THEN 'planning'
    WHEN w.status IN ('制作中')                              THEN 'in_production'
    WHEN w.status IN ('発売済','発売済み')                    THEN 'released'
    ELSE 'planning'
  END,
  NULLIF(w.remarks, ''), w.id, 'works'
FROM public.works w
WHERE COALESCE(NULLIF(w.title,''), '') <> ''
ON CONFLICT (legacy_table, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  work_code = EXCLUDED.work_code, title = EXCLUDED.title, title_kana = EXCLUDED.title_kana,
  kind = EXCLUDED.kind, business_line = EXCLUDED.business_line,
  status = EXCLUDED.status, remarks = EXCLUDED.remarks, updated_at = now();

-- source_ips は works と別の表だが、採番は同じ空間を使っている（実データでは
-- source_code と work_code が完全に重なる）。V3 は1表なので work_code の UNIQUE が
-- 効き、そのまま入れると衝突する。同じコードの works が既にいる行は「同一作品の
-- 二重登録」として取り込まず、統合した事実だけ残す。
--   source_ips.id を参照している移行先は無い（020〜040 は触れない）ので、
--   行を落としても解決できなくなる参照は発生しない。
INSERT INTO v3.data_quality_issues (rule_code, target_type, target_id, severity, detail)
SELECT 'WORK_SOURCE_IP_MERGED', 'legacy_source_ip', s.id, 'low',
       jsonb_build_object('source_code', s.source_code,
                          'source_ip_title', s.title,
                          'merged_into_work_code', w.work_code,
                          'merged_into_work_title', w.title,
                          'title_matches', s.title IS NOT DISTINCT FROM w.title)
  FROM public.source_ips s
  JOIN public.works w ON NULLIF(w.work_code, '') = NULLIF(s.source_code, '')
ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
  detail = EXCLUDED.detail, detected_at = now();

-- 取り込むのは works に居ない原作IPだけ。
-- 同一コードが source_ips 内で重複していても1行に落とす（id の小さい方を残す）。
INSERT INTO v3.works (work_code, title, kind, status, legacy_id, legacy_table)
SELECT DISTINCT ON (COALESCE(NULLIF(s.source_code,''), 'id:' || s.id))
       NULLIF(s.source_code,''), s.title, 'source_ip',
       CASE WHEN COALESCE(s.is_active, true) THEN 'released' ELSE 'archived' END,
       s.id, 'source_ips'
  FROM public.source_ips s
 WHERE COALESCE(NULLIF(s.title,''), '') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM public.works w
      WHERE NULLIF(w.work_code, '') = NULLIF(s.source_code, '')
   )
 ORDER BY COALESCE(NULLIF(s.source_code,''), 'id:' || s.id), s.id
ON CONFLICT (legacy_table, legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  work_code = EXCLUDED.work_code, title = EXCLUDED.title,
  status = EXCLUDED.status, updated_at = now();

-- ---------------------------------------------------------------------
-- 構成パート：work_materials → work_parts
--   part_no は material_no を使い、無ければ id 順に採番する。
-- ---------------------------------------------------------------------
INSERT INTO v3.work_parts (work_id, part_no, name, part_type, royalty_bearing, remarks, legacy_id)
SELECT nw.id,
       COALESCE(m.material_no, ROW_NUMBER() OVER (PARTITION BY m.work_id ORDER BY m.id))::int,
       m.material_name,
       COALESCE(NULLIF(m.material_type, ''), 'unspecified'),
       COALESCE(m.is_royalty_bearing, true),
       NULLIF(m.remarks, ''),
       m.id
  FROM public.work_materials m
  JOIN v3.works nw ON nw.legacy_table = 'works' AND nw.legacy_id = m.work_id
 WHERE COALESCE(NULLIF(m.material_name,''), '') <> ''
ON CONFLICT (work_id, part_no) DO UPDATE SET
  name = EXCLUDED.name, part_type = EXCLUDED.part_type,
  royalty_bearing = EXCLUDED.royalty_bearing, remarks = EXCLUDED.remarks,
  legacy_id = EXCLUDED.legacy_id;

-- ---------------------------------------------------------------------
-- 系譜：work_relations と works.parent_work_id を1表に統合
-- ---------------------------------------------------------------------
INSERT INTO v3.work_lineage (parent_work_id, child_work_id, relation_type)
SELECT pw.id, cw.id, COALESCE(NULLIF(r.relation_type,''), 'derivative')
  FROM public.work_relations r
  JOIN v3.works pw ON pw.legacy_table = 'works' AND pw.legacy_id = r.parent_work_id
  JOIN v3.works cw ON cw.legacy_table = 'works' AND cw.legacy_id = r.child_work_id
 WHERE pw.id <> cw.id
ON CONFLICT DO NOTHING;

INSERT INTO v3.work_lineage (parent_work_id, child_work_id, relation_type)
SELECT pw.id, cw.id, 'derivative'
  FROM public.works w
  JOIN v3.works cw ON cw.legacy_table = 'works' AND cw.legacy_id = w.id
  JOIN v3.works pw ON pw.legacy_table = 'works' AND pw.legacy_id = w.parent_work_id
 WHERE w.parent_work_id IS NOT NULL AND pw.id <> cw.id
ON CONFLICT DO NOTHING;

COMMIT;
