import { DomainError } from "../core/errors.js";
import { SETTLED_COLUMNS, pick } from "./settled-columns.js";
import { csvAmount, parseCsv } from "../imports/parse.js";
import { roundAmount } from "../core/rounding.js";
import { normalizeDate, readOnOff } from "./batch-service.js";

/**
 * 決済済みの一括取込（遡及）。CSV の読み取りと検証。
 *
 * 発注書の一括作成（batch-service）は「これから出す紙」を起こす。こちらは
 * 逆で、**検収まで終わっていて支払だけが残っている過去の取引**を、台帳に
 * 一度に入れる。作るのは
 *
 *   条件 → 予定明細 → 発注書（決定）→ 実績 → 検収書（決定・実績を結ぶ）→ 支払
 *
 * の一式。紙の日付は過去なので、発注書・検収書の決定日も CSV の日付で
 * 焼く（issue の issuedOn）。今日で焼くと、期日の計算も滞留の集計も
 * そこからずれる。
 *
 * 規則は発注書の一括作成に揃える。
 *   - 1行 = 1品目。同じ取引先・作品・条件名の行は1つの束（＝1条件・1発注書）
 *   - 取引先・作品は「はっきり1件に決まる」ときだけ当てる。ここでは作らない
 *   - 読めない行は捨てずに不備として残す。束ごと飛ばす
 *
 * ここ（settled-batch.ts）は DB を触らない。当て込みと実行は
 * settled-batch-service.ts が持つ。
 */

/**
 * 支払をどう扱うか。
 *
 * none は「支払を立てない」。経理を別で動かしている分や、支払だけ
 * あとから画面で起こしたい分がある。作ってから取り消すのは記録が
 * 残って汚れるので、最初から作らない選択を置く。
 */
export type SettledPaymentState = "planned" | "paid" | "none";

export const PAYMENT_STATE_WORDS: Array<{ value: SettledPaymentState; label: string; match: RegExp }> = [
  { value: "planned", label: "未払", match: /^(未払|未払い|未|planned|予定)$/i },
  { value: "paid", label: "支払済み", match: /^(支払済み|支払済|済|paid|入金済み|入金済)$/i },
  { value: "none", label: "作らない", match: /^(なし|無|作らない|立てない|不要|none|skip|-)$/i }
];

export function readPaymentState(raw: string): SettledPaymentState | null {
  const text = String(raw ?? "").trim();
  if (!text) return "planned";           // 書いていなければ未払。立てるだけ立てる
  return PAYMENT_STATE_WORDS.find((w) => w.match.test(text))?.value ?? null;
}

/**
 * CSV の列。
 *
 * 発注書の一括作成と同じ名前の列は、同じ意味で使う（2つの雛形の間で人が
 * 迷わないように）。増えているのは日付と支払、それに特約。
 */

export function templateCsv(): string {
  // 2行にする。1行だと「同じ取引先でも作品が違えば別の発注書になる」ことと、
  // 「減額検収は検収数量で書く」ことの両方が伝わらない。
  const examples = [
    ["VD-00317", "合同会社アトリエ蒼", "WRK-10013", "星降る夜のミュゼ", "", "",
     "第4巻 表紙イラスト", "カラー1点", "1", "150000",
     "2026-06-01", "2026-07-20", "2026-07-25", "", "",
     "2026-08-31", "未払", "",
     "請負", "月末締め翌月末払い", "発注者", "あり", "なし",
     "業務委託の一般特約", "", ""],
    ["VD-00317", "合同会社アトリエ蒼", "WRK-10021", "夜明けのクロニクル", "", "",
     "第1巻 挿絵", "モノクロ12点", "12", "8000",
     "2026-06-01", "2026-07-31", "2026-08-05", "11", "納品点数が11点になったため減額",
     "2026-09-30", "支払済み", "2026-09-28",
     "請負", "月末締め翌月末払い", "発注者", "あり", "なし",
     "", "", ""]
  ].map((row) => Object.fromEntries(SETTLED_COLUMNS.map((c, i) => [c.key, row[i]])));
  return toCsv(examples);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  const header = SETTLED_COLUMNS.map((c) => c.label).join(",");
  const body = rows.map((row) => SETTLED_COLUMNS.map((c) => csvCell(row[c.key])).join(","));
  return `﻿${[header, ...body].join("\n")}\n`;
}

