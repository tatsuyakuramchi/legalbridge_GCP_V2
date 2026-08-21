\set ON_ERROR_STOP on
\pset pager off

-- 063_intl_po_drop_payment_schedule.sql
-- 海外発注書（intl_purchase_order）テンプレ改訂: 明細ごとの Payment Schedule 表を削除する。
--   ・表は明細の payment_schedule 配列をそのまま印字するが、V2 は配列を自動生成せず
--     鮮度を保つ仕組みがないため、Payment Date 欄（billing_note または自動表記・061）と
--     食い違う事故が起きていた。支払条件の記載を Payment Date 欄に一本化する。
--   ・国内発注書の「支払スケジュール」表は残す（フォームの支払予定日エディタで管理）。
--   ・{{#if payment_schedule}} 〜 </table> 直後の {{/if}} までを位置計算で除去して
--     新版を INSERT し current_version_id を差し替え。マーカーが一意に見つからない・
--     除去範囲が想定と違うときは何もせず中断。field_schema は引き継ぐ。
--   ・確定済み文書は自分の版で再生成されるため影響なし。明細に残っている
--     payment_schedule データも印字されなくなるだけで無害。
--
-- 実行: psql "$RUNTIME_ADMIN_DSN" -v confirm_drop_schedule=DROP_INTL_PO_PAYMENT_SCHEDULE \
--         -f infra/gcp/sql/063_intl_po_drop_payment_schedule.sql

\if :{?confirm_drop_schedule}
\else
  \echo 'Run with: -v confirm_drop_schedule=DROP_INTL_PO_PAYMENT_SCHEDULE'
  \quit 2
\endif
SELECT :'confirm_drop_schedule' = 'DROP_INTL_PO_PAYMENT_SCHEDULE' AS confirmed \gset
\if :confirmed
\else
  \echo 'Confirmation value is invalid; nothing was changed.'
  \quit 2
\endif

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  tpl_id bigint;
  next_no int;
  new_id bigint;
  start_pos int;
  table_end int;
  close_pos int;
  removed text;
  start_marker constant text := '{{#if payment_schedule}}';
  end_if constant text := '{{/if}}';
BEGIN
  SELECT t.id, v.html_source INTO tpl_id, src
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order テンプレートが見つかりません';
  END IF;
  IF (length(src) - length(replace(src, start_marker, ''))) / length(start_marker) <> 1 THEN
    RAISE EXCEPTION 'payment_schedule ブロックが想定どおり 1 箇所で見つかりません。現行版の内容を確認してください';
  END IF;

  -- ブロック終端: 開始マーカー以降の最初の </table> の直後にある {{/if}} まで。
  -- （ブロック内の {{#if amount}}…{{/if}} は </table> より前で閉じる）
  start_pos := strpos(src, start_marker);
  table_end := strpos(substr(src, start_pos), '</table>');
  IF table_end = 0 THEN
    RAISE EXCEPTION 'payment_schedule ブロック内に </table> が見つかりません。中断しました';
  END IF;
  table_end := start_pos + table_end - 1 + length('</table>');
  close_pos := strpos(substr(src, table_end), end_if);
  IF close_pos = 0 THEN
    RAISE EXCEPTION 'payment_schedule ブロックの閉じ {{/if}} が見つかりません。中断しました';
  END IF;
  close_pos := table_end + close_pos - 1 + length(end_if);

  removed := substr(src, start_pos, close_pos - start_pos);
  IF strpos(removed, 'Payment Schedule') = 0
     OR strpos(removed, '{{#each payment_schedule}}') = 0
     OR length(removed) > 1500 THEN
    RAISE EXCEPTION '除去範囲が想定と一致しません（length=% / 先頭=%）。中断しました',
      length(removed), left(removed, 60);
  END IF;

  new_html := substr(src, 1, start_pos - 1) || substr(src, close_pos);
  IF strpos(new_html, 'payment_schedule') > 0 THEN
    RAISE EXCEPTION '除去後も payment_schedule への参照が残っています。中断しました';
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_no
    FROM document_template_versions WHERE template_id = tpl_id;

  INSERT INTO document_template_versions (template_id, version_no, html_source, field_schema, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.field_schema,
         '海外発注書テンプレ改訂: 明細の Payment Schedule 表を削除・Payment Date 欄に一本化（063）',
         'legalbridge-v2'
    FROM document_templates t
    JOIN document_template_versions v ON v.id = t.current_version_id
   WHERE t.id = tpl_id
  RETURNING id INTO new_id;

  UPDATE document_templates SET current_version_id = new_id WHERE id = tpl_id;
END
$do$;

SELECT t.template_key, t.current_version_id, v.version_no,
       strpos(v.html_source, 'payment_schedule') = 0 AS schedule_removed,
       strpos(v.html_source, 'billing_note') > 0 AS keeps_billing_note
  FROM document_templates t
  JOIN document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'intl_purchase_order';

COMMIT;
