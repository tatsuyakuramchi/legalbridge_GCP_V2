// 発注書のひな形改訂 SQL（147 国内版・148 海外版）を templates/ の本文と CSS から組み立てる。
//   node infra/v3/tools/make-po-layout-sql.mjs
// 本文（*_v3_body.html）と足す CSS（*_v3_css.txt）を直したらこれを流して SQL を作り直す。
// SQL は Cloud SQL Studio にそのまま貼れる（psql のメタコマンドを使わない）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const TARGETS = [
  {
    // r4（180）：初版の利用許諾料を報酬として払う発注（A-077）。確定額に仮計算の注記、明細の報酬名に
    // 「（仮計算。確定は特約第3項）」、利用許諾条件の表に対象の明細・非加算・個別契約・クレジット表記。
    // 147（r2）・176（r3）の SQL はそのまま残し、180 が置き換える。
    // r5（184）：初版の利用許諾料で払う行の支払方法と注記を「制作報酬（初版の利用許諾料の算定方法による）」に
    // （特約第1項の構造に合わせる。A-093）。180（r4）はそのまま残し、184 が置き換える。
    // r6（186）：仮計算の注記を「見込みの額。納品後に確定し、減額しない」に。消費税等の精算文書を検収書・計算書に（A-099）。
    no: "186", key: "purchase_order", label: "発注書",
    body: "templates/purchase_order_v3_body.html", css: "templates/purchase_order_v3_css.txt",
    mark: 'data-layout="po-v3-2026-10r6"', family: 'data-layout="po-v3',
    out: "186_po_layout_v3_r6.sql",
    // 約款は本文に書いてある（{{> terms_spot_2026}}）。
    termsPlaceholder: null,
    title: "発注書のひな形：1 ページ目を固定し、明細は 2 ページ目から（署名式・利用許諾条件つき）",
    intro: `--   これまでの発注書は明細の行数で承諾欄が 2 ページ目へ流れ、紙ごとに署名の
--   位置が変わっていた。1 ページ目を「宛先・発注概要・支払情報・受領確認
--   （承諾）」の行数が決まった表だけで組み、業務明細・手数料・経費・利用
--   許諾条件・特約・通知先は強制改ページの後（2 ページ目以降）に置く。
--
--   ・受領確認（承諾）：受注者の欄（名前・住所・法人で担当者の登録があるとき
--     だけ担当）と、承諾日（12pt が入る下線）・署名の欄。押印欄は無い（署名式）。
--   ・発注署名欄＝あり（SHOW_ORDER_SIGN_SECTION）のときは、同じ場所に
--     発注者・受注者の署名欄（署名日・署名）を出す（甲・乙の表記は使わない）。
--   ・Word に貼っても枠が再現できるよう、箱と署名の下線は表（セルの罫線）で組む。
--   ・成果物の帰属先が受注者の品目があれば「■ 利用許諾条件」の表（利用形態／
--     料率・額／MG・AG／期間／地域・言語）を出す。台帳に無ければ
--     「利用許諾の条件は別途定める」と 1 行で出す。値はアプリが
--     license_terms（A-048）として差す。`,
    checks: `       (strpos(v.html_source, '■ 受領確認（承諾）') > 0) AS 承諾欄,
       (strpos(v.html_source, 'sign-both') > 0) AS 両者署名欄,
       (strpos(v.html_source, '■ 利用許諾条件') > 0) AS 利用許諾条件,`
  },
  {
    // r4（181）：License Terms に対象の明細（Covers）・個別契約・Credit line、確定額の行に報酬名。
    // 148（r2）・177（r3）の SQL はそのまま残し、181 が置き換える。
    // r5（185）：provisional の行の Payment と注記を production fee に（A-093）。181（r4）はそのまま残す。
    // r6（187）：provisional の注記を A-099 に合わせる。
    no: "187", key: "intl_purchase_order", label: "海外版の発注書",
    body: "templates/intl_purchase_order_v3_body.html", css: "templates/intl_purchase_order_v3_css.txt",
    mark: 'data-layout="ipo-v3-2026-10r6"', family: 'data-layout="ipo-v3',
    out: "187_intl_po_layout_v3_r6.sql",
    // 約款の partial 名は現行版の本文から拾って差す（海外版の約款名はここでは決めない）。
    termsPlaceholder: "__TERMS_BLOCK__",
    termsFallback: "terms_spot_intl_2026",
    title: "海外版の発注書のひな形：国内版（147）と同じレイアウトに（Page 1 固定・署名式・License Terms）",
    intro: `--   国内版（147）と同じ考え方。1 ページ目を To/From・Order Summary・Payment・
--   Acceptance（または Signatures）の行数が決まった表だけで組み、Line Items・
--   Other Fees・Expenses・License Terms・Special Terms・Notices は改ページの後。
--
--   ・Acceptance：Contractor の欄（名前・住所・法人で担当者の登録があるときだけ
--     Attn）と Date（12pt が入る 44mm の下線）・Signature。押印欄は無い。
--   ・発注署名欄＝あり なら同じ場所に Purchaser / Contractor の署名欄。
--   ・金額は通貨コード付き（JPY 246,000 / USD 2,460.00）。日付は英語表記。
--   ・Bank Account は取引先の海外口座（A-051）から Bank・Branch・SWIFT/BIC・Country／
--     Beneficiary・Account No.・IBAN・Routing No.・Currency／Bank Address・Intermediary を
--     小さめの 2〜3 行で出す（空の項目は出さない）。手数料は remitting＝発注者・
--     receiving＝受注者。Withholding Tax は Applicable / Not applicable。
--     r2：r1 は銀行名しか出なかった（SWIFT などの差し込み先が無かった）。
--   ・約款（Standard Terms）の partial は現行版の本文にある {{> 名前}} を拾って
--     同じ名前で差す。現行版に無ければ約款は付けない。
--   ・CSS は全部を書く（現行版の head に頼らない）。`,
    checks: `       (strpos(v.html_source, '■ ACCEPTANCE') > 0) AS acceptance,
       (strpos(v.html_source, 'SWIFT/BIC: {{SWIFT_BIC}}') > 0) AS bank_details,
       (strpos(v.html_source, 'sign-both') > 0) AS signatures,
       (strpos(v.html_source, '■ LICENSE TERMS') > 0) AS license_terms,
       (strpos(v.html_source, '{{> ') > 0) AS terms_partial,`
  },
  {
    // r2（189）：頭書きの契約種別を、今回検収する行の契約形式を重複なく並べたもの（請負／準委任）にする（A-118）。
    no: "189", key: "inspection_certificate", label: "検収書",
    body: "templates/inspection_certificate_v2_body.html", css: "templates/inspection_certificate_v2_css.txt",
    mark: 'data-layout="ins-v2-2026-10r2"', family: 'data-layout="ins-v2',
    out: "189_inspection_layout_v2_r2.sql",
    termsPlaceholder: null,
    title: "検収書のひな形 v2 r2：頭書きの契約種別を明細の契約形式から（請負・準委任）",
    intro: `--   役務提供完了通知書（169）と同じ考え方で検収書を組み直す。
--   宛先と当社を横に並べ、件名〜基本契約を「■ 検収概要」の表に、明細は 1 本の表（No.・品目・
--   発注番号・納品日・数量・単価・金額）、合計は表の下に右寄せの小さな欄（小計・消費税・実費・
--   お支払額・お支払予定日・振込先）。「支払条件・発注情報」「通知先」の表と、別表の変更履歴は出さない。
--
--   ・金額が当初から変わったとき（変更履歴があるとき）だけ「■ 変更内容の確認」の署名欄を出す（従来どおり）。
--   ・分納をまとめた検収書は「■ 支払済みの分（参考）」に前回までの行を出す。
--   ・差し込む名前は変えない（delivery_line_items・other_fees・expenses・taxableSubtotalExTaxStr …）。
--     項目の宣言（variables）も現行版のまま。`,
    checks: `       (strpos(v.html_source, '■ 検収概要') > 0) AS 検収概要,
       (strpos(v.html_source, '■ 検収内容') > 0) AS 検収内容,
       (strpos(v.html_source, 'signature-section') > 0) AS 署名欄,`
  }
];

