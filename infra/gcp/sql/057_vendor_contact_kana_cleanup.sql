\set ON_ERROR_STOP on
\pset pager off

-- 057_vendor_contact_kana_cleanup.sql
-- 取引先マスタの「担当者名／担当部署」に口座名義カナが入っている行を空にする。
--
-- 背景: 個人の取引先で、担当者名（contact_name）に口座名義カナ（account_holder_kana）と
--   同じ値が入っている行が複数ある。発注書テンプレートは
--     {{#if VENDOR_CONTACT_NAME}}{{VENDOR_CONTACT_DEPARTMENT}}　{{VENDOR_CONTACT_NAME}} 様{{/if}}
--   を宛先ブロックに出すため、「斎田明也 様」の下に「サイタ　アキヤ　サイタ　アキヤ 様」が
--   並んで出ていた（ARC-PO-2026-0117）。個人の取引先に「担当者」は無く、カナは口座名義欄が
--   持つべき値なので、担当者欄からは外す。
--
-- 対象の条件: 担当者名（または担当部署）が **口座名義カナと完全一致** する行のみ。
--   実務では担当者名と口座名義カナが一致することはまずないため、汚染の指標として使える。
--   前後・全角空白の差は無視する（「サイタ　アキヤ」と「サイタ アキヤ」を同一視）。
--   一致しない担当者名（本当の担当者）には触らない。
--
-- 影響範囲: これは **今後作成する文書** への対策。既に確定した文書は form_data に
--   値が焼き付いており、この SQL では変わらない（058 を参照）。
--   何度流しても結果は同じ（冪等）。

\if :{?confirm_vendor_contact_kana}
\else
  \echo 'Run with: -v confirm_vendor_contact_kana=CLEAR_VENDOR_CONTACT_KANA'
  \quit 2
\endif
SELECT :'confirm_vendor_contact_kana' = 'CLEAR_VENDOR_CONTACT_KANA' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

-- 空白差を無視した比較用（全角空白も畳む）。
CREATE OR REPLACE FUNCTION pg_temp.norm(value text) RETURNS text AS $$
  SELECT btrim(regexp_replace(coalesce(value, ''), '[[:space:]　]+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;

-- 適用前：対象行の一覧。
SELECT id, vendor_name, entity_type, contact_department, contact_name, account_holder_kana
  FROM vendors
 WHERE pg_temp.norm(account_holder_kana) <> ''
   AND (pg_temp.norm(contact_name) = pg_temp.norm(account_holder_kana)
     OR pg_temp.norm(contact_department) = pg_temp.norm(account_holder_kana))
 ORDER BY id;

UPDATE vendors
   SET contact_name = CASE
         WHEN pg_temp.norm(contact_name) = pg_temp.norm(account_holder_kana) THEN NULL
         ELSE contact_name END,
       contact_department = CASE
         WHEN pg_temp.norm(contact_department) = pg_temp.norm(account_holder_kana) THEN NULL
         ELSE contact_department END
 WHERE pg_temp.norm(account_holder_kana) <> ''
   AND (pg_temp.norm(contact_name) = pg_temp.norm(account_holder_kana)
     OR pg_temp.norm(contact_department) = pg_temp.norm(account_holder_kana));

-- 適用後：残っていないこと（0 行が期待値）。
SELECT id, vendor_name, contact_department, contact_name, account_holder_kana
  FROM vendors
 WHERE pg_temp.norm(account_holder_kana) <> ''
   AND (pg_temp.norm(contact_name) = pg_temp.norm(account_holder_kana)
     OR pg_temp.norm(contact_department) = pg_temp.norm(account_holder_kana));

-- 口座名義は消していないこと（担当者欄だけを空にする）。
SELECT count(*) AS 口座名義あり FROM vendors WHERE pg_temp.norm(account_holder_kana) <> '';

COMMIT;
