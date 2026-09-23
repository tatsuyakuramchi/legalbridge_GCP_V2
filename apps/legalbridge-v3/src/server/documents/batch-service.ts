import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { parseCsv, csvAmount } from "../imports/parse.js";
import { ConditionWriteService } from "../conditions/write-service.js";
import { roundAmount } from "../core/rounding.js";
import { normalizeDate } from "./csv-date.js";
import { LICENSE_COLUMNS, createLicenseConditions, licenseInputsFor, readLicenseSpec,
         type LicenseSpec } from "./order-license-columns.js";
import { ConditionScheduleService, TRIGGER_KINDS,
         type ScheduleLine, type TriggerKind } from "../conditions/schedule-service.js";
import { MatterLinkService } from "../matters/link-service.js";
import { MatterCommunicationService } from "../matters/communication-service.js";
import { DocumentIssueService } from "./issue-service.js";
import { DocumentRepository, type DocumentSummary } from "./repository.js";
import type { PdfRenderer } from "./pdf-renderer.js";

/**
 * 発注書の一括作成。
 *
 * 1つの案件に関わる発注先すべてに、CSV から発注書の下書きをまとめて起こす。
 * 1行 = 1品目。同じ取引先の行は1枚の発注書に束ねる。行ごとに条件明細を
 * 作ってから文書を起こすので、一括で作った発注書も普通の発注書と同じ扱い
 * （訂正版・下敷き・送る、すべて使える）。
 *
 * 扱うのは定額の業務委託だけ。料率・MG/AG のような条件は列に無い。
 *
 * 規則は取り込み（imports）と名寄せに揃える。
 *   - 取引先は「はっきり1件に決まる」ときだけ当てる。ここでは作らない
 *   - 当たらない束は飛ばして残りを作る。飛ばした束は結果に残す
 *   - 突き合わせ（preview）では何も作らない
 */

export const TEMPLATE_KEYS = new Set(["purchase_order", "intl_purchase_order"]);

/** CSV の列。画面の明細の欄と同じ名前で出す。 */
export const ORDER_COLUMNS: Array<{
  key: string; label: string; required?: boolean; note: string;
  /** 旧い雛形の見出し。読むときだけ受け付ける（書き出しは label のほう）。 */
  aliases?: string[];
}> = [
  { key: "partyCode", label: "取引先コード", note: "コードか名前のどちらかで当てる" },
  { key: "partyName", label: "取引先名", note: "登録名・別名・カナのどれかに一致" },
  // 作品は1つの案件に何本でも載る。列が無いと、同じ取引先の行が作品をまたいで
  // 1枚に混ざり、条件明細も作品なしで作られていた。
  { key: "workCode", label: "作品コード", note: "コードか作品名のどちらかで当てる。空なら作品なし" },
  { key: "workTitle", label: "作品名", note: "登録名に一致" },
  // 基本契約と条件名は束ごとの値。全行に同じものを書く（違えば不備として出す）。
  { key: "agreementNo", label: "契約番号",
    note: "空なら取引先から自動で当てる。「なし」と書けば基本契約なしの発注にする" },
  { key: "conditionName", label: "条件名", note: "空なら自動。書けば同じ取引先・作品でも別の条件になる" },
  { key: "item_name", label: "品目・業務名", required: true, note: "" },
  { key: "spec", label: "仕様・成果物", note: "" },
  { key: "quantity", label: "数量", note: "空なら 1" },
  { key: "unit_price", label: "単価（税抜）", required: true, note: "円" },
  // 起点は回ごとに違う（着手金は契約時、本編は検収後）。束でひとつに決められない。
  { key: "triggerKind", label: "起点", required: true, note: "検収後 / 納品後 / 契約時 / 定期" },
  { key: "delivery_date", label: "納期", note: "2026-10-31 か 2026/10/31" },
  { key: "payment_date", label: "支払日", note: "" },
  // 契約形式と支払条件は別のもの。1つの欄に混ぜていたので、「請負」と書くと
  // 支払条件として読めず、予定明細の支払期日が空のまま出ていた。
  // 旧い雛形の「契約種別・支払条件」に書いてあるのは契約形式なので、そちらへ読む。
  { key: "contract_form", label: "契約形式", aliases: ["契約種別・支払条件"],
    note: "請負 / 委任 / 準委任 など。発注書の「契約種別」に出る" },
  { key: "payment_terms", label: "支払条件",
    note: "例: 月末締め翌月末払い。ここから各回の支払期日を出す" },
  { key: "deliverable_ownership", label: "成果物の帰属先",
    note: "発注者 か 受注者。空ならその行に帰属先を出さない" },
  // 受注者帰属の成果物の利用許諾（A-048）。書けば許諾条件も一緒に作る。
  ...LICENSE_COLUMNS,
  // 書類の見た目の切り替え。束ごとの値なので全行に同じものを書く。
  { key: "orderSign", label: "発注署名欄", note: "あり / なし。空なら なし（発注者は署名しない）" },
  { key: "acceptSign", label: "承諾署名欄", note: "あり / なし。空なら あり（受注者だけが署名する欄）" },
  { key: "calc_method", label: "支払方法", note: "固定額 だけ。空なら固定額" },
  { key: "remarks", label: "備考", note: "" },
  // 末尾。既に決定した発注書を直すときだけ使う。
  { key: "fix", label: "一括修正", note: "あり / なし。空なら なし（新しく作る）" },
  { key: "fixReason", label: "修正理由", note: "一括修正が あり のときは必須。訂正版の記録に残る" }
];

export function templateCsv(): string {
  // 例は2行にする。1行だけだと「同じ取引先でも作品が違えば別の発注書になる」
  // ことが伝わらず、作品の列を空のまま使われる。
  const examples = [
    ["VD-00317", "合同会社アトリエ蒼", "WRK-10013", "星降る夜のミュゼ", "", "",
     "第4巻 表紙イラスト", "カラー1点", "1", "150000", "検収後", "2026-10-31", "2026-11-30",
     "請負", "月末締め翌月末払い", "発注者", "", "", "", "", "", "", "", "",
     "あり", "なし", "固定額", "", "", ""],
    ["VD-00317", "合同会社アトリエ蒼", "WRK-10021", "夜明けのクロニクル", "", "",
     "第1巻 挿絵", "モノクロ12点", "12", "8000", "検収後", "2026-11-30", "2026-12-31",
     "請負", "月末締め翌月末払い", "受注者", "出版（紙）", "8", "", "別途", "2026-12-01", "2029-11-30", "日本", "日本語",
     "あり", "なし", "固定額", "", "", ""]
  ].map((row) => Object.fromEntries(ORDER_COLUMNS.map((c, i) => [c.key, row[i]])));
  return toCsv(examples);
}

/** CSV の1セル。カンマ・引用符・改行が入っていたら囲って escape する。 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 見出し＋行を CSV に組む。Excel で開けるよう BOM を付ける。 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const header = ORDER_COLUMNS.map((c) => c.label).join(",");
  const body = rows.map((row) => ORDER_COLUMNS.map((c) => csvCell(row[c.key])).join(","));
  return `\ufeff${[header, ...body].join("\n")}\n`;
}

export interface BatchRow {
  line: number;
  partyCode: string | null;
  partyName: string | null;
  workCode: string | null;
  workTitle: string | null;
  /** 基本契約の番号。空なら取引先から自動で当てる。 */
  agreementNo: string | null;
  /** 条件名。空なら自動。書けば束の分かれ方にも効く。 */
  conditionName: string | null;
  /** 予定明細の起点。読めなければ null（その行は不備として残る）。 */
  triggerKind: TriggerKind | null;
  /** 発注署名欄・承諾署名欄を出すか。未記入は null（ひな形の既定に任せる）。 */
  orderSign: boolean | null;
  acceptSign: boolean | null;
  /** 決定済みの発注書を直すか。あり なら訂正版を起こす。 */
  fix: boolean | null;
  /** 訂正の理由。記録に残るので、直すときは必須。 */
  fixReason: string | null;
  /**
   * 支払条件。「月末締め翌月末払い」を読んで各回の支払期日を出す。
   * 紙に出る契約形式（請負）とは別で、そちらは item.payment_terms が持つ。
   */
  paymentTerms: string | null;
  /** 受注者帰属の成果物の利用許諾（A-048）。列が空なら null。 */
  license: LicenseSpec | null;
  item: Record<string, unknown>;
  amount: number;
  issues: string[];
}

