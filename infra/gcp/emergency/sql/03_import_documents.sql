\set ON_ERROR_STOP on
\pset pager off

-- 03_import_documents.sql — 確定文書の緊急登録（staging→検証→INSERT）。
-- CSV: work/documents_generic.csv（1ファイル1行を原則。templates/documents_generic.csv のヘッダー）
--   emergency_ref   : 必須。再実行防止キー（例: EMG-20260821-INC123-01）。form_data 内
--                     EMERGENCY_REF として保存し、同一キーの再登録を拒否する。
--   document_number : 空欄なら本番と同じ採番表（document_sequences）で自動採番する（推奨）。
--                     手動指定する場合は既存と重複しないこと。
--   issue_key       : 必須。受付番号／Backlog課題キー。
--   template_type   : 必須。active なテンプレートキー（00_preflight の一覧から選ぶ）。
--   form_data       : 必須。有効なJSONオブジェクト（CSV内では " を "" に二重化）。
-- 実行: psql "$EMERGENCY_DSN" \
--         -v confirm=LEGALBRIDGE_EMERGENCY_WRITE \
--         -v csv=work/documents_generic.csv \
--         -f infra/gcp/emergency/sql/03_import_documents.sql

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
  \echo '中止: -v csv=work/documents_generic.csv のようにCSVパスを指定してください'
  \quit 2
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE stg_docs (
  emergency_ref text, document_number text, issue_key text, template_type text,
  contract_title text, vendor_name text, created_by text, form_data text
) ON COMMIT DROP;

\copy stg_docs FROM :'csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')

SELECT COUNT(*) AS staged_rows FROM stg_docs;

-- 検証: 必須列・JSON妥当性・テンプレ実在・emergency_ref/document_number の重複
DO $$
DECLARE bad int; r record;
BEGIN
  SELECT COUNT(*) INTO bad FROM stg_docs
   WHERE COALESCE(trim(emergency_ref), '') = '' OR COALESCE(trim(issue_key), '') = ''
      OR COALESCE(trim(template_type), '') = '' OR COALESCE(trim(form_data), '') = '';
  IF bad > 0 THEN RAISE EXCEPTION '必須列（emergency_ref/issue_key/template_type/form_data）が空の行が % 行あります', bad; END IF;

  FOR r IN SELECT emergency_ref, form_data FROM stg_docs LOOP
    BEGIN
      IF jsonb_typeof(r.form_data::jsonb) <> 'object' THEN
        RAISE EXCEPTION 'form_data がJSONオブジェクトではありません（%）', r.emergency_ref;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'form_data のJSONが不正です（%）。Excelの引用符くずれを確認してください', r.emergency_ref;
    END;
  END LOOP;

  SELECT COUNT(*) INTO bad FROM stg_docs s
   WHERE NOT EXISTS (SELECT 1 FROM document_templates dt
                      WHERE dt.template_key = trim(s.template_type) AND dt.is_active = true);
  IF bad > 0 THEN RAISE EXCEPTION 'active でない template_type の行が % 行あります（00_preflight の一覧を確認）', bad; END IF;

  SELECT COUNT(*) INTO bad FROM stg_docs s
   JOIN documents d ON d.form_data->>'EMERGENCY_REF' = trim(s.emergency_ref);
  IF bad > 0 THEN RAISE EXCEPTION '同じ emergency_ref が登録済みです（%件）。再実行の疑い。中止します', bad; END IF;

  SELECT COUNT(*) INTO bad FROM stg_docs s
   JOIN documents d ON d.document_number = trim(s.document_number)
  WHERE COALESCE(trim(s.document_number), '') <> '';
  IF bad > 0 THEN RAISE EXCEPTION '指定した document_number が既存と重複します（%件）', bad; END IF;
END $$;

-- 登録: 採番（空欄時）→ INSERT。record_type / contract_status は通常系と同じ規則で刻む。
DO $$
DECLARE
  s record; tpl record; num text; base_prefix text; seq int; yr int;
  v_id bigint; rtype text;
