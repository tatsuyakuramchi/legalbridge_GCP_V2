import { DomainError } from "../core/errors.js";

/**
 * テンプレート変数の束縛。
 *
 * V2 は form_data の自由なキーが業務データの参照元だったため、相手先ひとつに
 * 10 種類のキー名が並立していた。V3 では **テンプレートが供給元を宣言する**。
 *   { "name": "VENDOR_NAME", "from": "agreement.counterparty.name" }
 * 条件・合意・当事者・作品から解決できないものだけを manual として手入力に回す。
 */
export interface TemplateVariable {
  name: string;
  label?: string;
  /** ドット記法のパス。"manual" は手入力。省略時は manual 扱い。 */
  from?: string;
  required?: boolean;
  /** 手入力の既定値。 */
  default?: unknown;
}

export interface BindingResult {
  values: Record<string, unknown>;
  /** 必須なのに埋まらなかった変数。発行前の検査で使う。 */
  missing: Array<{ name: string; label: string }>;
  /** 供給元から解決した変数（手入力と区別して画面に出す）。 */
  derived: string[];
}

export function parseVariables(raw: unknown): TemplateVariable[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const name = String(record.name ?? "").trim();
    if (!name) return [];
    return [{
      name,
      label: record.label ? String(record.label) : undefined,
      from: record.from ? String(record.from) : undefined,
      required: record.required === true,
      default: record.default
    }];
  });
}

/** ドット記法の取り出し。配列は "conditions.0.name" のように添字で辿る。 */
export function pick(context: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === "object") return (current as Record<string, unknown>)[segment];
    return undefined;
  }, context);
}

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

export function bindVariables(
  variables: TemplateVariable[],
  context: Record<string, unknown>,
  manualInputs: Record<string, unknown> = {}
): BindingResult {
  const values: Record<string, unknown> = {};
  const missing: BindingResult["missing"] = [];
  const derived: string[] = [];

  for (const variable of variables) {
    const manual = manualInputs[variable.name];
    let value: unknown;

    if (!variable.from || variable.from === "manual") {
      value = isEmpty(manual) ? variable.default : manual;
    } else {
      // 供給元から解決する。手入力があってもデータ側を優先しない代わりに、
      // データ側が空のときだけ手入力で補える（移行期の欠測を埋めるため）。
      const resolved = pick(context, variable.from);
      if (!isEmpty(resolved)) {
        value = resolved;
        derived.push(variable.name);
      } else {
        value = isEmpty(manual) ? variable.default : manual;
      }
    }

    if (isEmpty(value)) {
      if (variable.required) missing.push({ name: variable.name, label: variable.label ?? variable.name });
      continue;
    }
    values[variable.name] = value;
  }

  return { values, missing, derived };
}

export function assertComplete(result: BindingResult): void {
  if (!result.missing.length) return;
  throw new DomainError(
    "VALIDATION",
    `必須項目が埋まっていません: ${result.missing.map((m) => m.label).join("、")}`,
    { missing: result.missing }
  );
}
