-- =====================================================================
-- 下請法（取適法）遵守体制の稼働状況（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   内部監査（2026-06末の指摘②）への報告用。V3 へ切り替えた日からの
--   利用状況・支払期日の遵守状況・定期ジョブの動きを数字で出す。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/compliance-status.sql since=2026-09-27
--
--     Cloud SQL Studio は \ で始まる行が効かない。先頭の \ の行を消して、
--     :'since' を '2026-09-27' のように（引用符ごと）置き換えて流す。
--
--   ★ 読み方の注意
--     - 「取適法の対象」はシステム上は個人（parties.kind = 'individual'）だけ。
--       法人は資本金・従業員数を持っていないので判定できず、参考値として出す。
--     - 部署は依頼者のメールで引いた担当者の部署 → 案件の担当者の部署の順。
--       どちらも引けない案件は「（部署なし）」に入る。
--     - 支払の種類は割り当てた条件の種類で決める。業務委託（役務・製品）を
--       含めば「業務委託」、ライセンスだけなら「印税・許諾料」。60日の検査は
--       システム上は種類を問わず掛かるので、監査の説明では業務委託の行を見る。
-- =====================================================================

\pset pager off

\if :{?since}
\else
\set since '2026-09-27'
\endif

SET search_path = v3;

-- ---------------------------------------------------------------------
-- 1. 要約（1行）。Excel の1セルに書く数字はここから取る
-- ---------------------------------------------------------------------
WITH out_pay AS (
  SELECT p.*, pt.kind AS party_kind,
         (SELECT CASE
                 WHEN bool_or(c.kind IN ('service', 'product')) THEN '業務委託'
                 WHEN bool_and(c.kind = 'license')              THEN '印税・許諾料'
                 WHEN count(c.id) = 0                           THEN '割当なし'
                 ELSE 'その他（経費・手数料）'
               END
          FROM payment_allocations a JOIN conditions c ON c.id = a.condition_id
         WHERE a.payment_id = p.id) AS pay_kind,
         CASE
           WHEN p.basis_received_on IS NULL OR p.due_on IS NULL THEN 'unset'
           WHEN p.due_on - p.basis_received_on > 60          THEN 'over_limit'
           ELSE 'ok'
         END AS verdict
    FROM payments p
    JOIN parties pt ON pt.id = p.party_id
   WHERE p.direction = 'out' AND p.status <> 'canceled'
     AND p.created_at >= :'since'::date
),
po AS (
  SELECT d.*
    FROM documents d
    JOIN document_template_versions v ON v.id = d.template_version_id
    JOIN document_templates t         ON t.id = v.template_id
   WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
     AND d.status IN ('issued', 'superseded')
     AND d.issued_at >= :'since'::date
)
SELECT :'since'::date                                                         AS 集計開始日,
       current_date                                                           AS 集計日,
       (SELECT count(*) FROM matters WHERE created_at >= :'since'::date
                                       AND merged_into_id IS NULL)             AS 案件数,
       (SELECT count(*) FROM matters WHERE created_at >= :'since'::date
                                       AND merged_into_id IS NULL
                                       AND kind = 'outsourcing')               AS うち業務委託,
       (SELECT count(*) FROM intake_requests WHERE created_at >= :'since'::date) AS 受付件数,
       (SELECT count(*) FROM po)                                              AS 発注書発行数,
       (SELECT count(*) FROM documents WHERE status IN ('issued', 'superseded')
                                         AND issued_at >= :'since'::date)      AS 文書発行数,
       (SELECT count(*) FROM out_pay)                                         AS 外注支払数,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'individual')         AS うち個人,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'individual' AND verdict = 'ok')         AS 個人_期日適合,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'individual' AND verdict = 'over_limit') AS 個人_期日超過,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'individual' AND verdict = 'unset')      AS 個人_期日未設定,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'individual' AND verdict = 'over_limit'
                                       AND pay_kind = '業務委託')                                 AS うち業務委託の超過,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'corporate'  AND verdict = 'over_limit') AS 法人_期日超過_参考,
       (SELECT count(*) FROM out_pay WHERE party_kind = 'corporate'  AND verdict = 'unset')      AS 法人_期日未設定_参考,
       (SELECT count(*) FROM out_pay WHERE status <> 'paid' AND due_on < current_date)          AS 期日経過の未払,
       (SELECT count(*) FROM data_quality_issues
         WHERE rule_code = 'PAYMENT_DUE_OVER_LIMIT' AND status = 'open')       AS 期日超過の未解決記録,
       (SELECT count(*) FROM data_quality_issues
         WHERE severity = 'high' AND status = 'open')                          AS 品質high未解決,
       (SELECT max(occurred_at) FROM audit_events WHERE action = 'job.daily')          AS 日次点検_最終実行,
       (SELECT max(occurred_at) FROM audit_events WHERE action = 'job.delivery_alert') AS 納期アラート_最終実行;

