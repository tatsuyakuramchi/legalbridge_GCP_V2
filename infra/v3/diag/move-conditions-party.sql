-- =====================================================================
-- 条件明細を、別の取引先の契約へ移す（取引先ごと付け替える。DO ブロック 1 つ）。
--
--   使う場面：許諾者（取引先）の登録が違っていた条件明細を、本当の許諾者の契約に載せ替える。
--     例）邪神グリード 3 作は DucQrews ではなく著作者本人が許諾者 → 本人の基本契約へ
--
--   直すこと
--     1. 条件明細（conds= に並べたいまの版）の取引先を、移し先の契約（to=）の取引先に変え、その契約に載せる
--        受取人（target_party_id）がもとの取引先なら、それも移し先の取引先に変える
--     2. もとの個別契約に条件が 1 本も残らなければ知らせる。end=日付 を渡せば、その日で終了（解除済み）にする
--   変えないこと：条件の中身（料率・期間・按分）、旧版の条件、文書（旧条件書）とのつながり、文書の番号
--   止めるとき：実績・支払の割り当てがある条件（取引先が変わると支払先が変わるため）／向きが違う／
--               移し先が条件を持てない契約（解除合意・文書だけ）
--
--   ★ 使い方（予備系。infra\local で。ファイルは書き換えない）
--       お試し： docker compose run --rm ops sql /v3/diag/move-conditions-party.sql conds=CL-2026-00702,CL-2026-00703-R2 to=ARC-LIC-2026-0001
--       書き込む：… 同じ引数 … write=1
--       もとの個別契約を終了にする：… end=2026-12-01 を足す
-- =====================================================================

\if :{?conds}
\else
  \echo '条件番号を conds=… で渡してください（カンマ区切り。例: conds=CL-2026-00702,CL-2026-00703-R2）'
  \quit
\endif
\if :{?to}
\else
  \echo '移し先の契約番号を to=… で渡してください（例: to=ARC-LIC-2026-0001）'
  \quit
\endif
\if :{?end}
\else
  \set end ''
\endif
\if :{?write}
\else
  \set write 0
\endif
SELECT set_config('fix.conds', :'conds', false) AS 条件, set_config('fix.to', :'to', false) AS 移し先,
       set_config('fix.end', :'end', false) AS 終了日, set_config('fix.write', :'write', false) AS 書き込む;

DO $fix$
DECLARE
  dry     boolean := current_setting('fix.write') NOT IN ('1', 'true', 'yes');
  v_nos   text[] := (SELECT array_agg(btrim(x)) FROM unnest(string_to_array(current_setting('fix.conds'), ',')) x WHERE btrim(x) <> '');
  v_to    text := btrim(current_setting('fix.to'));
  v_end   text := btrim(current_setting('fix.end'));
  plan    text[] := '{}';
  t       record;
  c       record;
  s       record;
  v_no    text;
  v_n     int;
  v_from  bigint[] := '{}';