function build(t) {
  const body = readFileSync(join(root, t.body), "utf8").trimEnd();
  const css = readFileSync(join(root, t.css), "utf8").trimEnd();
  if (!body.includes(t.mark)) throw new Error(`${t.body} に目印 ${t.mark} がありません`);
  for (const [name, text] of [["本文", body], ["CSS", css]]) {
    if (text.includes("$q$")) throw new Error(`${name}に $q$ が含まれています（引用符と衝突）`);
  }
  if (t.termsPlaceholder && !body.includes(t.termsPlaceholder)) {
    throw new Error(`${t.body} に約款の差し込み位置 ${t.termsPlaceholder} がありません`);
  }
  const termsSql = t.termsPlaceholder ? `
  -- 約款の partial 名は現行版から拾う（{{> 名前}}）。無ければ、登録済みの既定の約款
  -- （${t.termsFallback}。150 などで登録）を使う。どちらも無ければ約款は付けない。
  terms_partial := COALESCE(
    substring(src from '\\{\\{>\\s*([A-Za-z0-9_]+)\\s*\\}\\}'),
    (SELECT p.template_key FROM v3.document_templates p
      WHERE p.template_key = '${t.termsFallback}' AND p.category = 'partial' AND p.is_active));
  IF terms_partial IS NULL THEN
    RAISE NOTICE '${t.no}: 現行版に約款の partial（{{> …}}）が無いので、約款は付けません';
    body_text := replace(body_text, '${t.termsPlaceholder}', '');
  ELSE
    body_text := replace(body_text, '${t.termsPlaceholder}',
      E'{{#unless HAS_BASE_CONTRACT}}\\n{{> ' || terms_partial || E'}}\\n{{/unless}}');
  END IF;` : "";

  return `-- =====================================================================
-- ${t.title}
--
${t.intro}
--
--   やり方は 120・137 と同じ。現行版の <head>（CSS）を残して </style> の前に
--   CSS を足し、<body>…</body> を丸ごと置き換えた新しい版を作って
--   current_version_id を差し替える。項目の宣言（variables）は現行版のまま。
--   適用済み（本文に ${t.mark} がある）なら何もしない。同じレイアウトの
--   古い改訂が入っていれば、${t.no} より前の版の head を下敷きにして
--   新しい改訂に置き換える（手で前の版に戻さなくてよい）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/${t.out}
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = '${t.key}';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描画される。直すなら訂正版を出す。
--   元の本文と CSS: infra/v3/${t.body} / ${t.css.replace("templates/", "")}
--   （このファイルは infra/v3/tools/make-po-layout-sql.mjs が組み立てる）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  head text;
  new_html text;
  body_text text;
  terms_partial text;
  tpl_id bigint;
  from_version bigint;
  from_no int;
  base_version bigint;
  base_no int;
  next_no int;
  new_id bigint;
  body_pos int;
  css_add constant text := $q$
${css}
$q$;
  new_body constant text := $q$${body}$q$;
BEGIN
  SELECT t.id, v.id, v.version_no, v.html_source INTO tpl_id, from_version, from_no, src
    FROM v3.document_templates t
    JOIN v3.document_template_versions v ON v.id = t.current_version_id
   WHERE t.template_key = '${t.key}';
  IF src IS NULL THEN
    RAISE EXCEPTION '${t.key} のひな形が見つかりません';
  END IF;
  IF strpos(src, '${t.mark}') > 0 THEN
    RAISE NOTICE '${t.no}: 適用済み（本文に ${t.mark} がある）。何もしません';
    RETURN;
  END IF;
  -- 同じレイアウトの古い改訂が入っていれば、${t.no} より前の版（元の head/CSS を
  -- 持つ版）を下敷きにして置き換える。手で前の版に戻す必要はない。
  IF strpos(src, '${t.family}') > 0 THEN
    SELECT v.id, v.version_no, v.html_source INTO base_version, base_no, src
      FROM v3.document_template_versions v
     WHERE v.template_id = tpl_id AND strpos(v.html_source, '${t.family}') = 0
     ORDER BY v.version_no DESC LIMIT 1;
    IF src IS NULL THEN
      RAISE EXCEPTION '${t.no} より前の版が見つかりません（146 で書き出した本文から作り直してください）';
    END IF;
    RAISE NOTICE '${t.no}: 古い改訂（版 %）を置き換える。head は版 % から', from_no, base_no;
  END IF;
  body_pos := strpos(src, '<body');
  IF body_pos = 0 THEN
    RAISE EXCEPTION '<body が見つかりません。146 で現行版を書き出して確かめてください';
  END IF;
  head := left(src, body_pos - 1);
  IF (length(head) - length(replace(head, '</style>', ''))) / length('</style>') <> 1 THEN
    RAISE EXCEPTION '</style> が <head> に 1 箇所ではありません。146 で現行版を確かめてください';
  END IF;
  body_text := new_body;${termsSql}
  new_html := replace(head, '</style>', css_add || E'\\n</style>') || body_text || E'\\n</html>\\n';

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('${t.no}: 1 ページ目固定・明細は 2 ページ目から・署名式・利用許諾条件（%s 版の項目を引き継ぎ）', from_no),
         'sql:${t.no}'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '${t.no}: ${t.key} 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に目印があり、承諾欄・署名欄・利用許諾条件・改ページが揃っていること
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, '${t.mark}') > 0) AS 新レイアウト,
       (strpos(v.html_source, 'class="page-break"') > 0) AS 改ページ,
${t.checks}
       (strpos(v.html_source, 'class="sign-box"') = 0) AS 押印欄なし,
       jsonb_array_length(COALESCE(v.variables, '[]'::jsonb)) AS 項目数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = '${t.key}';
`;
}

for (const t of TARGETS) {
  const sql = build(t);
  writeFileSync(join(root, t.out), sql);
  console.log(`infra/v3/${t.out} を書き出しました（${sql.split("\n").length} 行）`);
}
