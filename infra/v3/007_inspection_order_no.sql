-- =====================================================================
-- 検収書のひな形に「発注番号」の列を足す
--
--   検収書は条件をまたいで1枚にできるようになった（委託料と実費など）。
--   見出しの発注番号は全部を「・」で並べるが、どの行がどの発注書の分かは
--   行に無いと読めない。アプリは明細の行ごとに order_no（その条件から出た
--   発注書の番号）を渡すので、ひな形の「今回の納品内容」の表に列を足す。
--
--   やり方は 059（歩留率の列を落とした改訂）と同じ。現行版の本文を文字列で
--   置き換えて新しい版を作り、current_version_id を差し替える。置換の目印が
--   想定どおり見つからなければ何もせず止める。先に 093 で目印を確かめること。
--
--   実行: Cloud SQL Studio に貼って実行（DO ブロックなので 1 回で終わる）。
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  loop_start int;
  anchor_pos int;

  th_item_old constant text := '<th style="width:47%">成果物・業務内容</th>';
  th_item_new constant text := '<th style="width:33%">成果物・業務内容</th><th style="width:14%">発注番号</th>';
  cell_new    constant text := E'<td class="center">{{order_no}}</td>\n            ';
  -- 差し込む位置の目印：明細ループの中の数量セル。成果物のセルの直後にある。
  -- （成果物のセルは {{or item_name ../description}} と書かれていて {{item_name}} では探せない）
  qty_cell    constant text := '<td class="center">{{#if (gt inspected_quantity 0)}}';
  total_sub_old constant text := '<td colspan="5" class="right">検収 小計（税抜）</td>';
  total_sub_new constant text := '<td colspan="6" class="right">検収 小計（税抜）</td>';
  total_tax_old constant text := E'<td colspan="5" class="right">\n          消費税(';
  total_tax_new constant text := E'<td colspan="6" class="right">\n          消費税(';
  total_inc_old constant text := '<td colspan="5" class="right">源泉徴収税計算前　検収金額(税込)</td>';
  total_inc_new constant text := '<td colspan="6" class="right">源泉徴収税計算前　検収金額(税込)</td>';
BEGIN
  SELECT t.id, v.html_source INTO tpl_id, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate';
  IF src IS NULL THEN
    RAISE EXCEPTION 'inspection_certificate のひな形が見つかりません';
  END IF;
  IF strpos(src, '{{order_no}}') > 0 THEN
    RAISE NOTICE '007: 適用済み（発注番号の列がある）';
    RETURN;
  END IF;

  -- 目印の確認。違えば本番の版が想定と違うので止める（093 で確かめる）。
  IF (length(src) - length(replace(src, th_item_old, ''))) / length(th_item_old) <> 1 THEN
    RAISE EXCEPTION '成果物列の見出し（width:47%%）が 1 箇所ではありません。093 で現行版を確かめてください';
  END IF;
  IF strpos(src, total_sub_old) = 0 OR strpos(src, total_tax_old) = 0 OR strpos(src, total_inc_old) = 0 THEN
    RAISE EXCEPTION '合計行（colspan="5"）が想定どおり見つかりません。093 で現行版を確かめてください';
  END IF;
  loop_start := strpos(src, '{{#each delivery_line_items}}');
  IF loop_start = 0 THEN
    RAISE EXCEPTION '明細のループ（{{#each delivery_line_items}}）が見つかりません';
  END IF;
  IF (length(src) - length(replace(src, qty_cell, ''))) / length(qty_cell) <> 1 THEN
    RAISE EXCEPTION '明細の数量セル（inspected_quantity）が 1 箇所ではありません。093 で現行版を確かめてください';
  END IF;
  anchor_pos := strpos(src, qty_cell);
  IF anchor_pos < loop_start THEN
    RAISE EXCEPTION '数量セルが明細ループの外にあります。093 で現行版を確かめてください';
  END IF;

  -- 成果物のセルと数量のセルの間に、発注番号のセルを差し込む。
  new_html := substr(src, 1, anchor_pos - 1) || cell_new || substr(src, anchor_pos);
  new_html := replace(new_html, th_item_old, th_item_new);
  new_html := replace(new_html, total_sub_old, total_sub_new);
  new_html := replace(new_html, total_tax_old, total_tax_new);
  new_html := replace(new_html, total_inc_old, total_inc_new);

  IF strpos(new_html, '{{order_no}}') = 0 OR strpos(new_html, '>発注番号<') = 0 THEN
    RAISE EXCEPTION '置換後に発注番号の列が入っていません。中断しました';
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;

  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         '検収書：今回の納品内容に行ごとの発注番号の列を足す（条件をまたぐ検収書のため・007）',
         'legalbridge-v3'
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.id = tpl_id
  RETURNING id INTO new_id;

  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '007: 検収書のひな形を版 % に上げた', next_no;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, '{{order_no}}') > 0 AS 発注番号の列,
       (length(v.html_source) - length(replace(v.html_source, 'colspan="6"', ''))) / 11 AS colspan6の数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
