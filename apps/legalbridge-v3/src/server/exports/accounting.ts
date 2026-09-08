import type { XlsColumn } from "./xls.js";

/**
 * 経理提出用の帳票（V1 互換レイアウト）。
 *
 * V1 の excelService.buildFromFormData が出していた列並び
 *   件名／支払日／部署／取引先コード／氏名／氏名（カナ）／
 *   支払内容・単価・数量・金額・納品日 × 8／
 *   立替金／小計／消費税／源泉税／税引後／差引振込額／インボイス登録
 * をそのまま保つ。提出先の運用を変えさせないため、列名も順番も変えない。
 *
 * 中身の作り方は V1・V2 と違う。V1/V2 は文書の form_data（JSON の塊）を
 * 10通りの別名キーで舐めて金額を拾っていた。V3 は支払・割当・条件が列に
 * 分かれているので、そこから組む。別名を推測する必要がない。
 *
 * 行の単位は「支払1件」。V1 が文書を単位にしていたのは、V1 に支払という
 * 実体が無く、文書が支払の引き金だったから。V3 は payments が支払日も
 * 振込額も源泉も持っているので、そちらが単位として正しい。
 */

export const ACCOUNTING_SLOT_COUNT = 8;

export interface AccountingSlot {
  content: string;
  unitPrice: number | "";
  quantity: number | "";
  amount: number | "";
  deliveryDate: string;
}

/** 支払の割当1件。条件と、分かっていれば実績の数量・単価・日付。 */
export interface AllocationLine {
  conditionNo: string | null;
  name: string;
  taxCategory: "taxable" | "reduced" | "exempt";
  /** 主要通貨単位。最小単位のままここへ渡さない。 */
  amount: number;
  quantity: number | null;
  unitAmount: number | null;
  occurredOn: string | null;
}

export interface AccountingSource {
  paymentId: number;
  paymentNo: string | null;
  currency: string;
  /** 税抜（主要通貨単位）。 */
  amount: number;
  taxAmount: number;
  withholdingAmount: number;
  dueOn: string | null;
  paidOn: string | null;
  status: string;
  party: {
    code: string | null; name: string; kana: string | null;
    kind: "corporate" | "individual"; invoiceNo: string | null; withholding: boolean;
  };
  ownerName: string | null;
  ownerDepartment: string | null;
  matterNo: string | null;
  matterTitle: string | null;
  lines: AllocationLine[];
}

export interface AccountingRow {
  paymentId: number;
  paymentNo: string | null;
  currency: string;
  title: string;
  paymentDate: string;
  department: string;
  vendorCode: string;
  vendorName: string;
  vendorNameKana: string;
  slots: AccountingSlot[];        // 常に8要素
  reimbursement: number;          // 立替金（非課税・不課税）
  subtotal: number;               // 課税対象の税抜小計
  consumptionTax: number;
  withholdingTax: number;
  afterTax: number;               // 税込 − 源泉
  netTransfer: number;            // 税引後 + 立替金
  invoiceRegistration: string;
  taxable10: number;
  reduced8: number;
  exempt: number;
  /**
   * 気づけるようにするための印。黙って空欄・0 を出さない。
   *   unallocated       … 割当が無い。支払内容の欄が埋まらない
   *   allocationMismatch… 割当の合計が支払額と合わない
   *   withholdingGap    … 源泉の保存値が計算値と違う
   */
  flags: string[];
  withholdingExpected: number;
}

const emptySlot = (): AccountingSlot =>
  ({ content: "", unitPrice: "", quantity: "", amount: "", deliveryDate: "" });

/**
 * 9件目以降は8件目に束ねる（V1 と同じ）。
 * 落とすと合計が合わなくなるので、内容を連結して金額を足す。
 */
export function fitSlots(slots: AccountingSlot[]): AccountingSlot[] {
  const fitted = slots.slice(0, ACCOUNTING_SLOT_COUNT);
  const rest = slots.slice(ACCOUNTING_SLOT_COUNT);
  if (rest.length) {
    const last = fitted[ACCOUNTING_SLOT_COUNT - 1];
    fitted[ACCOUNTING_SLOT_COUNT - 1] = {
      content: [last.content, ...rest.map((s) => s.content)].filter(Boolean).join("／"),
      unitPrice: "", quantity: "",
      amount: [last, ...rest].reduce((sum, s) => sum + (Number(s.amount) || 0), 0),
      deliveryDate: last.deliveryDate
    };
  }
  while (fitted.length < ACCOUNTING_SLOT_COUNT) fitted.push(emptySlot());
  return fitted;
}

/** 源泉の期待値。V1 と同じく税込ベース。判定も V1 と同じ（個人か源泉ONなら対象）。 */
export function expectedWithholding(
  subtotal: number, consumptionTax: number,
  party: { kind: string; withholding: boolean }
): number {
  if (!(party.withholding || party.kind === "individual")) return 0;
  const base = subtotal + consumptionTax;
  if (base <= 0) return 0;
  if (base <= 1_000_000) return Math.floor(base * 0.1021);
  return Math.floor(1_000_000 * 0.1021) + Math.floor((base - 1_000_000) * 0.2042);
}

