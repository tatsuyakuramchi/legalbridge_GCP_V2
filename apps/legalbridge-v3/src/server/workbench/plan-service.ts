import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import type { ConditionSummary, TradeContext } from "../core/model.js";
import type { MatterRepository } from "../matters/repository.js";
import type { DocumentRepository, DocumentSummary } from "../documents/repository.js";
import type { AgreementService, AgreementRow } from "../agreements/service.js";
import type { IntakeRepository } from "../intake/repository.js";
import type { ConditionRepository } from "../conditions/repository.js";
import { isQuasiMandate } from "../conditions/time-settlement.js";
import { conditionMatches, inferPattern, MAIN_DOCS, MASTER_DOC, SERVICE_COMPLETION_DOC, SETTLEMENT_DOC, SET_DOMAIN, type WorkbenchPattern } from "./catalog.js";

/**
 * 作業テーブルの ①「要る文書と用意の仕方を決める」に出す材料。
 *
 * どこから入っても（デイリータスク・案件・相手先）、同じ形にそろえて返す：
 *   - 文脈（何の作業か、相手先、取引の型、戻る先）
 *   - 繋いである条件明細（本体の文書に載せるもの）
 *   - 要る文書の候補。候補ごとに、この相手先と既にある文書と、用意の仕方の既定
 *
 * 用意の仕方の既定：
 *   基本契約 … 生きている基本契約（契約の記録か決定済みの基本契約書）があれば「既にある文書を使う」、無ければ「ひな形で作る」
 *   本体     … 「ひな形で作る」。決定済みの同じ文書が既にあれば「既にある」に寄せる
 *   決済文書 … 「あとで」（実績が出てから。ここでは作らない）
 */

export type PrepareMode = "create" | "existing" | "external" | "later" | "skip";
export type CandidateRole = "master" | "main" | "settlement" | "revise";

export interface ExistingDoc {
  id: number; documentNo: string | null; title: string | null; templateLabel: string | null;
  status: string; phase: string; issuedAt: string | null; counterparty: string | null;
}

export interface WorkbenchCandidate {
  /** 画面の鍵。master / main / settlement。 */
  id: CandidateRole;
  role: CandidateRole;
  /** 既定のひな形と、選び直せるひな形。 */
  templateKey: string;
  options: Array<{ key: string; label: string }>;
  label: string;
  /** なぜ要るか・いつ要るか。 */
  why: string;
  needed: "now" | "later";
  suggested: PrepareMode;
  /** この相手先と既にある同じ種類の文書（決定済み・送信済み）。 */
  existing: ExistingDoc[];
  /** 基本契約の記録（文書が無くても契約として登録されているもの）。 */
  agreements: Array<{ id: number; agreementNo: string | null; title: string; status: string; live: boolean; currentEnd: string | null }>;
}

export interface WorkbenchContext {
  kind: "task" | "matter" | "party" | "round" | "conditions" | "document";
  /**
   * 文書の画面から来たとき（訂正版を作る・下敷きにして次を作る）。
   *   revise … この文書を退かせて入れ替える訂正版（理由が要る）
   *   derive … この文書を下敷きに次の文書（条件・案件・手入力を引き継ぐ。この文書は残る）
   */
  source?: { documentId: number; documentNo: string | null; title: string | null; templateKey: string | null;
             templateLabel: string | null; status: string; mode: "revise" | "derive";
             /** この版を直している下書きがもうあるなら、その下書き（訂正版を二重に作らせない）。 */
             pendingDraftId: number | null } | null;
  /** 取引管理の回から来たとき。決済文書に渡す実績と、戻る先。 */
  round?: { conditionId: number; conditionNo: string | null; conditionName: string;
            scheduleId: number | null; eventId: number | null; roundLabel: string | null } | null;
  requestId: number | null; requestNo: string | null; taskId: number | null;
  /** デイリータスクの目的（inspection / royalty / template / other）。①の既定に効く。 */
  purpose?: string | null;
  matterId: number | null; matterNo: string | null;
  title: string;
  partyId: number | null; partyName: string | null; partyKind: "corporate" | "individual" | null;
  pattern: WorkbenchPattern;
  /** 基本契約＋本体をまとめて作れる型なら、その domain。 */
  setDomain: "license" | "service" | null;
  workIds: number[];
  works: Array<{ id: number; title: string }>;
}

