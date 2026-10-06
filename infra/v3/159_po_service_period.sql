-- =====================================================================
-- 159 発注書（国内・海外）：役務提供の品目は「納期」ではなく「役務提供期間」を出す
--
--   これまで品目の日付は納期の 1 日だけで、10月20日〜25日の作業が 1 ページ目に
--   「October 25, 2026」とだけ出て、仕様欄の期間と食い違っていた。品目ごとに
--   「納品の形」（成果物納品／役務提供）を選べるようにし、役務提供の行は
--   提供期間（October 20 – 25, 2026／2026年10月20日〜25日）を出す。
--
--   ・明細の行：アプリが差す period_label / period_text があればそれを出す
--     （役務提供の行だけ）。無ければ従来どおり（納期／定期支払の役務提供期間）。
--   ・1 ページ目の見出し：アプリが差す delivery_heading があればそれ
--     （全部が役務提供なら「役務提供期間」、全部が成果物なら「納期」）。
--     無ければ従来の「納期 (または役務提供期間)」。
--   何度流しても同じ（済んでいれば何もしない）。アプリの更新より先に流しても
--   後に流しても壊れない（値が無ければ従来の出し方）。
--
--   実行: psql -v ON_ERROR_STOP=1 -f infra/v3/159_po_service_period.sql
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  tpl_id bigint;
  from_version bigint;
  from_no int;
  src text;
  new_html text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, 'period_text') > 0 THEN
    RAISE NOTICE '159: 発注書は役務提供期間を出し分けています。何もしません';
    RETURN;
  END IF;
  new_html := src;
  IF strpos(new_html, $r$<th>納期 <span style="font-size:8pt;color:#888;font-weight:400;">(または役務提供期間)</span></th>$r$) = 0 THEN
    RAISE EXCEPTION '159: ひな形の本文が想定と違います（差し替え先が無い）: %', left($r$<th>納期 <span style="font-size:8pt;color:#888;font-weight:400;">(または役務提供期間)</span></th>$r$, 60);
  END IF;
  new_html := replace(new_html, $r$<th>納期 <span style="font-size:8pt;color:#888;font-weight:400;">(または役務提供期間)</span></th>$r$, $r$<th>{{#if delivery_heading}}{{delivery_heading}}{{else}}納期 <span style="font-size:8pt;color:#888;font-weight:400;">(または役務提供期間)</span>{{/if}}</th>$r$);
  IF strpos(new_html, $r${{#if (eq calc_method "SUBSCRIPTION")}}役務提供期間{{else}}納期{{/if}}：$r$) = 0 THEN
    RAISE EXCEPTION '159: ひな形の本文が想定と違います（差し替え先が無い）: %', left($r${{#if (eq calc_method "SUBSCRIPTION")}}役務提供期間{{else}}納期{{/if}}：$r$, 60);
  END IF;
  new_html := replace(new_html, $r${{#if (eq calc_method "SUBSCRIPTION")}}役務提供期間{{else}}納期{{/if}}：$r$, $r${{#if period_text}}{{period_label}}：{{period_text}}{{else}}{{#if (eq calc_method "SUBSCRIPTION")}}役務提供期間{{else}}納期{{/if}}：$r$);
  IF strpos(new_html, $r${{else}}{{formatDate delivery_date}}{{/if}}$r$) = 0 THEN
    RAISE EXCEPTION '159: ひな形の本文が想定と違います（差し替え先が無い）: %', left($r${{else}}{{formatDate delivery_date}}{{/if}}$r$, 60);
  END IF;
  new_html := replace(new_html, $r${{else}}{{formatDate delivery_date}}{{/if}}$r$, $r${{else}}{{formatDate delivery_date}}{{/if}}{{/if}}$r$);
  IF strpos(new_html, 'delivery_heading') = 0 OR strpos(new_html, 'period_text') = 0 THEN
    RAISE EXCEPTION '159: 発注書の納期の欄が見つかりません（147/148 の版か確かめてください）';
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('159: 役務提供の品目は納期ではなく提供期間を出す（%s 版から）', from_no), 'sql:159'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '159: purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

DO $do$
DECLARE
  tpl_id bigint;
  from_version bigint;
  from_no int;
  src text;
  new_html text;
  next_no int;
  new_id bigint;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'intl_purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'intl_purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, 'period_text') > 0 THEN
    RAISE NOTICE '159: 海外発注書は役務提供期間を出し分けています。何もしません';
    RETURN;
  END IF;
  new_html := src;
  IF strpos(new_html, $r$<th>Delivery <span style="font-size:8pt;color:#888;font-weight:400;">(or service period)</span></th>$r$) = 0 THEN
    RAISE EXCEPTION '159: ひな形の本文が想定と違います（差し替え先が無い）: %', left($r$<th>Delivery <span style="font-size:8pt;color:#888;font-weight:400;">(or service period)</span></th>$r$, 60);
  END IF;
  new_html := replace(new_html, $r$<th>Delivery <span style="font-size:8pt;color:#888;font-weight:400;">(or service period)</span></th>$r$, $r$<th>{{#if delivery_heading}}{{delivery_heading}}{{else}}Delivery <span style="font-size:8pt;color:#888;font-weight:400;">(or service period)</span>{{/if}}</th>$r$);
  IF strpos(new_html, $r${{#if (eq calc_method "SUBSCRIPTION")}}Service period{{else}}Delivery{{/if}}: $r$) = 0 THEN
    RAISE EXCEPTION '159: ひな形の本文が想定と違います（差し替え先が無い）: %', left($r${{#if (eq calc_method "SUBSCRIPTION")}}Service period{{else}}Delivery{{/if}}: $r$, 60);
  END IF;
  new_html := replace(new_html, $r${{#if (eq calc_method "SUBSCRIPTION")}}Service period{{else}}Delivery{{/if}}: $r$, $r${{#if period_text}}{{period_label}}: {{period_text}}{{else}}{{#if (eq calc_method "SUBSCRIPTION")}}Service period{{else}}Delivery{{/if}}: $r$);
  IF strpos(new_html, $r${{else}}{{formatDateEn delivery_date}}{{/if}}$r$) = 0 THEN
    RAISE EXCEPTION '159: ひな形の本文が想定と違います（差し替え先が無い）: %', left($r${{else}}{{formatDateEn delivery_date}}{{/if}}$r$, 60);
  END IF;
  new_html := replace(new_html, $r${{else}}{{formatDateEn delivery_date}}{{/if}}$r$, $r${{else}}{{formatDateEn delivery_date}}{{/if}}{{/if}}$r$);
  IF strpos(new_html, 'delivery_heading') = 0 OR strpos(new_html, 'period_text') = 0 THEN
    RAISE EXCEPTION '159: 海外発注書の納期の欄が見つかりません（147/148 の版か確かめてください）';
  END IF;
  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('159: 役務提供の品目は納期ではなく提供期間を出す（%s 版から）', from_no), 'sql:159'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '159: intl_purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：役務提供期間の出し分けが入ったか
SELECT t.template_key AS ひな形, v.version_no AS 版,
       (strpos(v.html_source, 'period_text') > 0) AS 明細の提供期間,
       (strpos(v.html_source, 'delivery_heading') > 0) AS 見出しの出し分け
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key IN ('purchase_order', 'intl_purchase_order');
