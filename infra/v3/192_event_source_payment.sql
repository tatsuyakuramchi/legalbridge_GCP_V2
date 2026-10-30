-- =====================================================================
-- 192_event_source_payment.sql（Cloud Shell の psql / Cloud SQL Studio 用）
--
--   取引先からの入金（OUT 条件に割り当てた入金）と、作者への報告（IN 条件の実績）を繋ぐ。
--
--   当社は取引先から OUT 条件に基づいてお金を受け取り、作者へ IN 条件に基づいて払う。
--   これまで 入金（payments, direction = 'in'）と 作者の報告（condition_events の受領額）を
--   別々に打っていて、どの入金の分の報告かが残らなかった（金額の打ち間違い・払い漏れが見えない）。
--     condition_events.source_payment_id … この報告の元になった取引先からの入金
--   1 つの入金から作者が複数いれば、作者（IN 条件）ごとに 1 件ずつ報告が立ち、同じ入金を指す。
--
--   何度流しても同じ結果。戻すときは 192_event_source_payment_rollback.sql。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL search_path = v3, public;

ALTER TABLE v3.condition_events ADD COLUMN IF NOT EXISTS source_payment_id bigint;
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'v3.condition_events'::regclass AND conname = 'condition_events_source_payment_fk') THEN
    ALTER TABLE v3.condition_events ADD CONSTRAINT condition_events_source_payment_fk
      FOREIGN KEY (source_payment_id) REFERENCES v3.payments(id);
  END IF;
END
$fk$;
CREATE INDEX IF NOT EXISTS condition_events_source_payment_idx
  ON v3.condition_events (source_payment_id) WHERE source_payment_id IS NOT NULL;
COMMENT ON COLUMN v3.condition_events.source_payment_id IS
  'この報告（IN 条件の実績）の元になった取引先からの入金（payments.direction = in、OUT 条件に割り当てたもの）。作者ごとに同じ入金を指す。';

COMMIT;

-- 確かめ：列と外部キーがある
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'v3' AND table_name = 'condition_events' AND column_name = 'source_payment_id';
SELECT conname FROM pg_constraint WHERE conname = 'condition_events_source_payment_fk';
