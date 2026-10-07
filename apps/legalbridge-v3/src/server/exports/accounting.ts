import { consumptionTax, resolveWithholdingEnabled, withholdingFor } from "../royalty/tax.js";
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
  /** 税抜。消費税の列がある表（確認用）に出す。 */
  unitPrice: number | "";
  quantity: number | "";
  amount: number | "";
  /**
   * 税込。経理へ渡す実物（V1 形式）には消費税の列が無く小計が税込なので、組の金額も
   * 税込で出す。税抜のままだと 金額（１）＋…＋金額（８）≠ 小計 になり、経理が照合できない。
   */
  unitPriceIncTax: number | "";
  amountIncTax: number | "";
  deliveryDate: string;
}

/** 支払の割当1件。条件と、分かっていれば実績の数量・単価・日付。 */
export interface AllocationLine {
  conditionNo: string | null;
  name: string;
  taxCategory: "taxable" | "reduced" | "exempt" | "included";
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
    /** 非居住者と租税条約（A-057）。無ければ居住者。 */
    residency?: string | null; treatyRatePct?: number | null; treatyDocsReceivedOn?: string | null;
  };
  ownerName: string | null;
  ownerDepartment: string | null;
  /** 担当者のメール。searchAPI の「自分の担当分だけ」に使う（帳票には出さない）。 */
  ownerEmail?: string | null;
  matterNo: string | null;
  matterTitle: string | null;
  lines: AllocationLine[];
  /**
   * 元になった書類の明細（検収書）。V1・V2 は支払内容をここから出していた。
   * 条件の名前ではなく、その回に検収した成果物がそのまま経理の明細になる。
   * 手で起こした支払には無いので、そのときは割当から組む。
   */
  documentLines?: DocumentLine[];
  /** 元になった書類（1件に決まるときだけ）。V1 形式の種別と PDF の同梱に使う。 */
  document?: { id: number; number: string | null; templateKey: string | null } | null;
  /** 元になった書類の件名（紙に刷った件名）。あれば帳票の件名はこれにする。 */
  documentTitle?: string | null;
  /** 割当の条件の種類（license／service …）。書類が無い支払の種別を決める。 */
  conditionKinds?: string[];
}

/** 検収書の明細1行。V2 の inspectionSlots が読んでいた項目に合わせる。 */
export interface DocumentLine {
  content: string;
  unitPrice: number | null;
  quantity: number | null;
  /** 税抜（税込で持つ行は税込のまま。その行は taxRatePct を 0 にする）。 */
  amount: number;
  deliveryDate: string | null;
  /** 消費税率（%）。税込の行（報酬に含める経費・海外）は 0。無ければ 10。 */
  taxRatePct?: number | null;
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
  /**
   * 9組目以降（8組ずつ）。経理提出の表では次の行に続けて載せる（sheetRows）。
   * 続きの行は金額の欄（小計・消費税・源泉税…）を空にする。同じ支払を二重に数えないため。
   */
  moreSlots?: AccountingSlot[][];
  /** 続きの行（sheetRows が作る）。金額の欄を空にして出す。 */
  continuation?: boolean;
  /** 担当者（帳票には出さない。searchAPI の一覧と絞り込みに使う）。 */
  ownerName?: string | null;
  ownerEmail?: string | null;
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
  /** 税込（海外・内税）。消費税を上乗せしない報酬。立替金ではなく小計に入る（源泉の対象にもなる）。 */
  taxIncluded: number;
  /**
   * 気づけるようにするための印。黙って空欄・0 を出さない。
   *   unallocated       … 割当が無い。支払内容の欄が埋まらない
   *   allocationMismatch… 割当の合計が支払額と合わない
   *   withholdingGap    … 源泉の保存値が計算値と違う
   */
  flags: string[];
  withholdingExpected: number;
  /** V1 形式の出力単位（種別 × 個人／法人）。 */
  category: AccountingCategory;
  entity: AccountingEntity;
  documentId: number | null;
  documentNo: string | null;
}

/** V1 の種別。ファイル名とシート名の頭に付く。 */
export type AccountingCategory = "検収書" | "利用許諾料計算書";
export type AccountingEntity = "個人" | "法人";
export const ACCOUNTING_CATEGORIES: AccountingCategory[] = ["検収書", "利用許諾料計算書"];
export const ACCOUNTING_ENTITIES: AccountingEntity[] = ["個人", "法人"];

