-- =====================================================================
-- 183_price_basis.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-091：利用許諾料の価格の基準（price_basis）。
--
--   出版の利用許諾料は 定価（本体価格）× 部数 × 料率 が基本だが、再許諾先（KADOKAWA 等）へ
--   卸す形では、発注者が受け取るのは卸代なので、基準は 卸価格（再許諾先への供給価格）になる
--   （ゲームの自社製造・他社販売＝供給価格 × 個数 × 料率 と同じ構造）。電子は受領額。
--   list=本体価格（定価）/ supply=卸価格（再許諾先への供給価格）/ receipts=発注者の受領額。
--   委託料の行では初版の算定の基礎の価格の意味、利用許諾条件では 2 版目以降の式の基準になる。
--   空なら従来どおり（紙は本体価格、電子は受領額）。
--
--   何度流しても同じ。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.conditions ADD COLUMN IF NOT EXISTS price_basis text;
DO $a091$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.conditions'::regclass AND conname = 'conditions_price_basis_chk') THEN
    ALTER TABLE v3.conditions ADD CONSTRAINT conditions_price_basis_chk
      CHECK (price_basis IS NULL OR price_basis IN ('list', 'supply', 'receipts'));
  END IF;
END $a091$;
COMMENT ON COLUMN v3.conditions.price_basis IS
  '利用許諾料の価格の基準（list=本体価格 / supply=卸価格＝再許諾先への供給価格 / receipts=発注者の受領額）。空なら紙は本体価格、電子は受領額。A-091';

COMMIT;

-- 確認
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='v3' AND table_name='conditions' AND column_name='price_basis')
     + (SELECT count(*) FROM pg_constraint WHERE conrelid='v3.conditions'::regclass AND conname='conditions_price_basis_chk') AS 列とCHECK;
