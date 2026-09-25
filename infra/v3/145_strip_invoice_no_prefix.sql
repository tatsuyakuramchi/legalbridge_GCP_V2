-- =====================================================================
-- ひな形の本文にある「T{{登録番号}}」の T を外す
--
--   台帳の登録番号は T 付き（T1234567890123）で持ち、差し込みでも T＋13 桁に
--   そろえる。本文の側に T が書いてあると「TT…」になるので、本文の T を外す。
--   やり方は 137 と同じ。現行版の本文だけを直し、新しい版を作って
--   current_version_id を差し替える。項目（variables）は変えない。
--   直す所が無いひな形は何もしない。何度流しても同じ。
--
--   対象: is_active なひな形の本文で、
--         T / Ｔ（後ろに - や 空白があってもよい）の直後に
--         {{INVOICE_REGISTRATION_NUMBER}} / {{VENDOR_INVOICE_NO}} / {{COMPANY_INVOICE_NO}}
--         / {{licensor_t_number}} / {{T番号}} / {{登録番号}} が続くところ。
--
--   実行: docker compose run --rm ops sql /v3/145_strip_invoice_no_prefix.sql
--         （本番は Cloud SQL Studio に貼る）
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = '<ひな形>';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描く。直すなら訂正版を出す。
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  tpl record;
  fixed text;
  next_no int;
  new_id bigint;
  pattern constant text := '[TＴ][\s\-－]?(\{\{\s*(INVOICE_REGISTRATION_NUMBER|VENDOR_INVOICE_NO|COMPANY_INVOICE_NO|licensor_t_number|T番号|登録番号)\s*\}\})';
BEGIN
  FOR tpl IN
    SELECT t.id AS tpl_id, t.template_key, v.id AS version_id, v.version_no, v.html_source, v.variables
      FROM v3.document_templates t
      JOIN v3.document_template_versions v ON v.id = t.current_version_id
     WHERE t.is_active
  LOOP
    fixed := regexp_replace(tpl.html_source, pattern, '\1', 'g');
    IF fixed = tpl.html_source THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
      FROM v3.document_template_versions WHERE template_id = tpl.tpl_id;

    INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
    VALUES (tpl.tpl_id, next_no, fixed, tpl.variables,
            format('145: 登録番号の前の T を本文から外した（項目は %s 版と同じ）', tpl.version_no),
            'sql:145')
    RETURNING id INTO new_id;
    UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl.tpl_id;
    RAISE NOTICE '% : 本文の T を外した。前の版 id=%（版 %）→ 新しい版 id=%（版 %）',
      tpl.template_key, tpl.version_id, tpl.version_no, new_id, next_no;
  END LOOP;
END
$do$;

COMMIT;

-- 確認：本文に T{{登録番号}} の形が残っていないこと（0 行）
SELECT t.template_key AS ひな形, v.version_no AS 版, m[1] AS 残っている所
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id,
       LATERAL regexp_matches(v.html_source,
         '(.{0,40}[TＴ][\s\-－]?\{\{\s*(INVOICE_REGISTRATION_NUMBER|VENDOR_INVOICE_NO|COMPANY_INVOICE_NO|licensor_t_number|T番号|登録番号)\s*\}\}.{0,20})', 'g') AS m
 WHERE t.is_active
 ORDER BY 1, 2;
