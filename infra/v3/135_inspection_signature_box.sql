-- =====================================================================
-- 検収書「変更内容の確認」の署名する空欄を 12pt 用に広げる
--
--   134 でこの欄の文字を 12pt にしたが、署名する空欄（下線までの空き）は
--   8.5pt のころの 34px のままだった。CloudSign で 12pt の署名欄・
--   フリーワード欄を置くと、文字が枠の上下にはみ出して窮屈になる。
--   44px に広げ、12pt の入力が余裕をもって収まるようにする。
--
--   受託者側（空欄）と発注者側（当社の部署・氏名が入る欄）の両方を同じ
--   高さにする。片方だけ広げると下線の位置がずれて、2つの欄が段違いに見える。
--
--   120・134 が入れた署名欄（signature-section）の中だけを直す。
--   何度流しても同じ結果（適用済みなら何もしない）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/135_inspection_signature_box.sql
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

  -- 受託者側：署名を書く空欄。発注者側：当社の部署・氏名が入るので min-height。
  old_sign  constant text := '<div style="height:34px;border-bottom:1px solid #333;"></div>';
  new_sign  constant text := '<div style="height:44px;border-bottom:1px solid #333;"></div>';
  old_ours  constant text := '<div style="min-height:34px;border-bottom:1px solid #333;';
  new_ours  constant text := '<div style="min-height:44px;border-bottom:1px solid #333;';
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
  IF strpos(src, old_sign) = 0 AND strpos(src, new_sign) > 0 THEN
    RAISE NOTICE '135: 適用済み（署名する空欄が 44px）。何もしません';
    RETURN;
  END IF;
  IF strpos(src, 'border-collapse:collapse;font-size:12pt;') = 0 THEN
    RAISE EXCEPTION 'この欄が 12pt になっていません。先に 134 を流してください';
  END IF;

  -- どちらも 1 箇所だけ（明細や他の欄の 34px を巻き込まない）。
  IF (length(src) - length(replace(src, old_sign, ''))) / length(old_sign) <> 1 THEN
    RAISE EXCEPTION '受託者側の空欄が 1 箇所ではありません。中止します';
  END IF;
  IF (length(src) - length(replace(src, old_ours, ''))) / length(old_ours) <> 1 THEN
    RAISE EXCEPTION '発注者側の欄が 1 箇所ではありません。中止します';
  END IF;

  new_html := replace(src, old_sign, new_sign);
  new_html := replace(new_html, old_ours, new_ours);

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         '135: 変更内容の確認の署名する空欄を 12pt 用に広げる（34px → 44px）',
         'migration'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '135: inspection_certificate を版 % (id %) → 版 % (id %) に改訂しました', from_no, from_version, next_no, new_id;
END
$do$;

COMMIT;

-- 確かめる
\echo '--- 検収書の署名する空欄（44px・両側そろっていること） ---'
SELECT t.template_key, v.version_no,
       strpos(v.html_source, 'height:44px;border-bottom:1px solid #333;"></div>') > 0 AS 受託者側44px,
       strpos(v.html_source, 'min-height:44px;border-bottom') > 0 AS 発注者側44px,
       strpos(v.html_source, '34px') = 0 AS 古い高さが残っていない
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
