-- =====================================================================
-- 案件の紐づけを改訂前の条件（旧版）から今の版へ移す
--
--   先に 114_matter_links_current_check.sql で対象を見ること。
--   旧版 → 今の版（superseded_by_id の末端）へ付け替える。今の版がすでに
--   紐づいていれば旧版の紐づけを外すだけ。監査（audit_events）に1行残す。
--   何度流しても同じ結果になる（対象が無ければ何もしない）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/115_matter_links_current_apply.sql
-- =====================================================================

BEGIN;

DO $apply$
DECLARE
  moved int := 0;
  dropped int := 0;
BEGIN
  CREATE TEMP TABLE _relink ON COMMIT DROP AS
  WITH RECURSIVE chain AS (
    SELECT c.id AS old_id, c.id AS cur_id, c.superseded_by_id, 0 AS depth
      FROM v3.conditions c
     WHERE c.status = 'superseded' AND c.superseded_by_id IS NOT NULL
    UNION ALL
    SELECT ch.old_id, n.id, n.superseded_by_id, ch.depth + 1
      FROM chain ch JOIN v3.conditions n ON n.id = ch.superseded_by_id
     WHERE ch.depth < 20
  ),
  latest AS (
    SELECT DISTINCT ON (old_id) old_id, cur_id FROM chain WHERE superseded_by_id IS NULL
     ORDER BY old_id, depth DESC
  )
  SELECT ml.matter_id, ml.target_ref AS old_ref, l.cur_id::text AS cur_ref, ml.relation, ml.snapshot
    FROM v3.matter_links ml JOIN latest l ON l.old_id::text = ml.target_ref
   WHERE ml.target_type = 'condition';

  -- 今の版の紐づけを足す（すでにあれば何もしない）
  INSERT INTO v3.matter_links (matter_id, target_type, target_ref, relation, snapshot)
  SELECT matter_id, 'condition', cur_ref, relation, snapshot FROM _relink
  ON CONFLICT (matter_id, target_type, target_ref) DO NOTHING;
  GET DIAGNOSTICS moved = ROW_COUNT;

  -- 旧版の紐づけを外す
  DELETE FROM v3.matter_links ml
   USING _relink r
   WHERE ml.matter_id = r.matter_id AND ml.target_type = 'condition' AND ml.target_ref = r.old_ref;
  GET DIAGNOSTICS dropped = ROW_COUNT;

  IF dropped > 0 THEN
    INSERT INTO v3.audit_events (actor, action, target_type, target_id, idempotency_key, detail)
    SELECT 'legalbridge-v3', 'matter.relink_current', 'matter', matter_id,
           'relink-current:' || matter_id || ':' || old_ref || ':' || cur_ref,
           jsonb_build_object('from', old_ref, 'to', cur_ref, 'reason', '改訂前の条件から今の版へ（115）')
      FROM _relink
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RAISE NOTICE '115: 今の版の紐づけを % 件足し、旧版の紐づけを % 件外した', moved, dropped;
END
$apply$;

COMMIT;

-- 確認：旧版に紐づいている案件が 0 になっていること
WITH RECURSIVE chain AS (
  SELECT c.id AS old_id, c.id AS cur_id, c.superseded_by_id, 0 AS depth
    FROM v3.conditions c
   WHERE c.status = 'superseded' AND c.superseded_by_id IS NOT NULL
  UNION ALL
  SELECT ch.old_id, n.id, n.superseded_by_id, ch.depth + 1
    FROM chain ch JOIN v3.conditions n ON n.id = ch.superseded_by_id
   WHERE ch.depth < 20
)
SELECT count(*) AS 旧版に紐づいている件数
  FROM v3.matter_links ml
  JOIN chain l ON l.superseded_by_id IS NULL AND l.old_id::text = ml.target_ref
 WHERE ml.target_type = 'condition';
