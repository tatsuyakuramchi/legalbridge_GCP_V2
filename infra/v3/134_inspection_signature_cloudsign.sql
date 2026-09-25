-- =====================================================================
-- 検収書の「変更内容の確認」欄を CloudSign に合わせる
--
--   この欄は CloudSign で相手に署名してもらう。日付は CloudSign の
--   フリーワード欄で入れるので、紙に「年　　月　　日」を刷っておくと
--   入力欄と二重になる（相手はどちらに書けばよいか分からない）。
--   印字をやめて「署名日：」だけにする。
--
--   併せて、この欄の文字を 12pt にする。CloudSign のフリーワード欄が
--   12pt 設定なので、8.5pt のまま刷ると入力された文字だけが大きく、
--   同じ行の見出しと揃わない。
--
--   120 で足した署名欄（signature-section）だけを直す。ほかの欄は動かさない。
--   やり方は 007・105・117・120 と同じ。現行版の本文を文字列で置き換えて
--   新しい版を作り、current_version_id を差し替える。目印が想定どおりで
--   なければ何もせず止まる。何度流しても同じ結果（適用済みなら何もしない）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/134_inspection_signature_cloudsign.sql
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
  from_no int;
  next_no int;
  new_id bigint;

  -- 直す前の文字列（120 が入れたもの）。1 箇所だけあること。
  old_head  constant text := '<div style="font-size:9.5pt;font-weight:bold;margin-bottom:4px;">■ 変更内容の確認</div>';
  old_lead  constant text := '<p style="font-size:8.5pt;margin:0 0 8px;line-height:1.5;">上記「変更履歴」のとおり';
  old_table constant text := '<table style="width:100%;border-collapse:collapse;font-size:8.5pt;">';
  old_date  constant text := '<div style="margin-top:6px;">署名日：　　　　年　　　月　　　日</div>';

  new_head  constant text := '<div style="font-size:12pt;font-weight:bold;margin-bottom:6px;">■ 変更内容の確認</div>';
  new_lead  constant text := '<p style="font-size:12pt;margin:0 0 8px;line-height:1.6;">上記「変更履歴」のとおり';
  new_table constant text := '<table style="width:100%;border-collapse:collapse;font-size:12pt;">';
  -- 日付は CloudSign のフリーワード欄で入れる。印字はしない。
  new_date  constant text := '<div style="margin-top:6px;">署名日：</div>';
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate';
  IF src IS NULL THEN
    RAISE EXCEPTION 'inspection_certificate のひな形が見つかりません';
  END IF;
  IF strpos(src, 'signature-section') = 0 THEN
    RAISE EXCEPTION '署名欄（signature-section）がありません。先に 120 を流してください';
  END IF;
  IF strpos(src, old_date) = 0 AND strpos(src, new_date) > 0 THEN
    RAISE NOTICE '134: 適用済み（署名日の印字が無く 12pt）。何もしません';
    RETURN;
  END IF;

  IF strpos(src, old_head) = 0 OR strpos(src, old_lead) = 0
     OR strpos(src, old_table) = 0 OR strpos(src, old_date) = 0 THEN
    RAISE EXCEPTION '署名欄の中身が想定と違います（120 の版か確かめてください）';
  END IF;

  new_html := replace(src, old_head, new_head);
  new_html := replace(new_html, old_lead, new_lead);
  new_html := replace(new_html, old_table, new_table);
  new_html := replace(new_html, old_date, new_date);

  -- 置き換えは署名欄の中だけ。ほかの 8.5pt（明細や支払条件）は動かさない。
  IF strpos(new_html, old_date) > 0 OR strpos(new_html, old_table) > 0 THEN
    RAISE EXCEPTION '置き換えが残っています。中止します';
  END IF;

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         '134: 変更内容の確認を CloudSign に合わせる（署名日の年月日を刷らない・12pt）',
         'migration'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '134: inspection_certificate を版 % (id %) → 版 % (id %) に改訂しました', from_no, from_version, next_no, new_id;
END
$do$;

COMMIT;

-- 確かめる
\echo '--- 検収書の署名欄（12pt・署名日の印字なし） ---'
SELECT t.template_key, v.version_no,
       strpos(v.html_source, '署名日：　　　　年') = 0 AS 年月日を刷らない,
       strpos(v.html_source, 'border-collapse:collapse;font-size:12pt;') > 0 AS 表が12pt,
       strpos(v.html_source, 'font-size:12pt;font-weight:bold;') > 0 AS 見出しが12pt
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