export interface WorkbenchPlan {
  ctx: WorkbenchContext;
  /** 本体の文書に載せる条件（型に合うもの）。 */
  conditions: ConditionSummary[];
  /** 型に合わない条件も見せる（繋ぎ忘れに気づけるように）。 */
  otherConditions: ConditionSummary[];
  candidates: WorkbenchCandidate[];
  /** この作業・案件に既に繋がっている文書。 */
  linkedDocuments: ExistingDoc[];
}

export interface PlanQuery {
  taskId?: number | null;
  requestId?: number | null;
  matterId?: number | null;
  partyId?: number | null;
  workIds?: number[];
  /** 取引管理の回から（決済文書を作る）。 */
  conditionId?: number | null;
  scheduleId?: number | null;
  eventId?: number | null;
  /** 条件明細・作品・契約・案件の「文書を作る」から（選んだ条件で）。 */
  conditionIds?: number[];
  /** 型を手で決めたとき（相手先だけから入って推せないとき）。 */
  pattern?: WorkbenchPattern | null;
  /** 文書の画面から（訂正版・下敷き）。 */
  documentId?: number | null;
  documentMode?: "revise" | "derive" | null;
}

const isLive = (a: AgreementRow, today: string) =>
  a.status === "executed" && !a.terminatedOn && (a.currentEnd === null || a.currentEnd >= today);

const toExisting = (d: DocumentSummary): ExistingDoc => ({
  id: d.id, documentNo: d.documentNo, title: d.title, templateLabel: d.templateLabel,
  status: d.status, phase: d.phase, issuedAt: d.issuedAt, counterparty: d.counterparty
});

export class WorkbenchPlanService {
  constructor(
    private readonly database: Queryable,
    private readonly deps: { matters: MatterRepository; conditions: ConditionRepository; documents: DocumentRepository;
                             agreements: AgreementService; intake: IntakeRepository }
  ) {}

