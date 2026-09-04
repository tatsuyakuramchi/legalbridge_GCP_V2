import Handlebars from "handlebars";
import { masterEntityTypeFor } from "../../honorific.js";
import type { TemplateRepository } from "./template-repository.js";
import type { RegisteredDocument } from "./registry-repository.js";
import { registerLegacyHelpers } from "./rendering.js";
import {
  buildIndividualLicenseV3Context,
  INDIVIDUAL_LICENSE_V3_KEY
} from "./individual-license-v3.js";
import { buildTemplateDocumentContext } from "./template-context-adapters.js";

export class StoredDocumentTemplateVersionError extends Error {
  constructor(
    readonly storedVersionId: number | null,
    readonly currentVersionId: number
  ) {
    super("stored document template version is not available");
  }
}

export async function renderStoredDocumentHtml(
  templates: TemplateRepository,
  document: RegisteredDocument
) {
  // 確定済み文書は自分の版（templateVersionId）で描く。テンプレ改訂（現行版の差し替え）後も、
  // 過去の版の html_source が残っていればそのまま再描画できる。版の行が消えていて
  // 現行版しか無いときだけ、下の不一致エラーになる。
  const template = await templates.findRenderSource(document.templateType, document.templateVersionId);
  if (!template) return null;
  if (
    document.templateVersionId !== null &&
    document.templateVersionId !== template.templateVersionId
  ) {
    throw new StoredDocumentTemplateVersionError(
      document.templateVersionId,
      template.templateVersionId
    );
  }

  const handlebars = Handlebars.create();
  registerLegacyHelpers(handlebars);
  const partials = await templates.findPartials();
  for (const [name, source] of Object.entries(partials)) {
    handlebars.registerPartial(name, source);
  }
  const render = handlebars.compile(template.htmlSource, {
    strict: false,
    noEscape: false
  });
  const numberedFormData = {
    ...document.formData,
    ...masterEntityTypeOverrides(document),
    契約書番号: document.documentNumber,
    文書番号: document.documentNumber,
    CONTRACT_NO: document.documentNumber,
    DOC_NO: document.documentNumber,
    document_number: document.documentNumber
  };
  const context = document.templateType === INDIVIDUAL_LICENSE_V3_KEY
    ? buildIndividualLicenseV3Context(numberedFormData)
    : buildTemplateDocumentContext(document.templateType, numberedFormData);
  const rendered = render({
    ...context,
    DOCUMENT_NUMBER: document.documentNumber,
    document_number: document.documentNumber,
    issue_key: document.issueKey
  });
  return wrapPrintableHtml(rendered);
}

// 相手先の宛名に使う名前（区分の突き合わせ対象）。documents.vendor_id を引くときと
// 同じ順序で見る（finalization の PARTY_NAME_KEYS と揃える）。
const VENDOR_NAME_KEYS = ["VENDOR_NAME", "取引先", "相手先", "counterparty", "PARTY_A_NAME"];
const LICENSOR_NAME_KEYS = ["LICENSOR_NAME", "Licensor_氏名会社名", "Licensor_名称", "許諾者名", "許諾者"];

// 区分（法人／個人）は取引先マスタを正とする。form_data の区分は、取引先ボタンで
// 引いた値がそのまま残るため、宛名だけ書き換えた文書では前の相手の区分が残る
// （ARC-PO-2026-0115 は 宛名=個人・区分=法人 で保存されていた）。
// マスタの名称と宛名が一致するときだけ上書きする（別人のマスタでは触らない）。
export function masterEntityTypeOverrides(document: RegisteredDocument): Record<string, string> {
  const master = document.vendorMaster;
  if (!master) return {};
  const formData = document.formData ?? {};
  const overrides: Record<string, string> = {};
  const vendor = masterEntityTypeFor(firstText(formData, VENDOR_NAME_KEYS), master);
  if (vendor) overrides.VENDOR_MASTER_ENTITY_TYPE = vendor;
  const licensor = masterEntityTypeFor(firstText(formData, LICENSOR_NAME_KEYS), master);
  if (licensor) overrides.LICENSOR_MASTER_ENTITY_TYPE = licensor;
  return overrides;
}

function firstText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  return "";
}

// 印刷レイアウト。テンプレート本体には @page も改ページ制御も無く、
// Chromium の --print-to-pdf は @page が無いと A4 ではなく既定用紙で組むため、
// 用紙サイズも改ページ位置も運任せになっていた（表や枠が途中で割れる）。
// テンプレート側を直すと版が上がり、既存文書の再描画が
// StoredDocumentTemplateVersionError で全滅するので、描画時に注入する。
export const PRINT_STYLESHEET = `<style data-legalbridge="print">
  @page { size: A4; margin: 12mm; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* 行と囲み枠は途中で割らない。長い明細表そのものには avoid を付けない
     （1ページに入らない表が丸ごと次ページへ送られて大きな空白ができる）。 */
  tr, .terms-box, .callout, .summary, .party, .sign-box, .amount-note {
    break-inside: avoid; page-break-inside: avoid;
  }
  /* 複数ページに渡る表は見出し行を各ページで繰り返す。 */
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  /* 見出しだけがページ末尾に取り残されないように。 */
  .section-mark, h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
</style>`;

export function wrapPrintableHtml(source: string) {
  // テンプレートが完全な HTML を返す場合は、その <head> の最後に印刷CSSを足す。
  // 最後に置くことで、テンプレート側の同名指定より後勝ちになる。
  if (/<html[\s>]/i.test(source)) {
    if (/<\/head>/i.test(source)) {
      return source.replace(/<\/head>/i, `${PRINT_STYLESHEET}\n</head>`);
    }
    // <head> が無い（body 直書き）テンプレートでも用紙設定は当てる。
    if (/<body[\s>]/i.test(source)) {
      return source.replace(/<body([\s>])/i, `<head>${PRINT_STYLESHEET}</head><body$1`);
    }
    return source.replace(/<html([^>]*)>/i, `<html$1><head>${PRINT_STYLESHEET}</head>`);
  }
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  ${PRINT_STYLESHEET}
  <style>
    body { margin: 0; font-family: "Noto Sans CJK JP", "Noto Serif CJK JP", sans-serif; }
  </style>
</head>
<body>${source}</body>
</html>`;
}
