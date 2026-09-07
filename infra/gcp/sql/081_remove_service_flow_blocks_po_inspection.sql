\set ON_ERROR_STOP on
\pset pager off

-- 081_remove_service_flow_blocks_po_inspection.sql
-- 079 で発注書（purchase_order）と検収書（inspection_certificate）に差し込んだ
-- 「業務委託の条件」「確認方法・判定・支払処理」のブロック（<section class="lb-service-terms">）を
-- 取り除く（2026-09-07 の指摘: 発注書上部の条件表と検収書下部の「合格」表は不要）。
--
-- 方針: 079 の版（同日に作成・差分はこのブロックだけ）の html_source をその場で書き換える。
--   新版を積むだけだと、079 以降に作った文書は自分の版（templateVersionId）で描くため
--   ブロックが残り続ける。書き換えれば既存文書の再発行・Drive 保存からも消える。
--   business_master（業務委託基本契約）と intl_purchase_order（海外発注書）は対象外
--   （必要なら下の template_key リストに追加）。
-- 冪等: 対象にブロックが無ければ何もしない。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_remove_blocks=REMOVE_SERVICE_FLOW_BLOCKS \
--         -f infra/gcp/sql/081_remove_service_flow_blocks_po_inspection.sql

\if :{?confirm_remove_blocks}
\else
  \echo 'Run with: -v confirm_remove_blocks=REMOVE_SERVICE_FLOW_BLOCKS'
  \quit 2
\endif
SELECT :'confirm_remove_blocks' = 'REMOVE_SERVICE_FLOW_BLOCKS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 適用前: ブロックを含む版の一覧
SELECT t.template_key, v.version_no, v.id = t.current_version_id AS is_current,
       length(v.html_source) AS html_len
  FROM document_templates t
  JOIN document_template_versions v ON v.template_id = t.id
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
   AND strpos(v.html_source, 'lb-service-terms') > 0
 ORDER BY t.template_key, v.version_no;

DO $do$
DECLARE
  rec record;
  new_html text;
  touched int := 0;
  guard text;
  s int;       -- {{#if …}} の開始位置
  p int;       -- <section の位置（相対）
  e int;       -- </section> の位置（相対）
  f int;       -- その後の {{/if}} の位置（相対）
  cut_end int;
BEGIN
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
    -- を位置計算で切り出す（正規表現の貪欲/非貪欲の混在に依存しない）。1 テンプレに 1 ブロックだが
    -- 念のため無くなるまで繰り返す。
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
      cut_end := s + e - 1 + f - 1 + length('{{/if}}');   -- {{/if}} の直後（1 始まり・排他的）
      -- 直後の改行も 1 つ取り除く
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

-- 適用後: 現行版にブロックが残っていないこと（has_block が f）
SELECT t.template_key, v.version_no,
       strpos(v.html_source, 'lb-service-terms') > 0 AS has_block,
       strpos(v.html_source, '{{#if hasServiceTerms}}') > 0 OR strpos(v.html_source, '{{#if hasInspectionChoices}}') > 0 AS has_guard
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'inspection_certificate')
 ORDER BY t.template_key;

COMMIT;
