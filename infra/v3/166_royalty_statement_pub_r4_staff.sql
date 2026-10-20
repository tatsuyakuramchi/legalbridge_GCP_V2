-- =====================================================================
-- 166_royalty_statement_pub_r4_staff.sql（Cloud SQL Studio でも psql でも流せる）
--
--   出版専用の利用許諾料計算書（royalty_statement_pub）の r4。「作成者」の下に担当者の行を足す。
--
--     担当　{部署}　{名前}　{メール}　TEL {電話}
--       担当者は 文書で選んだ担当 → 案件の担当 → デイリータスクの担当（STAFF_NAME など）。
--       まとめて締める・計算書の一括の出し直しでは、画面で担当者を選べる。
--     担当者が決まらないとき：担当　{事業名}
--       事業名は案件の事業区分、案件が無ければ出版の計算書は「出版事業」（STAFF_UNIT）。
--     どちらも無ければ、担当の行は出さない。
--
--   いまの版（r3）の本文の「作成者」の欄だけを置き換えて r4 の版を足し、それを使う版にする。
--   r3 の本文が使われているときだけ足す。何度流しても同じ結果。
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--   戻すときは、ひとつ前の版（r3）へ current_version_id を向け直す。
-- =====================================================================

INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
SELECT d.id,
       (SELECT max(x.version_no) + 1 FROM v3.document_template_versions x WHERE x.template_id = d.id),
       replace(replace(v.html_source,
           '<!-- royalty_statement_pub r3 -->',
           '<!-- royalty_statement_pub r4 -->'),
           '  {{#if COMPANY_INVOICE_NO}}登録番号 {{COMPANY_INVOICE_NO}}{{/if}}' || chr(10) || '</div>',
           '  {{#if COMPANY_INVOICE_NO}}登録番号 {{COMPANY_INVOICE_NO}}{{/if}}' || chr(10)
           || '  {{#if STAFF_NAME}}<br>担当　{{#if STAFF_DEPARTMENT}}{{STAFF_DEPARTMENT}}　{{/if}}{{STAFF_NAME}}'
           || '{{#if STAFF_EMAIL}}　{{STAFF_EMAIL}}{{/if}}{{#if STAFF_PHONE}}　TEL {{STAFF_PHONE}}{{/if}}'
           || '{{else}}{{#if STAFF_UNIT}}<br>担当　{{STAFF_UNIT}}{{/if}}{{/if}}' || chr(10) || '</div>'),
       '[]'::jsonb,
       'r4：作成者の下に担当者（部署・名前・メール・電話）。担当者が決まらなければ事業名',
       'infra/v3/166'
  FROM v3.document_templates d
  JOIN v3.document_template_versions v ON v.id = d.current_version_id
 WHERE d.template_key = 'royalty_statement_pub'
   AND position('<!-- royalty_statement_pub r3 -->' in v.html_source) > 0
   AND position('  {{#if COMPANY_INVOICE_NO}}登録番号 {{COMPANY_INVOICE_NO}}{{/if}}' || chr(10) || '</div>' in v.html_source) > 0;

UPDATE v3.document_templates d
   SET current_version_id = (SELECT max(x.id) FROM v3.document_template_versions x
                              WHERE x.template_id = d.id
                                AND position('<!-- royalty_statement_pub r4 -->' in x.html_source) > 0)
 WHERE d.template_key = 'royalty_statement_pub'
   AND EXISTS (SELECT 1 FROM v3.document_template_versions x
                WHERE x.template_id = d.id
                  AND position('<!-- royalty_statement_pub r4 -->' in x.html_source) > 0);

-- 確認。r4 が true、担当の行あり が true になっていれば完了。
-- r4 が false なら、いまの版が r3 ではない（先に 165 を流す）か、作成者の欄の形が想定と違う。
SELECT t.template_key AS キー, v.id AS 版id, v.version_no AS 版番号,
       (position('royalty_statement_pub r4' in v.html_source) > 0) AS r4,
       (position('{{STAFF_UNIT}}' in v.html_source) > 0) AS 担当の行あり
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement_pub';
