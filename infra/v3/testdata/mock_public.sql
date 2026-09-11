-- =====================================================================
-- 移行スクリプトのローカル検証用。本番へは絶対に適用しない。
--   V1 相当の public スキーマを最小構成で再現し、移行の難所を網羅する:
--     向き3列の欠落パターン / 範囲のテキストと正規化の混在 / 外貨 /
--     テンプレ無し取込文書 / void・旧版 / 未名寄せの相手先
-- =====================================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE public.vendors (
  id serial PRIMARY KEY, vendor_name text, vendor_code text, entity_type text,
  trade_name text, pen_name text, email text, phone text,
  contact_name text, contact_email text, contact_department text, signer_email text,
  address text,
  invoice_registration_number text, corporate_number text,
  withholding_enabled boolean, is_active boolean DEFAULT true,
  bank_name text, branch_name text, account_type text, account_number text, account_holder_kana text
);
CREATE TABLE public.staff (id serial PRIMARY KEY, staff_name text, email text, phone text, department text);
CREATE TABLE public.works (
  id serial PRIMARY KEY, title text, title_kana text, work_code text, kind text, work_type text,
  status text, business_line text, ledger_code text, remarks text, is_active boolean DEFAULT true,
  parent_work_id integer, rights_holder_vendor_id integer);
CREATE TABLE public.source_ips (id serial PRIMARY KEY, source_code text, title text, is_active boolean DEFAULT true);
CREATE TABLE public.work_materials (
  id serial PRIMARY KEY, work_id integer, material_no integer, material_name text,
  material_type text, is_royalty_bearing boolean, remarks text, rights_holder_vendor_id integer);
CREATE TABLE public.work_relations (parent_work_id integer, child_work_id integer, relation_type text);
CREATE TABLE public.contracts (
  id serial PRIMARY KEY, document_number text, contract_title text, primary_vendor_id integer,
  contract_status text, executed_at timestamptz, effective_date date, expiration_date date,
  auto_renewal boolean, renewal_notice_months integer, source_system text, document_url text);
CREATE TABLE public.document_templates (
  id serial PRIMARY KEY, template_key text, label text, category text,
  document_prefix text, current_version_id integer, is_active boolean DEFAULT true);
CREATE TABLE public.document_template_versions (
  id serial PRIMARY KEY, template_id integer, version_no integer, html_source text, field_schema jsonb);
CREATE TABLE public.matters (
  id serial PRIMARY KEY, matter_code text, title text, status text, matter_kind text,
  owner_staff_id integer, counterparty text, vendor_id integer, primary_issue_key text,
  target_due_date date, blocked_reason text, remarks text, drive_folder_url text,
  created_by text, created_at timestamptz DEFAULT now(), completed_at timestamptz);
CREATE TABLE public.matter_tasks (
  id serial PRIMARY KEY, matter_id integer, title text, task_type text,
  assignee_staff_id integer, due_at timestamptz, status text, blocked_reason text);
CREATE TABLE public.matter_issues (
  id serial PRIMARY KEY, matter_id integer, backlog_issue_key text, relation text, summary_snapshot text);
CREATE TABLE public.legal_requests (
  id serial PRIMARY KEY, backlog_issue_key text, summary text, deadline timestamptz);
CREATE TABLE public.documents (
  id serial PRIMARY KEY, document_number text, template_type text, template_version_id integer,
  form_data jsonb, matter_id integer, contract_id integer, lifecycle_status text,
  drive_link text, created_at timestamptz DEFAULT now(), created_by text, vendor_id integer,
  contract_title text, effective_date date, expiration_date date,
  auto_renewal boolean, renewal_notice_months integer);
CREATE TABLE public.document_sequences (kind text, year integer, current_value integer);
CREATE TABLE public.condition_lines (
  id serial PRIMARY KEY, document_id integer, line_no integer, line_code text,
  work_id integer, source_work_id integer, source_material_id integer,
  counterparty_vendor_id integer, direction text, flow_direction text, is_inbound boolean,
  transaction_kind text, line_kind text DEFAULT 'payment', tax_category text,
  condition_name text, region_territory text, region_language text,
  exclusivity text, sublicense_allowed boolean, term_start date, term_end date,
  currency text, rate_pct numeric, unit_amount numeric, amount_ex_tax numeric,
  mg_amount numeric, ag_amount numeric, calc_type text, calc_method text,
  payment_scheme text, payment_terms text, royalty_base text, deductible_costs text,
  cycle text, notes text, parent_license_condition_id integer);
CREATE TABLE public.condition_line_regions (
  id serial PRIMARY KEY, condition_line_id integer, country_name text, sort_order integer);
CREATE TABLE public.condition_line_languages (
  id serial PRIMARY KEY, condition_line_id integer, language_name text, sort_order integer);
CREATE TABLE public.condition_line_installments (
  id serial PRIMARY KEY, condition_line_id integer, installment_no integer,
  trigger_kind text, planned_amount_ex_tax numeric, due_date date);
CREATE TABLE public.condition_events (
  id serial PRIMARY KEY, condition_line_id integer, installment_id integer, event_no integer,
  event_type text, occurred_at timestamptz, amount_ex_tax numeric, period text,
  document_id integer, voided_at timestamptz);
