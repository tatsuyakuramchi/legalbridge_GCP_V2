-- =====================================================================
-- 157_statement_model_header.sql（Cloud SQL Studio / psql 用）
--
--   利用許諾料計算書の「■ 受領情報（サブライセンス入金）」の表を、
--   取引モデルの表にする。直すのは本文（ひな形）の文言2か所だけ。
--
--     見出し   受領情報（サブライセンス入金） → 取引モデル
--     項目名   入金企業                       → 取引モデル概要
--
--   欄の中身（変数 payerCompany）はアプリで取引モデルごとに組む
--   （apps/legalbridge-v3/src/server/royalty/statement-model.ts）。
--
--     自社製造・自社販売   アークライト版（会社情報の会社名から「株式会社」を外して「版」）
--     再許諾               {アウト条件の取引先}再許諾分
--     自社製造・他社販売   {アウト条件の取引先}版
--     1枚に複数            明細の並び順で最初の1つ ＋「ほかN件」
--
--   「デザイナー / 権利者」「入金通貨」の欄はそのまま。
--
--   いまの版は残す。新しい版を作って current_version_id を向けるだけ。
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--
--   ファイルをそのまま流してよい（書き換えは要らない）。
--   本文には「受領情報（サブライセンス入金）」が2か所ある。
--     {{#if receiptRows}} 側 … サブライセンシーごとの受領明細の表（旧方式の手入力）。
--                              本当にサブライセンス入金の表なので、変えない
--     {{else}} 側           … 入金企業／デザイナー・権利者／入金通貨の表。ここを変える
--   見出しの直後に「入金企業」の項目名が続く並び（間は空白とタグだけ）を目印にして、
--   2つ目だけに当てる。目印がちょうど1回あるときだけ改訂し、0回や2回以上なら
--   本文の作りが想定と違うので、何もせずに【1】の結果で知らせる。
--   何度流しても同じ結果になる（改訂済みなら何もしない）。
--
--   アプリを先に出してから流す。順番が逆だと、見出しが「取引モデル」なのに
--   欄に入金企業の名前が出る期間ができる（害は無いが紛らわしい）。
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 【1】いまの本文の目印を数える。何も変えない。
--      「変える表の数」が 1 なら【2】で改訂される。
-- ---------------------------------------------------------------------
\set mark '■ 受領情報（サブライセンス入金）(</div>\\s*<table[^>]*>\\s*<tr>\\s*<td class="label"[^>]*>)入金企業(</td>)'

SELECT t.template_key                                                    AS キー,
       v.id                                                              AS 版id,
       v.version_no                                                      AS 版番号,
       (SELECT count(*) FROM regexp_matches(v.html_source, '受領情報（サブライセンス入金）', 'g'))
                                                                         AS 見出しの数,
       (SELECT count(*) FROM regexp_matches(v.html_source, :'mark', 'g'))  AS 変える表の数,
       (position('>取引モデル概要<' in v.html_source) > 0)                  AS 既に改訂済み
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'royalty_statement';


-- ---------------------------------------------------------------------
-- 【2】改訂する。
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
         regexp_replace(s.html_source, :'mark', '■ 取引モデル\1取引モデル概要\2'),
         s.variables,
         '受領情報（サブライセンス入金）→取引モデル、入金企業→取引モデル概要（receiptRows の明細表はそのまま）',
         'infra/v3/157'
    FROM src s
   -- 目印がちょうど1回のときだけ作る。
   WHERE (SELECT count(*) FROM regexp_matches(s.html_source, :'mark', 'g')) = 1
     -- 既に改訂してあれば作らない。
     AND position('>取引モデル概要<' in s.html_source) = 0
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
SELECT '—', '0 件', '既に改訂済みか、変える表の数が1ではありません（【1】の結果を見てください）'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);


-- ---------------------------------------------------------------------
-- 【3】確認。見出しは receiptRows の明細表の1か所だけ残り、表は取引モデルになっているか。
-- ---------------------------------------------------------------------
SELECT t.template_key                                                  AS キー,
       v.id                                                            AS 版id,
       v.version_no                                                    AS 版番号,
       (SELECT count(*) FROM regexp_matches(v.html_source, '受領情報（サブライセンス入金）', 'g'))
                                                                       AS 残る見出しの数_1なら正しい,
       (position('■ 取引モデル<' in v.html_source) > 0)                 AS 新しい見出し,
       (position('>取引モデル概要<' in v.html_source) > 0)              AS 取引モデル概要,
       (position('{{payerCompany}}' in v.html_source) > 0)             AS 変数は残っている
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
-- 【4】戻すとき（版id は【3】の一覧の「ひとつ前」）:
--   UPDATE v3.document_templates SET current_version_id = <ひとつ前の版id>
--    WHERE template_key = 'royalty_statement';
-- ---------------------------------------------------------------------
