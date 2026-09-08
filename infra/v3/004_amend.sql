-- =====================================================================
-- LegalBridge V3 スキーマの後追い変更
--
--   001_schema.sql は CREATE TABLE IF NOT EXISTS で書いてあるので、
--   既に作られた表には流し直しても効かない。制約や列の変更はここに積む。
--   何度流しても同じ結果になるように書くこと。
--
--   実行: psql "$ADMIN_DSN" -f infra/v3/004_amend.sql
--   順番: 003_grants.sql の後、005_preflight.sql の前。
--   新しい表を足したときは 003_grants.sql も流し直すこと。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- A-001 メールのスレッドを案件に紐づけられるようにする
--
--   受信したメールから案件を起こしたとき、同じスレッドの続きが届いても
--   案件を二重に立てないために、スレッドIDを控える先が要る。
--   制約名は自動採番なので、名前を決め打ちにせず pg_constraint から引く。
-- ---------------------------------------------------------------------
DO $amend_matter_links$
DECLARE
  con   text;
  wanted constant text[] := ARRAY[
    'backlog_issue', 'document', 'agreement', 'condition', 'payment',
    'slack_thread', 'email_thread'];
BEGIN
  -- 既に email_thread を通す制約なら何もしない。
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%email_thread%'
  ) THEN
    RAISE NOTICE 'A-001: 適用済み';
  ELSE
    SELECT c.conname INTO con
      FROM pg_constraint c
     WHERE c.conrelid = 'v3.matter_links'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%target_type%'
     LIMIT 1;
    IF con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE v3.matter_links DROP CONSTRAINT %I', con);
    END IF;
    EXECUTE format(
      'ALTER TABLE v3.matter_links ADD CONSTRAINT matter_links_target_type_check
         CHECK (target_type = ANY (%L::text[]))', wanted);
    RAISE NOTICE 'A-001: matter_links.target_type に email_thread を足した';
  END IF;
END
$amend_matter_links$;

-- ---------------------------------------------------------------------
-- A-002 予定明細に名前を持たせる
--
--   毎月28万円の1年契約は12行並ぶ。どの行が何月分かを人が読めるように
--   名前を持たせる（「2026年4月分」「第1回 着手金」）。期日から機械的に
--   導ける場合もあるが、着手金・中間金のような区切りは導けない。
-- ---------------------------------------------------------------------
ALTER TABLE v3.condition_schedules ADD COLUMN IF NOT EXISTS label text;

COMMENT ON COLUMN v3.condition_schedules.label IS
  '明細行の名前。「2026年4月分」「第1回 着手金」など。空なら期日から表示を作る。';


-- ---------------------------------------------------------------------
-- A-003 案件に「進め方」を持たせる
--
--   取引モデル（ライセンス／業務委託／文書作成）だけでは、実際に何をする
--   のかが決まらない。相手方の文書をレビューするのか、自社で一から書くの
--   か、ひな形から起こすのかで、最初にやることも要る材料も違う。
--
--     counterparty_review … 他社文書レビュー型（相手方の文書を受け取る）
--     own_draft           … 自社ドラフト型（一から書く）
--     own_template        … 自社テンプレートドラフト型（ひな形から起こす）
--
--   既存の案件は空のまま。決まっていないものを勝手に決めない。
-- ---------------------------------------------------------------------
ALTER TABLE v3.matters ADD COLUMN IF NOT EXISTS document_style text;

DO $amend_doc_style$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'v3.matters'::regclass
       AND conname = 'matters_document_style_check'
  ) THEN
    ALTER TABLE v3.matters ADD CONSTRAINT matters_document_style_check
      CHECK (document_style IS NULL OR document_style IN
             ('counterparty_review', 'own_draft', 'own_template'));
    RAISE NOTICE 'A-003: matters.document_style を足した';
  ELSE
    RAISE NOTICE 'A-003: 適用済み';
  END IF;
END
$amend_doc_style$;

COMMENT ON COLUMN v3.matters.document_style IS
  '進め方。counterparty_review=他社文書レビュー / own_draft=自社ドラフト / own_template=自社テンプレート。';


-- ---------------------------------------------------------------------
-- A-004: 契約変更の「いつから適用か」
--
-- 改訂すると旧版がその瞬間に死んで新版が生きる作りだったので、
-- 「2027-04-01 から料率が変わる」を記録できなかった。回避策は
-- 「その日まで改訂しないで覚えておく」しか無く、記録システムとして敗けている。
--
-- 契約期間（term_start / term_end）とは別の列にする。旧版の term_end を
-- 切ると、契約は 2029 年まで続くのに満了アラートが 2027 年に鳴り、
-- 権利包絡チェックも「許諾は 2027 年まで」と誤認する。
--
-- 未来の改訂は status='scheduled' で置く。active のまま2行あると、
-- conditions を status='active' で絞っている8箇所が同じ条件を二重に数える。
-- scheduled ならその8箇所を1行も触らずに済む。
-- ---------------------------------------------------------------------

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS series_id bigint;

