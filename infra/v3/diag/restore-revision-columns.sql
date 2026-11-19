-- =====================================================================
-- 条件明細の改訂版（-R2 …）で落ちた「算定の基礎」「共著の分配のしかた」を戻す（お試しが既定）。
--
--   何が起きていたか：
--     条件明細を改訂する（実績・支払がある条件を直す、先の日付で予約する、契約期間を延ばす）と、新しい版は
--     「写す列の一覧」の列だけで作られる。その一覧に price_basis（算定の基礎）と distribution（分配のしかた）が
--     入っていなかったので、
--       ・改訂のたびに、算定の基礎が「未設定」に戻っていた
--       ・改訂になった編集で算定の基礎を選んでも、選んだ値が保存されなかった
--     （条件書V5 で「算定の基礎が未設定です」と出続ける原因。アプリは直した。これは、もう落ちた分の手当て）
--
--   直すこと（改訂版ごとに、空になっている列だけ）：
--     算定の基礎 … ① その改訂を作った編集で選んでいた値（操作の記録 audit_events に残っている）
--                   ② ①が無ければ、前の版の値
--     分配のしかた … 前の版の値
--     版を古い順に直すので、-R2 → -R3 と続く系列でも、いちばん古い版の値が最後の版まで届く。
--   変えないこと：値が入っている列、料率・期間などほかの列、実績・支払・文書。
--     編集で「空にする」を選んだ記録がある改訂版は、空のままにする。
--
--   直らないもの：前の版も未設定で、編集で選んだ記録も無いもの。最後に一覧で出すので、条件明細で選ぶ。
--
--   ★ 使い方（予備系。infra\local で。ファイルは書き換えない）
--       お試し： docker compose run --rm ops sql /v3/diag/restore-revision-columns.sql
--       書き込む：docker compose run --rm ops sql /v3/diag/restore-revision-columns.sql write=1
--     何度流しても同じ（2 回目以降は 0 件）。
-- =====================================================================

\pset pager off
\if :{?write}
\else
  \set write 0
\endif
SELECT set_config('fix.write', :'write', false) AS 書き込む;

DO $fix$
DECLARE
  dry    boolean := current_setting('fix.write') NOT IN ('1', 'true', 'yes');
  r      record;
  ev     record;
  prev   record;
  basis  text;
  dist   text;
  src    text;
  plan   text[] := '{}';
  n      int := 0;
  label  CONSTANT jsonb := '{"list": "配信価格・上代", "receipts": "受領額", "supply": "卸価格"}'::jsonb;
BEGIN
  FOR r IN
    SELECT c.id, c.condition_no, c.name, c.status, c.series_id, c.price_basis, c.distribution
      FROM v3.conditions c
     WHERE c.series_id IS NOT NULL AND c.id <> c.series_id
       AND (c.price_basis IS NULL OR c.distribution IS NULL)
     ORDER BY c.id
  LOOP
    -- この版を作った編集（改訂・予約）。いちばん新しい記録。
    SELECT a.target_id, a.detail INTO ev
      FROM v3.audit_events a
     WHERE a.target_type = 'condition' AND a.action IN ('condition.revise', 'condition.schedule_revision')
       AND a.detail ->> 'revisedTo' = r.id::text
     ORDER BY a.id DESC LIMIT 1;
    -- 前の版：編集の記録の対象。記録が無ければ、同じ系列でこの版のすぐ前。
    SELECT p.id, p.condition_no, p.price_basis, p.distribution INTO prev
      FROM v3.conditions p
     WHERE p.id = COALESCE(ev.target_id,
             (SELECT max(x.id) FROM v3.conditions x WHERE COALESCE(x.series_id, x.id) = r.series_id AND x.id < r.id));

    basis := NULL; dist := NULL; src := '';
    IF r.price_basis IS NULL THEN
      IF ev.detail IS NOT NULL AND (ev.detail -> 'patch') ? 'priceBasis' THEN
        -- 編集で選んでいた値。空にする（null）を選んでいたなら、空のまま。
        basis := NULLIF(ev.detail -> 'patch' ->> 'priceBasis', '');
        src := '編集で選んだ値';
      ELSE
        basis := prev.price_basis;
        src := '前の版 ' || COALESCE(prev.condition_no, '#' || prev.id::text);
      END IF;
      IF basis IS NOT NULL AND basis NOT IN ('list', 'receipts', 'supply') THEN basis := NULL; END IF;
    END IF;
    IF r.distribution IS NULL THEN dist := prev.distribution; END IF;
    CONTINUE WHEN basis IS NULL AND dist IS NULL;

    UPDATE v3.conditions
       SET price_basis = COALESCE(price_basis, basis), distribution = COALESCE(distribution, dist), updated_at = now()
     WHERE id = r.id;
    n := n + 1;
    plan := plan || format('%s（%s・%s）%s%s',
      COALESCE(r.condition_no, '#' || r.id::text), left(r.name, 30), r.status,
      CASE WHEN basis IS NOT NULL THEN format('　算定の基礎 → %s（%s）', COALESCE(label ->> basis, basis), src) ELSE '' END,
      CASE WHEN dist IS NOT NULL THEN format('　分配のしかた → %s（前の版）', CASE dist WHEN 'representative' THEN '代表がまとめて受け取る' ELSE '各自に直接払う' END) ELSE '' END);
    IF NOT dry THEN
      INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
      VALUES ('sql:restore-revision-columns', 'condition.restore_columns', 'condition', r.id,
              jsonb_build_object('priceBasis', basis, 'distribution', dist, 'source', src));
    END IF;
  END LOOP;

  IF n = 0 THEN
    RAISE WARNING '戻すものはありません（改訂版で、算定の基礎・分配のしかたが落ちているものは 0 件）';
    RETURN;
  END IF;
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = format(E'お試し：書き込みは取り消しました（write=1 を付けると書き込みます）。戻す改訂版 %s 件\n', n)
      || array_to_string(plan, E'\n');
  END IF;
  RAISE WARNING E'書き込みました。戻した改訂版 % 件\n%', n, array_to_string(plan, E'\n');
END
$fix$;

\echo
\echo '直らないもの：電子（出版）で、算定の基礎が未設定のままの条件明細（有効・予定）。条件明細の編集で選ぶ'
\echo '（お試しのときは、上の「戻す」分も未設定としてここに並びます）'
SELECT c.condition_no AS 条件番号, left(c.name, 36) AS 条件名, c.status AS 状態,
       (c.rate_ppm / 10000.0)::numeric(7,4) AS 料率, p.name AS 相手先
  FROM v3.conditions c
  JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE c.kind = 'license' AND c.direction = 'in' AND c.usage_type = 'pub_digital'
   AND c.status IN ('active', 'scheduled')
   AND c.price_basis IS NULL
   AND COALESCE(c.license_fee_basis, 'separate') <> 'in_lieu'
 ORDER BY p.name, c.condition_no;
