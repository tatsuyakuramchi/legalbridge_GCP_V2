\set ON_ERROR_STOP on
\pset pager off

-- 059_inspection_certificate_drop_yield.sql
-- 検収書テンプレ改訂: 「■ 今回の納品内容」から歩留率列を削除する（フォーム再設計に合わせる）。
--   ・現行版 html_source への文字列置換で新版を作り、current_version_id を差し替える。
--     全文差し替えではなく置換ベース＝本番側に他の改訂があっても温存される。
--     置換対象が想定どおりの回数で見つからない場合は何もせず中断する。
--   ・acceptance_ratio（歩留率）はデータと計算（単価×数量×歩留率）では温存し、表示だけ落とす。
--   ・field_schema は現行版をそのまま引き継ぐ。
--   ・確定済み文書は自分の版の html で再生成されるため影響なし。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_inspection_yield=DROP_INSPECTION_YIELD_COLUMN \
--         -f infra/gcp/sql/059_inspection_certificate_drop_yield.sql

\if :{?confirm_inspection_yield}
\else
  \echo 'Run with: -v confirm_inspection_yield=DROP_INSPECTION_YIELD_COLUMN'
  \quit 2
\endif
SELECT :'confirm_inspection_yield' = 'DROP_INSPECTION_YIELD_COLUMN' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;

  th_yield constant text := $q$<th style="width:10%">歩留率</th>$q$;
  th_item_old constant text := $q$<th style="width:45%">成果物・業務内容</th>$q$;
  th_item_new constant text := $q$<th style="width:50%">成果物・業務内容</th>$q$;
  th_date_old constant text := $q$<th style="width:14%">納品日</th>$q$;
  th_date_new constant text := $q$<th style="width:19%">納品日</th>$q$;
  cell_yield constant text := $q$<td class="center">{{#if (gt acceptance_ratio 0)}}{{formatPct (multiply acceptance_ratio 100)}}{{else}}—{{/if}}</td>$q$;
  dash_pair constant text := $q$<td class="center">—</td>
          <td class="center">—</td>$q$;
  dash_single constant text := $q$<td class="center">—</td>$q$;
BEGIN
  SELECT t.id, v.html_source INTO tpl_id, src
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate';
  IF src IS NULL THEN
    RAISE EXCEPTION 'inspection_certificate テンプレートが見つかりません';
  END IF;

  -- ガード: 置換対象が想定どおりの回数で存在するか（違えば本番の版が想定と異なる）。
  IF (length(src) - length(replace(src, th_yield, ''))) / length(th_yield) <> 1 THEN
    RAISE EXCEPTION '歩留率の列見出しが 1 箇所ではありません。現行版の内容を確認してください';
  END IF;
  IF (length(src) - length(replace(src, cell_yield, ''))) / length(cell_yield) <> 1 THEN
    RAISE EXCEPTION '歩留率のセル（acceptance_ratio）が想定と異なります。現行版の内容を確認してください';
  END IF;
  IF (length(src) - length(replace(src, 'colspan="5"', ''))) / length('colspan="5"') <> 3 THEN
    RAISE EXCEPTION 'colspan="5" が 3 箇所ではありません。現行版の内容を確認してください';
  END IF;
  IF strpos(src, dash_pair) = 0 THEN
    RAISE EXCEPTION '単票フォールバック行の「—」セル対が見つかりません。現行版の内容を確認してください';
  END IF;
  IF strpos(src, th_item_old) = 0 OR strpos(src, th_date_old) = 0 THEN
    RAISE EXCEPTION '列幅（45%% / 14%%）の見出しが見つかりません。現行版の内容を確認してください';
  END IF;

  new_html := replace(src, th_yield, '');
  new_html := replace(new_html, th_item_old, th_item_new);
  new_html := replace(new_html, th_date_old, th_date_new);
  new_html := replace(new_html, cell_yield, '');
  new_html := replace(new_html, dash_pair, dash_single);
  new_html := replace(new_html, 'colspan="5"', 'colspan="4"');

  IF strpos(new_html, '>歩留率<') > 0 THEN
    RAISE EXCEPTION '置換後も歩留率の表示が残っています。中断しました';
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM document_template_versions WHERE template_id = tpl_id;

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.field_schema,
         '検収書テンプレ改訂: 今回の納品内容から歩留率列を削除（059・フォーム再設計に合わせる）',
         'legalbridge-v2'
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.id = tpl_id
  RETURNING id INTO new_id;

  UPDATE document_templates SET current_version_id = new_id WHERE id = tpl_id;
END
$do$;

SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, '>歩留率<') AS yield_visible_pos,
       (length(v.html_source) - length(replace(v.html_source, 'colspan="4"', ''))) / length('colspan="4"') AS colspan4_count
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';

COMMIT;