-- ---------------------------------------------------------------------
-- 2. 月別・部署別の利用状況。全社に使われているかを見る
-- ---------------------------------------------------------------------
WITH m AS (
  SELECT mt.id, mt.kind,
         date_trunc('month', mt.created_at)::date AS 月,
         COALESCE(NULLIF(rs.department, ''), NULLIF(os.department, ''), '（部署なし）') AS 部署
    FROM matters mt
    LEFT JOIN staff os ON os.id = mt.owner_staff_id
    LEFT JOIN staff rs ON lower(rs.email) = lower(mt.requester_email)
   WHERE mt.created_at >= :'since'::date AND mt.merged_into_id IS NULL
),
po AS (
  SELECT d.matter_id, count(*) AS n
    FROM documents d
    JOIN document_template_versions v ON v.id = d.template_version_id
    JOIN document_templates t         ON t.id = v.template_id
   WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
     AND d.status IN ('issued', 'superseded')
   GROUP BY d.matter_id
)
SELECT m.月, m.部署,
       count(*)                                          AS 案件数,
       count(*) FILTER (WHERE m.kind = 'outsourcing')    AS 業務委託,
       COALESCE(sum(po.n), 0)                            AS 発注書
  FROM m
  LEFT JOIN po ON po.matter_id = m.id
 GROUP BY m.月, m.部署
 ORDER BY m.月 DESC, 案件数 DESC;

-- 依頼（受付箱）の月別・依頼部署別。案件にしなかった依頼も数える
SELECT date_trunc('month', r.created_at)::date              AS 月,
       COALESCE(NULLIF(s.department, ''), '（部署なし）')    AS 依頼部署,
       count(*)                                            AS 依頼数,
       count(*) FILTER (WHERE r.state = 'accepted')        AS 受付済
  FROM intake_requests r
  -- 依頼者はメールか Slack の ID で引く。二人当たっても1行に絞る
  LEFT JOIN LATERAL (
    SELECT department FROM staff st
     WHERE lower(st.email) = lower(r.requester_email)
        OR (st.slack_user_id IS NOT NULL AND st.slack_user_id = r.requester_slack_id)
     ORDER BY (lower(st.email) = lower(r.requester_email)) DESC NULLS LAST, st.id
     LIMIT 1) s ON true
 WHERE r.created_at >= :'since'::date
 GROUP BY 1, 2
 ORDER BY 1 DESC, 依頼数 DESC;

-- ---------------------------------------------------------------------
-- 3. 支払期日の判定別（個人／法人 × 判定）
-- ---------------------------------------------------------------------
SELECT CASE pt.kind WHEN 'individual' THEN '個人（取適法の対象）' ELSE '法人（参考）' END AS 区分,
       (SELECT CASE
                 WHEN bool_or(c.kind IN ('service', 'product')) THEN '業務委託'
                 WHEN bool_and(c.kind = 'license')              THEN '印税・許諾料'
                 WHEN count(c.id) = 0                           THEN '割当なし'
                 ELSE 'その他（経費・手数料）'
               END
          FROM payment_allocations a JOIN conditions c ON c.id = a.condition_id
         WHERE a.payment_id = p.id) AS 種類,
       CASE
         WHEN p.basis_received_on IS NULL OR p.due_on IS NULL THEN '期日未設定'
         WHEN p.due_on - p.basis_received_on > 60          THEN '期日超過'
         ELSE '適合'
       END                                               AS 判定,
       count(*)                                          AS 件数,
       sum(p.amount)                                     AS 金額_税抜,
       max(p.due_on - p.basis_received_on)               AS 最長日数
  FROM payments p
  JOIN parties pt ON pt.id = p.party_id
 WHERE p.direction = 'out' AND p.status <> 'canceled'
   AND p.created_at >= :'since'::date
 GROUP BY 1, 2, 3
 ORDER BY 1 DESC, 2, 3;

