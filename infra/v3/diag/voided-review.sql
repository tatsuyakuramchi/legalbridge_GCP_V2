-- =====================================================================
-- 無効にした文書を見直す（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   無効化は「相手に出した紙を無かったことにする」操作なので、
--   取り違えると記録が消える。重複だと思って畳んだ紙が、実は別の相手に
--   出した唯一の紙だった、ということが起きる（実際に3枚起きた）。
--
--   ここは無効にした文書を並べ、1枚ずつ「控えがあるか」を見る。
--     控えがある … 同じ本文の紙が有効なまま残っている。重複で正しい
--     控えが無い … その内容の紙はこれ1枚だけだった。戻すか、確かめる
--
--   ★ 使い方
--     docker compose run --rm ops sql /v3/diag/voided-review.sql
--     docker compose run --rm ops sql /v3/diag/voided-review.sql m=MTR-2026-00216
--     docker compose run --rm ops sql /v3/diag/voided-review.sql since=2026-09-01
--
--   ★ 戻すとき
--     Invoke-RestMethod -Method Post -Uri ".../api/v3/documents/<id>/unvoid" ...
--     無効にしたときに解放した実績も一緒に戻る。
-- =====================================================================

\pset pager off

\if :{?m}
\else
\set m ''
\endif
\if :{?since}
\else
\set since '2000-01-01'
\endif

-- ---------------------------------------------------------------------
-- 1. 無効にした文書。控えがあるかどうかで仕分ける
-- ---------------------------------------------------------------------
WITH v AS (
  SELECT d.id, d.document_no, d.matter_id, d.issued_at, d.legacy_id,
         COALESCE(t.template_key, '（版が無い）') AS template_key,
         md5(((d.rendered_values - 'items') - 'delivery_line_items')::text) AS head,
         COALESCE(d.rendered_values ->> 'counterparty',
                  d.rendered_values ->> 'VENDOR_NAME', '—')                 AS party,
         COALESCE(d.rendered_values ->> 'parent_po_number',
                  d.rendered_values ->> 'ORDER_NO', '')                     AS po
    FROM v3.documents d
    LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
    LEFT JOIN v3.document_templates t ON t.id = tv.template_id
    LEFT JOIN v3.matters mm ON mm.id = d.matter_id
   WHERE d.status = 'void'
     AND (:'m' = '' OR mm.matter_no = :'m')
),
last_void AS (
  SELECT DISTINCT ON (a.target_id)
         a.target_id, a.occurred_at, a.actor, a.detail ->> 'reason' AS reason
    FROM v3.audit_events a
   WHERE a.action = 'document.void' AND a.target_type = 'document'
   ORDER BY a.target_id, a.id DESC
)
SELECT v.document_no                                     AS 文書番号,
       v.id                                              AS 文書id,
       v.template_key                                    AS ひな形,
       v.issued_at::date                                 AS 発行日,
       m.matter_no                                       AS 案件番号,
       v.party                                           AS 相手,
       NULLIF(v.po, '')                                  AS 発注番号,
       lv.occurred_at::date                               AS 無効にした日,
       left(COALESCE(lv.reason, ''), 40)                 AS 理由,
       (SELECT count(*) FROM v3.documents x
         WHERE x.status <> 'void'
           AND md5(((x.rendered_values - 'items') - 'delivery_line_items')::text) = v.head)  AS 同じ本文の有効な紙,
       CASE
         WHEN (SELECT count(*) FROM v3.documents x
                WHERE x.status <> 'void'
                  AND md5(((x.rendered_values - 'items') - 'delivery_line_items')::text) = v.head) > 0
           THEN '控えがある。重複で正しい'
         ELSE '控えが無い。この内容の紙はこれだけ。戻すか確かめる'
       END                                               AS 見立て
  FROM v
  LEFT JOIN v3.matters m ON m.id = v.matter_id
  LEFT JOIN last_void lv ON lv.target_id = v.id
 WHERE COALESCE(lv.occurred_at::date, v.issued_at::date, DATE '2000-01-01') >= :'since'::date
 ORDER BY lv.occurred_at DESC NULLS LAST, v.document_no;

-- ---------------------------------------------------------------------
-- 2. 控えが無いものだけ。戻すコマンドを組み立てる
--
--    見立てが「控えが無い」の紙だけを対象にする。中身を見て、戻すものを
--    選んでから貼る（全部戻すとは限らない。中身が空の紙は無効のままでよい）。
-- ---------------------------------------------------------------------
\pset format unaligned
\pset tuples_only on

\echo ''
\echo '--- 控えが無い文書を戻すコマンド。中身を見てから、戻すものだけ貼る ----'
WITH v AS (
  SELECT d.id, d.document_no,
         md5(((d.rendered_values - 'items') - 'delivery_line_items')::text) AS head
    FROM v3.documents d
    LEFT JOIN v3.matters mm ON mm.id = d.matter_id
   WHERE d.status = 'void'
     AND (:'m' = '' OR mm.matter_no = :'m')
)
SELECT format(
         '# %s' || E'\n'
         || 'Invoke-RestMethod -Method Post -Uri'
         || ' "http://localhost:8080/api/v3/documents/%s/unvoid"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body ([Text.Encoding]::UTF8.GetBytes(''{"reason":"重複ではなかったため戻す"}''))',
         v.document_no, v.id)
  FROM v
 WHERE NOT EXISTS (SELECT 1 FROM v3.documents x
                    WHERE x.status <> 'void'
                      AND md5(((x.rendered_values - 'items') - 'delivery_line_items')::text) = v.head)
 ORDER BY v.document_no;

\echo ''
\echo '--- 中身を見るには ---------------------------------------------------'
\echo '  ops sql /v3/diag/document-detail.sql doc=<文書番号>'
\echo '  ops sql /v3/diag/documents-compare.sql docs=<番号>,<番号>'
\echo ''
