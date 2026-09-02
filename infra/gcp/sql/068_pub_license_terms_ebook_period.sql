\set ON_ERROR_STOP on
\pset pager off

-- 068_pub_license_terms_ebook_period.sql
-- 出版・個別利用許諾条件書（pub_license_terms）の支払条件を改訂（利用者指示 2026-09-02）。
--   旧: 紙書籍＝都度払い（刊行日を含む月の翌々月 法人=末日/個人=20日払い）
--       電子書籍＝年1回・6月（法人=末日/個人=20日）払い・算定期間 毎年4/1〜翌3/31
--   新: 紙書籍・電子書籍とも＝年1回・10月（法人=末日/個人=20日）払い・
--       算定期間 毎年7月1日〜翌年6月末日（同日締め）
-- 法人/個人の書き分け（末日/20日）はフィールド仕様（許諾者種別のラベルに明記）どおり維持。
-- 方式: 現行版（version 2・md5 1afe8ab6…）を md5 で照合 → 文言2箇所を置換した
--       新版を INSERT → current_version_id を差し替え（049 NDA改訂と同じ作法）。
--       field_schema は変更なし。確定済みの旧文書は自身の版でそのまま再生成できる。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_pub_period=REVISE_PUB_PAYMENT_PERIOD \
--         -f infra/gcp/sql/068_pub_license_terms_ebook_period.sql

\if :{?confirm_pub_period}
\else
  \echo 'Run with: -v confirm_pub_period=REVISE_PUB_PAYMENT_PERIOD'
  \quit 2
\endif
SELECT :'confirm_pub_period' = 'REVISE_PUB_PAYMENT_PERIOD' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 現行版が想定どおりであること・置換対象が各1箇所であることを確認して中断可能にする。
DO $$
DECLARE
  src text;
  old_paper text := '紙書籍：都度払い（刊行日を含む月の翌々月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い）。';
  old_ebook text := '電子書籍：年1回・6月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い（算定期間：毎年4月1日から翌年3月末日まで、同日締め）。';
  n_paper int;
  n_ebook int;
BEGIN
  SELECT v.html_source INTO src
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms';
  IF src IS NULL THEN
    RAISE EXCEPTION 'pub_license_terms テンプレートが見つかりません';
  END IF;
  IF md5(src) <> '1afe8ab6b7a4527e7e6fac3333cc0102' THEN
    RAISE EXCEPTION 'pub_license_terms の現行版が想定（version 2）と異なります (md5=%)', md5(src);
  END IF;
  n_paper := (length(src) - length(replace(src, old_paper, ''))) / length(old_paper);
  n_ebook := (length(src) - length(replace(src, old_ebook, ''))) / length(old_ebook);
  IF n_paper <> 1 OR n_ebook <> 1 THEN
    RAISE EXCEPTION '置換対象の出現回数が想定外です（紙=%箇所・電子=%箇所、想定は各1箇所）', n_paper, n_ebook;
  END IF;
END $$;

WITH cur AS (
  SELECT t.id AS template_id, v.html_source, v.field_schema,
         (SELECT COALESCE(MAX(version_no), 0) + 1
            FROM document_template_versions WHERE template_id = t.id) AS next_no
    FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'pub_license_terms'
), inserted AS (
  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  SELECT template_id, next_no,
         replace(replace(html_source,
           '紙書籍：都度払い（刊行日を含む月の翌々月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い）。',
           '紙書籍：年1回・10月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い（算定期間：毎年7月1日から翌年6月末日まで、同日締め）。'),
           '電子書籍：年1回・6月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い（算定期間：毎年4月1日から翌年3月末日まで、同日締め）。',
           '電子書籍：年1回・10月{{#if (eq 許諾者種別 "法人")}}末日{{else}}20日{{/if}}払い（算定期間：毎年7月1日から翌年6月末日まで、同日締め）。'),
         field_schema,
         '紙・電子とも 年1回・10月（法人=末日/個人=20日）払い・算定期間 7/1〜翌6月末日へ変更（2026-09-02 利用者指示）',
         'tatsuya.kuramochi@arclight.co.jp'
    FROM cur
  RETURNING id, template_id
)
UPDATE document_templates t
   SET current_version_id = i.id
  FROM inserted i
 WHERE t.id = i.template_id;

-- 適用結果の確認（紙・電子の新しい文言が現行版に入っていること）。
SELECT t.template_key, v.version_no,
       (regexp_matches(v.html_source, '紙書籍：年1回・10月.{0,130}', 'g'))[1] AS paper_clause,
       (regexp_matches(v.html_source, '電子書籍：年1回・10月.{0,130}', 'g'))[1] AS ebook_clause
  FROM document_templates t JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'pub_license_terms';

COMMIT;
