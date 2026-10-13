import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import type { ConditionSummary, TradeContext } from "../core/model.js";
import type { MatterRepository } from "../matters/repository.js";
import type { DocumentRepository, DocumentSummary } from "../documents/repository.js";
import type { AgreementService, AgreementRow } from "../agreements/service.js";
import type { IntakeRepository } from "../intake/repository.js";
import type { ConditionRepository } from "../conditions/repository.js";
import { conditionMatches, inferPattern, MAIN_DOCS, MASTER_DOC, SETTLEMENT_DOC, SET_DOMAIN, type WorkbenchPattern } from "./catalog.js";

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
export type CandidateRole = "master" | "main" | "settlement";

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
  kind: "task" | "matter" | "party";
  requestId: number | null; requestNo: string | null; taskId: number | null;
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
  /** 型を手で決めたとき（相手先だけから入って推せないとき）。 */
  pattern?: WorkbenchPattern | null;
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

    if (query.taskId || query.requestId) {
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
      ctx = {
        kind: "task", requestId, requestNo: r.requestNo, taskId: query.taskId ?? null,
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
    const candidates = await this.candidates(ctx, today);
    return { ctx, conditions: mine, otherConditions: others, candidates, linkedDocuments: linked };
  }

  private async candidates(ctx: WorkbenchContext, today: string): Promise<WorkbenchCandidate[]> {
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
    if (mains.length) {
      const existing = byKeys(mains.map((m) => m.key));
      const label = p === "service" ? "発注書" : p === "pub_in" ? "出版許諾契約書" : isLicenseTerms(p) ? "条件書" : mains[0].label;
      out.push({
        id: "main", role: "main", templateKey: mains[0].key, options: mains, label,
        why: p === "service" ? "条件明細から明細を作る" : "条件明細から取引形態・料率を載せる",
        needed: "now", suggested: "create", existing, agreements: []
      });
    }

    const settlement = SETTLEMENT_DOC[p];
    if (settlement) {
      out.push({
        id: "settlement", role: "settlement", templateKey: settlement.key, options: [settlement], label: settlement.label,
        why: p === "service" ? "納品のあとに作る（実績から）" : "締めごとに作る（実績から）",
        needed: "later", suggested: "later", existing: [], agreements: []
      });
    }
    return out;
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

const isLicenseTerms = (p: WorkbenchPattern) => p === "game_in" || p === "game_out" || p === "pub_out";

function uniqWorks(conditions: ConditionSummary[]): Array<{ id: number; title: string }> {
  const seen = new Map<number, string>();
  for (const c of conditions) if (c.work && !seen.has(c.work.id)) seen.set(c.work.id, c.work.title);
  return [...seen].map(([id, title]) => ({ id, title }));
}

