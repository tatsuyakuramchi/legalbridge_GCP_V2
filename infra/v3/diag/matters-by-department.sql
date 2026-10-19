-- =====================================================================
-- 部署ごとの案件と取引先（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   compliance-status.sql の「月別・部署別」の内訳。部署の決め方は同じで、
--   依頼者のメールで引いた担当者の部署 → 案件の担当者の部署の順。
--   法務部に入った案件が「法務部が自分で起こした」のか「依頼者が
--   担当者マスタに無くて担当（法務）の部署に落ちた」のかを、依頼者・
--   担当の列で見分ける。
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/matters-by-department.sql since=2026-09-27
--     部署で絞るとき（部分一致）:
--     docker compose run --rm ops sql /v3/diag/matters-by-department.sql since=2026-09-27 dept=法務
--
--     Cloud SQL Studio は \ で始まる行が効かない。先頭の \ の行を消して、
--     :'since' / :'until' / :'dept' を引用符ごと値に置き換えて流す。
-- =====================================================================

\pset pager off

\if :{?since}
\else
\set since '2026-09-27'
\endif
\if :{?until}
\else
\set until '9999-12-31'
\endif
\if :{?dept}
\else
\set dept ''
\endif

SET search_path = v3;

WITH m AS (
  SELECT mt.*,
         COALESCE(NULLIF(rs.department, ''), NULLIF(os.department, ''), '（部署なし）') AS 部署,
         CASE WHEN NULLIF(rs.department, '') IS NOT NULL THEN '依頼者'
              WHEN NULLIF(os.department, '') IS NOT NULL THEN '担当'
              ELSE '—' END                                  AS 部署の出どころ,
         rs.name                                            AS 依頼者名,
         os.name                                            AS 担当者名
    FROM matters mt
    LEFT JOIN staff os ON os.id = mt.owner_staff_id
    LEFT JOIN staff rs ON lower(rs.email) = lower(mt.requester_email)
   WHERE mt.created_at >= :'since'::date AND mt.created_at < :'until'::date + 1
     AND mt.merged_into_id IS NULL
),
-- 案件の取引先。案件に直に付いた相手先と、案件の文書が参照する条件の相手先
cp AS (
  SELECT m.id AS matter_id, p.name
    FROM m JOIN parties p ON p.id = m.counterparty_id
  UNION
  SELECT d.matter_id, p.name
    FROM documents d
    JOIN document_conditions dc ON dc.document_id = d.id
    JOIN conditions c           ON c.id = dc.condition_id
    JOIN parties p              ON p.id = c.counterparty_id
   WHERE d.matter_id IN (SELECT id FROM m)
)
SELECT m.部署,
       m.matter_no                                          AS 案件番号,
       m.title                                              AS 案件名,
       CASE m.kind WHEN 'outsourcing' THEN '業務委託' WHEN 'work' THEN '作品'
                   ELSE '単発' END                           AS 種別,
       COALESCE(string_agg(DISTINCT cp.name, '、'), '（未登録）') AS 取引先,
       m.created_at::date                                   AS 作成日,
       m.部署の出どころ,
       COALESCE(m.依頼者名, NULLIF(m.requester_email, ''), '—') AS 依頼者,
       COALESCE(m.担当者名, '—')                              AS 担当
  FROM m
  LEFT JOIN cp ON cp.matter_id = m.id
 WHERE :'dept' = '' OR m.部署 LIKE '%' || :'dept' || '%'
 GROUP BY m.id, m.部署, m.matter_no, m.title, m.kind, m.created_at,
          m.部署の出どころ, m.依頼者名, m.requester_email, m.担当者名
 ORDER BY m.部署, m.created_at;
