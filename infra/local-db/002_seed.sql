WITH template AS (
  INSERT INTO document_templates (
    template_key, kind, label, category, document_prefix
  ) VALUES (
    'purchase_order', 'document', '発注書（国内）', 'Domestic', 'ARC-PO'
  )
  RETURNING id
), version AS (
  INSERT INTO document_template_versions (
    template_id, version_no, html_source, field_schema
  )
  SELECT
    id,
    1,
    '<h1>発注書</h1><p>{{PROJECT_TITLE}}</p><p>{{VENDOR_NAME}}</p><p>{{ORDER_DATE}}</p>',
    '[
      {
        "name": "PROJECT_TITLE",
        "label": "件名",
        "group": "I. 発注概要",
        "required": true,
        "dbField": "backlog.summary"
      },
      {
        "name": "ORDER_DATE",
        "label": "発行日",
        "type": "date",
        "group": "I. 発注概要",
        "required": true,
        "dbField": "auto.today"
      },
      {
        "name": "VENDOR_NAME",
        "label": "発注先名称",
        "group": "II. 発注先",
        "required": true,
        "dbField": "vendor.vendor_name"
      },
      {
        "name": "SPECIAL_TERMS",
        "label": "特約事項",
        "type": "textarea",
        "group": "III. 特約・備考"
      }
    ]'::jsonb
  FROM template
  RETURNING id, template_id
)
UPDATE document_templates
SET current_version_id = version.id
FROM version
WHERE document_templates.id = version.template_id;

INSERT INTO document_drafts (
  issue_key, template_type, form_data, updated_by
) VALUES (
  'LOCAL-1',
  'purchase_order',
  '{"PROJECT_TITLE":"ローカル環境確認用の発注書","VENDOR_NAME":"テスト取引先"}'::jsonb,
  'local@example.com'
);

