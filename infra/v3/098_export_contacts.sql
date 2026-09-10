-- =====================================================================
-- 取引先の連絡先と口座を取り出す（Cloud SQL Studio 用・読むだけ）
--
--   ★ この結果には口座番号・名義・個人の電話番号が入る。
--     ・チャットや issue に貼らないこと
--     ・ダウンロードした CSV は取り込んだら消すこと
--     ・共有ドライブに置かないこと
--
--   使い方:
--     1. 下の3つを Studio でそれぞれ実行し、結果を CSV でダウンロードする
--        （見出しは tbl,data の2列。094 と同じ形）
--     2. 手元の infra/local/dumps/contacts/ に置く（他の CSV を混ぜない）
--     3. docker compose run --rm ops import-contacts /dumps/contacts
--
--   取引先そのものは作らない。手元にある取引先の
--   住所・電話・メール・連絡先・口座だけを本番の値で上書きする。
--   突き合わせは取引先コード（party_code）。id は見ない。
-- =====================================================================

-- ① 取引先の住所・電話・メール
SELECT 'parties' AS tbl,
       jsonb_build_object(
         'party_code', p.party_code,
         'address',    p.address,
         'phone',      p.phone,
         'email',      p.email
       )::text AS data
  FROM v3.parties p
 WHERE p.party_code IS NOT NULL
   AND (p.address IS NOT NULL OR p.phone IS NOT NULL OR p.email IS NOT NULL)
 ORDER BY p.party_code;

-- ② 連絡先（役割ごと）
SELECT 'party_contacts' AS tbl,
       jsonb_build_object(
         'party_code', p.party_code,
         'role',       c.role,
         'name',       c.name,
         'email',      c.email,
         'phone',      c.phone,
         'department', c.department
       )::text AS data
  FROM v3.party_contacts c
  JOIN v3.parties p ON p.id = c.party_id
 WHERE p.party_code IS NOT NULL
 ORDER BY p.party_code, c.role;

-- ③ 口座（★ 口座番号と名義が入る）
SELECT 'party_bank_accounts' AS tbl,
       jsonb_build_object(
         'party_code',          p.party_code,
         'bank_name',           b.bank_name,
         'branch_name',         b.branch_name,
         'account_type',        b.account_type,
         'account_number',      b.account_number,
         'account_holder_kana', b.account_holder_kana
       )::text AS data
  FROM v3.party_bank_accounts b
  JOIN v3.parties p ON p.id = b.party_id
 WHERE p.party_code IS NOT NULL
 ORDER BY p.party_code;
