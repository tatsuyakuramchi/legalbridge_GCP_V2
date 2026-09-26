-- =====================================================================
-- V3移行 050：稟議・関連当事者（A-053・A-054）
--   V1 の ringi_records・ringi_documents・ringi_works・contracts.ringi_id・
--   condition_lines.ringi_id と、関連当事者（vendors の印・officers・officer_roles・
--   vendor_shareholdings・ringi_related_party）を v3 へ写す。
--
--   何度流しても同じ結果になる（legacy_id と一意キーで重ねない）。
--   V3 で直した稟議・役職・株主構成は上書きしない（入っていないものだけ入れる）。
--   V1 に表が無ければ、その部分は飛ばす。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/050_migrate_ringi_rpt.sql
--         （004_amend.sql の A-053〜055 を流した後。010〜040 の後）
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

DO $ringi$
DECLARE n int;
BEGIN
  IF to_regclass('public.ringi_records') IS NULL THEN
    RAISE NOTICE '稟議：public.ringi_records が無いので飛ばします';
    RETURN;
  END IF;

  -- 稟議。番号は R-/B- 付きに揃える（V1 には 5 桁だけの古い番号も残りうる）。
  EXECUTE $q$
    INSERT INTO v3.ringi (ringi_no, decision_type, title, category, owner_name, owner_department,
                          approved_on, backlog_issue_key, status, total_budget, remarks, legacy_id,
                          created_by, created_at, updated_at)
    SELECT no, CASE WHEN no LIKE 'B-%' THEN 'board_resolution' ELSE 'ringi' END,
           COALESCE(NULLIF(btrim(r.title), ''), '（件名なし）'),
           NULLIF(r.category, ''), NULLIF(r.owner_name, ''), NULLIF(r.owner_department, ''),
           r.approved_at, NULLIF(r.backlog_issue_key, ''),
           CASE WHEN r.status IN ('open', 'approved', 'rejected', 'closed', 'cancelled') THEN r.status ELSE 'open' END,
           r.total_budget, NULLIF(r.remarks, ''), r.id, 'migration:050',
           COALESCE(r.created_at, now()), COALESCE(r.updated_at, r.created_at, now())
      FROM (SELECT r.*, CASE WHEN btrim(r.ringi_number) ~ '^[0-9]{5}$' THEN 'R-' || btrim(r.ringi_number)
                             ELSE upper(btrim(r.ringi_number)) END AS no
              FROM public.ringi_records r) r
     WHERE r.no ~ '^(R|B)-[0-9]{5}$'
    ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING
  $q$;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '稟議：% 件を入れました', n;

  -- 番号の形が読めず入れられなかったもの（人が見る）。
  EXECUTE $q$
    SELECT count(*) FROM public.ringi_records r
     WHERE NOT (btrim(r.ringi_number) ~ '^[0-9]{5}$' OR upper(btrim(r.ringi_number)) ~ '^(R|B)-[0-9]{5}$')
  $q$ INTO n;
  IF n > 0 THEN RAISE NOTICE '稟議：番号の形が読めない % 件は入れていません', n; END IF;

  -- 文書との繋ぎ
  IF to_regclass('public.ringi_documents') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO v3.ringi_links (ringi_id, target_type, target_id, linked_at, linked_by)
      SELECT nr.id, 'document', nd.id, COALESCE(rd.linked_at, now()), 'migration:050'
        FROM public.ringi_documents rd
        JOIN v3.ringi nr ON nr.legacy_id = rd.ringi_id
        JOIN v3.documents nd ON nd.legacy_id = rd.document_id
      ON CONFLICT DO NOTHING
    $q$;
  END IF;

  -- 作品との繋ぎ
  IF to_regclass('public.ringi_works') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO v3.ringi_links (ringi_id, target_type, target_id, linked_by)
      SELECT nr.id, 'work', w.id, 'migration:050'
        FROM public.ringi_works rw
        JOIN v3.ringi nr ON nr.legacy_id = rw.ringi_id
        JOIN v3.works w ON w.legacy_table = 'works' AND w.legacy_id = rw.work_id
      ON CONFLICT DO NOTHING
    $q$;
  END IF;

  -- 契約との繋ぎ（contracts.ringi_id）
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'contracts' AND column_name = 'ringi_id') THEN
    EXECUTE $q$
      INSERT INTO v3.ringi_links (ringi_id, target_type, target_id, linked_by)
      SELECT nr.id, 'agreement', a.id, 'migration:050'
        FROM public.contracts c
        JOIN v3.ringi nr ON nr.legacy_id = c.ringi_id
        JOIN v3.agreements a ON a.legacy_id = c.id
      ON CONFLICT DO NOTHING
    $q$;
  END IF;

  -- 条件との繋ぎ（condition_lines.ringi_id）
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'condition_lines' AND column_name = 'ringi_id') THEN
    EXECUTE $q$
      INSERT INTO v3.ringi_links (ringi_id, target_type, target_id, linked_by)
      SELECT nr.id, 'condition', nc.id, 'migration:050'
        FROM public.condition_lines cl
        JOIN v3.ringi nr ON nr.legacy_id = cl.ringi_id
        JOIN v3.conditions nc ON nc.legacy_id = cl.id
      ON CONFLICT DO NOTHING
    $q$;
  END IF;
END
$ringi$;

