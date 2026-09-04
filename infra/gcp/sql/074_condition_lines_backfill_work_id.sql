\set ON_ERROR_STOP on
\pset pager off

-- 074_condition_lines_backfill_work_id.sql
-- 条件明細の作品紐づけ（work_id）と向きフラグの一括補正（2026-09-03 棚卸し結果）。
--   文書確定・取込詳細編集・再発行・手動同期（条件同期）は従来 work_id を書かず
--   source_work_id / source_material_id だけを書いていた。作品詳細・ライセンスマトリクス・
--   作品一括編集はすべて cl.work_id で絞るため、これらの経路で入れた条件が作品側に出なかった。
--   アプリ側は同日の修正で work_id / flow_direction / is_inbound を書くようになった。
--   本SQLは既存行を同じ規則で補正する:
--     work_id = 文書の作品（documents.form_data.work_code → works.work_code）
--             ＞ 素材の作品（source_material_id → work_materials.work_id）
--             ＞ source_work_id
--     flow_direction: NULL のものだけ direction から（receivable→out / それ以外→in）
--   契約取込・アウト条件で入れた行（work_id あり）は触らない。冪等。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_backfill=BACKFILL_CONDITION_WORK_ID \
--         -f infra/gcp/sql/074_condition_lines_backfill_work_id.sql

\if :{?confirm_backfill}
\else
  \echo 'Run with: -v confirm_backfill=BACKFILL_CONDITION_WORK_ID'
  \quit 2
\endif
SELECT :'confirm_backfill' = 'BACKFILL_CONDITION_WORK_ID' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 適用前: work_id が無い行の件数
SELECT count(*) AS lines_without_work_before FROM condition_lines WHERE work_id IS NULL;

-- 1) 文書の作品（form_data.work_code）から
UPDATE condition_lines cl
   SET work_id = w.id, updated_at = now()
  FROM documents d
  JOIN works w ON w.work_code = d.form_data->>'work_code'
 WHERE cl.document_id = d.id AND cl.work_id IS NULL
   AND COALESCE(d.form_data->>'work_code', '') <> '';

-- 2) 素材の作品から
UPDATE condition_lines cl
   SET work_id = wm.work_id, updated_at = now()
  FROM work_materials wm
 WHERE cl.source_material_id = wm.id AND cl.work_id IS NULL;

-- 3) source_work_id から
UPDATE condition_lines cl
   SET work_id = cl.source_work_id, updated_at = now()
 WHERE cl.work_id IS NULL AND cl.source_work_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM works w WHERE w.id = cl.source_work_id);

-- 4) 向きフラグの補完（NULL のみ）
UPDATE condition_lines
   SET flow_direction = CASE WHEN direction = 'receivable' THEN 'out' ELSE 'in' END,
       updated_at = now()
 WHERE flow_direction IS NULL AND direction IS NOT NULL;

-- 適用後: 残った work_id 無し（文書にも素材にも作品紐づけが無い行＝手動紐づけ対象）
SELECT count(*) AS lines_without_work_after FROM condition_lines WHERE work_id IS NULL;
SELECT cl.id, cl.condition_name, d.document_number
  FROM condition_lines cl LEFT JOIN documents d ON d.id = cl.document_id
 WHERE cl.work_id IS NULL
 ORDER BY cl.id DESC LIMIT 50;

COMMIT;