/**
 * 種別。書類があればそのひな形で決める（計算書なら利用許諾料計算書）。
 * 書類の無い支払は条件の種類で決める（許諾の支払なら利用許諾料計算書）。
 */
export function categoryOf(
  templateKey: string | null | undefined, conditionKinds: string[] = []
): AccountingCategory {
  if (templateKey) return templateKey === "royalty_statement" ? "利用許諾料計算書" : "検収書";
  return conditionKinds.length > 0 && conditionKinds.every((k) => k === "license")
    ? "利用許諾料計算書" : "検収書";
}

const emptySlot = (): AccountingSlot =>
  ({ content: "", unitPrice: "", quantity: "", amount: "", unitPriceIncTax: "", amountIncTax: "", deliveryDate: "" });

/** 税区分 → 消費税率（%）。税込（海外・内税）と非課税は 0。 */
export const TAX_RATE_OF: Record<AllocationLine["taxCategory"], number> =
  { taxable: 10, reduced: 8, exempt: 0, included: 0 };

/** 税込。消費税は支払を立てるときと同じ丸め（consumptionTax）。 */
const incTaxOf = (amount: number, taxRatePct: number): number =>
  amount + (taxRatePct > 0 ? consumptionTax(amount, taxRatePct) : 0);

/**
 * 単価。持っていなければ 金額 ÷ 数量 で出す。
 *
 * 検収書の明細は「何をいくらで」を実績から組むので、単価を持たない行がある
 * （実績は数量と金額しか持たない）。経理の表で単価の列が空のままだと、
 * 受け取った側が1件ずつ電卓を叩くことになる。
 *
 * ただし割り切れないときは出さない。丸めた単価を置くと 単価×数量≠金額 に
 * なり、経理の表の中で二つの数が食い違う。空欄のほうがまだ分かる。
 */
export function unitPriceOf(amount: unknown, quantity: unknown): number | "" {
  const total = Number(amount);
  const count = Number(quantity);
  if (!Number.isFinite(total) || !Number.isFinite(count) || count === 0) return "";
  // 通貨の最小の桁（主単位で小数2桁）まで丸めてから、掛け戻して金額に
  // 戻るかを見る。10000 ÷ 3 のように戻らない割り方は空欄にする。
  const unit = Math.round((total / count) * 100) / 100;
  return Number.isFinite(unit) && unit * count === total ? unit : "";
}

/** 持っている単価を優先し、無ければ金額と数量から出す。 */
const unitPriceFor = (
  held: number | null | undefined, amount: unknown, quantity: unknown
): number | "" => (held === null || held === undefined ? unitPriceOf(amount, quantity) : held);

/**
 * 8組ごとに分ける。9組目以降は次の行（続きの行）に載せる。
 * 1組目の行は 8 組に足りなければ空の組で埋める。
 */
export function pageSlots(slots: AccountingSlot[]): AccountingSlot[][] {
  const pages: AccountingSlot[][] = [];
  for (let i = 0; i < Math.max(slots.length, 1); i += ACCOUNTING_SLOT_COUNT) {
    const page = slots.slice(i, i + ACCOUNTING_SLOT_COUNT);
    while (page.length < ACCOUNTING_SLOT_COUNT) page.push(emptySlot());
    pages.push(page);
  }
  return pages;
}

/**
 * 9件目以降は8件目に束ねる（合計行など、1行に収めたいとき）。
 * 落とすと合計が合わなくなるので、内容を連結して金額を足す。
 * 経理提出の行は束ねずに続きの行へ送る（pageSlots・sheetRows）。
 */
export function fitSlots(slots: AccountingSlot[]): AccountingSlot[] {
  const fitted = slots.slice(0, ACCOUNTING_SLOT_COUNT);
  const rest = slots.slice(ACCOUNTING_SLOT_COUNT);
  if (rest.length) {
    const last = fitted[ACCOUNTING_SLOT_COUNT - 1];
    fitted[ACCOUNTING_SLOT_COUNT - 1] = {
      content: [last.content, ...rest.map((s) => s.content)].filter(Boolean).join("／"),
      unitPrice: "", quantity: "", unitPriceIncTax: "",
      amount: [last, ...rest].reduce((sum, s) => sum + (Number(s.amount) || 0), 0),
      amountIncTax: [last, ...rest].reduce((sum, s) => sum + (Number(s.amountIncTax) || 0), 0),
      deliveryDate: last.deliveryDate
    };
  }
  while (fitted.length < ACCOUNTING_SLOT_COUNT) fitted.push(emptySlot());
  return fitted;
}

