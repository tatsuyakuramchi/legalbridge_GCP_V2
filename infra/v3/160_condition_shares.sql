-- =====================================================================
-- 160_condition_shares.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-068：共著の取り分（docs/royalty-shares.md）。
--   中身は 004_amend.sql の A-068 と同じ（004 を流し直すなら、こちらは要らない）。
--
--   作品に対する許諾料率は条件明細 1 本（全体率）が持つ。当社から複数の権利者へ
--   直接払う作品だけ、「誰に何 %」を condition_shares に持つ。代表 1 者が受け取って
--   自分で分配する契約は従来どおり条件の相手先 1 者だけで、取り分は持たない。
--
--     v3.condition_shares            条件 × 権利者 × 取り分（百万分率。合計 100% はアプリが担保）
--     v3.statements.payee_party_id   その計算書の受取人（空＝条件の相手先）
--     v3.statements.share_ppm        その計算書の取り分（空＝100%）
--     statements の一意索引           文書 × 条件 × 受取人（A-020 の索引を差し替え）
--
--   何度流しても同じ。データは書き換えない。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TABLE IF NOT EXISTS v3.condition_shares (
  id           bigserial PRIMARY KEY,
  condition_id bigint NOT NULL REFERENCES v3.conditions(id) ON DELETE CASCADE,
  party_id     bigint NOT NULL REFERENCES v3.parties(id),
  share_ppm    integer NOT NULL CHECK (share_ppm > 0 AND share_ppm <= 1000000),
  sort_order   int NOT NULL DEFAULT 0,
  note         text,
  UNIQUE (condition_id, party_id)
);
CREATE INDEX IF NOT EXISTS condition_shares_condition_idx ON v3.condition_shares (condition_id);
COMMENT ON TABLE v3.condition_shares IS
  '共著の取り分。条件（全体率）を権利者ごとに何 % に分けて当社から直接払うか。百万分率、合計 100%。A-068';
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.condition_shares TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.condition_shares_id_seq TO legalbridge_v3_runtime;

ALTER TABLE v3.statements ADD COLUMN IF NOT EXISTS payee_party_id bigint REFERENCES v3.parties(id);
ALTER TABLE v3.statements ADD COLUMN IF NOT EXISTS share_ppm integer;
COMMENT ON COLUMN v3.statements.payee_party_id IS
  'この計算書の受取人（取り分のある条件のとき）。空なら条件の相手先。A-068';
COMMENT ON COLUMN v3.statements.share_ppm IS
  'この計算書が全体のうち何 % の取り分か（百万分率）。空なら 100%。A-068';
DROP INDEX IF EXISTS v3.statements_document_condition_uq;
CREATE UNIQUE INDEX IF NOT EXISTS statements_document_condition_payee_uq
  ON v3.statements (document_id, condition_id, COALESCE(payee_party_id, 0));
CREATE INDEX IF NOT EXISTS statements_payee_idx
  ON v3.statements (payee_party_id) WHERE payee_party_id IS NOT NULL;

COMMIT;

-- 確認（4 であること）
SELECT (SELECT count(*) FROM information_schema.tables
         WHERE table_schema='v3' AND table_name='condition_shares')
     + (SELECT count(*) FROM information_schema.columns
         WHERE table_schema='v3' AND table_name='statements' AND column_name IN ('payee_party_id', 'share_ppm'))
     + (SELECT count(*) FROM pg_indexes
         WHERE schemaname='v3' AND indexname='statements_document_condition_payee_uq') AS 表と列と索引;
