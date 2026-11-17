-- =====================================================================
-- 216_align_master_numbers_once.sql（ops sql / Cloud SQL Studio 用・一度だけ流す）
--
--   基本契約（合意）の番号を、載っている基本契約書（決定済み）の紙の番号にそろえる。
--   例：契約 ARC-HYB-2026-9000 に載った著作物利用許諾基本契約書V5 が ARC-LIC-2026-9003(-R4) → 契約を ARC-LIC-2026-9003 に。
--
--   起きていたこと：合意と文書は採番表が別。巻き直し・一括作成で先に基本契約を立てると、
--     あとで決定した基本契約書は別の番号になり、契約の一覧（HYB-9000）と紙（LIC-9003）で番号が食い違った。
--   アプリはこれから、基本契約書を決定した時点で番号をそろえる（agreements/auto.ts alignMasterNumber）。
--   この SQL は、それより前にできた食い違いを直す。
--
--   対象：基本契約（kind = master）で、番号がシステムの採番（ARC-SVC/LIC/HYB/SAL/OTH-年-連番）のもの。
--     載っている基本契約書（license_master_v5・license_master・service_master・pub_master_individual・
--     pub_master_corporate）のうち、決定済み（issued）でいちばん新しいものの番号（-R2 などの枝番を除く）にそろえる。
--     外部で付けた番号（紙の契約の番号）・その番号を別の契約が使っているもの・もう同じものは触らない。
--   下の個別契約・解除合意で「親番号-S01」「親番号-T01」の形のものは頭を付け替える。
--
--   流し方：ローカルは infra/local で docker compose run --rm ops sql /v3/216_align_master_numbers_once.sql
--     更新の前に対象の一覧を出す。何度流しても同じ（2回目以降は 0 件）。
--   流したあと：その基本契約の番号を印字した条件書（「基本契約 ARC-HYB-…」）があれば作り直す。
-- =====================================================================

BEGIN;
-- 契約の版（208）の記録に、だれが・なぜを残す。
SELECT set_config('lb.actor', 'ops:216', true), set_config('lb.reason', '基本契約の番号を基本契約書の番号にそろえる（216）', true);

CREATE TEMP TABLE align_216 ON COMMIT DROP AS
WITH masters AS (
  SELECT DISTINCT ON (a.id) a.id, a.agreement_no AS from_no,
         regexp_replace(d.document_no, '-R[0-9]+$', '') AS to_no, d.document_no
    FROM v3.agreements a
    JOIN v3.documents d ON d.agreement_id = a.id AND d.status = 'issued' AND d.document_no IS NOT NULL
    JOIN v3.document_template_versions tv ON tv.id = d.template_version_id
    JOIN v3.document_templates t ON t.id = tv.template_id
   WHERE COALESCE(a.kind, 'master') = 'master'
     AND a.agreement_no ~ '^ARC-(SVC|LIC|HYB|SAL|OTH)-[0-9]{4}-[0-9]+$'
     AND t.template_key IN ('license_master_v5', 'license_master', 'service_master', 'pub_master_individual', 'pub_master_corporate')
   ORDER BY a.id, d.issued_at DESC, d.id DESC
)
SELECT m.* FROM masters m
 WHERE m.from_no <> m.to_no
   AND NOT EXISTS (SELECT 1 FROM v3.agreements x WHERE x.agreement_no = m.to_no AND x.id <> m.id);

\echo '--- 対象（契約の番号 → 基本契約書の番号） ---'
SELECT x.id, x.from_no AS 契約の番号, x.to_no AS そろえる番号, x.document_no AS 基本契約書, p.name AS 相手先
  FROM align_216 x JOIN v3.agreements a ON a.id = x.id JOIN v3.parties p ON p.id = a.counterparty_id
 ORDER BY x.from_no;

\echo '--- 下の個別契約・解除合意（親番号-S01 / -T01）の頭を付け替える ---'
UPDATE v3.agreements k
   SET agreement_no = x.to_no || substr(k.agreement_no, length(x.from_no) + 1), updated_at = now()
  FROM align_216 x
 WHERE k.parent_id = x.id
   AND left(k.agreement_no, length(x.from_no) + 2) IN (x.from_no || '-S', x.from_no || '-T')
   AND NOT EXISTS (SELECT 1 FROM v3.agreements y WHERE y.agreement_no = x.to_no || substr(k.agreement_no, length(x.from_no) + 1))
RETURNING k.id, k.agreement_no;

\echo '--- 基本契約の番号をそろえる ---'
UPDATE v3.agreements a
   SET agreement_no = x.to_no, updated_at = now()
  FROM align_216 x
 WHERE a.id = x.id
RETURNING a.id, x.from_no AS 旧番号, a.agreement_no AS 新番号;

INSERT INTO v3.audit_events (actor, action, target_type, target_id, detail)
SELECT 'ops:216', 'agreement.renumber', 'agreement', x.id,
       jsonb_build_object('from', x.from_no, 'to', x.to_no, 'reason', '基本契約書の番号にそろえる（216）')
  FROM align_216 x;
COMMIT;
