-- =====================================================================
-- 検収書のひな形：金額が当初から変わったときだけ、相手の確認（署名）欄を出す
--
--   減額・増額を伴う検収は、相手の合意を紙に残す必要がある。変更履歴
--   （hasChangeLogs：予定額／記録時の確認額と実額の差）が出るときに限って、
--   履歴のすぐ下に「変更内容の確認」欄を足す。額が変わっていない検収書には
--   出ない。変更履歴と同じ条件なので、履歴が出るのに署名欄が無い／その逆は
--   起きない（記入漏れの防止）。
--
--   やり方は 007・105・117 と同じ。現行版の本文を文字列で置き換えて新しい版を
--   作り、current_version_id を差し替える。目印が想定どおりでなければ何もせず
--   止まる。何度流しても同じ結果（適用済みなら何もしない）。
--
--   目印（116 の 2 番で確かめた、変更履歴の直後にあるコメント）:
--     {{!-- 支払条件・発注情報 — 期日表記は formatDate で YYYY年MM月DD日 --}}
--   その直前に、{{#if hasChangeLogs}} … {{/if}} で囲んだ署名欄を足す。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/120_inspection_signature.sql
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'inspection_certificate';（前の版id は NOTICE に出る）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  new_html text;
  tpl_id bigint;
  from_version bigint;
  from_no int;
  next_no int;
  new_id bigint;
  pos int;

  mark constant text := '{{!-- 支払条件・発注情報';
  sig constant text := E'{{!-- 変更内容の確認（金額が当初から変わったときだけ。hasChangeLogs と同じ条件） --}}\n'
    || E'  {{#if hasChangeLogs}}\n'
    || E'  <div class="signature-section" style="margin:10px 0 12px;padding:8px 10px;border:1px solid #c9a227;background:#fffbea;page-break-inside:avoid;">\n'
    || E'    <div style="font-size:9.5pt;font-weight:bold;margin-bottom:4px;">■ 変更内容の確認</div>\n'
    || E'    <p style="font-size:8.5pt;margin:0 0 8px;line-height:1.5;">上記「変更履歴」のとおり、本検収書の金額は当初の発注条件から変更されています。'
    || E'変更の内容および理由を確認のうえ、下記にご署名（または記名押印）ください。ご署名をもって、変更後の金額で検収が確定します。</p>\n'
    || E'    <table style="width:100%;border-collapse:collapse;font-size:8.5pt;">\n'
    || E'      <tr>\n'
    || E'        <td style="width:50%;vertical-align:top;padding:6px 8px;border:1px solid #bbb;">\n'
    || E'          <div style="color:#555;margin-bottom:6px;">受託者（署名または記名押印）</div>\n'
    || E'          <div style="height:34px;border-bottom:1px solid #333;"></div>\n'
    || E'          <div style="margin-top:6px;">署名日：　　　　年　　　月　　　日</div>\n'
    || E'        </td>\n'
    || E'        <td style="width:50%;vertical-align:top;padding:6px 8px;border:1px solid #bbb;">\n'
    || E'          <div style="color:#555;margin-bottom:6px;">発注者（確認者）</div>\n'
    || E'          <div style="height:34px;border-bottom:1px solid #333;padding-top:14px;">株式会社アークライト　{{inspectorDept}}　{{inspectorName}}</div>\n'
    || E'          <div style="margin-top:6px;">確認日：{{formatDate INSPECTION_DATE}}</div>\n'
    || E'        </td>\n'
    || E'      </tr>\n'
    || E'    </table>\n'
    || E'  </div>\n'
    || E'  {{/if}}\n\n  ';
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'inspection_certificate';
  IF src IS NULL THEN
    RAISE EXCEPTION 'inspection_certificate のひな形が見つかりません';
  END IF;
  IF strpos(src, 'signature-section') > 0 THEN
    RAISE NOTICE '120: 適用済み（署名欄がある）。何もしません';
    RETURN;
  END IF;
  IF strpos(src, '{{#if hasChangeLogs}}') = 0 THEN
    RAISE EXCEPTION '変更履歴のブロック（{{#if hasChangeLogs}}）が見つかりません。116 で現行版を確かめてください';
  END IF;
  IF (length(src) - length(replace(src, mark, ''))) / length(mark) <> 1 THEN
    RAISE EXCEPTION '目印（%）が 1 箇所ではありません。116 の 2 番で現行版を確かめてください', mark;
  END IF;
  pos := strpos(src, mark);
  IF pos < strpos(src, '{{#if hasChangeLogs}}') THEN
    RAISE EXCEPTION '目印が変更履歴より前にあります。116 の 2 番で現行版を確かめてください';
  END IF;

  new_html := substr(src, 1, pos - 1) || sig || substr(src, pos);

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         '120: 金額が当初から変わったときだけ「変更内容の確認」（署名欄）を変更履歴の下に出す',
         'migration'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '120: inspection_certificate を版 % (id %) → 版 % (id %) に改訂しました', from_no, from_version, next_no, new_id;
END
$do$;

COMMIT;

-- 確かめる
SELECT t.template_key, v.version_no, v.id,
       strpos(v.html_source, 'signature-section') > 0 AS 署名欄あり,
       strpos(v.html_source, '{{#if hasChangeLogs}}') AS 変更履歴の位置,
       strpos(v.html_source, 'signature-section') AS 署名欄の位置
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'inspection_certificate';
