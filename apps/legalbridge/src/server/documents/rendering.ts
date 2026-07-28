type HelperRegistry = {
  registerHelper(name: string, helper: (...args: any[]) => unknown): void;
};

export function registerLegacyHelpers(handlebars: HelperRegistry) {
  handlebars.registerHelper("eq", (a, b) => a === b);
  handlebars.registerHelper("ne", (a, b) => a !== b);
  handlebars.registerHelper("formatCurrency", formatCurrency);
  handlebars.registerHelper("formatDate", formatDate);
  handlebars.registerHelper("formatDateCompact", formatDateCompact);
  handlebars.registerHelper("add", (a, b) => Number(a) + Number(b));
  handlebars.registerHelper("multiply", (a, b) => (Number(a) || 0) * (Number(b) || 0));
  handlebars.registerHelper("index1", (index) => Number(index) + 1);
  handlebars.registerHelper("circledNum", circledNum);
  handlebars.registerHelper("formatPct", formatPct);
  handlebars.registerHelper("formatYen", formatYen);
  handlebars.registerHelper("formatMoney", formatMoney);
  handlebars.registerHelper("or", (a, b) => (a ? a : b));
  handlebars.registerHelper("gt", (a, b) => Number(a) > Number(b));
  handlebars.registerHelper("lt", (a, b) => Number(a) < Number(b));
  handlebars.registerHelper("join", join);
  handlebars.registerHelper("length", (value) => Array.isArray(value) ? value.length : 0);
  handlebars.registerHelper("concat", (...args) =>
    args.slice(0, -1).map((value) => value == null ? "" : String(value)).join("")
  );
  handlebars.registerHelper("cycleLabel", cycleLabel);
  handlebars.registerHelper("invoiceLabel", invoiceLabel);
  handlebars.registerHelper("cycleLabelEn", cycleLabelEn);
  handlebars.registerHelper("billingDayLabel", billingDayLabel);
  handlebars.registerHelper("billingDayLabelEn", billingDayLabelEn);
}

export function buildRenderContext(formData: Record<string, unknown>) {
  const details =
    formData.details && typeof formData.details === "object" && !Array.isArray(formData.details)
      ? formData.details as Record<string, unknown>
      : {};
  return {
    ...formData,
    ...expandDateFields(formData),
    ...expandDateFields(details)
  };
}

function expandDateFields(values: Record<string, unknown>) {
  const expanded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") continue;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) continue;
    expanded[`${key}_YEAR`] ??= String(Number(match[1]));
    expanded[`${key}_MONTH`] ??= String(Number(match[2]));
    expanded[`${key}_DAY`] ??= String(Number(match[3]));
  }
  return expanded;
}

function toNumber(value: unknown) {
  return typeof value === "number"
    ? value
    : Number.parseFloat(String(value).replace(/[^0-9.-]+/g, ""));
}

function formatCurrency(value: unknown) {
  const number = toNumber(value ?? 0);
  return Number.isFinite(number)
    ? new Intl.NumberFormat("ja-JP").format(Math.floor(number))
    : "0";
}

function formatDate(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Asia/Tokyo"
      });
}

function formatDateCompact(value: unknown) {
  if (!value) return "";
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date).replaceAll("-", "/");
}

function circledNum(index: unknown) {
  const number = Number(index) + 1;
  const circled = [
    "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
    "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"
  ];
  return circled[number - 1] || `${number}.`;
}

function formatPct(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number)
    ? `${number.toFixed(4).replace(/\.?0+$/, "")} %`
    : String(value);
}

function formatYen(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `¥ ${new Intl.NumberFormat("ja-JP").format(Math.floor(number))}`
    : "¥ 0";
}

function formatMoney(value: unknown) {
  const number = toNumber(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  const hasFraction = Math.abs(number % 1) > 1e-9;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2
  }).format(number);
}

function join(values: unknown, separator: unknown) {
  if (!Array.isArray(values)) return "";
  return values.map((value) => {
    if (!value || typeof value !== "object") return value;
    const item = value as { value?: unknown; label?: unknown };
    return item.value ?? item.label ?? "";
  }).join(typeof separator === "string" ? separator : ", ");
}