  async plan(query: PlanQuery): Promise<WorkbenchPlan> {
    const today = new Date().toISOString().slice(0, 10);
    let ctx: WorkbenchContext;
    let conditions: ConditionSummary[] = [];
    let linked: ExistingDoc[] = [];

    if (query.documentId) {
      // 文書の画面から：訂正版を作る／下敷きにして次を作る。文書の条件・案件・相手先がそのまま文脈。
      const doc = await this.deps.documents.find(query.documentId);
      if (!doc) throw new DomainError("NOT_FOUND", `文書 ${query.documentId} が見つかりません`);
      const mode = query.documentMode === "derive" ? "derive" : "revise";
      if (mode === "revise" && doc.status !== "issued") throw new DomainError("VALIDATION", "訂正版を作れるのは決定済みの文書だけです");
      if (mode === "revise" && doc.imported) throw new DomainError("VALIDATION", "外で作った文書に訂正版は作れません（登録し直してください）");
      const ids = doc.conditions.map((c) => c.id);
      conditions = ids.length ? await this.conditionsById(ids) : [];
      const matterRow = doc.matterId ? await this.deps.matters.find(doc.matterId) : null;
      const partyRow = (await this.database.query(
        "SELECT counterparty_id FROM v_document_display WHERE document_id = $1", [doc.id])).rows[0] as { counterparty_id: unknown } | undefined;
      const partyId = conditions[0]?.counterparty?.id ?? (partyRow?.counterparty_id ? Number(partyRow.counterparty_id) : null);
      const party = partyId ? await this.party(partyId) : null;
      const pending = (await this.database.query(
        "SELECT id FROM documents WHERE supersedes_id = $1 AND status = 'draft' ORDER BY id DESC LIMIT 1", [doc.id])).rows[0] as { id: unknown } | undefined;
      const pattern = query.pattern ?? inferPattern(conditions, { kind: matterRow?.kind ?? null, businessLine: matterRow?.businessLine ?? null });
      ctx = {
        kind: "document", requestId: null, requestNo: null, taskId: null,
        matterId: matterRow?.id ?? null, matterNo: matterRow?.matterNo ?? null,
        title: `${mode === "revise" ? "訂正版" : "下敷きに次を作る"}：${doc.documentNo ?? `#${doc.id}`}${doc.title ? `　${doc.title}` : ""}`,
        partyId, partyName: party?.name ?? doc.counterparty ?? null, partyKind: party?.kind ?? null,
        pattern, setDomain: SET_DOMAIN[pattern],
        workIds: [...new Set(conditions.map((c) => c.work?.id).filter((x): x is number => Boolean(x)))],
        works: uniqWorks(conditions),
        source: { documentId: doc.id, documentNo: doc.documentNo, title: doc.title, templateKey: doc.templateKey,
                  templateLabel: doc.templateLabel, status: doc.status, mode, pendingDraftId: pending ? Number(pending.id) : null }
      };
      linked = [toExisting(doc)];
    } else if (query.conditionIds?.length) {
      // 条件を選んだ状態で来た（条件明細・作品・契約・案件の「文書を作る」）。
      conditions = await this.deps.conditions.findMany(query.conditionIds);
      if (!conditions.length) throw new DomainError("NOT_FOUND", "選んだ条件が見つかりません");
      const first = conditions[0];
      const matterRow = query.matterId
        ? await this.deps.matters.find(query.matterId)
        : null;
      const req = query.requestId ? (await this.deps.intake.find(query.requestId)).request : null;
      const pattern = query.pattern ?? inferPattern(conditions, { kind: matterRow?.kind ?? req?.kind ?? null, businessLine: matterRow?.businessLine ?? null });
      ctx = {
        kind: "conditions", requestId: req?.id ?? null, requestNo: req?.requestNo ?? null, taskId: null,
        matterId: matterRow?.id ?? null, matterNo: matterRow?.matterNo ?? null,
        title: matterRow?.title ?? (conditions.length === 1 ? first.name : `${first.name} ほか ${conditions.length - 1} 件`),
        partyId: first.counterparty?.id ?? null, partyName: first.counterparty?.name ?? null, partyKind: first.counterparty?.kind ?? null,
        pattern, setDomain: SET_DOMAIN[pattern],
        workIds: [...new Set(conditions.map((c) => c.work?.id).filter((x): x is number => Boolean(x)))],
        works: uniqWorks(conditions)
      };
      const linkedDocs = await this.database.query(
        `SELECT DISTINCT d.id FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
          WHERE dc.condition_id = ANY($1::bigint[]) AND d.status <> 'void' ORDER BY d.id DESC LIMIT 20`, [query.conditionIds]);
      linked = await this.documentsById((linkedDocs.rows as Array<{ id: unknown }>).map((x) => Number(x.id)));
    } else if (query.conditionId) {
      // 取引管理の回：条件 1 本。決済文書（検収書・計算書）を「要る・いま」で出し、
      // 前提（発注書・基本契約）が無ければ先に要るものとして上に並べる。
      const [cond] = await this.deps.conditions.findMany([query.conditionId]);
      if (!cond) throw new DomainError("NOT_FOUND", `条件 ${query.conditionId} が見つかりません`);
      conditions = [cond];
      const sched = query.scheduleId
        ? (await this.database.query("SELECT seq, label FROM condition_schedules WHERE id = $1", [query.scheduleId])).rows[0] as { seq: unknown; label: unknown } | undefined
        : undefined;
      const matterRow = (await this.database.query(
        `SELECT mm.id, mm.matter_no FROM matter_links ml JOIN matters mm ON mm.id = ml.matter_id
          WHERE ml.target_type = 'condition' AND ml.target_ref = $1::text ORDER BY mm.id DESC LIMIT 1`, [query.conditionId])).rows[0] as
        { id: unknown; matter_no: unknown } | undefined;
      const pattern = query.pattern ?? inferPattern(conditions);
      ctx = {
        kind: "round", requestId: null, requestNo: null, taskId: null,
        matterId: matterRow ? Number(matterRow.id) : null, matterNo: matterRow ? String(matterRow.matter_no ?? "") : null,
        title: cond.name,
        partyId: cond.counterparty?.id ?? null, partyName: cond.counterparty?.name ?? null, partyKind: cond.counterparty?.kind ?? null,
        pattern, setDomain: SET_DOMAIN[pattern],
        workIds: cond.work ? [cond.work.id] : [], works: cond.work ? [{ id: cond.work.id, title: cond.work.title }] : [],
        round: { conditionId: cond.id, conditionNo: cond.conditionNo, conditionName: cond.name,
                 scheduleId: query.scheduleId ?? null, eventId: query.eventId ?? null,
                 roundLabel: sched ? (sched.label ? String(sched.label) : `第 ${sched.seq} 回`) : null }
      };
      const linkedDocs = await this.database.query(
        `SELECT DISTINCT d.id FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
          WHERE dc.condition_id = $1 AND d.status <> 'void' ORDER BY d.id DESC LIMIT 20`, [query.conditionId]);
      linked = await this.documentsById((linkedDocs.rows as Array<{ id: unknown }>).map((x) => Number(x.id)));
    } else if (query.taskId || query.requestId) {
      const requestId = query.requestId ?? await this.requestIdOfTask(Number(query.taskId));
      const d = await this.deps.intake.find(requestId);
      const r = d.request;
      const ids = d.conditions.map((c) => c.id);
      conditions = ids.length ? await this.conditionsById(ids) : [];
      const partyId = r.counterpartyId ?? conditions[0]?.counterparty?.id ?? null;
      const party = partyId ? await this.party(partyId) : null;
      const linkedDocs = await this.database.query(
        `SELECT target_id FROM intake_request_links WHERE request_id = $1 AND target_type = 'document'`, [requestId]);
      linked = await this.documentsById((linkedDocs.rows as Array<{ target_id: unknown }>).map((x) => Number(x.target_id)));
      const pattern = query.pattern ?? inferPattern(conditions, { kind: r.kind });
      const taskRow = query.taskId
        ? (await this.database.query("SELECT purpose FROM tasks WHERE id = $1", [query.taskId])).rows[0] as { purpose: unknown } | undefined
        : undefined;
      ctx = {
        kind: "task", requestId, requestNo: r.requestNo, taskId: query.taskId ?? null,
        purpose: (taskRow?.purpose ?? r.purpose ?? null) as string | null,
        matterId: null, matterNo: null, title: r.title,
        partyId, partyName: party?.name ?? r.counterpartyName ?? null, partyKind: party?.kind ?? null,
        pattern, setDomain: SET_DOMAIN[pattern],
        workIds: [...new Set(conditions.map((c) => c.work?.id).filter((x): x is number => Boolean(x)))],
        works: uniqWorks(conditions)
      };
    } else if (query.matterId) {
      const m = await this.deps.matters.find(query.matterId);
      if (!m) throw new DomainError("NOT_FOUND", `案件 ${query.matterId} が見つかりません`);
      conditions = m.conditions;
      linked = m.documents.map((d) => ({
        id: d.id, documentNo: d.documentNo, title: null, templateLabel: d.templateLabel,
        status: d.status, phase: d.status, issuedAt: d.issuedAt, counterparty: d.counterparty
      }));
      const pattern = query.pattern ?? inferPattern(conditions, { kind: m.kind, businessLine: m.businessLine });
      ctx = {
        kind: "matter", requestId: null, requestNo: null, taskId: null,
        matterId: m.id, matterNo: m.matterNo, title: m.title,
        partyId: m.counterparty?.id ?? null, partyName: m.counterparty?.name ?? null, partyKind: m.counterparty?.kind ?? null,
        pattern, setDomain: SET_DOMAIN[pattern],
        workIds: m.works.map((w) => w.id), works: m.works.map((w) => ({ id: w.id, title: w.title }))
      };
    } else if (query.partyId) {
      const t: TradeContext | null = await this.deps.matters.tradeContext({ partyId: query.partyId, workIds: query.workIds ?? [] });
      if (!t) throw new DomainError("NOT_FOUND", `取引先 ${query.partyId} が見つかりません`);
      conditions = t.conditions;
      const pattern = query.pattern ?? inferPattern(conditions);
      ctx = {
        kind: "party", requestId: null, requestNo: null, taskId: null, matterId: null, matterNo: null,
        title: t.title,
        partyId: t.counterparty?.id ?? query.partyId, partyName: t.counterparty?.name ?? null, partyKind: t.counterparty?.kind ?? null,
        pattern, setDomain: SET_DOMAIN[pattern],
        workIds: t.works.map((w) => w.id), works: t.works.map((w) => ({ id: w.id, title: w.title }))
      };
    } else {
      throw new DomainError("VALIDATION", "作業・案件・相手先のどれかを指定してください");
    }

    const mine = conditions.filter((c) => conditionMatches(ctx.pattern, c));
    const others = conditions.filter((c) => !mine.includes(c));
    const candidates = this.fromTask(ctx, this.fromDocument(ctx, await this.candidates(ctx, today, mine.map((c) => c.id))));
    return { ctx, conditions: mine, otherConditions: others, candidates, linkedDocuments: linked };
  }

