\set ON_ERROR_STOP on
\pset pager off

-- 01_import_vendors.sql — 取引先マスタの緊急登録（staging→検証→INSERT）。
-- CSV: work/master_vendors.csv（templates/master_vendors.csv のヘッダーどおり）
-- 実行: psql "$EMERGENCY_DSN" \
--         -v confirm=LEGALBRIDGE_EMERGENCY_WRITE \
--         -v csv=work/master_vendors.csv \
--         -f infra/gcp/emergency/sql/01_import_vendors.sql
-- 冪等性: 同名（vendor_name 完全一致）の既存行はスキップする。

\if :{?confirm}
\else
  \echo '中止: -v confirm=LEGALBRIDGE_EMERGENCY_WRITE を付けて実行してください'
  \quit 2
\endif
SELECT :'confirm' = 'LEGALBRIDGE_EMERGENCY_WRITE' AS ok \gset
\if :ok
\else
  \echo '中止: confirm の値が不正です。何も変更していません。'
  \quit 2
\endif
\if :{?csv}
\else
  \echo '中止: -v csv=work/master_vendors.csv のようにCSVパスを指定してください'
  \quit 2
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE stg_vendors (
  vendor_name text, vendor_code text, trade_name text, pen_name text,
  entity_type text, email text, phone text, contact_name text,
  contact_department text, address text, invoice_registration_number text,
  vendor_rep text, corporate_number text,
  is_invoice_issuer text, withholding_enabled text, is_active text
) ON COMMIT DROP;

\copy stg_vendors FROM :'csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

-- 検証1: vendor_name 必須・staging 内重複なし
SELECT COUNT(*) AS staged_rows FROM stg_vendors;
DO $$
DECLARE bad int;
BEGIN
  SELECT COUNT(*) INTO bad FROM stg_vendors WHERE COALESCE(trim(vendor_name), '') = '';
  IF bad > 0 THEN RAISE EXCEPTION 'vendor_name が空の行が % 行あります。CSVを修正してください', bad; END IF;
  SELECT COUNT(*) INTO bad FROM (
    SELECT vendor_name FROM stg_vendors GROUP BY vendor_name HAVING COUNT(*) > 1) d;
  IF bad > 0 THEN RAISE EXCEPTION 'CSV内で vendor_name が重複しています（%件）', bad; END IF;
END $$;

-- 検証2: 既存と同名の行（スキップ対象）を表示
\echo '--- 既存と同名のためスキップされる行 ---'
SELECT s.vendor_name
  FROM stg_vendors s
  JOIN vendors v ON v.vendor_name = s.vendor_name;

-- 登録（既存同名はスキップ。真偽値は小文字化して解釈・既定は通常系と同じ）
WITH ins AS (
  INSERT INTO vendors (
    vendor_name, vendor_code, trade_name, pen_name, entity_type, email, phone,
    contact_name, contact_department, address, invoice_registration_number,
    vendor_rep, corporate_number, is_invoice_issuer, withholding_enabled, is_active
  )
  SELECT
    trim(s.vendor_name),
    NULLIF(trim(s.vendor_code), ''),
    NULLIF(trim(s.trade_name), ''), NULLIF(trim(s.pen_name), ''),
    NULLIF(trim(s.entity_type), ''), NULLIF(trim(s.email), ''), NULLIF(trim(s.phone), ''),
    NULLIF(trim(s.contact_name), ''), NULLIF(trim(s.contact_department), ''),
    NULLIF(trim(s.address), ''), NULLIF(trim(s.invoice_registration_number), ''),
    NULLIF(trim(s.vendor_rep), ''), NULLIF(trim(s.corporate_number), ''),
    lower(COALESCE(NULLIF(trim(s.is_invoice_issuer), ''), 'false')) = 'true',
    lower(COALESCE(NULLIF(trim(s.withholding_enabled), ''), 'false')) = 'true',
    lower(COALESCE(NULLIF(trim(s.is_active), ''), 'true')) <> 'false'
  FROM stg_vendors s
  WHERE NOT EXISTS (SELECT 1 FROM vendors v WHERE v.vendor_name = trim(s.vendor_name))
  RETURNING id, vendor_name, vendor_code
)
SELECT COUNT(*) AS inserted_rows FROM ins;

-- vendor_code が空の新規行へ通常系と同じ形式（VEN-00000）で採番
UPDATE vendors
   SET vendor_code = 'VEN-' || lpad(id::text, 5, '0')
 WHERE vendor_code IS NULL
    OR vendor_code = ''
    OR vendor_code = 'PENDING';

-- 結果照合（今回CSVに含まれる名称の最終状態）
\echo '--- 登録結果（この一覧を記録票に添付）---'
SELECT v.id, v.vendor_name, v.vendor_code, v.is_active
  FROM vendors v
  JOIN stg_vendors s ON s.vendor_name = v.vendor_name
 ORDER BY v.id;

\echo '件数・内容が承認どおりであることを確認してから COMMIT してください。'
\echo '想定と違う場合は ROLLBACK; を実行してください。'
COMMIT;
