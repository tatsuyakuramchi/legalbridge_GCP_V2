-- =====================================================================
-- 条件が「検収書の明細に出ない」ときの当たりを付ける（読むだけ）
--
--   検収書は実績（condition_events）1件が明細1行になる。実績が無い条件は
--   1行も出ない。行の発注番号は、その条件に紐づく発注書から引く。
--
--   下の condition_no を見たい条件に書き換えて流す。
--   ローカル版なら:
--     docker compose exec db psql -U postgres legalbridge -f /v3/095_diagnose_condition.sql
-- =====================================================================
\set ON_ERROR_STOP on

WITH target AS (
  SELECT id, condition_no, name, status, pricing_model, flat_amount
    FROM v3.conditions
   WHERE condition_no IN ('CL-2026-00410', 'CL-2026-00411')   -- ★ ここを書き換える
)
SELECT t.condition_no AS 条件,
       t.status       AS 状態,
       t.pricing_model AS 課金,
       -- 明細に出せる実績（取り消したものは出ない）
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = t.id AND e.status = 'active')        AS 使える実績,
       -- すでに別の文書で使った実績（選べない）
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = t.id AND e.status = 'active'
           AND e.document_id IS NOT NULL)                            AS 文書済みの実績,
       -- 取り消した実績（画面に出ない）
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = t.id AND e.status <> 'active')       AS 取り消した実績,
       -- 予定（実績はここから作れる）
       (SELECT count(*) FROM v3.condition_schedules s
         WHERE s.condition_id = t.id)                                AS 予定,
       -- 行の発注番号の出どころ
       (SELECT string_agg(DISTINCT d.document_no, '・')
          FROM v3.document_conditions dc
          JOIN v3.documents d  ON d.id = dc.document_id
          JOIN v3.document_template_versions v ON v.id = d.template_version_id
          JOIN v3.document_templates tp ON tp.id = v.template_id
         WHERE dc.condition_id = t.id
           AND tp.template_key IN ('purchase_order', 'intl_purchase_order')) AS 発注書,
       t.name AS 名称
  FROM target t
 ORDER BY t.condition_no;
