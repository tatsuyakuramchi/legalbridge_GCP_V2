-- =====================================================================
-- 取引先 1 社の「契約書まわり」を洗い出す（読むだけ。書き込みは 1 つも無い）。
--   基本契約 → 個別契約（条件書・発注書）→ 条件明細 → 文書（条件書・計算書）のつながりと、
--   機械的に分かるずれ。契約書の整理（重複・付け替え・番号の直し）を決める材料。
--
--   ★ 使い方（予備系。infra\local で）
--       docker compose run --rm ops sql /v3/diag/party-contracts.sql q=アーカム
--     q は取引先名・カナ・別名・取引先コードの一部。当たった取引先ぜんぶを対象にする（1 で確かめる）。
--     本番（Cloud SQL Studio）で流すときは、先頭の \ で始まる行を消し、:'q' を '%アーカム%' に置き換える。
--
--   ★ 出るもの
--     1 取引先　2 契約の一覧（親子の順）　3 条件明細と載っている契約・条件書
--     4 文書（条件書・計算書・取込文書）　5 機械的に分かるずれ（1 行 1 件）
-- =====================================================================

\if :{?q}
\else
  \echo '取引先名の一部を q=… で渡してください（例: ops sql /v3/diag/party-contracts.sql q=アーカム）'
  \quit
\endif
\set pat '%' :q '%'
\pset pager off

-- 対象の取引先（統合済みも含めて拾う）。
CREATE TEMP TABLE _p AS
SELECT pa.id FROM v3.parties pa
 WHERE pa.name ILIKE :'pat' OR COALESCE(pa.name_kana, '') ILIKE :'pat' OR COALESCE(pa.party_code, '') ILIKE :'pat'
    OR EXISTS (SELECT 1 FROM unnest(pa.aliases) x WHERE x ILIKE :'pat');

-- 対象の文書：契約がこの取引先のもの、または載っている条件がこの取引先のもの。
CREATE TEMP TABLE _d AS
SELECT DISTINCT d.id
  FROM v3.documents d
  LEFT JOIN v3.agreements a ON a.id = d.agreement_id
 WHERE a.counterparty_id IN (SELECT id FROM _p)
    OR EXISTS (SELECT 1 FROM v3.document_conditions dc JOIN v3.conditions c ON c.id = dc.condition_id
                WHERE dc.document_id = d.id AND c.counterparty_id IN (SELECT id FROM _p));

\echo '==== 1. 取引先 ===='
SELECT pa.id, pa.party_code AS コード, pa.name AS 名前, pa.kind AS 区分, pa.status AS 状態, pa.merged_into_id AS 統合先,
       (SELECT count(*) FROM v3.agreements a WHERE a.counterparty_id = pa.id) AS 契約,
       (SELECT count(*) FROM v3.conditions c WHERE c.counterparty_id = pa.id AND c.status IN ('active', 'scheduled')) AS 生きた条件
  FROM v3.parties pa WHERE pa.id IN (SELECT id FROM _p) ORDER BY pa.id;

\echo '==== 2. 契約の一覧（基本契約の下に個別契約。補助は親の下） ===='
SELECT a.id,
       CASE WHEN a.parent_id IS NULL THEN '' ELSE '　└ ' END || COALESCE(a.agreement_no, '（番号なし）') AS 番号,
       a.kind AS 種類, a.domain AS 種別, a.direction AS 向き, a.status AS 状態,
       left(a.title, 40) AS 件名,
       a.executed_on AS 締結日, a.effective_on AS 開始, a.expires_on AS 満了,
       CASE WHEN a.auto_renewal THEN '自動更新' ELSE '' END AS 更新,
       (SELECT count(*) FROM v3.conditions c WHERE c.agreement_id = a.id AND c.status IN ('active', 'scheduled')) AS 条件,
       (SELECT string_agg(d.document_no || '(' || d.status || ')', '・' ORDER BY d.id) FROM v3.documents d WHERE d.agreement_id = a.id) AS 文書,
       CASE WHEN a.source_url IS NOT NULL THEN 'あり' ELSE '' END AS 原本
  FROM v3.agreements a
 WHERE a.counterparty_id IN (SELECT id FROM _p)
 ORDER BY COALESCE(a.parent_id, a.id), a.parent_id IS NOT NULL, a.agreement_no, a.id;

