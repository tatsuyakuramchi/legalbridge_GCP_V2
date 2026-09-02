\set ON_ERROR_STOP on
\pset pager off

-- 067_vendor_send_emails.sql
-- 取引先台帳に送信用メールアドレス2欄を追加する（利用者要望 2026-09-02）。
--   contact_email … 取引先担当者のメールアドレス。Gmail確定通知などの宛先候補。
--   signer_email  … 電子契約（CloudSign）の署名者メールアドレス。署名依頼の宛先候補。
--   既存の vendors.email（代表メール）はそのまま。3つとも文書詳細の
--   「外部連携」宛先候補（send-history suggestions）に出し分けされる。
--   grant 009 は vendors へのテーブル単位 SELECT/INSERT/UPDATE のため追加付与は不要。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_vendor_emails=ADD_VENDOR_SEND_EMAILS \
--         -f infra/gcp/sql/067_vendor_send_emails.sql

\if :{?confirm_vendor_emails}
\else
  \echo 'Run with: -v confirm_vendor_emails=ADD_VENDOR_SEND_EMAILS'
  \quit 2
\endif
SELECT :'confirm_vendor_emails' = 'ADD_VENDOR_SEND_EMAILS' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF current_database() <> 'legalbridge' THEN
    RAISE EXCEPTION 'Expected production database legalbridge, connected to %', current_database();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'vendors'
  ) THEN
    RAISE EXCEPTION 'Table vendors does not exist';
  END IF;
END
$guard$;

ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS signer_email VARCHAR(255);

COMMENT ON COLUMN public.vendors.contact_email IS
  '取引先担当者メールアドレス（Gmail確定通知などの宛先候補・任意）';
COMMENT ON COLUMN public.vendors.signer_email IS
  '電子契約（CloudSign）署名者メールアドレス（署名依頼の宛先候補・任意）';

SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'vendors'
   AND column_name IN ('contact_email', 'signer_email')
 ORDER BY column_name;

COMMIT;
