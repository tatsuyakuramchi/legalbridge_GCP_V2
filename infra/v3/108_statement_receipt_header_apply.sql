-- =====================================================================
-- 108_statement_receipt_header_apply.sql（ops sql / Cloud SQL Studio 用）
--
--   107 の改訂を、書き換えずにそのまま流す版。
--
--   107 は「(false) を (true) に書き換えてから流す」作りにしてある。
--   Windows でファイルを開いて1文字直すのは、文字コードを壊しやすい
--   （UTF-8 に BOM が付くと psql が先頭の文から転ぶ）。中身を確かめる
--   のが 107、流すのが 108、と役割で分ける。
--
--   何をするかは 107 の冒頭に書いてある。直すのは本文の4か所だけ。
--     1. 入金企業の欄を、消したカテゴリーのぶんまで広げる（colspan=3）
--     2. カテゴリーの見出しを消す
--     3. カテゴリーの値を消す
--     4. 「入金日レート: <数値>」を「当社適用レート」にする
--
--   いまの版は残る。新しい版を作って current_version_id を向けるだけ。
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--   何度流しても同じ結果になる（改訂済みなら何もしない）。
--
--   戻すとき（版id は【2】の一覧に出る）:
--     UPDATE v3.document_templates SET current_version_id = 104
--      WHERE template_key = 'royalty_statement';
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 【1】改訂する。
-- ---------------------------------------------------------------------
WITH src AS (
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
         'infra/v3/108'
    FROM src s
   -- 目印が無ければ作らない。本文の作りが変わっている。
   WHERE position('<td>{{payerCompany}}</td>' in s.html_source) > 0
     -- 既に改訂してあれば作らない。
     AND position('（当社適用レート）' in s.html_source) = 0
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates t
     SET current_version_id = m.id
    FROM made m WHERE t.id = m.template_id
  RETURNING t.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号
  FROM pointed p
UNION ALL
SELECT '—', '0 件', '既に改訂済みか、目印が見つかりません（107 の【1】で確かめてください）'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);


-- ---------------------------------------------------------------------
-- 【2】確認。消したものが消え、入れたものが入っているか。
--      「戻すときの版id」は、いま使っている版のひとつ前。
-- ---------------------------------------------------------------------
SELECT t.template_key                                        AS キー,
       v.id                                                  AS 版id,
       v.version_no                                          AS 版番号,
       (position('{{royaltyCategory}}' in v.html_source) = 0) AS カテゴリーを消した,
       (position('（当社適用レート）' in v.html_source) > 0)   AS 当社適用レート,
       (position('（入金日レート' in v.html_source) = 0)       AS 入金日レートは無い,
       (position('{{payerCompany}}' in v.html_source) > 0)    AS 入金企業は残っている,
       (position('{{designerName}}' in v.html_source) > 0)    AS 権利者は残っている,
       length(v.html_source)                                 AS 本文の長さ
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';

SELECT v.id AS 版id, v.version_no AS 版番号, v.comment AS 備考,
       (v.id = t.current_version_id) AS いま使っている
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.template_id = t.id
 WHERE t.template_key = 'royalty_statement'
 ORDER BY v.version_no DESC
 LIMIT 5;

-- ---------------------------------------------------------------------
-- 【3】受領通貨の確かめ。
--
--      入金通貨の欄はアウト条件の通貨を出す。JPY のままなら「JPY」と出て、
--      「（当社適用レート）」も出ない（円建てにレートは要らない）。
--      USD で受け取っている契約は、条件の通貨を USD にしておく。
-- ---------------------------------------------------------------------
SELECT c.condition_no AS 条件番号, p.name AS 取引先, c.name AS 条件名,
       c.currency AS 通貨, c.status AS 状態
  FROM v3.conditions c
  LEFT JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE c.direction = 'out'
   AND c.status IN ('active', 'draft')
 ORDER BY (c.currency = 'JPY') DESC, c.condition_no
 LIMIT 50;
