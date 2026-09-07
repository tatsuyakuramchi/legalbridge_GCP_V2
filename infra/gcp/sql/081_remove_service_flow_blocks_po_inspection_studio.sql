-- 081_remove_service_flow_blocks_po_inspection_studio.sql
-- Cloud SQL Studio 用（psql 専用メタコマンドなし・全文貼り付けで実行）。
-- 内容は 081_remove_service_flow_blocks_po_inspection.sql と同じ:
--   079 で発注書（purchase_order）と検収書（inspection_certificate）に差し込んだ
--   「業務委託の条件」「確認方法・判定・支払処理」のブロック（<section class="lb-service-terms">）を、
--   079 の版の html_source をその場で書き換えて取り除く。既存文書の再発行・Drive 保存からも消える。
--   業務委託基本契約・海外発注書は対象外。冪等（ブロックが無ければ何もしない）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $do$
DECLARE
  rec record;
  new_html text;
  touched int := 0;
  guard text;
  s int;
  p int;
  e int;
  f int;
  cut_end int;
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;

  FOR rec IN
    SELECT t.template_key, v.id, v.version_no, v.html_source
      FROM document_templates t
      JOIN document_template_versions v ON v.template_id = t.id
     WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
       AND strpos(v.html_source, 'lb-service-terms') > 0
  LOOP
    new_html := rec.html_source;
    -- 079 の目印コメント行（行ごと）
    new_html := regexp_replace(new_html, E'[ \\t]*\\{\\{!-- 079:[^\\n]*\\n', '', 'g');
    -- {{#if hasServiceTerms|hasInspectionChoices}} … <section class="lb-service-terms"> … </section> … {{/if}}
    -- を位置計算で切り出す。
    LOOP
      guard := '{{#if hasServiceTerms}}';
      s := strpos(new_html, guard);
      IF s = 0 THEN
        guard := '{{#if hasInspectionChoices}}';
        s := strpos(new_html, guard);
      END IF;
      EXIT WHEN s = 0;
      p := strpos(substr(new_html, s), '<section class="lb-service-terms"');
      IF p = 0 THEN
        RAISE EXCEPTION '% v%: % の直後に lb-service-terms が見つかりません。中断しました', rec.template_key, rec.version_no, guard;
      END IF;
      e := strpos(substr(new_html, s), '</section>');
      f := strpos(substr(new_html, s + e - 1), '{{/if}}');
      IF e = 0 OR f = 0 THEN
        RAISE EXCEPTION '% v%: ブロックの終端（</section> / {{/if}}）が見つかりません。中断しました', rec.template_key, rec.version_no;
      END IF;
      cut_end := s + e - 1 + f - 1 + length('{{/if}}');
      IF substr(new_html, cut_end, 1) = E'\n' THEN cut_end := cut_end + 1; END IF;
      new_html := substr(new_html, 1, s - 1) || substr(new_html, cut_end);
    END LOOP;
    IF strpos(new_html, 'lb-service-terms') > 0 THEN
      RAISE EXCEPTION '% v%: ブロックを取り除けませんでした（想定外の形）。中断しました', rec.template_key, rec.version_no;
    END IF;
    UPDATE document_template_versions SET html_source = new_html WHERE id = rec.id;
    touched := touched + 1;
    RAISE NOTICE '% v%: ブロックを削除（% → % 文字）', rec.template_key, rec.version_no,
      length(rec.html_source), length(new_html);
  END LOOP;
  IF touched = 0 THEN
    RAISE NOTICE '対象にブロックはありません（適用済み）';
  END IF;
END
$do$;

COMMIT;

-- 確認: 現行版にブロックが残っていないこと（has_block / has_guard が両方 false）
SELECT t.template_key, v.version_no,
       strpos(v.html_source, 'lb-service-terms') > 0 AS has_block,
       (strpos(v.html_source, '{{#if hasServiceTerms}}') > 0
        OR strpos(v.html_source, '{{#if hasInspectionChoices}}') > 0) AS has_guard,
       length(v.html_source) AS html_len
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;
