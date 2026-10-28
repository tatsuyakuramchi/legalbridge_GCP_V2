-- =====================================================================
-- 190_condition_holder.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   条件明細の持ち主を正す（docs/v3-condition-holder.md 段階2 PR-C）。
--
--   条件明細を持つのは個別契約（条件書・発注書）か単体契約で、基本契約は個別契約を持つ。
--   これまで条件明細（conditions.agreement_id）は基本契約を直接指していた。既存のデータを移す：
--     1. ライセンス：基本契約を指す条件が、その基本契約の下の個別契約（条件書）に載っていれば
--        → その個別契約へ
--     2. 業務委託：基本契約を指す条件が発注書に載っていれば
--        → 発注書ごとに個別契約の器（kind=supplement、親＝基本契約、番号＝発注書の本体番号）を立て、
--          条件と発注書をそこへ
--     3. 基本契約の無い発注書（条件が契約なし）
--        → 発注書ごとに単体契約の器（kind=standalone）を立て、条件と発注書をそこへ
--     4. 残り（基本契約を指すが、どの文書にも載っていない）は「個別契約待ち」としてそのまま
--        （取引先⇔基本契約の「持ち主の決まっていない条件明細」に出る）
--   触らずに一覧に出すもの（v3.condition_holder_190_review）：
--     - 1 枚の発注書の条件が 2 本の基本契約に分かれている（人が決める）
--     - 発注書の条件の相手先が 2 つ以上
--     - 発注書の条件の一部だけが別の契約（単体契約・個別契約）に載っている
--
--   先に 189（agreements.order_document_id）を流しておくこと。
--   退避：v3.condition_holder_190_backup（条件ごとの移行前の agreement_id）。
--   立てた器：v3.condition_holder_190_created。戻すときは 190_condition_holder_rollback.sql。
--   何度流しても同じ結果（器のある発注書・移した条件はもう当たらない）。
--
--   流す前に infra/v3/diag/condition-holder-check.sql の「前」を、流したあとに「後」を取り、
--   決定済み文書ごとの基本契約が変わっていないことを突き合わせる（同じファイルに手順）。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

