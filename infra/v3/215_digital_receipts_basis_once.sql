-- =====================================================================
-- 215_digital_receipts_basis_once.sql（ops sql / Cloud SQL Studio 用・一度だけ流す）
--
--   電子（出版）の条件明細のうち、料率 42.5%・45% のものの算定の基礎を「受領額」（price_basis = 'receipts'）にする。
--   42.5%・45% は受領額（再許諾先・配信事業者から受け取った額）に掛ける契約なので（例：ARC-PUBT-2026-9002）。
--   条件書V5（出版）r10 の第4条は price_basis から式を決める（docs/v5-license-templates.md）。
--
--   対象：IN の利用許諾・電子（利用形態 pub_digital、または利用形態が空で範囲の媒体が電子）・料率 42.5% か 45%・
--         基礎がまだ受領額でない・印税相当額（in_lieu）でない・有効／予定／下書きの条件。
--   対象外：再許諾の電子（pub_sub_digital）、置き換えられた旧版・無効の条件。
--
--   流し方：ローカルは infra/local で docker compose run --rm ops sql /v3/215_digital_receipts_basis_once.sql
--     更新の前後に対象の一覧と件数を出す。何度流しても同じ（2回目以降は 0 件）。
--     42.5%・45% でも配信価格で計算する契約があれば、流す前に下の 2 か所の条件へ AND c.id NOT IN (...) を足す。
--   流したあと：該当する条件書V5（出版）を作り直す（9002 など）。
-- =====================================================================

\echo '--- 対象（更新前） ---'
SELECT c.id, c.condition_no, c.name, c.usage_type, c.rate_ppm / 10000.0 AS rate_pct,
       c.price_basis, c.status, p.name AS counterparty
  FROM v3.conditions c
  JOIN v3.parties p ON p.id = c.counterparty_id
 WHERE true
   AND c.kind = 'license' AND c.direction = 'in'
   AND c.rate_ppm IN (425000, 450000)
   AND c.status IN ('active', 'scheduled', 'draft')
   AND c.license_fee_basis <> 'in_lieu'
   AND c.price_basis IS DISTINCT FROM 'receipts'
   AND (c.usage_type = 'pub_digital'
        OR (c.usage_type IS NULL AND EXISTS (
              SELECT 1 FROM v3.condition_scopes s
               WHERE s.condition_id = c.id AND s.scope_type = 'media'
                 AND (s.code = 'digital' OR s.label LIKE '%電子%'))))
 ORDER BY c.condition_no;

BEGIN;
UPDATE v3.conditions c
   SET price_basis = 'receipts', updated_at = now()
 WHERE true
   AND c.kind = 'license' AND c.direction = 'in'
   AND c.rate_ppm IN (425000, 450000)
   AND c.status IN ('active', 'scheduled', 'draft')
   AND c.license_fee_basis <> 'in_lieu'
   AND c.price_basis IS DISTINCT FROM 'receipts'
   AND (c.usage_type = 'pub_digital'
        OR (c.usage_type IS NULL AND EXISTS (
              SELECT 1 FROM v3.condition_scopes s
               WHERE s.condition_id = c.id AND s.scope_type = 'media'
                 AND (s.code = 'digital' OR s.label LIKE '%電子%'))))
RETURNING c.id, c.condition_no, c.name;
COMMIT;

\echo '--- 確認：42.5%・45% の IN の利用許諾の料率・算定の基礎ごとの件数 ---'
SELECT rate_ppm / 10000.0 AS rate_pct, coalesce(price_basis, '（未設定）') AS price_basis, count(*)
  FROM v3.conditions
 WHERE kind = 'license' AND direction = 'in' AND rate_ppm IN (425000, 450000)
 GROUP BY 1, 2 ORDER BY 1, 2;
