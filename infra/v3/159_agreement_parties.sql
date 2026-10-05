-- =====================================================================
-- 159_agreement_parties.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-068：三社間契約など、当社（アークライト）対 相手方が 1 対 N になる契約を表す。
--   中身は 004_amend.sql の A-068 と同じ（004 を流し直すなら、こちらは要らない）。
--
--   これまで契約（v3.agreements）の相手方は counterparty_id の 1 列だけで、
--   三社間契約は「相手方を 1 社だけ選ぶ」か「同じ契約を 2 本登録する」しか
--   できなかった。もう 1 社は検索・取引先の画面・法務検索のどれにも出なかった。
--
--   v3.agreement_parties … 契約の「他の当事者」（主たる相手先は agreements.counterparty_id のまま）
--     agreement_id / party_id / role（共同当事者・窓口・保証人・権利者・その他）/ seq（丙＝2 から）/ note
--     主たる相手先をこの表に重ねて入れない（アプリで断る。ビューは UNION で重複を畳む）。
--   v3.v_agreement_parties … 主たる相手先（seq 1）と他の当事者を 1 本に並べた読み取り用。
--     「この取引先の契約」を引く画面はこのビューを通す。
--
--   表とビューを足すだけ。既存の列・データは書き換えない。何度流しても同じ。
--   アプリはこの表が無くても契約の登録・表示は動く（当事者の追加だけが「まだ作られていません」で止まる）。
--
--   実行: psql "host=127.0.0.1 port=5432 dbname=legalbridge user=postgres" -f infra/v3/159_agreement_parties.sql
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS v3.agreement_parties (
  id           bigserial PRIMARY KEY,
  agreement_id bigint NOT NULL REFERENCES v3.agreements(id) ON DELETE CASCADE,
  party_id     bigint NOT NULL REFERENCES v3.parties(id),
  -- 契約の中での立場。主たる相手先（counterparty_id）はここに入れない。
  role         text NOT NULL DEFAULT 'co_party'
               CONSTRAINT agreement_parties_role_chk
               CHECK (role IN ('co_party', 'agent', 'guarantor', 'rights_holder', 'other')),
  -- 契約書の頭書きの順。主たる相手先が 1（乙）なので、他の当事者は 2（丙）から。
  seq          int NOT NULL CHECK (seq >= 2),
  note         text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, party_id),
  CONSTRAINT agreement_parties_seq_uq UNIQUE (agreement_id, seq) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE v3.agreement_parties IS
  '契約の他の当事者（三社間契約など）。主たる相手先は agreements.counterparty_id のまま。A-068';
COMMENT ON COLUMN v3.agreement_parties.role IS
  'co_party=共同当事者 / agent=窓口・代理 / guarantor=保証人 / rights_holder=権利者 / other=その他';
CREATE INDEX IF NOT EXISTS agreement_parties_party_idx ON v3.agreement_parties (party_id);

-- 主たる相手先（seq 1）と他の当事者を 1 本に。取引先→契約の逆引きはここを通す。
CREATE OR REPLACE VIEW v3.v_agreement_parties AS
SELECT a.id AS agreement_id, a.counterparty_id AS party_id,
       'counterparty'::text AS role, 1 AS seq, true AS is_primary, NULL::text AS note
  FROM v3.agreements a
UNION ALL
SELECT ap.agreement_id, ap.party_id, ap.role, ap.seq, false AS is_primary, ap.note
  FROM v3.agreement_parties ap
  JOIN v3.agreements a ON a.id = ap.agreement_id
 WHERE ap.party_id <> a.counterparty_id;
COMMENT ON VIEW v3.v_agreement_parties IS
  '契約の当事者（主たる相手先 seq 1 ＋ 他の当事者）。取引先ごとの契約を引く画面はここを通す。A-068';

-- アプリの接続ユーザー。追加当事者は付け外しできる。
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.agreement_parties TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.agreement_parties_id_seq TO legalbridge_v3_runtime;
GRANT SELECT ON v3.v_agreement_parties TO legalbridge_v3_runtime;

COMMIT;

-- 確認（表 1・ビュー 1 で 2 であること）
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'v3' AND table_name = 'agreement_parties')
     + (SELECT count(*) FROM information_schema.views  WHERE table_schema = 'v3' AND table_name = 'v_agreement_parties') AS 表とビュー;

-- 確認：アプリの接続ユーザーが読み書きできるか（t なら OK）。
SELECT has_table_privilege('legalbridge_v3_runtime', 'v3.agreement_parties', 'INSERT') AS 追加できる,
       has_table_privilege('legalbridge_v3_runtime', 'v3.v_agreement_parties', 'SELECT') AS 読める,
       (SELECT count(*) FROM v3.v_agreement_parties) AS 当事者の行数;
