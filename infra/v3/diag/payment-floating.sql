-- 宙に浮いた支払1件の調査。読み取りだけ。
--
-- 使い方（予備系）
--   1. 下の payment_id を書き換える
--   2. cd infra\local
--      docker compose run --rm ops sql /v3/diag/payment-floating.sql
--
-- 何を見るか
--   payment-blocks.sql の C に並んだ支払（有効なのに、割り当てた実績がどの
--   文書にも付いていないもの）が、どうしてそうなったかを辿る。
--
--   実績が文書から外れる道は4つしかない。
--     1. 文書を無効にした        … document.void（その文書の実績を全部外す）
--     2. 訂正版を決定した        … document.supersede（新しい版へ移す。外れない）
--     3. 人が整理タブで外した    … condition.unlink_document
--     4. 計算書を作り直した      … 実績の付け替え
--   どれが起きたかは、実績の監査記録に残っている。
--
-- 口座も連絡先も引かない。

\set payment_id 42

SET search_path = v3;
\pset pager off
\pset border 0

\echo ''
\echo '=== 1. この支払 ========================================================'
\echo ''

SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       p.status AS "状態", p.direction AS "向き",
       p.amount AS "金額", p.tax_amount AS "消費税",
       p.due_on AS "期日", p.paid_on AS "支払日",
       p.created_at::date AS "作った日", p.legacy_id AS "移行元"
  FROM payments p
 WHERE p.id = :payment_id;

\echo ''
\echo '=== 2. 割り当て先の条件と実績 =========================================='
\echo '   「いまの文書」が空なら、その実績はどの文書にも付いていない。'
\echo ''

SELECT c.condition_no AS "条件", c.name AS "条件名",
       a.amount AS "割当額",
       e.id AS "実績", e.status AS "実績の状態",
       e.occurred_on AS "納品日", e.amount AS "実績の額",
       COALESCE(d.document_no, '（付いていない）') AS "いまの文書",
       d.status AS "その文書の状態"
  FROM payment_allocations a
  LEFT JOIN conditions c ON c.id = a.condition_id
  LEFT JOIN condition_events e ON e.id = a.event_id
  LEFT JOIN documents d ON d.id = e.document_id
 WHERE a.payment_id = :payment_id
 ORDER BY a.id;

\echo ''
\echo '=== 3. 支払を立てたときの文書は、いまどうなっているか =================='
\echo '   監査記録の detail.documentId を引く。ここが issued のままなのに'
\echo '   実績が外れているなら、人が整理タブで外したか、計算書で付け替えた。'
\echo ''

SELECT sd.document_no AS "立てたときの文書", sd.status AS "いまの状態",
       t.template_key AS "ひな形",
       (SELECT count(*) FROM condition_events x
         WHERE x.document_id = sd.id AND x.status = 'active') AS "いま載っている実績",
       sd.supersedes_id AS "差し替えた元",
       (SELECT x.document_no FROM documents x WHERE x.supersedes_id = sd.id
         ORDER BY x.id DESC LIMIT 1) AS "この文書を退かせた版"
  FROM audit_events a
  JOIN documents sd ON sd.id = (a.detail ->> 'documentId')::bigint
  LEFT JOIN document_template_versions tv ON tv.id = sd.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id
 WHERE a.target_type = 'payment' AND a.target_id = :payment_id
   AND a.action = 'payment.create' AND a.detail ? 'documentId';

\echo ''
\echo '=== 4. 実績に何が起きたか（ここが本題） ================================'
\echo '   condition.unlink_document があれば、人が整理タブで外した。'
\echo '   document.void があれば、文書を無効にしたときに外れた。'
\echo '   document.supersede は訂正版。これは外れず、新しい版へ移る。'
\echo ''

WITH mine AS (
  SELECT a.event_id FROM payment_allocations a
   WHERE a.payment_id = :payment_id AND a.event_id IS NOT NULL
)
SELECT ev.occurred_at AS "いつ", ev.actor AS "だれが", ev.action AS "何を",
       ev.target_type AS "対象", ev.target_id AS "対象id", ev.detail AS "中身"
  FROM audit_events ev
 WHERE
   -- 実績そのものを名指ししている記録
   (ev.detail ? 'eventId'
      AND (ev.detail ->> 'eventId')::bigint IN (SELECT event_id FROM mine))
   -- まとめて動かした記録（eventIds の配列）
   OR (ev.detail ? 'eventIds'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(ev.detail -> 'eventIds') x
                   WHERE x.value ~ '^[0-9]+$'
                     AND x.value::bigint IN (SELECT event_id FROM mine)))
   -- 文書の無効化・差し替えで外れた記録（releasedEvents / movedEvents）
   OR (ev.action IN ('document.void', 'document.supersede')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(ev.detail -> 'releasedEvents') = 'array'
                         THEN ev.detail -> 'releasedEvents' ELSE '[]'::jsonb END) r
                   WHERE (r ->> 'id')::bigint IN (SELECT event_id FROM mine)))
 ORDER BY ev.id;

\echo ''
\echo '=== 5. この条件には、いまどんな文書があるか ============================'
\echo '   実績を付け直す先の候補。検収書がもう出ているなら、そこへ戻す。'
\echo ''

WITH mine AS (
  SELECT DISTINCT a.condition_id FROM payment_allocations a
   WHERE a.payment_id = :payment_id AND a.condition_id IS NOT NULL
)
SELECT c.condition_no AS "条件", d.document_no AS "文書", t.template_key AS "ひな形",
       d.status AS "状態", d.issued_at::date AS "決定日",
       (SELECT count(*) FROM condition_events x
         WHERE x.document_id = d.id AND x.status = 'active') AS "載っている実績"
  FROM mine
  JOIN conditions c ON c.id = mine.condition_id
  JOIN document_conditions dc ON dc.condition_id = c.id
  JOIN documents d ON d.id = dc.document_id
  LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id
 ORDER BY c.condition_no, d.issued_at NULLS LAST, d.id;
