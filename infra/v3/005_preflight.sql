-- =====================================================================
-- V3移行 preflight：移行元の列が実在するかを確認する（読み取りのみ）
--   移行スクリプトが参照する public 側の列を宣言し、実DBと突き合わせる。
--   exists=false の行が1つでもあれば、その列を使う移行スクリプトを直すこと。
--
--   実行: psql "$READONLY_DSN" -f infra/v3/005_preflight.sql
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE TEMP TABLE expected_source (
  table_name  text NOT NULL,
  column_name text NOT NULL,
  used_by     text NOT NULL,
  required    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (table_name, column_name)
) ON COMMIT PRESERVE ROWS;

INSERT INTO expected_source (table_name, column_name, used_by, required) VALUES
  -- 010 マスタ
  ('vendors','id','010',true),               ('vendors','vendor_name','010',true),
  ('vendors','vendor_code','010',false),     ('vendors','entity_type','010',false),
  ('vendors','trade_name','010',false),      ('vendors','pen_name','010',false),
  ('vendors','email','010',false),           ('vendors','phone','010',false),
  ('vendors','contact_name','010',false),    ('vendors','contact_email','010',false),
  ('vendors','contact_department','010',false), ('vendors','signer_email','010',false),
  ('vendors','invoice_registration_number','010',false),
  ('vendors','corporate_number','010',false),('vendors','withholding_enabled','010',false),
  ('vendors','is_active','010',false),       ('vendors','bank_name','010',false),
  ('vendors','branch_name','010',false),     ('vendors','account_type','010',false),
  ('vendors','account_number','010',false),  ('vendors','account_holder_kana','010',false),
  ('staff','id','010',true),                 ('staff','staff_name','010',true),
  ('staff','email','010',false),             ('staff','department','010',false),
  ('works','id','010',true),                 ('works','title','010',true),
  ('works','work_code','010',false),         ('works','title_kana','010',false),
  ('works','kind','010',false),              ('works','work_type','010',false),
  ('works','status','010',false),            ('works','business_line','010',false),
  ('works','remarks','010',false),           ('works','is_active','010',false),
  ('works','parent_work_id','010',false),
  ('source_ips','id','010',false),           ('source_ips','title','010',false),
  ('source_ips','source_code','010',false),  ('source_ips','is_active','010',false),
  ('work_materials','id','010',true),        ('work_materials','work_id','010',true),
  ('work_materials','material_name','010',true), ('work_materials','material_no','010',false),
  ('work_materials','material_type','010',false),('work_materials','is_royalty_bearing','010',false),
  ('work_materials','remarks','010',false),
  ('work_relations','parent_work_id','010',false),('work_relations','child_work_id','010',false),
  ('work_relations','relation_type','010',false),
  -- 020 コア
  ('contracts','id','020',true),             ('contracts','contract_title','020',false),
  ('contracts','document_number','020',false),('contracts','primary_vendor_id','020',false),
  ('contracts','contract_status','020',false),('contracts','executed_at','020',false),
  ('contracts','effective_date','020',false),('contracts','expiration_date','020',false),
  ('contracts','auto_renewal','020',false),  ('contracts','renewal_notice_months','020',false),
  ('contracts','source_system','020',false), ('contracts','document_url','020',false),
  ('condition_lines','id','020',true),       ('condition_lines','condition_name','020',true),
  ('condition_lines','document_id','020',false),('condition_lines','work_id','020',false),
  ('condition_lines','source_work_id','020',false),
  ('condition_lines','source_material_id','020',false),
  ('condition_lines','counterparty_vendor_id','020',false),
  ('condition_lines','direction','020',false),('condition_lines','flow_direction','020',false),
  ('condition_lines','is_inbound','020',false),('condition_lines','transaction_kind','020',false),
  ('condition_lines','line_kind','020',false),('condition_lines','tax_category','020',false),
  ('condition_lines','exclusivity','020',false),('condition_lines','sublicense_allowed','020',false),
  ('condition_lines','term_start','020',false),('condition_lines','term_end','020',false),
  ('condition_lines','currency','020',false), ('condition_lines','rate_pct','020',false),
  ('condition_lines','unit_amount','020',false),('condition_lines','amount_ex_tax','020',false),
  ('condition_lines','mg_amount','020',false),('condition_lines','ag_amount','020',false),
  ('condition_lines','calc_type','020',false),('condition_lines','calc_method','020',false),
  ('condition_lines','payment_scheme','020',false),('condition_lines','payment_terms','020',false),
  ('condition_lines','royalty_base','020',false),('condition_lines','deductible_costs','020',false),
  ('condition_lines','cycle','020',false),   ('condition_lines','notes','020',false),
  ('condition_lines','line_no','020',false), ('condition_lines','line_code','020',false),
  ('condition_lines','parent_license_condition_id','020',false),
  ('condition_lines','region_territory','020',false),
  ('condition_lines','region_language','020',false),
  ('condition_line_regions','condition_line_id','020',false),
  ('condition_line_regions','country_name','020',false),
  ('condition_line_languages','condition_line_id','020',false),
  ('condition_line_languages','language_name','020',false),
  ('condition_line_installments','id','020',false),
  ('condition_line_installments','condition_line_id','020',false),
  ('condition_line_installments','installment_no','020',false),
  ('condition_line_installments','trigger_kind','020',false),
  ('condition_line_installments','planned_amount_ex_tax','020',false),
  ('condition_line_installments','due_date','020',false),
  ('condition_events','id','020',false),     ('condition_events','condition_line_id','020',false),
  ('condition_events','event_type','020',false),('condition_events','occurred_at','020',false),
  ('condition_events','amount_ex_tax','020',false),('condition_events','period','020',false),
  ('condition_events','document_id','020',false),('condition_events','voided_at','020',false),
  ('payments','id','020',false),             ('payments','counterparty_vendor_id','020',false),
  ('payments','direction','020',false),      ('payments','currency','020',false),
  ('payments','amount_ex_tax','020',false),  ('payments','total_amount','020',false),
  ('payments','due_date','020',false),       ('payments','paid_date','020',false),
  ('payments','status','020',false),
  -- 030 文書
  ('document_templates','id','030',true),    ('document_templates','template_key','030',true),
  ('document_templates','label','030',false),('document_templates','category','030',false),
  ('document_templates','document_prefix','030',false),
  ('document_templates','current_version_id','030',false),
  ('document_templates','is_active','030',false),
  ('document_template_versions','id','030',true),
  ('document_template_versions','template_id','030',true),
  ('document_template_versions','version_no','030',true),
  ('document_template_versions','html_source','030',true),
  ('document_template_versions','field_schema','030',false),
  ('documents','id','030',true),             ('documents','document_number','030',false),
  ('documents','template_type','030',true),  ('documents','template_version_id','030',false),
  ('documents','form_data','030',true),      ('documents','matter_id','030',false),
  ('documents','contract_id','030',false),   ('documents','lifecycle_status','030',false),
  ('documents','drive_link','030',false),    ('documents','created_at','030',false),
  ('documents','created_by','030',false),    ('documents','vendor_id','030',false),
  ('documents','contract_title','030',false),('documents','effective_date','030',false),
  ('documents','expiration_date','030',false),('documents','auto_renewal','030',false),
  ('documents','renewal_notice_months','030',false),
  ('document_sequences','kind','030',false), ('document_sequences','year','030',false),
  ('document_sequences','current_value','030',false),
  -- 040 案件
  ('matters','id','040',true),               ('matters','title','040',true),
  ('matters','matter_code','040',false),     ('matters','status','040',false),
  ('matters','matter_kind','040',false),     ('matters','owner_staff_id','040',false),
  ('matters','counterparty','040',false),    ('matters','vendor_id','040',false),
  ('matters','primary_issue_key','040',false),('matters','target_due_date','040',false),
  ('matters','blocked_reason','040',false),  ('matters','remarks','040',false),
  ('matters','drive_folder_url','040',false),('matters','created_by','040',false),
  ('matters','created_at','040',false),      ('matters','completed_at','040',false),
  ('matter_issues','matter_id','040',false), ('matter_issues','backlog_issue_key','040',false),
  ('matter_issues','relation','040',false),  ('matter_issues','summary_snapshot','040',false),
  ('matter_tasks','id','040',false),         ('matter_tasks','matter_id','040',false),
  ('matter_tasks','title','040',false),      ('matter_tasks','status','040',false),
  ('matter_tasks','assignee_staff_id','040',false),('matter_tasks','due_at','040',false),
  ('legal_requests','id','040',false),       ('legal_requests','backlog_issue_key','040',false),
  ('legal_requests','summary','040',false),  ('legal_requests','deadline','040',false);

