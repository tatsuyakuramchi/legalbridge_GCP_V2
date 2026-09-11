import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { parseCsv, csvAmount } from "../imports/parse.js";
import { ConditionWriteService } from "../conditions/write-service.js";
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
export const ORDER_COLUMNS: Array<{ key: string; label: string; required?: boolean; note: string }> = [
  { key: "partyCode", label: "取引先コード", note: "コードか名前のどちらかで当てる" },
  { key: "partyName", label: "取引先名", note: "登録名・別名・カナのどれかに一致" },
  // 作品は1つの案件に何本でも載る。列が無いと、同じ取引先の行が作品をまたいで
  // 1枚に混ざり、条件明細も作品なしで作られていた。
  { key: "workCode", label: "作品コード", note: "コードか作品名のどちらかで当てる。空なら作品なし" },
  { key: "workTitle", label: "作品名", note: "登録名に一致" },
  { key: "item_name", label: "品目・業務名", required: true, note: "" },
  { key: "spec", label: "仕様・成果物", note: "" },
  { key: "quantity", label: "数量", note: "空なら 1" },
  { key: "unit_price", label: "単価（税抜）", required: true, note: "円" },
  { key: "delivery_date", label: "納期", note: "2026-10-31 か 2026/10/31" },
  { key: "payment_date", label: "支払日", note: "" },
  { key: "deliverable_ownership", label: "成果物の帰属先", note: "発注者 か 受注者" },
  { key: "calc_method", label: "支払方法", note: "固定額 だけ。空なら固定額" },
  { key: "remarks", label: "備考", note: "" }
];

export function templateCsv(): string {
  const header = ORDER_COLUMNS.map((c) => c.label).join(",");
  // 例は2行にする。1行だけだと「同じ取引先でも作品が違えば別の発注書になる」
  // ことが伝わらず、作品の列を空のまま使われる。
  const examples = [
    ["VD-00317", "合同会社アトリエ蒼", "WRK-10013", "星降る夜のミュゼ", "第4巻 表紙イラスト",
     "カラー1点", "1", "150000", "2026-10-31", "2026-11-30", "発注者", "固定額", ""],
    ["VD-00317", "合同会社アトリエ蒼", "WRK-10021", "夜明けのクロニクル", "第1巻 挿絵",
     "モノクロ12点", "12", "8000", "2026-11-30", "2026-12-31", "発注者", "固定額", ""]
  ].map((row) => row.join(","));
  return `﻿${header}\n${examples.join("\n")}\n`;
}

export interface BatchRow {
  line: number;
  partyCode: string | null;
  partyName: string | null;
  workCode: string | null;
  workTitle: string | null;
  item: Record<string, unknown>;
  amount: number;
  issues: string[];
}

const normalizeDate = (v: string | undefined): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
};

/** 見出しは日本語の列名か、明細のキー名のどちらでも読む。 */
const pick = (row: Record<string, string>, column: { key: string; label: string }) =>
  row[column.label] ?? row[column.key] ?? "";

/** CSV の行を、明細の1行として読む。読めないところは issues に残す（行は捨てない）。 */
export function readRows(text: string): BatchRow[] {
  const parsed = parseCsv(text, { maxRows: 1000 });
  const known = ORDER_COLUMNS.some((c) => parsed.headers.includes(c.label) || parsed.headers.includes(c.key));
  if (!known) {
    throw new DomainError("VALIDATION",
      `見出しが雛形と合いません。雛形をダウンロードして、その列名で作ってください（読んだ見出し: ${parsed.headers.slice(0, 5).join(", ")}）`);
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
    const amount = (quantity ?? 0) * (unitPrice ?? 0);
    return {
      line: i + 2,
      partyCode: get("partyCode") || null,
      partyName: get("partyName") || null,
      workCode: get("workCode") || null,
      workTitle: get("workTitle") || null,
      item: {
        item_name: itemName, spec: get("spec") || null,
        quantity: quantity ?? null, unit_price: unitPrice ?? null, amount_ex_tax: amount,
        delivery_date: deliveryDate, payment_date: paymentDate,
        deliverable_ownership: ownership || null, calc_method: "FIXED",
        remarks: get("remarks") || null
      },
      amount,
      issues
    };
  });
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
  workResolution: WorkResolution;
  work: WorkCandidate | null;
  workCandidates: WorkCandidate[];
  /** 条件明細の扱い。既存に当てるか、新しく作るか。 */
  condition: { mode: "existing" | "new"; id: number | null; conditionNo: string | null };
  rows: BatchRow[];
  total: number;
  issues: string[];
  /** この束をどうするか。create=作る / choose=候補を選ぶ / skip=飛ばす */
  action: "create" | "choose" | "skip";
}