  private async candidates(ctx: WorkbenchContext, today: string, conditionIds: number[] = []): Promise<WorkbenchCandidate[]> {
    const p = ctx.pattern;
    const partyDocs = ctx.partyId
      ? (await this.deps.documents.list({ partyId: ctx.partyId, limit: 300 })).filter((d) => d.status === "issued")
      : [];
    const byKeys = (keys: string[]) => partyDocs.filter((d) => d.templateKey && keys.includes(d.templateKey)).map(toExisting);
    const out: WorkbenchCandidate[] = [];

    const master = MASTER_DOC[p];
    if (master) {
      const rows = ctx.partyId ? await this.deps.agreements.list({ partyId: ctx.partyId }) : [];
      const domain = SET_DOMAIN[p];
      const masters = rows
        .filter((a) => (a.kind === "master" || a.kind === "standalone") && a.status !== "terminated"
                       && (!domain || !a.domain || a.domain === domain))
        .map((a) => ({ id: a.id, agreementNo: a.agreementNo, title: a.title, status: a.status, live: isLive(a, today), currentEnd: a.currentEnd }));
      const existing = byKeys([master.key]);
      const hasLive = masters.some((a) => a.live) || existing.length > 0;
      out.push({
        id: "master", role: "master", templateKey: master.key, options: [master], label: master.label,
        why: hasLive ? "この相手先と結んだものがある" : "この相手先とはまだ結んでいない。本体の文書より先に作る",
        needed: "now", suggested: hasLive ? "existing" : "create", existing, agreements: masters
      });
    }

    const mains = MAIN_DOCS[p];
    // 回から来たとき：本体の文書（発注書・条件書）がこの条件に既にあるかを見る。
    const roundMain = ctx.round
      ? partyDocs.filter((d) => d.templateKey && mains.some((m) => m.key === d.templateKey)
                               && d.conditions.some((c) => c.id === ctx.round!.conditionId)).map(toExisting)
      : [];
    if (mains.length) {
      const existing = ctx.round ? roundMain : byKeys(mains.map((m) => m.key));
      const label = p === "service" ? "発注書" : isLicenseTerms(p) ? "条件書" : mains[0].label;
      out.push({
        id: "main", role: "main", templateKey: mains[0].key, options: mains, label,
        why: ctx.round
          ? (existing.length ? "この条件の分は決定済み" : `無い。${SETTLEMENT_DOC[p]?.label ?? "決済文書"}より先に要る`)
          : p === "service" ? "条件明細から明細を作る" : "条件明細から取引形態・料率を載せる",
        needed: "now", suggested: ctx.round ? (existing.length ? "existing" : "create") : "create", existing, agreements: []
      });
    }

    let settlement = SETTLEMENT_DOC[p];
    let settlementOptions = settlement ? [settlement] : [];
    if (p === "service" && settlement) {
      // 準委任の時間精算（A-073）の条件が載っていれば、決済文書は検収書ではなく役務提供完了通知書。
      // どちらも選べるようにし、既定を条件から決める。回から来たときはその条件だけを見る。
      const ids = ctx.round ? [ctx.round.conditionId] : conditionIds;
      // 準委任（契約形式）も同じ（仕事の完成が無いので検収ではなく役務の完了を通知する）。
      const timeSettled = ids.length
        ? ((await this.database.query(
            "SELECT time_settlement, contract_form FROM conditions WHERE id = ANY($1::bigint[])", [ids])).rows as Array<{ time_settlement?: boolean; contract_form?: string | null }>)
            .some((r) => r.time_settlement === true || isQuasiMandate(r.contract_form))
        : false;
      settlementOptions = timeSettled ? [SERVICE_COMPLETION_DOC, settlement] : [settlement, SERVICE_COMPLETION_DOC];
      if (timeSettled) settlement = SERVICE_COMPLETION_DOC;
    }
    if (settlement) {
      const now = Boolean(ctx.round);
      out.push({
        id: "settlement", role: "settlement", templateKey: settlement.key, options: settlementOptions, label: settlement.label,
        why: now ? (ctx.round?.roundLabel ? `この回（${ctx.round.roundLabel}）の決済文書。実績から作る` : "この回の決済文書。実績から作る")
          : p === "service" ? "納品のあとに作る（実績から）" : "締めごとに作る（実績から）",
        needed: now ? "now" : "later", suggested: now ? "create" : "later", existing: [], agreements: []
      });
    }
    return out;
  }

