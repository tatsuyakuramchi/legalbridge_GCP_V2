import Handlebars from "handlebars";
import { registerLegacyHelpers } from "./rendering.js";

/**
 * 文書のHTML描画。ヘルパは V2 からそのまま移植している（テンプレート本文と
 * ヘルパ名は互換境界なので変えない）。変わったのは値の供給元だけ。
 */
export function renderDocumentHtml(
  htmlSource: string,
  values: Record<string, unknown>,
  partials: Record<string, string> = {}
): string {
  const handlebars = Handlebars.create();
  registerLegacyHelpers(handlebars);
  for (const [name, source] of Object.entries(partials)) {
    handlebars.registerPartial(name, source);
  }
  const template = handlebars.compile(htmlSource, { strict: false, noEscape: false });
  return template(values);
}
