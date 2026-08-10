\set ON_ERROR_STOP on
\pset pager off

-- 040_production_document_status_backfill.sql
-- 監査 P0-3 のデータ是正：V2 が過去に作成した documents 行へ contract_status='executed' を刻む。
--   対象 = contract_status IS NULL かつ template_version_id IS NOT NULL（V2 作成の確定判定・
--          V1 はこの列を書かない）かつ 現行版（voided/reissued/superseded を除く）。
--   V1 作成の NULL 行（workflow 文書等）は V1 自身も NULL 運用のため触らない。
--   旧版（reissued/superseded）も状態機械の対象外のため触らない。
-- コード側は同スライスで finalize/reissue が 'executed' を刻むようになっており、本ファイルは
-- それ以前に作られた行の一回限りの是正。再実行しても対象 0 件（冪等）。

\if :{?confirm_document_backfill}
\else
  \echo 'Missing confirmation variable.'
  \echo 'Run with: -v confirm_document_backfill=BACKFILL_PRODUCTION_DOCUMENT_STATUS'
  \quit 2
\endif

SELECT :'confirm_document_backfill' = 'BACKFILL_PRODUCTION_DOCUMENT_STATUS' AS confirmed
\gset

\if :confirmed
\else
  \echo 'Confirmation value is invalid; no changes were made.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF to_regclass('public.documents') IS NULL THEN
    RAISE EXCEPTION 'Required relation public.documents is missing';
  END IF;
END
$guard$;

UPDATE public.documents
   SET contract_status = 'executed'
 WHERE contract_status IS NULL
   AND template_version_id IS NOT NULL
   AND COALESCE(lifecycle_status, 'final') NOT IN ('voided', 'reissued', 'superseded');

-- 適用結果の確認（残対象は 0 件のはず）。
SELECT count(*) AS remaining_null_v2_docs
FROM public.documents
WHERE contract_status IS NULL
  AND template_version_id IS NOT NULL
  AND COALESCE(lifecycle_status, 'final') NOT IN ('voided', 'reissued', 'superseded');

COMMIT;
