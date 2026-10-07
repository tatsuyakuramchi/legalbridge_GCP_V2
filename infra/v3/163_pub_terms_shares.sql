-- =====================================================================
-- 163_pub_terms_shares.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   出版条件書に共同著作の取り分を出す（A-068。docs/royalty-shares.md §3.2）。
--
--   ・作品の行の下（許諾期間・翻訳版・備考と同じ全幅の行）に「共同著作 作家B 66.67%・作家C 33.33%」。
--     受取人（共著者の一人）宛ての条件書なら「（甲の取り分 66.67%）」を添え、料率の欄は
--     甲に帰属する率を主に括弧で全体率「6.67%（全体 10%）」（本文側で組む。一覧の合計許諾料と読み違えないため）。
--   ・受取人宛ての条件書は、第１条の前に取り分に係る一文が入る。
--
--   2 本のひな形の両方を改訂する（本文は現行の版を置換して作る）。
--     pub_license_terms_v3        … 一覧形式  r10 → r11
--     pub_license_terms_v3_annex  … 別紙形式  r6  → r7
--
--   先に 133 を流しておくこと（r10 / r6 が current であること）。
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
-- 【1】一覧形式（pub_license_terms_v3）r10 → r11
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
         replace(replace(replace(v.html_source,
           '<!-- pub_license_terms_v3 r10 -->',
           '<!-- pub_license_terms_v3 r11 -->'),
           $s${{#if note}}<span class="lbl">備考</span>{{note}}{{/if}}</td>$s$,
           $s${{#if hasShares}}<span class="lbl">共同著作</span>{{coAuthors}}{{#if payeeShare}}（{{payeeShare}}）{{/if}}{{/if}}{{#if note}}<span class="lbl">備考</span>{{note}}{{/if}}</td>$s$),
           $s$<h2><span class="no">第１条</span>対象著作物</h2>$s$,
           $s${{#if payeeTerms}}<p>本条件書は、甲が対象著作物の共同著作者（権利者の一人）として有する取り分に係る許諾条件を定める。第１条一覧の「料率」は甲に帰属する料率（対象著作物全体の料率に甲の取り分を乗じたもの）であり、括弧内は対象著作物全体の料率、甲の取り分は同一覧の「共同著作」欄に記載のとおりとする。甲に支払う許諾料は、甲に帰属する料率により算定する。</p>{{/if}}
<h2><span class="no">第１条</span>対象著作物</h2>$s$),
         v.variables,
         'r11：共同著作の取り分を一覧の行に出す。受取人宛ての条件書は取り分の一文を入れる',
         'infra/v3/163'
    FROM t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE position('<!-- pub_license_terms_v3 r10 -->' in v.html_source) > 0
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
SELECT '—', '0 件', '一覧形式：r10 が current でない（r11 済みか、133 が未適用）。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- ---------------------------------------------------------------------
-- 【2】別紙形式（pub_license_terms_v3_annex）r6 → r7
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
         replace(replace(replace(v.html_source,
           '<!-- pub_license_terms_v3_annex r6 -->',
           '<!-- pub_license_terms_v3_annex r7 -->'),
           $s${{#if note}}<span class="lbl">備考</span>{{note}}{{/if}}</td>$s$,
           $s${{#if hasShares}}<span class="lbl">共同著作</span>{{coAuthors}}{{#if payeeShare}}（{{payeeShare}}）{{/if}}{{/if}}{{#if note}}<span class="lbl">備考</span>{{note}}{{/if}}</td>$s$),
           $s$<h2><span class="no">第１条</span>対象著作物</h2>$s$,
           $s${{#if payeeTerms}}<p>本条件書は、甲が対象著作物の共同著作者（権利者の一人）として有する取り分に係る許諾条件を定める。別紙1の「料率」は甲に帰属する料率（対象著作物全体の料率に甲の取り分を乗じたもの）であり、括弧内は対象著作物全体の料率、甲の取り分は同別紙の「共同著作」欄に記載のとおりとする。甲に支払う許諾料は、甲に帰属する料率により算定する。</p>{{/if}}
<h2><span class="no">第１条</span>対象著作物</h2>$s$),
         v.variables,
         'r7：共同著作の取り分を一覧の行に出す。受取人宛ての条件書は取り分の一文を入れる',
         'infra/v3/163'
    FROM t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE position('<!-- pub_license_terms_v3_annex r6 -->' in v.html_source) > 0
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
SELECT '—', '0 件', '別紙形式：r6 が current でない（r7 済みか、133 が未適用）。何もしていません'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- 確認（両方 1 であること：現行の版に r11 / r7 の目印がある）
SELECT d.template_key AS キー,
       (position(CASE d.template_key WHEN 'pub_license_terms_v3' THEN '<!-- pub_license_terms_v3 r11 -->'
                                     ELSE '<!-- pub_license_terms_v3_annex r7 -->' END in v.html_source) > 0)::int AS 当たっている
  FROM v3.document_templates d JOIN v3.document_template_versions v ON v.id = d.current_version_id
 WHERE d.template_key IN ('pub_license_terms_v3', 'pub_license_terms_v3_annex');
