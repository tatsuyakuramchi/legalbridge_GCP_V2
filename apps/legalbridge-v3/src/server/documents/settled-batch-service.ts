import { inTransaction, str, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionWriteService } from "../conditions/write-service.js";
import { ConditionScheduleService } from "../conditions/schedule-service.js";
import { ConditionEventService } from "../conditions/event-service.js";
import { MatterLinkService } from "../matters/link-service.js";
import { PaymentService } from "../payments/service.js";
import { DocumentIssueService } from "./issue-service.js";
import {
  DocumentBatchService, type AgreementRef, type PartyCandidate,
  type WorkCandidate, type WorkResolution
} from "./batch-service.js";
import {
  conflictsOf, groupRows, ownershipOfRows, readRows, sameAcross, scheduleLinesFrom,
  type SettledGroupRows, type SettledPaymentState, type SettledRow
} from "./settled-batch.js";

/**
 * 決済済みの一括取込（遡及）。当て込みと実行。
 *
 * 1束から 条件 → 予定明細 → 発注書（決定）→ 実績 → 検収書（決定）→ 支払
 * までを作る。紙の日付は過去なので、発注書・検収書の決定日は CSV の日付で
 * 焼く。
 *
 * 発注書の一括作成と違って、ここは**番号を振ってしまう**。下書きで止めて
 * 人が確かめる余地が無いので、試算（preview）を必ず先に通す。試算では
 * 何も作らず、どの番号を使うことになるかまで見せる。
 *
 * 名寄せ（取引先・作品・基本契約・既存の条件）は発注書の一括作成の規則を
 * そのまま借りる。規則が2つに分かれると、同じ CSV が経路によって別の
 * 相手に当たる。
 */

export const ORDER_TEMPLATE = "purchase_order";
export const INSPECTION_TEMPLATE = "inspection_certificate";
/** 束の記録に残す種別。発注書の一括作成（purchase_order）と区別する。 */
export const SETTLED_BATCH_KEY = "settled_import";

export interface SettledGroup extends SettledGroupRows {
  resolution: "resolved" | "ambiguous" | "missing";
  party: PartyCandidate | null;
  candidates: PartyCandidate[];
  workResolution: WorkResolution;
  work: WorkCandidate | null;
  workCandidates: WorkCandidate[];
  condition: {
    mode: "existing" | "new";
    id: number | null;
    conditionNo: string | null;
    agreement: AgreementRef | null;
    agreementNote: string | null;
    schedules: number;
  };
  /** 束の日付と支払。束で1つに決まる値なので、ここに畳んで見せる。 */
  orderedOn: string | null;
  inspectedOn: string | null;
  dueOn: string | null;
  paymentState: SettledPaymentState;
  paidOn: string | null;
  /** 特約。定型文の名前を書いていれば、その本文に解決したもの。 */
  specialTerms: string | null;
  specialTermsNote: string | null;
  issues: string[];
  action: "create" | "choose" | "skip";
}

export interface SettledNumberPeek {
  templateKey: string;
  prefix: string;
  year: number;
  /** この取り込みで使うことになる番号（見込み）。 */
  from: string;
  to: string;
  count: number;
}

export interface SettledPreview {
  groups: SettledGroup[];
  /** 使うことになる採番。確定ではない（間に誰かが1枚出せばずれる）。 */
  numbers: SettledNumberPeek[];
  summary: {
    rows: number; groups: number; creatable: number; skipped: number; choose: number;
    /** 作られる実績の数と、支払の合計。 */
    events: number; payments: number; paymentTotal: number;
  };
}

export interface SettledResultEntry {
  key: string;
  partyName: string | null;
  status: "created" | "skipped" | "failed";
  reason?: string;
  partyId?: number;
  conditionId?: number | null;
  conditionNo?: string | null;
  orderDocumentId?: number;
  orderDocumentNo?: string | null;
  inspectionDocumentId?: number;
  inspectionDocumentNo?: string | null;
  eventIds?: number[];
  paymentId?: number;
  paymentNo?: string | null;
  paymentState?: SettledPaymentState;
  /** どこまで進んで落ちたか。途中で落ちた束の後始末に要る。 */
  stage?: string;
}

