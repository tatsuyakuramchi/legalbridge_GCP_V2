\set ON_ERROR_STOP on
\pset pager off

-- 072_pub_license_terms_signature_toggle.sql
-- 出版・個別利用許諾条件書（pub_license_terms）に署名欄のオン/オフを追加（利用者指示 2026-09-03）。
--   基本契約と個別条件書を CloudSign の1書類で一括締結するとき、文書ごとに記名押印欄が
--   並ぶと使いにくい。フォームに「署名欄（末尾の記名押印欄）」（表示する／表示しない・
--   空欄＝表示する）を追加し、本文末尾の署名ブロック <div class="head-signature">…</div> を
--   {{#unless (eq 署名欄 "表示しない")}} … {{/unless}} で囲む。成立文言（closing-text）は残す。
-- ガード: 現行版が version 4（md5 d3d65a83…）・開始/終了の置換対象が各1箇所・欄が未追加。
-- 新版 INSERT ＋ current_version_id 差し替え（既存文書は自身の版のまま）。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_pub_sig=ADD_PUB_SIGNATURE_TOGGLE \
--         -f infra/gcp/sql/072_pub_license_terms_signature_toggle.sql

\if :{?confirm_pub_sig}
\else
  \echo 'Run with: -v confirm_pub_sig=ADD_PUB_SIGNATURE_TOGGLE'
  \quit 2
\endif
SELECT :'confirm_pub_sig' = 'ADD_PUB_SIGNATURE_TOGGLE' AS confirmed \gset
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
  open_old text := E'\n  <div class="head-signature">\n    <div class="sig-date">';
  open_new text := E'\n{{#unless (eq 署名欄 "表示しない")}}\n  <div class="head-signature">\n    <div class="sig-date">';
  close_old text := E'\n  </div>\n\n</div>\n</body>';
  close_new text := E'\n  </div>\n{{/unless}}\n\n</div>\n</body>';
  n_open int; n_close int; anchor_idx int := NULL; i int;
  new_field jsonb; new_schema jsonb; new_html text; new_ver_id bigint;
BEGIN
  SELECT t.id, v.version_no, v.html_source, v.field_schema INTO tpl_id, ver_no, src, schema
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms';
  IF tpl_id IS NULL THEN RAISE EXCEPTION 'pub_license_terms が見つかりません'; END IF;
  IF ver_no <> 4 OR md5(src) <> 'd3d65a83e4d0d1e5bb8f14451411e02f' THEN
    RAISE EXCEPTION '現行版が想定（version 4）と異なります (version=% md5=%)', ver_no, md5(src);
  END IF;
  n_open := (length(src) - length(replace(src, open_old, ''))) / length(open_old);
  n_close := (length(src) - length(replace(src, close_old, ''))) / length(close_old);
  IF n_open <> 1 OR n_close <> 1 THEN
    RAISE EXCEPTION '署名ブロックの開始/終了が想定外です（開始=%・終了=%、想定は各1）', n_open, n_close;
  END IF;
  IF jsonb_typeof(schema) <> 'array' THEN RAISE EXCEPTION 'field_schema の形が想定外です'; END IF;
  FOR i IN 0..jsonb_array_length(schema) - 1 LOOP
    IF schema->i->>'name' = '署名欄' THEN RAISE EXCEPTION '入力欄「署名欄」は既に存在します'; END IF;
    IF schema->i->>'name' = '許諾者種別' THEN anchor_idx := i; END IF;
  END LOOP;
  IF anchor_idx IS NULL THEN RAISE EXCEPTION '挿入位置の目印（許諾者種別）が見つかりません'; END IF;

  new_field := jsonb_build_object(
    'name', '署名欄',
    'label', '署名欄（末尾の記名押印欄）',
    'type', 'select',
    'options', jsonb_build_array('表示する', '表示しない'),
    'group', 'I. 基本情報',
    'helpText', '基本契約と一括で電子署名する場合は「表示しない」にすると、条件書末尾の記名押印欄が出ず基本契約側の署名欄だけになります。空欄は「表示する」と同じです。'
  );
  new_schema := jsonb_insert(schema, ARRAY[anchor_idx::text], new_field, true);
  new_html := replace(replace(src, open_old, open_new), close_old, close_new);

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  VALUES (
    tpl_id,
    (SELECT COALESCE(MAX(version_no), 0) + 1 FROM document_template_versions WHERE template_id = tpl_id),
    new_html, new_schema,
    '署名欄のオン/オフ（署名欄=表示しない で末尾の記名押印欄を非表示）を追加（2026-09-03 利用者指示）',
    'tatsuya.kuramochi@arclight.co.jp'
  ) RETURNING id INTO new_ver_id;
  UPDATE document_templates SET current_version_id = new_ver_id WHERE id = tpl_id;
END $$;

SELECT t.template_key, v.version_no,
       (regexp_matches(v.html_source, '\{\{#unless \(eq 署名欄 "表示しない"\)\}\}.{0,60}', 'g'))[1] AS opened,
       (regexp_matches(v.html_source, '.{0,40}\{\{/unless\}\}.{0,20}', 'g'))[1] AS closed
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'pub_license_terms';

COMMIT;
