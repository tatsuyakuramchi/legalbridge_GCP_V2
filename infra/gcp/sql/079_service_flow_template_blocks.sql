\set ON_ERROR_STOP on
\pset pager off

-- 079_service_flow_template_blocks.sql
-- 業務委託フロー（main 統合 2026-09-06）の選択値を PDF に出す。対象 4 テンプレの現行版に
-- 「条件の概要」ブロックを足した新版を INSERT し、current_version_id を差し替える。
--   service_master        : 契約類型・業務区分・報酬方式・成果物・検収・知的財産権・再委託・個人情報・契約更新
--   purchase_order        : 契約類型・業務区分・成果物・知的財産権・源泉徴収
--   intl_purchase_order   : 同上（英語見出し）
--   inspection_certificate: 確認方法・判定・支払処理
-- いずれも値があるときだけ描く（{{#if}}）。旧文書・値のない文書の出力は変わらない。
-- 差込位置: 本文の最初の </h1> の直後（タイトルの下）。</h1> が無ければ </body> の直前、それも無ければ末尾。
-- 既存文書は自分の版（templateVersionId）で描くので（document-html-renderer の findRenderSource）、
-- 新版を作っても PDF 再発行・Drive 保存は止まらない。冪等（適用済みなら中断）。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_service_blocks=ADD_SERVICE_FLOW_BLOCKS \
--         -f infra/gcp/sql/079_service_flow_template_blocks.sql

\if :{?confirm_service_blocks}
\else
  \echo 'Run with: -v confirm_service_blocks=ADD_SERVICE_FLOW_BLOCKS'
  \quit 2
\endif
SELECT :'confirm_service_blocks' = 'ADD_SERVICE_FLOW_BLOCKS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 適用前: 差込位置の確認（</h1> があるか）。
SELECT t.template_key, v.version_no, length(v.html_source) AS html_len,
       strpos(v.html_source, '</h1>') AS h1_end_pos,
       strpos(v.html_source, '</body>') AS body_end_pos,
       strpos(v.html_source, 'lb-service-terms') > 0 AS already_applied
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('service_master', 'purchase_order', 'intl_purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;

DO $do$
DECLARE
  rec record;
  src text;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  pos int;
  block text;
  row_style constant text := 'padding:3px 8px; border-bottom:1px solid #d0d0d0; vertical-align:top;';
  th_style constant text := 'text-align:left; width:26%; padding:3px 8px; border-bottom:1px solid #d0d0d0; background:#f3f3f3; font-weight:700; white-space:nowrap;';
  -- 業務委託基本契約
  block_service constant text := $b$
{{!-- 079: 業務委託条件の概要（選択式フォームの値があるときだけ描く） --}}
{{#if hasServiceTerms}}
<section class="lb-service-terms" style="margin:8px 0 14px; padding:10px 12px; border:1px solid #888; font-size:9.5pt; break-inside:avoid;">
  <div style="font-weight:700; margin-bottom:6px;">業務委託条件の概要</div>
  <table style="width:100%; border-collapse:collapse; font-size:9.5pt;">
    {{#if SERVICE_ENGAGEMENT_TYPE}}<tr><th style="__TH__">契約類型</th><td style="__TD__">{{SERVICE_ENGAGEMENT_TYPE}}</td></tr>{{/if}}
    {{#if SERVICE_CATEGORY}}<tr><th style="__TH__">業務区分</th><td style="__TD__">{{SERVICE_CATEGORY}}</td></tr>{{/if}}
    {{#if COMPENSATION_TYPE}}<tr><th style="__TH__">報酬方式</th><td style="__TD__">{{COMPENSATION_TYPE}}</td></tr>{{/if}}
    {{#if DELIVERABLE_REQUIRED}}<tr><th style="__TH__">成果物</th><td style="__TD__">{{DELIVERABLE_REQUIRED}}</td></tr>{{/if}}
    {{#if INSPECTION_REQUIRED}}<tr><th style="__TH__">検収</th><td style="__TD__">{{INSPECTION_REQUIRED}}</td></tr>{{/if}}
    {{#if IP_OWNERSHIP}}<tr><th style="__TH__">知的財産権</th><td style="__TD__">{{IP_OWNERSHIP}}</td></tr>{{/if}}
    {{#if SUBCONTRACTING_POLICY}}<tr><th style="__TH__">再委託</th><td style="__TD__">{{SUBCONTRACTING_POLICY}}</td></tr>{{/if}}
    {{#if PERSONAL_DATA_HANDLING}}<tr><th style="__TH__">個人情報</th><td style="__TD__">{{PERSONAL_DATA_HANDLING}}</td></tr>{{/if}}
    {{#if RENEWAL_TYPE}}<tr><th style="__TH__">契約更新</th><td style="__TD__">{{RENEWAL_TYPE}}</td></tr>{{/if}}
  </table>
</section>
{{/if}}
$b$;
  -- 発注書（国内）
  block_po constant text := $b$
{{!-- 079: 業務委託の発注条件（選択式フォームの値があるときだけ描く） --}}
{{#if hasServiceTerms}}
<section class="lb-service-terms" style="margin:8px 0 12px; padding:8px 12px; border:1px solid #888; font-size:9.5pt; break-inside:avoid;">
  <div style="font-weight:700; margin-bottom:4px;">業務委託の条件</div>
  <table style="width:100%; border-collapse:collapse; font-size:9.5pt;">
    {{#if SERVICE_ENGAGEMENT_TYPE}}<tr><th style="__TH__">契約類型</th><td style="__TD__">{{SERVICE_ENGAGEMENT_TYPE}}</td></tr>{{/if}}
    {{#if SERVICE_CATEGORY}}<tr><th style="__TH__">業務区分</th><td style="__TD__">{{SERVICE_CATEGORY}}</td></tr>{{/if}}
    {{#if DELIVERABLE_REQUIRED}}<tr><th style="__TH__">成果物・報告</th><td style="__TD__">{{DELIVERABLE_REQUIRED}}</td></tr>{{/if}}
    {{#if IP_OWNERSHIP}}<tr><th style="__TH__">知的財産権</th><td style="__TD__">{{IP_OWNERSHIP}}</td></tr>{{/if}}
    {{#if WITHHOLDING_TAX}}<tr><th style="__TH__">源泉徴収</th><td style="__TD__">{{WITHHOLDING_TAX}}</td></tr>{{/if}}
  </table>
</section>
{{/if}}
$b$;
  -- 海外発注書（英語見出し・値は入力どおり）
  block_intl constant text := $b$
{{!-- 079: Service engagement terms (rendered only when the selection fields have values) --}}
{{#if hasServiceTerms}}
<section class="lb-service-terms" style="margin:8px 0 12px; padding:8px 12px; border:1px solid #888; font-size:9.5pt; break-inside:avoid;">
  <div style="font-weight:700; margin-bottom:4px;">Engagement Terms</div>
  <table style="width:100%; border-collapse:collapse; font-size:9.5pt;">
    {{#if SERVICE_ENGAGEMENT_TYPE}}<tr><th style="__TH__">Engagement type</th><td style="__TD__">{{SERVICE_ENGAGEMENT_TYPE}}</td></tr>{{/if}}
    {{#if SERVICE_CATEGORY}}<tr><th style="__TH__">Service category</th><td style="__TD__">{{SERVICE_CATEGORY}}</td></tr>{{/if}}
    {{#if DELIVERABLE_REQUIRED}}<tr><th style="__TH__">Deliverables / reporting</th><td style="__TD__">{{DELIVERABLE_REQUIRED}}</td></tr>{{/if}}
    {{#if IP_OWNERSHIP}}<tr><th style="__TH__">Intellectual property</th><td style="__TD__">{{IP_OWNERSHIP}}</td></tr>{{/if}}
    {{#if WITHHOLDING_TAX}}<tr><th style="__TH__">Withholding tax</th><td style="__TD__">{{WITHHOLDING_TAX}}</td></tr>{{/if}}
  </table>
</section>
{{/if}}
$b$;
  -- 検収書
  block_inspection constant text := $b$
{{!-- 079: 検収の確認方法・判定・支払処理（選択式フォームの値があるときだけ描く） --}}
{{#if hasInspectionChoices}}
<section class="lb-service-terms" style="margin:8px 0 12px; padding:8px 12px; border:1px solid #888; font-size:9.5pt; break-inside:avoid;">
  <table style="width:100%; border-collapse:collapse; font-size:9.5pt;">
    {{#if INSPECTION_METHOD}}<tr><th style="__TH__">確認方法</th><td style="__TD__">{{INSPECTION_METHOD}}</td></tr>{{/if}}
    {{#if INSPECTION_RESULT}}<tr><th style="__TH__">判定</th><td style="__TD__">{{INSPECTION_RESULT}}</td></tr>{{/if}}
    {{#if PAYMENT_STATUS}}<tr><th style="__TH__">支払処理</th><td style="__TD__">{{PAYMENT_STATUS}}</td></tr>{{/if}}
  </table>
</section>
{{/if}}
$b$;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('service_master', block_service, '業務委託基本契約テンプレ改訂: 業務委託条件の概要ブロック（079・値があるときのみ）'),
      ('purchase_order', block_po, '発注書テンプレ改訂: 業務委託の条件ブロック（079・値があるときのみ）'),
      ('intl_purchase_order', block_intl, 'Intl PO template revision: engagement terms block (079, rendered only when values exist)'),
      ('inspection_certificate', block_inspection, '検収書テンプレ改訂: 確認方法・判定・支払処理ブロック（079・値があるときのみ）')
    ) AS x(template_key, block_html, comment)
  LOOP
    SELECT t.id, v.html_source INTO tpl_id, src
      FROM document_templates t
      JOIN document_template_versions v ON v.id = t.current_version_id
     WHERE t.template_key = rec.template_key;
    IF src IS NULL THEN
      RAISE EXCEPTION '% テンプレートが見つかりません', rec.template_key;
    END IF;
    IF strpos(src, 'lb-service-terms') > 0 THEN
      RAISE NOTICE '% は適用済み（lb-service-terms あり）。スキップ', rec.template_key;
      CONTINUE;
    END IF;

    block := replace(replace(rec.block_html, '__TH__', th_style), '__TD__', row_style);

    pos := strpos(src, '</h1>');
    IF pos > 0 THEN
      new_html := left(src, pos + length('</h1>') - 1) || block || substr(src, pos + length('</h1>'));
    ELSE
      pos := strpos(src, '</body>');
      IF pos > 0 THEN
        new_html := left(src, pos - 1) || block || substr(src, pos);
      ELSE
        new_html := src || block;
      END IF;
    END IF;

    SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
      FROM document_template_versions WHERE template_id = tpl_id;

    INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
    SELECT tpl_id, next_no, new_html, v.field_schema, rec.comment, 'legalbridge-v2'
      FROM document_templates t
      JOIN document_template_versions v ON v.id = t.current_version_id
     WHERE t.id = tpl_id
    RETURNING id INTO new_id;

    UPDATE document_templates SET current_version_id = new_id WHERE id = tpl_id;
    RAISE NOTICE '% : version % を作成（差込位置 %）', rec.template_key, next_no,
      CASE WHEN strpos(src, '</h1>') > 0 THEN '</h1> の直後' WHEN strpos(src, '</body>') > 0 THEN '</body> の直前' ELSE '末尾' END;
  END LOOP;
END
$do$;

-- 適用後: 新版とブロックの有無。
SELECT t.template_key, v.version_no,
       strpos(v.html_source, 'lb-service-terms') > 0 AS has_block,
       strpos(v.html_source, 'SERVICE_ENGAGEMENT_TYPE') > 0 AS has_engagement_type,
       strpos(v.html_source, 'INSPECTION_RESULT') > 0 AS has_inspection_result
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('service_master', 'purchase_order', 'intl_purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;

COMMIT;
