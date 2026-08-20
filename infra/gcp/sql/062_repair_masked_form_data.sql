\set ON_ERROR_STOP on
\pset pager off

-- 062_repair_masked_form_data.sql
-- マスク値の保存事故の修復。表示時マスキング（2026-08-19 撤廃）が有効な間に
-- 特例編集・複製を確定した文書・下書きに、マスク済み文字列（********o.jp 等）が
-- 実データとして保存された。実値は取引先・担当者マスタに残っているので書き戻す。
--   ・対象キー（取引先由来）: VENDOR_EMAIL / VENDOR_PHONE / VENDOR_CONTACT_PHONE /
--     BANK_NAME / BRANCH_NAME / ACCOUNT_TYPE / ACCOUNT_NUMBER / ACCOUNT_HOLDER_KANA
--   ・対象キー（担当者由来）: STAFF_EMAIL / STAFF_PHONE（STAFF_NAME でマスタ照合）
--   ・「値が * で始まる」ものだけ上書きする＝正常値には一切触れない（冪等）。
--   ・lifecycle を問わず全文書＋下書きを直す（reissued の旧版も、以後の特例編集の
--     下敷きになるため直しておく）。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_masked_repair=REPAIR_MASKED_FORM_DATA \
--         -f infra/gcp/sql/062_repair_masked_form_data.sql

\if :{?confirm_masked_repair}
\else
  \echo 'Run with: -v confirm_masked_repair=REPAIR_MASKED_FORM_DATA'
  \quit 2
\endif
SELECT :'confirm_masked_repair' = 'REPAIR_MASKED_FORM_DATA' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 修復前の汚染件数（記録用）
SELECT 'before: documents' AS scope, COUNT(*) AS contaminated
  FROM documents d
 WHERE jsonb_typeof(d.form_data) = 'object'
   AND EXISTS (SELECT 1 FROM jsonb_each_text(d.form_data) kv WHERE kv.value ~ '^\*+');

-- 1) 文書 × 取引先マスタ（documents.vendor_id で照合）
UPDATE documents d
   SET form_data = d.form_data
     || CASE WHEN d.form_data->>'VENDOR_EMAIL'        ~ '^\*+' AND COALESCE(v.email, '') <> ''               THEN jsonb_build_object('VENDOR_EMAIL', v.email) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'VENDOR_PHONE'        ~ '^\*+' AND COALESCE(v.phone, '') <> ''               THEN jsonb_build_object('VENDOR_PHONE', v.phone) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'VENDOR_CONTACT_PHONE' ~ '^\*+' AND COALESCE(v.phone, '') <> ''              THEN jsonb_build_object('VENDOR_CONTACT_PHONE', v.phone) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'BANK_NAME'           ~ '^\*+' AND COALESCE(v.bank_name, '') <> ''           THEN jsonb_build_object('BANK_NAME', v.bank_name) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'BRANCH_NAME'         ~ '^\*+' AND COALESCE(v.branch_name, '') <> ''         THEN jsonb_build_object('BRANCH_NAME', v.branch_name) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'ACCOUNT_TYPE'        ~ '^\*+' AND COALESCE(v.account_type, '') <> ''        THEN jsonb_build_object('ACCOUNT_TYPE', v.account_type) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'ACCOUNT_NUMBER'      ~ '^\*+' AND COALESCE(v.account_number, '') <> ''      THEN jsonb_build_object('ACCOUNT_NUMBER', v.account_number) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'ACCOUNT_HOLDER_KANA' ~ '^\*+' AND COALESCE(v.account_holder_kana, '') <> '' THEN jsonb_build_object('ACCOUNT_HOLDER_KANA', v.account_holder_kana) ELSE '{}'::jsonb END,
       updated_at = now()
  FROM vendors v
 WHERE v.id = d.vendor_id
   AND jsonb_typeof(d.form_data) = 'object'
   AND EXISTS (
     SELECT 1 FROM jsonb_each_text(d.form_data) kv
      WHERE kv.key IN ('VENDOR_EMAIL','VENDOR_PHONE','VENDOR_CONTACT_PHONE','BANK_NAME',
                       'BRANCH_NAME','ACCOUNT_TYPE','ACCOUNT_NUMBER','ACCOUNT_HOLDER_KANA')
        AND kv.value ~ '^\*+');

-- 2) 文書 × 担当者マスタ（form_data の STAFF_NAME で照合）
UPDATE documents d
   SET form_data = d.form_data
     || CASE WHEN d.form_data->>'STAFF_EMAIL' ~ '^\*+' AND COALESCE(s.email, '') <> '' THEN jsonb_build_object('STAFF_EMAIL', s.email) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'STAFF_PHONE' ~ '^\*+' AND COALESCE(s.phone, '') <> '' THEN jsonb_build_object('STAFF_PHONE', s.phone) ELSE '{}'::jsonb END,
       updated_at = now()
  FROM staff s
 WHERE s.staff_name = d.form_data->>'STAFF_NAME'
   AND jsonb_typeof(d.form_data) = 'object'
   AND (d.form_data->>'STAFF_EMAIL' ~ '^\*+' OR d.form_data->>'STAFF_PHONE' ~ '^\*+');

