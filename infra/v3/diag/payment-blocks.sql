-- 支払が検収書・計算書を止めている件の調査（全体の見取り）。読み取りだけ。
--
-- 使い方（予備系）
--   cd infra\local
--   docker compose run --rm ops sql /v3/diag/payment-blocks.sql
--
-- 1件だけ詳しく見たいときは payment-block.sql のほうを使う。
--
-- なぜこれが要るか
--   payments は文書への列を持たない。支払と検収書の繋がりは
--     payment_allocations.event_id → condition_events.document_id
--   という辿り方しかなく、この document_id は動く。
--     ・訂正版を決定すると、実績は新しい版へ移る
--     ・元の文書を無効にすると、実績は外れる（支払は残る）
--   だから「いま辿れる文書」は「支払を立てたときの文書」とは限らない。
--   立てたときの文書は監査記録にだけ残っているので、両方を並べて食い違いを見る。
--
-- 口座も連絡先も引かない（この調査に要らない）。

SET search_path = v3;

-- PowerShell の窓では、横に広い表が折り返されて読めなくなる。
-- ページャを止めて、1行を縦に並べる（行ごとに「欄：値」で出る）。
\pset pager off
\pset border 0


\echo ''
\echo '=== A. いま開くと「すでに支払があります」で止まる文書 ==================='
\echo '   決定済みの検収書・計算書のうち、載っている実績に取消済みでない支払の'
\echo '   割当があるもの。これが画面に出るエラーの母集団。'
\echo ''

SELECT d.document_no AS "文書",
       t.template_key AS "ひな形",
       d.status AS "文書の状態",
       count(DISTINCT e.id) AS "載っている実績",
       string_agg(DISTINCT COALESCE(p.payment_no, '#' || p.id::text)
                  || '(' || p.status || ')', '・') AS "止めている支払"
  FROM documents d
  JOIN document_template_versions tv ON tv.id = d.template_version_id
  JOIN document_templates t ON t.id = tv.template_id
  JOIN condition_events e ON e.document_id = d.id AND e.status = 'active'
  JOIN payment_allocations a ON a.event_id = e.id
  JOIN payments p ON p.id = a.payment_id AND p.status <> 'canceled'
 WHERE d.status = 'issued'
   AND t.template_key IN ('inspection_certificate', 'royalty_statement')
 GROUP BY d.document_no, t.template_key, d.status
 ORDER BY d.document_no;

\echo ''
\echo '=== B. 支払の出どころと、実績のいまの居場所の食い違い ==================='
\echo '   「立てたときの文書」は監査記録（payment.create の detail.documentId）。'
\echo '   documentId が無いものは、条件に宛てて立てた支払か、移行した支払。'
\echo '   見立てが「そろっている」以外のものだけを出す（そろっているものは数だけ）。'
\echo ''

