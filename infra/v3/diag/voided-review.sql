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
--     控えがある … 同じ相手・同じ発注・同じ明細の紙が有効なまま残っている
--     控えが無い … その組み合わせの紙はこれ1枚だけだった。戻すか、確かめる
--
--   比べるのは「誰あてに・どの発注から・何を」の3つ。文書番号と発行日は
--   1枚ごとに必ず違うので、指紋に入れない（入れると2枚が一致することが
--   原理的に無くなり、全部が「控えが無い」になる）。
--
--   ★ 理由の欄も見ること
--     「中身が無いため」「金額修正のため」のように、控えが無くても
--     無効のままでよいものがある。見立ては「戻せ」ではなく「確かめろ」。
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
WITH fp AS (
  -- 全文書の指紋。無効にした紙と、生きている紙を同じ物差しで比べる。
  SELECT d.id, d.status, md5(
           COALESCE(d.rendered_values ->> 'counterparty',
                    d.rendered_values ->> 'VENDOR_NAME', '')
           -- 発注元の紙。自分の番号が入っている文書があるので、そのときは
           -- 空として扱う（入れると1枚ごとに必ず違う指紋になる）。
           || '｜' || COALESCE(NULLIF(COALESCE(d.rendered_values ->> 'parent_po_number',
                                               d.rendered_values ->> 'ORDER_NO', ''),
                                      COALESCE(d.document_no, '')), '')
           || '｜' || COALESCE(d.matter_id::text, '')
           || '｜' || COALESCE((
                SELECT string_agg((li ->> 'item_name') || '=' ||
                         COALESCE(li ->> 'inspected_amount_ex_tax',
                                  li ->> 'amount_ex_tax', ''), '／' ORDER BY n)
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                              THEN d.rendered_values -> 'delivery_line_items'
                              WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                              THEN d.rendered_values -> 'items'
                              ELSE '[]'::jsonb END) WITH ORDINALITY AS t(li, n)), '')) AS key
    FROM v3.documents d
),
v AS (
  SELECT d.id, d.document_no, d.matter_id, d.issued_at, d.legacy_id,
         COALESCE(t.template_key, '（版が無い）') AS template_key,
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
       (SELECT count(*) FROM fp a JOIN fp b ON b.key = a.key
         WHERE a.id = v.id AND b.status <> 'void')       AS 控えの数,
       CASE
         WHEN (SELECT count(*) FROM fp a JOIN fp b ON b.key = a.key
                WHERE a.id = v.id AND b.status <> 'void') > 0
           THEN '控えがある。重複で正しい'
         ELSE '控えが無い。この相手・この発注・この明細の紙はこれだけ'
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
WITH fp AS (
  SELECT d.id, d.status, md5(
           COALESCE(d.rendered_values ->> 'counterparty',
                    d.rendered_values ->> 'VENDOR_NAME', '')
           -- 発注元の紙。自分の番号が入っている文書があるので、そのときは
           -- 空として扱う（入れると1枚ごとに必ず違う指紋になる）。
           || '｜' || COALESCE(NULLIF(COALESCE(d.rendered_values ->> 'parent_po_number',
                                               d.rendered_values ->> 'ORDER_NO', ''),
                                      COALESCE(d.document_no, '')), '')
           || '｜' || COALESCE(d.matter_id::text, '')
           || '｜' || COALESCE((
                SELECT string_agg((li ->> 'item_name') || '=' ||
                         COALESCE(li ->> 'inspected_amount_ex_tax',
                                  li ->> 'amount_ex_tax', ''), '／' ORDER BY n)
                  FROM jsonb_array_elements(
                         CASE WHEN jsonb_typeof(d.rendered_values -> 'delivery_line_items') = 'array'
                              THEN d.rendered_values -> 'delivery_line_items'
                              WHEN jsonb_typeof(d.rendered_values -> 'items') = 'array'
                              THEN d.rendered_values -> 'items'
                              ELSE '[]'::jsonb END) WITH ORDINALITY AS t(li, n)), '')) AS key
    FROM v3.documents d
),
v AS (
  SELECT d.id, d.document_no
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
 WHERE NOT EXISTS (SELECT 1 FROM fp a JOIN fp b ON b.key = a.key
                    WHERE a.id = v.id AND b.status <> 'void')
 ORDER BY v.document_no;

\echo ''
\echo '--- 中身を見るには ---------------------------------------------------'
\echo '  ops sql /v3/diag/document-detail.sql doc=<文書番号>'
\echo '  ops sql /v3/diag/documents-compare.sql docs=<番号>,<番号>'
\echo ''
