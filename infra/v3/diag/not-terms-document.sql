-- =====================================================================
-- 条件書ではなかった文書を、個別契約から外して種類を直す（DO ブロック 1 つ）。
--
--   起きたこと：fix-party-contracts.sql は、番号が ARC-PUBT／ARC-ILT の取込文書を条件書として扱い、
--   本体の番号の個別契約を立てて文書を載せた。中身が条件書ではない文書（利用許諾計算書など）にも立ってしまった。
--
--   直すこと（doc=文書番号 の 1 枚）
--     1. 文書を、立てた個別契約の親（基本契約）に戻す（立てる前と同じ）
--     2. その個別契約に条件も文書も残っていなければ消す（残っていれば消さずに知らせる）
--     3. kind=… を渡せば、取込文書の種類（documentKind）をそれに直す（次に整理を流しても条件書と見なさない）
--   文書の番号・中身・条件とのつながり（document_conditions）・実績・支払は変えない。
--
--   ★ 使い方（予備系。infra\local で。ファイルは書き換えない）
--       お試し： docker compose run --rm ops sql /v3/diag/not-terms-document.sql doc=ARC-PUBT-2026-0026 kind=利用許諾計算書
--       書き込む：docker compose run --rm ops sql /v3/diag/not-terms-document.sql doc=ARC-PUBT-2026-0026 kind=利用許諾計算書 write=1
-- =====================================================================

\if :{?doc}
\else
  \echo '文書番号を doc=… で渡してください（例: doc=ARC-PUBT-2026-0026 kind=利用許諾計算書）'
  \quit
\endif
\if :{?kind}
\else
  \set kind ''
\endif
\if :{?write}
\else
  \set write 0
\endif
SELECT set_config('fix.doc', :'doc', false) AS 文書, set_config('fix.kind', :'kind', false) AS 種類,
       set_config('fix.write', :'write', false) AS 書き込む;

DO $fix$
DECLARE
  dry    boolean := current_setting('fix.write') NOT IN ('1', 'true', 'yes');
  v_no   text := btrim(current_setting('fix.doc'));
  v_kind text := btrim(current_setting('fix.kind'));
  plan   text[] := '{}';
  d      record;
  a      record;
  v_n    int;
  v_m    int;
BEGIN
  SELECT dd.id, dd.document_no, dd.agreement_id, dd.template_version_id, dd.manual_inputs->>'documentKind' AS kind
    INTO d FROM v3.documents dd WHERE dd.document_no = v_no;
  IF d.id IS NULL THEN RAISE EXCEPTION '文書 % が見つかりません', v_no; END IF;
  plan := plan || format('文書 %s（#%s・いまの種類：%s）', d.document_no, d.id, COALESCE(d.kind, '—'));

  SELECT x.id, x.agreement_no, COALESCE(x.kind, 'master') AS kind, x.parent_id, p.agreement_no AS parent_no
    INTO a FROM v3.agreements x LEFT JOIN v3.agreements p ON p.id = x.parent_id WHERE x.id = d.agreement_id;
  IF a.id IS NULL THEN
    plan := plan || '  契約に載っていないので、契約はそのまま'::text;
  ELSIF a.kind <> 'supplement' OR a.parent_id IS NULL THEN
    plan := plan || format('  載っている契約 %s は個別契約ではないので、そのまま', a.agreement_no);
  ELSE
    UPDATE v3.documents SET agreement_id = a.parent_id WHERE id = d.id;
    plan := plan || format('  文書を個別契約 %s から基本契約 %s に戻す', a.agreement_no, a.parent_no);
    SELECT count(*) INTO v_n FROM v3.conditions WHERE agreement_id = a.id;
    SELECT count(*) INTO v_m FROM v3.documents WHERE agreement_id = a.id;
    IF v_n = 0 AND v_m = 0 AND NOT EXISTS (SELECT 1 FROM v3.agreements k WHERE k.parent_id = a.id) THEN
      DELETE FROM v3.matter_links WHERE target_type = 'agreement' AND target_ref = a.id::text;
      DELETE FROM v3.agreements WHERE id = a.id;
      plan := plan || format('  空になった個別契約 %s を消す', a.agreement_no);
    ELSE
      plan := plan || format('  個別契約 %s には条件 %s 本・文書 %s 枚が残っているので消さない', a.agreement_no, v_n, v_m);
    END IF;
  END IF;

  IF v_kind <> '' THEN
    IF d.template_version_id IS NOT NULL THEN
      plan := plan || '  ひな形から作った文書なので種類は変えない'::text;
    ELSE
      UPDATE v3.documents SET manual_inputs = jsonb_set(COALESCE(manual_inputs, '{}'::jsonb), '{documentKind}', to_jsonb(v_kind))
       WHERE id = d.id;
      plan := plan || format('  種類を「%s」→「%s」に直す', COALESCE(d.kind, '—'), v_kind);
    END IF;
  END IF;

  IF NOT dry THEN
    INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
    VALUES ('sql:not-terms-document', 'document.retag', 'document', d.id, jsonb_build_object('plan', to_jsonb(plan)));
  END IF;
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（write=1 を付けると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE WARNING E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