function cycleLabel(cycle: unknown) {
  const value = String(cycle || "").toUpperCase();
  if (value === "QUARTERLY") return "四半期";
  if (value === "SEMIANNUAL") return "半年";
  if (value === "ANNUAL") return "年次";
  return "月次";
}

function invoiceLabel(value: unknown) {
  if (value === true) return "該当";
  if (value === false || value == null) return "非該当";
  const normalized = String(value).trim();
  if (!normalized) return "非該当";
  if (normalized === "該当" || normalized === "非該当") return normalized;
  const lower = normalized.toLowerCase();
  if (["true", "yes", "y", "1", "○", "✓"].includes(lower)) return "該当";
  if (["false", "no", "n", "0", "×"].includes(lower)) return "非該当";
  return normalized;
}

function cycleLabelEn(cycle: unknown, intervalUnit: unknown, intervalCount: unknown) {
  const value = String(cycle || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (value === "CUSTOM") {
    const count = Number(intervalCount);
    if (Number.isFinite(count) && count > 0) {
      const unit = String(intervalUnit || "").toUpperCase() === "DAY" ? "day" : "month";
      return `Every ${count} ${unit}${count > 1 ? "s" : ""}`;
    }
    return "Custom cycle";
  }
  const labels: Record<string, string> = {
    QUARTERLY: "Quarterly",
    SEMIANNUAL: "Semi-annual",
    ANNUAL: "Annual",
    MONTHLY: "Monthly"
  };
  return labels[value] ?? (cycle ? String(cycle) : "Periodic");
}

function billingDayLabel(day: unknown, cycle: unknown, timing: unknown) {
  if (day === null || day === undefined || day === "") return "";
  const number = Number(day);
  if (Number.isNaN(number)) return "";
  const cycleValue = String(cycle || "").toUpperCase();
  const prefix =
    cycleValue === "QUARTERLY" ? "毎四半期"
    : cycleValue === "SEMIANNUAL" ? "毎半期"
    : cycleValue === "ANNUAL" ? "毎年"
    : "毎月";
  const dayLabel = number === 0 || number > 30 ? "末日" : `${number}日`;
  const timingValue = typeof timing === "string" ? timing.toUpperCase() : "";
  const timingLabel =
    timingValue === "SAME_MONTH" ? "当月"
    : timingValue === "NEXT_MONTH" ? "翌月"
    : timingValue === "MONTH_AFTER_NEXT" ? "翌々月"
    : "";
  if (!timingLabel) return `${prefix}${dayLabel}`;
  const cyclePrefix = !cycleValue || cycleValue === "MONTHLY" ? "" : `${prefix}・`;
  return `${cyclePrefix}${timingLabel}${dayLabel}払い`;
}

function billingDayLabelEn(day: unknown, cycle: unknown, timing: unknown) {
  if (day === null || day === undefined || day === "") return "";
  const number = Number(day);
  if (Number.isNaN(number)) return "";
  const cycleValue = String(cycle || "").toUpperCase().replace(/[^A-Z]/g, "");
  const period =
    cycleValue === "QUARTERLY" ? "quarter"
    : cycleValue === "SEMIANNUAL" ? "half-year"
    : cycleValue === "ANNUAL" ? "year"
    : cycleValue === "CUSTOM" ? "period"
    : "month";
  const dayPhrase = number === 0 || number > 30 ? "end" : `day ${number}`;
  const timingValue = typeof timing === "string" ? timing.toUpperCase() : "";
  if (timingValue === "NEXT_MONTH") {
    return period === "month"
      ? `${dayPhrase} of the following month`
      : `${dayPhrase} of the month following each ${period}`;
  }
  if (timingValue === "MONTH_AFTER_NEXT") {
    return period === "month"
      ? `${dayPhrase} of the second following month`
      : `${dayPhrase} of the second month following each ${period}`;
  }
  return number === 0 || number > 30
    ? `end of each ${period}`
    : `day ${number} of each ${period}`;
}