-- ---------------------------------------------------------------------
-- 4. 期日超過・期日未設定の支払の明細（個人を先に）
-- ---------------------------------------------------------------------
SELECT p.payment_no                                      AS 支払番号,
       pt.name                                           AS 相手先,
       CASE pt.kind WHEN 'individual' THEN '個人' ELSE '法人' END AS 区分,
       (SELECT CASE
                 WHEN bool_or(c.kind IN ('service', 'product')) THEN '業務委託'
                 WHEN bool_and(c.kind = 'license')              THEN '印税・許諾料'
                 WHEN count(c.id) = 0                           THEN '割当なし'
                 ELSE 'その他（経費・手数料）'
               END
          FROM payment_allocations a JOIN conditions c ON c.id = a.condition_id
         WHERE a.payment_id = p.id) AS 種類,
       p.amount                                          AS 税抜,
       p.basis_received_on                               AS 受領日,
       p.due_on                                          AS 期日,
       p.due_on - p.basis_received_on                    AS 日数,
       p.status                                          AS 状態
  FROM payments p
  JOIN parties pt ON pt.id = p.party_id
 WHERE p.direction = 'out' AND p.status <> 'canceled'
   AND p.created_at >= :'since'::date
   AND (p.basis_received_on IS NULL OR p.due_on IS NULL
        OR p.due_on - p.basis_received_on > 60)
 ORDER BY (pt.kind = 'individual') DESC, 日数 DESC NULLS LAST;

-- ---------------------------------------------------------------------
-- 5. 発注書の無い外注支払。システムを通さずに発注した可能性がある
--    種類が「業務委託」の行が確認の対象。印税・許諾料は計算書で払うので
--    発注書が無くて正しい
-- ---------------------------------------------------------------------
SELECT p.payment_no                                      AS 支払番号,
       pt.name                                           AS 相手先,
       (SELECT CASE
                 WHEN bool_or(c.kind IN ('service', 'product')) THEN '業務委託'
                 WHEN bool_and(c.kind = 'license')              THEN '印税・許諾料'
                 WHEN count(c.id) = 0                           THEN '割当なし'
                 ELSE 'その他（経費・手数料）'
               END
          FROM payment_allocations a JOIN conditions c ON c.id = a.condition_id
         WHERE a.payment_id = p.id) AS 種類,
       p.amount                                          AS 税抜,
       p.created_at::date                                AS 登録日,
       string_agg(DISTINCT c.condition_no, ', ')         AS 条件,
       COALESCE(NULLIF(p.note, ''), '')                  AS メモ
  FROM payments p
  JOIN parties pt ON pt.id = p.party_id
  LEFT JOIN payment_allocations a ON a.payment_id = p.id
  LEFT JOIN conditions c          ON c.id = a.condition_id
 WHERE p.direction = 'out' AND p.status <> 'canceled'
   AND p.created_at >= :'since'::date
   AND NOT EXISTS (
     SELECT 1
       FROM payment_allocations a2
       JOIN document_conditions dc       ON dc.condition_id = a2.condition_id
       JOIN documents d                  ON d.id = dc.document_id
       JOIN document_template_versions v ON v.id = d.template_version_id
       JOIN document_templates t         ON t.id = v.template_id
      WHERE a2.payment_id = p.id
        AND t.template_key IN ('purchase_order', 'intl_purchase_order')
        AND d.status IN ('issued', 'superseded'))
 GROUP BY p.id, p.payment_no, pt.name, p.amount, p.created_at, p.note
 ORDER BY p.created_at DESC;

-- ---------------------------------------------------------------------
-- 6. データ品質の未解決（ルール別）。移行時の high 304件の残りもここに出る
-- ---------------------------------------------------------------------
SELECT rule_code                                         AS ルール,
       severity                                          AS 重大度,
       count(*) FILTER (WHERE status = 'open')           AS 未解決,
       count(*) FILTER (WHERE status = 'resolved')       AS 解決,
       count(*) FILTER (WHERE status = 'ignored')        AS 対象外とした,
       max(detected_at)::date                            AS 最終検出
  FROM data_quality_issues
 GROUP BY rule_code, severity
 ORDER BY (severity = 'high') DESC, 未解決 DESC;

-- ---------------------------------------------------------------------
-- 7. 定期ジョブの実行記録（直近14日）。空の行があれば止まっている
-- ---------------------------------------------------------------------
SELECT action                                            AS ジョブ,
       occurred_at::date                                 AS 日,
       count(*)                                          AS 回数,
       max(occurred_at)                                  AS 最終
  FROM audit_events
 WHERE action LIKE 'job.%'
   AND occurred_at >= current_date - 14
 GROUP BY action, occurred_at::date
 ORDER BY action, 日 DESC;
