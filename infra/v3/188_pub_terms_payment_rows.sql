-- =====================================================================
-- 188_pub_terms_payment_rows.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   出版等利用許諾条件書 第５条（支払時期・方法）：載っていない媒体の行を「—」にする（A-111）。
--
--   電子書籍配信の条件を載せていない条件書でも「毎年7月1日〜翌年6月30日を集計期間とし、10月末日
--   までに支払う。」の既定文が出ていた。本文の値（digitalPeriod・payDigital）を「—」にしても
--   文の枠がひな形にあるので「毎年—を集計期間とし、—までに支払う。」になる。枠ごと分岐させる。
--     紙媒体出版   … {{#if hasPrintMedia}}…{{else}}—{{/if}}
--     電子書籍配信 … {{#if hasDigitalMedia}}…{{else}}—{{/if}}
--     翻訳版       … {{#if hasTranslation}}…{{else}}—{{/if}}
--   hasPrintMedia / hasDigitalMedia は本文側（pub-terms.ts）が載っている条件の媒体から出す。
--
--   2 本のひな形の両方を改訂する（本文は現行の版を置換して作る）。
--     pub_license_terms_v3        … 一覧形式  r11 → r12
--     pub_license_terms_v3_annex  … 別紙形式  r7  → r8
--   先に 163 を流しておくこと（r11 / r7 が current であること）。
--   何度流しても同じ結果（目印の版が current なら何もしない）。
--
--   戻すとき（版id は結果の一覧に出る）:
--     UPDATE v3.document_templates SET current_version_id = <前の版id>
--      WHERE template_key = 'pub_license_terms_v3';
--     UPDATE v3.document_templates SET current_version_id = <前の版id>
--      WHERE template_key = 'pub_license_terms_v3_annex';
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 【1】一覧形式（pub_license_terms_v3）r11 → r12
-- ---------------------------------------------------------------------
WITH t AS (
  SELECT d.id, d.current_version_id
    FROM v3.document_templates d
   WHERE d.template_key = 'pub_license_terms_v3'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = t.id),
         replace(replace(replace(replace(v.html_source,
           '<!-- pub_license_terms_v3 r11 -->',
           '<!-- pub_license_terms_v3 r12 -->'),
           $s$  <tr><th>紙媒体出版</th><td>刷部数確定の都度、{{payPrint}}までに支払う。</td></tr>$s$,
           $s$  <tr><th>紙媒体出版</th><td>{{#if hasPrintMedia}}刷部数確定の都度、{{payPrint}}までに支払う。{{else}}—{{/if}}</td></tr>$s$),
           $s$  <tr><th>電子書籍配信</th><td>毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。</td></tr>$s$,
           $s$  <tr><th>電子書籍配信</th><td>{{#if hasDigitalMedia}}毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。{{else}}—{{/if}}</td></tr>$s$),
           $s$  <tr><th>翻訳版</th><td>乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。</td></tr>$s$,
           $s$  <tr><th>翻訳版</th><td>{{#if hasTranslation}}乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。{{else}}—{{/if}}</td></tr>$s$),
         v.variables,
         'r12：第５条の支払時期は、載っていない媒体（紙・電子・翻訳版）の行を「—」にする（A-111）',
         'infra/v3/188'
    FROM t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE position('<!-- pub_license_terms_v3 r11 -->' in v.html_source) > 0
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates d
     SET current_version_id = m.id
    FROM made m WHERE d.id = m.template_id
  RETURNING d.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号
  FROM pointed p
UNION ALL
SELECT '—', '0 件', '一覧形式：r11 が current でない（r12 済みか、163 が未適用）。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【2】別紙形式（pub_license_terms_v3_annex）r7 → r8
-- ---------------------------------------------------------------------
WITH t AS (
  SELECT d.id, d.current_version_id
    FROM v3.document_templates d
   WHERE d.template_key = 'pub_license_terms_v3_annex'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT t.id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = t.id),
         replace(replace(replace(replace(v.html_source,
           '<!-- pub_license_terms_v3_annex r7 -->',
           '<!-- pub_license_terms_v3_annex r8 -->'),
           $s$  <tr><th>紙媒体出版</th><td>刷部数確定の都度、{{payPrint}}までに支払う。</td></tr>$s$,
           $s$  <tr><th>紙媒体出版</th><td>{{#if hasPrintMedia}}刷部数確定の都度、{{payPrint}}までに支払う。{{else}}—{{/if}}</td></tr>$s$),
           $s$  <tr><th>電子書籍配信</th><td>毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。</td></tr>$s$,
           $s$  <tr><th>電子書籍配信</th><td>{{#if hasDigitalMedia}}毎年{{digitalPeriod}}を集計期間とし、{{payDigital}}までに支払う。{{else}}—{{/if}}</td></tr>$s$),
           $s$  <tr><th>翻訳版</th><td>乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。</td></tr>$s$,
           $s$  <tr><th>翻訳版</th><td>{{#if hasTranslation}}乙が再許諾先から対価を受領した日の{{payTranslation}}までに支払う。{{else}}—{{/if}}</td></tr>$s$),
         v.variables,
         'r8：第５条の支払時期は、載っていない媒体（紙・電子・翻訳版）の行を「—」にする（A-111）',
         'infra/v3/188'
    FROM t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE position('<!-- pub_license_terms_v3_annex r7 -->' in v.html_source) > 0
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates d
     SET current_version_id = m.id
    FROM made m WHERE d.id = m.template_id
  RETURNING d.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号
  FROM pointed p
UNION ALL
SELECT '—', '0 件', '別紙形式：r7 が current でない（r8 済みか、163 が未適用）。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【3】確認。両方とも「目印あり」「分岐あり」が true なら完了。
-- ---------------------------------------------------------------------
SELECT d.template_key AS キー,
       (position(CASE d.template_key WHEN 'pub_license_terms_v3' THEN '<!-- pub_license_terms_v3 r12 -->'
                                     ELSE '<!-- pub_license_terms_v3_annex r8 -->' END in v.html_source) > 0) AS 目印あり,
       (position('{{#if hasDigitalMedia}}' in v.html_source) > 0) AS 分岐あり,
       v.version_no AS 版番号
  FROM v3.document_templates d
  JOIN v3.document_template_versions v ON v.id = d.current_version_id
 WHERE d.template_key IN ('pub_license_terms_v3', 'pub_license_terms_v3_annex');