/**
 * 源泉の期待値。税込ベース。判定は V1 と同じ（個人か源泉ONなら対象）だが、非居住者は
 * 源泉ONのときだけ対象で、税率は国内法 20.42% か租税条約の税率（A-057。royalty/tax.ts）。
 */
export function expectedWithholding(
  subtotal: number, consumptionTax: number,
  party: { kind: string; withholding: boolean; residency?: string | null;
           treatyRatePct?: number | null; treatyDocsReceivedOn?: string | null },
  payOn?: string | null
): number {
  const enabled = resolveWithholdingEnabled({
    vendorWithholdingEnabled: party.withholding, entityType: party.kind, residency: party.residency ?? null
  });
  return withholdingFor(subtotal + consumptionTax, enabled, party, payOn).amount;
}

/** 支払内容の組の種。税込にする前。 */
interface SlotSeed {
  content: string;
  unitPrice: number | null;
  quantity: number | null;
  /** 税抜（taxRatePct が 0 の行は税込のまま）。 */
  amount: number;
  taxRatePct: number;
  deliveryDate: string;
}

/**
 * 組に税込の金額・単価を付ける。
 *
 * 行ごとに丸めた消費税の合計は、支払の消費税と 1 円ずれることがある（支払は実績ごと、
 * 書類は小計で丸める）。組が小計（税抜）を丸ごと説明できているときだけ、最後の課税の
 * 組で差を吸収して 金額（１）＋…＋金額（８）＝ 小計（税込） を保つ。説明できていない
 * （割当が合わない・明細が一部）ときは触らない。合わない数を無理に合わせると中身が違う。
 */
