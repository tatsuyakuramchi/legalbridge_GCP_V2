-- =====================================================================
-- 別の種類の文書の「訂正版」として出てしまった文書を直す（DO ブロック 1 つ）。
--
--   起きたこと：条件書（ARC-PUBT-2026-9000）の訂正版として計算書を出したため、
--     ・計算書が条件書の番号に枝番を付けた番号（ARC-PUBT-2026-9000-R2、-R3 …）になった
--     ・元の条件書が「差し替え済み（訂正版あり）」に退いた
--   アプリは、訂正版を同じ種類の文書でだけ出せるように直した（issue-service の revisionFamily）。
--
--   直すこと（番号の本体が別の種類の文書の番号になっている文書を、本体の番号ごとにまとめて）
--     1. その文書たちに自分の種類の新しい番号を振る。並び（版）は保つ：1 枚目が本体、2 枚目から -R2、-R3 …
--        番号帯は元の番号に合わせる（9000 番台なら予備系の帯。採番表も進める）
--     2. 紙に焼き付けた番号（DOC_NO など、元の番号と同じ値の欄）を新しい番号に書き換え、PDF の作り置きを捨てる
--        （開けば新しい番号で作り直す）
--     3. 1 枚目が退かせていた別の種類の文書（条件書）を「決定済み」に戻し、1 枚目の「差し替え元」を外す
--   金額・実績・支払の繋がりは変えない（文書の id はそのまま）。
--
--   ★ 予備系（ローカル）で流す：infra\local で
--       docker compose run --rm ops sql /v3/diag/fix-cross-revision.sql
--     まずそのまま流す（お試し。一覧が出て、何も変わらない）→ よければ dry := false にして流す。
--     本番で同じことが起きていれば、Cloud SQL Studio でも同じように流せる。何度流しても同じ結果。
-- =====================================================================