COMMIT;

BEGIN READ ONLY;

\echo '--- 欠落している列（required=true は移行前に必ず解消する）---'
SELECT e.used_by, e.table_name, e.column_name, e.required
  FROM expected_source e
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = e.table_name AND c.column_name = e.column_name
 WHERE c.column_name IS NULL
 ORDER BY e.required DESC, e.used_by, e.table_name, e.column_name;

\echo '--- 移行元の件数 ---'
SELECT 'vendors' AS t, count(*) FROM public.vendors
UNION ALL SELECT 'staff', count(*) FROM public.staff
UNION ALL SELECT 'works', count(*) FROM public.works
UNION ALL SELECT 'work_materials', count(*) FROM public.work_materials
UNION ALL SELECT 'contracts', count(*) FROM public.contracts
UNION ALL SELECT 'condition_lines', count(*) FROM public.condition_lines
UNION ALL SELECT 'documents', count(*) FROM public.documents
UNION ALL SELECT 'matters', count(*) FROM public.matters
ORDER BY 1;

\echo '--- form_data の相手先キーの分布（030 の解決順を決める材料）---'
SELECT key, count(*) AS rows
  FROM public.documents d,
       LATERAL unnest(ARRAY['VENDOR_NAME','Licensor_氏名会社名','Licensor_名称','許諾者','相手先',
                            '取引先','counterparty','LICENSOR_NAME','licensor','designerName',
                            'PARTY_A_NAME']) AS key
 WHERE NULLIF(d.form_data->>key, '') IS NOT NULL
 GROUP BY key ORDER BY rows DESC;

COMMIT;
