\set ON_ERROR_STOP on
\pset pager off

-- 058_repair_document_contact_kana.sql
-- 確定済み文書の form_data から、口座名義カナが誤って入った担当者名／担当部署を外す。
--
-- ★★ これは確定済みデータの修正である ★★
--   通常、確定した文書の form_data は変更しない（作成時点の内容を保持するため）。
--   ここでは「個人の取引先の担当者名に口座名義カナが入っている」という明らかな
--   入力起因の誤りだけを、条件を絞って取り除く。適用は業務判断のうえで行う。
--   再発行（document-reissue）は form_data を引き継ぐため、再発行では直らない
--   （ARC-PO-2026-0117-R1 が同じ値を持っていることで確認済み）。
--
-- 対象の条件（すべて満たす行のみ）:
--   - form_data の VENDOR_CONTACT_NAME が空でない
--   - かつ ACCOUNT_HOLDER_KANA と完全一致（前後・全角空白の差は無視）
--   本当の担当者名が入っている文書には触らない。
--
-- 変わるもの: 発注書等の宛先ブロックに出ていた「<カナ>　<カナ> 様」の行が消える
--   （テンプレートは VENDOR_CONTACT_NAME が空ならこの行を出さない）。
--   金額・明細・特約・宛名・口座情報には触らない。
--   適用後、対象文書の PDF を再生成すると反映される（Drive 保存済みなら
--   「PDFを再生成（Drive更新）」）。
--   何度流しても結果は同じ（冪等）。

\if :{?confirm_document_contact_kana}
\else
  \echo 'Run with: -v confirm_document_contact_kana=REPAIR_DOCUMENT_CONTACT_KANA'
  \quit 2
\endif
SELECT :'confirm_document_contact_kana' = 'REPAIR_DOCUMENT_CONTACT_KANA' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.norm(value text) RETURNS text AS $$
  SELECT btrim(regexp_replace(coalesce(value, ''), '[[:space:]　]+', ' ', 'g'))
$$ LANGUAGE sql IMMUTABLE;

CREATE TEMP VIEW contaminated AS
  SELECT id, document_number, template_type, created_at::date AS created_on,
         form_data->>'VENDOR_NAME' AS vendor_name,
         form_data->>'VENDOR_CONTACT_DEPARTMENT' AS contact_department,
         form_data->>'VENDOR_CONTACT_NAME' AS contact_name
    FROM documents
   WHERE pg_temp.norm(form_data->>'VENDOR_CONTACT_NAME') <> ''
     AND pg_temp.norm(form_data->>'VENDOR_CONTACT_NAME')
         = pg_temp.norm(form_data->>'ACCOUNT_HOLDER_KANA');

-- 適用前：対象文書の一覧（この内容で良いか目で確認する）。
SELECT * FROM contaminated ORDER BY created_on DESC, document_number;

UPDATE documents
   SET form_data = form_data - 'VENDOR_CONTACT_NAME'
         - CASE
             WHEN pg_temp.norm(form_data->>'VENDOR_CONTACT_DEPARTMENT')
                  = pg_temp.norm(form_data->>'ACCOUNT_HOLDER_KANA')
             THEN 'VENDOR_CONTACT_DEPARTMENT' ELSE '' END
 WHERE id IN (SELECT id FROM contaminated);

-- 適用後：対象が残っていないこと（0 行が期待値）。
SELECT id, document_number FROM contaminated;

-- 口座名義・宛名・金額は残っていること（抜けていないかの確認）。
SELECT document_number,
       form_data->>'VENDOR_NAME' AS 宛名,
       form_data->>'ACCOUNT_HOLDER_KANA' AS 口座名義,
       form_data->>'grandTotalExTax' AS 合計,
       form_data ? 'VENDOR_CONTACT_NAME' AS 担当者名が残存,
       form_data ? 'VENDOR_CONTACT_DEPARTMENT' AS 担当部署が残存
  FROM documents
 WHERE document_number IN (
   'ARC-PO-2026-0117', 'ARC-PO-2026-0117-R1', 'ARC-INS-2026-0021',
   'ARC-PO-2026-0018', 'ARC-PO-2026-0018_001', 'ARC-PO-2026-0006',
   'ARC-PO-2026-0005', 'ARC-PO-2026-0004', 'ARC-PO-2026-0003', 'ARC-2026-0030')
 ORDER BY document_number;

COMMIT;
