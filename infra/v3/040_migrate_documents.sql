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
INSERT INTO v3.document_templates (template_key, label, category, number_prefix, is_active, legacy_id)
SELECT t.template_key,
       COALESCE(NULLIF(t.label, ''), t.template_key),
       NULLIF(t.category, ''), NULLIF(t.document_prefix, ''),
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
INSERT INTO v3.document_conditions (document_id, condition_id, line_no)
SELECT nd.id, nc.id,
       COALESCE(cl.line_no, ROW_NUMBER() OVER (PARTITION BY cl.document_id ORDER BY cl.id))::int
  FROM public.condition_lines cl
  JOIN v3.documents nd  ON nd.legacy_id = cl.document_id
  JOIN v3.conditions nc ON nc.legacy_id = cl.id
ON CONFLICT (document_id, condition_id) DO NOTHING;

-- 案件から文書へのリンク（030 で入れられなかった分）
INSERT INTO v3.matter_links (matter_id, target_type, target_ref, relation)
SELECT nd.matter_id, 'document', nd.id::text, 'related'
  FROM v3.documents nd
 WHERE nd.matter_id IS NOT NULL
ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING;

-- ---------------------------------------------------------------------
-- 採番（prefix は kind をそのまま引き継ぐ）
-- ---------------------------------------------------------------------
INSERT INTO v3.document_sequences (prefix, year, current_value)
SELECT s.kind, s.year, COALESCE(s.current_value, 0)
  FROM public.document_sequences s
ON CONFLICT (prefix, year) DO UPDATE SET
  current_value = GREATEST(v3.document_sequences.current_value, EXCLUDED.current_value);

COMMIT;
