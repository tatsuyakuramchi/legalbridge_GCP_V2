-- 宙に浮いた支払を全部まとめて辿る。読み取りだけ。書き換え不要。
--
-- 使い方（予備系）
--   cd infra\local
--   docker compose run --rm ops sql /v3/diag/payment-floating-all.sql
--
-- 対象は payment-blocks.sql の C と同じ。取消済みでない支払のうち、
-- 割り当てた実績がどの文書にも付いていないもの。
--
-- 実績が文書から外れる道は4つ。どれが起きたかは 3 の監査記録に出る。
--   document.void             … 文書を無効にした（その文書の実績を全部外す）
--   document.supersede        … 訂正版。外れず新しい版へ移る
--   condition.unlink_document … 人が整理タブで外した
--   計算書の作り直し          … 実績の付け替え
--
-- 口座も連絡先も引かない。

SET search_path = v3;
\pset pager off
\pset border 0

-- 宙に浮いた割当を持つ支払。各節の頭に同じ CTE を書く（一時ビューにすると、
-- 文ごとに別のつなぎになりうる Cloud SQL Studio で次の文から消える）。

\echo ''
\echo '=== 1. 宙に浮いた支払 =================================================='
\echo '   「浮いている実績 / 割当の実績」が全部なら、支払まるごと裏付けなし。'
\echo '   一部なら、その支払は複数の実績にまたがっていて片方だけ外れている。'
\echo ''

WITH floating AS (
  SELECT DISTINCT p.id AS payment_id
    FROM payments p
    JOIN payment_allocations a ON a.payment_id = p.id
    JOIN condition_events e ON e.id = a.event_id
   WHERE p.status <> 'canceled' AND e.document_id IS NULL
)
SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       p.status AS "状態", p.amount AS "金額", p.due_on AS "期日",
       p.created_at::date AS "作った日",
       count(*) FILTER (WHERE e.document_id IS NULL) AS "浮いている実績",
       count(*) AS "割当の実績"
  FROM floating f
  JOIN payments p ON p.id = f.payment_id
  JOIN payment_allocations a ON a.payment_id = p.id
  LEFT JOIN condition_events e ON e.id = a.event_id
 GROUP BY p.id, p.payment_no, p.status, p.amount, p.due_on, p.created_at
 ORDER BY p.id;

\echo ''
\echo '=== 2. 割当の中身と、立てたときの文書のいま ============================'
\echo '   「立てたときの文書」が issued のままなら、人が外したか付け替えた。'
\echo '   void なら、文書を無効にしたときに外れた。'
\echo ''

WITH floating AS (
  SELECT DISTINCT p.id AS payment_id
    FROM payments p
    JOIN payment_allocations a ON a.payment_id = p.id
    JOIN condition_events e ON e.id = a.event_id
   WHERE p.status <> 'canceled' AND e.document_id IS NULL
)
SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       c.condition_no AS "条件",
       e.id AS "実績", e.occurred_on AS "納品日", e.amount AS "実績の額",
       COALESCE(nd.document_no, '（付いていない）') AS "いまの文書",
       sd.document_no AS "立てたときの文書", sd.status AS "その文書のいま",
       (SELECT count(*) FROM condition_events x
         WHERE x.document_id = sd.id AND x.status = 'active') AS "その文書の実績数"
  FROM floating f
  JOIN payments p ON p.id = f.payment_id
  JOIN payment_allocations a ON a.payment_id = p.id
  LEFT JOIN conditions c ON c.id = a.condition_id
  LEFT JOIN condition_events e ON e.id = a.event_id
  LEFT JOIN documents nd ON nd.id = e.document_id
  LEFT JOIN LATERAL (
    SELECT (ae.detail ->> 'documentId')::bigint AS doc_id
      FROM audit_events ae
     WHERE ae.target_type = 'payment' AND ae.target_id = p.id
       AND ae.action = 'payment.create' AND ae.detail ? 'documentId'
     ORDER BY ae.id LIMIT 1
  ) src ON true
  LEFT JOIN documents sd ON sd.id = src.doc_id
 ORDER BY p.id, e.id;

