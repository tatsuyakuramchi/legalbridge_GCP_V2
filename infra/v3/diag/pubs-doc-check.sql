-- =====================================================================
-- 出版等利用許諾条件書（作品ごとに番号）の中身の確認（読むだけ。何も書き換えない）
--
--   備考に取り分（「紙 取り分 10.3125%（全体 11%）」）が出ない・料率が空欄になる、の原因を見る。
--     ① 文書：ひな形と版（備考に取り分を出すのは 207 で入れた版から）
--     ② 文書に載っている条件明細：料率・按分（取り分）の有無・許諾者の取り分
--        取り分が出る条件：料率がある × 按分がある（その条件の系列に condition_shares がある）
--        「許諾者の取り分」は、按分の相手先のうち条件明細の相手先（許諾者）と同じ取引先の分
--     ③ 料率のそろい：紙・電子それぞれ、作品で料率が 1 つにそろっていないと、紙の「料率（ ）」が空欄になる
--     ④ 文書に控えた一覧の行（画面で直した行）：条件明細と結び付いているか
--     ⑤ 作品ごと：「共同著作・第三者権利」欄が「あり」になる元（按分か、作品に書いた第三者権利か）
--
--   ★ 使い方（予備系。infra\local で）
--       docker compose run --rm ops sql /v3/diag/pubs-doc-check.sql doc=ARC-PUBS-2026-9001
-- =====================================================================

\pset pager off
\if :{?doc}
\else
  \echo '文書番号を doc=… で渡してください（例: doc=ARC-PUBS-2026-9001）'
  \quit
\endif

\echo
\echo '① 文書（ひな形と版）'
SELECT d.id, d.document_no AS 文書番号, d.status AS 状態, t.template_key AS ひな形, tv.version_no AS 版,
       (SELECT max(v2.version_no) FROM v3.document_template_versions v2 WHERE v2.template_id = t.id) AS 最新の版,
       a.agreement_no AS 載っている契約, d.issued_at::date AS 決定日
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.agreements a ON a.id = d.agreement_id
 WHERE d.document_no = :'doc';

CREATE TEMP TABLE doc_conds ON COMMIT PRESERVE ROWS AS
SELECT c.*, COALESCE(c.series_id, c.id) AS series
  FROM v3.documents d
  JOIN v3.document_conditions dc ON dc.document_id = d.id
  JOIN v3.conditions c ON c.id = dc.condition_id
 WHERE d.document_no = :'doc';

-- 按分は、改訂の系列でいちばん新しい版に付いたもの（アプリと同じ決まり）。
CREATE TEMP TABLE doc_shares ON COMMIT PRESERVE ROWS AS
WITH latest AS (
  SELECT c.id AS wanted_id, max(s.condition_id) AS condition_id
    FROM doc_conds c
    JOIN v3.conditions x ON COALESCE(x.series_id, x.id) = c.series
    JOIN v3.condition_shares s ON s.condition_id = x.id
   GROUP BY c.id
)
SELECT l.wanted_id, s.party_id, p.name, s.share_ppm, s.sort_order, s.id
  FROM latest l
  JOIN v3.condition_shares s ON s.condition_id = l.condition_id
  JOIN v3.parties p ON p.id = s.party_id;

