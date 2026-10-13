-- =====================================================================
-- 167_counterparty_doc_no.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-072：相手方の文書番号の控え（apps/legalbridge-v3/src/server/documents/cite-no.ts）。
--   中身は 004_amend.sql の A-072 と同じ（004 を流し直すなら、こちらは要らない）。
--
--     v3.documents.counterparty_doc_no
--       相手方から届いた文書（取り込んだ契約書・発注書・覚書）や、当社の文書に
--       相手方が付けた番号の控え。当社の番号（document_no）とは別に持つ。
--       個別条件書・発注書・検収書・計算書で引用するとき、文書フォームの
--       「番号の出し方」で 当社番号／相手方番号／両方 を選べる。
--       契約の相手方番号は、これまでどおり agreements.counterparty_ref_no。
--
--   何度流しても同じ。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.documents ADD COLUMN IF NOT EXISTS counterparty_doc_no text;
COMMENT ON COLUMN v3.documents.counterparty_doc_no IS
  '相手方が付けた文書番号の控え。当社番号（document_no）とは別。引用するとき 当社／相手方／両方 を選べる。A-072';

COMMIT;

-- 確認（列 1 であること）
SELECT count(*) AS 列 FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='documents' AND column_name='counterparty_doc_no';
