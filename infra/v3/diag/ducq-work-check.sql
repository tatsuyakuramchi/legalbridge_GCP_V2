-- =====================================================================
-- DucQrews：作品ごとの個別契約（ARC-PUBT-2026-0012〜0031）と条件明細の突き合わせ（読むだけ。何も書き換えない）
--
--   正解は条件書 v4（Word）の対象著作物一覧。番号 → 作品は下の v4 の表のとおり。
--   作品名は空白（全角・半角）を除いて同じなら同じ作品とみなす。
--
--   ① 番号ごと：v4 の作品と、その個別契約にいま載っている条件明細（作品違いは ×）
--   ② 条件明細ごと：いまの契約と、作品から見た正しい契約（違えば「→ 付け替え先」）
--      実績・支払の割り当て・つながっている文書の数も出す（付け替えてもこれらは動かない。目安として）
--   ③ 文書ごと：個別契約に載っている文書と、その文書につながっている条件明細の作品（作品違いは ×）
--
--   ★ 使い方（予備系。infra\local で）
--       docker compose run --rm ops sql /v3/diag/ducq-work-check.sql
--       取引先名が違うとき：… ducq-work-check.sql party=DucQrews
-- =====================================================================

\pset pager off
\if :{?party}
\else
  \set party 'DucQrews'
\endif

CREATE TEMP TABLE v4 (no text PRIMARY KEY, title text, letter text) ON COMMIT PRESERVE ROWS;
INSERT INTO v4 VALUES
  ('ARC-PUBT-2026-0026', '武装伝奇RPG　神我狩', '1通目'),
  ('ARC-PUBT-2026-0012', '神我狩リプレイ 黒剣のスレイヤー', '1通目'),
  ('ARC-PUBT-2026-0027', '神我狩 拡張ルールブック 神魂のレクイエム', '1通目'),
  ('ARC-PUBT-2026-0028', '神我狩 リプレイ 邪神グリード', '1通目'),
  ('ARC-PUBT-2026-0013', '神我狩 拡張ルールブック ダモクレスの機神', '1通目'),
  ('ARC-PUBT-2026-0016', '神我狩 リプレイ 邪神グリード2 デストロイヤー・ガール', '1通目'),
  ('ARC-PUBT-2026-0014', '神我狩 拡張ルールブック クロノスの原初神器', '1通目'),
  ('ARC-PUBT-2026-0015', '神我狩 リプレイ 邪神グリード3 ドラゴン・メイデン', '1通目'),
  ('ARC-PUBT-2026-0024', '神我狩 ストーリー＆データ集 少女を焦がす熾火', '1通目'),
  ('ARC-PUBT-2026-0017', '神我狩 拡張ルールブック 四神ガーディアンズ', '1通目'),
  ('ARC-PUBT-2026-0018', '神我狩 リプレイ 四神凶歌譚', '1通目'),
  ('ARC-PUBT-2026-0019', '神我狩 ストーリー＆データ集 混沌神話との接触', '1通目'),
  ('ARC-PUBT-2026-0020', '神我狩 ストーリー＆データ集 時空のオルタード', '1通目'),
  ('ARC-PUBT-2026-0021', '神我狩 ストーリー＆データ集 神魔ストラグル', '1通目'),
  ('ARC-PUBT-2026-0022', '神我狩 GMブック 神怪夜行', '1通目'),
  ('ARC-PUBT-2026-0023', '神我狩 拡張ルールブック 神機エクソダス', '1通目'),
  ('ARC-PUBT-2026-0025', '神我狩 拡張ルールブック 超神イヴォルヴ', '1通目'),
  ('ARC-PUBT-2026-0029', '神我狩 ストーリー＆データ集 神化の誓約', '1通目'),
  ('ARC-PUBT-2026-0030', 'テーブルトークRPG　呪印感染', '2通目'),
  ('ARC-PUBT-2026-0031', '呪印感染 ストーリー＆データ集 十の災い', '2通目');

-- 作品名の比べ方：空白（全角・半角）を除く
CREATE TEMP VIEW pp AS
  SELECT r.party_id FROM v3.v_party_resolved r
   WHERE r.resolved_id IN (SELECT r2.resolved_id FROM v3.v_party_resolved r2 JOIN v3.parties p ON p.id = r2.party_id
                            WHERE p.name ILIKE '%' || :'party' || '%');
CREATE TEMP VIEW cc AS
  SELECT c.id, c.condition_no, c.name, c.status, c.agreement_id, a.agreement_no AS now_no,
         w.title AS work, regexp_replace(COALESCE(w.title, ''), '[[:space:]　]', '', 'g') AS wkey,
         c.pricing_model, c.rate_ppm, c.flat_amount, c.usage_type
    FROM v3.conditions c
    LEFT JOIN v3.works w ON w.id = c.work_id
    LEFT JOIN v3.agreements a ON a.id = c.agreement_id
   WHERE c.counterparty_id IN (SELECT party_id FROM pp)
     AND c.status NOT IN ('superseded', 'void');
