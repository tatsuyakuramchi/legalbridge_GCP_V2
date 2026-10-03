-- =====================================================================
-- 158_royalty_mix_models.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   A-067：許諾料の計算書に取引モデル（利用形態）を混ぜるか、を作家ごとに持つ列を足す。
--   中身は 004_amend.sql の A-067 と同じ（004 を流し直すなら、こちらは要らない）。
--
--     v3.parties.royalty_mix_models boolean
--       空（既定）… 取引モデルごとに分ける。計算書1枚＝取引モデル1つ
--       true       … 従来どおり、同じ製造日・同じ支払日なら取引モデルをまたいで1枚
--
--   列を足すだけ。データは書き換えない。何度流しても同じ。
--   アプリはこの列が無くても動く（読むときは列が無ければ既定＝分ける）。
--   「取引モデルを混ぜる」に切り替えるときだけ、この列が要る。
-- =====================================================================

BEGIN;
ALTER TABLE v3.parties ADD COLUMN IF NOT EXISTS royalty_mix_models boolean;
COMMENT ON COLUMN v3.parties.royalty_mix_models IS
  '許諾料の計算書に取引モデルを混ぜるか。空＝取引モデルごとに分ける（既定）/ true＝混ぜる。A-067';
COMMIT;

-- 確認（列 1 であること）
SELECT count(*) AS 列 FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'parties' AND column_name = 'royalty_mix_models';