export function slotsWithTax(seeds: SlotSeed[], subtotal: number, tax: number): AccountingSlot[] {
  const incTax = seeds.map((s) => incTaxOf(s.amount, s.taxRatePct));
  const exTotal = seeds.reduce((sum, s) => sum + s.amount, 0);
  if (seeds.length && exTotal === subtotal) {
    const diff = subtotal + tax - incTax.reduce((sum, v) => sum + v, 0);
    if (diff !== 0) {
      let i = seeds.length - 1;
      while (i > 0 && seeds[i]!.taxRatePct === 0) i -= 1;
      incTax[i] = incTax[i]! + diff;
    }
  }
  return seeds.map((s, i) => ({
    content: s.content,
    unitPrice: unitPriceFor(s.unitPrice, s.amount, s.quantity),
    quantity: s.quantity ?? "",
    amount: s.amount,
    // 税込の単価は 税込金額 ÷ 数量。数量が無ければ持っている単価に税を乗せる。
    unitPriceIncTax: s.quantity !== null
      ? unitPriceOf(incTax[i], s.quantity)
      : s.unitPrice === null ? "" : incTaxOf(s.unitPrice, s.taxRatePct),
    amountIncTax: incTax[i]!,
    deliveryDate: s.deliveryDate
  }));
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
  const taxIncluded = covered ? byCategory("included") : 0;

  // 税込（海外）は報酬なので小計に入れる。非課税（立替金）とは分ける。
  const subtotal = taxable10 + reduced8 + taxIncluded;
  const reimbursement = exempt;
  const consumptionTax = source.taxAmount;
  const withholdingTax = source.withholdingAmount;
  const afterTax = subtotal + consumptionTax - withholdingTax;

  const withholdingExpected = expectedWithholding(subtotal, consumptionTax, source.party,
    source.paidOn ?? source.dueOn);
  // 源泉が違うと申告が狂う。黙って出さずに印を付ける。
  if (withholdingExpected !== withholdingTax) flags.push("withholdingGap");

  // 支払内容は書類の明細をそのまま出す（V1・V2 と同じ）。経理は「何に対する
  // 支払か」で照合するので、条件の名前では足りない。書類が無い支払だけ、
  // 割当から組む。
  //
  // 立替金（非課税の割当＝立替清算の経費）は支払内容に載せない。立替金の列で数える。
  // 報酬に含める経費（税込・内税）は支払内容の組になる（書類の明細は documentLinesFrom が
  // 条件の税区分で振り分けてある）。
  const seeds: SlotSeed[] = source.documentLines?.length
    ? source.documentLines.map((l) => ({
        content: l.content || "（内容未設定）",
        unitPrice: l.unitPrice, quantity: l.quantity, amount: l.amount,
        taxRatePct: l.taxRatePct ?? 10,
        deliveryDate: l.deliveryDate ?? ""
      }))
    : source.lines.filter((l) => l.taxCategory !== "exempt").map((l) => ({
        content: [l.conditionNo, l.name].filter(Boolean).join(" ") || "（内容未設定）",
        unitPrice: l.unitAmount, quantity: l.quantity, amount: l.amount,
        taxRatePct: TAX_RATE_OF[l.taxCategory],
        deliveryDate: l.occurredOn ?? ""
      }));
  const pages = pageSlots(slotsWithTax(seeds, subtotal, consumptionTax));
  const slots = pages[0]!;
  const moreSlots = pages.slice(1);

  return {
    paymentId: source.paymentId,
    paymentNo: source.paymentNo,
    currency: source.currency,
    ownerName: source.ownerName,
    ownerEmail: source.ownerEmail ?? null,
    ...(moreSlots.length ? { moreSlots } : {}),
    // 件名は元の書類（検収書・計算書）に刷った件名。経理は紙と帳票を突き合わせるので、
    // 紙と同じ件名にする。書類が無い支払だけ案件名 → 条件名で代える。
    title: source.documentTitle || source.matterTitle || source.lines[0]?.name || source.paymentNo || "",
    paymentDate: source.paidOn ?? source.dueOn ?? "",
    department: source.ownerDepartment ?? "",
    vendorCode: source.party.code ?? "",
    vendorName: source.party.name,
    vendorNameKana: source.party.kana ?? "",
    slots,
    reimbursement, subtotal, consumptionTax, withholdingTax, afterTax,
    netTransfer: afterTax + reimbursement,
    invoiceRegistration: source.party.invoiceNo ?? "",
    taxable10, reduced8, exempt, taxIncluded,
    flags, withholdingExpected,
    category: categoryOf(source.document?.templateKey, source.conditionKinds),
    entity: source.party.kind === "individual" ? "個人" : "法人",
    documentId: source.document?.id ?? null,
    documentNo: source.document?.number ?? null
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
  /** V1 形式で出せるファイル（種別 × 個人／法人）と件数。 */
  v1Files: Array<{ category: AccountingCategory; entity: AccountingEntity; count: number }>;
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
        count: 0, rows: [], flagged: 0, v1Files: [],
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
    const file = group.v1Files.find((f) => f.category === row.category && f.entity === row.entity);
    if (file) file.count += 1;
    else group.v1Files.push({ category: row.category, entity: row.entity, count: 1 });
  }
  for (const group of groups.values()) {
    group.v1Files.sort((a, b) =>
      ACCOUNTING_CATEGORIES.indexOf(a.category) - ACCOUNTING_CATEGORIES.indexOf(b.category)
      || ACCOUNTING_ENTITIES.indexOf(a.entity) - ACCOUNTING_ENTITIES.indexOf(b.entity));
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

/**
 * 表に出す行。支払内容が 9 組以上ある支払は、9 組目から次の行に続ける
 * （件名・支払日・取引先は同じものを出し、金額の欄は空）。
 */
export function sheetRows(rows: AccountingRow[]): AccountingRow[] {
  return rows.flatMap((row) => [
    row,
    ...(row.moreSlots ?? []).map((slots) => ({ ...row, slots, moreSlots: undefined, continuation: true }))
  ]);
}

/** 続きの行は金額の欄を空にする。 */
const money = (pick: (r: AccountingRow) => number) =>
  (r: AccountingRow): number | "" => (r.continuation ? "" : pick(r));

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
  { header: "立替金", value: money((r) => r.reimbursement) },
  { header: "小計", value: money((r) => r.subtotal) },
  { header: "消費税", value: money((r) => r.consumptionTax) },
  { header: "源泉税", value: money((r) => r.withholdingTax) },
  { header: "税引後", value: money((r) => r.afterTax) },
  { header: "差引振込額", value: money((r) => r.netTransfer) },
  { header: "インボイス登録", value: (r) => r.invoiceRegistration },
  { header: "課税対象（10%）税抜", value: money((r) => r.taxable10) },
  { header: "課税対象（8%）税抜", value: money((r) => r.reduced8) },
  { header: "非課税・不課税", value: money((r) => r.exempt) },
  { header: "税込（海外・内税）", value: money((r) => r.taxIncluded) },
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
  { header: "税込（海外・内税）", value: (r) => r.taxIncluded },
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
    taxIncluded: group.rows.reduce((s, r) => s + r.taxIncluded, 0),
    flags: [], withholdingExpected: group.rows.reduce((s, r) => s + r.withholdingExpected, 0),
    category: "検収書", entity: "法人", documentId: null, documentNo: null
  };
}

