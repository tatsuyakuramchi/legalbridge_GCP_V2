import { DomainError } from "../core/errors.js";
import { resolveLegacyDbField, resolveLegacyVariable } from "./legacy-variables.js";
import { isFieldRequested, type LegacyFieldMeta, type ShowWhenCondition } from "./legacy-fields.js";

/**
 * テンプレート変数の束縛。
 *
 * V2 は form_data の自由なキーが業務データの参照元だったため、相手先ひとつに
 * 10 種類のキー名が並立していた。V3 では **テンプレートが供給元を宣言する**。
 *   { "name": "VENDOR_NAME", "from": "agreement.counterparty.name" }
 * 条件・合意・当事者・作品から解決できないものだけを manual として手入力に回す。
 */
export interface TemplateVariable extends LegacyFieldMeta {
  name: string;
  label?: string;
  /** ドット記法のパス。"manual" は手入力。省略時は manual 扱い。 */
  from?: string;
  required?: boolean;
  /** 手入力の既定値。 */
  default?: unknown;
  /**
   * V1 の field_schema が持っていた供給元の宣言（"vendor.bank_name"）。
   * 移行でそのまま残っているので、from が無くてもこれで引ける。
   */
  dbField?: string;
  /** 項目の型。V1 の field_schema 由来。array は明細で、手入力には回さない。 */
  type?: string;
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
      // V1 の field_schema から来る宣言。読まないと全項目が手入力になる。
      dbField: record.dbField ? String(record.dbField) : undefined,
      type: record.type ? String(record.type) : undefined,
      hidden: record.hidden === true,
      readonly: record.readonly === true,
      showWhen: record.showWhen as ShowWhenCondition | ShowWhenCondition[] | undefined,
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

export interface BindOptions {
  /** ひな形のキー。どの項目を人に入力させるかの判定に使う。 */
  templateKey?: string;
  /**
   * ひな形ごとの計算ブロック（明細・合計・消費税）。本文の表と合計は
   * 同じ計算から出さないとずれるので、これは手入力より優先する。
   */
  computed?: Record<string, unknown>;
}

export function bindVariables(
  variables: TemplateVariable[],
  context: Record<string, unknown>,
  manualInputs: Record<string, unknown> = {},
  options: BindOptions = {}
): BindingResult {
  const values: Record<string, unknown> = {};
  const missing: BindingResult["missing"] = [];
  const derived: string[] = [];
  const computed = options.computed ?? {};
  const templateKey = options.templateKey ?? "";

  // 項目の出し分けはお互いの値を見る（showWhen・明細の有無）。
  // 判定用の一式をここで作る。__ 付きは判定にだけ使う内部の値。
  const decisionValues: Record<string, unknown> = {
    ...computed, ...manualInputs,
    __hasRoyalty: Boolean((context as Record<string, unknown>).royalty),
    __counterpartyKind:
      ((context as any).condition?.counterparty?.kind as string | undefined) ?? null
  };

  for (const variable of variables) {
    const manual = manualInputs[variable.name];
    let value: unknown;

    // 計算で決まる値が先。明細から出した合計を手入力で上書きさせない
    // （本文の表と合計がずれる）。
    const calculated = computed[variable.name];
    if (!isEmpty(calculated)) {
      values[variable.name] = calculated;
      derived.push(variable.name);
      continue;
    }

    if (!variable.from || variable.from === "manual") {
      // 供給元の宣言が無い変数は、V1/V2 と同じ名前なら同じ値を入れる。
      // 移行したひな形には宣言が無いので、これが無いと全項目が手入力になる。
      // 手入力が先。人が直したものをデータで上書きしない。
      if (!isEmpty(manual)) {
        value = manual;
      } else {
        // dbField（V1 の宣言）→ 名前の対応表、の順に見る。宣言のほうが確か。
        const declared = variable.dbField
          ? resolveLegacyDbField(variable.dbField, context)
          : undefined;
        const legacy = isEmpty(declared)
          ? resolveLegacyVariable(variable.name, context, variable.label)
          : declared;
        if (!isEmpty(legacy)) {
          value = legacy;
          derived.push(variable.name);
        } else {
          value = variable.default;
        }
      }
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
      // 人に入力させない項目（計算で埋まる欄・使わない分岐の欄・隠し項目）は
      // 未入力として数えない。ここを見ていなかったので、検収書は入力しようの
      // ない項目まで必須として要求していた。
      if (variable.required && isFieldRequested(templateKey, variable, decisionValues)) {
        missing.push({ name: variable.name, label: variable.label ?? variable.name });
      }
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
