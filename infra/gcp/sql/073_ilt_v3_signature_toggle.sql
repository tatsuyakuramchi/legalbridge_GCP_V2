\set ON_ERROR_STOP on
\pset pager off

-- 073_ilt_v3_signature_toggle.sql
-- 個別利用許諾条件書V3（individual_license_terms_v3）に署名欄のオン/オフを追加（利用者指示 2026-09-03）。
--   本文末尾の「5. 署名」節（見出し・確認文・Licensor/Licensee の記名欄）を
--   {{#unless (eq 署名欄 "表示しない")}} … {{/unless}} で囲む。
--   フォームの「署名欄（末尾の記名押印欄）」欄はコード定義（individualLicenseV3Fields）に追加済み
--   （本テンプレの DB field_schema は空＝コード定義が効く）。描画コンテキストは formData を
--   そのまま含むため、テンプレから 署名欄 を直接参照できる。空欄＝表示する。
-- ガード: 現行版が version 3（md5 d3e88380…）・開始/終了の置換対象が各1箇所。
-- 新版 INSERT ＋ current_version_id 差し替え（既存文書は自身の版のまま）。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_ilt_sig=ADD_ILT_V3_SIGNATURE_TOGGLE \
--         -f infra/gcp/sql/073_ilt_v3_signature_toggle.sql

\if :{?confirm_ilt_sig}
\else
  \echo 'Run with: -v confirm_ilt_sig=ADD_ILT_V3_SIGNATURE_TOGGLE'
  \quit 2
\endif
SELECT :'confirm_ilt_sig' = 'ADD_ILT_V3_SIGNATURE_TOGGLE' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  tpl_id bigint; ver_no int; src text; schema jsonb;
  open_old text := E'\n<!-- 5. 署名 -->\n<h2 class="block">5.　署名</h2>';
  open_new text := E'\n{{#unless (eq 署名欄 "表示しない")}}\n<!-- 5. 署名 -->\n<h2 class="block">5.　署名</h2>';
  close_old text := E'\n</div>\n\n</body>\n</html>';
  close_new text := E'\n</div>\n{{/unless}}\n\n</body>\n</html>';
  n_open int; n_close int; new_html text; new_ver_id bigint;
BEGIN
  SELECT t.id, v.version_no, v.html_source, v.field_schema INTO tpl_id, ver_no, src, schema
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'individual_license_terms_v3';
  IF tpl_id IS NULL THEN RAISE EXCEPTION 'individual_license_terms_v3 が見つかりません'; END IF;
  IF ver_no <> 3 OR md5(src) <> 'd3e883809afd541396fd4ff0168fbd7c' THEN
    RAISE EXCEPTION '現行版が想定（version 3）と異なります (version=% md5=%)', ver_no, md5(src);
  END IF;
  n_open := (length(src) - length(replace(src, open_old, ''))) / length(open_old);
  n_close := (length(src) - length(replace(src, close_old, ''))) / length(close_old);
  IF n_open <> 1 OR n_close <> 1 THEN
    RAISE EXCEPTION '署名節の開始/終了が想定外です（開始=%・終了=%、想定は各1）', n_open, n_close;
  END IF;
  new_html := replace(replace(src, open_old, open_new), close_old, close_new);

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  VALUES (
    tpl_id,
    (SELECT COALESCE(MAX(version_no), 0) + 1 FROM document_template_versions WHERE template_id = tpl_id),
    new_html, schema,
    '署名欄のオン/オフ（署名欄=表示しない で 5. 署名 節を非表示）を追加（2026-09-03 利用者指示）',
    'tatsuya.kuramochi@arclight.co.jp'
  ) RETURNING id INTO new_ver_id;
  UPDATE document_templates SET current_version_id = new_ver_id WHERE id = tpl_id;
END $$;

SELECT t.template_key, v.version_no,
       (regexp_matches(v.html_source, '\{\{#unless \(eq 署名欄 "表示しない"\)\}\}.{0,60}', 'g'))[1] AS opened,
       (regexp_matches(v.html_source, '.{0,30}\{\{/unless\}\}.{0,20}', 'g'))[1] AS closed
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'individual_license_terms_v3';

COMMIT;
