-- =====================================================================
-- 156_party_resolved_view.sql（ops sql / Cloud SQL Studio・psql 用）
--
--   本番に v3.v_party_resolved（取引先の統合を辿るビュー）が無く、契約の画面が
--   「対象のテーブルがまだ作られていません」で開けなかったのを直す。
--   契約の一覧・候補、受付、監視、横断検索がこのビューを読む。
--
--   定義は infra/v3/002_views.sql と同じ。取引先の表（v3.parties）を読むだけで、
--   データは書き換えない。何度流しても同じ（CREATE OR REPLACE）。
--
--   実行: psql "host=127.0.0.1 port=5432 dbname=legalbridge user=postgres" -f infra/v3/156_party_resolved_view.sql
-- =====================================================================

\pset pager off
\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE VIEW v3.v_party_resolved AS
WITH RECURSIVE chain(id, resolved_id, depth) AS (
  SELECT p.id, COALESCE(p.merged_into_id, p.id), 0 FROM v3.parties p
  UNION ALL
  SELECT c.id, COALESCE(p.merged_into_id, p.id), c.depth + 1
    FROM chain c
    JOIN v3.parties p ON p.id = c.resolved_id
   WHERE p.merged_into_id IS NOT NULL AND c.depth < 10
)
SELECT
  src.id                       AS party_id,
  src.name                     AS original_name,
  src.status                   AS original_status,
  dst.id                       AS resolved_id,
  dst.name                     AS resolved_name,
  dst.kind                     AS resolved_kind,
  dst.withholding              AS resolved_withholding,
  dst.invoice_no               AS resolved_invoice_no,
  (src.id <> dst.id)           AS was_merged
FROM v3.parties src
JOIN LATERAL (
  SELECT resolved_id FROM chain WHERE chain.id = src.id ORDER BY depth DESC LIMIT 1
) last ON true
JOIN v3.parties dst ON dst.id = last.resolved_id;

COMMENT ON VIEW v3.v_party_resolved IS
  '統合を辿った後の取引先。参照は付け替えないので、表示・集計はここを通す。';

-- アプリの接続ユーザーが読めるようにする。
GRANT SELECT ON v3.v_party_resolved TO legalbridge_v3_runtime;

COMMIT;

-- 確認：002_views.sql のビューが揃っているか。空欄（NULL）のものがあれば教えてください。
SELECT v.name AS ビュー, to_regclass('v3.' || v.name) IS NOT NULL AS ある
  FROM (VALUES ('v_party_resolved'), ('v_condition_balance'), ('v_work_rights_envelope'),
               ('v_work_scope_envelope'), ('v_document_display'), ('v_deadlines'),
               ('v_rights_sources')) AS v(name);

-- 確認：アプリの接続ユーザーが読めるか（t なら OK）。
SELECT has_table_privilege('legalbridge_v3_runtime', 'v3.v_party_resolved', 'SELECT') AS アプリから読める,
       (SELECT count(*) FROM v3.v_party_resolved) AS 取引先の数;