WITH src AS (
  SELECT DISTINCT ON (a.target_id)
         a.target_id AS payment_id,
         (a.detail ->> 'documentId')::bigint AS from_doc_id,
         a.detail ? 'conditionId' AS from_condition
    FROM audit_events a
   WHERE a.target_type = 'payment' AND a.action = 'payment.create'
   ORDER BY a.target_id, a.id
), now_at AS (
  SELECT al.payment_id,
         string_agg(DISTINCT COALESCE(nd.document_no, '（どの文書にも付いていない）')
                    || CASE WHEN nd.status IS NULL THEN '' ELSE '(' || nd.status || ')' END, '・') AS now_docs
    FROM payment_allocations al
    LEFT JOIN condition_events ne ON ne.id = al.event_id
    LEFT JOIN documents nd ON nd.id = ne.document_id
   WHERE al.event_id IS NOT NULL
   GROUP BY al.payment_id
)
SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       p.status AS "状態", p.amount AS "金額", p.due_on AS "期日",
       CASE WHEN src.from_doc_id IS NOT NULL THEN sd.document_no
            WHEN src.from_condition THEN '（条件に宛てて立てた）'
            ELSE '（記録なし。移行した支払）' END AS "立てたときの文書",
       sd.status AS "その文書のいま",
       now_at.now_docs AS "実績がいま付いている文書",
       CASE
         -- 文書から立てた支払
         WHEN src.from_doc_id IS NOT NULL AND sd.status IS DISTINCT FROM 'issued'
           THEN '出どころの文書がもう有効でない'
         WHEN src.from_doc_id IS NOT NULL AND now_at.now_docs IS NULL
           THEN '実績がどの文書にも付いていない'
         WHEN src.from_doc_id IS NOT NULL
              AND now_at.now_docs NOT LIKE '%' || sd.document_no || '%'
           THEN '出どころと違う文書に付いている'
         WHEN src.from_doc_id IS NOT NULL THEN 'そろっている'
         -- 条件に宛てて立てた支払。文書の実績に重なっていれば、その文書を止める
         WHEN src.from_condition AND now_at.now_docs IS NOT NULL
           THEN '条件宛てだが、文書の実績に重なっている'
         WHEN src.from_condition THEN '条件宛て（文書は元から無い）'
         -- 移行した支払。立てた経緯が V3 に無い
         WHEN now_at.now_docs IS NOT NULL THEN '移行した支払が、文書の実績に重なっている'
         ELSE '移行した支払（経緯を辿れない）'
       END AS "見立て"
  FROM payments p
  LEFT JOIN src ON src.payment_id = p.id
  LEFT JOIN documents sd ON sd.id = src.from_doc_id
  LEFT JOIN now_at ON now_at.payment_id = p.id
 WHERE p.status <> 'canceled'
   -- そろっているものは出さない。実データで 40 行出て、肝心の食い違いが
   -- ページャに流れて読めなかった。
   AND NOT (src.from_doc_id IS NOT NULL
            AND sd.status = 'issued'
            AND now_at.now_docs IS NOT NULL
            AND now_at.now_docs LIKE '%' || sd.document_no || '%')
 ORDER BY p.id;

\echo ''
\echo '   （そろっているものの件数）'

SELECT count(*) AS "そろっている支払"
  FROM payments p
  JOIN audit_events a ON a.target_type = 'payment' AND a.target_id = p.id
                     AND a.action = 'payment.create' AND a.detail ? 'documentId'
  JOIN documents sd ON sd.id = (a.detail ->> 'documentId')::bigint AND sd.status = 'issued'
 WHERE p.status <> 'canceled'
   AND EXISTS (SELECT 1 FROM payment_allocations al
                 JOIN condition_events ne ON ne.id = al.event_id
                WHERE al.payment_id = p.id AND ne.document_id = sd.id);

\echo ''
\echo '=== C. 宙に浮いた割当 =================================================='
\echo '   取消済みでない支払なのに、割り当てた実績がどの文書にも付いていないもの。'
\echo '   元の文書を無効にすると実績が外れ、支払だけが残る（無効化は支払に触らない）。'
\echo '   ここに並ぶものが「有効な検収書と紐づいていない支払」。'
\echo ''

SELECT COALESCE(p.payment_no, '#' || p.id::text) AS "支払",
       p.status AS "状態", p.amount AS "金額", p.due_on AS "期日",
       c.condition_no AS "条件", c.name AS "条件名",
       e.id AS "実績", e.occurred_on AS "実績の日", e.amount AS "実績の額",
       e.status AS "実績の状態"
  FROM payments p
  JOIN payment_allocations a ON a.payment_id = p.id
  JOIN condition_events e ON e.id = a.event_id
  LEFT JOIN conditions c ON c.id = a.condition_id
 WHERE p.status <> 'canceled' AND e.document_id IS NULL
 ORDER BY p.id, e.id;

\echo ''
\echo '=== D. 取消済みでない支払の内訳（母数の確認） =========================='
\echo ''

SELECT p.status AS "状態", count(*) AS "件数",
       count(*) FILTER (WHERE p.payment_no IS NULL) AS "番号なし（移行）"
  FROM payments p
 GROUP BY p.status
 ORDER BY p.status;