COMMENT ON COLUMN v3.conditions.effective_from IS
  'この版が適用され始める日。契約期間（term_start）とは別。適用終了日は持たない（系列の次版の前日として導ける）。';
COMMENT ON COLUMN v3.conditions.series_id IS
  '改訂の系列。初版の id を全版が持つ。AGの消化累計も予定明細もこの単位で数える。';

-- status に 'scheduled' を足す。列内 CHECK は自動命名なので、名前を引いて張り替える。
DO $amend_cond_status$
DECLARE
  old_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'v3.conditions'::regclass
                AND conname = 'conditions_status_chk') THEN
    RAISE NOTICE 'A-004: status の CHECK は適用済み';
  ELSE
    -- 先に新しい制約を張ってから古いものを外す。順番を逆にすると、
    -- その一瞬だけ status が無防備になる。
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_status_chk
      CHECK (status IN ('draft', 'active', 'scheduled', 'superseded', 'void'));

    SELECT c.conname INTO old_name
      FROM pg_constraint c
     WHERE c.conrelid = 'v3.conditions'::regclass
       AND c.contype = 'c'
       AND c.conname <> 'conditions_status_chk'
       AND pg_get_constraintdef(c.oid) LIKE '%status%'
       AND pg_get_constraintdef(c.oid) LIKE '%superseded%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%superseded_by_id%'
     LIMIT 1;
    IF old_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE v3.conditions DROP CONSTRAINT %I', old_name);
      RAISE NOTICE 'A-004: status の CHECK を張り替えた（旧 %）', old_name;
    ELSE
      RAISE NOTICE 'A-004: status の新しい CHECK を足した（旧制約は見つからず）';
    END IF;
  END IF;
END
$amend_cond_status$;

-- 予定の版は適用日が無いと意味を成さない。
DO $amend_cond_sched$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass
                    AND conname = 'conditions_scheduled_needs_date_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_scheduled_needs_date_chk
      CHECK (status <> 'scheduled' OR effective_from IS NOT NULL);
    RAISE NOTICE 'A-004: 予定の版に適用日を必須にした';
  END IF;
END
$amend_cond_sched$;

-- 既存行の埋め戻し。適用開始日は契約の開始日と同じとみなす。
UPDATE v3.conditions SET effective_from = term_start
 WHERE effective_from IS NULL AND term_start IS NOT NULL;

-- 系列。誰からも superseded_by_id で指されていない行が初版で、そこから前へ辿る。
WITH RECURSIVE chain(id, series_id) AS (
  SELECT c.id, c.id
    FROM v3.conditions c
   WHERE NOT EXISTS (SELECT 1 FROM v3.conditions p WHERE p.superseded_by_id = c.id)
  UNION ALL
  SELECT c.superseded_by_id, ch.series_id
    FROM v3.conditions c
    JOIN chain ch ON c.id = ch.id
   WHERE c.superseded_by_id IS NOT NULL
)
UPDATE v3.conditions t SET series_id = ch.series_id
  FROM chain ch
 WHERE t.id = ch.id AND t.series_id IS DISTINCT FROM ch.series_id;

-- 以後に入る行にも必ず系列を持たせる。アプリだけでなく移行スクリプトや
-- 手で入れた行にも効かせたいので、書き手ごとの取りこぼしが無いトリガにする。
CREATE OR REPLACE FUNCTION v3.set_condition_series() RETURNS trigger
LANGUAGE plpgsql AS $set_series$
BEGIN
  IF NEW.series_id IS NULL THEN NEW.series_id := NEW.id; END IF;
  RETURN NEW;
END
$set_series$;

DROP TRIGGER IF EXISTS conditions_series_bi ON v3.conditions;
CREATE TRIGGER conditions_series_bi BEFORE INSERT ON v3.conditions
  FOR EACH ROW EXECUTE FUNCTION v3.set_condition_series();

CREATE INDEX IF NOT EXISTS conditions_series_idx
  ON v3.conditions (series_id, effective_from);


COMMIT;

-- 確認
\echo '--- matter_links.target_type ---'
SELECT pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.conrelid = 'v3.matter_links'::regclass AND c.contype = 'c';

\echo '--- condition_schedules の列 ---'
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'condition_schedules'
 ORDER BY ordinal_position;

\echo '--- matters.document_style ---'
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='matters' AND column_name='document_style';

\echo '--- conditions の適用開始日と系列 ---'
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='v3' AND table_name='conditions'
   AND column_name IN ('effective_from', 'series_id')
 ORDER BY column_name;

\echo '--- conditions.status で許す値 ---'
SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
 WHERE conrelid='v3.conditions'::regclass AND conname='conditions_status_chk';

\echo '--- 系列が埋まっていない条件（0 であること） ---'
SELECT count(*) AS series_missing FROM v3.conditions WHERE series_id IS NULL;
