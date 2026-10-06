-- =====================================================================
-- 161_ebook_work_codes.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-069：電子書籍売上の取込（docs/royalty-shares.md §5）。
--   中身は 004_amend.sql の A-069 と同じ（004 を流し直すなら、こちらは要らない）。
--
--   事業部の月次 Excel（販売月・書店・タイトル・CID・販売価格・DL数）を読んで、
--   作品の電子出版の IN 条件に実績（usage_type='pub_digital'）を立てる。
--   作品は CID（書店の配信コード）で当て、当て方は一度決めたら覚える。
--
--   何度流しても同じ。データは書き換えない。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TABLE IF NOT EXISTS v3.ebook_work_codes (
  cid        text PRIMARY KEY,
  work_id    bigint NOT NULL REFERENCES v3.works(id),
  title      text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ebook_work_codes_work_idx ON v3.ebook_work_codes (work_id);
COMMENT ON TABLE v3.ebook_work_codes IS
  '電子書籍の配信コード（CID）→ 作品。売上の取込で当てた結果を覚える。A-069';
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.ebook_work_codes TO legalbridge_v3_runtime;

COMMIT;

-- 確認（1 であること）
SELECT count(*) AS 表 FROM information_schema.tables
 WHERE table_schema='v3' AND table_name='ebook_work_codes';
