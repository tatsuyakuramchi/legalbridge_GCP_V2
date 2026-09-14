-- =====================================================================
-- 110_statement_drop_desired_deadline.sql（ops sql / Cloud SQL Studio 用）
--
--   利用許諾料計算書から「希望納期」の欄を消す。
--
--   この欄は Slack の作業依頼フォームの「希望納期（文書作成等）」の残り。
--   「この書類をいつまでに作ってほしいか」という社内の依頼情報で、相手に
--   出す計算書に載る筋のものではない。V2 は値が無いときに支払期日で
--   埋めるようにしていたので、隣の「支払期日」と同じ日付が2回並んでいた。
--   V3 はこの値を供給していないので、いまは見出しだけが空欄で残っている。
--
--   消すのは2か所。
--     1. 受領情報の表の中の行（{{#if desiredDeadline}} …… {{/if}}）
--     2. 下の合計の枠の列（見出しの td/th と、{{desiredDeadline}} の td/th）
--   片方だけ消すともう片方が紙に残るので、両方まとめて消す。
--
--   ★ 消し切れなかったとき、消しすぎたときは、新しい版を作らない。
--     本文の作りが想定と違うということなので、中途半端な版を current に
--     向けるより、何もしないほうがよい。そのときは
--     099_diagnose_statement_header.sql の出力を見て手を入れる。
--
--   ※ 最初の版は {{#if desiredDeadline}}.*?{{/if}} で消していて、本文を
--     2万字から8千字に削った。Postgres の正規表現は「最初に優先を持つ
--     量指定子」が式全体の貪欲さを決める。先頭に置いた \s* が貪欲なので、
--     後ろの .*? も貪欲に振る舞い、最初の {{#if}} から**最後の** {{/if}}
--     までが消えた。いまは {{/if}} を跨げない書き方にしてあり、貪欲さに
--     左右されない。長さと目印の見張りも足した。
--
--   いまの版は残る。新しい版を作って current_version_id を向けるだけ。
--   発行済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--   何度流しても同じ結果になる（消し終わっていれば何もしない）。
--
--   戻すとき（版id は【2】の一覧に出る）:
--     UPDATE v3.document_templates SET current_version_id = <前の版id>
--      WHERE template_key = 'royalty_statement';
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 【1】消す。
-- ---------------------------------------------------------------------
WITH src AS (
  SELECT t.id AS template_id, v.id AS from_version, v.html_source, v.variables
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'royalty_statement'
),
cut AS (
  SELECT s.*,
         regexp_replace(
           regexp_replace(
             regexp_replace(s.html_source,
               -- 1. 受領情報の表の中の行。丸ごと。
               -- (?:(?!\{\{/if\}\}).)* ＝「{{/if}} ではない文字」の繰り返し。
               -- 最初の {{/if}} で必ず止まる。.*? と違い、式全体の貪欲さに
               -- 左右されない（先頭に \s* を置くと .*? も貪欲になる）。
               '\{\{#if desiredDeadline\}\}(?:(?!\{\{/if\}\}).)*\{\{/if\}\}', '', 'g'),
             -- 2a. 見出しの枡（中身が「希望納期」だけのもの）。
             '\s*<t[dh][^>]*>[^<]*希望納期[^<]*</t[dh]>', '', 'g'),
           -- 2b. 値の枡。
           '\s*<t[dh][^>]*>\s*\{\{desiredDeadline\}\}\s*</t[dh]>', '', 'g') AS html
    FROM src s
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT c.template_id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = c.template_id),
         c.html, c.variables,
         '希望納期の欄を削除（Slack 作業依頼の残りで、計算書には関係しない）',
         'infra/v3/110'
    FROM cut c
   -- まだ残っているときだけ作る（消し終わっていれば何もしない）。
   -- OR を括る。括らないと AND のほうが先に効いて、
   -- 「残っている」だけで通ってしまい、消し切れていない版が current になる。
   WHERE (position('希望納期' in c.html_source) > 0
          OR position('desiredDeadline' in c.html_source) > 0)
   -- ★ 消し切れていなければ作らない。
     AND position('希望納期' in c.html) = 0
     AND position('desiredDeadline' in c.html) = 0
   -- ★ 消しすぎていても作らない。消えるのは数百字。1000字を超えて減るのは
   --   行き過ぎで、本文を壊している。
     AND length(c.html) >= length(c.html_source) - 1000
   -- ★ 紙の骨組みが残っていなければ作らない。長さだけでは、真ん中が
   --   まるごと抜けたことに気づけない。
     AND position('{{paymentDueDate}}' in c.html) > 0
     AND position('{{totalPaymentStr}}' in c.html) > 0
     AND position('{{payerCompany}}' in c.html) > 0
     AND position('{{designerName}}' in c.html) > 0
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates t
     SET current_version_id = m.id
    FROM made m WHERE t.id = m.template_id
  RETURNING t.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号,
       '消しました' AS 結果
  FROM pointed p
UNION ALL
SELECT '—', '0 件', '',
       CASE
         WHEN (SELECT position('希望納期' in html_source) = 0
                 AND position('desiredDeadline' in html_source) = 0 FROM src)
           THEN '既に消えています（何もしていません）'
         WHEN (SELECT length(html) < length(html_source) - 1000 FROM cut)
           THEN '消しすぎになるので止めました（' ||
                (SELECT (length(html_source) - length(html))::text FROM cut) ||
                ' 字減る）。099 の出力を見てください'
         WHEN (SELECT position('{{paymentDueDate}}' in html) = 0
                 OR position('{{totalPaymentStr}}' in html) = 0
                 OR position('{{payerCompany}}' in html) = 0
                 OR position('{{designerName}}' in html) = 0 FROM cut)
           THEN '紙の骨組みまで消えるので止めました。099 の出力を見てください'
         ELSE '消し切れませんでした。本文の作りが想定と違います。'
                || '099_diagnose_statement_header.sql の「希望納期」の出力を見てください'
       END
 WHERE NOT EXISTS (SELECT 1 FROM pointed);


-- ---------------------------------------------------------------------
-- 【2】確認。いま使っている版に「希望納期」が残っていないか。
-- ---------------------------------------------------------------------
SELECT t.template_key                                      AS キー,
       v.id                                                AS 版id,
       v.version_no                                        AS 版番号,
       (position('希望納期' in v.html_source) = 0)          AS 希望納期は無い,
       (position('desiredDeadline' in v.html_source) = 0)  AS 変数も無い,
       (position('{{paymentDueDate}}' in v.html_source) > 0) AS 支払期日は残っている,
       (position('{{totalPaymentStr}}' in v.html_source) > 0) AS 合計は残っている,
       (position('{{payerCompany}}' in v.html_source) > 0)  AS 入金企業は残っている,
       (position('{{designerName}}' in v.html_source) > 0)  AS 権利者は残っている,
       length(v.html_source)                               AS 本文の長さ
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
