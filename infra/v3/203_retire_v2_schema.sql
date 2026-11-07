-- =====================================================================
-- 203_retire_v2_schema.sql（Cloud SQL Studio 用。DO ブロック 1 つ）
--
--   V2 アプリを止めたあと、public スキーマに残った旧アプリ（V1・V2）の表を legacy_v2 スキーマへ退避する。
--   消さない（名前の置き場所を変えるだけ。中身・索引・制約・連番はそのまま）。しばらく様子を見て、
--   困ることが無ければ、Cloud SQL の「エクスポート」で legacy_v2 を書き出してから消す（別の SQL）。
--
--   先に止めておくもの（コンソールで）：
--     - Cloud Run の legalbridge-v2-preview（サービスを削除するか、止める）
--     - Cloud Build で infra/gcp/cloudbuild.yaml を使うトリガー（無効にする。main へのマージで V2 が立ち上がらないように）
--
--   止まっていることの確かめ（どれかに当たると、移さずに止まる）
--     - V2 の DB ユーザー（legalbridge_v2_*）が今つないでいる
--     - v3 のビュー・関数が public の表を使っている
--   拡張機能の持ち物（pgcrypto などの関数・表）と、表に付いた連番は移さない（連番は表と一緒に動く）。
--   public スキーマそのもの（拡張機能の置き場所）は残す。
--
--   ★ 使い方：そのまま流す（お試し）→ 一覧を確かめる → dry := false で流す。何度流しても同じ結果。
--     戻すときは 203_retire_v2_schema_rollback.sql（legacy_v2 の表を public へ戻す）。
-- =====================================================================

DO $retire$
DECLARE
  dry      boolean := true;                       -- ★ false にすると書き込む
  plan     text[] := '{}';
  blockers text[] := '{}';
  r        record;
  n_moved  int := 0;
  n_failed int := 0;
  kind     text;
BEGIN
  -- 0. 止まっているか -------------------------------------------------------------------
  FOR r IN SELECT usename, count(*) AS n FROM pg_stat_activity
            WHERE usename LIKE 'legalbridge\_v2%' GROUP BY usename LOOP
    blockers := blockers || format('V2 の DB ユーザー %s が今 %s 本つないでいる（V2 のサービスがまだ動いている）', r.usename, r.n);
  END LOOP;
  FOR r IN
    SELECT DISTINCT dv.relname AS v3_obj, src.relname AS public_rel
      FROM pg_depend dep
      JOIN pg_rewrite rw ON rw.oid = dep.objid
      JOIN pg_class dv ON dv.oid = rw.ev_class
      JOIN pg_namespace dn ON dn.oid = dv.relnamespace AND dn.nspname = 'v3'
      JOIN pg_class src ON src.oid = dep.refobjid
      JOIN pg_namespace sn ON sn.oid = src.relnamespace AND sn.nspname = 'public'
  LOOP
    blockers := blockers || format('v3 のビュー %s が public.%s を使っている', r.v3_obj, r.public_rel);
  END LOOP;
  FOR r IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'v3' AND p.prosrc ~* '\mpublic\.[a-z_"]'
  LOOP
    blockers := blockers || format('v3 の関数 %s の本文に public. の表の名前がある', r.proname);
  END LOOP;
  IF array_length(blockers, 1) IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = E'止めました（何も変えていません）\n' || array_to_string(blockers, E'\n');
  END IF;

  -- 1. public の表・ビュー・連番を legacy_v2 へ ----------------------------------------------
  CREATE SCHEMA IF NOT EXISTS legacy_v2;
  FOR r IN
    SELECT c.oid, c.relname, c.relkind,
           pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       -- 拡張機能の持ち物は動かさない
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       -- 表に付いた連番（serial・identity）は表と一緒に動くので、ここでは動かさない
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                                             AND d.objid = c.oid AND d.deptype IN ('a', 'i')))
     ORDER BY c.relkind, c.relname
  LOOP
    kind := CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE'
                           WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END;
    IF to_regclass(format('legacy_v2.%I', r.relname)) IS NOT NULL THEN
      plan := plan || format('要確認 %s：legacy_v2 にも同じ名前があるので移さない', r.relname);
      n_failed := n_failed + 1;
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('ALTER %s public.%I SET SCHEMA legacy_v2', kind, r.relname);
      n_moved := n_moved + 1;
    EXCEPTION WHEN OTHERS THEN
      plan := plan || format('要確認 %s：移せない（%s）', r.relname, SQLERRM);
      n_failed := n_failed + 1;
    END;
  END LOOP;

  plan := array_prepend(format('public の表・ビュー・連番 %s 個を legacy_v2 へ移す（移せなかったもの %s 個）', n_moved, n_failed), plan);
  SELECT count(*) INTO n_moved FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm');
  plan := plan || format('public に残る表・ビュー：%s 個（拡張機能の持ち物など）', n_moved);

  INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
  VALUES ('sql:203_retire_v2_schema', 'db.retire_v2_schema', 'job', 0, jsonb_build_object('plan', to_jsonb(plan)));
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$retire$;