DO $rpt$
DECLARE n int;
BEGIN
  -- 取引先の印（関連当事者の判定に使う会社・取締役会の有無・関連当事者）
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'rpt_entity') THEN
    EXECUTE $q$
      UPDATE v3.parties p
         SET rpt_entity = true, has_board = COALESCE(v.has_board, p.has_board)
        FROM public.vendors v
       WHERE p.legacy_id = v.id AND v.rpt_entity IS TRUE AND NOT p.rpt_entity
    $q$;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '関連当事者：判定に使う会社 % 社に印を付けました', n;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'related_party') THEN
    EXECUTE $q$
      UPDATE v3.parties p
         SET related_party = true,
             related_party_type = COALESCE(p.related_party_type, NULLIF(v.related_party_type, '')),
             related_party_note = COALESCE(p.related_party_note, NULLIF(v.related_party_note, ''))
        FROM public.vendors v
       WHERE p.legacy_id = v.id AND v.related_party IS TRUE AND NOT p.related_party
    $q$;
  END IF;

  IF to_regclass('public.officers') IS NULL THEN
    RAISE NOTICE '関連当事者：public.officers が無いので役員・株主構成・議案は飛ばします';
    RETURN;
  END IF;

  EXECUTE $q$
    INSERT INTO v3.officers (officer_key, name, staff_id, voided_at, legacy_id, created_at, updated_at)
    SELECT o.officer_key, o.name, s.id, o.voided_at, o.id,
           COALESCE(o.created_at, now()), COALESCE(o.updated_at, o.created_at, now())
      FROM public.officers o
      LEFT JOIN v3.staff s ON s.legacy_id = o.staff_id
    ON CONFLICT (officer_key) DO NOTHING
  $q$;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '関連当事者：役員 % 人を入れました', n;

  IF to_regclass('public.officer_roles') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO v3.officer_roles (officer_id, party_id, title, is_director)
      SELECT no.id, p.id, r.title, COALESCE(r.is_director, true)
        FROM public.officer_roles r
        JOIN v3.officers no ON no.legacy_id = r.officer_id
        JOIN v3.parties p ON p.legacy_id = r.entity_id
       WHERE r.title IN ('代表取締役', '取締役', '社外取締役', '監査役', '執行役員', '会計参与')
      ON CONFLICT (officer_id, party_id, title) DO NOTHING
    $q$;
  END IF;

  -- 株主構成。V3 でその会社の株主構成をもう直していれば触らない。
  IF to_regclass('public.vendor_shareholdings') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO v3.party_shareholdings (party_id, holder_kind, holder_party_id, holder_officer_id, voting_pct)
      SELECT p.id,
             CASE WHEN sh.holder_kind = 'officer' THEN 'officer' ELSE 'party' END,
             hp.id, ho.id, sh.voting_pct
        FROM public.vendor_shareholdings sh
        JOIN v3.parties p ON p.legacy_id = sh.entity_id
        LEFT JOIN v3.parties hp ON hp.legacy_id = sh.holder_entity_id
        LEFT JOIN v3.officers ho ON ho.legacy_id = sh.holder_officer_id
       WHERE sh.voting_pct > 0 AND sh.voting_pct <= 100
         AND ((sh.holder_kind = 'officer' AND ho.id IS NOT NULL)
              OR (sh.holder_kind <> 'officer' AND hp.id IS NOT NULL AND hp.id <> p.id))
         AND NOT EXISTS (SELECT 1 FROM v3.party_shareholdings x WHERE x.party_id = p.id)
    $q$;
  END IF;

  -- 取締役会の議案
  IF to_regclass('public.ringi_related_party') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO v3.ringi_related_party (ringi_id, party_id, meeting_on, txn_type, party_a, party_b,
                                          amount_ex_tax, is_conflict, is_related_party, related_category,
                                          conflict_types, excluded_officers, rp_status, note, created_at, updated_at)
      SELECT nr.id, p.id, x.meeting_date, COALESCE(NULLIF(x.txn_type, ''), 'その他'),
             COALESCE(x.party_a, ''), COALESCE(x.party_b, ''), x.amount_ex_tax,
             COALESCE(x.is_conflict, false), COALESCE(x.is_related_party, false), NULLIF(x.related_category, ''),
             COALESCE(x.conflict_types, '[]'::jsonb), COALESCE(x.excluded_officers, '[]'::jsonb),
             CASE WHEN x.rp_status IN ('pending', 'approved', 'rejected', 'deferred') THEN x.rp_status ELSE 'pending' END,
             NULLIF(x.note, ''), COALESCE(x.created_at, now()), COALESCE(x.updated_at, x.created_at, now())
        FROM public.ringi_related_party x
        JOIN v3.ringi nr ON nr.legacy_id = x.ringi_id
        LEFT JOIN v3.parties p ON p.legacy_id = x.entity_id
      ON CONFLICT (ringi_id) DO NOTHING
    $q$;
  END IF;
END
$rpt$;

COMMIT;

\echo '--- 写した件数 ---'
SELECT '稟議' AS 表, count(*) AS 件数 FROM v3.ringi
UNION ALL SELECT '稟議の繋ぎ', count(*) FROM v3.ringi_links
UNION ALL SELECT '判定に使う会社', count(*) FROM v3.parties WHERE rpt_entity
UNION ALL SELECT '役員', count(*) FROM v3.officers
UNION ALL SELECT '役職', count(*) FROM v3.officer_roles
UNION ALL SELECT '株主構成', count(*) FROM v3.party_shareholdings
UNION ALL SELECT '取締役会の議案', count(*) FROM v3.ringi_related_party;