export interface SettledBatchRecord {
  id: number;
  matterId: number | null;
  sourceFilename: string | null;
  rowCount: number;
  createdBy: string | null;
  createdAt: string;
  result: SettledResultEntry[];
}

export class SettledBatchService {
  private readonly conditions: ConditionWriteService;
  private readonly schedules: ConditionScheduleService;
  private readonly matters: MatterLinkService;

  constructor(
    private readonly database: Transactable,
    private readonly issues: DocumentIssueService,
    private readonly events: ConditionEventService,
    private readonly payments: PaymentService,
    private readonly batch: DocumentBatchService
  ) {
    this.conditions = new ConditionWriteService(database);
    this.schedules = new ConditionScheduleService(database);
    this.matters = new MatterLinkService(database);
  }

  /** 突き合わせ。何も作らない。 */
  async preview(input: {
    matterId: number; csv: string;
    choices?: Record<string, number>; workChoices?: Record<string, number>;
  }): Promise<SettledPreview> {
    const rows = readRows(input.csv);
    try {
      const matter = await this.database.query(
        "SELECT id FROM matters WHERE id = $1", [input.matterId]);
      if (!matter.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${input.matterId} が見つかりません`);

      const groups: SettledGroup[] = [];
      for (const g of groupRows(rows)) {
        const resolved = await this.batch.resolveParty(this.database, g.partyCode, g.partyName);
        const chosen = input.choices?.[g.key];
        let party = resolved.party;
        let resolution = resolved.resolution;
        if (resolution === "ambiguous" && chosen && resolved.candidates.some((c) => c.id === chosen)) {
          party = resolved.candidates.find((c) => c.id === chosen)!;
          resolution = "resolved";
        }
        const foundWork = await this.batch.resolveWork(this.database, g.workCode, g.workTitle);
        const pickedWork = input.workChoices?.[g.key];
        let work = foundWork.work;
        let workResolution = foundWork.resolution;
        if (workResolution === "ambiguous" && pickedWork
            && foundWork.candidates.some((c) => c.id === pickedWork)) {
          work = foundWork.candidates.find((c) => c.id === pickedWork)!;
          workResolution = "resolved";
        }

        const mixed = conflictsOf(g.rows);
        const stuck = resolution === "missing" || workResolution === "missing";
        const choosing = resolution === "ambiguous" || workResolution === "ambiguous";

        const condition = party && (workResolution === "none" || workResolution === "resolved")
          ? await this.batch.existingCondition(this.database, input.matterId, party.id,
                                               work?.id ?? null, g.conditionName)
          : null;
        const basic = party && !condition && !stuck && !choosing
          ? await this.batch.basicAgreement(this.database, input.matterId, party.id,
                                            sameAcross(g.rows, (r) => r.agreementNo))
          : { agreement: null, note: null as string | null, missing: false };
        const badAgreement = Boolean((basic as { missing?: boolean }).missing);

        const terms = await this.resolveSpecialTerms(g.rows);

        const issues = [
          ...(resolution === "missing" ? ["取引先が未登録（コードも名前も当たらない）。この束は飛ばす"] : []),
          ...(resolution === "ambiguous" ? ["候補が複数。どれかを選ぶ"] : []),
          ...(workResolution === "missing"
            ? [`作品が見つからない（${[g.workCode, g.workTitle].filter(Boolean).join(" / ")}）。この束は飛ばす`] : []),
          ...(workResolution === "ambiguous" ? ["作品の候補が複数。どれかを選ぶ"] : []),
          ...mixed,
          ...(badAgreement && basic.note ? [`${basic.note}。この束は飛ばす`] : []),
          ...(terms.note && terms.missing ? [`${terms.note}。この束は飛ばす`] : []),
          ...g.rows.flatMap((r) => r.issues.map((m) => `${r.line} 行目：${m}`))
        ];
        const blocking = g.rows.some((r) => r.issues.length > 0)
          || mixed.length > 0 || badAgreement || terms.missing;

        groups.push({
          ...g, resolution, party, candidates: resolved.candidates,
          workResolution, work, workCandidates: foundWork.candidates,
          condition: condition
            ? { mode: "existing", id: condition.id, conditionNo: condition.conditionNo,
                agreement: null, agreementNote: null, schedules: 0 }
            : { mode: "new", id: null, conditionNo: null,
                agreement: basic.agreement, agreementNote: basic.note,
                schedules: scheduleLinesFrom(g.rows).length },
          orderedOn: sameAcross(g.rows, (r) => r.orderedOn),
          inspectedOn: sameAcross(g.rows, (r) => r.inspectedOn),
          dueOn: sameAcross(g.rows, (r) => r.dueOn),
          paymentState: sameAcross(g.rows, (r) => r.paymentState) ?? "planned",
          paidOn: sameAcross(g.rows, (r) => r.paidOn),
          specialTerms: terms.text, specialTermsNote: terms.note,
          issues,
          action: stuck ? "skip" : choosing ? "choose" : blocking ? "skip" : "create"
        });
      }

      const creatable = groups.filter((g) => g.action === "create");
      return {
        groups,
        numbers: await this.peekNumbers(creatable),
        summary: {
          rows: rows.length, groups: groups.length,
          creatable: creatable.length,
          skipped: groups.filter((g) => g.action === "skip").length,
          choose: groups.filter((g) => g.action === "choose").length,
          events: creatable.reduce((sum, g) => sum + g.rows.length, 0),
          payments: creatable.length,
          paymentTotal: creatable.reduce((sum, g) => sum + g.inspectedTotal, 0)
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * どの番号を使うことになるかを、採番を進めずに覗く。
   *
   * 確定ではない。試算と取り込みの間に誰かが1枚出せばずれる。それでも
   * 「決定まで一気」で流す前に、消費する番号の見当が付くかどうかは大きい。
   */
  private async peekNumbers(groups: SettledGroup[]): Promise<SettledNumberPeek[]> {
    if (!groups.length) return [];
    const out: SettledNumberPeek[] = [];
    for (const [templateKey, dateOf] of [
      [ORDER_TEMPLATE, (g: SettledGroup) => g.orderedOn],
      [INSPECTION_TEMPLATE, (g: SettledGroup) => g.inspectedOn]
    ] as Array<[string, (g: SettledGroup) => string | null]>) {
      const prefixRow = await this.database.query(
        `SELECT t.number_prefix FROM document_templates t WHERE t.template_key = $1`, [templateKey]);
      const prefix = String((prefixRow.rows[0] as { number_prefix?: string } | undefined)?.number_prefix ?? "")
        .trim().toUpperCase().replace(/^ARC-/, "");
      if (!prefix) continue;
      // 年ごとに数える。去年の紙と今年の紙が混ざった CSV は連番も分かれる。
      const byYear = new Map<number, number>();
      for (const g of groups) {
        const on = dateOf(g);
        const year = on ? Number(on.slice(0, 4)) : new Date().getFullYear();
        byYear.set(year, (byYear.get(year) ?? 0) + 1);
      }
      for (const [year, count] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
        const seq = await this.database.query(
          `SELECT current_value FROM document_sequences WHERE prefix = $1 AND year = $2`,
          [prefix, year]);
        const current = Number((seq.rows[0] as { current_value?: number } | undefined)?.current_value ?? 0);
        const fmt = (n: number) => `ARC-${prefix}-${year}-${String(n).padStart(4, "0")}`;
        out.push({ templateKey, prefix, year, count,
                   from: fmt(current + 1), to: fmt(current + count) });
      }
    }
    return out;
  }

  /**
   * 特約。定型文の名前で書けるようにする。
   *
   * 全行に同じ長文を貼らせると、1文字違いの特約が量産される。名前で呼んで
   * もらえば、文面の出どころは1つに残る。名前が当たらない束は作らない
   * （黙って特約なしで出すと、紙から条項が消える）。
   */
  private async resolveSpecialTerms(rows: SettledRow[]):
    Promise<{ text: string | null; note: string | null; missing: boolean }> {
    const title = sameAcross(rows, (r) => r.specialTermsSnippet);
    const own = sameAcross(rows, (r) => r.specialTerms);
    if (!title) return { text: own, note: null, missing: false };
    const found = await this.database.query(
      `SELECT title, body FROM text_snippets
        WHERE is_active AND category = 'special_terms' AND btrim(title) = btrim($1)
        LIMIT 5`, [title]);
    if (!found.rows.length) {
      return { text: own, missing: true, note: `特約の定型文「${title}」が見つかりません` };
    }
    if (found.rows.length > 1) {
      return { text: own, missing: true, note: `特約の定型文「${title}」が複数あります` };
    }
    const body = String((found.rows[0] as { body: string }).body ?? "").trim();
    // 両方書いてあれば、定型文のあとに続ける。個別の但し書きを足す使い方。
    return { text: [body, own].filter(Boolean).join("\n") || null, note: null, missing: false };
  }

  /**
   * 作る。束ごとに 条件 → 予定 → 発注書 → 実績 → 検収書 → 支払。
   *
   * 1束で失敗しても止めない。どこまで進んで落ちたかを結果に残す。番号を
   * 振ったあとで落ちた束は、その紙が台帳に残るので、後始末の手掛かりが
   * 無いと探せない。
   */
  async create(
    input: { matterId: number; csv: string; filename?: string | null;
             choices?: Record<string, number>; workChoices?: Record<string, number> },
    actor: string
  ): Promise<SettledBatchRecord> {
    const preview = await this.preview(input);
    try {
      const batchId = await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `INSERT INTO document_batches (template_key, matter_id, source_filename, row_count, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [SETTLED_BATCH_KEY, input.matterId, str(input.filename), preview.summary.rows, actor]);
        return Number((r.rows[0] as { id: number }).id);
      });

      const result: SettledResultEntry[] = [];
      for (const g of preview.groups) {
        if (g.action !== "create" || !g.party) {
          result.push({ key: g.key, partyName: g.party?.name ?? g.partyName, status: "skipped",
                        reason: g.issues[0] ?? "候補が決まっていない" });
          continue;
        }
        let stage = "条件";
        try {
          const made = await this.runGroup(g, input.matterId, batchId, actor, (s) => { stage = s; });
          result.push({ key: g.key, partyName: g.party.name, status: "created",
                        partyId: g.party.id, ...made });
        } catch (error) {
          result.push({ key: g.key, partyName: g.party.name, status: "failed", stage,
                        reason: (error as Error)?.message ?? String(error) });
        }
      }

      await inTransaction(this.database, async (client) => {
        await client.query("UPDATE document_batches SET result = $2::jsonb WHERE id = $1",
          [batchId, JSON.stringify(result)]);
        await recordAudit(client, {
          actor, action: "document.settled_batch", targetType: "document_batch", targetId: batchId,
          detail: { matterId: input.matterId, filename: input.filename ?? null,
                    created: result.filter((r) => r.status === "created").length,
                    skipped: result.filter((r) => r.status === "skipped").length,
                    failed: result.filter((r) => r.status === "failed").length,
                    backdated: true }
        });
      });
      return (await this.find(batchId))!;
    } catch (error) { throw translate(error); }
  }

  /** 1束ぶん。落ちたところが分かるよう、進むたびに stage を置く。 */
  private async runGroup(
    g: SettledGroup, matterId: number, batchId: number, actor: string,
    mark: (stage: string) => void
  ): Promise<Partial<SettledResultEntry>> {
    const party = g.party!;
    mark("条件");
    let conditionId = g.condition.id;
    let conditionNo = g.condition.conditionNo;
    if (!conditionId) {
      const created = await this.conditions.create({
        matterId,
        name: g.conditionName
          ?? (g.rows.length === 1
            ? String(g.rows[0].item.item_name)
            : `${g.work?.title ?? party.name} ${party.name}`),
        direction: "in", kind: "service", counterpartyId: party.id,
        workId: g.work?.id ?? null,
        pricingModel: "fixed", flatAmount: g.orderedTotal, currency: "JPY",
        termEnd: g.inspectedOn,
        paymentTerms: sameAcross(g.rows, (r) => r.paymentTerms),
        contractForm: sameAcross(g.rows, (r) => (r.item.payment_terms as string | null) ?? null),
        notes: [...new Set(g.rows.map((r) => r.item.remarks as string | null).filter(Boolean))].join("\n") || null,
        spec: g.rows.map((r) => r.item.spec
          ? (g.rows.length > 1 ? `${r.item.item_name}：${r.item.spec}` : String(r.item.spec)) : "")
          .filter(Boolean).join("\n") || null,
        deliverableOwnership: ownershipOfRows(g.rows),
        agreementId: g.condition.agreement?.id ?? null
      }, actor);
      conditionId = created.id; conditionNo = created.conditionNo;
      const lines = scheduleLinesFrom(g.rows);
      if (lines.length) await this.schedules.replace(conditionId, lines, actor);
    } else {
      await this.matters.attachCondition(matterId, conditionId, actor);
    }

    // 発注書。決定日は発注日で焼く。
    mark("発注書");
    const orderManual: Record<string, unknown> = {
      items: g.rows.map((r) => r.item), _batchId: batchId,
      ...this.toggles(g),
      ...(g.specialTerms ? { SPECIAL_TERMS: g.specialTerms } : {})
    };
    const orderDraft = await this.issues.createDraft({
      templateKey: ORDER_TEMPLATE, conditionIds: [conditionId], matterId,
      manualInputs: orderManual
    }, actor);
    const order = await this.issues.issue(orderDraft.id, actor, { issuedOn: g.orderedOn });
    await this.database.query(
      "UPDATE documents SET batch_id = $2 WHERE id = $1", [orderDraft.id, batchId]);

    // 実績。1行が1件。予定の回に繋げないと、検収書の支払日が空で出る。
    mark("実績");
    const schedules = await this.database.query(
      `SELECT id FROM condition_schedules WHERE condition_id = $1 ORDER BY seq, id`, [conditionId]);
    const scheduleIds = (schedules.rows as Array<{ id: number }>).map((r) => Number(r.id));
    const eventIds: number[] = [];
    for (const [index, row] of g.rows.entries()) {
      const added = await this.events.add(conditionId, {
        eventType: "inspection",
        occurredOn: row.deliveredOn!,
        inspectedOn: row.inspectedOn,
        // 数量を渡さないと、検収書の「検収数量」が空になり、単価も
        // 金額から割り戻したものになる。
        quantity: row.inspectedQuantity,
        amount: row.inspectedAmount,
        // 検収書の品目欄になる。仕様を入れると「挿絵」が「モノクロ12点」に
        // 化け、変更履歴も「モノクロ12点 支払対価」と読みにくくなる。
        deliverable: String(row.item.item_name ?? "") || null,
        contractForm: (row.item.payment_terms as string | null) ?? null,
        // 減額・増額の理由。検収書の変更履歴にそのまま出る。
        varianceNote: row.varianceNote,
        scheduleId: scheduleIds[index] ?? null,
        workId: g.work?.id ?? null,
        note: row.item.remarks as string | null
      }, actor);
      eventIds.push(added.id);
    }

    // 検収書。決定日は検収日。実績を結んでから支払を立てる。
    mark("検収書");
    const inspectionDraft = await this.issues.createDraft({
      templateKey: INSPECTION_TEMPLATE, conditionIds: [conditionId], matterId,
      manualInputs: { _batchId: batchId, ...(g.specialTerms ? { SPECIAL_TERMS: g.specialTerms } : {}) }
    }, actor);
    const inspection = await this.issues.issue(inspectionDraft.id, actor,
      { issuedOn: g.inspectedOn, eventIds });
    await this.database.query(
      "UPDATE documents SET batch_id = $2 WHERE id = $1", [inspectionDraft.id, batchId]);
    await this.events.linkDocument(conditionId, eventIds, inspection.id, actor);

    // 支払。額も源泉も検収書の実績から出す（画面から立てるのと同じ経路）。
    mark("支払");
    const payment = await this.payments.createFromInspection(inspection.id, actor,
      { dueOn: g.dueOn });
    if (g.paymentState === "paid" && g.paidOn) {
      mark("入金の記録");
      await this.payments.markPaid(payment.paymentId, g.paidOn, actor);
    }

    return {
      conditionId, conditionNo,
      orderDocumentId: orderDraft.id, orderDocumentNo: order.documentNo,
      inspectionDocumentId: inspectionDraft.id, inspectionDocumentNo: inspection.documentNo,
      eventIds,
      paymentId: payment.paymentId, paymentNo: payment.paymentNo,
      paymentState: g.paymentState
    };
  }

  /** 書類ごとの切り替え。手入力として渡すので、あとから画面で直せる。 */
  private toggles(g: SettledGroup): Record<string, unknown> {
    const orderSign = sameAcross(g.rows, (r) => r.orderSign);
    const acceptSign = sameAcross(g.rows, (r) => r.acceptSign);
    const declaredNone = g.rows.some((r) => /^(なし|無|none|-)$/i.test(String(r.agreementNo ?? "").trim()));
    return {
      ...(orderSign === null ? {} : { SHOW_ORDER_SIGN_SECTION: orderSign }),
      ...(acceptSign === null ? {} : { SHOW_SIGN_SECTION: acceptSign }),
      ...(declaredNone ? { HAS_BASE_CONTRACT: false } : {})
    };
  }

  async find(id: number): Promise<SettledBatchRecord | null> {
    const r = await this.database.query(
      `SELECT id, matter_id, source_filename, row_count, created_by, created_at, result
         FROM document_batches WHERE id = $1 AND template_key = $2`, [id, SETTLED_BATCH_KEY]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id), matterId: row.matter_id === null ? null : Number(row.matter_id),
      sourceFilename: str(row.source_filename), rowCount: Number(row.row_count ?? 0),
      createdBy: str(row.created_by),
      createdAt: new Date(String(row.created_at)).toISOString(),
      result: (row.result as SettledResultEntry[]) ?? []
    };
  }

  async list(matterId: number | null, limit = 30) {
    const r = await this.database.query(
      `SELECT id, matter_id, source_filename, row_count, created_by, created_at, result
         FROM document_batches
        WHERE template_key = $1 AND ($2::bigint IS NULL OR matter_id = $2)
        ORDER BY id DESC LIMIT $3`, [SETTLED_BATCH_KEY, matterId, limit]);
    return (r.rows as Array<Record<string, any>>).map((row) => {
      const result = (row.result as SettledResultEntry[]) ?? [];
      return {
        id: Number(row.id), matterId: row.matter_id === null ? null : Number(row.matter_id),
        sourceFilename: str(row.source_filename), rowCount: Number(row.row_count ?? 0),
        createdBy: str(row.created_by),
        createdAt: new Date(String(row.created_at)).toISOString(),
        created: result.filter((x) => x.status === "created").length,
        skipped: result.filter((x) => x.status === "skipped").length,
        failed: result.filter((x) => x.status === "failed").length
      };
    });
  }
}
