\set ON_ERROR_STOP on
\pset pager off

-- 081_intl_purchase_order_standard_terms.sql
-- 海外発注書（intl_purchase_order）で、基本契約がない場合に
-- Cross-Border Spot Order 用の業務委託基本条件を別紙として自動添付する。
--
-- 目的:
--   - HAS_BASE_CONTRACT = false / 未設定
--       → Standard Terms and Conditions for Service Outsourcing を PDF 末尾に添付
--   - HAS_BASE_CONTRACT = true
--       → Standard Terms は添付しない（基本契約を優先）
--   - MASTER_CONTRACT_REF は「DBから引用 → 契約・文書」で基本契約を選ぶと自動入力される
--     （MasterDataPicker の既存ロジックを利用）。
--
-- フォーム項目:
--   HAS_BASE_CONTRACT   : boolean
--   MASTER_CONTRACT_REF : text（基本契約ありのときだけ表示）
--
-- テンプレート本文は新版を作成する。確定済み文書は保存済み template_version_id で
-- 再描画されるため、過去文書の表示は変えない。
--
-- 実行:
--   psql "$RUNTIME_ADMIN_DSN" -v ON_ERROR_STOP=1 \
--     -v confirm_intl_standard_terms=ADD_INTL_PO_STANDARD_TERMS \
--     -f infra/gcp/sql/081_intl_purchase_order_standard_terms.sql

\if :{?confirm_intl_standard_terms}
\else
  \echo 'Run with: -v confirm_intl_standard_terms=ADD_INTL_PO_STANDARD_TERMS'
  \quit 2
\endif
SELECT :'confirm_intl_standard_terms' = 'ADD_INTL_PO_STANDARD_TERMS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $do$
DECLARE
  src text;
  schema_json jsonb;
  normalized_schema jsonb;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  body_pos int;
  marker constant text := 'lb-intl-standard-terms';
  terms_block constant text := $terms$

