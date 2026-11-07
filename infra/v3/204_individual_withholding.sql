-- =====================================================================
-- 204_individual_withholding.sql（Cloud SQL Studio 用。DO ブロック 1 つ）
--
--   取引先のうち個人（kind = 'individual'）を、まとめて源泉徴収の対象（withholding = true）にする。
--
--   対象: v3.parties で kind = 'individual' かつ withholding = false の行。
--         統合済み（status = 'merged'）は別の取引先に付け替え済みなので触らない。
--         archived は、戻したときに印が違わないよう一緒に直す。
--         非居住者（residency = 'non_resident'）も個人なので直す。税率は従来どおり
--         支払の計算側（国内法 20.42% / 租税条約）で決まる。件数は NOTICE に出すので、
--         外したい取引先があれば流したあとに画面で個別に外す。
--   法人（kind = 'corporate'）は触らない。
--
--   あわせて v3.audit_events に party.update（actor = 'sql:204'）を 1 件ずつ残す。
--   画面からの修正と同じ形（fields に withholding）。戻すときの目印にもなる。
--
--   ★ 使い方：そのまま流す（お試し。対象の一覧と件数だけ出る）→ 確かめる
--     → dry := false にして流す。何度流しても同じ結果（直し終わった行は対象に入らない）。
--   実行: docker compose run --rm ops sql /v3/204_individual_withholding.sql
--         （本番は Cloud SQL Studio に全文を貼る）
--   戻すとき: 204_individual_withholding_rollback.sql（この SQL で true にした行だけ false に戻す）
-- =====================================================================

DO $fix$
DECLARE
  dry        boolean := true;                       -- ★ false にすると書き込む
  r          record;
  n_target   int := 0;
  n_nonres   int := 0;
  n_archived int := 0;
  n_done     int := 0;
BEGIN
  -- 0. 対象の一覧 ------------------------------------------------------------------------
  FOR r IN
    SELECT id, party_code, name, status, residency
      FROM v3.parties
     WHERE kind = 'individual'
       AND withholding = false
       AND status <> 'merged'
     ORDER BY id
  LOOP
    n_target := n_target + 1;
    IF r.residency = 'non_resident' THEN n_nonres := n_nonres + 1; END IF;
    IF r.status = 'archived' THEN n_archived := n_archived + 1; END IF;
    RAISE NOTICE '対象 id=% code=% name=% status=% residency=%',
      r.id, COALESCE(r.party_code, '-'), r.name, r.status, COALESCE(r.residency, 'resident');
  END LOOP;

  RAISE NOTICE '個人で源泉の印が付いていない取引先: % 件（うち非居住者 % 件、archived % 件）',
    n_target, n_nonres, n_archived;

  IF n_target = 0 THEN
    RAISE NOTICE '直す行はありません。';
    RETURN;
  END IF;

  IF dry THEN
    RAISE NOTICE 'お試しなので何も変えていません。書き込むには dry := false にして流し直す。';
    RETURN;
  END IF;

  -- 1. 直す（監査記録を先に、同じトランザクションで） -------------------------------------
  INSERT INTO v3.audit_events (actor, action, target_type, target_id, idempotency_key, detail)
  SELECT 'sql:204', 'party.update', 'party', p.id,
         'sql:204:party:' || p.id,
         jsonb_build_object('fields', jsonb_build_array('withholding'),
                            'name', p.name,
                            'was', p.name,
                            'withholdingWas', false,
                            'reason', '個人の取引先を一括で源泉徴収の対象にした（204）')
    FROM v3.parties p
   WHERE p.kind = 'individual'
     AND p.withholding = false
     AND p.status <> 'merged'
  ON CONFLICT (idempotency_key) DO NOTHING;

  UPDATE v3.parties
     SET withholding = true,
         updated_at  = now()
   WHERE kind = 'individual'
     AND withholding = false
     AND status <> 'merged';
  GET DIAGNOSTICS n_done = ROW_COUNT;

  RAISE NOTICE '% 件を源泉徴収の対象にしました。', n_done;
END
$fix$;

-- 確認：個人（統合済みを除く）で源泉の印が付いていない行が残っていないこと（本番反映後は 0 行）
SELECT id, party_code AS コード, name AS 名前, status, residency
  FROM v3.parties
 WHERE kind = 'individual'
   AND withholding = false
   AND status <> 'merged'
 ORDER BY id;

-- 確認：個人の印の内訳
SELECT withholding AS 源泉対象, status, count(*) AS 件数
  FROM v3.parties
 WHERE kind = 'individual'
 GROUP BY 1, 2
 ORDER BY 1, 2;
