-- =====================================================================
-- 193_work_editions.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   作品の刊行物（版元・ISBN・刊行日・本体価格）。docs/work-editions.md。
--
--   1 つの作品が、版元を変えて何度も出る（例：アークライト版 2011 年 → 新紀元社版 2026 年）。
--   版元を作品に 1 つだけ持たせると、作品を二重に登録するしかない。そこで作品の下に刊行物を持つ。
--     relation          … 版元との関係
--                           own        = 自社刊行（当社が出す）
--                           group      = グループ会社（料率の取り決めが無い。版元として記録するだけ）
--                           sublicense = 再許諾（版元との OUT 条件がある）
--     out_condition_id  … 再許諾のとき、根拠の OUT 条件（作品 × 版元で 1 本。重版・新装版で ISBN が増えても条件は増えない）
--   ISBN は生きた刊行物の間で一意。
--
--   何度流しても同じ結果。戻すときは 193_work_editions_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

CREATE TABLE IF NOT EXISTS v3.work_editions (
  id                  bigserial PRIMARY KEY,
  work_id             bigint NOT NULL REFERENCES v3.works(id),
  publisher_party_id  bigint REFERENCES v3.parties(id),
  relation            text NOT NULL DEFAULT 'sublicense'
                      CHECK (relation IN ('own', 'group', 'sublicense')),
  isbn                text,
  edition_title       text,
  published_on        date,
  list_price          bigint CHECK (list_price IS NULL OR list_price >= 0),
  out_condition_id    bigint REFERENCES v3.conditions(id),
  notes               text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  created_by          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS work_editions_isbn_uq
  ON v3.work_editions (isbn) WHERE isbn IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS work_editions_work_idx ON v3.work_editions (work_id);
CREATE INDEX IF NOT EXISTS work_editions_out_idx
  ON v3.work_editions (out_condition_id) WHERE out_condition_id IS NOT NULL;
-- アプリの実行ロールの権限（当初付け忘れ。既に 193 を流した DB は 195 で付ける）。
GRANT SELECT, INSERT, UPDATE, DELETE ON v3.work_editions TO legalbridge_v3_runtime;
GRANT USAGE, SELECT ON SEQUENCE v3.work_editions_id_seq TO legalbridge_v3_runtime;
COMMENT ON TABLE v3.work_editions IS
  '作品の刊行物（版元・ISBN・刊行日・本体価格）。relation：own=自社刊行／group=グループ会社（料率なし）／sublicense=再許諾（out_condition_id が根拠の OUT 条件）。';

COMMIT;

-- 確かめ：表がある
SELECT to_regclass('v3.work_editions') AS work_editions;