export interface BatchPreview {
  groups: BatchGroup[];
  summary: { rows: number; groups: number; creatable: number; skipped: number; choose: number };
}

/** 束の鍵の取引先の側。コード、無ければ名前。 */
const partyToken = (r: BatchRow) =>
  r.partyCode ? `code:${r.partyCode.toLowerCase()}` : r.partyName ? `name:${r.partyName}` : `line:${r.line}`;

/** 束の鍵の作品の側。書いていなければ「作品なし」。 */
const workToken = (r: BatchRow) =>
  r.workCode ? `wcode:${r.workCode.toLowerCase()}` : r.workTitle ? `wname:${r.workTitle}` : "wnone";

/**
 * 同じ取引先・同じ作品の行を束ねる。1束 = 発注書1枚 = 条件明細1件。
 *
 * 取引先だけで束ねていたので、1つの案件に作品が何本かあると、同じ取引先の
 * 行が作品をまたいで1枚に混ざっていた。条件明細も作品なしで1件できるので、
 * その先（検収書・支払・権利）からどの作品の仕事か辿れなくなる。
 */
export function groupRows(rows: BatchRow[]): Array<
  Pick<BatchGroup, "key" | "partyCode" | "partyName" | "workCode" | "workTitle" | "rows" | "total">
> {
  const order: string[] = [];
  const by = new Map<string, BatchRow[]>();
  for (const r of rows) {
    const key = `${partyToken(r)}／${workToken(r)}`;
    if (!by.has(key)) { by.set(key, []); order.push(key); }
    by.get(key)!.push(r);
  }
  return order.map((key) => {
    const list = by.get(key)!;
    return { key, partyCode: list[0].partyCode, partyName: list[0].partyName,
             workCode: list[0].workCode, workTitle: list[0].workTitle, rows: list,
             total: list.reduce((s, r) => s + r.amount, 0) };
  });
}

export interface BatchResultEntry {
  key: string; partyName: string | null; status: "created" | "skipped" | "failed";
  partyId?: number; conditionId?: number; conditionNo?: string | null;
  documentId?: number; reason?: string;
}

export interface BatchRecord {
  id: number; templateKey: string; matterId: number | null; matterNo: string | null; matterTitle: string | null;
  sourceFilename: string | null; rowCount: number; createdBy: string | null; createdAt: string;
  result: BatchResultEntry[];
  documents: DocumentSummary[];
}

export class DocumentBatchService {
  private readonly conditions: ConditionWriteService;
  private readonly matters: MatterLinkService;
  private readonly documents: DocumentRepository;

