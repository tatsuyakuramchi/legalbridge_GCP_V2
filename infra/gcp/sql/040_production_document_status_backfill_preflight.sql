\set ON_ERROR_STOP on
\pset pager off

-- 040_production_document_status_backfill_preflight.sql
-- 読取専用の事前確認（本番）。変更なし（適用は 040_production_document_status_backfill.sql）。
-- 監査 P0-3：V2 作成文書は contract_status が NULL のままで、CloudSign executed 遷移・満了ジョブ・
-- V1 の契約チェック表示のいずれからも見えない。バックフィル対象を确認する。
--   V2 作成文書の判定 = template_version_id IS NOT NULL（V1 は 0002 で列だけ追加しコードは一切書かない）。

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
END
$guard$;

-- バックフィル対象（V2 作成・contract_status NULL・現行版のみ）の件数を種別ごとに確認。
SELECT template_type, count(*) AS backfill_targets
FROM public.documents
WHERE contract_status IS NULL
  AND template_version_id IS NOT NULL
  AND COALESCE(lifecycle_status, 'final') NOT IN ('voided', 'reissued', 'superseded')
GROUP BY template_type
ORDER BY backfill_targets DESC;

-- サンプル（最新10件）。
SELECT id, document_number, template_type, created_at, created_by
FROM public.documents
WHERE contract_status IS NULL
  AND template_version_id IS NOT NULL
  AND COALESCE(lifecycle_status, 'final') NOT IN ('voided', 'reissued', 'superseded')
ORDER BY created_at DESC NULLS LAST
LIMIT 10;

-- 参考：V1 作成で contract_status NULL の行（対象外。V1 も workflow 文書は NULL を許容している）。
SELECT count(*) AS v1_null_rows_untouched
FROM public.documents
WHERE contract_status IS NULL AND template_version_id IS NULL;
