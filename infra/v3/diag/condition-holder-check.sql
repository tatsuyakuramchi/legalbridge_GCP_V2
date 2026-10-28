-- =====================================================================
-- condition-holder-check.sql（190 の前後の突き合わせ。読むだけ）
--
--   手順
--     前：190 を流す前に「A. 写し」を流す（v3.condition_holder_190_snapshot ができる）。
--     後：190 を流したあとに「B. 突き合わせ」と「C. 残りの数」を流す。
--         B が 0 行なら、決定済み文書ごとの基本契約（文書の基本契約名・契約番号・締結日・自動更新の出所）は
--         変わっていない。
--
--   基本契約は「条件の契約の根（個別契約ならその親）のうち kind=master のもの」で見る。
--   これはアプリの読み出し（conditions/contracts.ts の rootOf）と同じ決まり。
--   移行で 基本契約の無い発注書 に単体契約の器が立つが、単体契約は基本契約として出さないので、ここには影響しない。
-- =====================================================================

SET search_path = v3, public;

-- A. 写し（190 の前に 1 回）-----------------------------------------------------
DROP TABLE IF EXISTS v3.condition_holder_190_snapshot;
CREATE TABLE v3.condition_holder_190_snapshot AS
SELECT d.id AS document_id, d.document_no,
       string_agg(DISTINCT m.agreement_no, '・' ORDER BY m.agreement_no) AS master_nos,
       count(DISTINCT c.id) AS conditions
  FROM v3.documents d
  JOIN v3.document_conditions dc ON dc.document_id = d.id
  JOIN v3.conditions c ON c.id = dc.condition_id
  LEFT JOIN v3.agreements a ON a.id = c.agreement_id
  LEFT JOIN v3.agreements r ON r.id = CASE WHEN COALESCE(a.kind, 'master') IN ('supplement', 'termination')
                                            THEN COALESCE(a.parent_id, a.id) ELSE a.id END
  LEFT JOIN v3.agreements m ON m.id = r.id AND COALESCE(m.kind, 'master') = 'master'
 WHERE d.status = 'issued'
 GROUP BY d.id, d.document_no;

-- B. 突き合わせ（190 の後）。0 行が正。 -------------------------------------------
WITH now_ AS (
  SELECT d.id AS document_id, d.document_no,
         string_agg(DISTINCT m.agreement_no, '・' ORDER BY m.agreement_no) AS master_nos,
         count(DISTINCT c.id) AS conditions
    FROM v3.documents d
    JOIN v3.document_conditions dc ON dc.document_id = d.id
    JOIN v3.conditions c ON c.id = dc.condition_id
    LEFT JOIN v3.agreements a ON a.id = c.agreement_id
    LEFT JOIN v3.agreements r ON r.id = CASE WHEN COALESCE(a.kind, 'master') IN ('supplement', 'termination')
                                              THEN COALESCE(a.parent_id, a.id) ELSE a.id END
    LEFT JOIN v3.agreements m ON m.id = r.id AND COALESCE(m.kind, 'master') = 'master'
   WHERE d.status = 'issued'
   GROUP BY d.id, d.document_no
)
SELECT s.document_no, s.master_nos AS before_master, n.master_nos AS after_master, s.conditions, n.conditions AS after_conditions
  FROM v3.condition_holder_190_snapshot s
  FULL JOIN now_ n ON n.document_id = s.document_id
 WHERE s.master_nos IS DISTINCT FROM n.master_nos OR s.conditions IS DISTINCT FROM n.conditions
 ORDER BY s.document_no;

-- C. 残りの数（190 の後）---------------------------------------------------------
-- C-1. 決定済みの文書に載っているのに、基本契約を直接指している条件（review に出た発注書の分を除いて 0 が正）
SELECT count(*) AS held_but_on_master
  FROM v3.conditions c
  JOIN v3.agreements a ON a.id = c.agreement_id AND COALESCE(a.kind, 'master') = 'master'
 WHERE c.status NOT IN ('void', 'superseded')
   AND EXISTS (SELECT 1 FROM v3.document_conditions dc JOIN v3.documents d ON d.id = dc.document_id
                WHERE dc.condition_id = c.id AND d.status NOT IN ('void', 'superseded', 'draft')
                  AND NOT EXISTS (SELECT 1 FROM v3.condition_holder_190_review r WHERE r.document_id = d.id));
-- C-2. 器の無い決定済みの発注書（0 が正）。review に出たものと、条件が全部 別の契約（契約として登録された
--      発注書＝「発注書（文書）に寄せる」の対象、条件書の条件を載せた発注書）に載っているものは除く
SELECT d.id, d.document_no
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
 WHERE d.status NOT IN ('void', 'superseded', 'draft')
   AND (t.template_key IN ('purchase_order', 'intl_purchase_order')
        OR (t.template_key IS NULL AND d.manual_inputs->>'documentKind' = '発注書'))
   AND EXISTS (SELECT 1 FROM v3.document_conditions dc WHERE dc.document_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM v3.agreements x WHERE x.order_document_id = d.id)
   AND NOT EXISTS (SELECT 1 FROM v3.condition_holder_190_review r WHERE r.document_id = d.id)
   AND EXISTS (SELECT 1 FROM v3.document_conditions dc JOIN v3.conditions c ON c.id = dc.condition_id
                LEFT JOIN v3.agreements a ON a.id = c.agreement_id
               WHERE dc.document_id = d.id AND (a.id IS NULL OR COALESCE(a.kind, 'master') = 'master'))
 ORDER BY d.id;
-- C-3. 個別契約待ち（基本契約を直接指すが文書に載っていない）。これは残ってよい
SELECT a.agreement_no, count(*) AS waiting
  FROM v3.conditions c JOIN v3.agreements a ON a.id = c.agreement_id
 WHERE COALESCE(a.kind, 'master') = 'master' AND c.status NOT IN ('void', 'superseded')
 GROUP BY a.agreement_no ORDER BY waiting DESC;