export interface SettledRow {
  line: number;
  partyCode: string | null;
  partyName: string | null;
  workCode: string | null;
  workTitle: string | null;
  agreementNo: string | null;
  conditionName: string | null;
  /** 発注書の決定日。 */
  orderedOn: string | null;
  /** 実績の日付。 */
  deliveredOn: string | null;
  /** 検収日。実績にも入り、検収書の決定日にもなる。 */
  inspectedOn: string | null;
  /** 検収数量が発注数量と違うときの理由。検収書の変更履歴に出る。 */
  varianceNote: string | null;
  /** 支払期日。空なら支払条件・予定から出す。 */
  dueOn: string | null;
  paymentState: SettledPaymentState | null;
  paidOn: string | null;
  orderSign: boolean | null;
  acceptSign: boolean | null;
  paymentTerms: string | null;
  specialTerms: string | null;
  specialTermsSnippet: string | null;
  /** 発注明細の1行。発注書の本文がそのまま使う。 */
  item: Record<string, unknown>;
  /** 発注数量。 */
  quantity: number;
  /** 検収数量。空欄なら発注数量と同じ。 */
  inspectedQuantity: number;
  /** 発注額（単価×数量）。 */
  orderedAmount: number;
  /** 検収額（単価×検収数量）。書かせるものではなく、ここで出す。 */
  inspectedAmount: number;
  issues: string[];
}


/** 必須の日付を読む。空も読めないのも不備にするが、行は捨てない。 */
function readRequiredDate(
  raw: string, label: string, issues: string[]
): string | null {
  if (!raw) { issues.push(`${label}が空`); return null; }
  const value = normalizeDate(raw);
  if (!value) { issues.push(`${label}が日付として読めない（${raw}）`); return null; }
  return value;
}

