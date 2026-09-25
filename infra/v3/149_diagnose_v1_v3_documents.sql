-- =====================================================================
-- V1（public）と V3 の文書・ひな形・採番の食い違いを見る（ops sql / Cloud Shell 用）
--
--   何度流しても読むだけ。書き込みは1つも無い。
--
--   並行稼働中は V1（release/api・release/worker）も文書を発行し、ひな形を
--   改版する。V3 は 040_migrate_documents.sql で取り込んだ時点の写しに、
--   V3 だけの改版（113・120・137・145・147・148 など）を重ねている。
--   ここでは次の5つを見る。
--     1. ひな形ごとの対応（V1 の新しい版が未取込か／V3 で改版しているか／採番記号）
--     2. 040 を流し直すと止まる版番号の衝突
--     3. V3 に取り込まれていない V1 の文書
--     4. V1 と V3 で同じ文書番号が別々の文書に振られていないか
--     5. 採番表の遅れ（V3 の次の番号が V1 の発行済みとぶつかるか）
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/149_diagnose_v1_v3_documents.sql
-- =====================================================================

\pset pager off

-- ---------------------------------------------------------------------
-- 1. ひな形ごとの対応
--   判定
--     V3に無い                 … V1 にあって V3 に無い。040 の後に V1 で足された
--     V3だけ                   … V3 で足したもの（113 の pub_license_terms_v3 など）
--     V3で採番記号なし          … V3 で有効なのに number_prefix が空。V3 では発行できない
--     V1の新しい版が未取込      … V1 の現行版が V3 に入っていない。040 の流し直しで入る
--     V3で改版（040で戻る）     … V3 の現行版が V1 の現行版と違う。040 を流し直すと
--                                V3 の現行版が V1 の版へ差し戻される
--     一致
-- ---------------------------------------------------------------------
WITH v1 AS (
  SELECT t.id, t.template_key, t.is_active, NULLIF(t.document_prefix, '') AS prefix,
         t.current_version_id, cv.version_no, md5(COALESCE(cv.html_source, '')) AS html_md5
    FROM public.document_templates t
    LEFT JOIN public.document_template_versions cv ON cv.id = t.current_version_id
), v3t AS (
  SELECT t.id, t.template_key, t.is_active, t.number_prefix, t.legacy_id,
         cv.id AS cur_id, cv.version_no, cv.legacy_id AS cur_legacy_id,
         md5(COALESCE(cv.html_source, '')) AS html_md5
    FROM v3.document_templates t
    LEFT JOIN v3.document_template_versions cv ON cv.id = t.current_version_id
)
SELECT COALESCE(a.template_key, b.template_key)                 AS ひな形,
       a.is_active                                              AS "V1有効",
       b.is_active                                              AS "V3有効",
       a.prefix                                                 AS "V1記号(上書き)",
       b.number_prefix                                          AS "V3記号",
       a.version_no                                             AS "V1現行版",
       b.version_no                                             AS "V3現行版",
       CASE WHEN b.cur_id IS NULL THEN NULL
            WHEN b.cur_legacy_id IS NULL THEN 'V3で作成'
            ELSE 'V1から取込' END                               AS "V3現行版の出所",
       CASE
         WHEN b.id IS NULL THEN 'V3に無い'
         WHEN a.id IS NULL THEN 'V3だけ'
         WHEN b.is_active AND b.number_prefix IS NULL THEN 'V3で採番記号なし'
         WHEN a.current_version_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM v3.document_template_versions x
                               WHERE x.legacy_id = a.current_version_id)
           THEN 'V1の新しい版が未取込'
         WHEN b.cur_legacy_id IS DISTINCT FROM a.current_version_id
           THEN 'V3で改版（040で戻る）'
         WHEN a.html_md5 <> b.html_md5 THEN '本文が違う（要確認）'
         ELSE '一致'
       END                                                      AS 判定
  FROM v1 a
  FULL JOIN v3t b ON b.legacy_id = a.id
 ORDER BY (CASE WHEN a.id IS NULL OR b.id IS NULL THEN 0 ELSE 1 END), 1;

-- ---------------------------------------------------------------------
-- 2. 040 を流し直すと止まる版番号の衝突
--   V3 で改版した版（legacy_id なし）と、まだ V3 に入っていない V1 の版が
--   同じひな形・同じ版番号を持つと、040 の INSERT が UNIQUE (template_id,
--   version_no) で止まる。0 行なら流し直しても止まらない。
-- ---------------------------------------------------------------------
SELECT nt.template_key                AS ひな形,
       v.version_no                   AS 版番号,
       v.id                           AS "V1の版id",
       own.id                         AS "V3で作った版id",
       own.comment                    AS "V3の版のメモ"
  FROM public.document_template_versions v
  JOIN v3.document_templates nt ON nt.legacy_id = v.template_id
  JOIN v3.document_template_versions own
    ON own.template_id = nt.id AND own.version_no = v.version_no AND own.legacy_id IS NULL
 WHERE NOT EXISTS (SELECT 1 FROM v3.document_template_versions x WHERE x.legacy_id = v.id)
 ORDER BY 1, 2;