BEGIN
  yr := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Tokyo'))::int;
  FOR s IN SELECT * FROM stg_docs LOOP
    SELECT dt.template_key, dt.document_prefix, dt.current_version_id INTO tpl
      FROM document_templates dt
     WHERE dt.template_key = trim(s.template_type) AND dt.is_active = true;

    -- 採番プレフィックス（テンプレ設定 → 既定表。通常系 DOCUMENT_PREFIXES と同一）
    base_prefix := COALESCE(NULLIF(upper(trim(tpl.document_prefix)), ''),
      CASE trim(s.template_type)
        WHEN 'purchase_order' THEN 'PO'
        WHEN 'intl_purchase_order' THEN 'IPO'
        WHEN 'inspection_certificate' THEN 'INS'
        WHEN 'license_master' THEN 'LIC'
        WHEN 'individual_license_terms' THEN 'ILT'
        WHEN 'individual_license_terms_v3' THEN 'ILT'
        WHEN 'royalty_statement' THEN 'ROY'
        WHEN 'service_master' THEN 'SVC'
        WHEN 'nda' THEN 'NDA'
        WHEN 'payment_notice' THEN 'PAY'
        WHEN 'invoice' THEN 'INV'
        ELSE NULL
      END);
    IF base_prefix IS NULL THEN
      RAISE EXCEPTION '採番プレフィックスを解決できません（%）。document_number を手動指定してください', s.template_type;
    END IF;
    IF base_prefix LIKE 'ARC-%' THEN base_prefix := substr(base_prefix, 5); END IF;

    IF COALESCE(trim(s.document_number), '') <> '' THEN
      num := trim(s.document_number);
    ELSE
      INSERT INTO document_sequences (kind, year, current_value) VALUES (base_prefix, yr, 1)
      ON CONFLICT (kind, year) DO UPDATE SET current_value = document_sequences.current_value + 1
      RETURNING current_value INTO seq;
      num := 'ARC-' || base_prefix || '-' || yr || '-' || lpad(seq::text, 4, '0');
    END IF;

    -- vendor_id を名称から解決（vendor_name → trade_name → pen_name。通常系と同じ順）
    v_id := NULL;
    IF COALESCE(trim(s.vendor_name), '') <> '' THEN
      SELECT id INTO v_id FROM vendors
       WHERE vendor_name = trim(s.vendor_name)
          OR trade_name = trim(s.vendor_name) OR pen_name = trim(s.vendor_name)
       ORDER BY is_active DESC, id LIMIT 1;
    END IF;

    -- record_type（通常系 deriveRecordType と同じ規則）
    rtype := CASE
      WHEN trim(s.template_type) LIKE 'pub_master_%' THEN 'master_contract'
      WHEN trim(s.template_type) LIKE 'pub_%' THEN 'publication_condition'
      WHEN trim(s.template_type) LIKE '%license%' OR trim(s.template_type) LIKE '%royalty%' THEN 'license_condition'
      WHEN trim(s.template_type) LIKE '%purchase_order%' OR trim(s.template_type) LIKE '%inspection%'
        OR trim(s.template_type) LIKE '%payment%' OR trim(s.template_type) LIKE '%invoice%' THEN 'individual_contract'
      ELSE 'master_contract'
    END;

    INSERT INTO documents (
      document_number, issue_key, template_type, template_version_id,
      form_data, drive_link, created_at, created_by,
      record_type, contract_status, contract_title, vendor_id
    ) VALUES (
      num, trim(s.issue_key), trim(s.template_type), tpl.current_version_id,
      (s.form_data::jsonb) || jsonb_build_object('EMERGENCY_REF', trim(s.emergency_ref)),
      '', now(), NULLIF(trim(s.created_by), ''),
      rtype, 'executed', NULLIF(trim(s.contract_title), ''), v_id
    );
    RAISE NOTICE '登録: % （%・ref=%）', num, trim(s.template_type), trim(s.emergency_ref);
  END LOOP;
END $$;

\echo '--- 登録結果（この一覧を記録票に添付）---'
SELECT d.document_number, d.template_type, d.issue_key,
       d.form_data->>'EMERGENCY_REF' AS emergency_ref,
       d.vendor_id, d.created_at
  FROM documents d
  JOIN stg_docs s ON d.form_data->>'EMERGENCY_REF' = trim(s.emergency_ref)
 ORDER BY d.id;

COMMIT;