export function readRows(text: string): SettledRow[] {
  const parsed = parseCsv(text, { maxRows: 1000 });
  const known = SETTLED_COLUMNS.some((c) => parsed.headers.includes(c.label)
    || parsed.headers.includes(c.key)
    || (c.aliases ?? []).some((a) => parsed.headers.includes(a)));
  if (!known) {
    throw new DomainError("VALIDATION",
      `見出しが雛形と合いません。雛形をダウンロードして、その列名で作ってください（読んだ見出し: ${parsed.headers.slice(0, 5).join(", ")}）`);
  }
  for (const column of SETTLED_COLUMNS.filter((c) => c.required)) {
    if (!parsed.headers.includes(column.label) && !parsed.headers.includes(column.key)) {
      throw new DomainError("VALIDATION",
        `「${column.label}」の列がありません。雛形をダウンロードし直して、その列名で作ってください`);
    }
  }
  return parsed.rows.map((row, i) => {
    const get = (key: string) => String(pick(row, SETTLED_COLUMNS.find((c) => c.key === key)!)).trim();
    const issues: string[] = [];

    const itemName = get("item_name");
    if (!itemName) issues.push("品目・業務名が空");
    const quantity = get("quantity") ? csvAmount(get("quantity")) : 1;
    if (quantity === undefined || quantity <= 0) issues.push("数量が読めない");
    const unitPrice = csvAmount(get("unit_price"));
    if (unitPrice === undefined) issues.push("単価が空か読めない");
    const orderedAmount = roundAmount((quantity ?? 0) * (unitPrice ?? 0));

    const orderedOn = readRequiredDate(get("orderedOn"), "発注日", issues);
    const deliveredOn = readRequiredDate(get("deliveredOn"), "納品日", issues);
    const inspectedOn = readRequiredDate(get("inspectedOn"), "検収日", issues);
    // 日付の前後。逆になっていれば列を取り違えている。金額より先に気づける。
    if (orderedOn && deliveredOn && deliveredOn < orderedOn) {
      issues.push(`納品日（${deliveredOn}）が発注日（${orderedOn}）より前`);
    }
    if (deliveredOn && inspectedOn && inspectedOn < deliveredOn) {
      issues.push(`検収日（${inspectedOn}）が納品日（${deliveredOn}）より前`);
    }

    const dueRaw = get("dueOn");
    const dueOn = dueRaw ? normalizeDate(dueRaw) : null;
    if (dueRaw && !dueOn) issues.push(`支払期日が日付として読めない（${dueRaw}）`);

    const stateRaw = get("paymentState");
    const paymentState = readPaymentState(stateRaw);
    if (!paymentState) issues.push(`支払状態は 未払 か 支払済み（${stateRaw}）`);

    const paidRaw = get("paidOn");
    const paidOn = paidRaw ? normalizeDate(paidRaw) : null;
    if (paidRaw && !paidOn) issues.push(`入金日が日付として読めない（${paidRaw}）`);
    // 支払済みで入金日が無いと、いつ払ったか分からない支払済みが台帳に残る。
    if (paymentState === "paid" && !paidOn) issues.push("支払状態が 支払済み なら入金日が要ります");
    if (paymentState === "planned" && paidOn) {
      issues.push(`入金日（${paidOn}）があるのに支払状態が 未払 です`);
    }
    if (paymentState === "none" && paidOn) {
      issues.push(`入金日（${paidOn}）があるのに支払状態が なし です`);
    }
    // 支払を立てないなら期日も置き場所が無い。書いてあるのに使われないと、
    // 「期日を入れたのに支払に出てこない」になる。
    if (paymentState === "none" && dueOn) {
      issues.push(`支払期日（${dueOn}）があるのに支払状態が なし です`);
    }
    if (paidOn && inspectedOn && paidOn < inspectedOn) {
      issues.push(`入金日（${paidOn}）が検収日（${inspectedOn}）より前`);
    }

    // 検収数量。空なら発注数量と同じ。減らして納品されたらここに実数を書く。
    // 金額はここから出す（単価×検収数量）。
    const inspectedRaw = get("inspectedQuantity");
    const inspectedQty = inspectedRaw ? csvAmount(inspectedRaw) : quantity;
    if (inspectedRaw && inspectedQty === undefined) {
      issues.push(`検収数量が読めない（${inspectedRaw}）`);
    }
    if (inspectedQty !== undefined && inspectedQty < 0) issues.push("検収数量が負の数です");
    if (inspectedQty !== undefined && inspectedQty === 0) {
      issues.push("検収数量が 0 です。0 の実績からは支払を作れません（検収していない行は外してください）");
    }
    const orderedQuantity = quantity ?? 0;
    const inspectedQuantity = inspectedQty ?? orderedQuantity;
    const inspectedAmount = roundAmount(inspectedQuantity * (unitPrice ?? 0));
    // 数量が動いた行は、紙に変更履歴と署名欄が出る。理由を書かないと
    // 「（理由未記入）」と刷られたものが相手に渡る。
    const varianceNote = get("varianceNote") || null;
    if (inspectedQuantity !== orderedQuantity && !varianceNote) {
      issues.push(`検収数量（${inspectedQuantity}）が数量（${orderedQuantity}）と違います。変更理由が要ります`);
    }

    const ownershipRaw = get("deliverable_ownership");
    const ownership = /受注/.test(ownershipRaw) ? "受注者"
      : /発注/.test(ownershipRaw) ? "発注者" : ownershipRaw ? null : "";
    if (ownership === null) issues.push(`成果物の帰属先は 発注者 か 受注者（${ownershipRaw}）`);

    return {
      line: i + 2,
      partyCode: get("partyCode") || null,
      partyName: get("partyName") || null,
      workCode: get("workCode") || null,
      workTitle: get("workTitle") || null,
      agreementNo: get("agreementNo") || null,
      conditionName: get("conditionName") || null,
      orderedOn, deliveredOn, inspectedOn, varianceNote, dueOn,
      paymentState, paidOn,
      orderSign: readOnOff(get("orderSign")),
      acceptSign: readOnOff(get("acceptSign")),
      paymentTerms: get("payment_terms") || null,
      specialTerms: get("specialTerms") || null,
      specialTermsSnippet: get("specialTermsSnippet") || null,
      item: {
        item_name: itemName, spec: get("spec") || null,
        quantity: quantity ?? null, unit_price: unitPrice ?? null,
        amount_ex_tax: orderedAmount,
        // 発注書に刷るのは発注の数量。検収の数量は検収書が実績から出す。
        ordered_quantity: quantity ?? null,
        delivery_date: deliveredOn, payment_date: dueOn,
        deliverable_ownership: ownership || null, calc_method: "FIXED",
        payment_terms: get("contract_form") || null,
        remarks: get("remarks") || null
      },
      quantity: orderedQuantity, inspectedQuantity,
      orderedAmount, inspectedAmount,
      issues
    };
  });
}

/** 束の鍵。同じ取引先・作品・条件名の行が1つの条件・1枚の発注書になる。 */
export function groupKeyOf(row: SettledRow): string {
  return [row.partyCode ?? "", row.partyName ?? "", row.workCode ?? "", row.workTitle ?? "",
          row.conditionName ?? ""].join("\u0001");
}

export interface SettledGroupRows {
  key: string;
  partyCode: string | null;
  partyName: string | null;
  workCode: string | null;
  workTitle: string | null;
  conditionName: string | null;
  rows: SettledRow[];
  /** 発注額の合計。条件の金額になる。 */
  orderedTotal: number;
  /** 検収額の合計。支払の額になる。 */
  inspectedTotal: number;
}

export function groupRows(rows: SettledRow[]): SettledGroupRows[] {
  const map = new Map<string, SettledGroupRows>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    const group = map.get(key) ?? {
      key,
      partyCode: row.partyCode, partyName: row.partyName,
      workCode: row.workCode, workTitle: row.workTitle,
      conditionName: row.conditionName,
      rows: [], orderedTotal: 0, inspectedTotal: 0
    };
    group.rows.push(row);
    group.orderedTotal += row.orderedAmount;
    group.inspectedTotal += row.inspectedAmount;
    map.set(key, group);
  }
  return [...map.values()];
}

