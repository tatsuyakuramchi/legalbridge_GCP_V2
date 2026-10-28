-- =====================================================================
-- 189_order_agreements.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   発注書の個別契約（docs/v3-condition-holder.md 段階2 PR-B）。
--
--   条件明細を持つのは個別契約（条件書・発注書）か単体契約で、基本契約は個別契約を持つ。
--   条件書は決定したとき agreements に個別契約（kind=supplement）の行が立つが、発注書は文書だけで
--   契約の行が無く、条件明細は基本契約を直接指していた。発注書も決定したとき個別契約の行を立てる
--   （基本契約の下なら supplement、基本契約が無ければ standalone。番号は発注書の番号）。
--   その行が発注書のものであることを order_document_id で持つ（画面では発注書として見せ、
--   契約の一覧には出さない）。
--
--   列を足すだけ。既存の行は触らない（既存の発注書の分は 190 の移行で立てる）。
--   何度流しても同じ結果。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.agreements ADD COLUMN IF NOT EXISTS order_document_id bigint REFERENCES v3.documents(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agreements_order_document_id_key ON v3.agreements (order_document_id) WHERE order_document_id IS NOT NULL;
COMMENT ON COLUMN v3.agreements.order_document_id IS '発注書の個別契約のとき、その発注書（文書）。画面では発注書として見せ、契約の一覧には出さない';

COMMIT;
