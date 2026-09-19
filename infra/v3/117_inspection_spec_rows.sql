-- =====================================================================
-- 検収書のひな形：明細の仕様を「1行のまとめ」と「業務内容の行（表の幅いっぱい）」に分ける
--
--   「成果物・業務内容」の列は幅が 33% しかなく、長文の仕様をそのまま刷ると
--   1 行が 20 行分の高さになり、検収書が 3 ページになっていた。
--   行には仕様の先頭 1 行（spec_head。イベント名・日時など）だけを出し、その行の
--   直下に表の幅いっぱいの行を足して残り（spec_body）を刷る。アプリは abd7851 から
--   行に spec_head / spec_body / has_spec_body を渡している。
--
--   やり方は 007・105 と同じ。現行版の本文を文字列で置き換えて新しい版を作り、
--   current_version_id を差し替える。目印が想定どおりでなければ何もせず止まる。
--   何度流しても同じ結果（適用済みなら何もしない）。
--
--   目印（105 が作った単票の枝の仕様ブロック）:
--     <div class="item-spec">{{or spec ../spec}}</div>
--   足す行（明細ループ内の </tr> の直後、7 列 = No. + 6）:
--     {{#if has_spec_body}}<tr class="spec-row">…{{spec_body}}…</tr>{{/if}}
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/117_inspection_spec_rows.sql
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'inspection_certificate';（前の版id は NOTICE に出る）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  tpl_id bigint;
  from_version bigint;
  next_no int;
  new_id bigint;
  loop_start int;
  each_end int;
  row_end int;
  ifs int;
  endifs int;

  mark_old constant text := '<div class="item-spec">{{or spec ../spec}}</div>';
  mark_new constant text := '<div class="item-spec">{{or spec_head ../spec}}</div>';
  spec_row constant text := E'\n           {{#if has_spec_body}}<tr class="spec-row">'
    || '<td style="border-top:0;"></td>'
    || '<td colspan="6" style="border-top:0;background:#fafaf8;font-size:8.5pt;line-height:1.5;white-space:pre-line;padding:4px 8px 6px;">'
    || '<span style="display:inline-block;font-size:7.5pt;color:#555;border:1px solid #bbb;border-radius:2px;padding:0 4px;margin-right:6px;vertical-align:middle;white-space:nowrap;">業務内容</span>'
    || '{{spec_body}}</td></tr>{{/if}}';
BEGIN
  SELECT t.id, v.id, v.html_source INTO tpl_id, from_version, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate';
  IF src IS NULL THEN
    RAISE EXCEPTION 'inspection_certificate のひな形が見つかりません';
  END IF;
  IF strpos(src, '{{spec_body}}') > 0 THEN
    RAISE NOTICE '117: 適用済み（業務内容の行がある）。何もしません';
    RETURN;
  END IF;

  -- 目印の確認
  IF (length(src) - length(replace(src, mark_old, ''))) / length(mark_old) <> 1 THEN
    RAISE EXCEPTION '単票の仕様ブロック（%）が 1 箇所ではありません。116 で現行版を確かめてください', mark_old;
  END IF;
  loop_start := strpos(src, '{{#each delivery_line_items}}');
  IF loop_start = 0 THEN
    RAISE EXCEPTION '明細のループ（{{#each delivery_line_items}}）が見つかりません';
  END IF;
  IF strpos(src, mark_old) < loop_start THEN
    RAISE EXCEPTION '仕様ブロックが明細ループの外にあります。116 で現行版を確かめてください';
  END IF;
  -- ループの終わり（最初の {{/each}}）と、その直前の </tr>
  each_end := loop_start + strpos(substr(src, loop_start), '{{/each}}') - 1;
  IF each_end < loop_start THEN
    RAISE EXCEPTION '明細ループの {{/each}} が見つかりません';
  END IF;
  row_end := length(substr(src, 1, each_end)) - strpos(reverse(substr(src, 1, each_end)), reverse('</tr>')) + 1;
  IF row_end <= strpos(src, mark_old) THEN
    RAISE EXCEPTION '明細ループの中の </tr> が仕様ブロックより前にあります。116 で現行版を確かめてください';
  END IF;
  -- row_end は '</tr>' の先頭。その直後に業務内容の行を差し込む。
  new_html := substr(src, 1, row_end + length('</tr>') - 1) || spec_row || substr(src, row_end + length('</tr>'));
  new_html := replace(new_html, mark_old, mark_new);

  -- 壊れていないか：{{#if}} と {{/if}} の数が揃っている
  ifs := (length(new_html) - length(replace(new_html, '{{#if ', ''))) / length('{{#if ');
  endifs := (length(new_html) - length(replace(new_html, '{{/if}}', ''))) / length('{{/if}}');
  IF ifs <> endifs THEN
    RAISE EXCEPTION '置換後に {{#if}}（%）と {{/if}}（%）の数が揃いません。中断しました', ifs, endifs;
  END IF;
  IF strpos(new_html, '{{spec_body}}') = 0 OR strpos(new_html, mark_new) = 0 THEN
    RAISE EXCEPTION '置換後に業務内容の行が入っていません。中断しました';
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;

  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         '検収書：明細の仕様を 1 行のまとめと業務内容の行（表の幅いっぱい）に分ける（117）',
         'infra/v3/117'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;

  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '117: 検収書のひな形を版 % に上げた（前の版id % → 新しい版id %）', next_no, from_version, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, '{{spec_body}}') > 0            AS 業務内容の行,
       strpos(v.html_source, '{{or spec_head ../spec}}') > 0 AS まとめ,
       (length(v.html_source) - length(replace(v.html_source, '{{#if ', ''))) / length('{{#if ') AS ifの数,
       (length(v.html_source) - length(replace(v.html_source, '{{/if}}', ''))) / length('{{/if}}') AS 閉じifの数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
