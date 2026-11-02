-- =====================================================================
-- 197_pub_terms_review_fixes.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   出版等利用許諾条件書：アーカム 62 点の条件書の読み合わせで出た直し。
--
--   1. 第３条 許諾期間：作品ごとの許諾期間が一覧に出ているときは、本文は一覧に準拠する
--      （「2004-09-10 〜 2029-05-28」のような外包みの 1 行を出さない。終期が一覧の最も遅い終期と
--      合わないことがあった）。一覧に無いときだけ、これまでどおり 開始 〜 終期。
--   2. 第４条 紙媒体出版：増刷時の非加算（刷部数に所定の率を乗じた部数を印税対象部数とする定め）の
--      ある作品は一覧の備考欄による、の 1 文を足す（備考は pub-terms.ts が条件の 2 版目以降の非加算から書く）。
--   3. 第４条 電子書籍配信：電子の条件の価格の基準が「入金額」なら 乙が配信事業者から受領する金額 × 料率
--      （digitalReceiptBasis）。混ざれば配信価格の式のまま、備考に「電子の料率は乙の入金額に対する率」
--      とある作品だけ受領額基準（digitalBasisMixed）。
--   4. 第５条 報告：受領額基準の作品は受領額も明細に。
--   5. 一覧の注記：「更新 n 回」は 刊行日（許諾開始日）から締結日までに自動更新した回数（締結後ではない）。
--
--   2 本のひな形の両方を改訂する（本文は現行の版を置換して作る）。
--     pub_license_terms_v3        … 一覧形式  r12 → r13
--     pub_license_terms_v3_annex  … 別紙形式  r8  → r9
--   先に 188 を流しておくこと（r12 / r8 が current であること）。
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
-- 【1】一覧形式（pub_license_terms_v3）r12 → r13
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
         replace(replace(replace(replace(replace(replace(v.html_source,
           '<!-- pub_license_terms_v3 r12 -->',
           '<!-- pub_license_terms_v3 r13 -->'),
           $s$<tr><th>許諾期間</th><td>{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{#if hasWorkTerms}}（対象著作物ごとの許諾期間と更新は一覧の「許諾期間」の行による）{{/if}}</td></tr>$s$,
           $s$<tr><th>許諾期間</th><td>{{#if hasWorkTerms}}対象著作物ごとに第１条一覧の「許諾期間」の行による（自動更新した回数は同行のとおり）。{{else}}{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{/if}}</td></tr>$s$),
           $s$印税対象部数は刷部数とし、見本・献本・破損分を除く。$s$,
           $s$印税対象部数は刷部数とし、見本・献本・破損分を除く。増刷時に刷部数の一部を印税対象部数から除く定め（非加算）のある作品は、一覧の備考欄の率による。$s$),
           $s$<td>配信価格（税抜）× ダウンロード数 × 料率（第１条一覧「電子」欄）。$s$,
           $s$<td>{{#if digitalReceiptBasis}}乙が電子書店その他の配信事業者から受領する金額（税抜）× 料率（第１条一覧「電子」欄）。{{else}}配信価格（税抜）× ダウンロード数 × 料率（第１条一覧「電子」欄）。{{#if digitalBasisMixed}}ただし、一覧の備考欄に「電子の料率は乙の入金額に対する率」とある作品は、乙が配信事業者から受領する金額（税抜）× 料率とする。{{/if}}{{/if}}$s$),
           $s$刷部数・定価・ダウンロード数・配信価格を記載した明細$s$,
           $s$刷部数・定価・ダウンロード数・配信価格（受領する金額を基準とする作品はその額）を記載した明細$s$),
           $s$「更新 n 回」は本条件書の締結後に自動更新した回数を示す（第３条）$s$,
           $s$「更新 n 回」は許諾開始日（刊行日）から本条件書の締結日までに自動更新した回数を示す（第３条）$s$),
         v.variables,
         'r13：第３条の許諾期間は一覧に準拠、第４条に増刷時の非加算と電子の受領額基準、更新回数の注記（アーカム条件書の読み合わせ）',
         'infra/v3/197'
    FROM t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE position('<!-- pub_license_terms_v3 r12 -->' in v.html_source) > 0
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
SELECT '—', '0 件', '一覧形式：r12 が current でない（r13 済みか、188 が未適用）。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【2】別紙形式（pub_license_terms_v3_annex）r8 → r9
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
         replace(replace(replace(replace(replace(replace(v.html_source,
           '<!-- pub_license_terms_v3_annex r8 -->',
           '<!-- pub_license_terms_v3_annex r9 -->'),
           $s$<tr><th>許諾期間</th><td>{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{#if hasWorkTerms}}（対象著作物ごとの許諾期間と更新は一覧の「許諾期間」の行による）{{/if}}</td></tr>$s$,
           $s$<tr><th>許諾期間</th><td>{{#if hasWorkTerms}}対象著作物ごとに別紙1の「許諾期間」の行による（自動更新した回数は同行のとおり）。{{else}}{{formatDate termStart}}{{#if termEnd}} 〜 {{formatDate termEnd}}{{else}} から（期間の定めなし）{{/if}}{{/if}}</td></tr>$s$),
           $s$印税対象部数は刷部数とし、見本・献本・破損分を除く。$s$,
           $s$印税対象部数は刷部数とし、見本・献本・破損分を除く。増刷時に刷部数の一部を印税対象部数から除く定め（非加算）のある作品は、別紙1の備考の率による。$s$),
           $s$<td>配信価格（税抜）× ダウンロード数 × 料率（別紙1の「電子」欄）。$s$,
           $s$<td>{{#if digitalReceiptBasis}}乙が電子書店その他の配信事業者から受領する金額（税抜）× 料率（別紙1の「電子」欄）。{{else}}配信価格（税抜）× ダウンロード数 × 料率（別紙1の「電子」欄）。{{#if digitalBasisMixed}}ただし、別紙1の備考に「電子の料率は乙の入金額に対する率」とある作品は、乙が配信事業者から受領する金額（税抜）× 料率とする。{{/if}}{{/if}}$s$),
           $s$刷部数・定価・ダウンロード数・配信価格を記載した明細$s$,
           $s$刷部数・定価・ダウンロード数・配信価格（受領する金額を基準とする作品はその額）を記載した明細$s$),
           $s$「更新 n 回」は本条件書の締結後に自動更新した回数を示す（第３条）$s$,
           $s$「更新 n 回」は許諾開始日（刊行日）から本条件書の締結日までに自動更新した回数を示す（第３条）$s$),
         v.variables,
         'r9：第３条の許諾期間は別紙1に準拠、第４条に増刷時の非加算と電子の受領額基準、更新回数の注記（アーカム条件書の読み合わせ）',
         'infra/v3/197'
    FROM t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE position('<!-- pub_license_terms_v3_annex r8 -->' in v.html_source) > 0
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
SELECT '—', '0 件', '別紙形式：r8 が current でない（r9 済みか、188 が未適用）。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);
