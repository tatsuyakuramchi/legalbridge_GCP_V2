-- 015_add_legal_freeform_template_studio.sql
-- Cloud SQL Studio compatible.
-- Adds one NEW generic legal document template. Existing templates/versions are not modified.
BEGIN;

INSERT INTO public.document_templates (
  template_key, kind, label, category, comment, document_prefix, engine, is_active
)
VALUES (
  'legal_freeform',
  'document',
  '汎用法務文書',
  'Internal',
  '覚書・合意書・通知書・確認書等、専用Templateがない単発法務文書用。',
  NULL,
  'handlebars',
  TRUE
)
ON CONFLICT (template_key) DO NOTHING;

INSERT INTO public.document_template_versions (
  template_id,
  version_no,
  html_source,
  field_schema,
  comment,
  created_by
)
SELECT
  dt.id,
  1,
  $html$
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>{{DOCUMENT_TITLE}} {{DOC_NO}}</title>
<style>
*{box-sizing:border-box} body{margin:0;background:#fff;color:#111;font-family:"Noto Sans JP","Yu Gothic","Hiragino Kaku Gothic ProN",Meiryo,sans-serif;font-size:13px;line-height:1.8}
.page{max-width:794px;margin:0 auto;padding:48px 56px 64px}
.header{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:34px;font-size:10px;color:#666}
h1{font-size:24px;letter-spacing:.06em;text-align:center;margin:0 0 32px}
.meta{width:100%;border-collapse:collapse;margin-bottom:32px}.meta td{border-bottom:1px solid #e5e5e5;padding:7px 9px}.meta .label{width:120px;color:#777}
.intro,.body,.closing{white-space:pre-wrap;word-break:break-word}.intro{margin-bottom:24px}.body{min-height:260px}
.closing{margin-top:28px}
.signatures{display:grid;grid-template-columns:1fr 1fr;gap:34px;margin-top:48px}.signature{border-top:1px solid #bbb;padding-top:10px;white-space:pre-wrap;min-height:80px}
.footer{margin-top:48px;border-top:1px solid #ddd;padding-top:10px;display:flex;justify-content:space-between;color:#999;font-size:9px}
@media print{.page{max-width:none;padding:22mm 20mm}}
</style>
</head>
<body>
<div class="page">
  <div class="header"><span>株式会社アークライト 法務部</span><span>No. {{DOC_NO}}</span></div>
  <h1>{{DOCUMENT_TITLE}}</h1>
  <table class="meta">
    <tr><td class="label">文書種別</td><td>{{DOCUMENT_TYPE}}</td></tr>
    <tr><td class="label">作成日</td><td>{{DOCUMENT_DATE}}</td></tr>
    {{#if PARTY_A}}<tr><td class="label">当事者・宛先A</td><td>{{PARTY_A}}</td></tr>{{/if}}
    {{#if PARTY_B}}<tr><td class="label">当事者・宛先B</td><td>{{PARTY_B}}</td></tr>{{/if}}
  </table>
  {{#if INTRODUCTION}}<div class="intro">{{INTRODUCTION}}</div>{{/if}}
  <div class="body">{{BODY}}</div>
  {{#if CLOSING}}<div class="closing">{{CLOSING}}</div>{{/if}}
  {{#if SHOW_SIGNATURES}}
  <div class="signatures">
    <div class="signature">{{SIGNATURE_A}}</div>
    <div class="signature">{{SIGNATURE_B}}</div>
  </div>
  {{/if}}
  <div class="footer"><span>LegalBridge / Generic Legal Document</span><span>{{DOC_NO}}</span></div>
</div>
</body>
</html>
$html$,
  $schema$
[
  {"name":"DOCUMENT_TYPE","type":"select","group":"I. 基本情報","label":"文書種別","required":true,"options":["覚書","合意書","通知書","確認書","回答書","その他"]},
  {"name":"DOCUMENT_TITLE","group":"I. 基本情報","label":"文書タイトル","required":true,"placeholder":"例：契約条件変更に関する覚書"},
  {"name":"DOCUMENT_DATE","type":"date","group":"I. 基本情報","label":"作成日","required":true,"dbField":"auto.today"},
  {"name":"PARTY_A","group":"II. 当事者・宛先","label":"当事者・宛先A","placeholder":"株式会社アークライト"},
  {"name":"PARTY_B","group":"II. 当事者・宛先","label":"当事者・宛先B","placeholder":"相手方名称"},
  {"name":"INTRODUCTION","type":"textarea","group":"III. 本文","label":"前文","placeholder":"必要な場合のみ入力"},
  {"name":"BODY","type":"textarea","group":"III. 本文","label":"本文","required":true,"placeholder":"条項・通知内容・確認事項等を入力"},
  {"name":"CLOSING","type":"textarea","group":"III. 本文","label":"末文","placeholder":"必要な場合のみ入力"},
  {"name":"SHOW_SIGNATURES","type":"checkbox","group":"IV. 署名","label":"署名欄を表示"},
  {"name":"SIGNATURE_A","type":"textarea","group":"IV. 署名","label":"署名欄A","placeholder":"住所\n会社名\n代表者"},
  {"name":"SIGNATURE_B","type":"textarea","group":"IV. 署名","label":"署名欄B","placeholder":"住所\n会社名\n代表者"}
]
$schema$::jsonb,
  '汎用単発文書 v1',
  'LegalBridge V2 integrated workflow'
FROM public.document_templates dt
WHERE dt.template_key = 'legal_freeform'
  AND NOT EXISTS (
    SELECT 1
    FROM public.document_template_versions v
    WHERE v.template_id = dt.id AND v.version_no = 1
  );

UPDATE public.document_templates dt
SET current_version_id = v.id,
    updated_at = now()
FROM public.document_template_versions v
WHERE dt.template_key = 'legal_freeform'
  AND v.template_id = dt.id
  AND v.version_no = 1
  AND dt.current_version_id IS NULL;

COMMIT;

SELECT dt.template_key, dt.label, dt.category, dt.current_version_id,
       v.version_no, jsonb_array_length(v.field_schema) AS field_count
FROM document_templates dt
JOIN document_template_versions v ON v.id = dt.current_version_id
WHERE dt.template_key = 'legal_freeform';