// ---------------------------------------------------------------------
// V1 形式（経理へ渡している実物の列）
// ---------------------------------------------------------------------

/** 全角数字（１〜８）。V1 の見出しは括弧の中の数字が全角。 */
const zenkaku = (n: number): string => String(n).replace(/[0-9]/g, (d) =>
  String.fromCharCode(d.charCodeAt(0) + 0xFEE0));

/**
 * V1 の経理提出用の列（52 列）。実際に経理へ渡している表の見出しをそのまま使う。
 *   ・括弧の中の数字は全角（１〜８）。
 *   ・「納品日(１)」だけ括弧が半角（ほかは全角の括弧）。
 *   ・消費税の列は無い。小計は税込で、小計 − 源泉税 ＝ 税引後、
 *     税引後 ＋ 立替金 ＝ 差引振込額 になる。
 * 列名・順番・表記は変えない（経理側の取り込みが見出しで照合している）。
 */
export const V1_ACCOUNTING_HEADERS: string[] = [
  "件名", "支払日", "部署", "取引先コード", "氏名", "氏名（カナ）",
  ...Array.from({ length: ACCOUNTING_SLOT_COUNT }, (_, i) => {
    const n = zenkaku(i + 1);
    return [`支払内容（${n}）`, `単価（${n}）`, `数量（${n}）`, `金額（${n}）`, `納品日(${n})`];
  }).flat(),
  "立替金", "小計", "源泉税", "税引後", "差引振込額", "インボイス登録"
];

/** 1 行分のセル。空の欄は空のまま（0 を入れない）、金額は数値のまま。組の金額・単価は税込。 */
export function v1AccountingCells(row: AccountingRow): Array<string | number | null> {
  const cell = (v: string | number | ""): string | number | null => (v === "" ? null : v);
  // 続きの行（9 組目以降）は金額の欄を空にする。同じ支払を二重に数えないため。
  const amount = (v: number): number | null => (row.continuation ? null : v);
  return [
    row.title, row.paymentDate, row.department, row.vendorCode, row.vendorName, row.vendorNameKana,
    // 組の単価・金額は税込。消費税の列が無く小計が税込なので、組も税込で揃える
    // （金額（１）＋…＋金額（８）＋立替金 ＝ 小計 ＋ 立替金 ＝ 差引振込額 ＋ 源泉税）。
    ...row.slots.flatMap((s) => [
      cell(s.content), cell(s.unitPriceIncTax), cell(s.quantity), cell(s.amountIncTax), cell(s.deliveryDate)
    ]),
    amount(row.reimbursement),
    // 小計は税込（消費税の列が無いので、ここに含める）。
    amount(row.subtotal + row.consumptionTax),
    amount(row.withholdingTax), amount(row.afterTax), amount(row.netTransfer),
    cell(row.invoiceRegistration)
  ];
}

/** V1 のファイル名の本体（拡張子なし）。例：検収書_個人_2026-09-30 */
export function v1FileStem(category: AccountingCategory, entity: AccountingEntity, paymentDate: string): string {
  return `${category}_${entity}_${paymentDate || "期日未設定"}`;
}

/** V1 のシート名。例：検収書(個人) */
export const v1SheetName = (category: AccountingCategory, entity: AccountingEntity): string =>
  `${category}(${entity})`;