export function buildAccountingRow(source: AccountingSource): AccountingRow {
  const flags: string[] = [];
  const lineTotal = source.lines.reduce((sum, l) => sum + l.amount, 0);
  // 割当が支払額を丸ごと説明できているときだけ、税区分の内訳に使う。
  // 説明できていない内訳で経理の列を埋めると、合計だけ合って中身が違う表になる。
  const covered = source.lines.length > 0 && lineTotal === source.amount;
  if (!source.lines.length) flags.push("unallocated");
  else if (!covered) flags.push("allocationMismatch");

  const byCategory = (category: AllocationLine["taxCategory"]) =>
    source.lines.filter((l) => l.taxCategory === category).reduce((sum, l) => sum + l.amount, 0);

  // 割当が無い／合わないときは、支払額をそのまま課税対象として出す。
  // 条件の既定の税区分が taxable なので、勝手に非課税へ振り分けない。
  const taxable10 = covered ? byCategory("taxable") : source.amount;
  const reduced8 = covered ? byCategory("reduced") : 0;
  const exempt = covered ? byCategory("exempt") : 0;

  const subtotal = taxable10 + reduced8;
  const reimbursement = exempt;
  const consumptionTax = source.taxAmount;
  const withholdingTax = source.withholdingAmount;
  const afterTax = subtotal + consumptionTax - withholdingTax;

  const withholdingExpected = expectedWithholding(subtotal, consumptionTax, source.party);
  // 源泉が違うと申告が狂う。黙って出さずに印を付ける。
  if (withholdingExpected !== withholdingTax) flags.push("withholdingGap");

  const slots = fitSlots(source.lines.map((l) => ({
    content: [l.conditionNo, l.name].filter(Boolean).join(" ") || "（内容未設定）",
    unitPrice: l.unitAmount ?? "",
    quantity: l.quantity ?? "",
    amount: l.amount,
    deliveryDate: l.occurredOn ?? ""
  })));

  return {
    paymentId: source.paymentId,
    paymentNo: source.paymentNo,
    currency: source.currency,
    // 件名は案件名を優先する。経理は「何の支払か」で照合するため。
    title: source.matterTitle || source.lines[0]?.name || source.paymentNo || "",
    paymentDate: source.paidOn ?? source.dueOn ?? "",
    department: source.ownerDepartment ?? "",
    vendorCode: source.party.code ?? "",
    vendorName: source.party.name,
    vendorNameKana: source.party.kana ?? "",
    slots,
    reimbursement, subtotal, consumptionTax, withholdingTax, afterTax,
    netTransfer: afterTax + reimbursement,
    invoiceRegistration: source.party.invoiceNo ?? "",
    taxable10, reduced8, exempt,
    flags, withholdingExpected
  };
}

export interface AccountingGroup {
  key: string;
  /** 支払期日。空なら未設定。 */
  paymentDate: string;
  owner: string;
  currency: string;
  count: number;
  rows: AccountingRow[];
  totals: {
    subtotal: number; consumptionTax: number; withholdingTax: number;
    reimbursement: number; netTransfer: number;
  };
  /** この束に何件の要確認があるか。 */
  flagged: number;
}

/**
 * 束ね方。V1 は「種別 × 担当者 × 支払期日」だった。V3 は支払が単位なので
 * 種別の軸が無くなり、代わりに**通貨**を軸に入れる。通貨を混ぜた合計は
 * 意味を持たないので、束ねる時点で分けておく。
 */
