-- =====================================================================
-- V3移行 040：テンプレート・文書・文書条件・採番
--   documents は36列から12列へ落ちる。契約業務列は合意へ、
--   表示スナップショットは rendered_values（読み取り専用）へ。
--   実行: psql "$ADMIN_DSN" -f infra/v3/040_migrate_documents.sql（030 の後）
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- テンプレートと版（本文・field_schema はそのまま移す＝互換境界）
-- ---------------------------------------------------------------------
-- V1/V2 の DOCUMENT_PREFIXES（コード側の表）と同じ値。
-- 本番には ARC-PO-2026-0115 や ARC-INS-2026-0031 が実在するので、
-- 違う記号を振ると同じ書類の番号が途中で変わる。
CREATE OR REPLACE FUNCTION v3_default_prefix(key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $prefix$
  SELECT CASE key
    WHEN 'purchase_order'                        THEN 'PO'
    WHEN 'intl_purchase_order'                   THEN 'IPO'
    WHEN 'inspection_certificate'                THEN 'INS'
    WHEN 'license_master'                        THEN 'LIC'
    WHEN 'individual_license_terms'              THEN 'ILT'
    WHEN 'individual_license_terms_v3'           THEN 'ILT'
    WHEN 'royalty_statement'                     THEN 'ROY'
    WHEN 'service_master'                        THEN 'SVC'
    WHEN 'pub_master_individual'                 THEN 'PUB'
    WHEN 'pub_master_corporate'                  THEN 'PUB'
    WHEN 'pub_license_terms'                     THEN 'PUBT'
    WHEN 'pub_additional_terms'                  THEN 'PUBA'
    WHEN 'sales_master_buyer'                    THEN 'SAL'
    WHEN 'sales_master_credit'                   THEN 'SAL'
    WHEN 'sales_master_standard'                 THEN 'SAL'
    WHEN 'maintenance_spec'                      THEN 'MNT'
    WHEN 'legal_response'                        THEN 'LG'
    -- 汎用法務文書は V1 でも採番記号を持っておらず、一度も発行できなかった。
    -- 法務回答書と同じ連番に載せる（法務が出した文書を一続きで数える）。
    WHEN 'legal_freeform'                        THEN 'LG'
    WHEN 'notice_consent_personal_info_freelance' THEN 'PR'
    WHEN 'nda'                                   THEN 'NDA'
    WHEN 'payment_notice'                        THEN 'PAY'
    WHEN 'invoice'                               THEN 'INV'
  END;
$prefix$;

INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active, legacy_id)
SELECT t.template_key,
       COALESCE(NULLIF(t.label, ''), t.template_key),
       NULLIF(t.category, ''),
       -- V1/V2 はプレフィックスをコード側の表に持ち、この列は上書き用だった。
       -- 列だけを写すと、値が入っていない大半のひな形が発行できなくなる
       -- （V3 の発行はプレフィックスをDBから引く）。落ちた分をここで補う。
       COALESCE(NULLIF(t.document_prefix, ''), v3_default_prefix(t.template_key)),
       COALESCE(t.is_active, true), t.id
  FROM public.document_templates t
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  template_key = EXCLUDED.template_key, label = EXCLUDED.label,
  category = EXCLUDED.category, number_prefix = EXCLUDED.number_prefix,
  is_active = EXCLUDED.is_active;

INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, legacy_id)
SELECT nt.id, v.version_no, v.html_source,
       COALESCE(v.field_schema, '[]'::jsonb), v.id
  FROM public.document_template_versions v
  JOIN v3.document_templates nt ON nt.legacy_id = v.template_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  html_source = EXCLUDED.html_source, variables = EXCLUDED.variables;

UPDATE v3.document_templates nt
   SET current_version_id = nv.id
  FROM public.document_templates t
  JOIN v3.document_template_versions nv ON nv.legacy_id = t.current_version_id
 WHERE nt.legacy_id = t.id
   AND nt.current_version_id IS DISTINCT FROM nv.id;

-- ---------------------------------------------------------------------
-- 文書
--   form_data は rendered_values へそのまま入れる（本文互換のため変数名は変えない）。
--   ただし業務データの参照元にはしない。相手先・件名は合意と条件から解決する。
-- ---------------------------------------------------------------------
INSERT INTO v3.documents (document_no, template_version_id, matter_id, agreement_id,
                          status, rendered_values, storage_url, issued_at, issued_by,
                          created_at, legacy_id)
SELECT
  NULLIF(d.document_number, ''),
  nv.id,
  nm.id,
  ag.id,
  CASE
    WHEN d.lifecycle_status = 'voided'                      THEN 'void'
    WHEN d.lifecycle_status IN ('reissued', 'superseded')    THEN 'superseded'
    WHEN d.lifecycle_status = 'draft'                        THEN 'draft'
    WHEN NULLIF(d.document_number, '') IS NULL               THEN 'draft'
    ELSE 'issued'
  END,
  COALESCE(d.form_data, '{}'::jsonb),
  NULLIF(d.drive_link, ''),
  CASE WHEN NULLIF(d.document_number, '') IS NOT NULL THEN d.created_at END,
  NULLIF(d.created_by, ''),
  COALESCE(d.created_at, now()),
  d.id