CREATE TABLE public.payments (
  id serial PRIMARY KEY, payment_no text, counterparty_vendor_id integer, direction text,
  currency text, amount_ex_tax numeric, total_amount numeric, tax_rate numeric,
  tax_amount numeric, withholding_tax numeric, fx_rate numeric,
  due_date date, paid_date date, status text);

-- ---- データ ----
INSERT INTO vendors (id,vendor_name,vendor_code,entity_type,trade_name,pen_name,contact_name,contact_email,signer_email,withholding_enabled,bank_name,account_number) VALUES
 (1,'如月 涼','VD-00104','個人',NULL,'如月りょう','如月 涼','ryo@example.test','ryo@example.test',true,'さくら銀行','1234567'),
 (2,'合同会社アトリエ蒼','VD-00317','法人','アトリエ蒼',NULL,'青柳 みなも','contact@ao.test','sign@ao.test',false,NULL,NULL),
 (3,'晨光數位出版股份有限公司','VD-00512','法人',NULL,NULL,NULL,'acct@cg.test',NULL,false,NULL,NULL),
 (4,'廃止取引先','VD-00901','法人',NULL,NULL,NULL,NULL,NULL,false,NULL,NULL);
UPDATE vendors SET is_active=false WHERE id=4;
INSERT INTO staff (id,staff_name,email,department) VALUES (1,'倉持','kuramochi@example.test','法務'),(2,'南','minami@example.test','法務');
INSERT INTO works (id,title,title_kana,work_code,status,business_line,is_active,parent_work_id) VALUES
 (10,'星降る夜のミュゼ','ホシフルヨルノミュゼ','WRK-10013','発売済','コミック',true,NULL),
 (11,'星降る夜のミュゼ 繁体字版',NULL,'WRK-10119','制作中','コミック',true,10),
 (12,'休刊作品',NULL,'WRK-10500','企画中',NULL,false,NULL);
INSERT INTO source_ips (id,source_code,title) VALUES (5,'SRC-0004','小説 星降る夜のミュゼ');
INSERT INTO work_materials (id,work_id,material_no,material_name,material_type,is_royalty_bearing) VALUES
 (101,10,1,'本文','manuscript',true),(102,10,2,'挿絵','illustration',true),(103,10,NULL,'装丁','design',false);
INSERT INTO work_relations (parent_work_id,child_work_id,relation_type) VALUES (10,11,'translation');
INSERT INTO contracts (id,document_number,contract_title,primary_vendor_id,contract_status,executed_at,effective_date,expiration_date,auto_renewal,renewal_notice_months) VALUES
 (201,'AGR-2026-0088','繁体字版 配信許諾契約',3,'executed','2026-04-02','2026-04-01','2029-03-31',true,3),
 (202,'AGR-2025-0011','制作業務委託基本契約',2,'executed','2025-04-01','2025-04-01',NULL,true,1),
 (203,'AGR-2020-0001','相手先未設定の旧契約',NULL,'executed',NULL,NULL,NULL,false,NULL);
INSERT INTO document_templates (id,template_key,label,category,document_prefix,current_version_id) VALUES
 (301,'royalty_statement','利用許諾料計算書','license','ARC-RS',401),
 (302,'purchase_order','発注書','service','ARC-PO',402);
INSERT INTO document_template_versions (id,template_id,version_no,html_source,field_schema) VALUES
 (401,301,9,'<h1>計算書</h1>','[{"name":"PERIOD"}]'),(402,302,3,'<h1>発注書</h1>','[]');
INSERT INTO matters (id,matter_code,title,status,matter_kind,owner_staff_id,counterparty,vendor_id,primary_issue_key,target_due_date,blocked_reason,completed_at) VALUES
 (501,'MTR-2026-00218','繁体字版 配信許諾','waiting','license',1,'晨光數位出版',3,'LEGAL-284','2026-09-16','先方回答待ち',NULL),
 (502,'MTR-2026-00217','挿絵 追加発注','open','service',1,'合同会社アトリエ蒼',2,'LEGAL-291','2026-09-09',NULL,NULL),
 (503,'MTR-2026-00209','NDA（新規取次）','完了','unclassified',2,'株式会社ブックウェイ',NULL,'LEGAL-276','2026-08-30',NULL,'2026-08-30');
INSERT INTO matter_tasks (id,matter_id,title,assignee_staff_id,due_at,status,blocked_reason) VALUES
 (601,501,'配信開始日の確認',1,'2026-09-16','doing','先方回答待ち'),(602,501,'計算書の送付',1,'2026-08-29','完了',NULL);
INSERT INTO matter_issues (matter_id,backlog_issue_key,relation,summary_snapshot) VALUES
 (501,'LEGAL-284','origin','繁体字版の配信許諾について');