  /**
   * デイリータスクから来たときの既定。目的（purpose）で、何を「いま作る」かを決める。
   *   inspection / royalty … 決済文書（検収書・計算書）を「作る・いま」。本体・基本契約は既にあるものを使う
   *                          （無ければ「今回は用意しない」ではなく「作る」で先に要ると出す）
   *   other               … 相手方の文書や社内で起こした文書。本体は「外の文書を登録」
   *   template            … そのまま（本体をひな形で作る）
   */
  private fromTask(ctx: WorkbenchContext, base: WorkbenchCandidate[]): WorkbenchCandidate[] {
    if (ctx.kind !== "task" || !ctx.purpose) return base;
    const p = ctx.purpose;
    if (p === "inspection" || p === "royalty") {
      return base.map((c) => {
        if (c.role === "settlement") return { ...c, needed: "now" as const, suggested: "create" as PrepareMode, why: `この作業の目的（${p === "inspection" ? "検収書" : "計算書"}）。実績から作る` };
        if (c.role === "main") return { ...c, suggested: c.existing.length ? "existing" as PrepareMode : "create" as PrepareMode,
                                        why: c.existing.length ? "既にある（決済文書はこれに基づく）" : `無い。${p === "inspection" ? "検収書" : "計算書"}より先に要る` };
        if (c.role === "master") return { ...c, suggested: c.existing.length || c.agreements.some((a) => a.live) ? "existing" as PrepareMode : "skip" as PrepareMode };
        return c;
      });
    }
    if (p === "other") {
      return base.map((c) => (c.role === "main" ? { ...c, suggested: "external" as PrepareMode, why: "相手方の文書や社内で起こした文書を登録して番号を振る（ひな形で作るなら切り替える）" } : c));
    }
    return base;
  }

