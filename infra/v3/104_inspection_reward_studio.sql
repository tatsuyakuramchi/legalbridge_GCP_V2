-- =====================================================================
-- 104_inspection_reward_studio.sql（Cloud SQL Studio 用）
--
--   検収書の納品明細に、業績連動の報酬の内訳を出せるようにする。
--
--   報酬計算書という書類は作らず、検収書の明細に載せて済ませる方針。
--   本文は料率（rate_pct）と帰属先（deliverable_ownership）は差しているが、
--   確定報酬の名称・基準価格・計算の根拠は差していない。行の下に1行足す。
--
--   いまの版は残す。document_template_versions に新しい版を作り、
--   document_templates.current_version_id をそちらへ向けるだけ。
--   戻すときは current_version_id を元の版に戻せばよい（【4】に出る）。
--
--   使い方（1つずつ、順に実行する）
--     【1】 報告。何も変えない。当たる箇所の数と、いまの版を見る
--     【2】 改訂する。(false) を (true) に書き換えてから
--     【3】 確認。新しい版が差している項目
--     【4】 戻し方（控えておく）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 【1】報告。何も変えない。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, t.label AS 名前,
       v.id AS いまの版id, v.version_no AS 版番号,
       length(v.html_source) AS 本文の長さ,
       -- 差し込む目印。ここが 0 なら本文の作りが変わっている（流さないこと）。
       (length(v.html_source)
        - length(replace(v.html_source,
            '{{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}', '')))
       / nullif(length('{{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}'), 0)
         AS 当たる箇所,
       (v.html_source LIKE '%reward_label%')     AS 既に確定報酬の名称あり,
       (v.html_source LIKE '%formula_text%')     AS 既に計算の根拠あり
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';


-- ---------------------------------------------------------------------
-- 【2】改訂する。★ (false) を (true) に書き換えてから実行。
--
--   いまの本文の
--     {{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}
--   の直後に、業績連動のときだけ出る1行を足す。
--
--     利用許諾料（料率 8% ／ 基準 上代 × 数量）
--     上代1,500円 × 1,000部 × 8%
--
--   金額は既存の「支払対価（税抜）」の列に出る。ここは名前と根拠だけ。
-- ---------------------------------------------------------------------
WITH go(ok) AS (VALUES (false)),          -- ★ ここを (true) に
src AS (
  SELECT t.id AS template_id, v.id AS from_version, v.version_no, v.html_source, v.variables
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
         replace(s.html_source,
           '{{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}',
           '{{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}'
           || '{{#if reward_label}}<div class="item-spec">{{reward_label}}'
           || '{{#if rate_pct}}（料率 {{rate_pct}}%'
           || '{{#if base_price_label}} ／ 基準 {{base_price_label}}{{/if}}）{{/if}}'
           || '{{#if formula_text}}<br>{{formula_text}}{{/if}}</div>{{/if}}'),
         s.variables,
         '業績連動の報酬の内訳を納品明細に出す（報酬計算書を作らない運用）',
         'infra/v3/104'
    FROM src s, go
   WHERE go.ok
     -- 目印が無ければ作らない。本文の作りが変わっている。
     AND position('{{#if spec}}<div class="item-spec">{{spec}}</div>{{/if}}' in s.html_source) > 0
     -- 既に足してあれば作らない（何度流しても同じ結果になる）。
     AND position('{{#if reward_label}}' in s.html_source) = 0
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
-- 【3】確認。新しい版が何を差しているか。
-- ---------------------------------------------------------------------
SELECT t.template_key AS キー, v.id AS 版id, v.version_no AS 版番号, v.comment AS 備考,
       (v.html_source LIKE '%reward_label%')     AS 確定報酬の名称,
       (v.html_source LIKE '%rate_pct%')         AS 料率,
       (v.html_source LIKE '%base_price_label%') AS 基準価格,
       (v.html_source LIKE '%formula_text%')     AS 計算の根拠,
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
