import { int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { ConditionWriteService } from "../conditions/write-service.js";
import { ConditionScheduleService } from "../conditions/schedule-service.js";
import { MatterWriteService } from "../matters/write-service.js";
import { DocumentIssueService } from "../documents/issue-service.js";
import { deliveryKindFor } from "../documents/order-period.js";
import {
  JUDGE_BUSINESS_NAME, JUDGE_CONTRACT_FORM, planJudgeOrder,
  type JudgeDay, type JudgePlan, type JudgeStore
} from "./plan.js";

/**
 * 店舗イベント審判業務。店舗マスタ（店舗 × 担当取引先）と、発注書の下書きづくり。
 *
 * 発注書は普通の発注書（ひな形 purchase_order）と同じ道を通る：
 *   条件明細（委託料：明細の行ごと、実費：交通費があれば 1 本）→ 予定明細 → 案件 → 下書き。
 * だから作ったあとは 決定・送る・役務完了報告・支払 がいつもどおり使える。
 *
 * 案件は取引先ごとに 1 つ（店舗事業｜取引先｜店舗イベント審判業務）。開いている案件があれば
 * 毎月そこへぶら下げ、無ければ作る。
 */

export interface StoreJudge {
  partyId: number; name: string; partyCode: string | null; kind: string;
  invoiceNo: string | null; withholding: boolean; email: string | null;
  defaultFeeIncTax: number | null; defaultTravelIncTax: number | null;
  /** 人ごとの基本契約の扱い（店舗をまたいで同じ）。 */
  agreementMode: AgreementMode; agreementId: number | null; agreementNo: string | null;
}
export type AgreementMode = "auto" | "fixed" | "none";
export interface AgreementRef { id: number; agreementNo: string | null; title: string; status: string }
export interface EventStore {
  id: number; name: string; shortName: string; active: boolean; sortOrder: number;
  judges: StoreJudge[];
}

export interface JudgeOrderInput {
  partyId: number;
  days: JudgeDay[];
  /** 案件。空なら取引先の開いている審判業務の案件、それも無ければ作る。 */
  matterId?: number | null;
  /** 案件を新しく作るときの担当者（期限の通知先・紙の担当）。 */
  ownerStaffId?: number | null;
  /** この 1 枚だけの基本契約の扱い。空なら人ごとの設定（それも無ければ自動）。 */
  agreement?: { mode: AgreementMode; agreementId?: number | null } | null;
  /**
   * 訂正版。決定済みの発注書（この画面で作ったものでも、手で作ったものでも）を、この中身で作り直す。
   * 新しい条件明細は下書きで作り、訂正版を決定した時点で元の条件明細と入れ替わる（元は無効になる）。
   */
  revise?: { documentId: number; reason: string } | null;
}

/** 訂正版の元。開催日は、この画面で作った発注書なら控えから戻す。手で作ったものは空（入れ直す）。 */
export interface ReviseSource {
  documentId: number; documentNo: string | null; templateKey: string;
  partyId: number | null; partyName: string | null;
  matterId: number | null; agreementId: number | null;
  conditionIds: number[];
  days: JudgeDay[];
  /** この画面で作った発注書か（開催日を戻せたか）。 */
  fromThisScreen: boolean;
  issues: string[];
}

export interface JudgeOrderPreview {
  party: { id: number; name: string; kind: string } | null;
  plan: JudgePlan;
  /** ぶら下げる案件。null なら作る。 */
  matter: { id: number; matterNo: string | null; title: string } | null;
  /** 載せる基本契約。null なら基本契約なし（紙には標準約款が付く）。 */
  agreement: AgreementRef | null;
  /** どう決めたか（人の設定・自動・この 1 枚の指定）。 */
  agreementNote: string;
  /** 選び直せる契約（この取引先のイン契約）。 */
  agreementCandidates: AgreementRef[];
  /** 訂正版の元（訂正版のときだけ）。 */
  revise?: ReviseSource | null;
  issues: string[];
}

export interface JudgeOrderResult {
  documentId: number;
  /** 訂正版なら元の文書。 */
  supersedesId?: number | null;
  matterId: number;
  matterCreated: boolean;
  conditions: Array<{ id: number; conditionNo: string | null; kind: string }>;
}

const TEMPLATE_KEY = "purchase_order";

const agreementRef = (a: Record<string, any>): AgreementRef =>
  ({ id: Number(a.id), agreementNo: str(a.agreement_no), title: String(a.title ?? ""), status: String(a.status ?? "") });

export class StoreEventService {
  private readonly conditions: ConditionWriteService;
  private readonly schedules: ConditionScheduleService;
  private readonly matters: MatterWriteService;
  private readonly issues: DocumentIssueService;

  constructor(private readonly database: Transactable, deps?: {
    conditions?: ConditionWriteService; schedules?: ConditionScheduleService;
    matters?: MatterWriteService; issues?: DocumentIssueService;
  }) {
    this.conditions = deps?.conditions ?? new ConditionWriteService(database);
    this.schedules = deps?.schedules ?? new ConditionScheduleService(database);
    this.matters = deps?.matters ?? new MatterWriteService(database);
    this.issues = deps?.issues ?? new DocumentIssueService(database);
  }

  // ---- 店舗マスタ ------------------------------------------------------

  async listStores(includeInactive = true): Promise<EventStore[]> {
    try {
      const stores = await this.database.query(
        `SELECT id, name, short_name, active, sort_order FROM event_stores
          ${includeInactive ? "" : "WHERE active"}
          ORDER BY sort_order, id`);
      const judges = await this.database.query(
        `SELECT j.store_id, j.party_id, j.default_fee_inc_tax, j.default_travel_inc_tax,
                p.name, p.party_code, p.kind, p.invoice_no, p.withholding, p.email,
                COALESCE(st.agreement_mode, 'auto') AS agreement_mode, st.agreement_id, a.agreement_no
           FROM event_store_judges j JOIN parties p ON p.id = j.party_id
           LEFT JOIN event_judge_settings st ON st.party_id = j.party_id
           LEFT JOIN agreements a ON a.id = st.agreement_id
          ORDER BY j.sort_order, p.name`);
      const byStore = new Map<number, StoreJudge[]>();
      for (const r of judges.rows as Array<Record<string, any>>) {
        const list = byStore.get(Number(r.store_id)) ?? [];
        list.push({
          partyId: Number(r.party_id), name: String(r.name), partyCode: str(r.party_code), kind: String(r.kind),
          invoiceNo: str(r.invoice_no), withholding: Boolean(r.withholding), email: str(r.email),
          defaultFeeIncTax: int(r.default_fee_inc_tax), defaultTravelIncTax: int(r.default_travel_inc_tax),
          agreementMode: (r.agreement_mode as AgreementMode) ?? "auto", agreementId: int(r.agreement_id),
          agreementNo: str(r.agreement_no)
        });
        byStore.set(Number(r.store_id), list);
      }
      return (stores.rows as Array<Record<string, any>>).map((s) => ({
        id: Number(s.id), name: String(s.name), shortName: String(s.short_name),
        active: Boolean(s.active), sortOrder: Number(s.sort_order ?? 0),
        judges: byStore.get(Number(s.id)) ?? []
      }));
    } catch (error) { throw translate(error); }
  }

  async saveStore(input: { id?: number | null; name: string; shortName: string; active?: boolean; sortOrder?: number | null },
                  actor: string): Promise<{ id: number }> {
    const name = String(input.name ?? "").trim();
    const shortName = String(input.shortName ?? "").trim();
    if (!name) throw new DomainError("VALIDATION", "店舗名を入れてください（発注書の「場所」に出ます）");
    if (!shortName) throw new DomainError("VALIDATION", "略称を入れてください（品目名「審判業務（日付‗略称）」に出ます）");
    try {
      const r = input.id
        ? await this.database.query(
            `UPDATE event_stores SET name = $2, short_name = $3, active = $4, sort_order = $5, updated_at = now()
              WHERE id = $1 RETURNING id`,
            [input.id, name, shortName, input.active ?? true, input.sortOrder ?? 0])
        : await this.database.query(
            `INSERT INTO event_stores (name, short_name, active, sort_order) VALUES ($1, $2, $3, $4) RETURNING id`,
            [name, shortName, input.active ?? true, input.sortOrder ?? 0]);
      const row = r.rows[0] as { id: number } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `店舗 ${input.id} が見つかりません`);
      const id = Number(row.id);
      await recordAudit(this.database, { actor, action: input.id ? "event_store.update" : "event_store.create",
        targetType: "event_store", targetId: id, detail: { name, shortName, active: input.active ?? true } });
      return { id };
    } catch (error) { throw translate(error); }
  }

  async deleteStore(id: number, actor: string): Promise<void> {
    try {
      const r = await this.database.query("DELETE FROM event_stores WHERE id = $1 RETURNING name", [id]);
      if (!r.rows[0]) throw new DomainError("NOT_FOUND", `店舗 ${id} が見つかりません`);
      await recordAudit(this.database, { actor, action: "event_store.delete", targetType: "event_store", targetId: id,
        detail: { name: (r.rows[0] as { name: string }).name } });
    } catch (error) { throw translate(error); }
  }

  async setJudge(storeId: number, input: { partyId: number; defaultFeeIncTax?: number | null; defaultTravelIncTax?: number | null },
                 actor: string): Promise<void> {
    try {
      const party = (await this.database.query("SELECT id, status FROM parties WHERE id = $1", [input.partyId])).rows[0] as
        { id: number; status: string } | undefined;
      if (!party) throw new DomainError("NOT_FOUND", `取引先 ${input.partyId} が見つかりません`);
      if (party.status !== "active") throw new DomainError("VALIDATION", "使っていない（統合済み・保管済み）取引先は担当にできません");
      const store = (await this.database.query("SELECT id FROM event_stores WHERE id = $1", [storeId])).rows[0];
      if (!store) throw new DomainError("NOT_FOUND", `店舗 ${storeId} が見つかりません`);
      await this.database.query(
        `INSERT INTO event_store_judges (store_id, party_id, default_fee_inc_tax, default_travel_inc_tax)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (store_id, party_id) DO UPDATE
           SET default_fee_inc_tax = EXCLUDED.default_fee_inc_tax,
               default_travel_inc_tax = EXCLUDED.default_travel_inc_tax`,
        [storeId, input.partyId, input.defaultFeeIncTax ?? null, input.defaultTravelIncTax ?? null]);
      await recordAudit(this.database, { actor, action: "event_store.set_judge", targetType: "event_store", targetId: storeId,
        detail: { partyId: input.partyId, defaultFeeIncTax: input.defaultFeeIncTax ?? null,
                  defaultTravelIncTax: input.defaultTravelIncTax ?? null } });
    } catch (error) { throw translate(error); }
  }

  async removeJudge(storeId: number, partyId: number, actor: string): Promise<void> {
    try {
      await this.database.query("DELETE FROM event_store_judges WHERE store_id = $1 AND party_id = $2", [storeId, partyId]);
      await recordAudit(this.database, { actor, action: "event_store.remove_judge", targetType: "event_store",
        targetId: storeId, detail: { partyId } });
    } catch (error) { throw translate(error); }
  }

  /** 人ごとの基本契約の扱いを決める（店舗をまたいで同じ）。 */
  async setJudgeSettings(partyId: number, input: { agreementMode: AgreementMode; agreementId?: number | null },
                         actor: string): Promise<void> {
    const mode = input.agreementMode;
    if (!["auto", "fixed", "none"].includes(mode)) throw new DomainError("VALIDATION", "基本契約の扱いは 自動・この契約・なし のどれかです");
    try {
      let agreementId: number | null = null;
      if (mode === "fixed") {
        if (!input.agreementId) throw new DomainError("VALIDATION", "載せる基本契約を選んでください");
        const a = (await this.database.query("SELECT id, counterparty_id FROM agreements WHERE id = $1", [input.agreementId])).rows[0] as
          { id: number; counterparty_id: number | null } | undefined;
        if (!a) throw new DomainError("NOT_FOUND", `契約 ${input.agreementId} が見つかりません`);
        // 別の取引先の契約にぶら下げない。
        if (Number(a.counterparty_id) !== partyId) throw new DomainError("VALIDATION", "この取引先の契約ではありません");
        agreementId = Number(a.id);
      }
      await this.database.query(
        `INSERT INTO event_judge_settings (party_id, agreement_mode, agreement_id) VALUES ($1, $2, $3)
         ON CONFLICT (party_id) DO UPDATE SET agreement_mode = EXCLUDED.agreement_mode,
           agreement_id = EXCLUDED.agreement_id, updated_at = now()`, [partyId, mode, agreementId]);
      await recordAudit(this.database, { actor, action: "event_store.judge_settings", targetType: "party", targetId: partyId,
        detail: { agreementMode: mode, agreementId } });
    } catch (error) { throw translate(error); }
  }

  /** その取引先のイン契約（基本契約の候補）。締結済みが先。 */
  async agreementsOf(partyId: number): Promise<AgreementRef[]> {
    try {
      const r = await this.database.query(
        `SELECT id, agreement_no, title, status FROM agreements
          WHERE counterparty_id = $1 AND direction = 'in' AND status IN ('executed', 'negotiating', 'draft')
          ORDER BY (status = 'executed') DESC, id DESC LIMIT 30`, [partyId]);
      return (r.rows as Array<Record<string, any>>).map(agreementRef);
    } catch (error) { throw translate(error); }
  }

  /**
   * 載せる基本契約を決める。この 1 枚の指定 → 人ごとの設定 → 自動 の順。
   * 自動は 締結済みのイン契約が 1 本ならそれ。無い・複数なら基本契約なし（理由を返す）。
   */
  async resolveAgreement(partyId: number, override?: JudgeOrderInput["agreement"]):
    Promise<{ agreement: AgreementRef | null; note: string; issue: string | null }> {
    const setting = (await this.database.query(
      "SELECT agreement_mode, agreement_id FROM event_judge_settings WHERE party_id = $1", [partyId])).rows[0] as
      { agreement_mode: AgreementMode; agreement_id: number | null } | undefined;
    const chosen = override ?? (setting ? { mode: setting.agreement_mode, agreementId: setting.agreement_id } : null);
    const from = override ? "この発注書の指定" : setting ? "この人の設定" : "自動";
    if (chosen?.mode === "none") return { agreement: null, note: `基本契約なし（${from}）。発注書に標準約款が付きます`, issue: null };
    if (chosen?.mode === "fixed") {
      const a = chosen.agreementId
        ? (await this.database.query(
            "SELECT id, agreement_no, title, status, counterparty_id FROM agreements WHERE id = $1", [chosen.agreementId])).rows[0] as Record<string, any> | undefined
        : undefined;
      if (!a) return { agreement: null, note: "", issue: "指定した基本契約が見つかりません" };
      if (Number(a.counterparty_id) !== partyId) return { agreement: null, note: "", issue: "指定した基本契約はこの取引先の契約ではありません" };
      return { agreement: agreementRef(a), note: `指定の基本契約（${from}）`, issue: null };
    }
    const executed = await this.database.query(
      `SELECT id, agreement_no, title, status FROM agreements
        WHERE counterparty_id = $1 AND direction = 'in' AND status = 'executed' ORDER BY id DESC LIMIT 5`, [partyId]);
    if (executed.rows.length === 1) {
      return { agreement: agreementRef(executed.rows[0] as Record<string, any>), note: `締結済みの基本契約（${from}）`, issue: null };
    }
    if (executed.rows.length > 1) {
      return { agreement: null, note: "", issue: "締結済みの基本契約が複数あります。どれに載せるか選んでください（または「なし」）" };
    }
    return { agreement: null, note: `締結済みの基本契約が無いので基本契約なし（${from}）。発注書に標準約款が付きます`, issue: null };
  }

  // ---- 発注書 ----------------------------------------------------------

  /** 突き合わせ。何も作らない。画面のプレビューと、作る前の確かめに使う。 */
  async preview(input: JudgeOrderInput): Promise<JudgeOrderPreview> {
    try {
      const issues: string[] = [];
      const party = (await this.database.query(
        "SELECT id, name, kind, status FROM parties WHERE id = $1", [input.partyId])).rows[0] as
        { id: number; name: string; kind: string; status: string } | undefined;
      if (!party) issues.push("取引先が見つかりません");
      else if (party.status !== "active") issues.push("この取引先は使われていません（統合済み・保管済み）");
      const storeIds = [...new Set((input.days ?? []).map((d) => Number(d.storeId)).filter((n) => n > 0))];
      const stores = await this.storesById(this.database, storeIds);
      // 店舗の担当でない取引先には出さない（店舗を取り違えた発注を防ぐ）。
      if (party && storeIds.length) {
        const assigned = await this.database.query(
          "SELECT store_id FROM event_store_judges WHERE party_id = $1 AND store_id = ANY($2::bigint[])",
          [party.id, storeIds]);
        const ok = new Set((assigned.rows as Array<{ store_id: number }>).map((r) => Number(r.store_id)));
        for (const s of stores) if (!ok.has(s.id)) issues.push(`${party.name} は ${s.name} の担当に登録されていません`);
      }
      const plan = planJudgeOrder({ days: input.days ?? [], stores, partyKind: party?.kind ?? null });
      // 訂正版は元の発注書の案件に載る（作り直しても案件は動かさない）。
      const source = input.revise ? await this.reviseSource(input.revise.documentId) : null;
      if (source) {
        issues.push(...source.issues);
        if (party && source.partyId && source.partyId !== Number(party.id)) {
          issues.push(`元の発注書の取引先は ${source.partyName ?? `#${source.partyId}`} です。訂正版で取引先は変えられません`);
        }
        if (!String(input.revise?.reason ?? "").trim()) issues.push("訂正の理由を書いてください（訂正版の記録に残ります）");
      }
      const matter = source?.matterId ? await this.matterById(source.matterId)
        : input.matterId ? await this.matterById(input.matterId)
        : party ? await this.openMatterOf(party.id) : null;
      if (input.matterId && !matter) issues.push(`案件 ${input.matterId} が見つかりません`);
      if (!matter && !input.ownerStaffId) issues.push("この取引先の審判業務の案件がまだ無いので、案件の担当者を選んでください");
      const resolved = party ? await this.resolveAgreement(Number(party.id), input.agreement ?? null)
        : { agreement: null, note: "", issue: null };
      if (resolved.issue) issues.push(resolved.issue);
      return {
        party: party ? { id: Number(party.id), name: party.name, kind: party.kind } : null,
        plan, matter,
        agreement: resolved.agreement, agreementNote: resolved.note,
        agreementCandidates: party ? await this.agreementsOf(Number(party.id)) : [],
        revise: source,
        issues: [...issues, ...plan.issues]
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 発注書の下書きを作る。条件明細（委託料は明細の行ごと・実費は 1 本）→ 予定明細 → 下書き。
   * 決定・送付はいつもの文書の画面から。
   */
  async createOrder(input: JudgeOrderInput, actor: string): Promise<JudgeOrderResult> {
    const preview = await this.preview(input);
    if (preview.issues.length) throw new DomainError("VALIDATION", preview.issues.join("／"));
    const party = preview.party!;
    const plan = preview.plan;
    try {
      let matterId = preview.matter?.id ?? null;
      let matterCreated = false;
      if (!matterId) {
        const made = await this.matters.create({
          kind: "outsourcing", businessLine: "store", businessName: JUDGE_BUSINESS_NAME,
          counterpartyId: party.id, ownerStaffId: input.ownerStaffId ?? null
        }, actor);
        matterId = made.id; matterCreated = true;
      }
      const lines = plan.lines;
      const first = lines.map((l) => l.termStart).sort()[0];
      const last = lines.map((l) => l.termEnd).sort().at(-1)!;
      const set = await this.conditions.createServiceSet({
        matterId, title: plan.subject, counterpartyId: party.id,
        // 基本契約。人によって有る・無い。無ければ条件は契約に載らず、紙には標準約款が付く。
        agreementId: preview.agreement?.id ?? null,
        termStart: first, termEnd: last, contractForm: JUDGE_CONTRACT_FORM, deliverableOwnership: "orderer",
        rows: [
          ...lines.map((l) => ({
            kind: "service" as const, name: l.itemName, pricingModel: "fixed" as const,
            flatAmount: l.amount, unitAmount: l.unitPrice, quantity: l.quantity, unitLabel: "日",
            spec: l.spec, deliveryDue: l.termEnd, contractForm: JUDGE_CONTRACT_FORM, deliverableOwnership: "orderer" as const
          })),
          ...(plan.travelTotal > 0 ? [{
            kind: "expense" as const, name: `${plan.subject} 交通費`, flatAmount: plan.travelTotal,
            notes: `税込の実費（${plan.expenses.map((e) => `${e.date} ¥${e.amount.toLocaleString("ja-JP")}`).join("・")}）`
          }] : [])
        ]
      }, actor);
      const serviceIds = set.conditions.slice(0, lines.length).map((c) => c.id);
      const newIds = set.conditions.map((c) => c.id);
      // 訂正版の条件明細は、決定するまで下書き。元の発注書が生きている間に二重に数えない。
      if (input.revise) {
        await this.database.query(
          "UPDATE conditions SET status = 'draft', updated_at = now() WHERE id = ANY($1::bigint[]) AND status = 'active'", [newIds]);
      }
      const expenseId = plan.travelTotal > 0 ? set.conditions[lines.length]?.id ?? null : null;
      // 予定明細：委託料の行ごとに 1 回（役務完了報告で 1 行ずつ実績になる）。
      for (const [i, l] of lines.entries()) {
        await this.schedules.replace(serviceIds[i], [{
          seq: 1, label: l.itemName, triggerKind: "on_inspection", plannedAmount: l.amount,
          dueOn: l.termEnd, payOn: plan.payOn, serviceFrom: l.termStart, serviceTo: l.termEnd
        }], actor);
      }
      const manualInputs: Record<string, unknown> = {
        PROJECT_TITLE: plan.subject,
        items: lines.map((l, i) => ({
          condition_id: serviceIds[i], item_name: l.itemName, spec: l.spec, description: l.spec,
          quantity: l.quantity, unit: "日", unit_price: l.unitPrice, amount_ex_tax: l.amount,
          deliverable_ownership: "発注者", calc_method: "FIXED", payment_terms: JUDGE_CONTRACT_FORM,
          delivery_kind: deliveryKindFor(JUDGE_CONTRACT_FORM), term_start: l.termStart, term_end: l.termEnd,
          delivery_date: l.termEnd, payment_date: plan.payOn, tax_category: "taxable"
        })),
        expenses: expenseId ? plan.expenses.map((e) => ({
          condition_id: expenseId, expense_name: "交通費", amount_inc_tax: e.amount, spent_date: e.date, remarks: ""
        })) : [],
        // 作ったときの入力。開き直して直すとき・訂正版の手がかり（紙には出ない）。
        // 訂正版なら、決定したときに入れ替える条件明細（新＝下書き → 有効、元 → 無効）も控える。
        _storeEvent: { days: input.days,
          ...(input.revise ? { newConditionIds: newIds, replacesConditionIds: preview.revise?.conditionIds ?? [] } : {}) }
      };
      let draft: { id: number };
      if (input.revise) {
        // いつもの訂正版と同じ道（元の手入力・依頼を引き継ぎ、決定した瞬間に元が退く）。中身はこの画面のもので置き換える。
        draft = await this.issues.reissue(input.revise.documentId, input.revise.reason, actor, newIds);
        await this.issues.updateDraft(draft.id, { manualInputs, agreementId: preview.agreement?.id ?? null }, actor);
      } else {
        draft = await this.issues.createDraft({
          templateKey: TEMPLATE_KEY, conditionIds: newIds, matterId, manualInputs,
          agreementId: preview.agreement?.id ?? null
        }, actor);
      }
      await recordAudit(this.database, { actor, action: "document.store_event_order", targetType: "document",
        targetId: draft.id, detail: { partyId: party.id, month: plan.month, lines: lines.length,
          days: input.days.length, subtotal: plan.subtotal, travelTotal: plan.travelTotal, matterId, matterCreated,
          agreementId: preview.agreement?.id ?? null, supersedes: input.revise?.documentId ?? null } });
      return {
        documentId: draft.id, supersedesId: input.revise?.documentId ?? null, matterId, matterCreated,
        conditions: set.conditions.map((c, i) => ({ id: c.id, conditionNo: c.conditionNo ?? null,
          kind: i < lines.length ? "service" : "expense" }))
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 訂正版の元を読む。決定済みの発注書だけ。取引先は載っている条件明細の相手先から引く。
   * この画面で作った発注書なら開催日を控え（_storeEvent）から戻す。
   */
  async reviseSource(documentId: number): Promise<ReviseSource> {
    try {
      const issues: string[] = [];
      const doc = (await this.database.query(
        `SELECT d.id, d.document_no, d.status, d.matter_id, d.agreement_id, d.manual_inputs, t.template_key
           FROM documents d
           LEFT JOIN document_template_versions v ON v.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = v.template_id
          WHERE d.id = $1`, [documentId])).rows[0] as Record<string, any> | undefined;
      if (!doc) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
      if (doc.template_key !== TEMPLATE_KEY) issues.push("この画面で訂正版を作れるのは発注書（国内）だけです");
      if (doc.status !== "issued") issues.push(`決定済みの発注書だけ訂正版を作れます（この文書は ${doc.status}）`);
      const open = (await this.database.query(
        "SELECT id FROM documents WHERE supersedes_id = $1 AND status = 'draft' LIMIT 1", [documentId])).rows[0] as { id: number } | undefined;
      if (open) issues.push(`この発注書にはもう訂正版の下書きがあります（#${open.id}）。それを開いて直すか、消してから作り直してください`);
      const conds = (await this.database.query(
        `SELECT c.id, c.counterparty_id, p.name AS party_name
           FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
           LEFT JOIN parties p ON p.id = c.counterparty_id
          WHERE dc.document_id = $1 AND c.status NOT IN ('void', 'superseded')
          ORDER BY dc.condition_id`, [documentId])).rows as Array<Record<string, any>>;
      const partyIds = [...new Set(conds.map((c) => Number(c.counterparty_id)).filter(Boolean))];
      if (partyIds.length > 1) issues.push("元の発注書に取引先が複数載っています。この画面では直せません");
      const conditionIds = conds.map((c) => Number(c.id));
      // 実績（役務完了報告など）が付いた条件明細を無効にすると、その実績の行き場が無くなる。
      if (conditionIds.length) {
        const ev = (await this.database.query(
          "SELECT count(*)::int AS n FROM condition_events WHERE condition_id = ANY($1::bigint[]) AND status = 'active'",
          [conditionIds])).rows[0] as { n: number } | undefined;
        if (Number(ev?.n ?? 0) > 0) {
          issues.push("元の条件明細に実績（役務完了報告など）が付いています。実績のあとの訂正はこの画面ではできません（いつもの「訂正版を作る」で）");
        }
      }
      const saved = (doc.manual_inputs ?? {})._storeEvent as { days?: JudgeDay[] } | undefined;
      const days = Array.isArray(saved?.days) ? saved!.days : [];
      return {
        documentId: Number(doc.id), documentNo: str(doc.document_no), templateKey: String(doc.template_key ?? ""),
        partyId: partyIds[0] ?? null, partyName: str(conds[0]?.party_name),
        matterId: int(doc.matter_id), agreementId: int(doc.agreement_id), conditionIds, days,
        fromThisScreen: days.length > 0, issues
      };
    } catch (error) { throw translate(error); }
  }

  private async storesById(db: Queryable, ids: number[]): Promise<JudgeStore[]> {
    if (!ids.length) return [];
    const r = await db.query("SELECT id, name, short_name FROM event_stores WHERE id = ANY($1::bigint[])", [ids]);
    return (r.rows as Array<Record<string, any>>).map((s) => ({ id: Number(s.id), name: String(s.name), shortName: String(s.short_name) }));
  }

  private async matterById(id: number) {
    const r = await this.database.query("SELECT id, matter_no, title FROM matters WHERE id = $1", [id]);
    const m = r.rows[0] as { id: number; matter_no: string | null; title: string } | undefined;
    return m ? { id: Number(m.id), matterNo: m.matter_no, title: m.title } : null;
  }

  /** 取引先の開いている審判業務の案件（いちばん新しいもの）。 */
  private async openMatterOf(partyId: number) {
    const r = await this.database.query(
      `SELECT id, matter_no, title FROM matters
        WHERE kind = 'outsourcing' AND business_line = 'store' AND counterparty_id = $1
          AND business_name = $2 AND status NOT IN ('done', 'canceled')
        ORDER BY id DESC LIMIT 1`, [partyId, JUDGE_BUSINESS_NAME]);
    const m = r.rows[0] as { id: number; matter_no: string | null; title: string } | undefined;
    return m ? { id: Number(m.id), matterNo: m.matter_no, title: m.title } : null;
  }
}