-- ---------------------------------------------------------------------
-- 3. V3 に取り込まれていない V1 の文書
--   040 の後に V1 で作られた文書。二重入力期間なら 040 の流し直しで入る。
-- ---------------------------------------------------------------------
SELECT COALESCE(NULLIF(d.lifecycle_status, ''), '(空)')  AS "V1の状態",
       count(*)                                          AS 件数,
       min(d.created_at)::date                           AS 最初,
       max(d.created_at)::date                           AS 最後,
       (array_agg(d.document_number ORDER BY d.created_at DESC)
          FILTER (WHERE NULLIF(d.document_number, '') IS NOT NULL))[1:5] AS 新しい番号
  FROM public.documents d
 WHERE NOT EXISTS (SELECT 1 FROM v3.documents nd WHERE nd.legacy_id = d.id)
 GROUP BY 1
 ORDER BY 2 DESC;

-- V3 でだけ発行した文書（V1 は知らない）
SELECT nd.status AS "V3の状態", count(*) AS 件数,
       min(COALESCE(nd.issued_at, nd.created_at))::date AS 最初,
       max(COALESCE(nd.issued_at, nd.created_at))::date AS 最後
  FROM v3.documents nd
 WHERE nd.legacy_id IS NULL
 GROUP BY 1
 ORDER BY 2 DESC;

-- ---------------------------------------------------------------------
-- 4. 同じ文書番号が V1 と V3 で別々の文書に振られている
--   0 行であること。行があれば、同じ番号の紙が2枚ある。
-- ---------------------------------------------------------------------
SELECT d.document_number              AS 文書番号,
       d.id                           AS "V1の文書id",
       d.lifecycle_status             AS "V1の状態",
       d.created_at::date             AS "V1の作成日",
       nd.id                          AS "V3の文書id",
       nd.status                      AS "V3の状態",
       COALESCE(nd.issued_at, nd.created_at)::date AS "V3の発行日",
       nd.legacy_id                   AS "V3のlegacy_id"
  FROM public.documents d
  JOIN v3.documents nd ON nd.document_no = d.document_number
 WHERE NULLIF(d.document_number, '') IS NOT NULL
   AND nd.legacy_id IS DISTINCT FROM d.id
 ORDER BY 1;

-- ---------------------------------------------------------------------
-- 5. 採番表の遅れ
--   V3 の採番は v3.documents しか見ない。V1 がその後に発行した番号は知らないので、
--   「V3 の採番表 < V1 で使われた最大」だと、V3 の次の発行が V1 の番号と重なる
--   （V3 側に同じ番号が無いので、重なったまま発行される）。
--   判定が「V3が遅れている」の行は、次に V3 で発行する前に 040 を流し直すか、
--   採番表を V1 の最大まで進める。
-- ---------------------------------------------------------------------
WITH used AS (
  SELECT 'V1' AS src, m[1] AS prefix, m[2]::int AS year, m[3]::int AS seq
    FROM public.documents d,
         regexp_match(d.document_number, '^ARC-(.+)-([0-9]{4})-([0-9]+)$') AS m
  UNION ALL
  SELECT 'V3', m[1], m[2]::int, m[3]::int
    FROM v3.documents nd,
         regexp_match(nd.document_no, '^ARC-(.+)-([0-9]{4})-([0-9]+)$') AS m
), mx AS (
  SELECT prefix, year,
         max(seq) FILTER (WHERE src = 'V1') AS v1_max,
         max(seq) FILTER (WHERE src = 'V3') AS v3_max
    FROM used GROUP BY prefix, year
), seqs AS (
  SELECT regexp_replace(upper(btrim(kind)), '^ARC-', '') AS prefix, year,
         max(current_value) AS v1_seq
    FROM public.document_sequences
   WHERE btrim(COALESCE(kind, '')) <> ''
   GROUP BY 1, 2
), keys AS (
  SELECT prefix, year FROM mx
  UNION SELECT prefix, year FROM seqs
  UNION SELECT prefix, year FROM v3.document_sequences
)
SELECT k.prefix                         AS 記号,
       k.year                           AS 年,
       s.v1_seq                         AS "V1採番表",
       mx.v1_max                        AS "V1で使用済の最大",
       n.current_value                  AS "V3採番表",
       mx.v3_max                        AS "V3で使用済の最大",
       CASE
         WHEN COALESCE(n.current_value, mx.v3_max, 0)
              < GREATEST(COALESCE(mx.v1_max, 0), COALESCE(s.v1_seq, 0))
           THEN 'V3が遅れている（次の発行が V1 と重なりうる）'
         WHEN COALESCE(mx.v3_max, 0) > GREATEST(COALESCE(mx.v1_max, 0), COALESCE(s.v1_seq, 0))
           THEN 'V3が先行（V1 の次の発行が V3 と重なりうる）'
         ELSE '問題なし'
       END                              AS 判定
  FROM keys k
  LEFT JOIN mx   ON mx.prefix = k.prefix AND mx.year = k.year
  LEFT JOIN seqs s ON s.prefix = k.prefix AND s.year = k.year
  LEFT JOIN v3.document_sequences n ON n.prefix = k.prefix AND n.year = k.year
 WHERE k.year >= extract(year FROM now())::int - 1
 ORDER BY (CASE WHEN COALESCE(n.current_value, mx.v3_max, 0)
                     < GREATEST(COALESCE(mx.v1_max, 0), COALESCE(s.v1_seq, 0)) THEN 0 ELSE 1 END),
          k.prefix, k.year;
