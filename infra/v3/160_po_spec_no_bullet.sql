-- =====================================================================
-- 160 発注書（国内・海外）：明細の仕様欄の先頭に出る「・」を消す
--
--   明細の行の下の仕様（Specification）は箇条書き（<ul><li>）で組んでいて、
--   仕様の文の頭に「・」が付き、字下げもされていた。仕様はそれ自体が
--   「1. … 2. …」と番号を持つことが多く、「・ 1.」と二重に見える。
--   箇条書きの印と字下げを外す（文の中身・改行はそのまま）。
--   何度流しても同じ（済んでいれば何もしない）。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/160_po_spec_no_bullet.sql
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  tpl_id bigint;
  from_version bigint;
  from_no int;
  src text;
  new_html text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, $r$<ul style="list-style:none;padding-left:0;margin:4px 0 0;">$r$) > 0 THEN
    RAISE NOTICE '160: 発注書の仕様欄は「・」なしです。何もしません';
    RETURN;
  END IF;
  IF (length(src) - length(replace(src, $r$<ul>$r$, ''))) / length($r$<ul>$r$) <> 1 THEN
    RAISE EXCEPTION '160: 発注書の仕様欄（<ul>）が 1 か所ではありません。何も変えません';
  END IF;
  new_html := replace(src, $r$<ul>$r$, $r$<ul style="list-style:none;padding-left:0;margin:4px 0 0;">$r$);
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('160: 明細の仕様欄の先頭の「・」を消す（%s 版から）', from_no), 'sql:160'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '160: purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

DO $do$
DECLARE
  tpl_id bigint;
  from_version bigint;
  from_no int;
  src text;
  new_html text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, $r$<ul style="list-style:none;padding-left:0;margin:4px 0 0;">$r$) > 0 THEN
    RAISE NOTICE '160: 海外発注書の仕様欄は「・」なしです。何もしません';
    RETURN;
  END IF;
  IF (length(src) - length(replace(src, $r$<ul>$r$, ''))) / length($r$<ul>$r$) <> 1 THEN
    RAISE EXCEPTION '160: 海外発注書の仕様欄（<ul>）が 1 か所ではありません。何も変えません';
  END IF;
  new_html := replace(src, $r$<ul>$r$, $r$<ul style="list-style:none;padding-left:0;margin:4px 0 0;">$r$);
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('160: 明細の仕様欄の先頭の「・」を消す（%s 版から）', from_no), 'sql:160'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '160: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：仕様欄の「・」が外れたか
SELECT t.template_key AS ひな形, v.version_no AS 版,
       (strpos(v.html_source, 'list-style:none;padding-left:0') > 0) AS 仕様欄の点なし
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order');