-- 3) 下書き × 取引先（VENDOR_NAME で照合・同名は1件目）
UPDATE document_drafts d
   SET form_data = d.form_data
     || CASE WHEN d.form_data->>'VENDOR_EMAIL'        ~ '^\*+' AND COALESCE(v.email, '') <> ''               THEN jsonb_build_object('VENDOR_EMAIL', v.email) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'VENDOR_PHONE'        ~ '^\*+' AND COALESCE(v.phone, '') <> ''               THEN jsonb_build_object('VENDOR_PHONE', v.phone) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'VENDOR_CONTACT_PHONE' ~ '^\*+' AND COALESCE(v.phone, '') <> ''              THEN jsonb_build_object('VENDOR_CONTACT_PHONE', v.phone) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'BANK_NAME'           ~ '^\*+' AND COALESCE(v.bank_name, '') <> ''           THEN jsonb_build_object('BANK_NAME', v.bank_name) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'BRANCH_NAME'         ~ '^\*+' AND COALESCE(v.branch_name, '') <> ''         THEN jsonb_build_object('BRANCH_NAME', v.branch_name) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'ACCOUNT_TYPE'        ~ '^\*+' AND COALESCE(v.account_type, '') <> ''        THEN jsonb_build_object('ACCOUNT_TYPE', v.account_type) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'ACCOUNT_NUMBER'      ~ '^\*+' AND COALESCE(v.account_number, '') <> ''      THEN jsonb_build_object('ACCOUNT_NUMBER', v.account_number) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'ACCOUNT_HOLDER_KANA' ~ '^\*+' AND COALESCE(v.account_holder_kana, '') <> '' THEN jsonb_build_object('ACCOUNT_HOLDER_KANA', v.account_holder_kana) ELSE '{}'::jsonb END
  FROM (
    -- UPDATE の FROM では対象テーブルを LATERAL 参照できないため、
    -- 同名取引先の重複排除は DISTINCT ON（有効を優先・次に id 順）で行う。
    SELECT DISTINCT ON (vendor_name)
           vendor_name, email, phone, bank_name, branch_name,
           account_type, account_number, account_holder_kana
      FROM vendors
     ORDER BY vendor_name, is_active DESC, id
  ) v
 WHERE v.vendor_name = d.form_data->>'VENDOR_NAME'
   AND jsonb_typeof(d.form_data) = 'object'
   AND EXISTS (
     SELECT 1 FROM jsonb_each_text(d.form_data) kv
      WHERE kv.key IN ('VENDOR_EMAIL','VENDOR_PHONE','VENDOR_CONTACT_PHONE','BANK_NAME',
                       'BRANCH_NAME','ACCOUNT_TYPE','ACCOUNT_NUMBER','ACCOUNT_HOLDER_KANA')
        AND kv.value ~ '^\*+');

-- 4) 下書き × 担当者
UPDATE document_drafts d
   SET form_data = d.form_data
     || CASE WHEN d.form_data->>'STAFF_EMAIL' ~ '^\*+' AND COALESCE(s.email, '') <> '' THEN jsonb_build_object('STAFF_EMAIL', s.email) ELSE '{}'::jsonb END
     || CASE WHEN d.form_data->>'STAFF_PHONE' ~ '^\*+' AND COALESCE(s.phone, '') <> '' THEN jsonb_build_object('STAFF_PHONE', s.phone) ELSE '{}'::jsonb END
  FROM staff s
 WHERE s.staff_name = d.form_data->>'STAFF_NAME'
   AND jsonb_typeof(d.form_data) = 'object'
   AND (d.form_data->>'STAFF_EMAIL' ~ '^\*+' OR d.form_data->>'STAFF_PHONE' ~ '^\*+');

-- 修復後に残ったマスク値（マスタで解決できなかったもの＝手で直す対象）。0行が理想。
SELECT 'after: documents' AS scope, d.document_number, kv.key, kv.value
  FROM documents d, jsonb_each_text(d.form_data) kv
 WHERE jsonb_typeof(d.form_data) = 'object'
   AND kv.value ~ '^\*+'
 ORDER BY d.created_at DESC
 LIMIT 50;

SELECT 'after: drafts' AS scope, d.issue_key, kv.key, kv.value
  FROM document_drafts d, jsonb_each_text(d.form_data) kv
 WHERE jsonb_typeof(d.form_data) = 'object'
   AND kv.value ~ '^\*+'
 ORDER BY d.updated_at DESC
 LIMIT 50;

COMMIT;
