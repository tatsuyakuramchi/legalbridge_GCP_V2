-- =====================================================================
-- 155_inspection_po_no_no_backlog.sql（ops sql / Cloud SQL Studio・psql 用）
--
--   検収書の見出しの「発注番号」に Backlog の課題番号が出ていたのを直す。
--
--   本文が {{or parent_po_number issueKey}} になっていた（V1 の名残。V1 は検収書の
--   番号を Backlog の課題番号から作っていた）。親の発注書（V3 で出したもの）も、
--   条件に控えた外部の発注番号も無い検収書では、課題番号（LEGAL-348 など）が
--   「発注番号」として出ていた。
--
--   発注番号は親の発注書の番号だけにする。無いときは「—」を出す。
--     before: <div>発注番号: <strong>{{or parent_po_number issueKey}}</strong></div>
--     after : <div>発注番号: <strong>{{#if parent_po_number}}{{parent_po_number}}{{else}}—{{/if}}</strong></div>
--
--   いまの版は残す。新しい版を作って current_version_id を向けるだけ。
--   決定済みの文書は中身を凍らせてあるので、過去の PDF は変わらない。
--   何度流しても同じ（直してあれば何もしない）。目印が無ければ何もしない。
--
--   実行: psql "host=127.0.0.1 port=5432 dbname=legalbridge user=postgres" -f infra/v3/155_inspection_po_no_no_backlog.sql
--   戻すとき（版id は【2】に出る）:
--     UPDATE v3.document_templates SET current_version_id = <前の版id> WHERE template_key = 'inspection_certificate';
-- =====================================================================

\pset pager off

-- 【1】直す
WITH src AS (
  SELECT t.id AS template_id, v.id AS from_version, v.html_source, v.variables
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate'
),
made AS (
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT s.template_id,
         (SELECT COALESCE(max(x.version_no), 0) + 1 FROM v3.document_template_versions x WHERE x.template_id = s.template_id),
         replace(s.html_source,
           '{{or parent_po_number issueKey}}',
           '{{#if parent_po_number}}{{parent_po_number}}{{else}}—{{/if}}'),
         s.variables,
         '発注番号に Backlog の課題番号を出さない（親の発注書の番号だけ。無ければ —）',
         'infra/v3/155'
    FROM src s
   WHERE position('{{or parent_po_number issueKey}}' in s.html_source) > 0
  RETURNING id, template_id, version_no
),
pointed AS (
  UPDATE v3.document_templates t SET current_version_id = m.id
    FROM made m WHERE t.id = m.template_id
  RETURNING t.template_key, m.id AS new_version, m.version_no
)
SELECT p.template_key AS キー, p.new_version::text AS 新しい版id, p.version_no::text AS 版番号 FROM pointed p
UNION ALL
SELECT '—', '0 件', '直してあるか、目印 {{or parent_po_number issueKey}} が見つかりません（【2】で確かめてください）'
 WHERE NOT EXISTS (SELECT 1 FROM pointed);

-- 【2】確認：いまの版の「発注番号」のまわり。「Backlogの番号を出す式が残っている」が f なら OK。
--     （本文のコメントに旧い番号の作り方として issueKey の語が残っているが、表示はしない）
SELECT t.template_key AS キー, v.id AS 版id, v.version_no AS 版番号,
       (SELECT string_agg(m[1], E'\n') FROM regexp_matches(v.html_source, '(発注番号: <strong>[^<]*</strong>)', 'g') m) AS 発注番号のところ,
       position('{{or parent_po_number issueKey}}' in v.html_source) > 0 AS Backlogの番号を出す式が残っている
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