FROM public.documents d
LEFT JOIN v3.document_template_versions nv ON nv.legacy_id = d.template_version_id
LEFT JOIN v3.matters nm    ON nm.legacy_id = d.matter_id
LEFT JOIN v3.agreements ag ON ag.legacy_id = d.contract_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO UPDATE SET
  document_no = EXCLUDED.document_no,
  template_version_id = EXCLUDED.template_version_id,
  matter_id = EXCLUDED.matter_id, agreement_id = EXCLUDED.agreement_id,
  status = EXCLUDED.status, rendered_values = EXCLUDED.rendered_values,
  storage_url = EXCLUDED.storage_url;

-- 版の連鎖。旧版の form_data.superseded_by に「自分を差し替えた新版の文書番号」が入る。
-- V3 の supersedes_id は逆向き（新版が旧版を指す）なので、向きを反転して結ぶ。
UPDATE v3.documents nd
   SET supersedes_id = prev.id
  FROM public.documents old_doc                                   -- 旧版
  JOIN public.documents new_doc
    ON new_doc.document_number = old_doc.form_data->>'superseded_by'  -- 新版
  JOIN v3.documents prev ON prev.legacy_id = old_doc.id
 WHERE nd.legacy_id = new_doc.id                                  -- 更新するのは新版の行
   AND nd.id <> prev.id
   AND nd.supersedes_id IS DISTINCT FROM prev.id;

-- ---------------------------------------------------------------------
-- 文書 → 条件（参照方向を反転する。ここが構造変更の要）
--   旧: condition_lines.document_id（条件が文書に従属）
--   新: document_conditions（文書が条件を参照）
-- ---------------------------------------------------------------------
-- 移行元から消えた紐付けが残っていると line_no がぶつかる。
-- この表を参照している表は無いので、そのまま消してよい。
DELETE FROM v3.document_conditions dc
 WHERE NOT EXISTS (
   SELECT 1 FROM public.condition_lines cl
     JOIN v3.documents nd  ON nd.legacy_id = cl.document_id
     JOIN v3.conditions nc ON nc.legacy_id = cl.id
    WHERE nd.id = dc.document_id AND nc.id = dc.condition_id);

--   line_no は文書内で一意とは限らない。document_conditions は
--   UNIQUE (document_id, line_no) を持つので、重複したまま入れると
--   ON CONFLICT (document_id, condition_id) では捕まえられずに落ちる。
--   全件そろって重複が無いときだけ元の番号を残し、それ以外は振り直す。
WITH src AS (
  SELECT cl.id, cl.document_id, cl.line_no,
         ROW_NUMBER() OVER (PARTITION BY cl.document_id
                            ORDER BY cl.line_no NULLS LAST, cl.id) AS rn
    FROM public.condition_lines cl
   WHERE cl.document_id IS NOT NULL
), clean AS (
  SELECT document_id FROM src
   GROUP BY document_id HAVING count(*) = count(DISTINCT line_no)
)
INSERT INTO v3.document_conditions (document_id, condition_id, line_no)
SELECT nd.id, nc.id,
       (CASE WHEN c.document_id IS NOT NULL THEN s.line_no ELSE s.rn END)::int
  FROM src s
  JOIN v3.documents nd  ON nd.legacy_id = s.document_id
  JOIN v3.conditions nc ON nc.legacy_id = s.id
  LEFT JOIN clean c ON c.document_id = s.document_id
ON CONFLICT (document_id, condition_id) DO UPDATE SET line_no = EXCLUDED.line_no;

-- 案件から文書へのリンク（030 で入れられなかった分）
INSERT INTO v3.matter_links (matter_id, target_type, target_ref, relation)
SELECT nd.matter_id, 'document', nd.id::text, 'related'
  FROM v3.documents nd
 WHERE nd.matter_id IS NOT NULL
ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING;

-- ---------------------------------------------------------------------
-- 採番（prefix は kind をそのまま引き継ぐ）
-- ---------------------------------------------------------------------
-- prefix は基底（ARC- を除いた部分）で持つ。アプリの採番も基底で引くため、
-- 移行時に正規化しないと連番が振り出しに戻る。
INSERT INTO v3.document_sequences (prefix, year, current_value)
SELECT regexp_replace(upper(btrim(s.kind)), '^ARC-', ''), s.year, COALESCE(s.current_value, 0)
  FROM public.document_sequences s
 WHERE btrim(COALESCE(s.kind, '')) <> ''
ON CONFLICT (prefix, year) DO UPDATE SET
  current_value = GREATEST(v3.document_sequences.current_value, EXCLUDED.current_value);

COMMIT;