export function groupAccounting(rows: AccountingRow[], owners: Map<number, string>): AccountingGroup[] {
  const groups = new Map<string, AccountingGroup>();
  for (const row of rows) {
    const owner = owners.get(row.paymentId) ?? "(担当者未設定)";
    const key = `${row.paymentDate}||${owner}||${row.currency}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key, paymentDate: row.paymentDate, owner, currency: row.currency,
        count: 0, rows: [], flagged: 0,
        totals: { subtotal: 0, consumptionTax: 0, withholdingTax: 0, reimbursement: 0, netTransfer: 0 }
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.count += 1;
    if (row.flags.length) group.flagged += 1;
    group.totals.subtotal += row.subtotal;
    group.totals.consumptionTax += row.consumptionTax;
    group.totals.withholdingTax += row.withholdingTax;
    group.totals.reimbursement += row.reimbursement;
    group.totals.netTransfer += row.netTransfer;
  }
  // 支払期日の昇順（空は末尾）→ 担当者名。V1 と同じ並び。
  return [...groups.values()].sort((a, b) => {
    const ad = a.paymentDate || "9999-12-31";
    const bd = b.paymentDate || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.owner.localeCompare(b.owner, "ja");
  });
}

const slotOf = (row: AccountingRow, i: number): AccountingSlot => row.slots[i] ?? emptySlot();

const FLAG_LABEL: Record<string, string> = {
  unallocated: "割当なし",
  allocationMismatch: "割当が支払額と不一致",
  withholdingGap: "源泉が計算値と不一致"
};

/** 経理提出用の列。V1 の並びを変えない。末尾に V3 で分かることを足す。 */
export const ACCOUNTING_COLUMNS: Array<XlsColumn<AccountingRow>> = [
  { header: "件名", value: (r) => r.title },
  { header: "支払日", value: (r) => r.paymentDate },
  { header: "部署", value: (r) => r.department },
  { header: "取引先コード", value: (r) => r.vendorCode },
  { header: "氏名", value: (r) => r.vendorName },
  { header: "氏名（カナ）", value: (r) => r.vendorNameKana },
  ...Array.from<unknown, Array<XlsColumn<AccountingRow>>>(
    { length: ACCOUNTING_SLOT_COUNT }, (_, i) => ([
    { header: `支払内容（${i + 1}）`, value: (r: AccountingRow) => slotOf(r, i).content },
    { header: `単価（${i + 1}）`, value: (r: AccountingRow) => slotOf(r, i).unitPrice },
    { header: `数量（${i + 1}）`, value: (r: AccountingRow) => slotOf(r, i).quantity },
    { header: `金額（${i + 1}）`, value: (r: AccountingRow) => slotOf(r, i).amount },
    { header: `納品日(${i + 1})`, value: (r: AccountingRow) => slotOf(r, i).deliveryDate }
  ])).flat(),
  { header: "立替金", value: (r) => r.reimbursement },
  { header: "小計", value: (r) => r.subtotal },
  { header: "消費税", value: (r) => r.consumptionTax },
  { header: "源泉税", value: (r) => r.withholdingTax },
  { header: "税引後", value: (r) => r.afterTax },
  { header: "差引振込額", value: (r) => r.netTransfer },
  { header: "インボイス登録", value: (r) => r.invoiceRegistration },
  { header: "課税対象（10%）税抜", value: (r) => r.taxable10 },
  { header: "課税対象（8%）税抜", value: (r) => r.reduced8 },
  { header: "非課税・不課税", value: (r) => r.exempt },
  { header: "通貨", value: (r) => r.currency },
  { header: "支払番号", value: (r) => r.paymentNo ?? "" },
  // 経理が受け取った表の中で「確かめるべき行」が分かるようにする。
  { header: "要確認", value: (r) => r.flags.map((f) => FLAG_LABEL[f] ?? f).join("／") }
];

/** 内訳一覧。金額の内訳と要確認だけを見たいとき。 */
export const BREAKDOWN_COLUMNS: Array<XlsColumn<AccountingRow>> = [
  { header: "支払番号", value: (r) => r.paymentNo ?? "" },
  { header: "支払日", value: (r) => r.paymentDate },
  { header: "件名", value: (r) => r.title },
  { header: "取引先", value: (r) => r.vendorName },
  { header: "課税対象（10%）税抜", value: (r) => r.taxable10 },
  { header: "課税対象（8%）税抜", value: (r) => r.reduced8 },
  { header: "非課税・不課税", value: (r) => r.exempt },
  { header: "消費税", value: (r) => r.consumptionTax },
  { header: "源泉税", value: (r) => r.withholdingTax },
  { header: "源泉税（計算値）", value: (r) => r.withholdingExpected },
  { header: "差引振込額", value: (r) => r.netTransfer },
  { header: "通貨", value: (r) => r.currency },
  { header: "要確認", value: (r) => r.flags.map((f) => FLAG_LABEL[f] ?? f).join("／") }
];

/** 合計行。V1 と同じく末尾に付ける。 */
export function totalRow(group: AccountingGroup): AccountingRow {
  return {
    paymentId: 0, paymentNo: "合計", currency: group.currency,
    title: `${group.count}件`, paymentDate: "", department: "",
    vendorCode: "", vendorName: "", vendorNameKana: "",
    slots: fitSlots([]),
    reimbursement: group.totals.reimbursement,
    subtotal: group.totals.subtotal,
    consumptionTax: group.totals.consumptionTax,
    withholdingTax: group.totals.withholdingTax,
    afterTax: group.totals.subtotal + group.totals.consumptionTax - group.totals.withholdingTax,
    netTransfer: group.totals.netTransfer,
    invoiceRegistration: "",
    taxable10: group.rows.reduce((s, r) => s + r.taxable10, 0),
    reduced8: group.rows.reduce((s, r) => s + r.reduced8, 0),
    exempt: group.rows.reduce((s, r) => s + r.exempt, 0),
    flags: [], withholdingExpected: group.rows.reduce((s, r) => s + r.withholdingExpected, 0)
  };
}
