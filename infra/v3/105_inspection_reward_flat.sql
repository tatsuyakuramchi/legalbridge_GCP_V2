-- =====================================================================
-- 105_inspection_reward_flat.sql（Cloud SQL Studio 用）
--
--   104 の続き。検収書の「単票」の枝にも、業績連動の報酬の内訳を出す。
--
--   検収書の本文には明細の枝が2つある。
--     まとめ（paymentGroups）… 過去に支払済みの行があるとき、支払日ごと
--     単票  （delivery_line_items）… 初回。支払済みの行がまだ無いとき
--   104 はまとめの枝だけを直した。初回の検収書は単票の枝で出るので、
--   業績連動の1枚目には報酬の名称も料率も根拠も出ないままだった。
--
--   単票の枝は仕様（spec）を {{#if (or spec ../spec)}} で括っている。
--   内訳をその中に入れると、仕様が空の行では報酬の名前ごと消える。
--   そうならないよう、いったん if を閉じ、内訳を出し、また開く
--   （開き直した側は空のまま元の {{/if}} で閉じる。数は合っている）。
--
--   いまの版は残す。新しい版を作って current_version_id を向けるだけ。
--   戻すときは current_version_id を元の版に戻す（【4】に出る）。
--
--   使い方（1つずつ、順に実行する）
--     【1】 報告。何も変えない。目印の数を見る
--     【2】 改訂する。(false) を (true) に書き換えてから
--     【3】 確認
--     【4】 戻し方（控えておく）
--
--   ※ 104 を先に流しておくこと。104 がまとめの枝、105 が単票の枝。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
--
--   「単票の目印」が 1 でないと【2】は何もしない。0 なら本文の作りが
--   変わっている。2 以上なら同じ書き方が他所にもあるので、当てる場所を
--   決め直す必要がある。どちらもこちらへ知らせてください。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, t.label AS 名前,
       v.id AS いまの版id, v.version_no AS 版番号,
       length(v.html_source) AS 本文の長さ,
       (length(v.html_source)
        - length(replace(v.html_source,
            '<div class="item-spec">{{or spec ../spec}}</div>', '')))
       / nullif(length('<div class="item-spec">{{or spec ../spec}}</div>'), 0)
         AS 単票の目印,
       (v.html_source LIKE '%{{#if reward_label}}%') AS まとめの枝は改訂済み,
       -- 単票の枝に既に入れてあれば、【2】は何もしない（冪等）。
       (v.html_source LIKE '%業績連動の内訳。仕様が空の行でも出す%')
         AS 単票の枝は改訂済み
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';


-- ---------------------------------------------------------------------
-- 【2】改訂する。★ (false) を (true) に書き換えてから実行。
--
--   単票の行の仕様の直後に、業績連動のときだけ出る1行を足す。
--
--     利用許諾料（料率 8% ／ 基準 上代 × 数量）
--     上代1,500円 × 1,000部 × 8%
--
--   金額は既存の「支払対価（税抜）」の列に出る。ここは名前と根拠だけ。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
mark(m) AS (VALUES ('<div class="item-spec">{{or spec ../spec}}</div>')),
src AS (
  SELECT t.id AS template_id, v.id AS from_version, v.html_source, v.variables
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate'
),
made AS (
  INSERT INTO v3.document_template_versions
    (template_id, version_no, html_source, variables, comment, created_by)
  SELECT s.template_id,
         (SELECT COALESCE(max(x.version_no), 0) + 1
            FROM v3.document_template_versions x WHERE x.template_id = s.template_id),
         replace(s.html_source, mark.m,
           mark.m
           || '{{/if}}'
           || '{{!-- 業績連動の内訳。仕様が空の行でも出す（104 の単票側） --}}'
           || '{{#if reward_label}}<div class="item-spec">{{reward_label}}'
           || '{{#if rate_pct}}（料率 {{rate_pct}}%'
           || '{{#if base_price_label}} ／ 基準 {{base_price_label}}{{/if}}）{{/if}}'
           || '{{#if formula_text}}<br>{{formula_text}}{{/if}}</div>{{/if}}'
           || '{{#if (or spec ../spec)}}'),
         s.variables,
         '業績連動の報酬の内訳を単票の納品明細にも出す（105）',
         'infra/v3/105'
    FROM src s, go, mark
   WHERE go.ok
     -- 目印がちょうど1つのときだけ。0 なら本文の作りが変わっている。
     -- 2 つ以上あると replace が全部に当たるので、当てる場所を決め直す。
     AND (length(s.html_source) - length(replace(s.html_source, mark.m, '')))
         / length(mark.m) = 1
     -- 既に足してあれば作らない（何度流しても同じ結果になる）。
     AND position('業績連動の内訳。仕様が空の行でも出す' in s.html_source) = 0
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
SELECT '—', '0 件',
       '(false) を (true) に。既に改訂済みか、目印がちょうど1つではありません（【1】を見てください）'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);


-- ---------------------------------------------------------------------
-- 【3】確認。両方の枝に入ったか。
--   {{#if}} と {{/if}} の数が揃っていることも見る（揃っていないと本文が壊れる）。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, v.id AS 版id, v.version_no AS 版番号, v.comment AS 備考,
       (v.html_source LIKE '%{{#if reward_label}}%') AS 確定報酬の名称,
       (v.html_source LIKE '%業績連動の内訳。仕様が空の行でも出す%')
         AS 単票の枝にも出る,
       (length(v.html_source) - length(replace(v.html_source, '{{#if ', '')))
         / length('{{#if ') AS ifの数,
       (length(v.html_source) - length(replace(v.html_source, '{{/if}}', '')))
         / length('{{/if}}') AS 閉じifの数,
       length(v.html_source) AS 本文の長さ
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';


-- ---------------------------------------------------------------------
-- 【4】戻し方。版の一覧を出す。戻すときは current_version_id を前の版に向ける。
--      UPDATE v3.document_templates SET current_version_id = <前の版id>
--       WHERE template_key = 'inspection_certificate';
-- ---------------------------------------------------------------------
SELECT v.id AS 版id, v.version_no AS 版番号, v.created_at AS 作成, v.comment AS 備考,
       (v.id = t.current_version_id) AS いま使っている
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.template_id = t.id
 WHERE t.template_key = 'inspection_certificate'
 ORDER BY v.version_no DESC;