export { normalizeDate };

/**
 * 起点の読み取り。雛形の言葉（検収後）でも、短く書いた言葉（検収）でも、
 * 中の値（on_inspection）でも読む。人が手で書き足す欄なので、表記を1つに
 * 縛ると「検収」と書いただけで全行が不備になる。
 */
export function readTriggerKind(raw: string): TriggerKind | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const exact = TRIGGER_KINDS.find((t) => t.value === text || t.label === text);
  if (exact) return exact.value;
  if (/検収/.test(text)) return "on_inspection";
  if (/納品|検品/.test(text)) return "on_delivery";
  if (/契約|着手/.test(text)) return "on_execution";
  if (/定期|毎月|毎月度|月次|四半期/.test(text)) return "periodic";
  return null;
}

/**
 * あり・なしの読み取り。未記入（null）と「なし」（false）は違う。
 *
 * 未記入は「決めていない」で、書類のひな形の既定に任せる。「なし」は
 * 人が外したという指示なので、既定が「あり」でも出さない。
 */
export function readOnOff(raw: string): boolean | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (/^(あり|有|要|表示|する|on|true|yes|y|1|○|◯|◎)$/i.test(text)) return true;
  if (/^(なし|無|不要|非表示|しない|off|false|no|n|0|×|✕|-|—)$/i.test(text)) return false;
  return null;
}

export const TRIGGER_LABEL: Record<TriggerKind, string> =
  Object.fromEntries(TRIGGER_KINDS.map((t) => [t.value, t.label])) as Record<TriggerKind, string>;

/** 見出しは日本語の列名か、明細のキー名のどちらでも読む。 */
const pick = (
  row: Record<string, string>, column: { key: string; label: string; aliases?: string[] }
) => {
  const hit = row[column.label] ?? row[column.key];
  if (hit !== undefined) return hit;
  for (const alias of column.aliases ?? []) if (row[alias] !== undefined) return row[alias];
  return "";
};

/** CSV の行を、明細の1行として読む。読めないところは issues に残す（行は捨てない）。 */
export function readRows(text: string): BatchRow[] {
  const parsed = parseCsv(text, { maxRows: 1000 });
  const known = ORDER_COLUMNS.some((c) => parsed.headers.includes(c.label)
    || parsed.headers.includes(c.key)
    || (c.aliases ?? []).some((a) => parsed.headers.includes(a)));
  if (!known) {
    throw new DomainError("VALIDATION",
      `見出しが雛形と合いません。雛形をダウンロードして、その列名で作ってください（読んだ見出し: ${parsed.headers.slice(0, 5).join(", ")}）`);
  }
  // 列そのものが無いなら、行ごとの不備として何百件も並べない。
  // 古い雛形で作ったファイルなので、雛形を取り直してもらう。
  for (const column of ORDER_COLUMNS.filter((c) => c.required)) {
    if (!parsed.headers.includes(column.label) && !parsed.headers.includes(column.key)) {
      throw new DomainError("VALIDATION",
        `「${column.label}」の列がありません。雛形をダウンロードし直して、その列名で作ってください`);
    }
  }
  return parsed.rows.map((row, i) => {
    const get = (key: string) => String(pick(row, ORDER_COLUMNS.find((c) => c.key === key)!)).trim();
    const issues: string[] = [];
    const itemName = get("item_name");
    if (!itemName) issues.push("品目・業務名が空");
    const quantity = get("quantity") ? csvAmount(get("quantity")) : 1;
    if (quantity === undefined || quantity <= 0) issues.push("数量が読めない");
    const unitPrice = csvAmount(get("unit_price"));
    if (unitPrice === undefined) issues.push("単価が空か読めない");
    const triggerKind = readTriggerKind(get("triggerKind"));
    if (!triggerKind) {
      issues.push(get("triggerKind")
        ? `起点が読めない（${get("triggerKind")}）。検収後 / 納品後 / 契約時 / 定期 のどれか`
        : "起点が空。検収後 / 納品後 / 契約時 / 定期 のどれかを入れる");
    }
    const delivery = get("delivery_date");
    const deliveryDate = normalizeDate(delivery);
    if (delivery && !deliveryDate) issues.push(`納期が日付として読めない（${delivery}）`);
    const payment = get("payment_date");
    const paymentDate = normalizeDate(payment);
    if (payment && !paymentDate) issues.push(`支払日が日付として読めない（${payment}）`);
    const ownershipRaw = get("deliverable_ownership");
    const ownership = /受注/.test(ownershipRaw) ? "受注者" : /発注/.test(ownershipRaw) ? "発注者" : ownershipRaw ? null : "";
    if (ownership === null) issues.push(`成果物の帰属先は 発注者 か 受注者（${ownershipRaw}）`);
    const method = get("calc_method");
    if (method && !/^(固定額|FIXED)$/i.test(method)) issues.push(`支払方法は 固定額 だけ扱えます（${method}）`);
    // 数量は小数を取る（0.5人日）。掛けた金額に端数が出ると、条件明細の
    // 金額欄（整数）へ渡すところで落ちる。行ごとに四捨五入して整数にする。
    const amount = roundAmount((quantity ?? 0) * (unitPrice ?? 0));
    const license = readLicenseSpec(get, ownership, issues);
    return {
      line: i + 2,
      partyCode: get("partyCode") || null,
      partyName: get("partyName") || null,
      workCode: get("workCode") || null,
      workTitle: get("workTitle") || null,
      agreementNo: get("agreementNo") || null,
      conditionName: get("conditionName") || null,
      license,
      triggerKind,
      orderSign: readOnOff(get("orderSign")),
      acceptSign: readOnOff(get("acceptSign")),
      fix: readOnOff(get("fix")),
      fixReason: get("fixReason") || null,
      // 支払条件は条件が持つ（各回の支払期日をここから出す）。行の欄ではない。
      paymentTerms: get("payment_terms") || null,
      item: {
        item_name: itemName, spec: get("spec") || null,
        quantity: quantity ?? null, unit_price: unitPrice ?? null, amount_ex_tax: amount,
        delivery_date: deliveryDate, payment_date: paymentDate,
        deliverable_ownership: ownership || null, calc_method: "FIXED",
        // 発注明細の「契約種別」。本文がこの列をそのまま印字する。
        // 紙に出るのは契約形式のほうで、支払条件は条件が持って支払期日を出す。
        payment_terms: get("contract_form") || null,
        remarks: get("remarks") || null
      },
      amount,
      issues
    };
  });
}

/**
 * 束の行から、条件の予定明細を組む。CSV の1行が1回。
 *
 * 予定を作らないと、条件明細は金額の総額しか持たない。実績を入れるときに
 * 「どの回の分か」が選べず、検収書の支払日が空欄で出る。CSV には納期も
 * 支払日も1行ずつ書いてあるので、そのまま回にできる。
 *
 * 起点は行が持つ（着手金は契約時、本編は検収後、と1つの束の中でも変わる）。
 * 読めない行は先に不備として弾かれるので、ここに来るのは読めた行だけ。
 * 0円の行は置けない（予定明細の規則）ので落とす。
 */
export function scheduleLinesFrom(rows: BatchRow[]): ScheduleLine[] {
  return rows
    .filter((r) => Math.round(r.amount) > 0 && r.triggerKind)
    .map((r, index) => ({
      seq: index + 1,
      label: String(r.item.item_name ?? "") || null,
      triggerKind: r.triggerKind!,
      plannedAmount: Math.round(r.amount),
      dueOn: (r.item.delivery_date as string | null) ?? null,
      payOn: (r.item.payment_date as string | null) ?? null
    }));
}