  constructor(
    private readonly database: Transactable,
    private readonly issues: DocumentIssueService,
    private readonly communications: MatterCommunicationService,
    private readonly pdf: PdfRenderer
  ) {
    this.conditions = new ConditionWriteService(database);
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
        const issues = [
          ...(resolution === "missing" ? ["取引先が未登録（コードも名前も当たらない）。この束は飛ばす"] : []),
          ...(resolution === "ambiguous" ? ["候補が複数。どれかを選ぶ"] : []),
          ...(workResolution === "missing"
            ? [`作品が見つからない（${[g.workCode, g.workTitle].filter(Boolean).join(" / ")}）。この束は飛ばす`] : []),
          ...(workResolution === "ambiguous" ? ["作品の候補が複数。どれかを選ぶ"] : []),
          ...g.rows.flatMap((r) => r.issues.map((m) => `${r.line} 行目：${m}`))
        ];
        // 作品が決まっていない束では引かない。作品なしの条件に当たって
        // 「既存」と出てしまい、飛ばす束なのに当たっているように見える。
        const condition = party && (workResolution === "none" || workResolution === "resolved")
          ? await this.existingCondition(this.database, input.matterId, party.id, work?.id ?? null)
          : null;
        const blocking = g.rows.some((r) => r.issues.length > 0);
        // 取引先と作品のどちらかが未登録なら飛ばす。どちらかが候補待ちなら選ぶ。
        const stuck = resolution === "missing" || workResolution === "missing";
        const choosing = resolution === "ambiguous" || workResolution === "ambiguous";
        groups.push({
          ...g, resolution, party, candidates: resolved.candidates,
          workResolution, work, workCandidates: foundWork.candidates,
          condition: condition
            ? { mode: "existing", id: condition.id, conditionNo: condition.conditionNo }
            : { mode: "new", id: null, conditionNo: null },
          issues,
          action: stuck ? "skip" : choosing ? "choose" : blocking ? "skip" : "create"
        });
      }
      return {
        groups,
        summary: {
          rows: rows.length, groups: groups.length,
          creatable: groups.filter((g) => g.action === "create").length,
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
              name: g.rows.length === 1
                ? String(g.rows[0].item.item_name)
                : `${g.work?.title ?? matterRow.title} ${g.party.name}`,
              direction: "in", kind: "service", counterpartyId: g.party.id,
              // 作品まで持たせないと、この条件から出た検収書も支払も
              // どの作品の仕事か辿れない。
              workId: g.work?.id ?? null,
              pricingModel: "fixed", flatAmount: g.total, currency: "JPY",
              termEnd: g.rows.map((r) => r.item.delivery_date as string | null).filter(Boolean).sort().pop() ?? null,
              paymentTerms: [...new Set(g.rows.map((r) => r.item.payment_date as string | null).filter(Boolean))].join("、") || null,
              notes: [...new Set(g.rows.map((r) => r.item.remarks as string | null).filter(Boolean))].join("\n") || null,
              // 仕様と帰属先も条件に持たせる。行ごとに違えば仕様は行名付きで並べ、帰属先は空にする。
              spec: g.rows.map((r) => r.item.spec ? (g.rows.length > 1 ? `${r.item.item_name}：${r.item.spec}` : String(r.item.spec)) : "")
                .filter(Boolean).join("\n") || null,
              deliverableOwnership: ownershipOfRows(g.rows)
            }, actor);
            conditionId = created.id; conditionNo = created.conditionNo;
          } else {
            await this.matters.attachCondition(input.matterId, conditionId, actor);
          }
          const draft = await this.issues.createDraft({
            templateKey: input.templateKey, conditionIds: [conditionId], matterId: input.matterId,
            manualInputs: { items: g.rows.map((r) => r.item), _batchId: batchId }
          }, actor);
          await this.database.query(
            "UPDATE documents SET batch_id = $2 WHERE id = $1", [draft.id, batchId]);
          result.push({ key: g.key, partyName: g.party.name, status: "created", partyId: g.party.id,
                        conditionId, conditionNo, documentId: draft.id });
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
                    skipped: result.filter((r) => r.status === "skipped").length,
                    failed: result.filter((r) => r.status === "failed").length }
        });
      });
      return (await this.find(batchId))!;
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
        created: result.filter((x) => x.status === "created").length,
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
   * この案件に載っている、その取引先・その作品の 定額・委託料 の有効な条件。
   *
   * 作品まで見ないと、作品が何本かある案件で、別の作品の条件に発注書が
   * ぶら下がってしまう。作品なしの束は作品なしの条件にだけ当てる。
   */
  private async existingCondition(
    client: Queryable, matterId: number, partyId: number, workId: number | null
  ) {
    const r = await client.query(
      `SELECT c.id, c.condition_no FROM matter_links ml
         JOIN conditions c ON c.id::text = ml.target_ref
        WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
          AND c.counterparty_id = $2 AND c.status = 'active'
          AND c.kind = 'service' AND c.pricing_model = 'fixed'
          AND c.work_id IS NOT DISTINCT FROM $3
        ORDER BY c.id DESC LIMIT 1`, [matterId, partyId, workId]);
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
