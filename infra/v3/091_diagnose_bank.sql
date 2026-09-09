-- =====================================================================
-- 振込先の欠けが「元データ」か「移行の取りこぼし」かを切り分ける
--
--   A-012 が 460 件の「振り込めない口座」を上げた（2498 件中）。
--   V1 の元データがそこまで欠けているのか、移行で落としたのかを決める。
--
--   読むだけ。何も書き換えない。public も v3 も更新しない。
--   Cloud SQL Studio にそのまま貼れる（psql の命令を使っていない）。
--
--   出力に口座番号そのものは出さない。「入っているか」だけを出すので、
--   結果をそのまま人に渡しても口座情報は漏れない。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. V1 と V3 を並べる。同じ数なら元データ、V3 のほうが欠けていれば移行の穴。
-- ---------------------------------------------------------------------
SELECT * FROM (
  SELECT 1 AS n, 'V1 vendors：口座らしい行（4項目のどれかが入っている）' AS 項目,
         (SELECT count(*)::text FROM public.vendors
           WHERE COALESCE(NULLIF(bank_name,''), NULLIF(branch_name,''),
                          NULLIF(account_number,''), NULLIF(account_holder_kana,''))
                 IS NOT NULL) AS 結果
  UNION ALL
  SELECT 2, 'V3 party_bank_accounts：行数（1と同じであること）',
         (SELECT count(*)::text FROM v3.party_bank_accounts)
  UNION ALL
  SELECT 3, 'V1 の欠け（銀行名 / 支店名 / 口座番号 / 名義）',
         (SELECT count(*) FILTER (WHERE NULLIF(bank_name,'')           IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE NULLIF(branch_name,'')         IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE NULLIF(account_number,'')      IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE NULLIF(account_holder_kana,'') IS NULL)::text
            FROM public.vendors
           WHERE COALESCE(NULLIF(bank_name,''), NULLIF(branch_name,''),
                          NULLIF(account_number,''), NULLIF(account_holder_kana,''))
                 IS NOT NULL)
  UNION ALL
  SELECT 4, 'V3 の欠け（同じ並び。3と一致すれば移行は落としていない）',
         (SELECT count(*) FILTER (WHERE bank_name           IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE branch_name         IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE account_number      IS NULL)::text || ' / ' ||
                 count(*) FILTER (WHERE account_holder_kana IS NULL)::text
            FROM v3.party_bank_accounts)
  UNION ALL
  SELECT 5, '振り込めない行（口座番号か名義が無い）V1 / V3',
         (SELECT count(*)::text FROM public.vendors
           WHERE COALESCE(NULLIF(bank_name,''), NULLIF(branch_name,''),
                          NULLIF(account_number,''), NULLIF(account_holder_kana,''))
                 IS NOT NULL
             AND (NULLIF(account_number,'') IS NULL
                  OR NULLIF(account_holder_kana,'') IS NULL))
         || ' / ' ||
         (SELECT count(*)::text FROM v3.party_bank_accounts
           WHERE account_number IS NULL OR account_holder_kana IS NULL)
  UNION ALL
  -- V1 は構造化列のほかに bank_info という自由記述も持っている。V3 は移して
  -- いない（書類には自動で出ない欄なので落とした）。欠けている行の情報が
  -- こちらに書いてあるなら、移すべきものが残っている。
  SELECT 6, '欠けている行のうち、V1 の自由記述 bank_info に何か書いてある数',
         (SELECT count(*)::text FROM public.vendors
           WHERE COALESCE(NULLIF(bank_name,''), NULLIF(branch_name,''),
                          NULLIF(account_number,''), NULLIF(account_holder_kana,''))
                 IS NOT NULL
             AND (NULLIF(account_number,'') IS NULL
                  OR NULLIF(account_holder_kana,'') IS NULL)
             AND NULLIF(bank_info,'') IS NOT NULL)
  UNION ALL
  -- 構造化列が全部空で bank_info だけある取引先は、V3 に口座の行が作られない。
  -- 数が多いなら、その人たちは V3 では振込先を1文字も持っていない。
  SELECT 7, '構造化列が空で bank_info だけある取引先（V3 に行が無い）',
         (SELECT count(*)::text FROM public.vendors
           WHERE COALESCE(NULLIF(bank_name,''), NULLIF(branch_name,''),
                          NULLIF(account_number,''), NULLIF(account_holder_kana,''))
                 IS NULL
             AND NULLIF(bank_info,'') IS NOT NULL)
) AS 切り分け ORDER BY n;

-- ---------------------------------------------------------------------
-- 2. 欠け方の内訳。どのパターンが多いかで、元データの入れ方の癖が分かる。
--    値そのものは出さない（入っているかどうかだけ）。
-- ---------------------------------------------------------------------
SELECT
  CASE WHEN bank_name           IS NULL THEN '銀行名なし ' ELSE '' END ||
  CASE WHEN branch_name         IS NULL THEN '支店名なし ' ELSE '' END ||
  CASE WHEN account_type        IS NULL THEN '種別なし '   ELSE '' END ||
  CASE WHEN account_number      IS NULL THEN '口座番号なし ' ELSE '' END ||
  CASE WHEN account_holder_kana IS NULL THEN '名義なし '   ELSE '' END AS 欠け方,
  count(*) AS 件数
  FROM v3.party_bank_accounts
 WHERE bank_name IS NULL OR branch_name IS NULL
    OR account_number IS NULL OR account_holder_kana IS NULL
 GROUP BY 1
 ORDER BY 件数 DESC
 LIMIT 20;

-- ---------------------------------------------------------------------
-- 3. 実物を10件だけ、伏せた形で。移行の取りこぼしなら V1 側に値があるのに
--    V3 側が空、という行が並ぶ。
-- ---------------------------------------------------------------------
SELECT p.name AS 取引先,
       CASE WHEN NULLIF(v.bank_name,'')           IS NOT NULL THEN '有' ELSE '－' END AS "V1銀行",
       CASE WHEN b.bank_name                      IS NOT NULL THEN '有' ELSE '－' END AS "V3銀行",
       CASE WHEN NULLIF(v.account_number,'')      IS NOT NULL THEN '有' ELSE '－' END AS "V1番号",
       CASE WHEN b.account_number                 IS NOT NULL THEN '有' ELSE '－' END AS "V3番号",
       CASE WHEN NULLIF(v.account_holder_kana,'') IS NOT NULL THEN '有' ELSE '－' END AS "V1名義",
       CASE WHEN b.account_holder_kana            IS NOT NULL THEN '有' ELSE '－' END AS "V3名義",
       CASE WHEN NULLIF(v.bank_info,'')           IS NOT NULL THEN '有' ELSE '－' END AS "V1自由記述"
  FROM v3.party_bank_accounts b
  JOIN v3.parties p         ON p.id = b.party_id
  LEFT JOIN public.vendors v ON v.id = p.legacy_id
 WHERE b.account_number IS NULL OR b.account_holder_kana IS NULL
 ORDER BY p.name
 LIMIT 10;