  /**
   * 文書の画面から来たときの候補。
   *   訂正版 … 先頭に「この文書の訂正版」（ひな形は元の文書のもの。作る）。ほかの候補は今回は用意しない
   *   下敷き … 元の文書と同じ種類は「既にある」（元の文書）、決済文書は「作る・いま」（下敷きから作る）。
   *            基本契約は従来どおり（結んであれば既にある）
   */
  private fromDocument(ctx: WorkbenchContext, base: WorkbenchCandidate[]): WorkbenchCandidate[] {
    const src = ctx.source;
    if (!src) return base;
    const tplLabel = src.templateLabel ?? src.templateKey ?? "文書";
    if (src.mode === "revise") {
      const revise: WorkbenchCandidate = {
        id: "revise", role: "revise", templateKey: src.templateKey ?? "", options: [{ key: src.templateKey ?? "", label: tplLabel }],
        label: `${tplLabel} の訂正版`,
        why: src.pendingDraftId
          ? "この版を直している下書きがもうある（二重には作らない。下書きを開いて続ける）"
          : "条件・実績・手入力を引き継いだ下書きを作り、決定した瞬間にこの版と入れ替わる。理由が要る",
        needed: "now", suggested: src.pendingDraftId ? "skip" : "create",
        existing: src.pendingDraftId ? [{ id: src.pendingDraftId, documentNo: null, title: "訂正版の下書き", templateLabel: tplLabel,
                                          status: "draft", phase: "draft", issuedAt: null, counterparty: ctx.partyName }] : [],
        agreements: []
      };
      return [revise, ...base.map((c) => ({ ...c, suggested: "skip" as PrepareMode, why: `${c.why}（訂正版と一緒に要るときだけ）` }))];
    }
    // derive
    const source: ExistingDoc = { id: src.documentId, documentNo: src.documentNo, title: src.title, templateLabel: src.templateLabel,
                                  status: src.status, phase: src.status === "issued" ? "decided" : src.status, issuedAt: null, counterparty: ctx.partyName };
    return base.map((c) => {
      const same = src.templateKey !== null && c.options.some((o) => o.key === src.templateKey);
      if (same) {
        return { ...c, existing: [source, ...c.existing.filter((d) => d.id !== source.id)], suggested: "existing" as PrepareMode,
                 why: "下敷きにする文書そのもの（もう 1 枚同じ種類を作るなら「ひな形で作る」。下敷きから作る）" };
      }
      if (c.role === "settlement") {
        return { ...c, needed: "now" as const, suggested: "create" as PrepareMode, why: `${src.documentNo ?? "この文書"} を下敷きに作る（条件・案件・手入力を引き継ぐ）` };
      }
      return c;
    });
  }