DO $fix$
DECLARE
  dry      boolean := true;                       -- ★ false にすると書き込む
  plan     text[] := '{}';
  g        record;
  d        record;
  r        record;
  v_prefix text;
  v_key    text;
  v_year   int;
  v_band   boolean;
  v_seq    int;
  v_base   text;
  v_no     text;
  v_old_printed text;
  v_new_printed text;
  v_rev    int;
  v_show   boolean;
  v_vals   jsonb;
  k        text;
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  -- 自分のひな形の採番プレフィックスと番号が合わない文書を、元の番号の本体（枝番を外したもの）ごとに。
  FOR g IN
    WITH docs AS (
      SELECT dd.id, dd.document_no, dd.status, dd.supersedes_id, dd.issued_at, dd.manual_inputs,
             regexp_replace(dd.document_no, '-R[0-9]+$', '') AS base,
             COALESCE((regexp_match(dd.document_no, '-R([0-9]+)$'))[1]::int, 1) AS rev,
             upper(regexp_replace(t.number_prefix, '^ARC-', '', 'i')) AS own_prefix,
             t.template_key, t.label
        FROM v3.documents dd
        JOIN v3.document_template_versions tv ON tv.id = dd.template_version_id
        JOIN v3.document_templates t ON t.id = tv.template_id
       WHERE dd.document_no IS NOT NULL AND dd.status IN ('issued', 'superseded', 'void')
         AND t.number_prefix IS NOT NULL AND t.number_prefix <> ''
    )
    SELECT base, own_prefix, min(template_key) AS template_key, min(label) AS label,
           array_agg(id ORDER BY rev, id) AS ids
      FROM docs
     WHERE base NOT LIKE 'ARC-' || own_prefix || '-%'
       -- 本体の番号が「別の種類の文書」の番号であるものだけ（訂正版の取り違え）。採番の頭が昔と変わった
       -- 移行文書（自分の番号の文書）は触らない。
       AND EXISTS (SELECT 1 FROM docs o WHERE o.document_no = docs.base AND o.own_prefix <> docs.own_prefix)
     GROUP BY base, own_prefix
     ORDER BY base
  LOOP
    v_prefix := g.own_prefix;
    -- 年と番号帯は元の番号から（ARC-PUBT-2026-9000 → 2026 年・9000 番台）。
    v_year := (regexp_match(g.base, '-([0-9]{4})-[0-9]+$'))[1]::int;
    v_band := ((regexp_match(g.base, '-([0-9]+)$'))[1])::int >= 9000;
    IF v_year IS NULL THEN
      plan := plan || format('要確認 %s：番号から年が読めないので触らない', g.base);
      CONTINUE;
    END IF;
    v_key := v_prefix || CASE WHEN v_band THEN '@backup' ELSE '' END;
    -- 次の番号：採番表の値と、その帯で使われている最大の番号の大きいほう ＋ 1。使われていれば進める。
    SELECT greatest(
             COALESCE((SELECT current_value FROM v3.document_sequences WHERE prefix = v_key AND year = v_year),
                      CASE WHEN v_band THEN 8999 ELSE 0 END),
             COALESCE((SELECT max(((regexp_match(x.document_no, '^ARC-' || v_prefix || '-' || v_year || '-([0-9]+)'))[1])::int)
                         FROM v3.documents x
                        WHERE x.document_no ~ ('^ARC-' || v_prefix || '-' || v_year || '-[0-9]+')
                          AND (((regexp_match(x.document_no, '^ARC-' || v_prefix || '-' || v_year || '-([0-9]+)'))[1])::int >= 9000) = v_band), 0)
           ) + 1 INTO v_seq;
    LOOP
      v_base := format('ARC-%s-%s-%s', v_prefix, v_year, lpad(v_seq::text, 4, '0'));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM v3.documents x WHERE regexp_replace(x.document_no, '-R[0-9]+$', '') = v_base);
      v_seq := v_seq + 1;
    END LOOP;
    INSERT INTO v3.document_sequences (prefix, year, current_value) VALUES (v_key, v_year, v_seq)
      ON CONFLICT (prefix, year) DO UPDATE SET current_value = greatest(v3.document_sequences.current_value, EXCLUDED.current_value);

    v_rev := 0;
    FOR d IN SELECT x.* FROM v3.documents x WHERE x.id = ANY(g.ids) ORDER BY array_position(g.ids, x.id) LOOP
      v_rev := v_rev + 1;
      v_no := CASE WHEN v_rev = 1 THEN v_base ELSE v_base || '-R' || v_rev END;
      v_show := COALESCE(d.manual_inputs ->> '_showRevision', '1') <> '0';
      -- 紙に焼き付けた番号（本体＋改訂の印）。元の番号と同じ値の欄だけを書き換える。
      v_old_printed := regexp_replace(d.document_no, '-R[0-9]+$', '')
        || CASE WHEN d.document_no ~ '-R[0-9]+$' AND v_show THEN '（改訂' || (regexp_match(d.document_no, '-R([0-9]+)$'))[1] || '）' ELSE '' END;
      v_new_printed := v_base || CASE WHEN v_rev > 1 AND v_show THEN '（改訂' || v_rev || '）' ELSE '' END;
      v_vals := COALESCE(d.rendered_values, '{}'::jsonb);
      -- 枝番つき・改訂の印つきの値はこの文書の番号なので、どの欄でも書き換える。枝番の無い本体の番号は
      -- 元の種類の文書（条件書）の番号でもあり、対象契約などとして正しく載っていることがあるので、
      -- 文書番号の欄（legacy-variables.ts の DOC_NO など）だけを書き換える。
      FOR k IN SELECT key FROM jsonb_each_text(v_vals)
                WHERE (value IN (v_old_printed, d.document_no) AND value <> regexp_replace(d.document_no, '-R[0-9]+$', ''))
                   OR (value = regexp_replace(d.document_no, '-R[0-9]+$', '')
                       AND key IN ('DOC_NO', 'CONTRACT_NO', 'ORDER_NO', 'documentNumber', '文書番号', '契約書番号', '発注番号')) LOOP
        v_vals := jsonb_set(v_vals, ARRAY[k], to_jsonb(v_new_printed));
      END LOOP;
      UPDATE v3.documents SET document_no = v_no, rendered_values = v_vals WHERE id = d.id;
      DELETE FROM v3.document_pdfs WHERE document_id = d.id;
      plan := plan || format('%s %s（%s・%s）→ %s', g.label, d.document_no, d.status, d.id, v_no);

      -- 1 枚目が退かせていた別の種類の文書を戻す。
      IF v_rev = 1 AND d.supersedes_id IS NOT NULL THEN
        SELECT x.id, x.document_no, x.status, t2.label INTO r
          FROM v3.documents x
          LEFT JOIN v3.document_template_versions tv2 ON tv2.id = x.template_version_id
          LEFT JOIN v3.document_templates t2 ON t2.id = tv2.template_id
         WHERE x.id = d.supersedes_id;
        UPDATE v3.documents SET supersedes_id = NULL WHERE id = d.id;
        IF r.id IS NOT NULL AND r.status = 'superseded'
           AND NOT EXISTS (SELECT 1 FROM v3.documents y WHERE y.supersedes_id = r.id AND y.id <> d.id AND y.status <> 'void') THEN
          UPDATE v3.documents SET status = 'issued' WHERE id = r.id;
          plan := plan || format('  %s %s：「差し替え済み」から「決定済み」に戻す（%s の差し替え元を外す）', COALESCE(r.label, '文書'), r.document_no, v_no);
        ELSE
          plan := plan || format('  %s の差し替え元（%s）を外す', v_no, COALESCE(r.document_no, '#' || d.supersedes_id));
        END IF;
      END IF;
    END LOOP;

    INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
    VALUES ('sql:fix-cross-revision', 'document.renumber', 'document', g.ids[1],
            jsonb_build_object('oldBase', g.base, 'newBase', v_base, 'documentIds', to_jsonb(g.ids)));
  END LOOP;

  IF array_length(plan, 1) IS NULL THEN plan := ARRAY['直すものはありません（番号と種類が合っています）']; END IF;
  IF dry THEN
    RAISE EXCEPTION USING MESSAGE = E'お試し：書き込みは取り消しました（dry := false にすると書き込みます）\n' || array_to_string(plan, E'\n');
  END IF;
  RAISE NOTICE E'書き込みました\n%', array_to_string(plan, E'\n');
END
$fix$;
