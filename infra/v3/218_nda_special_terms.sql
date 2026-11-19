-- =====================================================================
-- 218_nda_special_terms.sql（ops sql / Cloud SQL Studio 用）
--
--   NDA（nda）に「特約事項」欄を足す。先方からひな形の条文に修正案が来たとき、
--   本文は変えずに、文書ごとの特約事項にまとめて書いて対応するため。
--     ・入力欄 SPECIAL_TERMS（特約事項・任意・長文）を足す
--     ・空でないときだけ、準拠法の条の次に「特約事項」の条を出す
--         第14条（特約事項）※個人情報条項を適用するときは第15条
--         本契約の条項に加え、次の特約事項を適用する。特約事項と本契約の条項が抵触するときは、
--         特約事項が優先する。
--         （入力した文面。改行はそのまま）
--     ・頭書きに「特約事項」の行を出す（あり（第14条）／なし）
--     ・ほかの条文・入力欄は今の版のまま（今の版の本文と欄を読んで、足すだけ）
--   書き方の例：
--     第5条中「事前に開示者の書面による承諾を得るものとし、」を削除する。
--
--   何度流しても同じ（目印 <!-- nda special_terms r1 --> があれば何もしない）。
--   決定済みの NDA は変わらない（出したときの版のまま）。
--   ローカルは docker compose run --rm ops sql /v3/218_nda_special_terms.sql
--   戻すとき：ひとつ前の版に current_version_id を戻す
--     UPDATE v3.document_templates d SET current_version_id = v.id FROM v3.document_template_versions v
--      WHERE d.template_key = 'nda' AND v.template_id = d.id
--        AND v.version_no = (SELECT max(x.version_no) - 1 FROM v3.document_template_versions x WHERE x.template_id = d.id);
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  mark constant text := '<!-- nda special_terms r1 -->';
  css constant text := $css$
    /* ===== 特約事項（218） ===== */
    .special-terms {
      white-space: pre-wrap;
    }
  </style>$css$;
  head_row constant text := $row$
    <!-- 特約事項（218） -->
    <tr class="sec-row"><td colspan="2">特　約　事　項</td></tr>
    <tr>
      <td class="col-item">
        特約事項{{#if SPECIAL_TERMS}}<span class="art-ref">（第{{#if INCLUDE_PERSONAL_INFO}}15{{else}}14{{/if}}条）</span>{{/if}}
        <span class="sub-note">本契約の条項と抵触するときは特約事項が優先</span>
      </td>
      <td class="col-value">{{#if SPECIAL_TERMS}}あり（第{{#if INCLUDE_PERSONAL_INFO}}15{{else}}14{{/if}}条のとおり）{{else}}なし{{/if}}</td>
    </tr>

  </tbody>$row$;
  article constant text := $art${{#if SPECIAL_TERMS}}
<div class="article">
<div class="article-title">第{{#if INCLUDE_PERSONAL_INFO}}15{{else}}14{{/if}}条（特約事項）</div>
<div class="article-content">
<p>本契約の条項に加え、次の特約事項を適用する。特約事項と本契約の条項が抵触するときは、特約事項が優先する。</p>
<p class="special-terms">{{SPECIAL_TERMS}}</p>
</div>
</div>
{{/if}}

<div class="margin-note">（以下余白）</div>$art$;
  field constant jsonb := $json$[{
    "name": "SPECIAL_TERMS",
    "type": "textarea",
    "group": "VI. 特約事項",
    "label": "特約事項 (任意)",
    "helpText": "先方の修正案など、ひな形の条文を変える定めをまとめて書く。変える条項と内容を特定して書く（例: 第5条中「事前に開示者の書面による承諾を得るものとし、」を削除する。）。空なら特約事項の条は出ない",
    "placeholder": "例: 第5条中「事前に開示者の書面による承諾を得るものとし、」を削除する。"
  }]$json$::jsonb;
  tpl_id bigint;
  src text;
  vars jsonb;
  html text;
  next_no int;
  new_id bigint;
  n int;
  anchor text;
BEGIN
  SELECT t.id, v.html_source, COALESCE(v.variables, '[]'::jsonb) INTO tpl_id, src, vars
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = 'nda';
  IF tpl_id IS NULL THEN
    RAISE EXCEPTION 'nda のひな形（現行版）が見つかりません';
  END IF;
  IF position(mark in src) > 0 THEN
    RAISE NOTICE '218: NDA には特約事項欄が入っています。何もしません';
    RETURN;
  END IF;
  -- 今の版が 049 改訂版の作りであること（条番号が 準拠法＝13/14 条）を確かめる。
  IF position('（準拠法・管轄裁判所）' in src) = 0 OR position('{{#if INCLUDE_PERSONAL_INFO}}14{{else}}13{{/if}}' in src) = 0 THEN
    RAISE EXCEPTION 'nda の現行版が想定（049 改訂版：準拠法が第13条／第14条）と違います。本文を確認してください';
  END IF;
  -- 差し込む位置は本文に 1 か所ずつしかない前提。違えば止める。
  FOREACH anchor IN ARRAY ARRAY['</style>', '</tbody>', '<div class="margin-note">（以下余白）</div>'] LOOP
    n := (length(src) - length(replace(src, anchor, ''))) / length(anchor);
    IF n <> 1 THEN
      RAISE EXCEPTION 'nda の本文で % が % か所あります（1 か所の前提）。本文を確認してください', anchor, n;
    END IF;
  END LOOP;
  IF vars @> '[{"name": "SPECIAL_TERMS"}]'::jsonb THEN
    RAISE EXCEPTION 'nda の入力欄に SPECIAL_TERMS が既にあります（本文には無い）。内容を確認してください';
  END IF;

  html := mark || E'\n' || src;
  html := replace(html, '  </style>', css);
  IF position('/* ===== 特約事項（218）' in html) = 0 THEN
    html := replace(html, '</style>', css);   -- 字下げが違う本文でも入るように
  END IF;
  html := replace(html, '  </tbody>', head_row);
  IF position('<!-- 特約事項（218） -->' in html) = 0 THEN
    html := replace(html, '</tbody>', head_row);
  END IF;
  html := replace(html, '<div class="margin-note">（以下余白）</div>', article);

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  VALUES (tpl_id, next_no, html, vars || field,
          '218: 特約事項欄を追加（先方の修正案を本文を変えずに特約で受ける）', 'sql:218')
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '218: NDA を版 % として登録しました（版id %）', next_no, new_id;
END
$do$;

COMMIT;

-- 確認
SELECT t.template_key AS キー, v.version_no AS 版,
       (strpos(v.html_source, '<!-- nda special_terms r1 -->') > 0) AS 目印,
       (strpos(v.html_source, '（特約事項）') > 0) AS 特約の条,
       (v.variables @> '[{"name": "SPECIAL_TERMS"}]'::jsonb) AS 入力欄
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'nda';