  private async requestIdOfTask(taskId: number): Promise<number> {
    const r = await this.database.query("SELECT request_id FROM tasks WHERE id = $1", [taskId]);
    const row = r.rows[0] as { request_id: unknown } | undefined;
    if (!row?.request_id) throw new DomainError("NOT_FOUND", `作業 ${taskId} が見つかりません（依頼に繋がっていません）`);
    return Number(row.request_id);
  }

  private async party(id: number): Promise<{ id: number; name: string; kind: "corporate" | "individual" } | null> {
    const r = await this.database.query("SELECT id, name, kind FROM parties WHERE id = $1", [id]);
    const row = r.rows[0] as { id: unknown; name: unknown; kind: unknown } | undefined;
    return row ? { id: Number(row.id), name: String(row.name ?? ""), kind: row.kind === "individual" ? "individual" : "corporate" } : null;
  }

  private async conditionsById(ids: number[]): Promise<ConditionSummary[]> {
    return this.deps.conditions.findMany(ids);
  }

  private async documentsById(ids: number[]): Promise<ExistingDoc[]> {
    if (!ids.length) return [];
    const out: ExistingDoc[] = [];
    for (const id of ids) {
      const d = await this.deps.documents.find(id).catch(() => null);
      if (d) out.push(toExisting(d));
    }
    return out;
  }
}

const isLicenseTerms = (p: WorkbenchPattern) => p === "game_in" || p === "game_out" || p === "pub_in" || p === "pub_out";

function uniqWorks(conditions: ConditionSummary[]): Array<{ id: number; title: string }> {
  const seen = new Map<number, string>();
  for (const c of conditions) if (c.work && !seen.has(c.work.id)) seen.set(c.work.id, c.work.title);
  return [...seen].map(([id, title]) => ({ id, title }));
}