/** 束の行の帰属先が全部同じならそれを条件に持たせる。混ざっていれば決めない。 */
export function ownershipOfRows(rows: BatchRow[]): "orderer" | "contractor" | null {
  const set = new Set(rows.map((r) => String(r.item.deliverable_ownership ?? "")).filter(Boolean));
  if (set.size !== 1) return null;
  const v = [...set][0];
  return v === "発注者" ? "orderer" : v === "受注者" ? "contractor" : null;
}

export interface PartyCandidate { id: number; name: string; partyCode: string | null }
export interface WorkCandidate { id: number; title: string; workCode: string | null }
export interface AgreementRef { id: number; agreementNo: string | null; title: string | null }

/** 作品の当たり方。none は CSV が作品を書いていない（作品なしの発注）。 */
export type WorkResolution = "none" | "resolved" | "ambiguous" | "missing";

export interface BatchGroup {
  /** 束の鍵。取引先（コード、無ければ名前）と作品の組。 */
  key: string;
  partyCode: string | null;
  partyName: string | null;
  resolution: "resolved" | "ambiguous" | "missing";
  party: PartyCandidate | null;
  candidates: PartyCandidate[];
  /** CSV に書かれた作品と、その当たり具合。 */
  workCode: string | null;
  workTitle: string | null;
  /** CSV に書かれた条件名（空なら自動生成）。 */
  conditionName: string | null;
  workResolution: WorkResolution;
  work: WorkCandidate | null;
  workCandidates: WorkCandidate[];
  /**
   * 条件明細の扱い。既存に当てるか、新しく作るか。
   * 新しく作るときは、基本契約と予定明細もここで決まる（作ってから
   * 人が入れ直すものを減らす）。
   */
  condition: {
    mode: "existing" | "new"; id: number | null; conditionNo: string | null;
    /** 新しく作る条件に付ける基本契約。決まらなければ null（発注書は基本契約なしでも出せる）。 */
    agreement: AgreementRef | null;
    /** 基本契約が決まらなかった理由。埋まらないことは止める理由ではないので、issues には出さない。 */
    agreementNote: string | null;
    /** 作る予定明細の回数。CSV の1行が1回。 */
    schedules: number;
  };
  rows: BatchRow[];
  total: number;
  issues: string[];
  /**
   * 決定済みの発注書を直す束。on=false なら新しく作る（これまでどおり）。
   * 対象が決まらないときは reason が理由を持ち、束は飛ぶ。
   */
  fix: { on: boolean; documentId: number | null; documentNo: string | null;
         reason: string | null; note: string | null };
  /** この束をどうするか。create=作る／直す / choose=候補を選ぶ / skip=飛ばす */
  action: "create" | "choose" | "skip";
}

export interface BatchPreview {
  groups: BatchGroup[];
  summary: { rows: number; groups: number; creatable: number; skipped: number; choose: number;
             /** creatable のうち、決定済みの発注書を直す束。 */
             revising: number };
}

/** 束の鍵の取引先の側。コード、無ければ名前。 */
const partyToken = (r: BatchRow) =>
  r.partyCode ? `code:${r.partyCode.toLowerCase()}` : r.partyName ? `name:${r.partyName}` : `line:${r.line}`;

/** 束の鍵の作品の側。書いていなければ「作品なし」。 */
const workToken = (r: BatchRow) =>
  r.workCode ? `wcode:${r.workCode.toLowerCase()}` : r.workTitle ? `wname:${r.workTitle}` : "wnone";

/**
 * 束の鍵の条件名の側。書いていなければ1つにまとまる（これまでどおり）。
 * 書けば、同じ取引先・同じ作品でも条件を分けられる。分ける手立てが
 * 他に無いので、人が名前で決められるようにしておく。
 */
const nameToken = (r: BatchRow) => (r.conditionName ? `cname:${r.conditionName}` : "cauto");

/**
 * 同じ取引先・同じ作品の行を束ねる。1束 = 発注書1枚 = 条件明細1件。
 *
 * 取引先だけで束ねていたので、1つの案件に作品が何本かあると、同じ取引先の
 * 行が作品をまたいで1枚に混ざっていた。条件明細も作品なしで1件できるので、
 * その先（検収書・支払・権利）からどの作品の仕事か辿れなくなる。
 */
export function groupRows(rows: BatchRow[]): Array<
  Pick<BatchGroup, "key" | "partyCode" | "partyName" | "workCode" | "workTitle"
                 | "conditionName" | "rows" | "total">
> {
  const order: string[] = [];
  const by = new Map<string, BatchRow[]>();
  for (const r of rows) {
    const key = `${partyToken(r)}／${workToken(r)}／${nameToken(r)}`;
    if (!by.has(key)) { by.set(key, []); order.push(key); }
    by.get(key)!.push(r);
  }
  return order.map((key) => {
    const list = by.get(key)!;
    return { key, partyCode: list[0].partyCode, partyName: list[0].partyName,
             workCode: list[0].workCode, workTitle: list[0].workTitle,
             conditionName: list[0].conditionName, rows: list,
             total: list.reduce((s, r) => s + r.amount, 0) };
  });
}

/**
 * 束の中で揃っている値だけを返す。揃っていなければ null。
 *
 * 契約番号・支払条件は条件明細に1つしか持てない。行ごとに違うまま作ると、
 * どれか1行のぶんが全体の値として残る。揃っていないことを見せて、
 * 人に直してもらう。
 */
export function sameAcross<T>(rows: BatchRow[], pick: (r: BatchRow) => T | null): T | null {
  const set = new Set(rows.map(pick).filter((v) => v !== null && v !== ""));
  return set.size === 1 ? ([...set][0] as T) : null;
}

/**
 * 書類ごとの切り替え。発注書の「VII. 契約・署名」の欄に渡す。
 *
 * 渡すのは **CSV に書いてあることだけ**。未記入は渡さない。渡すと
 * 「人が決めた」扱いになり、ひな形の既定や条件からの差し込みを塞ぐ。
 *
 * 基本契約の「あり」と名前は渡さない。条件明細が合意を持っていれば、
 * 差し込みのときにそこから引ける（HAS_BASE_CONTRACT・MASTER_CONTRACT_REF）。
 * ここで固めると、合意の名前を直したときに古い名前が残る。
 * 「なし」だけは人の指示なので渡す（既定が「あり」でも外す）。
 */
export function documentToggles(g: Pick<BatchGroup, "rows">): Record<string, unknown> {
  const orderSign = sameAcross(g.rows, (r) => r.orderSign);
  const acceptSign = sameAcross(g.rows, (r) => r.acceptSign);
  const declaredNone = g.rows.some((r) => /^(なし|無|none|-)$/i.test(String(r.agreementNo ?? "").trim()));
  return {
    ...(orderSign === null ? {} : { SHOW_ORDER_SIGN_SECTION: orderSign }),
    ...(acceptSign === null ? {} : { SHOW_SIGN_SECTION: acceptSign }),
    ...(declaredNone ? { HAS_BASE_CONTRACT: false } : {})
  };
}

/** 書き出すときの あり・なし。決めていない（未記入）なら空のまま出す。 */
const onOffLabel = (value: unknown) =>
  value === true ? "あり" : value === false ? "なし" : "";

/** あり・なしを、食い違いの判定に使える文字にする（未記入は数えない）。 */
const onOffText = (value: boolean | null) =>
  value === null ? null : value ? "on" : "off";

/** 束の中で値が食い違っているか（1つも無いのは食い違いではない）。 */
export const conflicts = (rows: BatchRow[], pick: (r: BatchRow) => string | null): boolean =>
  new Set(rows.map(pick).filter(Boolean)).size > 1;

export interface BatchResultEntry {
  key: string; partyName: string | null;
  /** revised は決定済みの発注書の訂正版を起こした束。 */
  status: "created" | "revised" | "skipped" | "failed";
  partyId?: number; conditionId?: number; conditionNo?: string | null;
  documentId?: number; reason?: string;
  /** 訂正版が退かせる相手の文書番号（発行した時点で退く）。 */
  supersedesNo?: string | null;
  /** 一緒に作った（または既にあった）利用許諾条件の番号（A-048）。 */
  licenseConditionNos?: string[];
}