INSERT INTO legal_requests (backlog_issue_key,summary,deadline) VALUES ('LEGAL-284','繁体字版の配信許諾について','2026-09-16');
INSERT INTO documents (id,document_number,template_type,template_version_id,form_data,matter_id,contract_id,lifecycle_status,drive_link,created_by) VALUES
 (701,'ARC-RS-2026-0007','royalty_statement',401,'{"PERIOD":"2026上期","LICENSEE_NAME":"晨光數位出版"}',501,201,'final','https://drive.test/1','kuramochi'),
 (702,'ARC-RS-2026-0003','royalty_statement',401,'{"PERIOD":"2025下期","superseded_by":"ARC-RS-2026-0007"}',501,201,'reissued','','kuramochi'),
 (703,'ARC-PO-2026-0031','purchase_order',402,'{"VENDOR_NAME":"合同会社アトリエ蒼"}',502,202,'final','','kuramochi'),
 (704,'ARC-OLD-0001','registered_master',NULL,'{"許諾者":"廃止取引先"}',NULL,203,'final','https://drive.test/old','import'),
 (705,'ARC-PO-2025-0009','purchase_order',402,'{"VENDOR_NAME":"合同会社アトリエ蒼"}',NULL,202,'voided','','kuramochi');
INSERT INTO document_sequences (kind,year,current_value) VALUES ('ARC-RS',2026,7),('ARC-PO',2026,31);
-- 条件：向きの欠落パターンと範囲の持ち方を散らす
INSERT INTO condition_lines (id,document_id,line_no,line_code,work_id,source_material_id,counterparty_vendor_id,
  direction,flow_direction,is_inbound,transaction_kind,condition_name,region_territory,region_language,
  exclusivity,sublicense_allowed,term_start,term_end,currency,rate_pct,amount_ex_tax,mg_amount,ag_amount,calc_type,notes) VALUES
 -- flow_direction あり・範囲は正規化テーブル
 (801,701,1,'CL-2026-00042',10,NULL,3,'receivable','out',false,'license','繁体字版 電子書籍 配信許諾',NULL,NULL,'non_exclusive',false,'2026-04-01','2029-03-31','JPY',12.5,NULL,1200000,800000,'BASE_RATE','半期締め'),
 -- flow_direction 無し・direction のみ・範囲はテキスト列
 (802,NULL,1,'CL-2026-00041',10,NULL,3,'receivable',NULL,NULL,'license','英語版 単行本 出版許諾','北米・欧州','英語','exclusive',true,'2026-01-01','2028-12-31','USD',8.0,NULL,NULL,NULL,NULL,NULL),
 -- direction も無く is_inbound のみ
 (803,703,1,'CL-2026-00031',10,102,2,NULL,NULL,true,'service','挿絵 第4巻 制作委託',NULL,NULL,NULL,NULL,'2026-07-20','2026-08-28','JPY',NULL,784000,NULL,NULL,'FIXED',NULL),
 -- 経費行
 (804,703,2,'CL-2026-00032',10,NULL,2,'payable','in',true,'service','資料取材の実費',NULL,NULL,NULL,NULL,NULL,NULL,'JPY',NULL,12000,NULL,NULL,NULL,NULL),
 -- void 文書にぶら下がる条件
 (805,705,1,'CL-2025-00099',10,NULL,2,'payable','in',true,'service','旧発注（無効）',NULL,NULL,NULL,NULL,NULL,NULL,'JPY',NULL,50000,NULL,NULL,NULL,NULL),
 -- 相手先が解決できない行（090 で拾われる）
 (806,NULL,1,'CL-2019-00001',NULL,NULL,999,'payable',NULL,NULL,'service','相手先不明の旧条件',NULL,NULL,NULL,NULL,NULL,NULL,'JPY',NULL,1000,NULL,NULL,NULL,NULL);
UPDATE condition_lines SET line_kind='expense', tax_category='taxable' WHERE id=804;
UPDATE condition_lines SET parent_license_condition_id=801 WHERE id=802;
INSERT INTO condition_line_regions (condition_line_id,country_name,sort_order) VALUES (801,'台湾',0),(801,'香港',1),(801,'マカオ',2);
INSERT INTO condition_line_languages (condition_line_id,language_name,sort_order) VALUES (801,'繁体字中国語',0);
INSERT INTO condition_line_installments (id,condition_line_id,installment_no,trigger_kind,planned_amount_ex_tax,due_date) VALUES
 (901,803,1,'on_inspection',784000,'2026-10-27'),(902,801,1,'periodic',600000,'2026-11-30');
INSERT INTO condition_events (id,condition_line_id,installment_id,event_no,event_type,occurred_at,amount_ex_tax,period,voided_at) VALUES
 (1001,801,902,1,'sales','2026-08-20',612000,'2026上期',NULL),
 (1002,801,NULL,2,'royalty_calc','2026-02-18',431000,'2025下期',NULL),
 (1003,803,901,1,'inspection','2026-09-05',784000,NULL,'2026-09-06');
INSERT INTO payments (id,counterparty_vendor_id,direction,currency,amount_ex_tax,total_amount,due_date,paid_date,status) VALUES
 (1101,1,'payable','JPY',600000,660000,'2026-09-10',NULL,'approved'),
 (1102,2,'payable','JPY',784000,862400,'2026-10-27',NULL,'planned');

COMMIT;
