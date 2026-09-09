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
  const example = [
    "VD-00317", "合同会社アトリエ蒼", "第4巻 表紙イラスト", "カラー1点", "1", "150000",
    "2026-10-31", "2026-11-30", "発注者", "固定額", ""
  ].join(",");
  return `﻿${header}\n${example}\n`;
}

export interface BatchRow {
  line: number;
  partyCode: string | null;
  partyName: string | null;
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

export interface PartyCandidate { id: number; name: string; partyCode: string | null }
export interface BatchGroup {
  /** 束の鍵。取引先コードがあればそれ、無ければ名前。 */
  key: string;
  partyCode: string | null;
  partyName: string | null;
  resolution: "resolved" | "ambiguous" | "missing";
  party: PartyCandidate | null;
  candidates: PartyCandidate[];
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

/** 同じ取引先の行を束ねる。鍵はコード、無ければ名前。 */
export function groupRows(rows: BatchRow[]): Array<Pick<BatchGroup, "key" | "partyCode" | "partyName" | "rows" | "total">> {
  const order: string[] = [];
  const by = new Map<string, BatchRow[]>();
  for (const r of rows) {
    const key = r.partyCode ? `code:${r.partyCode.toLowerCase()}` : r.partyName ? `name:${r.partyName}` : `line:${r.line}`;
    if (!by.has(key)) { by.set(key, []); order.push(key); }
    by.get(key)!.push(r);
  }
  return order.map((key) => {
    const list = by.get(key)!;
    return { key, partyCode: list[0].partyCode, partyName: list[0].partyName, rows: list,
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
    templateKey: string; matterId: number; csv: string; choices?: Record<string, number>;
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
        const issues = [
          ...(resolution === "missing" ? ["取引先が未登録（コードも名前も当たらない）。この束は飛ばす"] : []),
          ...(resolution === "ambiguous" ? ["候補が複数。どれかを選ぶ"] : []),
          ...g.rows.flatMap((r) => r.issues.map((m) => `${r.line} 行目：${m}`))
        ];
        const condition = party
          ? await this.existingCondition(this.database, input.matterId, party.id)
          : null;
        const blocking = g.rows.some((r) => r.issues.length > 0);
        groups.push({
          ...g, resolution, party, candidates: resolved.candidates,
          condition: condition
            ? { mode: "existing", id: condition.id, conditionNo: condition.conditionNo }
            : { mode: "new", id: null, conditionNo: null },
          issues,
          action: resolution === "resolved" && !blocking ? "create"
            : resolution === "ambiguous" ? "choose" : "skip"
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
             choices?: Record<string, number> },
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
                : `${matterRow.title} ${g.party.name}`,
              direction: "in", kind: "service", counterpartyId: g.party.id,
              pricingModel: "fixed", flatAmount: g.total, currency: "JPY",
              termEnd: g.rows.map((r) => r.item.delivery_date as string | null).filter(Boolean).sort().pop() ?? null,
              paymentTerms: [...new Set(g.rows.map((r) => r.item.payment_date as string | null).filter(Boolean))].join("、") || null,
              notes: [...new Set(g.rows.map((r) => r.item.remarks as string | null).filter(Boolean))].join("\n") || null
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

  /** この案件に載っている、その取引先の 定額・委託料 の有効な条件。 */
  private async existingCondition(client: Queryable, matterId: number, partyId: number) {
    const r = await client.query(
      `SELECT c.id, c.condition_no FROM matter_links ml
         JOIN conditions c ON c.id::text = ml.target_ref
        WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
          AND c.counterparty_id = $2 AND c.status = 'active'
          AND c.kind = 'service' AND c.pricing_model = 'fixed'
        ORDER BY c.id DESC LIMIT 1`, [matterId, partyId]);
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