/** 束の中で1つに決まる値。決まらなければ null。 */
export function sameAcross<T>(rows: SettledRow[], pickValue: (r: SettledRow) => T | null): T | null {
  const set = new Set(rows.map((r) => pickValue(r)).filter((v) => v !== null && v !== ""));
  return set.size === 1 ? ([...set][0] as T) : null;
}

const differs = <T>(rows: SettledRow[], pickValue: (r: SettledRow) => T | null) =>
  new Set(rows.map((r) => String(pickValue(r) ?? ""))).size > 1;

/**
 * 束の中で食い違っていると作れない値。
 *
 * 1つの束から出るのは 1条件・1発注書・1検収書・1支払 なので、それぞれの
 * 日付と切り替えは束でひとつに決まっていなければならない。黙ってどれかを
 * 採ると、紙に載らなかった日付が消える。
 */
export function conflictsOf(rows: SettledRow[]): string[] {
  return [
    ...(differs(rows, (r) => r.orderedOn)
      ? ["発注日が行ごとに違います。1枚の発注書に決定日は1つです"] : []),
    ...(differs(rows, (r) => r.inspectedOn)
      ? ["検収日が行ごとに違います。1枚の検収書に決定日は1つです"] : []),
    ...(differs(rows, (r) => r.dueOn)
      ? ["支払期日が行ごとに違います。1束から立つ支払は1件です"] : []),
    ...(differs(rows, (r) => r.paymentState)
      ? ["支払状態が行ごとに違います。1束から立つ支払は1件です"] : []),
    ...(differs(rows, (r) => r.paidOn)
      ? ["入金日が行ごとに違います。1束から立つ支払は1件です"] : []),
    ...(differs(rows, (r) => r.agreementNo)
      ? ["契約番号が行ごとに違います。1つの条件に契約は1つです"] : []),
    ...(differs(rows, (r) => r.orderSign === null ? "" : r.orderSign ? "あり" : "なし")
      ? ["発注署名欄が行ごとに違います。書類ごとの切り替えです"] : []),
    ...(differs(rows, (r) => r.acceptSign === null ? "" : r.acceptSign ? "あり" : "なし")
      ? ["承諾署名欄が行ごとに違います。書類ごとの切り替えです"] : []),
    ...(differs(rows, (r) => r.specialTerms)
      ? ["特約が行ごとに違います。1枚の発注書に特約は1つです"] : []),
    ...(differs(rows, (r) => r.specialTermsSnippet)
      ? ["特約の定型文が行ごとに違います。1枚の発注書に特約は1つです"] : [])
  ];
}

/** 束の行の帰属先が全部同じならそれを条件に持たせる。混ざっていれば決めない。 */
export function ownershipOfRows(rows: SettledRow[]): "orderer" | "contractor" | null {
  const set = new Set(rows.map((r) => String(r.item.deliverable_ownership ?? "")).filter(Boolean));
  if (set.size !== 1) return null;
  const v = [...set][0];
  return v === "発注者" ? "orderer" : v === "受注者" ? "contractor" : null;
}

/**
 * 予定明細。CSV の1行が1回。
 *
 * 遡及なので起点は常に「検収後」でよい（もう検収は済んでいる）。予定が
 * 無いと、実績を入れるときに「どの回の分か」が繋がらず、検収書の支払日が
 * 空で出る。
 */
export function scheduleLinesFrom(rows: SettledRow[]) {
  return rows
    .filter((r) => Math.round(r.orderedAmount) > 0)
    .map((r, index) => ({
      seq: index + 1,
      label: String(r.item.item_name ?? "") || null,
      triggerKind: "on_inspection" as const,
      plannedAmount: Math.round(r.orderedAmount),
      dueOn: r.deliveredOn,
      payOn: r.dueOn
    }));
}

/**
 * CSV を列の鍵で読む。取り込み（readRows）は値を検査して型に直すが、
 * 差分は「打った字がどう変わったか」を見るので、字のまま突き合わせる。
 * 読み方（別名・見出しの揺れ）は取り込みと同じ pick を通す。
 */
export function rawRows(text: string): Array<Record<string, string>> {
  const parsed = parseCsv(text, { maxRows: 1000 });
  return parsed.rows.map((row) =>
    Object.fromEntries(SETTLED_COLUMNS.map((c) => [c.key, String(pick(row, c) ?? "").trim()])));
}

export { SETTLED_COLUMNS, pick };