\echo '==== 3. 条件明細（生きているもの）と、載っている契約・条件書 ===='
SELECT c.condition_no AS 条件, left(c.name, 36) AS 条件名, c.direction AS 向き, c.usage_type AS 利用形態,
       c.pricing_model AS 方式,
       CASE WHEN c.rate_ppm IS NOT NULL AND c.rate_ppm > 0 THEN round(c.rate_ppm / 10000.0, 3) || '%'
            WHEN c.flat_amount IS NOT NULL THEN '定額 ' || c.flat_amount ELSE '' END AS 料率・額,
       w.title AS 作品,
       a.agreement_no AS 契約, a.kind AS 契約の種類, par.agreement_no AS 親の契約,
       (SELECT string_agg(DISTINCT d.document_no || '(' || d.status || ')', '・')
          FROM v3.document_conditions dc JOIN v3.documents d ON d.id = dc.document_id
          LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
          LEFT JOIN v3.document_templates t ON t.id = tv.template_id
         WHERE dc.condition_id = c.id AND d.status <> 'void'
           AND COALESCE(t.template_key, '') NOT IN ('royalty_statement', 'royalty_statement_pub')) AS 条件書・発注書,
       (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS 実績
  FROM v3.conditions c
  LEFT JOIN v3.works w ON w.id = c.work_id
  LEFT JOIN v3.agreements a ON a.id = c.agreement_id
  LEFT JOIN v3.agreements par ON par.id = a.parent_id
 WHERE c.counterparty_id IN (SELECT id FROM _p) AND c.status IN ('active', 'scheduled')
 ORDER BY par.agreement_no NULLS FIRST, a.agreement_no NULLS FIRST, w.title, c.condition_no;

\echo '==== 4. 文書（条件書・発注書・計算書・取込文書） ===='
SELECT d.id, d.document_no AS 番号, COALESCE(t.label, '取込：' || COALESCE(d.manual_inputs ->> 'documentKind', '種類不明')) AS 種類,
       d.status AS 状態, d.issued_at::date AS 決定日,
       a.agreement_no AS 契約, a.kind AS 契約の種類,
       s.document_no AS 差し替え元,
       (SELECT string_agg(x.document_no, '・') FROM v3.documents x WHERE x.supersedes_id = d.id) AS 差し替え先,
       (SELECT count(*) FROM v3.document_conditions dc WHERE dc.document_id = d.id) AS 条件,
       (SELECT count(*) FROM v3.condition_events e WHERE e.document_id = d.id AND e.status = 'active') AS 実績,
       CASE WHEN d.storage_url IS NOT NULL THEN 'あり' ELSE '' END AS ファイル
  FROM v3.documents d
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v3.agreements a ON a.id = d.agreement_id
  LEFT JOIN v3.documents s ON s.id = d.supersedes_id
 WHERE d.id IN (SELECT id FROM _d) AND d.status <> 'draft'
 ORDER BY regexp_replace(COALESCE(d.document_no, ''), '-R[0-9]+$', ''), d.id;

\echo '==== 5. 機械的に分かるずれ（1 行 1 件） ===='
WITH pc AS (SELECT * FROM v3.conditions WHERE counterparty_id IN (SELECT id FROM _p) AND status IN ('active', 'scheduled')),
pa AS (SELECT * FROM v3.agreements WHERE counterparty_id IN (SELECT id FROM _p)),
pd AS (SELECT d.*, t.template_key, t.label, upper(regexp_replace(COALESCE(t.number_prefix, ''), '^ARC-', '', 'i')) AS own_prefix
         FROM v3.documents d
         LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
         LEFT JOIN v3.document_templates t ON t.id = tv.template_id
        WHERE d.id IN (SELECT id FROM _d) AND d.status <> 'draft')
SELECT 種類, 対象, 内容 FROM (
  SELECT 1 AS o, '条件が契約に載っていない' AS 種類, c.condition_no AS 対象, left(c.name, 50) AS 内容 FROM pc c WHERE c.agreement_id IS NULL
  UNION ALL
  SELECT 2, '条件が基本契約に直接載っている（個別契約なし）', c.condition_no, a.agreement_no || ' ' || left(c.name, 40)
    FROM pc c JOIN pa a ON a.id = c.agreement_id WHERE a.kind = 'master'
  UNION ALL
  SELECT 3, '条件が文書だけの契約に載っている', c.condition_no, a.agreement_no
    FROM pc c JOIN pa a ON a.id = c.agreement_id WHERE a.kind = 'document'
  UNION ALL
  SELECT 4, '空の契約（条件も文書も下の契約も無い）', a.agreement_no, left(a.title, 50)
    FROM pa a
   WHERE NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM v3.documents d WHERE d.agreement_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM v3.agreements ch WHERE ch.parent_id = a.id)
  UNION ALL
  SELECT 5, '文書だけの契約（条件が載っていない）', a.agreement_no,
         (SELECT string_agg(d.document_no || '(' || d.status || ')', '・') FROM v3.documents d WHERE d.agreement_id = a.id)
    FROM pa a
   WHERE a.kind <> 'master' AND NOT EXISTS (SELECT 1 FROM v3.conditions c WHERE c.agreement_id = a.id)
     AND EXISTS (SELECT 1 FROM v3.documents d WHERE d.agreement_id = a.id)
  UNION ALL
  SELECT 6, '計算書・請求系の番号が契約として登録されている', a.agreement_no, left(a.title, 50)
    FROM pa a WHERE a.agreement_no ~ '^(ARC-)?(ROY|RS|INS|PAY)-'
  UNION ALL
  SELECT 7, '同じ件名・同じ種類の契約が複数', string_agg(a.agreement_no, '・' ORDER BY a.id), min(left(a.title, 50))
    FROM pa a WHERE a.status <> 'terminated'
   GROUP BY a.counterparty_id, a.kind, a.direction, lower(regexp_replace(a.title, '\s', '', 'g')) HAVING count(*) > 1
  UNION ALL
  SELECT 8, '個別契約の親が別の相手の契約', a.agreement_no, par.agreement_no
    FROM pa a JOIN v3.agreements par ON par.id = a.parent_id WHERE par.counterparty_id <> a.counterparty_id
  UNION ALL
  SELECT 9, '基本契約に締結日が無い', a.agreement_no, left(a.title, 50)
    FROM pa a WHERE a.kind = 'master' AND a.executed_on IS NULL AND a.status = 'executed'
  UNION ALL
  SELECT 10, '満了した契約に生きた条件が載っている', a.agreement_no, '満了 ' || a.expires_on || '・条件 ' || count(c.id)
    FROM pa a JOIN pc c ON c.agreement_id = a.id
   WHERE a.expires_on < current_date AND NOT a.auto_renewal
   GROUP BY a.agreement_no, a.expires_on
  UNION ALL
  SELECT 11, '決定した条件書が契約に紐づいていない', d.document_no, d.label
    FROM pd d WHERE d.status = 'issued' AND d.agreement_id IS NULL
     AND d.template_key IS NOT NULL AND d.template_key NOT IN ('royalty_statement', 'royalty_statement_pub')
     AND d.template_key ~ '(terms|license|master)'
  UNION ALL
  SELECT 12, '番号が別の種類の文書の番号（訂正版の取り違え）', d.document_no, d.label
    FROM pd d
   WHERE d.own_prefix <> '' AND d.document_no IS NOT NULL
     AND regexp_replace(d.document_no, '-R[0-9]+$', '') NOT LIKE 'ARC-' || d.own_prefix || '-%'
     AND EXISTS (SELECT 1 FROM pd o WHERE o.document_no = regexp_replace(d.document_no, '-R[0-9]+$', '') AND o.own_prefix <> d.own_prefix)
  UNION ALL
  SELECT 13, '差し替え済みの文書しか載っていない契約', a.agreement_no,
         (SELECT string_agg(d.document_no, '・') FROM v3.documents d WHERE d.agreement_id = a.id)
    FROM pa a
   WHERE EXISTS (SELECT 1 FROM v3.documents d WHERE d.agreement_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM v3.documents d WHERE d.agreement_id = a.id AND d.status = 'issued')
  UNION ALL
  SELECT 14, '同じ作品・同じ利用形態の生きた条件が複数', string_agg(c.condition_no, '・' ORDER BY c.id),
         min(COALESCE(w.title, '（作品なし）')) || '・' || COALESCE(c.usage_type, '形態なし')
    FROM pc c LEFT JOIN v3.works w ON w.id = c.work_id
   WHERE c.direction = 'in' AND c.kind = 'license'
   GROUP BY c.counterparty_id, c.work_id, c.usage_type, c.target_party_id HAVING count(*) > 1
) x ORDER BY o, 対象;
