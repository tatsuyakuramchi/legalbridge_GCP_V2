\set ON_ERROR_STOP on
\pset pager off

-- 069_pub_license_terms_paper_per_publication.sql
-- 出版・個別利用許諾条件書（pub_license_terms）の紙書籍支払を都度払いへ再変更
-- （利用者指示 2026-09-02。068 で年1回・10月に揃えた直後の方針変更）。
--   紙書籍: 年1回・10月払い（068）
--     → 都度払い（支払基準日〔校了日・出版予定日等のフリーワード欄・未入力時は刊行日〕を
--        含む月の翌月 法人=末日／個人=20日 払い）
--   電子書籍: 年1回・10月払い・算定期間 7/1〜翌6月末日（068のまま変更なし）
-- あわせて form の入力欄「紙支払基準日」（フリーワード）を紙の印税欄の直後に追加する。
-- ガード: 現行版が version 3・置換対象の文言が正確に1箇所・欄が未追加であること。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_pub_paper=REVISE_PUB_PAPER_PER_PUBLICATION \
--         -f infra/gcp/sql/069_pub_license_terms_paper_per_publication.sql

\if :{?confirm_pub_paper}
\else
  \echo 'Run with: -v confirm_pub_paper=REVISE_PUB_PAPER_PER_PUBLICATION'
  \quit 2
\endif
SELECT :'confirm_pub_paper' = 'REVISE_PUB_PAPER_PER_PUBLICATION' AS confirmed \gset
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
  tpl_id bigint;
  ver_no int;
  src text;
  schema jsonb;
  arr jsonb;
  is_wrapped boolean;
  anchor_idx int := NULL;
  anchor_group text;
  new_field jsonb;
  new_arr jsonb;
  new_schema jsonb;
  new_html text;
  new_ver_id bigint;
  old_clause text :=
    '紙書籍：年1回・10月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い（算定期間：毎年7月1日から翌年6月末日まで、同日締め）。';
  new_clause text :=
    '紙書籍：都度払い（{{#if 紙支払基準日}}{{紙支払基準日}}{{else}}刊行日{{/if}}を含む月の翌月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い）。';
  occurrences int;
  i int;
BEGIN
  SELECT t.id, v.version_no, v.html_source, v.field_schema
    INTO tpl_id, ver_no, src, schema
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms';
  IF tpl_id IS NULL THEN
    RAISE EXCEPTION 'pub_license_terms テンプレートが見つかりません';
  END IF;
  IF ver_no <> 3 OR md5(src) <> 'f1c0bc1b74d6f536d3b2b43577198570' THEN
    RAISE EXCEPTION '現行版が想定（version 3・068適用後）と異なります (version=% md5=%)', ver_no, md5(src);
  END IF;
  occurrences := (length(src) - length(replace(src, old_clause, ''))) / length(old_clause);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '置換対象（紙書籍の年1回払い文言）が % 箇所です（想定1箇所）', occurrences;
  END IF;

  -- field_schema は配列 or {fields:[...]} の両形に対応。
  is_wrapped := jsonb_typeof(schema) <> 'array';
  arr := CASE WHEN is_wrapped THEN schema->'fields' ELSE schema END;
  IF arr IS NULL OR jsonb_typeof(arr) <> 'array' THEN
    RAISE EXCEPTION 'field_schema の形が想定外です (%)', jsonb_typeof(schema);
  END IF;

  -- 既に追加済みなら中断（二重適用防止）。挿入位置は紙の印税関連欄の最後の直後。
  FOR i IN 0..jsonb_array_length(arr) - 1 LOOP
    IF arr->i->>'name' = '紙支払基準日' THEN
      RAISE EXCEPTION '入力欄「紙支払基準日」は既に存在します（適用済みの可能性）';
    END IF;
    IF arr->i->>'name' IN ('紙書籍印税率', '紙媒体計算式', '紙媒体印税対象部数区分') THEN
      anchor_idx := i;
      anchor_group := arr->i->>'group';
    END IF;
  END LOOP;
  IF anchor_idx IS NULL THEN
    RAISE EXCEPTION '挿入位置の目印（紙書籍印税率 等）が見つかりません';
  END IF;

  new_field := jsonb_build_object(
    'name', '紙支払基準日',
    'label', '支払基準日（紙・都度払い）',
    'type', 'text',
    'placeholder', '例: 校了日、出版予定日',
    'helpText', '紙書籍の支払起点となる日をフリーワードで指定します（この日を含む月の翌月払い）。空欄の場合は「刊行日」と印字されます。'
  ) || CASE WHEN anchor_group IS NOT NULL THEN jsonb_build_object('group', anchor_group) ELSE '{}'::jsonb END;

  new_arr := jsonb_insert(arr, ARRAY[anchor_idx::text], new_field, true);
  new_schema := CASE WHEN is_wrapped THEN jsonb_set(schema, '{fields}', new_arr) ELSE new_arr END;
  new_html := replace(src, old_clause, new_clause);

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  VALUES (
    tpl_id,
    (SELECT COALESCE(MAX(version_no), 0) + 1 FROM document_template_versions WHERE template_id = tpl_id),
    new_html, new_schema,
    '紙書籍を都度払い（支払基準日〔フリーワード〕を含む月の翌月・法人=末日/個人=20日）へ変更＋紙支払基準日欄を追加（2026-09-02 利用者指示）',
    'tatsuya.kuramochi@arclight.co.jp'
  ) RETURNING id INTO new_ver_id;

  UPDATE document_templates SET current_version_id = new_ver_id WHERE id = tpl_id;
END $$;

-- 適用結果の確認（新しい紙の文言と、追加された入力欄）。
SELECT t.template_key, v.version_no,
       (regexp_matches(v.html_source, '紙書籍：都度払い.{0,180}', 'g'))[1] AS paper_clause
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'pub_license_terms';

SELECT f->>'name' AS name, f->>'label' AS label, f->>'group' AS grp
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id,
       jsonb_array_elements(
         CASE WHEN jsonb_typeof(v.field_schema) = 'array' THEN v.field_schema
              ELSE v.field_schema->'fields' END) f
 WHERE t.template_key = 'pub_license_terms' AND f->>'name' = '紙支払基準日';

COMMIT;
