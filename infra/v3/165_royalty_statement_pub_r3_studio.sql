-- =====================================================================
-- 165_royalty_statement_pub_r3_studio.sql（Cloud SQL Studio 用）
--
--   165_royalty_statement_pub_r3.sql と同じ結果を、Studio で流せる形にしたもの
--   （ドル記号の引用を使わず、いまの版（r2）の本文を置き換えて r3 の版を足す）。
--   r2 の本文が使われているときだけ足す。何度流しても同じ結果。
-- =====================================================================

INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
SELECT d.id,
       (SELECT max(x.version_no) + 1 FROM v3.document_template_versions x WHERE x.template_id = d.id),
       replace(replace(replace(replace(replace(replace(v.html_source,
           '<!-- royalty_statement_pub r2 -->',
           '<!-- royalty_statement_pub r3 -->'),
           '</style>',
           '.c.wrap { white-space: normal }' || chr(10) || '  table.t td.work { min-width: 40mm }' || chr(10) || '</style>'),
           '<tr><td>{{title}}</td><td class="c">{{media}}</td><td class="c">{{period}}</td>',
           '<tr><td class="work">{{title}}</td><td class="c">{{media}}</td><td class="c wrap">{{period}}</td>'),
           '<th>お支払額（税込）</th>',
           '<th>お支払額（税込・源泉徴収前）</th>'),
           '  {{#if pubHasWithholding}}' || chr(10) || '  <tr><th>源泉徴収税額</th><td class="r">▲¥{{pubWithholdingStr}}</td></tr>' || chr(10) || '  <tr class="big"><th>差引お振込額</th><td class="r">¥{{pubNetTransferStr}}</td></tr>' || chr(10) || '  {{/if}}' || chr(10) || '',
           ''),
           '<p class="note">本計算書は仕入明細書として作成しています。',
           '{{#if pubHasWithholding}}<p class="note">※ お振込額は、上記のお支払額（税込）から源泉徴収税額を差し引いた金額となります。</p>{{/if}}' || chr(10) || '<p class="note">本計算書は仕入明細書として作成しています。'),
       '[]'::jsonb,
       'r3：源泉徴収税額・差引お振込額の行を消して税込（源泉徴収前）で締め、源泉の注記。作品の列の潰れを直す',
       'infra/v3/165_studio'
  FROM v3.document_templates d
  JOIN v3.document_template_versions v ON v.id = d.current_version_id
 WHERE d.template_key = 'royalty_statement_pub'
   AND position('<!-- royalty_statement_pub r2 -->' in v.html_source) > 0;

UPDATE v3.document_templates d
   SET current_version_id = (SELECT max(x.id) FROM v3.document_template_versions x
                              WHERE x.template_id = d.id
                                AND position('<!-- royalty_statement_pub r3 -->' in x.html_source) > 0)
 WHERE d.template_key = 'royalty_statement_pub'
   AND EXISTS (SELECT 1 FROM v3.document_template_versions x
                WHERE x.template_id = d.id
                  AND position('<!-- royalty_statement_pub r3 -->' in x.html_source) > 0);

-- 確認。r3 が true、源泉の行なし が true になっていれば完了。
SELECT t.template_key AS キー, v.id AS 版id, v.version_no AS 版番号,
       (position('royalty_statement_pub r3' in v.html_source) > 0) AS r3,
       (position('差引お振込額' in v.html_source) = 0) AS 源泉の行なし
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement_pub';
