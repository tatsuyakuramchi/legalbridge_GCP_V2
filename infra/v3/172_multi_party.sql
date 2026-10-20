-- =====================================================================
-- 172_multi_party.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-075：複数当事者の契約（docs/v3-tidy.md「取引の 3 つの型」型 3）。
--
--   契約・条件の相手方（counterparty_id）は 1 人のまま。3 者以上が関わる文書は
--   「文書 × 取引先 × 役割」を N 行で持ち、どの取引先の木からも同じ 1 件が見える。
--   地位承継（3 社契約）は、元の契約の相手方を発効日で切り替える出来事として持つ。
--
--     v3.document_parties        文書の関係当事者（相手方・共著者・譲渡人・譲受人・承諾者・署名者）
--     v3.agreement_successions   契約の相手方の切り替え（誰から誰へ・発効日・根拠の文書・適用した日時）
--
--   何度流しても同じ。データは書き換えない。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TABLE IF NOT EXISTS v3.document_parties (
  id          bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES v3.documents(id) ON DELETE CASCADE,
  party_id    bigint NOT NULL REFERENCES v3.parties(id),
  role        text NOT NULL
              CHECK (role IN ('counterparty', 'coauthor', 'assignor', 'assignee', 'consenter', 'signer', 'other')),
  note        text,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, party_id, role)
);
CREATE INDEX IF NOT EXISTS document_parties_party_idx ON v3.document_parties (party_id);
COMMENT ON TABLE v3.document_parties IS
  '文書の関係当事者。文書は 1 件のまま、関わる取引先を役割つきで N 行持つ（連名の条件書・3 社契約）。宛名・支払の宛先は従来どおり 1 人。A-075';
COMMENT ON COLUMN v3.document_parties.role IS
  'counterparty=相手方 / coauthor=共著者 / assignor=譲渡人 / assignee=譲受人 / consenter=承諾者 / signer=署名者 / other';
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.document_parties TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.document_parties_id_seq TO legalbridge_v3_runtime;

CREATE TABLE IF NOT EXISTS v3.agreement_successions (
  id            bigserial PRIMARY KEY,
  agreement_id  bigint NOT NULL REFERENCES v3.agreements(id) ON DELETE CASCADE,
  from_party_id bigint NOT NULL REFERENCES v3.parties(id),
  to_party_id   bigint NOT NULL REFERENCES v3.parties(id),
  effective_on  date NOT NULL,
  document_id   bigint REFERENCES v3.documents(id),
  note          text,
  applied_at    timestamptz,
  reverted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL DEFAULT current_user,
  CHECK (from_party_id <> to_party_id)
);
CREATE INDEX IF NOT EXISTS agreement_successions_agreement_idx ON v3.agreement_successions (agreement_id);
CREATE INDEX IF NOT EXISTS agreement_successions_party_idx ON v3.agreement_successions (from_party_id, to_party_id);
COMMENT ON TABLE v3.agreement_successions IS
  '契約の地位承継。発効日が来たら契約と条件の相手方を from から to に切り替える（applied_at）。発効日前の実績・支払文書・支払は from 宛てのまま。A-075';
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.agreement_successions TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.agreement_successions_id_seq TO legalbridge_v3_runtime;

COMMIT;

\echo '--- 複数当事者（A-075。表 2 であること） ---'
SELECT count(*) AS 表 FROM information_schema.tables
 WHERE table_schema='v3' AND table_name IN ('document_parties', 'agreement_successions');
