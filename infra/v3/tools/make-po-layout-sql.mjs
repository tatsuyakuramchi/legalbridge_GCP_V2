// 147_po_layout_v3.sql を templates/ の本文と CSS から組み立てる。
//   node infra/v3/tools/make-po-layout-sql.mjs
// 本文（purchase_order_v3_body.html）と足す CSS（purchase_order_v3_css.txt）を
// 直したらこれを流して SQL を作り直す。SQL は Cloud SQL Studio にそのまま貼れる
// （psql のメタコマンドを使わない）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const body = readFileSync(join(root, "templates/purchase_order_v3_body.html"), "utf8").trimEnd();
const css = readFileSync(join(root, "templates/purchase_order_v3_css.txt"), "utf8").trimEnd();
const MARK = 'data-layout="po-v3-2026-09r2"';
// 同じレイアウトの古い改訂（r1 …）を見分ける目印。これがあれば「置き換え」になる。
const FAMILY = 'data-layout="po-v3';
if (!body.includes(MARK)) throw new Error(`本文に目印 ${MARK} がありません`);
for (const [name, text] of [["本文", body], ["CSS", css]]) {
  if (text.includes("$q$")) throw new Error(`${name}に $q$ が含まれています（引用符と衝突）`);
}

const sql = `-- =====================================================================
-- 発注書のひな形：1 ページ目を固定し、明細は 2 ページ目から（署名式・利用許諾条件つき）
--
--   これまでの発注書は明細の行数で承諾欄が 2 ページ目へ流れ、紙ごとに署名の
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
--     license_terms（A-048）として差す。
--
--   やり方は 120・137 と同じ。現行版の <head>（CSS）を残して </style> の前に
--   CSS を足し、<body>…</body> を丸ごと置き換えた新しい版を作って
--   current_version_id を差し替える。項目の宣言（variables）は現行版のまま。
--   適用済み（本文に ${MARK} がある）なら何もしない。同じレイアウトの
--   古い改訂（甲乙ありの版など）が入っていれば、147 より前の版の head を
--   下敷きにして新しい改訂に置き換える（手で前の版に戻さなくてよい）。
--
--   実行: Cloud SQL Studio にそのまま貼る／ローカルは
--         docker compose run --rm ops sql /v3/147_po_layout_v3.sql
--   戻すとき: UPDATE v3.document_templates SET current_version_id = <前の版id>
--            WHERE template_key = 'purchase_order';（前の版id は NOTICE に出る）
--   注意: すでに決定した文書は決定時の版で描画される。直すなら訂正版を出す。
--   元の本文と CSS: infra/v3/templates/purchase_order_v3_body.html / _css.txt
--   （このファイルは infra/v3/tools/make-po-layout-sql.mjs が組み立てる）
-- =====================================================================

BEGIN;

DO $do$
DECLARE
  src text;
  head text;
  new_html text;
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
   WHERE t.template_key = 'purchase_order';
  IF src IS NULL THEN
    RAISE EXCEPTION 'purchase_order のひな形が見つかりません';
  END IF;
  IF strpos(src, '${MARK}') > 0 THEN
    RAISE NOTICE '147: 適用済み（本文に ${MARK} がある）。何もしません';
    RETURN;
  END IF;
  -- 同じレイアウトの古い改訂が入っていれば、147 より前の版（元の head/CSS を
  -- 持つ版）を下敷きにして置き換える。手で前の版に戻す必要はない。
  IF strpos(src, '${FAMILY}') > 0 THEN
    SELECT v.id, v.version_no, v.html_source INTO base_version, base_no, src
      FROM v3.document_template_versions v
     WHERE v.template_id = tpl_id AND strpos(v.html_source, '${FAMILY}') = 0
     ORDER BY v.version_no DESC LIMIT 1;
    IF src IS NULL THEN
      RAISE EXCEPTION '147 より前の版が見つかりません（146 で書き出した本文から作り直してください）';
    END IF;
    RAISE NOTICE '147: 古い改訂（版 %）を置き換える。head は版 % から', from_no, base_no;
  END IF;
  body_pos := strpos(src, '<body');
  IF body_pos = 0 THEN
    RAISE EXCEPTION '<body が見つかりません。146 で現行版を書き出して確かめてください';
  END IF;
  head := left(src, body_pos - 1);
  IF (length(head) - length(replace(head, '</style>', ''))) / length('</style>') <> 1 THEN
    RAISE EXCEPTION '</style> が <head> に 1 箇所ではありません。146 で現行版を確かめてください';
  END IF;
  new_html := replace(head, '</style>', css_add || E'\\n</style>') || new_body || E'\\n</html>\\n';

  SELECT COALESCE(max(version_no), 0) + 1 INTO next_no
    FROM v3.document_template_versions WHERE template_id = tpl_id;
  INSERT INTO v3.document_template_versions (template_id, version_no, html_source, variables, comment, created_by)
  SELECT tpl_id, next_no, new_html, v.variables,
         format('147: 1 ページ目固定・明細は 2 ページ目から・署名式・利用許諾条件（%s 版の項目を引き継ぎ）', from_no),
         'sql:147'
    FROM v3.document_template_versions v WHERE v.id = from_version
  RETURNING id INTO new_id;
  UPDATE v3.document_templates SET current_version_id = new_id WHERE id = tpl_id;
  RAISE NOTICE '147: purchase_order 前の版 id=%（版 %）→ 新しい版 id=%（版 %）', from_version, from_no, new_id, next_no;
END
$do$;

COMMIT;

-- 確認：現行版に目印があり、承諾欄・署名欄・利用許諾条件・改ページが揃っていること
SELECT t.template_key AS ひな形, v.version_no AS 版, v.id AS 版id,
       (strpos(v.html_source, '${MARK}') > 0) AS 新レイアウト,
       (strpos(v.html_source, 'class="page-break"') > 0) AS 改ページ,
       (strpos(v.html_source, '■ 受領確認（承諾）') > 0) AS 承諾欄,
       (strpos(v.html_source, 'sign-both') > 0) AS 両者署名欄,
       (strpos(v.html_source, '■ 利用許諾条件') > 0) AS 利用許諾条件,
       (strpos(v.html_source, 'class="sign-box"') = 0) AS 押印欄なし,
       jsonb_array_length(COALESCE(v.variables, '[]'::jsonb)) AS 項目数
  FROM v3.document_templates t
  JOIN v3.document_template_versions v ON v.id = t.current_version_id
 WHERE t.template_key = 'purchase_order';
`;
writeFileSync(join(root, "147_po_layout_v3.sql"), sql);
console.log(`infra/v3/147_po_layout_v3.sql を書き出しました（${sql.split("\n").length} 行）`);
