-- =====================================================================
-- 107_statement_receipt_header.sql（Cloud SQL Studio / psql 用）
--
--   利用許諾料計算書の「受領情報（サブライセンス入金）」を直す。
--
--   直すのは本文（ひな形）だけ。中身を入れる側はアプリで直してあるので、
--   この改訂と合わせて次のようになる。
--
--     入金企業            許諾（アウト）の取引先名（払ってきた相手）
--     デザイナー / 権利者  取得（イン）の取引先名（作者）
--     カテゴリー          欄ごと消す（使っていない）
--     入金通貨            アウト条件の通貨。円以外は「（当社適用レート）」
--
--   これまでの本文は
--     {{intakeCurrency}}（入金日レート: {{fxRate}}）
--   と出していた。当社は入金日のレートではなく当社の適用レートで円に直して
--   いるので、書いてあるとおりに検算されると合わない。レートの数値は持って
--   いないので、数値は出さず「当社適用レート」とだけ書く。
--
--   いまの版は残す。document_template_versions に新しい版を作り、
--   document_templates.current_version_id をそちらへ向けるだけ。
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--
--   使い方（1つずつ、順に実行する）
--     【1】 いまの本文を見る。何も変えない
--     【2】 改訂する。(false) を (true) に書き換えてから
--     【3】 確認
--     【4】 戻し方
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】いまの本文に、直す目印があるか。何も変えない。
--
--      「カテゴリーの欄」と「入金日レート」が true なら、まだ改訂していない。
-- ---------------------------------------------------------------------
SELECT t.template_key                                       AS キー,
       v.id                                                 AS 版id,
       v.version_no                                         AS 版番号,
       length(v.html_source)                                AS 本文の長さ,
       (position('<td>{{payerCompany}}</td>' in v.html_source) > 0)
                                                            AS 入金企業の欄,
       (position('<td class="label" style="width:120px;">カテゴリー</td>'
                 in v.html_source) > 0)                     AS カテゴリーの欄,
       (position('（入金日レート: {{fxRate}}）' in v.html_source) > 0)
                                                            AS 入金日レート,
       (position('（当社適用レート）' in v.html_source) > 0) AS 既に改訂済み
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';


-- ---------------------------------------------------------------------
-- 【2】改訂する。★ (false) を (true) に書き換えてから実行。
--
--      置き換えは4つ。どれも1行の中で閉じているので、字下げの違いで
--      外れることがない。
--        1. 入金企業の欄を、消したカテゴリーのぶんまで広げる（colspan=3）
--        2. カテゴリーの見出しを消す
--        3. カテゴリーの値を消す
--        4. 「入金日レート: <数値>」を「当社適用レート」にする
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
src AS (
  SELECT t.id AS template_id, v.id AS from_version, v.html_source, v.variables
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT s.template_id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = s.template_id),
         replace(
           replace(
             replace(
               replace(s.html_source,
                 '<td>{{payerCompany}}</td>',
                 '<td colspan="3">{{payerCompany}}</td>'),
               '<td class="label" style="width:120px;">カテゴリー</td>', ''),
             '<td class="center" style="width:170px;">{{royaltyCategory}}</td>', ''),
           '（入金日レート: {{fxRate}}）', '（当社適用レート）'),
         s.variables,
         '受領情報：入金企業＝許諾先、権利者＝イン取引先、カテゴリー削除、レートは当社適用レート',
         'infra/v3/107'
    FROM src s, go
   WHERE go.ok
     -- 目印が無ければ作らない。本文の作りが変わっている。
     AND position('<td>{{payerCompany}}</td>' in s.html_source) > 0
     -- 既に改訂してあれば作らない（何度流しても同じ結果になる）。
     AND position('（当社適用レート）' in s.html_source) = 0
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates t
     SET current_version_id = m.id
    FROM made m WHERE t.id = m.template_id
  RETURNING t.id, t.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号
  FROM pointed p
UNION ALL
SELECT '—', '0 件', '(false) を (true) に。既に改訂済みか、目印が見つかりません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);


-- ---------------------------------------------------------------------
-- 【3】確認。新しい版から、消したものが消え、入れたものが入っているか。
-- ---------------------------------------------------------------------
SELECT t.template_key                                        AS キー,
       v.id                                                  AS 版id,
       v.version_no                                          AS 版番号,
       v.comment                                             AS 備考,
       (position('{{royaltyCategory}}' in v.html_source) = 0) AS カテゴリーを消した,
       (position('（当社適用レート）' in v.html_source) > 0)   AS 当社適用レート,
       (position('（入金日レート' in v.html_source) = 0)       AS 入金日レートは無い,
       (position('{{payerCompany}}' in v.html_source) > 0)    AS 入金企業は残っている,
       (position('{{designerName}}' in v.html_source) > 0)    AS 権利者は残っている,
       length(v.html_source)                                 AS 本文の長さ
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';


-- ---------------------------------------------------------------------
-- 【4】戻し方。版の一覧を出す。戻すときは current_version_id を前の版に向ける。
--      UPDATE v3.document_templates SET current_version_id = <前の版id>
--       WHERE template_key = 'royalty_statement';
-- ---------------------------------------------------------------------
SELECT v.id AS 版id, v.version_no AS 版番号, v.created_at AS 作成, v.comment AS 備考,
       (v.id = t.current_version_id) AS いま使っている
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.template_id = t.id
 WHERE t.template_key = 'royalty_statement'
 ORDER BY v.version_no DESC;
