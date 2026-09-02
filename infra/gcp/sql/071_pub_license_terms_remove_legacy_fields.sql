\set ON_ERROR_STOP on
\pset pager off

-- 071_pub_license_terms_remove_legacy_fields.sql
-- 出版・個別利用許諾条件書（pub_license_terms）のレガシー入力欄を外す（利用者決定 2026-09-02）。
--   全テンプレートの field_schema と html_source を突き合わせた結果、入力しても条文に
--   一切出ない項目は本テンプレの以下5つだけだった（055 で「別途」と保留したもの）:
--     翻訳海外版許諾有無 / 翻訳海外版対象地域言語 / 翻訳海外版計算式 / 翻訳海外版料率
--       … 本文の二次利用欄に「翻訳…は通常の条件書では対象外（二次的著作物）」と明記＝削除
--     販売形態 … 出力先が無く用途も無いため削除
--   他の候補（CHANGE_RECORDS・royalty_statement の (legacy) 項目・*_IS_CORPORATION）は
--   アプリ側が使う／自動非表示のため残す。
-- ★ 055 と同じく版は上げず、現行版（version 4）の field_schema だけを書き換える。
--   html_source は無変更＝描画結果は同一。既存文書の再生成・CloudSign 依頼に影響しない。
--   documents.form_data には触れない（旧文書に値が残っていても表示には出ない）。冪等。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_pub_fields=REMOVE_PUB_LEGACY_FIELDS \
--         -f infra/gcp/sql/071_pub_license_terms_remove_legacy_fields.sql

\if :{?confirm_pub_fields}
\else
  \echo 'Run with: -v confirm_pub_fields=REMOVE_PUB_LEGACY_FIELDS'
  \quit 2
\endif
SELECT :'confirm_pub_fields' = 'REMOVE_PUB_LEGACY_FIELDS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 適用前：対象項目の実在確認（初回は 5 行、再実行時は 0 行）。
SELECT f->>'name' AS field, f->>'label' AS label
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE t.template_key = 'pub_license_terms'
   AND f->>'name' IN ('翻訳海外版許諾有無', '翻訳海外版対象地域言語', '翻訳海外版計算式', '翻訳海外版料率', '販売形態')
 ORDER BY field;

DO $$
DECLARE ver_no int;
BEGIN
  SELECT v.version_no INTO ver_no
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms';
  IF ver_no IS NULL THEN RAISE EXCEPTION 'pub_license_terms テンプレートが見つかりません'; END IF;
  IF ver_no < 4 THEN
    RAISE EXCEPTION '現行版が version 4 未満です (version=%)。068/069 を先に適用してください', ver_no;
  END IF;
END $$;

UPDATE document_template_versions v
   SET field_schema = (
     SELECT COALESCE(jsonb_agg(f ORDER BY ord), '[]'::jsonb)
       FROM jsonb_array_elements(v.field_schema) WITH ORDINALITY AS a(f, ord)
      WHERE f->>'name' NOT IN ('翻訳海外版許諾有無', '翻訳海外版対象地域言語', '翻訳海外版計算式', '翻訳海外版料率', '販売形態')
   )
  FROM document_templates t
 WHERE t.template_key = 'pub_license_terms'
   AND v.id = t.current_version_id;

-- 適用後：0 行になっていること。
SELECT count(*) AS remaining_legacy_fields
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
  LATERAL jsonb_array_elements(v.field_schema) f
 WHERE t.template_key = 'pub_license_terms'
   AND f->>'name' IN ('翻訳海外版許諾有無', '翻訳海外版対象地域言語', '翻訳海外版計算式', '翻訳海外版料率', '販売形態');

COMMIT;