BEGIN
  SELECT a.id, a.agreement_no, COALESCE(a.kind, 'master') AS kind, a.direction, a.counterparty_id, p.name AS party
    INTO t FROM v3.agreements a JOIN v3.parties p ON p.id = a.counterparty_id WHERE a.agreement_no = v_to;
  IF t.id IS NULL THEN RAISE EXCEPTION '移し先の契約 % が見つかりません', v_to; END IF;
  IF t.kind NOT IN ('master', 'standalone', 'supplement') THEN
    RAISE EXCEPTION '移し先 % は条件明細を持てない契約です（%）', v_to, t.kind;
  END IF;
  plan := plan || format('移し先：%s（%s・%s）', t.agreement_no, t.party, t.kind);
  IF t.kind = 'master' THEN
    plan := plan || '  基本契約に直に載せます。作品ごとに番号の条件書を決定すると、作品ごとの個別契約が立ちます'::text;
  END IF;

  FOREACH v_no IN ARRAY v_nos LOOP
    SELECT x.id, x.condition_no, x.name, x.status, x.direction, x.counterparty_id, x.agreement_id, x.target_party_id,
           p.name AS party, a.agreement_no AS now_no
      INTO c FROM v3.conditions x
      JOIN v3.parties p ON p.id = x.counterparty_id
      LEFT JOIN v3.agreements a ON a.id = x.agreement_id
     WHERE x.condition_no = v_no;
    IF c.id IS NULL THEN RAISE EXCEPTION '条件 % が見つかりません', v_no; END IF;
    IF c.status IN ('superseded', 'void') THEN
      RAISE EXCEPTION '条件 % は %（いまの版ではありません）。いまの版の番号を渡してください', v_no, c.status;
    END IF;
    IF c.direction IS DISTINCT FROM t.direction THEN
      RAISE EXCEPTION '条件 % の向き（%）が移し先の契約（%）と違います', v_no, c.direction, t.direction;
    END IF;
    SELECT count(*) INTO v_n FROM v3.condition_events e
     WHERE e.condition_id IN (SELECT y.id FROM v3.conditions y WHERE COALESCE(y.series_id, y.id) =
                               (SELECT COALESCE(z.series_id, z.id) FROM v3.conditions z WHERE z.id = c.id))
       AND e.status <> 'void';
    IF v_n > 0 THEN RAISE EXCEPTION '条件 % には実績が % 件あります。取引先を変えると支払先が変わるので止めました', v_no, v_n; END IF;
    SELECT count(*) INTO v_n FROM v3.payment_allocations pa WHERE pa.condition_id = c.id;
    IF v_n > 0 THEN RAISE EXCEPTION '条件 % には支払の割り当てが % 件あります。止めました', v_no, v_n; END IF;

    plan := plan || format('%s %s：%s／%s → %s／%s', c.condition_no, c.name, c.party, COALESCE(c.now_no, '（契約なし）'), t.party, t.agreement_no);
    -- 按分：新しい取引先の取り分（条件書の備考の「取り分」になる）
    SELECT string_agg(p.name || ' ' || rtrim(rtrim((s2.share_ppm / 10000.0)::numeric(9,4)::text, '0'), '.') || '%', '／' ORDER BY s2.sort_order) AS txt,
           bool_or(s2.party_id = t.counterparty_id) AS has_new, count(*) AS n
      INTO s FROM v3.condition_shares s2 JOIN v3.parties p ON p.id = s2.party_id WHERE s2.condition_id = c.id;
    IF s.n > 0 THEN
      plan := plan || format('    按分：%s%s', s.txt, CASE WHEN s.has_new THEN '' ELSE '（※ 新しい取引先がいません。取り分 0% で出ます）' END);
    END IF;

    IF c.agreement_id IS NOT NULL AND NOT (c.agreement_id = ANY (v_from)) THEN v_from := v_from || c.agreement_id; END IF;
    UPDATE v3.conditions
       SET counterparty_id = t.counterparty_id, agreement_id = t.id,
           target_party_id = CASE WHEN target_party_id = c.counterparty_id THEN t.counterparty_id ELSE target_party_id END,
           updated_at = now()
     WHERE id = c.id;
    IF c.target_party_id = c.counterparty_id THEN plan := plan || '    受取人も移し先の取引先に変えます'::text; END IF;
  END LOOP;

  -- もとの個別契約が空になったか
  FOR s IN SELECT a.id, a.agreement_no, COALESCE(a.kind, 'master') AS kind,
                  (SELECT count(*) FROM v3.conditions x WHERE x.agreement_id = a.id) AS n
             FROM v3.agreements a WHERE a.id = ANY (v_from) ORDER BY a.agreement_no LOOP
    IF s.n > 0 THEN
      plan := plan || format('もとの契約 %s：条件 %s 本が残ります', s.agreement_no, s.n);
    ELSIF v_end <> '' AND s.kind = 'supplement' THEN
      UPDATE v3.agreements SET terminated_on = v_end::date, status = 'terminated', updated_at = now() WHERE id = s.id;
      plan := plan || format('もとの個別契約 %s：条件が無くなるので %s で終了にします（文書は残ります）', s.agreement_no, v_end);
    ELSE
      plan := plan || format('もとの契約 %s：条件が無くなります（end=日付 を渡すと終了にします。文書は残ります）', s.agreement_no);
    END IF;
  END LOOP;

  IF NOT dry THEN
    INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
    VALUES ('sql:move-conditions-party', 'condition.move_party', 'agreement', t.id, jsonb_build_object('plan', to_jsonb(plan)));
  END IF;
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（write=1 を付けると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE WARNING E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
