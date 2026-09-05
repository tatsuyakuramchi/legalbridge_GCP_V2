-- 016_upgrade_royalty_statement_v9_studio.sql
-- Cloud SQL Studio compatible.
-- Stabilizes royalty_statement without rewriting historical documents.
--
-- Changes:
--  1. Creates template version 9 from current version 8.
--  2. Currency display uses generated {{moneyUnit}} instead of hard-coded yen.
--  3. Tax row is omitted when taxRate is 0/blank.
--  4. quantity / msrpStr are no longer globally required because SALE / SUBLICENSE
--     events do not use manufacturing quantity + MSRP semantics.
--  5. Vendor/master-derived fields become readonly metadata.
-- Existing versions 1-8 remain untouched.

BEGIN;

DO $guard$
DECLARE
  current_no integer;
  v9_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM document_templates dt
    JOIN document_template_versions v ON v.template_id = dt.id
    WHERE dt.template_key = 'royalty_statement' AND v.version_no = 9
  ) INTO v9_exists;

  IF NOT v9_exists THEN
    SELECT v.version_no INTO current_no
    FROM document_templates dt
    JOIN document_template_versions v ON v.id = dt.current_version_id
    WHERE dt.template_key = 'royalty_statement';

    IF current_no IS DISTINCT FROM 8 THEN
      RAISE EXCEPTION
        'royalty_statement current version must be 8 before v9 migration; current=%',
        current_no;
    END IF;
  END IF;
END
$guard$;

WITH source AS (
  SELECT
    dt.id AS template_id,
    v.html_source,
    v.field_schema
  FROM document_templates dt
  JOIN document_template_versions v ON v.id = dt.current_version_id
  WHERE dt.template_key = 'royalty_statement'
    AND NOT EXISTS (
      SELECT 1
      FROM document_template_versions existing
      WHERE existing.template_id = dt.id
        AND existing.version_no = 9
    )
),
normalized AS (
  SELECT
    template_id,
    replace(
      replace(
        replace(
          replace(
            html_source,
            '<td class="label" style="width:120px;">製造完了日</td>',
            '<td class="label" style="width:120px;">{{#if (eq calcType "manufacturing")}}製造完了日{{else if (eq calcType "sales")}}売上発生日{{else if (eq calcType "sublicense")}}入金日{{else}}発生日{{/if}}</td>'
          ),
          $oldtax$
      <tr>
        <td colspan="2" class="right">消費税（{{taxRate}}%）</td>
        <td class="right">¥{{taxAmount}}</td>
      </tr>
$oldtax$,
          $newtax$
      {{#if taxRate}}
      <tr>
        <td colspan="2" class="right">消費税（{{taxRate}}%）</td>
        <td class="right">{{moneyUnit}}{{taxAmount}}</td>
      </tr>
      {{/if}}
$newtax$
        ),
        '¥',
        '{{moneyUnit}}'
      ),
      '源泉徴収税計算前　お支払予定額（税込）',
      '{{#if taxRate}}源泉徴収税計算前　お支払予定額（税込）{{else}}お支払予定額（税抜）{{/if}}'
    ) AS html_source,
    (
      SELECT jsonb_agg(
        CASE item ->> 'name'
          WHEN 'quantity' THEN item - 'required'
          WHEN 'msrpStr' THEN
            jsonb_set(
              item - 'required',
              '{helpText}',
              to_jsonb('製造時は基準単価、売上・サブライセンス入金時は算定基礎額。新規作成は利用許諾料精算画面から自動設定。'::text),
              true
            )
          WHEN 'VENDOR_REPRESENTATIVE_SAMA' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'currency' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'paymentConditionSummary' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'bankName' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'branchName' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'accountType' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'accountNo' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'accountHolder' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          WHEN 'invoiceRegistrationNumber' THEN
            jsonb_set(item, '{readonly}', 'true'::jsonb, true)
          ELSE item
        END
        ORDER BY ordinality
      )
      FROM jsonb_array_elements(field_schema) WITH ORDINALITY AS e(item, ordinality)
    ) AS field_schema
  FROM source
),
inserted AS (
  INSERT INTO document_template_versions (
    template_id,
    version_no,
    html_source,
    field_schema,
    comment,
    created_by
  )
  SELECT
    template_id,
    9,
    html_source,
    field_schema,
    '利用許諾料計算書 v9: event-driven settlement / readonly-hidden metadata / currency-safe rendering',
    'LegalBridge V2 integrated workflow'
  FROM normalized
  RETURNING id, template_id
)
UPDATE document_templates dt
SET current_version_id = v.id,
    updated_at = now()
FROM document_template_versions v
WHERE dt.template_key = 'royalty_statement'
  AND v.template_id = dt.id
  AND v.version_no = 9;

COMMIT;

-- Verification
SELECT
  dt.template_key,
  dt.current_version_id,
  v.version_no,
  jsonb_array_length(v.field_schema) AS field_count,
  position('{{moneyUnit}}' in v.html_source) > 0 AS currency_unit_enabled,
  position('quantity}} 個' in v.html_source) > 0 AS manufacturing_layout_preserved
FROM document_templates dt
JOIN document_template_versions v ON v.id = dt.current_version_id
WHERE dt.template_key = 'royalty_statement';