-- 0. 退避と記録 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS v3.condition_holder_190_backup (
  condition_id bigint PRIMARY KEY,
  agreement_id bigint,
  saved_at     timestamptz NOT NULL DEFAULT now()
);
-- 最初に流したときの値を残す（2 回目以降は上書きしない）。
INSERT INTO v3.condition_holder_190_backup (condition_id, agreement_id)
SELECT id, agreement_id FROM v3.conditions
ON CONFLICT (condition_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS v3.condition_holder_190_created (
  agreement_id bigint PRIMARY KEY,
  document_id  bigint NOT NULL,
  kind         text NOT NULL,
  master_id    bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS v3.condition_holder_190_review (
  document_id bigint,
  document_no text,
  reason      text NOT NULL,
  detail      text,
  seen_at     timestamptz NOT NULL DEFAULT now()
);
DELETE FROM v3.condition_holder_190_review;

-- 1. ライセンス：基本契約を指す条件を、載っている個別契約（条件書）へ ------------
--    条件書の文書（documents.agreement_id = その基本契約の下の supplement）に載っているもの。
--    複数の条件書に載っていれば、決定済みで新しいもの。
WITH held AS (
  SELECT DISTINCT ON (c.id) c.id AS condition_id, s.id AS supplement_id
    FROM v3.conditions c
    JOIN v3.agreements m ON m.id = c.agreement_id AND COALESCE(m.kind, 'master') = 'master'
    JOIN v3.document_conditions dc ON dc.condition_id = c.id
    JOIN v3.documents d ON d.id = dc.document_id AND d.status NOT IN ('void', 'superseded', 'draft')
    JOIN v3.agreements s ON s.id = d.agreement_id AND COALESCE(s.kind, 'master') = 'supplement' AND s.parent_id = m.id
   WHERE c.status NOT IN ('void', 'superseded')
   ORDER BY c.id, (d.status = 'issued') DESC, d.issued_at DESC NULLS LAST, d.id DESC
)
UPDATE v3.conditions c
   SET agreement_id = held.supplement_id, updated_at = now()
  FROM held
 WHERE c.id = held.condition_id;

-- 2・3. 発注書：発注書ごとに器を立て、条件と発注書をそこへ ---------------------
DO $$
DECLARE
  o           record;
  v_master    bigint;
  v_master_no text;
  v_domain    text;
  v_kind      text;
  v_no        text;
  v_id        bigint;
  n_masters   int;
BEGIN
  FOR o IN
    SELECT d.id AS document_id, d.document_no, d.issued_at,
           COALESCE(d.manual_inputs->>'title', v.title) AS title,
           array_remove(array_agg(DISTINCT CASE WHEN COALESCE(a.kind, 'master') = 'master' THEN a.id END), NULL) AS masters,
           bool_or(c.agreement_id IS NULL) AS has_free,
           bool_or(a.id IS NOT NULL AND COALESCE(a.kind, 'master') <> 'master') AS has_other,
           array_remove(array_agg(DISTINCT c.counterparty_id), NULL) AS parties,
           array_agg(DISTINCT c.direction) AS dirs
      FROM v3.documents d
      JOIN v3.v_document_display v ON v.document_id = d.id
      LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
      LEFT JOIN v3.document_templates t ON t.id = tv.template_id
      JOIN v3.document_conditions dc ON dc.document_id = d.id
      JOIN v3.conditions c ON c.id = dc.condition_id AND c.status NOT IN ('void', 'superseded')
      LEFT JOIN v3.agreements a ON a.id = c.agreement_id
     WHERE d.status NOT IN ('void', 'superseded', 'draft')
       AND (t.template_key IN ('purchase_order', 'intl_purchase_order')
            OR (t.template_key IS NULL AND d.manual_inputs->>'documentKind' = '発注書'))
       AND NOT EXISTS (SELECT 1 FROM v3.agreements x WHERE x.order_document_id = d.id)
     GROUP BY d.id, d.document_no, d.issued_at, d.manual_inputs, v.title
     ORDER BY d.id
  LOOP
    n_masters := cardinality(o.masters);
    -- 条件が全部、別の契約（単体契約・個別契約）に載っている：契約として登録された発注書（寄せる）か
    -- 条件書の条件を発注書にも載せたもの。ここでは触らない。
    IF n_masters = 0 AND NOT o.has_free THEN CONTINUE; END IF;
    IF n_masters > 1 THEN
      INSERT INTO v3.condition_holder_190_review (document_id, document_no, reason, detail)
      VALUES (o.document_id, o.document_no, '条件が 2 本の基本契約に分かれている',
              (SELECT string_agg(agreement_no, '・') FROM v3.agreements WHERE id = ANY(o.masters)));
      CONTINUE;
    END IF;
    IF o.has_other THEN
      INSERT INTO v3.condition_holder_190_review (document_id, document_no, reason, detail)
      VALUES (o.document_id, o.document_no, '条件の一部が別の契約（単体契約・個別契約）に載っている', NULL);
      CONTINUE;
    END IF;
    IF cardinality(o.parties) <> 1 THEN
      INSERT INTO v3.condition_holder_190_review (document_id, document_no, reason, detail)
      VALUES (o.document_id, o.document_no, '条件の相手先が 1 つに決まらない', array_to_string(o.parties, '・'));
      CONTINUE;
    END IF;

    v_master := CASE WHEN n_masters = 1 THEN o.masters[1] END;
    v_master_no := NULL; v_domain := 'service';
    IF v_master IS NOT NULL THEN
      SELECT agreement_no, COALESCE(domain, 'service') INTO v_master_no, v_domain FROM v3.agreements WHERE id = v_master;
    END IF;
    v_kind := CASE WHEN v_master IS NULL THEN 'standalone' ELSE 'supplement' END;

    -- 番号：発注書の本体番号（-R2 を除く）。契約の番号として使われていれば発注書の番号そのまま。それも使われていれば -O<文書id>。
    v_no := regexp_replace(o.document_no, '-R[0-9]+$', '', 'i');
    IF EXISTS (SELECT 1 FROM v3.agreements WHERE lower(btrim(agreement_no)) = lower(v_no)) THEN
      v_no := o.document_no;
      IF EXISTS (SELECT 1 FROM v3.agreements WHERE lower(btrim(agreement_no)) = lower(v_no)) THEN
        v_no := v_no || '-O' || o.document_id;
      END IF;
    END IF;

    INSERT INTO v3.agreements (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
                               order_document_id, effective_on, executed_on)
    VALUES (v_no, COALESCE(o.title, '発注書 ' || v_no), o.parties[1],
            CASE WHEN o.dirs = ARRAY['out'] THEN 'out' ELSE 'in' END,
            'executed', v_kind, v_domain, v_master, o.document_id, o.issued_at::date, o.issued_at::date)
    RETURNING id INTO v_id;
    INSERT INTO v3.condition_holder_190_created (agreement_id, document_id, kind, master_id)
    VALUES (v_id, o.document_id, v_kind, v_master);

    UPDATE v3.conditions c
       SET agreement_id = v_id, updated_at = now()
      FROM v3.document_conditions dc
     WHERE dc.document_id = o.document_id AND dc.condition_id = c.id
       AND c.status NOT IN ('void', 'superseded')
       AND (c.agreement_id IS NULL OR c.agreement_id = v_master);
    UPDATE v3.documents SET agreement_id = v_id
     WHERE id = o.document_id AND (agreement_id IS NULL OR agreement_id = v_master);
  END LOOP;
END $$;

-- 4. 結果 -------------------------------------------------------------------
SELECT '立てた器' AS what, kind, count(*) FROM v3.condition_holder_190_created GROUP BY kind
UNION ALL
SELECT '移した条件（移行前と違う）', '', count(*)
  FROM v3.conditions c JOIN v3.condition_holder_190_backup b ON b.condition_id = c.id
 WHERE c.agreement_id IS DISTINCT FROM b.agreement_id
UNION ALL
SELECT '個別契約待ち（基本契約を直接指す。文書に載っていない）', '', count(*)
  FROM v3.conditions c JOIN v3.agreements a ON a.id = c.agreement_id
 WHERE COALESCE(a.kind, 'master') = 'master' AND c.status NOT IN ('void', 'superseded')
UNION ALL
SELECT '人が決めるもの（review）', reason, count(*) FROM v3.condition_holder_190_review GROUP BY reason;

SELECT * FROM v3.condition_holder_190_review ORDER BY document_id;

COMMIT;