CREATE TEMP VIEW v4k AS SELECT no, title, letter, regexp_replace(title, '[[:space:]　]', '', 'g') AS wkey FROM v4;

\echo
\echo '① 番号ごと（v4 の作品 ⇔ いま載っている条件明細）　判定：○ 作品が合う／× 作品違い／（空）条件なし'
SELECT v.no AS 番号, v.letter AS 通, v.title AS v4の作品,
       CASE WHEN a.id IS NULL THEN '契約なし' ELSE COALESCE(a.status, '') END AS 契約,
       c.condition_no AS 条件, c.name AS 条件名, c.work AS 条件の作品,
       CASE WHEN c.id IS NULL THEN '' WHEN c.wkey = v.wkey THEN '○' ELSE '×' END AS 判定
  FROM v4k v
  LEFT JOIN v3.agreements a ON a.agreement_no = v.no AND a.counterparty_id IN (SELECT party_id FROM pp)
  LEFT JOIN cc c ON c.agreement_id = a.id
 ORDER BY v.letter, v.no, c.condition_no;

\echo
\echo '② 条件明細ごと（いまの契約 ⇔ 作品から見た正しい契約）　→ があるものが付け替え候補'
SELECT c.condition_no AS 条件, c.name AS 条件名, c.work AS 作品, c.status AS 状態,
       COALESCE(c.now_no, '（契約なし）') AS いまの契約,
       COALESCE(v.no, '？ v4 に無い作品') AS 正しい契約,
       CASE WHEN v.no IS NULL THEN '要確認' WHEN v.no = c.now_no THEN '' ELSE '→ ' || v.no END AS 付け替え,
       CASE WHEN c.pricing_model = 'flat' THEN c.flat_amount::text ELSE round(c.rate_ppm / 10000.0, 2)::text || '%' END AS 料率・額,
       (SELECT count(*) FROM v3.condition_events e WHERE e.condition_id = c.id AND e.status <> 'void') AS 実績,
       (SELECT count(*) FROM v3.payment_allocations pa WHERE pa.condition_id = c.id) AS 支払割当,
       (SELECT string_agg(d.document_no, ' ' ORDER BY d.document_no) FROM v3.document_conditions dc
          JOIN v3.documents d ON d.id = dc.document_id WHERE dc.condition_id = c.id AND d.status <> 'void') AS 文書,
       (SELECT string_agg(p.name || ' ' || round(s.share_ppm / 10000.0, 1) || '%', '／' ORDER BY s.sort_order)
          FROM v3.condition_shares s JOIN v3.parties p ON p.id = s.party_id WHERE s.condition_id = c.id) AS 按分
  FROM cc c
  LEFT JOIN v4k v ON v.wkey = c.wkey
 ORDER BY (v.no IS DISTINCT FROM c.now_no) DESC, COALESCE(v.no, c.now_no, 'zzz'), c.condition_no;

\echo
\echo '③ 文書ごと（個別契約に載っている文書 ⇔ つながっている条件明細の作品）　× は作品違い'
SELECT a.agreement_no AS 契約, d.document_no AS 文書, d.status AS 状態,
       COALESCE(d.manual_inputs->>'documentKind', t.label, '') AS 種類,
       c.condition_no AS 条件, w.title AS 条件の作品,
       CASE WHEN c.id IS NULL THEN '' WHEN v.wkey = regexp_replace(COALESCE(w.title, ''), '[[:space:]　]', '', 'g') THEN '○'
            WHEN v.no IS NULL THEN '' ELSE '×' END AS 判定
  FROM v3.agreements a
  JOIN v3.documents d ON d.agreement_id = a.id AND d.status <> 'void'
  LEFT JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN v3.document_templates t ON t.id = tv.template_id
  LEFT JOIN v4k v ON v.no = a.agreement_no
  LEFT JOIN v3.document_conditions dc ON dc.document_id = d.id
  LEFT JOIN v3.conditions c ON c.id = dc.condition_id
  LEFT JOIN v3.works w ON w.id = c.work_id
 WHERE a.counterparty_id IN (SELECT party_id FROM pp)
   AND (a.agreement_no LIKE 'ARC-PUBT-2026-%' OR a.agreement_no = 'ATT-2026-00069')
 ORDER BY a.agreement_no, d.document_no, c.condition_no;

\echo
\echo '④ v4 の作品名に当たる作品（作品の名前が v4 と違うと ② で「v4 に無い作品」になる）'
SELECT v.no AS 番号, v.title AS v4の作品,
       (SELECT string_agg(w.id || ':' || w.title, ' ／ ') FROM v3.works w
         WHERE w.merged_into_id IS NULL AND regexp_replace(w.title, '[[:space:]　]', '', 'g') = v.wkey) AS 同じ名前の作品
  FROM v4k v ORDER BY v.letter, v.no;
