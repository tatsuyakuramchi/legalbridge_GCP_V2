-- =====================================================================
-- 重複して立った契約を 1 本にまとめる（DO ブロック 1 つ。お試しが既定）。
--
--   使う場面：同じ取引の契約が 2 本できてしまったとき。
--     例）条件明細を載せた個別契約（ARC-LIC-2026-9000-S01）があるのに、条件書を決定したら
--         もう 1 本の個別契約（ARC-ILT-2026-9000）が立って、文書だけがそちらに載った。
--     例）巻き直しを試して、要らない新契約（条件も文書も無い基本契約）が残った。
--
--   直すこと（from= の契約を、to= の契約に寄せて、from= を消す）
--     1. from に載っている文書・条件明細・下の契約（覚書など）・案件とのつながり・更新の記録を to へ移す
--     2. from を消す。巻き直しのつながりは繋ぎ直す：
--          旧 ← from ← 新 の途中（from）を消すとき（to なし、または to が「新」）→ 旧 ← 新 に
--          from を置き換えた新契約・from が置き換えた旧契約は、残す契約（to）が引き継ぐ
--        旧契約が from の締結で終了になっていても、終了はそのまま
--     3. keepno=from を渡せば、残る契約（to）の番号を from の番号にする
--        （個別契約の番号は条件書の番号と同じ、という決まりに合わせるとき）
--   to= を渡さなければ、from を消すだけ（載っているものが何も無いときに限る）。
--   変えないこと：文書の番号・中身、条件明細の中身、実績・支払。
--   止めるとき：相手先が違う／発注書の器（発注書として見せている契約）／to が from の下にある／
--               to を渡さないのに from に何か載っている。
--
--   ★ 使い方（予備系。infra\local で。ファイルは書き換えない）
--       お試し： docker compose run --rm ops sql /v3/diag/merge-agreements.sql from=ARC-ILT-2026-9000 to=ARC-LIC-2026-9000-S01
--       番号を条件書に合わせる：… keepno=from を足す
--       書き込む：… 同じ引数 … write=1
--       消すだけ：… merge-agreements.sql from=ARC-SVC-2026-9000 write=1
--         （巻き直しをやり直して鎖の途中に残った、空の契約もこれで抜ける）
-- =====================================================================

\if :{?from}
\else
  \echo '消す側の契約番号を from=… で渡してください（例: from=ARC-ILT-2026-9000 to=ARC-LIC-2026-9000-S01）'
  \quit
\endif
\if :{?to}
\else
  \set to ''
\endif
\if :{?keepno}
\else
  \set keepno 'to'
\endif
\if :{?write}
\else
  \set write 0
\endif
SELECT set_config('fix.from', :'from', false) AS 消す契約, set_config('fix.to', :'to', false) AS 残す契約,
       set_config('fix.keepno', :'keepno', false) AS 残す番号, set_config('fix.write', :'write', false) AS 書き込む;

DO $fix$
DECLARE
  dry      boolean := current_setting('fix.write') NOT IN ('1', 'true', 'yes');
  v_from   text := btrim(current_setting('fix.from'));
  v_to     text := btrim(current_setting('fix.to'));
  v_keep   text := lower(btrim(current_setting('fix.keepno')));
  plan     text[] := '{}';
  f        record;
  t        record;
  v_n      int;
  v_docs   int; v_conds int; v_kids int; v_links int; v_terms int;
  has_rep  boolean;
  v_old    text;
  f_rep    bigint; t_rep bigint;
  v_new_id bigint; v_new text; v_t_new text;
  t_id     bigint;   -- 残す契約（to を渡さなければ NULL。t は未代入のレコードなので直接は読めない）
