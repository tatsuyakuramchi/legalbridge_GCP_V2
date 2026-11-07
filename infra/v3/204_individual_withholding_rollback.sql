-- =====================================================================
-- 204_individual_withholding_rollback.sql（Cloud SQL Studio 用）
--
--   204 を戻す。204 が true にした行（audit_events に actor = 'sql:204' の記録がある取引先）だけ
--   withholding = false に戻す。204 のあとに画面で付けた印には触らない。
--   戻したことも audit_events に残す（actor = 'sql:204-rollback'）。何度流しても同じ結果。
-- =====================================================================

DO $undo$
DECLARE
  n int := 0;
BEGIN
  INSERT INTO v3.audit_events (actor, action, target_type, target_id, idempotency_key, detail)
  SELECT 'sql:204-rollback', 'party.update', 'party', p.id,
         'sql:204-rollback:party:' || p.id,
         jsonb_build_object('fields', jsonb_build_array('withholding'),
                            'name', p.name, 'was', p.name,
                            'withholdingWas', true,
                            'reason', '204 で付けた源泉徴収の印を戻した')
    FROM v3.parties p
   WHERE p.withholding = true
     AND EXISTS (SELECT 1 FROM v3.audit_events a
                  WHERE a.actor = 'sql:204' AND a.target_type = 'party' AND a.target_id = p.id)
  ON CONFLICT (idempotency_key) DO NOTHING;

  UPDATE v3.parties p
     SET withholding = false,
         updated_at  = now()
   WHERE p.withholding = true
     AND EXISTS (SELECT 1 FROM v3.audit_events a
                  WHERE a.actor = 'sql:204' AND a.target_type = 'party' AND a.target_id = p.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '% 件の源泉徴収の印を戻しました。', n;
END
$undo$;