export interface BatchRecord {
  id: number; templateKey: string; matterId: number | null; matterNo: string | null; matterTitle: string | null;
  sourceFilename: string | null; rowCount: number; createdBy: string | null; createdAt: string;
  result: BatchResultEntry[];
  documents: DocumentSummary[];
}

export class DocumentBatchService {
  private readonly conditions: ConditionWriteService;
  private readonly schedules: ConditionScheduleService;
  private readonly matters: MatterLinkService;
  private readonly documents: DocumentRepository;

  constructor(
    private readonly database: Transactable,
    private readonly issues: DocumentIssueService,
    private readonly communications: MatterCommunicationService,
    private readonly pdf: PdfRenderer
  ) {
    this.conditions = new ConditionWriteService(database);
    this.schedules = new ConditionScheduleService(database);
    this.matters = new MatterLinkService(database);
    this.documents = new DocumentRepository(database);
  }

  /**
   * 突き合わせ。何も作らない。
   * choices は「候補が複数の束でどれを選んだか」（束の鍵 → 取引先ID）。
   */
  async preview(input: {
    templateKey: string; matterId: number; csv: string;
    choices?: Record<string, number>; workChoices?: Record<string, number>;
  }): Promise<BatchPreview> {
    if (!TEMPLATE_KEYS.has(input.templateKey)) {
      throw new DomainError("VALIDATION", "一括で作れるのは発注書（国内・海外）だけです");
    }
    const rows = readRows(input.csv);
    try {
      const matter = await this.database.query("SELECT id, kind FROM matters WHERE id = $1", [input.matterId]);
      if (!matter.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${input.matterId} が見つかりません`);
      const groups: BatchGroup[] = [];
      for (const g of groupRows(rows)) {
        const resolved = await this.resolveParty(this.database, g.partyCode, g.partyName);
        const chosen = input.choices?.[g.key];
        let party = resolved.party;
        let resolution = resolved.resolution;
        if (resolution === "ambiguous" && chosen && resolved.candidates.some((c) => c.id === chosen)) {
          party = resolved.candidates.find((c) => c.id === chosen)!;
          resolution = "resolved";
        }
        // 作品も取引先と同じ当て方をする。書いていなければ「作品なし」。
        const foundWork = await this.resolveWork(this.database, g.workCode, g.workTitle);
        const pickedWork = input.workChoices?.[g.key];
        let work = foundWork.work;
        let workResolution = foundWork.resolution;
        if (workResolution === "ambiguous" && pickedWork
            && foundWork.candidates.some((c) => c.id === pickedWork)) {
          work = foundWork.candidates.find((c) => c.id === pickedWork)!;
          workResolution = "resolved";
        }
        // 束の中で1つに決まらない値。条件明細は1つしか持てないので、
        // 食い違ったまま作らずに人へ返す（どれか1行のぶんが全体の値として残る）。
        const mixed = [
          ...(conflicts(g.rows, (r) => r.agreementNo)
            ? ["契約番号が行ごとに違います。1つの条件明細に契約は1つです"] : []),
          // 署名欄は書類ごとの切り替え。行ごとに違うと、どれを採るかを
          // こちらで決めることになる。人に直してもらう。
          ...(conflicts(g.rows, (r) => onOffText(r.orderSign))
            ? ["発注署名欄が行ごとに違います。書類ごとの切り替えです"] : []),
          ...(conflicts(g.rows, (r) => onOffText(r.acceptSign))
            ? ["承諾署名欄が行ごとに違います。書類ごとの切り替えです"] : []),
          ...(conflicts(g.rows, (r) => onOffText(r.fix))
            ? ["一括修正が行ごとに違います。書類ごとの切り替えです"] : []),
          ...(conflicts(g.rows, (r) => r.fixReason)
            ? ["修正理由が行ごとに違います。1枚の訂正版に理由は1つです"] : [])
        ];
        // 取引先と作品のどちらかが未登録なら飛ばす。どちらかが候補待ちなら選ぶ。
        const stuck = resolution === "missing" || workResolution === "missing";
        const choosing = resolution === "ambiguous" || workResolution === "ambiguous";
        // 作品が決まっていない束では引かない。作品なしの条件に当たって
        // 「既存」と出てしまい、飛ばす束なのに当たっているように見える。
        const condition = party && (workResolution === "none" || workResolution === "resolved")
          ? await this.existingCondition(this.database, input.matterId, party.id,
                                         work?.id ?? null, g.conditionName)
          : null;
        // 新しく作る条件に付ける基本契約。既存に当てる束は今の合意のまま触らない。
        const basic = party && !condition && !stuck && !choosing
          ? await this.basicAgreement(this.database, input.matterId, party.id,
                                      sameAcross(g.rows, (r) => r.agreementNo))
          : { agreement: null, note: null as string | null, missing: false };
        // 契約番号を書いたのに当たらない束は作らない。黙って「基本契約なし」で
        // 作ると、紙がスポット契約の約款で出る。
        const badAgreement = Boolean((basic as { missing?: boolean }).missing);
        // 決定済みの発注書を直す束。相手が1枚に決まるときだけ直せる。
        const fix = await this.resolveFix(g, condition?.id ?? null, input.templateKey,
                                          stuck || choosing);
        // 許諾条件は 作品 × 受注者 に立つ。作品なしの束では作れない。
        const licenseNeedsWork = workResolution === "none" && g.rows.some((r) => r.license);
        const issues = [
          ...(resolution === "missing" ? ["取引先が未登録（コードも名前も当たらない）。この束は飛ばす"] : []),
          ...(resolution === "ambiguous" ? ["候補が複数。どれかを選ぶ"] : []),
          ...(workResolution === "missing"
            ? [`作品が見つからない（${[g.workCode, g.workTitle].filter(Boolean).join(" / ")}）。この束は飛ばす`] : []),
          ...(workResolution === "ambiguous" ? ["作品の候補が複数。どれかを選ぶ"] : []),
          ...mixed,
          ...(badAgreement && basic.note ? [`${basic.note}。この束は飛ばす`] : []),
          ...(fix.on && fix.note ? [`${fix.note}。この束は飛ばす`] : []),
          ...(licenseNeedsWork ? ["許諾の列を書くなら作品（作品コードか作品名）が要る。この束は飛ばす"] : []),
          ...g.rows.flatMap((r) => r.issues.map((m) => `${r.line} 行目：${m}`))
        ];
        const blocking = g.rows.some((r) => r.issues.length > 0)
          || mixed.length > 0 || badAgreement || Boolean(fix.on && fix.note) || licenseNeedsWork;
        groups.push({
          ...g, resolution, party, candidates: resolved.candidates,
          workResolution, work, workCandidates: foundWork.candidates,
          fix,
          condition: condition
            ? { mode: "existing", id: condition.id, conditionNo: condition.conditionNo,
                agreement: null, agreementNote: null, schedules: 0 }
            : { mode: "new", id: null, conditionNo: null,
                agreement: basic.agreement, agreementNote: basic.note,
                schedules: scheduleLinesFrom(g.rows).length },
          issues,
          action: stuck ? "skip" : choosing ? "choose" : blocking ? "skip" : "create"
        });
      }
      return {
        groups,
        summary: {
          rows: rows.length, groups: groups.length,
          creatable: groups.filter((g) => g.action === "create").length,
          revising: groups.filter((g) => g.action === "create" && g.fix.on).length,
          skipped: groups.filter((g) => g.action === "skip").length,
          choose: groups.filter((g) => g.action === "choose").length
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 作る。束ごとに 条件明細（無ければ作る）→ 案件に繋ぐ → 下書き。
   * 1束で失敗しても止めない。結果は束の行に残す。
   */
  async create(
    input: { templateKey: string; matterId: number; csv: string; filename?: string | null;
             choices?: Record<string, number>; workChoices?: Record<string, number> },
    actor: string
  ): Promise<BatchRecord> {
    const preview = await this.preview(input);
    try {
      const matterRow = (await this.database.query(
        "SELECT id, title FROM matters WHERE id = $1", [input.matterId])).rows[0] as { title: string };
      const batchId = await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `INSERT INTO document_batches (template_key, matter_id, source_filename, row_count, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [input.templateKey, input.matterId, str(input.filename), preview.summary.rows, actor]);
        return Number((r.rows[0] as { id: number }).id);
      });

      const result: BatchResultEntry[] = [];
      for (const g of preview.groups) {
        if (g.action !== "create" || !g.party) {
          result.push({ key: g.key, partyName: g.party?.name ?? g.partyName, status: "skipped",
                        reason: g.issues[0] ?? "候補が決まっていない" });
          continue;
        }
        try {
          let conditionId = g.condition.id;
          let conditionNo = g.condition.conditionNo;
          if (!conditionId) {
            const created = await this.conditions.create({
              matterId: input.matterId,
              // 名前は人が決められる。書いていなければこれまでどおり自動。
              name: g.conditionName
                ?? (g.rows.length === 1
                  ? String(g.rows[0].item.item_name)
                  : `${g.work?.title ?? matterRow.title} ${g.party.name}`),
              direction: "in", kind: "service", counterpartyId: g.party.id,
              // 作品まで持たせないと、この条件から出た検収書も支払も
              // どの作品の仕事か辿れない。
              workId: g.work?.id ?? null,
              pricingModel: "fixed", flatAmount: g.total, currency: "JPY",
              // 納期は納期の列へ。ここは長らく term_end に書いていたが、
              // 契約期間の終了日と納期は別物で、許諾の条件では term_end は
              // 許諾期間の終わりになる。紙の「納期」は delivery_due を先に見る。
              deliveryDue: g.rows.map((r) => r.item.delivery_date as string | null)
                .filter(Boolean).sort().pop() ?? null,
              // 支払条件。以前はここへ支払日を並べて入れていたが、この欄は
              // 「月末締め翌月末払い」のような条件を書くところで、解析して
              // 支払日を導く先でもある。日付は各回の予定明細（pay_on）が持つ。
              paymentTerms: sameAcross(g.rows, (r) => r.paymentTerms ?? null),
              // 契約形式。行ごとに違えば条件には置かず、各行（＝各回）が持つ。
              contractForm: sameAcross(g.rows, (r) => (r.item.payment_terms as string | null) ?? null),
              notes: [...new Set(g.rows.map((r) => r.item.remarks as string | null).filter(Boolean))].join("\n") || null,
              // 仕様と帰属先も条件に持たせる。行ごとに違えば仕様は行名付きで並べ、帰属先は空にする。
              spec: g.rows.map((r) => r.item.spec ? (g.rows.length > 1 ? `${r.item.item_name}：${r.item.spec}` : String(r.item.spec)) : "")
                .filter(Boolean).join("\n") || null,
              deliverableOwnership: ownershipOfRows(g.rows),
              // 条件明細は基本契約にぶら下がる。付けずに作ると
              // 契約の画面からこの発注が見えない。
              agreementId: g.condition.agreement?.id ?? null
            }, actor);
            conditionId = created.id; conditionNo = created.conditionNo;
            // 予定明細。CSV の1行が1回。これが無いと、実績を入れるときに
            // 「どの回の分か」が選べず、検収書の支払日が空欄で出る。
            const lines = scheduleLinesFrom(g.rows);
            if (lines.length) await this.schedules.replace(conditionId, lines, actor);
          } else {
            await this.matters.attachCondition(input.matterId, conditionId, actor);
          }
          // 受注者帰属の成果物の利用許諾条件（A-048）。列が書いてあれば、同じ
          // 作品 × 受注者に利用形態ごとに 1 本。既にあれば作らない。
          const licenses = g.work
            ? await createLicenseConditions(this.database, this.conditions,
                licenseInputsFor(g.rows.map((r) => r.license), {
                  counterpartyId: g.party.id, workId: g.work.id, workTitle: g.work.title,
                  agreementId: g.condition.agreement?.id ?? null, matterId: input.matterId
                }), actor)
            : [];
          for (const l of licenses) {
            if (!l.existed) await this.matters.attachCondition(input.matterId, l.id, actor);
          }
          const manualInputs = {
            items: g.rows.map((r) => r.item), _batchId: batchId,
            // 書類ごとの切り替え。手入力として渡すので、人がそのあと画面で
            // 直せる（差し込みの自動判定より手入力が勝つ）。
            ...documentToggles(g)
          };
          // 一括修正の束は、新しく作らずに決定済みの発注書の訂正版を起こす。
          // 決定した文書は書き換えない（出したものの記録なので）。元が退くのは
          // 訂正版を発行した瞬間なので、ここでは下書きが2枚並ぶだけで、
          // 「まとめて決定」を押すまで相手に出したものは動かない。
          const draft = g.fix.on && g.fix.documentId
            ? await this.issues.reissue(g.fix.documentId, g.fix.reason ?? "一括修正", actor,
                                        [conditionId])
            : await this.issues.createDraft({
                templateKey: input.templateKey, conditionIds: [conditionId],
                matterId: input.matterId, manualInputs
              }, actor);
          // 訂正版は元の手入力を引き継いでいる。CSV の中身で置き換える。
          if (g.fix.on && g.fix.documentId) {
            await this.issues.updateDraft(draft.id, { manualInputs }, actor);
          }
          await this.database.query(
            "UPDATE documents SET batch_id = $2 WHERE id = $1", [draft.id, batchId]);
          result.push({ key: g.key, partyName: g.party.name,
                        status: g.fix.on ? "revised" : "created", partyId: g.party.id,
                        conditionId, conditionNo, documentId: draft.id,
                        ...(licenses.length ? { licenseConditionNos: licenses.map((l) => l.conditionNo ?? String(l.id)) } : {}),
                        ...(g.fix.on ? { supersedesNo: g.fix.documentNo } : {}) });
        } catch (error) {
          result.push({ key: g.key, partyName: g.party.name, status: "failed",
                        reason: (error as Error)?.message ?? String(error) });
        }
      }

      await inTransaction(this.database, async (client) => {
        await client.query("UPDATE document_batches SET result = $2::jsonb WHERE id = $1",
          [batchId, JSON.stringify(result)]);
        await recordAudit(client, {
          actor, action: "document.batch", targetType: "document_batch", targetId: batchId,
          detail: { templateKey: input.templateKey, matterId: input.matterId, filename: input.filename ?? null,
                    created: result.filter((r) => r.status === "created").length,
                    revised: result.filter((r) => r.status === "revised").length,
                    skipped: result.filter((r) => r.status === "skipped").length,
                    failed: result.filter((r) => r.status === "failed").length }
        });
      });
      return (await this.find(batchId))!;
    } catch (error) { throw translate(error); }
  }

  /**
   * 決定済みの発注書を、一括修正にそのまま上げられる CSV にして出す。
   *
   * 直すたびに人が19列を手で組み直すのは現実的でない。いまの中身を出して、
   * 直したいところだけ書き換えて上げ直せるようにする。
   * 「一括修正」は あり で出し、**修正理由だけ空**にする。理由は訂正版の
   * 記録に残るもので、こちらでは決められない（書かなければ上げても飛ぶ）。
   *
   * 出せるのは発注書だけ。利用許諾の条件書は項目が桁違いに多く、CSV の
   * 1行に収まらない。
   *
   * 1行が明細1行。条件明細が2件以上ぶら下がる文書は、この CSV の形
   * （1束＝1条件＝1文書）で表せないので出さずに理由を返す。
   */
  async exportCsv(input: { matterId?: number | null; documentIds?: number[] }): Promise<{
    csv: string; rows: number; documents: number;
    skipped: Array<{ documentNo: string | null; reason: string }>;
  }> {
    try {
      const ids = (input.documentIds ?? []).map(Number).filter(Boolean);
      if (!ids.length && !input.matterId) {
        throw new DomainError("VALIDATION", "案件か文書を指定してください");
      }
      const found = await this.database.query(
        `SELECT d.id, d.document_no, d.manual_inputs,
                c.id AS condition_id, c.name AS condition_name,
                p.party_code, p.name AS party_name,
                w.work_code, w.title AS work_title, a.agreement_no,
                count(*) OVER (PARTITION BY d.id) AS condition_count
           FROM documents d
           JOIN document_conditions dc ON dc.document_id = d.id
           JOIN conditions c ON c.id = dc.condition_id
           JOIN parties p ON p.id = c.counterparty_id
           LEFT JOIN works w ON w.id = c.work_id
           LEFT JOIN agreements a ON a.id = c.agreement_id
           JOIN document_template_versions v ON v.id = d.template_version_id
           JOIN document_templates t ON t.id = v.template_id
          WHERE t.template_key = ANY($1::text[])
            AND d.status = 'issued'
            AND ($2::bigint[] IS NULL OR d.id = ANY($2::bigint[]))
            AND ($3::bigint IS NULL OR d.matter_id = $3)
          ORDER BY d.id, dc.line_no`,
        [[...TEMPLATE_KEYS], ids.length ? ids : null, input.matterId ?? null]);

      // 起点は明細に無く、条件の予定明細が持っている。品目名で突き合わせ、
      // 合わなければ並び順で拾う。どちらも当たらなければ検収後にする
      // （上げ直すときに必須なので、空では出さない）。
      const conditionIds = [...new Set((found.rows as any[]).map((r) => Number(r.condition_id)))];
      const plans = conditionIds.length
        ? (await this.database.query(
            `SELECT condition_id, seq, label, trigger_kind FROM condition_schedules
              WHERE condition_id = ANY($1::bigint[]) ORDER BY condition_id, seq`,
            [conditionIds])).rows as any[]
        : [];

      const skipped: Array<{ documentNo: string | null; reason: string }> = [];
      const out: Array<Record<string, unknown>> = [];
      const seen = new Set<number>();
      for (const row of found.rows as any[]) {
        const documentId = Number(row.id);
        if (seen.has(documentId)) continue;   // 条件が2件以上でも文書は1回だけ見る
        seen.add(documentId);
        if (Number(row.condition_count) > 1) {
          skipped.push({ documentNo: str(row.document_no),
                         reason: "条件明細が2件以上ぶら下がっています。この CSV の形では表せません" });
          continue;
        }
        const manual = (row.manual_inputs ?? {}) as Record<string, any>;
        const items = Array.isArray(manual.items) ? manual.items as Array<Record<string, any>> : [];
        if (!items.length) {
          skipped.push({ documentNo: str(row.document_no), reason: "明細がありません" });
          continue;
        }
        const mine = plans.filter((s) => Number(s.condition_id) === Number(row.condition_id));
        for (const [index, item] of items.entries()) {
          const plan = mine.find((s) => str(s.label) === String(item.item_name ?? "")) ?? mine[index];
          out.push({
            partyCode: str(row.party_code), partyName: str(row.party_name),
            workCode: str(row.work_code), workTitle: str(row.work_title),
            agreementNo: str(row.agreement_no), conditionName: str(row.condition_name),
            item_name: item.item_name, spec: item.spec,
            quantity: item.quantity, unit_price: item.unit_price,
            triggerKind: TRIGGER_LABEL[(plan?.trigger_kind as TriggerKind) ?? "on_inspection"],
            delivery_date: item.delivery_date, payment_date: item.payment_date,
            contract_form: item.payment_terms,
            payment_terms: str(row.payment_terms),
            deliverable_ownership: item.deliverable_ownership,
            orderSign: onOffLabel(manual.SHOW_ORDER_SIGN_SECTION),
            acceptSign: onOffLabel(manual.SHOW_SIGN_SECTION),
            calc_method: "固定額", remarks: item.remarks,
            // 直すために出す CSV なので、修正は あり。理由だけは人が書く。
            fix: "あり", fixReason: ""
          });
        }
      }
      return { csv: toCsv(out), rows: out.length, documents: seen.size - skipped.length, skipped };
    } catch (error) { throw translate(error); }
  }

  async list(limit = 30): Promise<Array<Omit<BatchRecord, "documents" | "result"> & { created: number; skipped: number; failed: number }>> {
    const r = await this.database.query(
      `SELECT b.*, m.matter_no, m.title AS matter_title FROM document_batches b
         LEFT JOIN matters m ON m.id = b.matter_id
        ORDER BY b.id DESC LIMIT $1`, [limit]);
    return r.rows.map((row: Record<string, any>) => {
      const result = (row.result as BatchResultEntry[]) ?? [];
      return {
        ...this.mapBatch(row),
        created: result.filter((x) => x.status === "created" || x.status === "revised").length,
        skipped: result.filter((x) => x.status === "skipped").length,
        failed: result.filter((x) => x.status === "failed").length
      };
    });
  }

  async find(id: number): Promise<BatchRecord | null> {
    const r = await this.database.query(
      `SELECT b.*, m.matter_no, m.title AS matter_title FROM document_batches b
         LEFT JOIN matters m ON m.id = b.matter_id WHERE b.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return { ...this.mapBatch(row), result: (row.result as BatchResultEntry[]) ?? [],
             documents: await this.documents.list({ batchId: id, limit: 500 }) };
  }

  /** 束の下書きをまとめて決定する。必須が揃っていないものは飛ばして理由を返す。 */
  async issueAll(id: number, actor: string) {
    const batch = await this.find(id);
    if (!batch) throw new DomainError("NOT_FOUND", `一括 #${id} が見つかりません`);
    const results: Array<{ documentId: number; partyName: string | null; ok: boolean; documentNo?: string; reason?: string }> = [];
    for (const d of batch.documents.filter((x) => x.status === "draft")) {
      try {
        const issued = await this.issues.issue(d.id, actor);
        results.push({ documentId: d.id, partyName: d.counterparty, ok: true, documentNo: issued.documentNo });
      } catch (error) {
        results.push({ documentId: d.id, partyName: d.counterparty, ok: false,
                       reason: (error as Error)?.message ?? String(error) });
      }
    }
    return { results, batch: await this.find(id) };
  }

  /**
   * 束の決定済み文書をまとめて送る。宛先は取引先の連絡先、写しに案件の担当者。
   * 連絡先の無い取引先は送れない理由を返す（黙って飛ばさない）。
   */
  async sendAll(id: number, input: { subject?: string | null; body?: string | null }, actor: string) {
    const batch = await this.find(id);
    if (!batch) throw new DomainError("NOT_FOUND", `一括 #${id} が見つかりません`);
    if (!batch.matterId) throw new DomainError("VALIDATION", "案件の無い束は送れません");
    const recipients = await this.communications.recipients(batch.matterId);
    const cc = recipients.owner?.email ? [recipients.owner.email] : [];
    const results: Array<{ documentId: number; documentNo: string | null; partyName: string | null;
                           sent: boolean; reason?: string; to?: string[] }> = [];
    for (const d of batch.documents.filter((x) => x.phase === "decided")) {
      try {
        const to = await this.partyEmails(d.id);
        if (!to.length) {
          results.push({ documentId: d.id, documentNo: d.documentNo, partyName: d.counterparty,
                         sent: false, reason: "取引先に連絡先のメールが無い" });
          continue;
        }
        const rendered = await this.issues.renderIssued(d.id);
        const r = await this.communications.sendEmail(batch.matterId, {
          to, cc,
          subject: str(input.subject) ?? `${d.documentNo ?? ""} ${d.templateLabel ?? "発注書"} のご確認`.trim(),
          body: str(input.body) ?? `${d.templateLabel ?? "発注書"}をお送りします。内容をご確認のうえ、問題なければご返信ください。`,
          documentId: d.id,
          attachment: { filename: `${d.documentNo ?? `document-${d.id}`}.pdf`,
                        mimeType: "application/pdf", data: await this.pdf.render(rendered.html) }
        }, actor);
        results.push({ documentId: d.id, documentNo: d.documentNo, partyName: d.counterparty,
                       sent: r.outcome.sent, to,
                       reason: r.outcome.sent ? undefined
                         : r.outcome.duplicated ? "同じ内容を送付済み" : r.outcome.gate.reasons.join("／") });
      } catch (error) {
        results.push({ documentId: d.id, documentNo: d.documentNo, partyName: d.counterparty,
                       sent: false, reason: (error as Error)?.message ?? String(error) });
      }
    }
    return { results, batch: await this.find(id) };
  }

  /** 文書の条件明細の相手先に登録されている連絡先のメール。無ければ取引先のメール。 */
  private async partyEmails(documentId: number): Promise<string[]> {
    const r = await this.database.query(
      `SELECT DISTINCT pc.email FROM document_conditions dc
         JOIN conditions c ON c.id = dc.condition_id
         JOIN party_contacts pc ON pc.party_id = c.counterparty_id
        WHERE dc.document_id = $1 AND pc.email IS NOT NULL`, [documentId]);
    const emails = r.rows.map((x: any) => String(x.email).trim()).filter(Boolean);
    if (emails.length) return emails;
    const p = await this.database.query(
      `SELECT DISTINCT p.email FROM document_conditions dc
         JOIN conditions c ON c.id = dc.condition_id
         JOIN parties p ON p.id = c.counterparty_id
        WHERE dc.document_id = $1 AND p.email IS NOT NULL`, [documentId]);
    return p.rows.map((x: any) => String(x.email).trim()).filter(Boolean);
  }

  /**
   * 取引先を当てる。コード → 名前（登録名・別名・カナの一致）の順。
   * 1件に決まるときだけ resolved。コードと名前が別の取引先を指したら ambiguous。
   */
  async resolveParty(client: Queryable, code: string | null, name: string | null):
    Promise<{ resolution: BatchGroup["resolution"]; party: PartyCandidate | null; candidates: PartyCandidate[] }> {
    const map = (p: any): PartyCandidate => ({ id: Number(p.id), name: String(p.name), partyCode: str(p.party_code) });
    const byCode = code
      ? (await client.query(
          `SELECT id, name, party_code FROM parties
            WHERE status <> 'merged' AND lower(btrim(party_code)) = lower(btrim($1))`, [code])).rows.map(map)
      : [];
    const byName = name
      ? (await client.query(
          `SELECT id, name, party_code FROM parties
            WHERE status <> 'merged'
              AND (btrim(name) = btrim($1) OR btrim(COALESCE(name_kana, '')) = btrim($1)
                   OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE btrim(a) = btrim($1)))
            LIMIT 5`, [name])).rows.map(map)
      : [];
    if (byCode.length === 1) {
      // コードで決まった。名前が別の取引先を指しているなら、人に決めてもらう。
      if (byName.length && !byName.some((p) => p.id === byCode[0].id)) {
        const candidates = [byCode[0], ...byName.filter((p) => p.id !== byCode[0].id)];
        return { resolution: "ambiguous", party: null, candidates };
      }
      return { resolution: "resolved", party: byCode[0], candidates: byCode };
    }
    if (byCode.length > 1) return { resolution: "ambiguous", party: null, candidates: byCode };
    if (byName.length === 1) return { resolution: "resolved", party: byName[0], candidates: byName };
    if (byName.length > 1) return { resolution: "ambiguous", party: null, candidates: byName };
    return { resolution: "missing", party: null, candidates: [] };
  }

  /**
   * 作品を当てる。コード → 題名 の順。1件に決まるときだけ resolved。
   *
   * 取引先と違って、書いていないのは誤りではない（作品に紐づかない委託がある）。
   * 書いてあるのに当たらないときだけ止める。黙って作品なしで作ると、その先から
   * どの作品の仕事か辿れない条件明細が残る。
   */
  async resolveWork(client: Queryable, code: string | null, title: string | null):
    Promise<{ resolution: WorkResolution; work: WorkCandidate | null; candidates: WorkCandidate[] }> {
    if (!code && !title) return { resolution: "none", work: null, candidates: [] };
    const map = (w: any): WorkCandidate => ({ id: Number(w.id), title: String(w.title), workCode: str(w.work_code) });
    const byCode = code
      ? (await client.query(
          `SELECT id, title, work_code FROM works
            WHERE lower(btrim(work_code)) = lower(btrim($1)) LIMIT 5`, [code])).rows.map(map)
      : [];
    const byTitle = title
      ? (await client.query(
          `SELECT id, title, work_code FROM works
            WHERE btrim(title) = btrim($1) OR btrim(COALESCE(title_kana, '')) = btrim($1)
            LIMIT 5`, [title])).rows.map(map)
      : [];
    if (byCode.length === 1) {
      // コードで決まった。題名が別の作品を指しているなら、人に決めてもらう。
      if (byTitle.length && !byTitle.some((w) => w.id === byCode[0].id)) {
        return { resolution: "ambiguous", work: null,
                 candidates: [byCode[0], ...byTitle.filter((w) => w.id !== byCode[0].id)] };
      }
      return { resolution: "resolved", work: byCode[0], candidates: byCode };
    }
    if (byCode.length > 1) return { resolution: "ambiguous", work: null, candidates: byCode };
    if (byTitle.length === 1) return { resolution: "resolved", work: byTitle[0], candidates: byTitle };
    if (byTitle.length > 1) return { resolution: "ambiguous", work: null, candidates: byTitle };
    return { resolution: "missing", work: null, candidates: [] };
  }

  /**
   * 「一括修正」の束の行き先を決める。
   *
   * 直すのは決定済みの発注書。CSV の中身で訂正版の下書きを起こす。
   * 条件明細そのものは触らない（金額や納期を台帳ごと直すのは別の作業で、
   * 条件の改訂になる）。台帳と紙が食い違うときは、突き合わせの表で知らせる。
   */
  private async resolveFix(
    g: { rows: BatchRow[] }, conditionId: number | null, templateKey: string, unresolved: boolean
  ): Promise<BatchGroup["fix"]> {
    const off = { on: false, documentId: null, documentNo: null, reason: null, note: null };
    // 行ごとに違うのは食い違い。mixed 側で拾うので、ここは1つに決まるときだけ。
    if (sameAcross(g.rows, (r) => (r.fix === true ? "on" : null)) !== "on") return off;
    const reason = sameAcross(g.rows, (r) => r.fixReason);
    const base = { on: true, documentId: null as number | null, documentNo: null as string | null,
                   reason };
    if (!reason) {
      return { ...base, note: "修正理由が空です。訂正版の記録に残るので必ず書いてください" };
    }
    // 取引先や作品が決まっていない束は、そもそもどの条件の話か定まらない。
    if (unresolved) return { ...base, note: null };
    if (!conditionId) {
      return { ...base,
               note: "直す相手が見つかりません（この取引先・作品・条件名の条件明細がこの案件にありません）" };
    }
    const found = await this.issuedDocument(this.database, conditionId, templateKey);
    if (!found.length) {
      return { ...base, note: "直す相手が見つかりません（この条件明細から決定済みの発注書が出ていません）" };
    }
    if (found.length > 1) {
      return { ...base,
               note: `決定済みの発注書が ${found.length} 枚あります（${found.map((d) => d.documentNo ?? `#${d.id}`).join("・")}）。どれを直すか決められません` };
    }
    return { ...base, documentId: found[0].id, documentNo: found[0].documentNo, note: null };
  }

  /**
   * 直す相手の発注書。その条件から出ている決定済みのものを探す。
   *
   * 決定した文書は書き換えない（出したものの記録なので）。直す唯一の道は
   * 訂正版を起こすことで、元は訂正版を発行した瞬間に退く。
   *
   * 1枚に決まるときだけ直す。0枚なら直すものが無く、2枚以上ならどれを
   * 直すかをこちらでは決められない。どちらも飛ばして理由を残す。
   */
  private async issuedDocument(client: Queryable, conditionId: number, templateKey: string) {
    const r = await client.query(
      `SELECT d.id, d.document_no FROM document_conditions dc
         JOIN documents d ON d.id = dc.document_id
         JOIN document_template_versions v ON v.id = d.template_version_id
         JOIN document_templates t ON t.id = v.template_id
        WHERE dc.condition_id = $1 AND t.template_key = $2 AND d.status = 'issued'
        ORDER BY d.id DESC LIMIT 5`, [conditionId, templateKey]);
    return (r.rows as Array<{ id: number; document_no: string | null }>)
      .map((row) => ({ id: Number(row.id), documentNo: str(row.document_no) }));
  }

  /**
   * その取引先との業務委託の基本契約。
   *
   * 条件明細は基本契約にぶら下がる（基本契約 ⇒ 作品 ⇒ 条件明細 ⇒ 発注書）。
   * 付けずに作ると鎖の1本目が切れ、契約の画面からこの発注が見えない。
   *
   * まず、この案件で既に使っている基本契約を見る（案件の工程バーが読んで
   * いるのと同じもの）。無ければ、その取引先の締結済みの取得側の合意が
   * ちょうど1件のときだけ当てる。決まらなければ付けない。
   * 発注書は基本契約なしでも出せるので、ここは止める理由にしない。
   */
  // 遡及の一括取込（settled-batch-service）も同じ当て方を使う。名寄せの
  // 規則が2つに分かれると、同じ CSV が経路によって別の相手に当たる。
  async basicAgreement(
    client: Queryable, matterId: number, partyId: number, agreementNo: string | null
  ): Promise<{ agreement: AgreementRef | null; note: string | null; missing?: boolean }> {
    const map = (a: any): AgreementRef =>
      ({ id: Number(a.id), agreementNo: str(a.agreement_no), title: str(a.title) });
    // 「なし」は人が外したという指示。自動で探さず、基本契約なしの発注にする
    // （紙はスポット契約の約款の側で出る）。
    if (agreementNo && /^(なし|無|none|-)$/i.test(agreementNo.trim())) {
      return { agreement: null, note: "基本契約なしの発注として作ります（CSV の指定）" };
    }
    // 契約番号が書いてあれば、それを当てる。自動判定より人の指定が強い。
    if (agreementNo) {
      const found = await client.query(
        `SELECT id, agreement_no, title, counterparty_id FROM agreements
          WHERE lower(btrim(agreement_no)) = lower(btrim($1)) LIMIT 5`, [agreementNo]);
      if (!found.rows.length) {
        return { agreement: null, missing: true,
                 note: `契約番号 ${agreementNo} が見つかりません` };
      }
      if (found.rows.length > 1) {
        return { agreement: null, missing: true,
                 note: `契約番号 ${agreementNo} が複数あります` };
      }
      const row = found.rows[0] as any;
      // 別の取引先の契約にぶら下げない。番号の写し間違いを黙って通すと、
      // 関係の無い契約に発注が紐づく。
      if (Number(row.counterparty_id) !== partyId) {
        return { agreement: null, missing: true,
                 note: `契約 ${agreementNo} はこの取引先の契約ではありません` };
      }
      return { agreement: map(row), note: null };
    }
    const inMatter = await client.query(
      `SELECT DISTINCT a.id, a.agreement_no, a.title
         FROM matter_links ml
         JOIN conditions c ON c.id::text = ml.target_ref
         JOIN agreements a ON a.id = c.agreement_id
        WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
          AND c.counterparty_id = $2 AND c.status = 'active'
        LIMIT 5`, [matterId, partyId]);
    if (inMatter.rows.length === 1) return { agreement: map(inMatter.rows[0]), note: null };
    if (inMatter.rows.length > 1) {
      return { agreement: null,
               note: "この案件でこの取引先の基本契約が複数使われています。基本契約なしで作ります。特定の契約に載せるなら「契約番号」の列に書いてください" };
    }
    const executed = await client.query(
      `SELECT id, agreement_no, title FROM agreements
        WHERE counterparty_id = $1 AND direction = 'in' AND status = 'executed'
        LIMIT 5`, [partyId]);
    if (executed.rows.length === 1) return { agreement: map(executed.rows[0]), note: null };
    if (executed.rows.length > 1) {
      return { agreement: null,
               note: "この取引先の締結済みの基本契約が複数あります。基本契約なしで作ります。特定の契約に載せるなら「契約番号」の列に書いてください" };
    }
    return { agreement: null, note: "締結済みの基本契約が見つかりません（基本契約なしの発注として作ります）" };
  }

  /**
   * この案件に載っている、その取引先・その作品の 定額・委託料 の有効な条件。
   *
   * 作品まで見ないと、作品が何本かある案件で、別の作品の条件に発注書が
   * ぶら下がってしまう。作品なしの束は作品なしの条件にだけ当てる。
   */
  /**
   * 条件番号で名指しで当てる。
   *
   * 名前で当てる規則は、同名の条件が2本ある取引先で取り違える。書き出した
   * CSV は番号を持っているので、番号があるときはそれだけを見る。
   * 番号が案件に無い／相手先が食い違うときは、当てずに理由を返す
   * （近そうな条件に黙って載せるほうが害が大きい）。
   */
  async conditionByNo(
    client: Queryable, matterId: number, conditionNo: string, partyId: number | null
  ): Promise<{ id: number; conditionNo: string | null } | { error: string }> {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.status, c.counterparty_id, p.name AS party_name,
              EXISTS (SELECT 1 FROM matter_links ml
                       WHERE ml.matter_id = $2 AND ml.target_type = 'condition'
                         AND ml.target_ref = c.id::text) AS on_matter
         FROM conditions c
         LEFT JOIN parties p ON p.id = c.counterparty_id
        WHERE btrim(c.condition_no) = btrim($1)`, [conditionNo, matterId]);
    const row = r.rows[0] as {
      id: number; condition_no: string | null; status: string;
      counterparty_id: number | null; party_name: string | null; on_matter: boolean;
    } | undefined;
    if (!row) return { error: `条件番号 ${conditionNo} が見つかりません` };
    if (row.status !== "active" && row.status !== "draft") {
      return { error: `条件番号 ${conditionNo} は ${row.status} です。有効な条件を指してください` };
    }
    if (!row.on_matter) return { error: `条件番号 ${conditionNo} はこの案件に載っていません` };
    if (partyId && Number(row.counterparty_id) !== partyId) {
      return { error: `条件番号 ${conditionNo} の相手先は ${row.party_name ?? "（不明）"} です。`
        + "行の取引先と食い違っています" };
    }
    return { id: Number(row.id), conditionNo: str(row.condition_no) };
  }

  async existingCondition(
    client: Queryable, matterId: number, partyId: number, workId: number | null,
    conditionName: string | null
  ) {
    // 条件名を書いてあるときは名前まで見る。束は名前で分かれるのに、当てる
    // ほうが名前を見ないと、別の名前を書いても同じ条件にぶら下がって
    // 名前が捨てられる（分ける手立てが無くなる）。
    const r = await client.query(
      `SELECT c.id, c.condition_no FROM matter_links ml
         JOIN conditions c ON c.id::text = ml.target_ref
        WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
          AND c.counterparty_id = $2 AND c.status = 'active'
          AND c.kind = 'service' AND c.pricing_model = 'fixed'
          AND c.work_id IS NOT DISTINCT FROM $3
          AND ($4::text IS NULL OR btrim(c.name) = btrim($4))
        ORDER BY c.id DESC LIMIT 1`, [matterId, partyId, workId, conditionName]);
    const row = r.rows[0] as { id: number; condition_no: string | null } | undefined;
    return row ? { id: Number(row.id), conditionNo: str(row.condition_no) } : null;
  }

  private mapBatch(row: Record<string, any>) {
    return {
      id: Number(row.id), templateKey: String(row.template_key), matterId: int(row.matter_id),
      matterNo: str(row.matter_no), matterTitle: str(row.matter_title),
      sourceFilename: str(row.source_filename), rowCount: Number(row.row_count ?? 0),
      createdBy: str(row.created_by), createdAt: new Date(String(row.created_at)).toISOString()
    };
  }
}