BEGIN
  SELECT a.id, a.agreement_no, COALESCE(a.kind, 'master') AS kind, a.parent_id, a.counterparty_id, a.direction, a.status,
         a.order_document_id, a.title, r.resolved_id
    INTO f FROM v3.agreements a JOIN v3.v_party_resolved r ON r.party_id = a.counterparty_id WHERE a.agreement_no = v_from;
  IF f.id IS NULL THEN RAISE EXCEPTION '消す契約 % が見つかりません', v_from; END IF;
  IF f.order_document_id IS NOT NULL THEN
    RAISE EXCEPTION '% は発注書の器です（発注書として見せている契約）。発注書は文書の画面で無効にしてください', v_from;
  END IF;
  SELECT count(*) INTO v_docs  FROM v3.documents  WHERE agreement_id = f.id;
  SELECT count(*) INTO v_conds FROM v3.conditions WHERE agreement_id = f.id;
  SELECT count(*) INTO v_kids  FROM v3.agreements WHERE parent_id = f.id;
  SELECT count(*) INTO v_links FROM v3.matter_links WHERE target_type = 'agreement' AND target_ref = f.id::text;
  SELECT count(*) INTO v_terms FROM v3.term_events WHERE target_type = 'agreement' AND target_id = f.id;
  plan := plan || format('消す契約：%s（%s・%s）「%s」　文書 %s・条件 %s・下の契約 %s・案件 %s・更新の記録 %s',
                         f.agreement_no, f.kind, f.status, f.title, v_docs, v_conds, v_kids, v_links, v_terms);

  IF v_to = '' THEN
    IF v_docs + v_conds + v_kids > 0 THEN
      RAISE EXCEPTION '% には文書・条件明細・下の契約が載っています。寄せる先を to=… で渡してください', v_from;
    END IF;
    DELETE FROM v3.matter_links WHERE target_type = 'agreement' AND target_ref = f.id::text;
    DELETE FROM v3.term_events WHERE target_type = 'agreement' AND target_id = f.id;
  ELSE
    SELECT a.id, a.agreement_no, COALESCE(a.kind, 'master') AS kind, a.parent_id, a.counterparty_id, a.direction, a.status,
           a.order_document_id, a.title, r.resolved_id
      INTO t FROM v3.agreements a JOIN v3.v_party_resolved r ON r.party_id = a.counterparty_id WHERE a.agreement_no = v_to;
    IF t.id IS NULL THEN RAISE EXCEPTION '残す契約 % が見つかりません', v_to; END IF;
    t_id := t.id;
    IF t.id = f.id THEN RAISE EXCEPTION 'from と to が同じ契約です'; END IF;
    IF t.resolved_id <> f.resolved_id THEN RAISE EXCEPTION '相手先が違います（% と %）', v_from, v_to; END IF;
    IF t.direction IS DISTINCT FROM f.direction THEN RAISE EXCEPTION '向き（IN／OUT）が違います'; END IF;
    IF t.order_document_id IS NOT NULL THEN RAISE EXCEPTION '% は発注書の器です。寄せる先にできません', v_to; END IF;
    IF t.parent_id = f.id THEN RAISE EXCEPTION '% は % の下の契約です。親を消すことはできません', v_to, v_from; END IF;
    IF v_conds > 0 AND t.kind NOT IN ('master', 'standalone', 'supplement') THEN
      RAISE EXCEPTION '残す契約 % は条件明細を持てません（%）', v_to, t.kind;
    END IF;
    plan := plan || format('残す契約：%s（%s・%s）「%s」', t.agreement_no, t.kind, t.status, t.title);
    IF f.parent_id IS DISTINCT FROM t.parent_id AND f.id IS DISTINCT FROM t.parent_id THEN
      plan := plan || format('  ※ 親の契約が違います（%s の親 #%s／%s の親 #%s）。残す契約の親のままにします',
                             v_from, COALESCE(f.parent_id::text, 'なし'), v_to, COALESCE(t.parent_id::text, 'なし'));
    END IF;

    UPDATE v3.documents SET agreement_id = t.id WHERE agreement_id = f.id;
    IF v_docs > 0 THEN
      plan := plan || format('  文書 %s 枚を %s へ（%s）', v_docs, t.agreement_no,
        (SELECT string_agg(COALESCE(d.document_no, '#' || d.id), '・' ORDER BY d.id) FROM v3.documents d WHERE d.agreement_id = t.id));
    END IF;
    UPDATE v3.conditions SET agreement_id = t.id, updated_at = now() WHERE agreement_id = f.id;
    IF v_conds > 0 THEN plan := plan || format('  条件明細 %s 本を %s へ', v_conds, t.agreement_no); END IF;
    UPDATE v3.agreements SET parent_id = t.id, updated_at = now() WHERE parent_id = f.id AND id <> t.id;
    IF v_kids > 0 THEN plan := plan || format('  下の契約 %s 本の親を %s へ', v_kids, t.agreement_no); END IF;
    -- 案件とのつながり：to に同じ案件があれば重ねない。
    UPDATE v3.matter_links ml SET target_ref = t.id::text
     WHERE ml.target_type = 'agreement' AND ml.target_ref = f.id::text
       AND NOT EXISTS (SELECT 1 FROM v3.matter_links x WHERE x.matter_id = ml.matter_id AND x.target_type = 'agreement' AND x.target_ref = t.id::text);
    DELETE FROM v3.matter_links WHERE target_type = 'agreement' AND target_ref = f.id::text;
    UPDATE v3.term_events SET target_id = t.id WHERE target_type = 'agreement' AND target_id = f.id;
    UPDATE v3.term_events SET ref_agreement_id = t.id WHERE ref_agreement_id = f.id;
  END IF;

  -- 巻き直しのつながり（209）。列の無い環境では何もしない。
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'v3' AND table_name = 'agreements' AND column_name = 'replaces_id') INTO has_rep;
  IF has_rep THEN
    -- from が置き換えた旧契約（f_rep）と、from を置き換えた新契約（v_new）。1 本の旧契約を置き換えられるのは 1 本だけ
    -- （agreements_replaces_uq）なので、先に from のつながりを外してから付け替える。
    EXECUTE 'SELECT a.replaces_id, o.agreement_no FROM v3.agreements a LEFT JOIN v3.agreements o ON o.id = a.replaces_id WHERE a.id = $1'
       INTO f_rep, v_old USING f.id;
    EXECUTE 'SELECT id, agreement_no FROM v3.agreements WHERE replaces_id = $1' INTO v_new_id, v_new USING f.id;
    IF v_to <> '' THEN
      EXECUTE 'SELECT replaces_id FROM v3.agreements WHERE id = $1' INTO t_rep USING t_id;
      EXECUTE 'SELECT agreement_no FROM v3.agreements WHERE replaces_id = $1 AND id <> $2' INTO v_t_new USING t_id, f.id;
    END IF;
    IF f_rep IS NOT NULL THEN EXECUTE 'UPDATE v3.agreements SET replaces_id = NULL WHERE id = $1' USING f.id; END IF;

    IF v_new_id IS NOT NULL AND (v_to = '' OR v_new_id = t_id) THEN
      -- 鎖の途中を抜く：旧 ← from ← 新 を、旧 ← 新 に（from が何も置き換えていなければ、新のつながりは外れる）。
      EXECUTE 'UPDATE v3.agreements SET replaces_id = $2 WHERE id = $1' USING v_new_id, f_rep;
      plan := plan || CASE WHEN f_rep IS NOT NULL
        THEN format('  巻き直しのつながり：%s ← %s ← %s を、%s ← %s に（途中の %s を抜く）', v_old, v_from, v_new, v_old, v_new, v_from)
        ELSE format('  巻き直しのつながり：%s が置き換えていた %s が無くなるので、つながりを外す', v_new, v_from) END;
    ELSIF v_new_id IS NOT NULL THEN
      -- from を置き換えた新契約は、残す契約（to）を置き換えたことにする。
      IF v_t_new IS NOT NULL THEN
        RAISE EXCEPTION '% は % で、% は % で巻き直しています。巻き直しの新契約が 2 本になるので寄せられません（先に新しい側を整理してください）',
                        v_from, v_new, v_to, v_t_new;
      END IF;
      EXECUTE 'UPDATE v3.agreements SET replaces_id = $2 WHERE id = $1' USING v_new_id, t_id;
      plan := plan || format('  巻き直しのつながり：%s が置き換える相手を %s → %s に', v_new, v_from, t.agreement_no);
    END IF;

    IF f_rep IS NOT NULL AND v_to <> '' AND f_rep <> t_id AND (v_new_id IS NULL OR v_new_id <> t_id) THEN
      -- from が置き換えていた旧契約は、残す契約（to）が引き継ぐ（to が別の契約を置き換えていなければ）。
      IF t_rep IS NULL THEN
        EXECUTE 'UPDATE v3.agreements SET replaces_id = $2 WHERE id = $1' USING t_id, f_rep;
        plan := plan || format('  巻き直しのつながり：%s を置き換えた新契約を %s → %s に', v_old, v_from, t.agreement_no);
      ELSE
        plan := plan || format('  ※ %s は %s を巻き直した契約でした。%s は別の契約を置き換えているので、このつながりは外れます（%s が終了になっていれば、終了はそのまま）',
                               v_from, v_old, t.agreement_no, v_old);
      END IF;
    ELSIF f_rep IS NOT NULL AND v_new_id IS NULL AND v_to = '' THEN
      plan := plan || format('  ※ %s は %s を巻き直した契約です。消すと巻き直しのつながりが外れます（%s が終了になっていれば、終了はそのまま。戻すなら契約の画面で）',
                             v_from, v_old, v_old);
    END IF;
  END IF;

  DELETE FROM v3.agreements WHERE id = f.id;
  plan := plan || format('  %s を消す', f.agreement_no);

  IF v_to <> '' AND v_keep = 'from' THEN
    UPDATE v3.agreements SET agreement_no = f.agreement_no, updated_at = now() WHERE id = t.id;
    plan := plan || format('  残る契約の番号を %s → %s に（条件書の番号に合わせる）', t.agreement_no, f.agreement_no);
  END IF;

  IF NOT dry THEN
    INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
    VALUES ('sql:merge-agreements', 'agreement.merge', 'agreement', COALESCE(t_id, f.id), jsonb_build_object('plan', to_jsonb(plan)));
  END IF;
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（write=1 を付けると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE WARNING E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