\echo
\echo '② 文書に載っている条件明細（料率・按分・許諾者の取り分）'
SELECT a.agreement_no AS 個別契約, c.condition_no AS 条件番号, left(COALESCE(w.title, c.name), 28) AS 作品,
       c.usage_type AS 利用形態, c.status AS 状態,
       CASE WHEN c.rate_ppm IS NULL THEN '×なし' ELSE (c.rate_ppm / 10000.0)::numeric(7,4)::text || '%' END AS 料率,
       (SELECT count(*) FROM doc_shares s WHERE s.wanted_id = c.id) AS 按分の数,
       COALESCE((SELECT (s.share_ppm / 10000.0)::numeric(7,4)::text || '%' FROM doc_shares s
                  WHERE s.wanted_id = c.id AND s.party_id = c.counterparty_id LIMIT 1),
                CASE WHEN EXISTS (SELECT 1 FROM doc_shares s WHERE s.wanted_id = c.id) THEN '×許諾者の分なし' ELSE '—' END) AS 許諾者の取り分,
       (SELECT string_agg(left(s.name, 10) || ' ' || (s.share_ppm / 10000.0)::numeric(7,4)::text || '%', '・' ORDER BY s.sort_order, s.id)
          FROM doc_shares s WHERE s.wanted_id = c.id) AS 按分の相手,
       CASE WHEN c.rate_ppm IS NULL THEN '料率が無い → 取り分は出ない'
            WHEN NOT EXISTS (SELECT 1 FROM doc_shares s WHERE s.wanted_id = c.id) THEN '按分が無い → 取り分は出ない'
            WHEN NOT EXISTS (SELECT 1 FROM doc_shares s WHERE s.wanted_id = c.id AND s.party_id = c.counterparty_id) THEN '取り分 0% で出る'
            ELSE '○ 取り分が出る' END AS 備考の取り分
  FROM doc_conds c
  LEFT JOIN v3.agreements a ON a.id = c.agreement_id
  LEFT JOIN v3.works w ON w.id = c.work_id
 ORDER BY a.agreement_no NULLS LAST, c.usage_type, c.id;

\echo
\echo '③ 料率のそろい（紙・電子それぞれ 1 つにそろっていないと、紙の「料率（ ）」が空欄になる）'
SELECT c.usage_type AS 利用形態,
       CASE WHEN c.rate_ppm IS NULL THEN 'なし' ELSE (c.rate_ppm / 10000.0)::numeric(7,4)::text || '%' END AS 料率,
       count(*) AS 条件の数,
       string_agg(DISTINCT right(a.agreement_no, 4), '・') AS 個別契約の末尾
  FROM doc_conds c LEFT JOIN v3.agreements a ON a.id = c.agreement_id
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo
\echo '④ 文書に控えた一覧の行（空なら、条件明細からそのまま組んでいる）'
SELECT r.ord AS 行, left(COALESCE(r.row ->> 'title', r.row ->> 'item_name'), 28) AS 作品,
       r.row ->> 'print_condition_id' AS 紙の条件id, r.row ->> 'digital_condition_id' AS 電子の条件id,
       CASE WHEN EXISTS (SELECT 1 FROM doc_conds c
                          WHERE c.id::text IN (r.row ->> 'print_condition_id', r.row ->> 'digital_condition_id'))
            THEN '○ 条件と結び付く' ELSE '× 結び付かない（題名で引き直す）' END AS 結び付き,
       r.row ->> 'print_rate' AS 行の紙料率, r.row ->> 'digital_rate' AS 行の電子料率,
       left(r.row ->> 'co_authors', 30) AS 行の共同著作, left(r.row ->> 'note', 30) AS 行の備考
  FROM v3.documents d,
       LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.manual_inputs -> 'pub_titles') = 'array'
                                         THEN d.manual_inputs -> 'pub_titles' ELSE '[]'::jsonb END) WITH ORDINALITY AS r(row, ord)
 WHERE d.document_no = :'doc'
 ORDER BY r.ord;

\echo
\echo '⑤ 作品ごと：「共同著作・第三者権利」欄が「あり」になる元（按分があるか、作品に第三者権利が書いてあるか）'
SELECT DISTINCT left(w.title, 34) AS 作品, left(to_jsonb(w) ->> 'copyright_notice', 24) AS 著作権表示,
       COALESCE(NULLIF(left(to_jsonb(w) ->> 'third_party_rights', 24), ''), '（空）') AS 作品の第三者権利,
       EXISTS (SELECT 1 FROM doc_conds c2 JOIN doc_shares s ON s.wanted_id = c2.id WHERE c2.work_id = w.id) AS 按分あり
  FROM doc_conds c JOIN v3.works w ON w.id = c.work_id
 ORDER BY 1;
