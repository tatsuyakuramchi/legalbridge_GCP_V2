-- =====================================================================
-- 条件をまとめて無効化するための下ごしらえ（ops sql / Cloud SQL Studio 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--   出てくるのは「流すためのコマンド」で、流すかどうかは人が決める。
--
--   画面から1本ずつ押していくと、条件6本＋実績3件で10回近くクリックする。
--   番号の読み違えも起きる。ここでは、番号から id を引いて、そのまま貼れる
--   コマンドの形にして出す。
--
--   コマンドはアプリの API を叩く。SQL で直接 UPDATE しない。
--   アプリを通せば、無効化できない条件は弾かれ、監査記録も残る
--   （誰がいつ何を無効にしたかが audit_events に入る）。直接 UPDATE すると
--   どちらも無い。
--
--   ★ 使い方
--     1) これを流して、2節・3節で対象を目で確かめる
--     2) 4節・5節に出たコマンドを PowerShell に貼る
--
--     docker compose run --rm ops sql /v3/diag/void-commands.sql \
--       conds=CL-2026-00261,CL-2026-00262 why=作り直したため
--
--   ★ 先に予備系を書ける状態にしておくこと
--     infra\local\.env の READ_ONLY=false（読み取り専用のままだと弾かれる）
-- =====================================================================

\pset pager off

\if :{?conds}
\else
\set conds 'CL-0000-00000'
\endif
\if :{?why}
\else
\set why '無効化の理由をここに書く'
\endif
\if :{?api}
\else
\set api 'http://localhost:8080/api/v3'
\endif

-- ---------------------------------------------------------------------
-- 1. 受け取った条件番号。綴りを間違えるとここで「見つからない」と出る
-- ---------------------------------------------------------------------
SELECT btrim(raw)                                        AS 条件番号,
       c.id                                              AS 条件id,
       COALESCE(c.name, '（見つからない）')              AS 条件名,
       COALESCE(c.status, '—')                           AS 版
  FROM unnest(string_to_array(:'conds', ',')) AS raw
  LEFT JOIN v3.conditions c ON c.condition_no = btrim(raw)
 ORDER BY 1;

-- ---------------------------------------------------------------------
-- 2. 消える見込みのもの。無効化しても記録は残るが、一覧からは消える
-- ---------------------------------------------------------------------
SELECT c.condition_no                                    AS 条件番号,
       c.name                                            AS 条件名,
       c.status                                          AS 版,
       COALESCE(c.flat_amount, c.unit_amount)            AS 金額,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active')                  AS 実績,
       (SELECT count(*) FROM v3.condition_events e
         WHERE e.condition_id = c.id AND e.status = 'active'
           AND e.document_id IS NOT NULL)                                      AS 文書に結ばれた実績,
       (SELECT count(*) FROM v3.document_conditions dc
         WHERE dc.condition_id = c.id)                                         AS 繋がっている文書,
       (SELECT count(*) FROM v3.payment_allocations al
         WHERE al.condition_id = c.id)                                         AS 支払の割当,
       CASE
         WHEN c.status = 'void' THEN 'すでに無効化済み。何もしなくてよい'
         WHEN c.status = 'superseded' THEN '旧版は無効化できない。最新版を無効化する'
         WHEN (SELECT count(*) FROM v3.document_conditions dc
                WHERE dc.condition_id = c.id) > 0 THEN '無効化はできる。削除はできない（文書が指している）'
         ELSE '無効化できる'
       END                                               AS 見込み
  FROM v3.conditions c
 WHERE c.condition_no = ANY(
         SELECT btrim(x) FROM unnest(string_to_array(:'conds', ',')) AS x)
 ORDER BY c.condition_no;

-- ---------------------------------------------------------------------
-- 3. 一緒に取り消す実績。文書に結ばれた実績は取り消せないので分けて出す
-- ---------------------------------------------------------------------
SELECT c.condition_no                                    AS 条件番号,
       e.id                                              AS 実績id,
       e.occurred_on                                     AS 納品日,
       e.quantity                                        AS 数量,
       e.amount                                          AS 金額,
       CASE WHEN e.document_id IS NULL THEN '取り消せる'
            ELSE '文書に結ばれている。先に文書側で外すか、文書ごと無効にする' END AS 見込み
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
 WHERE c.condition_no = ANY(
         SELECT btrim(x) FROM unnest(string_to_array(:'conds', ',')) AS x)
   AND e.status = 'active'
 ORDER BY c.condition_no, e.occurred_on, e.id;

-- ここから下は貼り付ける用。枠線と見出しを外す（そのままコピーできるように）。
\pset format unaligned
\pset tuples_only on

\echo ''
\echo '--- 4. 実績を取り消す。上から順に流す -------------------------------'
SELECT format(
         'Invoke-RestMethod -Method Post -Uri "%s/conditions/%s/events/%s/void"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body ([Text.Encoding]::UTF8.GetBytes(''%s''))',
         :'api', c.id, e.id,
         '{"reason":' || to_jsonb(:'why'::text)::text || '}')  AS コマンド
  FROM v3.condition_events e
  JOIN v3.conditions c ON c.id = e.condition_id
 WHERE c.condition_no = ANY(
         SELECT btrim(x) FROM unnest(string_to_array(:'conds', ',')) AS x)
   AND e.status = 'active'
   AND e.document_id IS NULL
 ORDER BY c.condition_no, e.id;

\echo ''
\echo '--- 5. 条件を無効化する。4 が全部通ってから流す ----------------------'
SELECT format(
         'Invoke-RestMethod -Method Post -Uri "%s/conditions/%s/void"'
         || ' -ContentType "application/json; charset=utf-8"'
         || ' -Body ([Text.Encoding]::UTF8.GetBytes(''%s''))',
         :'api', c.id,
         '{"reason":' || to_jsonb(:'why'::text)::text || '}')  AS コマンド
  FROM v3.conditions c
 WHERE c.condition_no = ANY(
         SELECT btrim(x) FROM unnest(string_to_array(:'conds', ',')) AS x)
   AND c.status = 'active'
 ORDER BY c.condition_no;

\echo ''
\echo '--- 流す前に ---------------------------------------------------------'
\echo '  infra/local/.env の READ_ONLY=false になっていること'
\echo '  （読み取り専用のままだと「読み取り専用です」と返り、何も変わらない）'
\echo '  Uri は組み上げ済み。PowerShell 側で変数を用意する必要はない'
\echo ''