\echo ''
\echo '=== 3. 実績に何が起きたか（支払ごと・時系列） =========================='
\echo '   condition.unlink_document … 人が整理タブで外した'
\echo '   document.void             … 文書を無効にしたときに外れた'
\echo ''

WITH floating AS (
  SELECT DISTINCT p.id AS payment_id
    FROM payments p
    JOIN payment_allocations a ON a.payment_id = p.id
    JOIN condition_events e ON e.id = a.event_id
   WHERE p.status <> 'canceled' AND e.document_id IS NULL
), mine AS (
  SELECT f.payment_id, a.event_id
    FROM floating f
    JOIN payment_allocations a ON a.payment_id = f.payment_id
   WHERE a.event_id IS NOT NULL
)
SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       m.event_id AS "実績",
       ev.occurred_at AS "いつ", ev.actor AS "だれが", ev.action AS "何を",
       ev.detail AS "中身"
  FROM mine m
  JOIN payments p ON p.id = m.payment_id
  JOIN audit_events ev ON
    (ev.detail ? 'eventId' AND (ev.detail ->> 'eventId')::bigint = m.event_id)
    OR (ev.detail ? 'eventIds'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(ev.detail -> 'eventIds') x
                     WHERE x.value ~ '^[0-9]+$' AND x.value::bigint = m.event_id))
    OR (ev.action IN ('document.void', 'document.supersede')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(ev.detail -> 'releasedEvents') = 'array'
                           THEN ev.detail -> 'releasedEvents' ELSE '[]'::jsonb END) r
                     WHERE (r ->> 'id')::bigint = m.event_id))
 ORDER BY p.id, m.event_id, ev.id;

\echo ''
\echo '=== 4. 付け直す先の候補 ================================================'
\echo '   その条件にいまある決定済みの検収書・計算書。'
\echo '   「載っている実績」が 0 のものが、外された相手である可能性が高い。'
\echo ''

WITH floating AS (
  SELECT DISTINCT p.id AS payment_id
    FROM payments p
    JOIN payment_allocations a ON a.payment_id = p.id
    JOIN condition_events e ON e.id = a.event_id
   WHERE p.status <> 'canceled' AND e.document_id IS NULL
), mine AS (
  SELECT DISTINCT f.payment_id, a.condition_id
    FROM floating f
    JOIN payment_allocations a ON a.payment_id = f.payment_id
   WHERE a.condition_id IS NOT NULL
)
SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       c.condition_no AS "条件", d.document_no AS "文書",
       t.template_key AS "ひな形", d.status AS "状態", d.issued_at::date AS "決定日",
       (SELECT count(*) FROM condition_events x
         WHERE x.document_id = d.id AND x.status = 'active') AS "載っている実績"
  FROM mine m
  JOIN payments p ON p.id = m.payment_id
  JOIN conditions c ON c.id = m.condition_id
  JOIN document_conditions dc ON dc.condition_id = c.id
  JOIN documents d ON d.id = dc.document_id AND d.status = 'issued'
  LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id
 WHERE t.template_key IN ('inspection_certificate', 'royalty_statement')
 ORDER BY p.id, c.condition_no, d.issued_at NULLS LAST;

\echo ''
\echo '=== 5. 実績ゼロの決定済み検収書 ========================================'
\echo '   外された側。紙は出ているのに中身の実績が無い状態。'
\echo '   4 の候補と突き合わせて、どの実績を戻すかを決める。'
\echo ''

SELECT d.document_no AS "文書", t.template_key AS "ひな形",
       d.issued_at::date AS "決定日",
       string_agg(DISTINCT c.condition_no, '・') AS "載っている条件"
  FROM documents d
  JOIN document_template_versions tv ON tv.id = d.template_version_id
  JOIN document_templates t ON t.id = tv.template_id
  LEFT JOIN document_conditions dc ON dc.document_id = d.id
  LEFT JOIN conditions c ON c.id = dc.condition_id
 WHERE d.status = 'issued'
   AND t.template_key IN ('inspection_certificate', 'royalty_statement')
   AND NOT EXISTS (SELECT 1 FROM condition_events x
                    WHERE x.document_id = d.id AND x.status = 'active')
 GROUP BY d.id, d.document_no, t.template_key, d.issued_at
 ORDER BY d.issued_at NULLS LAST, d.document_no;