{{!-- 081: Cross-border spot-order terms. A master agreement suppresses this exhibit. --}}
{{#unless HAS_BASE_CONTRACT}}
<section class="lb-intl-standard-terms"
  style="break-before:page; page-break-before:always; font-family:Arial,Helvetica,sans-serif; font-size:9.2pt; line-height:1.45; color:#111;">
  <div style="text-align:center; margin:0 0 8mm;">
    <div style="font-size:14pt; font-weight:700; letter-spacing:.02em;">
      STANDARD TERMS AND CONDITIONS FOR SERVICE OUTSOURCING
    </div>
    <div style="margin-top:2mm; font-size:9.5pt;">
      For Cross-Border Spot Orders — 2026 Revised Edition
    </div>
    <div style="margin-top:2mm; font-size:8.8pt; color:#444;">
      Exhibit to Purchase Order No. {{DOCUMENT_NUMBER}}
    </div>
  </div>

  <p>
    These Standard Terms and Conditions (the “Terms”) apply to the Purchase Order issued by
    Arclight, Inc. (the “Purchaser”) to the contractor identified in that Purchase Order
    (the “Contractor”) where no master agreement is specified. The Purchase Order and these
    Terms collectively constitute the “Agreement”. If any provision of the Purchase Order
    conflicts with these Terms, the Purchase Order shall prevail.
  </p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 1 — Formation of Agreement</h3>
  <p>1. The Agreement is formed when the Contractor accepts the Purchase Order by signed copy, email or other electronic notice, commencement of the work, or any other unambiguous expression of acceptance.</p>
  <p>2. Any material amendment to the scope, fee, delivery schedule or other material condition must be agreed in writing or by electronic communication.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 2 — Performance of Work; Independence</h3>
  <p>1. The Contractor shall perform the services and produce the deliverables stated in the Purchase Order with reasonable professional skill, care and diligence.</p>
  <p>2. The Contractor acts as an independent contractor and is responsible for the method, personnel, equipment and working environment used to perform the services. Nothing in the Agreement creates an employment, partnership, joint venture or agency relationship.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 3 — Remuneration; Changes in Scope</h3>
  <p>1. The remuneration shall be the amount stated in the Purchase Order.</p>
  <p>2. If either party proposes a material change in scope, specifications, deliverables or schedule, the parties shall agree the corresponding fee and schedule adjustment before the additional work is performed.</p>
  <p>3. The Contractor is not entitled to additional remuneration for material additional work unless approved by the Purchaser in writing or by electronic communication.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 4 — Delivery; Acceptance Inspection</h3>
  <p>1. The Contractor shall deliver the deliverables by the deadline and in the manner stated in the Purchase Order or applicable specifications.</p>
  <p>2. Unless another period is stated in the Purchase Order, the Purchaser shall inspect the deliverables within ten (10) business days after receipt and notify the Contractor of acceptance or material non-conformity.</p>
  <p>3. If the Purchaser gives no such notice within the applicable inspection period, the deliverables shall be deemed accepted.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 5 — Non-Conformity</h3>
  <p>1. If a deliverable materially fails to conform to the Agreement, the Purchaser may require correction or replacement within a reasonable period at no additional charge.</p>
  <p>2. Unless otherwise stated in the Purchase Order, the Purchaser may notify the Contractor of latent or subsequently discovered non-conformity within six (6) months after acceptance.</p>
  <p>3. The Contractor is not responsible for non-conformity caused solely by materials, specifications or instructions supplied by the Purchaser.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 6 — Payment; Taxes; Bank Charges</h3>
  <p>1. Payment timing, currency and payment method shall be as stated in the Purchase Order.</p>
  <p>2. Each party is responsible for taxes imposed on its own income. If the Purchaser is required by applicable law to deduct or withhold tax, the Purchaser may make the required deduction and remit it to the competent authority. Unless expressly agreed otherwise, no gross-up applies.</p>
  <p>3. Bank and remittance charges shall be allocated as stated in the Purchase Order.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 7 — Intellectual Property Rights</h3>
  <p>1. Ownership of intellectual property rights in the deliverables shall be determined by the Purchase Order.</p>
  <p>2. Where the Purchase Order states that ownership belongs to the Purchaser, upon full payment the Contractor assigns to the Purchaser all transferable intellectual property rights in the deliverables, including the right to modify, reproduce, distribute, publish, translate, adapt and otherwise exploit them worldwide for the full duration of such rights.</p>
  <p>3. To the extent any right cannot validly be assigned, the Contractor grants the Purchaser an exclusive, worldwide, perpetual, irrevocable, transferable, sublicensable and royalty-free licence to exercise that right to the fullest extent permitted by law.</p>
  <p>4. To the fullest extent permitted by applicable law, the Contractor shall not assert moral rights or similar personal rights against the Purchaser or any person authorized by the Purchaser in connection with the permitted use of the deliverables.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 8 — Third-Party Rights</h3>
  <p>1. The Contractor warrants that it has authority to perform the services and grant or assign the rights contemplated by the Agreement.</p>
  <p>2. The Contractor warrants that, excluding Purchaser-designated materials, the deliverables do not infringe third-party intellectual property rights.</p>
  <p>3. If third-party materials, fonts, images, software, AI-generated outputs or other third-party content are incorporated, the Contractor shall obtain all permissions necessary for the Purchaser’s intended use and, on request, disclose the applicable licence conditions.</p>
  <p>4. The Contractor shall indemnify the Purchaser against third-party claims arising from breach of this Article, except to the extent caused by Purchaser-designated materials.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 9 — Confidentiality</h3>
  <p>1. Each party shall keep confidential all non-public business, technical and commercial information received from the other party and use it only for purposes of the Agreement.</p>
  <p>2. This obligation does not apply to information that is public without breach, lawfully known before disclosure, lawfully obtained from a third party without restriction, or independently developed.</p>
  <p>3. The confidentiality obligation survives termination for five (5) years.</p>
  <p>4. The Contractor shall not publish or display unpublished deliverables, work-in-progress or project information in a portfolio, website, social media or other public channel without the Purchaser’s prior consent.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 10 — Data Protection</h3>
  <p>Each party shall comply with applicable privacy and data protection laws. Where the Contractor processes personal data provided by the Purchaser, the Contractor shall use it only as necessary for the services, implement reasonable technical and organizational safeguards, and promptly report any material personal-data incident to the Purchaser.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 11 — Assignment</h3>
  <p>Neither party may assign or transfer the Agreement or any material right or obligation under it without the other party’s prior written consent, except that the Purchaser may assign the Agreement to an affiliate or successor in connection with a merger, corporate reorganization or transfer of the relevant business.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 12 — Subcontracting</h3>
  <p>1. The Contractor shall not subcontract all or a material part of the services without the Purchaser’s prior written consent.</p>
  <p>2. Approved subcontracting does not relieve the Contractor of responsibility. The Contractor shall impose equivalent confidentiality, intellectual property and data-protection obligations on the subcontractor.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 13 — Compliance with Laws</h3>
  <p>Each party shall comply with all applicable laws and regulations relating to its performance of the Agreement, including applicable anti-bribery, sanctions, export-control and trade-control laws.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 14 — Organized Crime and Restricted Parties</h3>
  <p>Each party represents that it is not controlled by an organized criminal group, terrorist organization or person subject to applicable asset-freeze or trade sanctions, and shall not use such persons in connection with the Agreement. A material breach of this Article entitles the other party to terminate the Agreement immediately.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 15 — Termination; Damages</h3>
  <p>1. If either party materially breaches the Agreement and fails to remedy the breach within a reasonable cure period after written notice, the non-breaching party may terminate the Agreement.</p>
  <p>2. Except for fraud, willful misconduct, gross negligence, breach of confidentiality, infringement of intellectual property rights, or liability that cannot legally be limited, each party’s aggregate liability arising from the Agreement shall not exceed the total remuneration payable under the Purchase Order.</p>
  <p>3. Except where prohibited by applicable law, neither party is liable for indirect, incidental, special or consequential damages.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 16 — Settlement upon Early Termination</h3>
  <p>If the Agreement terminates before completion for reasons not attributable to the Contractor, the Purchaser shall pay reasonable compensation for conforming services properly performed up to the effective date of termination, taking into account the agreed remuneration and degree of completion. No payment is due for defective, unusable or unperformed portions.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 17 — Governing Law; Jurisdiction</h3>
  <p>The Agreement is governed by the laws of Japan, without regard to conflict-of-laws rules. The Tokyo District Court shall have exclusive jurisdiction as the court of first instance over any dispute arising out of or in connection with the Agreement.</p>

  <h3 style="font-size:10pt; margin:5mm 0 1.5mm;">Article 18 — Language; Matters Not Stipulated</h3>
  <p>1. The governing language of the Agreement is English. Any translation is provided for convenience only unless the parties expressly agree otherwise.</p>
  <p>2. Any matter not stipulated in the Agreement shall be resolved through good-faith consultation between the parties.</p>
</section>
{{/unless}}
$terms$;
BEGIN
  SELECT t.id, v.html_source, v.field_schema
    INTO tpl_id, src, schema_json
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';

  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order template was not found';
  END IF;

  -- 既存項目があれば型・説明を正規化。無ければ追加する。
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema_json) f
     WHERE f->>'name' = 'HAS_BASE_CONTRACT'
  ) THEN
    SELECT jsonb_agg(
             CASE WHEN e.f->>'name' = 'HAS_BASE_CONTRACT'
               THEN e.f || jsonb_build_object(
                 'type', 'boolean',
                 'label', '基本契約あり（Master Agreement）',
                 'helpText', '締結済みの基本契約に基づく海外発注ならチェック。未チェックの場合は、PDF末尾にCross-Border Spot Order用のStandard Termsを自動添付します。'
               )
               ELSE e.f
             END
             ORDER BY e.ord)
      INTO normalized_schema
      FROM jsonb_array_elements(schema_json) WITH ORDINALITY AS e(f, ord);
    schema_json := normalized_schema;
  ELSE
    schema_json := schema_json || jsonb_build_array(jsonb_build_object(
      'name', 'HAS_BASE_CONTRACT',
      'label', '基本契約あり（Master Agreement）',
      'type', 'boolean',
      'helpText', '締結済みの基本契約に基づく海外発注ならチェック。未チェックの場合は、PDF末尾にCross-Border Spot Order用のStandard Termsを自動添付します。'
    ));
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema_json) f
     WHERE f->>'name' = 'MASTER_CONTRACT_REF'
  ) THEN
    SELECT jsonb_agg(
             CASE WHEN e.f->>'name' = 'MASTER_CONTRACT_REF'
               THEN e.f || jsonb_build_object(
                 'type', 'text',
                 'label', '基本契約名 / 番号（Master Agreement）',
                 'helpText', '「DBから引用 → 契約・文書」で基本契約を選ぶと自動入力されます。',
                 'showWhen', jsonb_build_object('field', 'HAS_BASE_CONTRACT', 'truthy', true)
               )
               ELSE e.f
             END
             ORDER BY e.ord)
      INTO normalized_schema
      FROM jsonb_array_elements(schema_json) WITH ORDINALITY AS e(f, ord);
    schema_json := normalized_schema;
  ELSE
    schema_json := schema_json || jsonb_build_array(jsonb_build_object(
      'name', 'MASTER_CONTRACT_REF',
      'label', '基本契約名 / 番号（Master Agreement）',
      'type', 'text',
      'helpText', '「DBから引用 → 契約・文書」で基本契約を選ぶと自動入力されます。',
      'showWhen', jsonb_build_object('field', 'HAS_BASE_CONTRACT', 'truthy', true)
    ));
  END IF;

  IF strpos(src, marker) > 0 THEN
    -- HTML は適用済み。フォーム定義だけ不足していた場合に備え、現行版の schema を整える。
    UPDATE document_template_versions v
       SET field_schema = schema_json
      FROM document_templates t
     WHERE t.current_version_id = v.id
       AND t.id = tpl_id;
    RAISE NOTICE 'intl_purchase_order standard terms are already applied; field schema normalized only';
  ELSE
    body_pos := strpos(src, '</body>');
    IF body_pos > 0 THEN
      new_html := left(src, body_pos - 1) || terms_block || substr(src, body_pos);
    ELSE
      new_html := src || terms_block;
    END IF;

    SELECT COALESCE(MAX(version_no), 0) + 1
      INTO next_no
      FROM document_template_versions
     WHERE template_id = tpl_id;

    INSERT INTO document_template_versions
      (template_id, version_no, html_source, field_schema, comment, created_by)
    VALUES
      (tpl_id, next_no, new_html, schema_json,
       'Intl PO: append cross-border service outsourcing standard terms only when no master agreement (081)',
       'legalbridge-v2')
    RETURNING id INTO new_id;

    UPDATE document_templates
       SET current_version_id = new_id
     WHERE id = tpl_id;

    RAISE NOTICE 'intl_purchase_order version % created with conditional standard terms', next_no;
  END IF;
END
$do$;

-- 適用後確認。
SELECT t.template_key,
       v.version_no,
       strpos(v.html_source, 'lb-intl-standard-terms') > 0 AS has_standard_terms,
       strpos(v.html_source, '{{#unless HAS_BASE_CONTRACT}}') > 0 AS conditional_on_no_master,
       EXISTS (
         SELECT 1 FROM jsonb_array_elements(v.field_schema) f
          WHERE f->>'name' = 'HAS_BASE_CONTRACT' AND f->>'type' = 'boolean'
       ) AS has_master_flag,
       EXISTS (
         SELECT 1 FROM jsonb_array_elements(v.field_schema) f
          WHERE f->>'name' = 'MASTER_CONTRACT_REF'
       ) AS has_master_reference
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';

COMMIT;
