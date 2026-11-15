import { type Queryable, type Transactable, inTransaction, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { termHistory, type TermEvent, type TermHistory, type TermInput } from "./term-history.js";
import { agreementVersions, noteAgreementChange, type AgreementVersion } from "./versions.js";
import { TERMS_TEMPLATE_KEYS } from "./auto.js";

/**
 * 契約（合意）。
 *
 * 「合意」は締結の事実と期間を持つ器。「文書」は出力物。「条件」は金額。
 * これまで合意は V2 から移した器しか無く、画面からは作れなかった。
 * 新しい相手と契約を結んでも合意が立たず、条件は契約なしのまま、
 * 工程「基本契約の確認」は未済のまま、契約チェックは「なし」のままだった。
 *
 * 作られ方を 3 通りに固定する。
 *   ① 外で結んだ契約を人が登録する（ここ）
 *   ② 条件書（個別利用許諾条件書・出版条件書）を決定したとき自動で起こす
 *   ③ 発注書・検収書・計算書は合意にしない（基本契約の下の個別取引）
 *
 * 番号：基本契約 ARC-SVC／ARC-LIC、単体契約 ARC-ISA／ARC-ILT、
 *       補助文書・解除合意は親番号＋枝番（-S01／-T01）、文書だけは番号なし。
 */

export type AgreementKind = "master" | "standalone" | "supplement" | "termination" | "document";
export type AgreementDomain = "service" | "license" | "hybrid" | "sale" | "other";
/**
 * 種別（番号の頭が決まる）。売買・その他（覚書など）は 2026-11 に足した（infra/v3/200_agreement_domains.sql）。
 * ハイブリッド（業務委託とライセンスの両方の個別契約を持てる基本契約）は infra/v3/205_agreement_hybrid.sql。
 */
export const AGREEMENT_DOMAINS = ["service", "license", "hybrid", "sale", "other"] as const;
export const DOMAIN_LABELS: Record<AgreementDomain, string> = {
  service: "業務委託", license: "ライセンス", hybrid: "ハイブリッド", sale: "売買", other: "その他（覚書など）"
};
/** 向き。null は向きなし（文書だけの契約：NDA・覚書など。条件明細を持たない）。 */
export type AgreementDirection = "in" | "out" | null;

/** DB の値から向きを読む。 */
export const directionOf = (value: unknown): AgreementDirection =>
  value === "out" ? "out" : value === "in" ? "in" : null;

/** 向きの表示。 */
export const directionLabel = (direction: AgreementDirection): string =>
  direction === "in" ? "IN" : direction === "out" ? "OUT" : "向きなし";

/** 向きなしにできるのは文書だけの契約。ほかの種類は IN／OUT を選ぶ。 */
export function checkDirection(kind: AgreementKind, direction: AgreementDirection): void {
  if (direction === null && kind !== "document") {
    throw new DomainError("VALIDATION", "向き（IN／OUT）を選んでください。向きなしにできるのは「文書だけ」の契約だけです");
  }
}

export const KIND_LABEL: Record<AgreementKind, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "個別契約・覚書",
  termination: "解除合意", document: "文書だけ"
};

/** 番号の頭。domain × kind で決まる。 */
export function numberPrefix(kind: AgreementKind, domain: AgreementDomain | null): string | null {
  // 文書の取り込みの種別（SVC・LIC・MOU…）と同じ頭は使わない（採番表が別なので同じ番号が両方に出る）。
  if (kind === "master") return ({ service: "ARC-SVC", license: "ARC-LIC", hybrid: "ARC-HYB", sale: "ARC-SAL", other: "ARC-OTH" } as const)[domain ?? "service"];
  if (kind === "standalone") return ({ service: "ARC-ISA", license: "ARC-ILT", hybrid: "ARC-IHB", sale: "ARC-ISL", other: "ARC-IOT" } as const)[domain ?? "service"];
  return null;
}

export interface AgreementInput {
  /** 変更の理由（まき直し・更新・訂正など）。契約の版（agreement_versions）に残る。 */
  reason?: string | null;
  counterpartyId: number;
  direction: AgreementDirection;
  kind: AgreementKind;
  domain?: AgreementDomain | null;
  /** 補助文書・解除合意の親。 */
  parentId?: number | null;
  title: string;
  /**
   * 外部で付けた契約番号。システムの採番を使わず、この番号で登録する
   * （移行前に紙で結んだ契約。ATT-2026-00069 など）。同じ番号があれば登録できない。
   */
  agreementNo?: string | null;
  status?: "draft" | "negotiating" | "executed" | null;
  executedOn?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  autoRenewal?: boolean | null;
  renewalMonths?: number | null;
  renewalNoticeMonths?: number | null;
  counterpartyRefNo?: string | null;
  /** 契約書の現物（Drive リンク）。 */
  sourceUrl?: string | null;
}

export interface AgreementRow {
  id: number; agreementNo: string | null; title: string; direction: AgreementDirection;
  kind: AgreementKind; domain: AgreementDomain | null; parentId: number | null;
  status: string; executedOn: string | null; effectiveOn: string | null; expiresOn: string | null;
  autoRenewal: boolean; renewalMonths: number | null; renewalNoticeMonths: number | null;
  renewalStoppedOn: string | null; terminatedOn: string | null;
  counterpartyRefNo: string | null; sourceUrl: string | null;
  counterparty: { id: number; name: string };
  conditionCount: number; documentCount: number; totalFlat: number;
  /** いまの終了日（更新履歴の最終行）。 */
  currentEnd: string | null;
  renewals: number;
}

/** 契約の巻き直し（209）。 */
export interface RepaperInput {
  /** 新契約の件名。空なら旧契約と同じ。 */
  title?: string | null;
  /** 新契約の番号。空なら新しく取る。 */
  agreementNo?: string | null;
  /** 締結日。空なら未締結（交渉中）で立て、旧契約は有効のまま。締結済みにした時点で旧契約が終了になる。 */
  executedOn?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  /** 自動更新・更新期間。渡さなければ旧契約と同じ。 */
  autoRenewal?: boolean | null;
  renewalMonths?: number | null;
  renewalNoticeMonths?: number | null;
  sourceUrl?: string | null;
  reason?: string | null;
  /** 旧契約の条件明細と下の個別契約を新契約へ移す（既定は移す）。 */
  carryOver?: boolean;
  /**
   * 単体契約を、基本契約＋個別契約に切り替える。新契約を基本契約で立て、条件明細は基本契約に載せる
   * （個別契約待ち）。条件書・発注書を決定すると、新しい番号の個別契約が基本契約の下に立つ。
   */
  toMaster?: boolean;
  /** toMaster で、旧単体契約に種別が無いときの種別（番号の頭が決まる）。 */
  domain?: AgreementDomain | null;
}
export interface RepaperResult {
  id: number; agreementNo: string | null; oldNo: string | null;
  movedConditions: number; movedChildren: number;
  /** 新契約を締結済みで立てたので、旧契約が終了になった。 */
  oldClosed: boolean;
  /** 新契約の種類と種別（単体契約から基本契約に切り替えたら master）。 */
  kind: AgreementKind; domain: AgreementDomain | null;
  /** 新契約へ移した条件明細（続けて条件書・発注書を作るのに使う）。 */
  conditionIds: number[];
  /**
   * やり直し：まだ締結していない巻き直し先を巻き直した。新契約は元の旧契約（oldNo）を直接置き換える。
   * 途中の契約（agreementNo）は、何も載っていなければ消した（removed）。文書などが載っていれば、つながりだけ外して残した。
   */
  redo: { agreementNo: string | null; removed: boolean } | null;
  /**
   * 適用日が先の巻き直し：条件明細を移さず、適用日からの改訂として新契約に予約した。
   * いまの版と下の個別契約は旧契約に残る（適用日が来たら、日次ジョブが新しい版に切り替える）。
   * conditionIds は予約した版（これで条件書を作ると、許諾開始日が適用日になる）。
   */
  forward: ForwardCarry | null;
}
export interface ForwardCarry {
  /** 適用日。 */
  on: string;
  scheduled: Array<{ id: number; conditionNo: string | null; fromId: number; fromNo: string | null }>;
  /** 予約しなかった条件明細（旧契約に残る）と、その理由。 */
  skipped: Array<{ conditionNo: string | null; name: string; reason: string }>;
}
/** 条件明細の改訂を予約する道（conditions/write-service の scheduleRevisionIn）。 */
export type ScheduleRevision = (
  client: Queryable, conditionId: number,
  patch: { termStart?: string | null; termEnd?: string | null; agreementId?: number | null },
  effectiveFrom: string, actor: string, why: string
) => Promise<{ id: number; conditionNo: string | null }>;
export interface RepaperDeps { scheduleRevision?: ScheduleRevision }
/** あとから合わせる：巻き直した新契約の下にある「いまの版」を、適用日からの改訂にする。 */
export interface AlignResult { on: string; oldNo: string | null; forward: ForwardCarry; conditionIds: number[] }
export interface RepaperRef {
  id: number; agreementNo: string | null; title: string; status: string; executedOn: string | null; terminatedOn: string | null;
}
export interface RepaperLinks {
  available: boolean; replaces: RepaperRef | null; replacedBy: RepaperRef | null;
  /**
   * やり直しになる：この契約は、まだ締結していない巻き直し先。これを巻き直すと、新契約は元の旧契約（replaces）を
   * 直接置き換え、この契約は（何も載っていなければ）消える。
   */
  redo?: boolean;
  /**
   * あとから合わせられる：この契約は旧契約を置き換えた契約で、適用日が先。下に「いまの版」の条件明細が載っている
   * （適用日より前から効いている条件が、新契約の下にある）。count 本を、適用日からの改訂にできる。
   */
  align?: { on: string; count: number } | null;
  /**
   * 訂正版にする条件書：この契約（適用日が先）の下で、いまの版（適用日より前の開始日）のまま決定している条件書。
   * 載っている条件すべてに、適用日からの版が予約されているものだけ。conditionIds はその版
   * （これで訂正版を作ると、許諾開始日が適用日になる）。draftId は、もう起こしてある訂正版の下書き。
   */
  papers?: StalePaper[];
}
export interface StalePaper {
  id: number; documentNo: string | null; templateKey: string; on: string; conditionIds: number[]; draftId: number | null;
}

export interface TerminateInput {
  on: string;
  /** whole 契約ごと終える／conditions 一部の条件だけ */
  scope: "whole" | "conditions";
  conditionIds?: number[];
  reason: string;
  sourceUrl?: string | null;
}

export interface TerminatePlanLine {
  conditionId: number; conditionNo: string | null; name: string;
  currentEnd: string | null; newEnd: string;
  /** 解除日より後の予定（実績の付いていないもの）。取り消す。 */
  schedulesToRemove: number;
  events: number; unpaidPayments: number;
}

const HEAD = `
  SELECT a.id, a.agreement_no, a.title, a.direction, a.status, a.kind, a.domain, a.parent_id,
         a.executed_on, a.effective_on, a.expires_on, a.auto_renewal, a.renewal_months,
         a.renewal_notice_months, a.renewal_stopped_on, a.terminated_on,
         a.counterparty_ref_no, a.source_url,
         p.id AS party_id, p.name AS party_name,
         (SELECT count(*) FROM conditions c WHERE c.agreement_id = a.id)::int AS condition_count,
         (SELECT count(*) FROM documents d WHERE d.agreement_id = a.id)::int AS document_count,
         (SELECT COALESCE(sum(c.flat_amount), 0) FROM conditions c
           WHERE c.agreement_id = a.id AND c.status = 'active')::bigint AS total_flat
    FROM agreements a JOIN parties p ON p.id = a.counterparty_id`;

export class AgreementService {
  constructor(private readonly database: Transactable) {}

  // -------------------------------------------------------------------
  // 読む
  // -------------------------------------------------------------------

  async list(query: { keyword?: string; partyId?: number | null; executedOnly?: boolean } = {})
    : Promise<AgreementRow[]> {
    const q = String(query.keyword ?? "").trim();
    try {
      const r = await this.database.query(
        `${HEAD}
          WHERE ($1 = '' OR a.title ILIKE $1 OR COALESCE(a.agreement_no,'') ILIKE $1 OR p.name ILIKE $1)
            -- 発注書の個別契約（order-agreement.ts）は発注書として見せる。契約の一覧には出さない。
            AND a.order_document_id IS NULL
            AND ($2::bigint IS NULL OR a.counterparty_id = $2
                 OR a.counterparty_id IN (SELECT party_id FROM v_party_resolved WHERE resolved_id = $2))
            AND ($3::boolean = false OR a.status = 'executed')
          ORDER BY COALESCE(a.parent_id, a.id) DESC, a.parent_id NULLS FIRST, a.id
          LIMIT 300`,
        [q ? `%${q}%` : "", query.partyId ?? null, query.executedOnly === true]);
      const rows = r.rows as any[];
      const events = await this.eventsFor(this.database, "agreement", rows.map((x) => Number(x.id)));
      return rows.map((row) => mapRow(row, events.get(Number(row.id)) ?? []));
    } catch (error) { throw translate(error); }
  }

  async find(id: number): Promise<{
    agreement: AgreementRow; parent: AgreementRow | null; children: AgreementRow[];
    history: TermHistory;
  } | null> {
    try {
      const r = await this.database.query(`${HEAD} WHERE a.id = $1`, [id]);
      const row = r.rows[0] as any;
      if (!row) return null;
      const kids = await this.database.query(`${HEAD} WHERE a.parent_id = $1 ORDER BY a.id`, [id]);
      const ids = [Number(row.id), ...(kids.rows as any[]).map((x) => Number(x.id))];
      if (row.parent_id) ids.push(Number(row.parent_id));
      const events = await this.eventsFor(this.database, "agreement", ids);
      const agreement = mapRow(row, events.get(Number(row.id)) ?? []);
      let parent: AgreementRow | null = null;
      if (row.parent_id) {
        const pr = await this.database.query(`${HEAD} WHERE a.id = $1`, [Number(row.parent_id)]);
        if (pr.rows[0]) parent = mapRow(pr.rows[0] as any, events.get(Number(row.parent_id)) ?? []);
      }
      return {
        agreement, parent,
        children: (kids.rows as any[]).map((k) => mapRow(k, events.get(Number(k.id)) ?? [])),
        history: historyOf(row, events.get(Number(row.id)) ?? [])
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 条件登録で相手先を選んだときの候補。締結済みの基本契約・単体契約だけ。
   * 1 本なら画面が自動で入れる。無ければ「契約を登録する／契約なしで続ける」。
   */
  async candidatesFor(partyId: number): Promise<AgreementRow[]> {
    const rows = await this.list({ partyId, executedOnly: true });
    return rows.filter((a) => (a.kind === "master" || a.kind === "standalone") && !a.terminatedOn);
  }

  /** 更新の記録を対象ごとにまとめて引く。 */
  async eventsFor(
    client: Queryable, targetType: "agreement" | "condition", ids: number[]
  ): Promise<Map<number, TermEvent[]>> {
    const out = new Map<number, TermEvent[]>();
    if (!ids.length) return out;
    const r = await client.query(
      `SELECT e.target_id, e.kind, e.on_date, e.new_end, e.note, a.agreement_no
         FROM term_events e LEFT JOIN agreements a ON a.id = e.ref_agreement_id
        WHERE e.target_type = $1 AND e.target_id = ANY($2::bigint[])
        ORDER BY e.on_date, e.id`, [targetType, ids]);
    for (const row of r.rows as any[]) {
      const id = Number(row.target_id);
      const list = out.get(id) ?? [];
      list.push({ kind: row.kind, onDate: dateStr(row.on_date)!, newEnd: dateStr(row.new_end),
                  basis: str(row.agreement_no) ?? str(row.note) });
      out.set(id, list);
    }
    return out;
  }

  // -------------------------------------------------------------------
  // 作る・直す
  // -------------------------------------------------------------------

  async create(input: AgreementInput, actor: string): Promise<{ id: number; agreementNo: string | null }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "件名を入れてください");
    if (!["master", "standalone", "supplement", "termination", "document"].includes(input.kind)) {
      throw new DomainError("VALIDATION", "契約の種類が読めません");
    }
    checkDirection(input.kind, input.direction ?? null);
    if ((input.kind === "master" || input.kind === "standalone") && !input.domain) {
      throw new DomainError("VALIDATION", "種別（業務委託／ライセンス／売買／その他）を選んでください。番号の頭が決まります");
    }
    if ((input.kind === "supplement" || input.kind === "termination") && !input.parentId) {
      throw new DomainError("VALIDATION", "補助文書・解除合意は親の契約（基本契約か単体契約）を選んでください");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const party = await client.query("SELECT id, name FROM parties WHERE id = $1", [input.counterpartyId]);
        if (!party.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);

        let parent: any = null;
        if (input.parentId) {
          const pr = await client.query(
            "SELECT id, agreement_no, kind, counterparty_id, domain, direction FROM agreements WHERE id = $1",
            [input.parentId]);
          parent = pr.rows[0];
          if (!parent) throw new DomainError("NOT_FOUND", `親の契約 ${input.parentId} が見つかりません`);
          if (parent.kind !== "master" && parent.kind !== "standalone") {
            throw new DomainError("VALIDATION", "親にできるのは基本契約か単体契約だけです");
          }
          if (int(parent.counterparty_id) !== input.counterpartyId) {
            throw new DomainError("VALIDATION", "親の契約と相手先が違います");
          }
        }
        const external = String(input.agreementNo ?? "").trim();
        if (external) {
          const dup = await client.query(
            `SELECT a.id, a.title, p.name AS party FROM agreements a LEFT JOIN parties p ON p.id = a.counterparty_id
              WHERE lower(btrim(a.agreement_no)) = lower($1)`, [external]);
          const hit = dup.rows[0] as { id: number; title: string | null; party: string | null } | undefined;
          if (hit) {
            throw new DomainError("CONFLICT", `契約番号 ${external} はもう使われています（#${hit.id}「${hit.title ?? ""}」相手先：${hit.party ?? "なし"}）。`
              + "取引先⇔基本契約の「文書を探して契約に登録・送る」で番号を探すと、開くか、この取引先に付け替えられます");
          }
        }
        const agreementNo = external || await this.numberFor(client, input.kind, input.domain ?? (parent?.domain ?? null), parent);
        const status = input.status ?? (input.executedOn ? "executed" : "negotiating");
        const r = await client.query(
          `INSERT INTO agreements
             (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
              executed_on, effective_on, expires_on, auto_renewal, renewal_months, renewal_notice_months,
              counterparty_ref_no, source_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::date, $12, $13, $14, $15, $16)
           RETURNING id`,
          [agreementNo, title, input.counterpartyId, input.direction ?? null, status, input.kind,
           input.domain ?? parent?.domain ?? null, input.parentId ?? null,
           input.executedOn ?? null, input.effectiveOn ?? input.executedOn ?? null, input.expiresOn ?? null,
           input.autoRenewal === true, input.renewalMonths ?? null, input.renewalNoticeMonths ?? null,
           str(input.counterpartyRefNo), str(input.sourceUrl)]);
        const id = Number((r.rows[0] as { id: number }).id);
        await recordAudit(client, {
          actor, action: "agreement.create", targetType: "agreement", targetId: id,
          detail: { agreementNo, external: Boolean(external), kind: input.kind, domain: input.domain ?? null,
                    parentId: input.parentId ?? null, counterpartyId: input.counterpartyId, status }
        });
        return { id, agreementNo };
      });
    } catch (error) { throw translate(error); }
  }

  /** 番号。基本・単体は年の通し、補助・解除は親番号＋枝番、文書だけは無し。 */
  private async numberFor(
    client: Queryable, kind: AgreementKind, domain: AgreementDomain | null, parent: any
  ): Promise<string | null> {
    const prefix = numberPrefix(kind, domain);
    if (prefix) {
      return allocateNumber(client, { prefix, table: "agreements", column: "agreement_no", width: 4 });
    }
    if (kind === "supplement" || kind === "termination") {
      const base = str(parent?.agreement_no) ?? `#${parent?.id}`;
      const mark = kind === "supplement" ? "S" : "T";
      const used = await client.query(
        `SELECT count(*)::int AS n FROM agreements WHERE parent_id = $1 AND kind = $2`,
        [Number(parent.id), kind]);
      const n = Number((used.rows[0] as { n: number }).n) + 1;
      return `${base}-${mark}${String(n).padStart(2, "0")}`;
    }
    return null;
  }

  /** 契約の記録の版（新しい順）。208 を流していなければ available=false。 */
  async versions(id: number): Promise<{ available: boolean; versions: AgreementVersion[] }> {
    return agreementVersions(this.database, id);
  }

  /**
   * 渡した契約のうち、巻き直しで別の契約に置き換えられるもの（新契約が未締結でも）。
   * replaces_id の無い環境（209 の前）でも通るよう、列は行の JSON から読む。
   */
  async replacedIds(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const r = await this.database.query(
      `SELECT (to_jsonb(n) ->> 'replaces_id')::bigint AS id FROM agreements n
        WHERE (to_jsonb(n) ->> 'replaces_id')::bigint = ANY($1::bigint[])`, [ids]);
    return new Set((r.rows as Array<{ id: number | string }>).map((x) => Number(x.id)));
  }

  /**
   * 巻き直しのつながり（infra/v3/209_agreement_repaper.sql）。この契約が置き換えた旧契約と、
   * この契約を置き換えた新契約。209 を流していなければ available=false。
   */
  async repaperLinks(id: number): Promise<RepaperLinks> {
    try {
      const r = await this.database.query(
        `SELECT 'replaces' AS rel, o.id, o.agreement_no, o.title, o.status, o.executed_on, o.terminated_on
           FROM agreements a JOIN agreements o ON o.id = a.replaces_id WHERE a.id = $1
         UNION ALL
         SELECT 'replaced_by', n.id, n.agreement_no, n.title, n.status, n.executed_on, n.terminated_on
           FROM agreements n WHERE n.replaces_id = $1
         UNION ALL
         SELECT 'self', a.id, a.agreement_no, a.title, a.status, a.executed_on, a.terminated_on
           FROM agreements a WHERE a.id = $1`, [id]);
      const of = (rel: string): RepaperRef | null => {
        const row = (r.rows as any[]).find((x) => x.rel === rel);
        return row ? { id: Number(row.id), agreementNo: str(row.agreement_no), title: String(row.title ?? ""),
                       status: String(row.status), executedOn: dateStr(row.executed_on), terminatedOn: dateStr(row.terminated_on) } : null;
      };
      const replaces = of("replaces");
      const self = of("self");
      let align: RepaperLinks["align"] = null;
      if (replaces) {
        const n = (await this.database.query(
          `SELECT a.effective_on::text AS on_date,
                  (SELECT count(*) FROM conditions c
                    WHERE c.status = 'active'
                      AND c.agreement_id IN (SELECT $1::bigint UNION ALL
                                             SELECT k.id FROM agreements k
                                              WHERE k.parent_id = $1 AND k.kind = 'supplement'
                                                AND k.terminated_on IS NULL AND k.order_document_id IS NULL))::int AS n
             FROM agreements a JOIN agreements o ON o.id = a.replaces_id
            WHERE a.id = $1 AND a.effective_on > current_date
              AND (o.terminated_on IS NULL OR o.terminated_on > current_date)`, [id])).rows[0] as
          { on_date: string; n: number } | undefined;
        if (n && Number(n.n) > 0) align = { on: String(n.on_date), count: Number(n.n) };
      }
      let papers: StalePaper[] = [];
      if (replaces) {
        const docs = (await this.database.query(
          `SELECT d.id, d.document_no, t.template_key, a.effective_on::text AS on_date,
                  (SELECT x.id FROM documents x WHERE x.supersedes_id = d.id AND x.status = 'draft' ORDER BY x.id LIMIT 1) AS draft_id,
                  array_agg(n.id ORDER BY dc.condition_id) AS next_ids,
                  count(*)::int AS conds, count(n.id)::int AS matched
             FROM agreements a
             JOIN documents d ON d.status = 'issued'
                             AND d.agreement_id IN (SELECT a.id UNION ALL SELECT k.id FROM agreements k WHERE k.parent_id = a.id)
             JOIN document_conditions dc ON dc.document_id = d.id
             JOIN conditions c ON c.id = dc.condition_id
             LEFT JOIN conditions n ON COALESCE(n.series_id, n.id) = COALESCE(c.series_id, c.id)
                                   AND n.id <> c.id AND n.status = 'scheduled' AND n.effective_from = a.effective_on
             JOIN document_template_versions tv ON tv.id = d.template_version_id
             JOIN document_templates t ON t.id = tv.template_id
            WHERE a.id = $1 AND a.effective_on > current_date
            GROUP BY d.id, d.document_no, t.template_key, a.effective_on
           HAVING count(*) = count(n.id)
            ORDER BY d.id`, [id])).rows as Array<Record<string, any>>;
        papers = docs.filter((d) => TERMS_TEMPLATE_KEYS.has(String(d.template_key))).map((d) => ({
          id: Number(d.id), documentNo: str(d.document_no), templateKey: String(d.template_key), on: String(d.on_date),
          conditionIds: (d.next_ids as unknown[]).map(Number), draftId: int(d.draft_id)
        }));
      }
      return { available: true, replaces, replacedBy: of("replaced_by"),
               redo: Boolean(replaces && self && self.status !== "executed"), align, papers };
    } catch (error) {
      // 42703：列が無い（209 をまだ流していない）。
      if ((error as { code?: string }).code === "42703") return { available: false, replaces: null, replacedBy: null };
      throw error;
    }
  }

  /**
   * 契約を巻き直す：いまの基本契約・単体契約を、新しい契約で置き換える。
   *
   *   ・新契約を立てる（種類・種別・向き・相手先は旧契約と同じ。番号は新しく取るか、渡した番号）
   *   ・carryOver なら、旧契約に載っている条件明細と、下の個別契約（発注書の器を含む）を新契約へ移す
   *     条件書・発注書を新しい基本契約の名前で出すには、条件が新契約の下に要る
   *   ・旧契約は、新契約が締結済みになった時点で終了になる（209 のトリガー）。未締結のあいだは有効のまま
   *   ・旧契約の文書・実績・支払・解除合意は旧契約に残る
   *   ・適用日（有効期間の開始。空なら締結日）が先のときは、条件明細を移さない。いま有効な条件明細について
   *     「適用日からの改訂」を新契約に予約し（carryForward）、いまの版と下の個別契約は旧契約に残す。
   *     適用日までは旧契約の条件で計算が続き、適用日に日次ジョブが新しい版へ切り替える
   *   ・まだ締結していない巻き直し先を巻き直すと「やり直し」：新契約は元の旧契約を直接置き換える
   */
  async repaper(id: number, input: RepaperInput, actor: string, deps: RepaperDeps = {}): Promise<RepaperResult> {
    try {
      return await inTransaction(this.database, async (client) => {
        const cur = await client.query(
          `SELECT a.id, a.agreement_no, a.title, a.counterparty_id, a.direction, a.status, COALESCE(a.kind, 'master') AS kind, a.domain,
                  a.expires_on, a.auto_renewal, a.renewal_months, a.renewal_notice_months, a.terminated_on,
                  (to_jsonb(a) ->> 'replaces_id')::bigint AS replaces_id
             FROM agreements a WHERE a.id = $1 FOR UPDATE`, [id]);
        const old = cur.rows[0] as any;
        if (!old) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        if (old.kind !== "master" && old.kind !== "standalone") {
          throw new DomainError("VALIDATION", "巻き直せるのは基本契約か単体契約です（個別契約・覚書は、新しい条件書を出して差し替えます）");
        }
        if (old.terminated_on) throw new DomainError("CONFLICT", "この契約はもう終了しています");
        let dup: { rows: unknown[] };
        try {
          dup = await client.query("SELECT id, agreement_no FROM agreements WHERE replaces_id = $1", [id]);
        } catch (error) {
          if ((error as { code?: string }).code === "42703") {
            throw new DomainError("CONFLICT", "巻き直しを使うには、データベースに 209_agreement_repaper.sql を先に流してください");
          }
          throw error;
        }
        const hit = dup.rows[0] as { id: number; agreement_no: string | null } | undefined;
        if (hit) throw new DomainError("CONFLICT", `この契約は ${hit.agreement_no ?? `#${hit.id}`} でもう巻き直しています`);

        // やり直し：まだ締結していない巻き直し先（旧 ← これ）を、さらに巻き直すとき。鎖（旧 ← これ ← 新）にせず、
        // 新契約が旧契約を直接置き換える（旧 ← 新）。種別を選び直す・番号を取り直す、が主な使い道。
        // これ（途中の契約）は、文書が無ければ消す。文書があれば、つながりだけ外して残す。
        let replacesId = id;
        let origin: { id: number; agreement_no: string | null } | null = null;
        if (old.replaces_id && old.status !== "executed") {
          origin = (await client.query("SELECT id, agreement_no FROM agreements WHERE id = $1 FOR UPDATE", [old.replaces_id])).rows[0] as any ?? null;
          if (origin) {
            // 1 本の旧契約を置き換えられるのは 1 本だけ（agreements_replaces_uq）。先に途中のつながりを外す。
            await noteAgreementChange(client, actor, `巻き直しのやり直し（${origin.agreement_no ?? `#${origin.id}`} の巻き直し先を立て直す）`);
            await client.query("UPDATE agreements SET replaces_id = NULL, updated_at = now() WHERE id = $1", [id]);
            replacesId = Number(origin.id);
          }
        }
        const replacedNo = origin ? origin.agreement_no : old.agreement_no;

        // 単体契約 → 基本契約＋個別契約への切り替え。新契約は基本契約で立て、条件明細はいったん基本契約に載せる
        // （個別契約待ち）。条件書・発注書を決定すると、新しい番号の個別契約が基本契約の下に立つ
        // （agreements/auto.ts・order-agreement.ts）。
        const toMaster = input.toMaster === true;
        if (toMaster && old.kind !== "standalone") {
          throw new DomainError("VALIDATION", "基本契約＋個別契約に切り替えられるのは単体契約です");
        }
        const newKind: AgreementKind = toMaster ? "master" : old.kind;
        // 種別は選べる（ライセンスの基本契約／業務委託の基本契約／ハイブリッド …）。渡さなければ旧契約と同じ。
        // 番号の頭と、基本契約書のひな形が種別で決まる。
        const newDomain: AgreementDomain | null = (input.domain ?? old.domain) ?? null;
        if (newKind === "master" && !newDomain) {
          throw new DomainError("VALIDATION", "基本契約の種別（業務委託／ライセンス／売買／その他）を選んでください。番号の頭が決まります");
        }
        const title = String(input.title ?? "").trim() || String(old.title ?? "");
        const external = String(input.agreementNo ?? "").trim();
        if (external) {
          const used = await client.query("SELECT id FROM agreements WHERE lower(btrim(agreement_no)) = lower($1)", [external]);
          if (used.rows[0]) throw new DomainError("CONFLICT", `契約番号 ${external} はもう使われています`);
        }
        const agreementNo = external || await this.numberFor(client, newKind, newDomain, null);
        const executedOn = input.executedOn ?? null;
        const reason = String(input.reason ?? "").trim() || "契約の巻き直し";
        await noteAgreementChange(client, actor, `${reason}（旧 ${replacedNo ?? `#${replacesId}`} を置き換え）`);
        const made = await client.query(
          `INSERT INTO agreements
             (agreement_no, title, counterparty_id, direction, status, kind, domain, executed_on, effective_on, expires_on,
              auto_renewal, renewal_months, renewal_notice_months, source_url, replaces_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10::date, $11, $12, $13, $14, $15)
           RETURNING id`,
          [agreementNo, title, old.counterparty_id, old.direction, executedOn ? "executed" : "negotiating", newKind, newDomain,
           executedOn, input.effectiveOn ?? executedOn, input.expiresOn ?? null,
           input.autoRenewal ?? (old.auto_renewal === true), input.renewalMonths ?? old.renewal_months ?? null,
           input.renewalNoticeMonths ?? old.renewal_notice_months ?? null, str(input.sourceUrl), replacesId]);
        const newId = Number((made.rows[0] as { id: number }).id);

        let movedConditions = 0, movedChildren = 0;
        let conditionIds: number[] = [];
        // 適用日が先：条件明細は移さず、適用日からの改訂として新契約に予約する。いまの版・下の個別契約は旧契約に残る
        // （適用日までは旧契約の条件で計算が続き、適用日に新しい版へ切り替わる）。
        // やり直し（途中の契約を立て直す）は、途中の契約に載っているものをそのまま新契約へ移す。
        const effectiveOn = input.effectiveOn ?? executedOn;
        const todayIs = String(((await client.query("SELECT current_date::text AS d")).rows[0] as { d: string }).d);
        let forward: ForwardCarry | null = null;
        if (input.carryOver !== false && !origin && effectiveOn && effectiveOn > todayIs && deps.scheduleRevision) {
          forward = await this.carryForward(client, {
            from: id, to: newId, on: effectiveOn, termEnd: input.expiresOn ?? null,
            why: `${reason}（${agreementNo ?? `#${newId}`}。適用日 ${effectiveOn}）`
          }, actor, deps.scheduleRevision);
          conditionIds = forward.scheduled.map((x) => x.id);
        } else if (input.carryOver !== false) {
          await noteAgreementChange(client, actor, `${reason}（${agreementNo ?? `#${newId}`} へ引き継ぎ）`);
          const kids = await client.query(
            `UPDATE agreements SET parent_id = $2, updated_at = now()
              WHERE parent_id = $1 AND kind = 'supplement' AND terminated_on IS NULL RETURNING id`, [id, newId]);
          movedChildren = kids.rows.length;
          const conds = await client.query(
            `UPDATE conditions SET agreement_id = $2, updated_at = now()
              WHERE agreement_id = $1 AND status NOT IN ('superseded', 'void') RETURNING id`, [id, newId]);
          movedConditions = conds.rows.length;
          conditionIds = (conds.rows as Array<{ id: number }>).map((x) => Number(x.id));
        }
        // やり直しの途中の契約：何も載っていなければ消す（空の契約が鎖の外に残らないように）。
        let redo: RepaperResult["redo"] = null;
        if (origin) {
          const left = (await client.query(
            `SELECT (SELECT count(*) FROM documents d WHERE d.agreement_id = $1)::int AS docs,
                    (SELECT count(*) FROM conditions c WHERE c.agreement_id = $1)::int AS conds,
                    (SELECT count(*) FROM agreements k WHERE k.parent_id = $1)::int AS kids,
                    (SELECT count(*) FROM term_events e WHERE (e.target_type = 'agreement' AND e.target_id = $1) OR e.ref_agreement_id = $1)::int AS terms`,
            [id])).rows[0] as { docs: number; conds: number; kids: number; terms: number };
          const empty = !Number(left.docs) && !Number(left.conds) && !Number(left.kids) && !Number(left.terms);
          if (empty) {
            await noteAgreementChange(client, actor, `巻き直しのやり直し（${agreementNo ?? `#${newId}`} で立て直したので消す）`);
            // 案件とのつながりは新契約へ（同じ案件が既にあれば重ねない）。
            await client.query(
              `UPDATE matter_links ml SET target_ref = $2::text
                WHERE ml.target_type = 'agreement' AND ml.target_ref = $1::text
                  AND NOT EXISTS (SELECT 1 FROM matter_links x WHERE x.matter_id = ml.matter_id
                                     AND x.target_type = 'agreement' AND x.target_ref = $2::text)`, [String(id), String(newId)]);
            await client.query("DELETE FROM matter_links WHERE target_type = 'agreement' AND target_ref = $1::text", [String(id)]);
            await client.query("DELETE FROM agreements WHERE id = $1", [id]);
          }
          redo = { agreementNo: str(old.agreement_no), removed: empty };
        }
        await recordAudit(client, {
          actor, action: "agreement.repaper", targetType: "agreement", targetId: newId,
          detail: { replaces: replacesId, oldNo: replacedNo ?? null, agreementNo, reason, carryOver: input.carryOver !== false,
                    movedConditions, movedChildren, executedOn, toMaster, conditionIds, ...(redo ? { redo } : {}),
                    ...(forward ? { forward: { on: forward.on, scheduled: forward.scheduled.length, skipped: forward.skipped.length } } : {}) }
        });
        return { id: newId, agreementNo, oldNo: str(replacedNo), movedConditions, movedChildren,
                 oldClosed: Boolean(executedOn), kind: newKind, domain: newDomain, conditionIds, redo, forward };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 適用日からの改訂として引き継ぐ。from（と、その下の個別契約。発注書の器は除く）に載っている「いまの版」のうち、
   * 適用日以降も続くものについて、適用日からの版を予約する。
   *
   *   ・予約した版：許諾開始（契約期間の開始）＝適用日、終了＝渡した終了日（無ければ、適用日より後まで続く
   *     いまの終了日。それも無ければ空）。載せる先は to（渡さなければ、いまの版と同じ契約）。
   *   ・いまの版：keepOn を渡せばそこへ移す（あとから合わせるとき、旧契約へ戻す）。渡さなければ動かさない。
   *   ・見送るもの：もう改訂が予定されている／適用日より前に期間が終わる（自動更新でない）／適用日より前に済む取引。
   */
  private async carryForward(
    client: Queryable,
    input: { from: number; to?: number | null; keepOn?: number | null; on: string; termEnd: string | null; why: string },
    actor: string, schedule: ScheduleRevision
  ): Promise<ForwardCarry> {
    const rows = (await client.query(
      `SELECT c.id, c.condition_no, c.name, c.kind, c.term_end::text AS term_end,
              (c.term_end IS NOT NULL AND c.term_end > $2::date) AS runs_past,
              (c.term_end IS NOT NULL AND c.term_end < $2::date - 1 AND c.auto_renew IS NOT TRUE) AS ended,
              (c.kind <> 'license' AND (
                 (EXISTS (SELECT 1 FROM condition_schedules s WHERE s.condition_id = c.id)
                  AND NOT EXISTS (SELECT 1 FROM condition_schedules s WHERE s.condition_id = c.id AND s.due_on >= $2::date))
                 OR (NOT EXISTS (SELECT 1 FROM condition_schedules s WHERE s.condition_id = c.id)
                     AND c.delivery_due IS NOT NULL AND c.delivery_due < $2::date))) AS done,
              EXISTS (SELECT 1 FROM conditions x
                       WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id) AND x.status = 'scheduled' AND x.id <> c.id) AS pending
         FROM conditions c
        WHERE c.status = 'active'
          AND c.agreement_id IN (SELECT $1::bigint UNION ALL
                                 SELECT k.id FROM agreements k
                                  WHERE k.parent_id = $1 AND k.kind = 'supplement'
                                    AND k.terminated_on IS NULL AND k.order_document_id IS NULL)
        ORDER BY c.id FOR UPDATE OF c`, [input.from, input.on])).rows as Array<Record<string, any>>;
    const out: ForwardCarry = { on: input.on, scheduled: [], skipped: [] };
    for (const c of rows) {
      const reason = c.pending ? "もう改訂が予定されています"
        : c.ended ? "適用日より前に期間が終わります"
        : c.done ? "適用日より前に済む取引です" : null;
      if (reason) {
        out.skipped.push({ conditionNo: str(c.condition_no), name: String(c.name ?? ""), reason });
        continue;
      }
      const made = await schedule(client, Number(c.id), {
        termStart: input.on,
        termEnd: input.termEnd ?? (c.runs_past ? String(c.term_end) : null),
        ...(input.to ? { agreementId: input.to } : {})
      }, input.on, actor, input.why);
      if (input.keepOn) {
        await client.query("UPDATE conditions SET agreement_id = $2, updated_at = now() WHERE id = $1", [c.id, input.keepOn]);
      }
      out.scheduled.push({ id: made.id, conditionNo: made.conditionNo, fromId: Number(c.id), fromNo: str(c.condition_no) });
    }
    return out;
  }

  /**
   * あとから合わせる：巻き直した新契約（適用日が先）の下に「いまの版」の条件明細が載っているとき
   * （適用日の前に、条件を新契約へ移してしまった）、適用日からの改訂にする。
   *   ・適用日からの版を予約する（新契約の下の、いま載っている契約にそのまま）
   *   ・いまの版は旧契約へ戻す（適用日までは旧契約の条件）
   */
  async align(id: number, actor: string, deps: RepaperDeps): Promise<AlignResult> {
    if (!deps.scheduleRevision) throw new DomainError("CONFLICT", "条件明細の改訂を予約できません");
    try {
      return await inTransaction(this.database, async (client) => {
        const a = (await client.query(
          `SELECT a.id, a.agreement_no, a.effective_on::text AS effective_on, a.expires_on::text AS expires_on,
                  (a.effective_on > current_date) AS later,
                  o.id AS old_id, o.agreement_no AS old_no,
                  (o.terminated_on IS NOT NULL AND o.terminated_on <= current_date) AS old_over
             FROM agreements a JOIN agreements o ON o.id = a.replaces_id WHERE a.id = $1 FOR UPDATE OF a`, [id])).rows[0] as any;
        if (!a) throw new DomainError("VALIDATION", "巻き直した契約（旧契約を置き換えた契約）ではありません");
        if (!a.effective_on || !a.later) throw new DomainError("VALIDATION", "適用日（有効期間の開始）が先の契約だけが対象です。先に適用日を入れてください");
        if (a.old_over) throw new DomainError("CONFLICT", `旧契約 ${a.old_no ?? `#${a.old_id}`} はもう終了しています`);
        const why = `適用日（${a.effective_on}）からの改訂にする（${a.agreement_no ?? `#${id}`}。いまの版は ${a.old_no ?? `#${a.old_id}`} へ）`;
        await noteAgreementChange(client, actor, why);
        const forward = await this.carryForward(client, {
          from: id, keepOn: Number(a.old_id), on: String(a.effective_on), termEnd: str(a.expires_on), why
        }, actor, deps.scheduleRevision!);
        if (!forward.scheduled.length) {
          throw new DomainError("VALIDATION", forward.skipped.length
            ? `改訂にできる条件明細がありません（${forward.skipped.map((x) => `${x.conditionNo ?? x.name}：${x.reason}`).join("／")}）`
            : "この契約の下に、いま有効な条件明細がありません");
        }
        await recordAudit(client, {
          actor, action: "agreement.repaper_align", targetType: "agreement", targetId: id,
          detail: { on: forward.on, oldId: Number(a.old_id), oldNo: a.old_no ?? null,
                    scheduled: forward.scheduled, skipped: forward.skipped }
        });
        return { on: forward.on, oldNo: str(a.old_no), forward, conditionIds: forward.scheduled.map((x) => x.id) };
      });
    } catch (error) { throw translate(error); }
  }

  async update(id: number, patch: Partial<AgreementInput>, actor: string): Promise<void> {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown, cast = "") => { vals.push(v); cols.push(`${col} = $${vals.length}${cast}`); };
    if (patch.title !== undefined) {
      const t = String(patch.title ?? "").trim();
      if (!t) throw new DomainError("VALIDATION", "件名を空にはできません");
      put("title", t);
    }
    if (patch.domain !== undefined) put("domain", patch.domain ?? null);
    if (patch.executedOn !== undefined) put("executed_on", patch.executedOn ?? null, "::date");
    if (patch.effectiveOn !== undefined) put("effective_on", patch.effectiveOn ?? null, "::date");
    if (patch.expiresOn !== undefined) put("expires_on", patch.expiresOn ?? null, "::date");
    if (patch.autoRenewal !== undefined) put("auto_renewal", patch.autoRenewal === true);
    if (patch.renewalMonths !== undefined) put("renewal_months", patch.renewalMonths ?? null);
    if (patch.renewalNoticeMonths !== undefined) put("renewal_notice_months", patch.renewalNoticeMonths ?? null);
    if (patch.counterpartyRefNo !== undefined) put("counterparty_ref_no", str(patch.counterpartyRefNo));
    if (patch.sourceUrl !== undefined) put("source_url", str(patch.sourceUrl));
    if (patch.status !== undefined && patch.status) put("status", patch.status);
    if (!cols.length) return;
    vals.push(id);
    try {
      await inTransaction(this.database, async (client) => {
        await noteAgreementChange(client, actor, patch.reason);
        const r = await client.query(
          `UPDATE agreements SET ${cols.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING id`, vals);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await recordAudit(client, { actor, action: "agreement.update", targetType: "agreement", targetId: id,
                                    detail: { fields: Object.keys(patch) } });
      });
    } catch (error) { throw translate(error); }
  }

  /** 締結を記録する。文書からでも契約からでもできる（外で結んだ契約には文書が無い）。 */
  /**
   * 文書を契約の記録に繋ぐ（documents.agreement_id）。基本契約書を「既にある文書を使う」で
   * 選んだとき、案件には付けずにここへ繋ぐ（業務委託の基本契約は案件をまたぐ）。
   * 別の契約に繋がっている文書は止める。
   */
  async attachDocument(id: number, documentId: number, actor: string): Promise<{ attached: boolean; documentId: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const a = (await client.query("SELECT id, agreement_no FROM agreements WHERE id = $1", [id])).rows[0] as { id: number; agreement_no: string | null } | undefined;
        if (!a) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        const d = (await client.query("SELECT id, document_no, agreement_id FROM documents WHERE id = $1", [documentId])).rows[0] as
          { id: number; document_no: string | null; agreement_id: number | null } | undefined;
        if (!d) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (d.agreement_id && Number(d.agreement_id) !== id) {
          throw new DomainError("CONFLICT", `文書 ${d.document_no ?? `#${d.id}`} は別の契約（#${d.agreement_id}）に繋がっています`);
        }
        if (!d.agreement_id) {
          await client.query("UPDATE documents SET agreement_id = $2 WHERE id = $1", [documentId, id]);
          await recordAudit(client, { actor, action: "agreement.attach_document", targetType: "agreement", targetId: id,
                                      detail: { documentId, documentNo: d.document_no, agreementNo: a.agreement_no } });
        }
        return { attached: true, documentId };
      });
    } catch (error) { throw translate(error); }
  }

  async execute(id: number, input: { on?: string | null; note?: string | null }, actor: string): Promise<void> {
    try {
      await inTransaction(this.database, async (client) => {
        await noteAgreementChange(client, actor, ["締結を記録", str(input.note)].filter(Boolean).join("："));
        const r = await client.query(
          `UPDATE agreements
              SET status = 'executed',
                  executed_on = COALESCE($2::date, executed_on, current_date),
                  effective_on = COALESCE(effective_on, $2::date, current_date),
                  updated_at = now()
            WHERE id = $1 RETURNING agreement_no`, [id, input.on ?? null]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await recordAudit(client, { actor, action: "agreement.execute", targetType: "agreement", targetId: id,
                                    detail: { on: input.on ?? null, note: str(input.note) } });
      });
    } catch (error) { throw translate(error); }
  }

  /** 不更新。自動更新をその日で止める（いまの期間は満了まで有効）。 */
  async decline(id: number, input: { on: string; note?: string | null }, actor: string): Promise<void> {
    if (!input.on) throw new DomainError("VALIDATION", "不更新を決めた日を入れてください");
    try {
      await inTransaction(this.database, async (client) => {
        await noteAgreementChange(client, actor, ["更新しない通知", str(input.note)].filter(Boolean).join("："));
        const r = await client.query(
          `UPDATE agreements SET renewal_stopped_on = $2::date, updated_at = now() WHERE id = $1 RETURNING id`,
          [id, input.on]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await client.query(
          `INSERT INTO term_events (target_type, target_id, kind, on_date, note, created_by)
           VALUES ('agreement', $1, 'declined', $2::date, $3, $4)`, [id, input.on, str(input.note), actor]);
        await recordAudit(client, { actor, action: "agreement.decline", targetType: "agreement", targetId: id,
                                    detail: { on: input.on, note: str(input.note) } });
      });
    } catch (error) { throw translate(error); }
  }

  /** 合意による更新。覚書で終了日を決め直したときに、その補助文書を根拠にして記録する。 */
  async renew(
    id: number, input: { on: string; newEnd: string; refAgreementId?: number | null; note?: string | null },
    actor: string
  ): Promise<void> {
    if (!input.on || !input.newEnd) throw new DomainError("VALIDATION", "更新の日と新しい終了日を入れてください");
    try {
      await inTransaction(this.database, async (client) => {
        const r = await client.query("SELECT id FROM agreements WHERE id = $1", [id]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        await client.query(
          `INSERT INTO term_events (target_type, target_id, kind, on_date, new_end, ref_agreement_id, note, created_by)
           VALUES ('agreement', $1, 'renewed', $2::date, $3::date, $4, $5, $6)`,
          [id, input.on, input.newEnd, input.refAgreementId ?? null, str(input.note), actor]);
        await recordAudit(client, { actor, action: "agreement.renew", targetType: "agreement", targetId: id,
                                    detail: { on: input.on, newEnd: input.newEnd, refAgreementId: input.refAgreementId ?? null } });
      });
    } catch (error) { throw translate(error); }
  }

  // -------------------------------------------------------------------
  // 解除
  // -------------------------------------------------------------------

  /**
   * 解除の下見。何が終わり、何を取り消し、何を残すかを先に出す。
   * 解除は「ここで終わる」と日付を置く処理。条件・紙・支払は消さない。
   */
  async terminatePlan(
    id: number, input: Pick<TerminateInput, "on" | "scope" | "conditionIds">
  ): Promise<{ agreement: AgreementRow; lines: TerminatePlanLine[]; warnings: string[] }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.on ?? ""))) {
      throw new DomainError("VALIDATION", "解除日を入れてください");
    }
    try {
      const found = await this.find(id);
      if (!found) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
      const agreement = found.agreement;
      if (agreement.kind !== "master" && agreement.kind !== "standalone") {
        throw new DomainError("VALIDATION", "解除できるのは基本契約か単体契約です（補助文書は親ごと解除します）");
      }
      const only = input.scope === "conditions" ? (input.conditionIds ?? []).map(Number).filter(Boolean) : [];
      if (input.scope === "conditions" && !only.length) {
        throw new DomainError("VALIDATION", "終える条件を選んでください");
      }
      const conds = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.term_start, c.term_end, c.auto_renew, c.renew_months,
                c.renew_stopped_on,
                (SELECT count(*) FROM condition_schedules s
                  WHERE s.condition_id = c.id AND s.due_on > $2::date
                    AND NOT EXISTS (SELECT 1 FROM condition_events e
                                     WHERE e.schedule_id = s.id AND e.status = 'active'))::int AS removable,
                (SELECT count(*) FROM condition_events e
                  WHERE e.condition_id = c.id AND e.status = 'active')::int AS events,
                (SELECT count(DISTINCT y.id) FROM payments y
                   JOIN payment_allocations al ON al.payment_id = y.id
                   JOIN condition_events e ON e.id = al.event_id
                  WHERE e.condition_id = c.id AND y.status IN ('planned', 'approved'))::int AS unpaid
           FROM conditions c
          WHERE c.agreement_id = $1 AND c.status = 'active'
            AND ($3::bigint[] = '{}'::bigint[] OR c.id = ANY($3::bigint[]))
          ORDER BY c.id`, [id, input.on, only]);
      const condEvents = await this.eventsFor(this.database, "condition", (conds.rows as any[]).map((c) => Number(c.id)));
      const lines: TerminatePlanLine[] = (conds.rows as any[]).map((c) => {
        const h = termHistory(termInputForCondition(c, agreement, condEvents.get(Number(c.id)) ?? []), input.on);
        return {
          conditionId: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
          currentEnd: h.currentEnd, newEnd: input.on,
          schedulesToRemove: Number(c.removable), events: Number(c.events), unpaidPayments: Number(c.unpaid)
        };
      });
      const warnings: string[] = [];
      if (agreement.terminatedOn) warnings.push(`この契約は ${agreement.terminatedOn} に解除済みです`);
      if (input.scope === "whole") warnings.push("契約の状態を「解除」にします。契約チェックは「解除済み。新しい発注はできません」を返します");
      else warnings.push("契約は締結済みのまま。選んだ条件だけが解除日で終わります");
      const removing = lines.reduce((a, l) => a + l.schedulesToRemove, 0);
      if (removing) warnings.push(`解除日より後の予定明細 ${removing} 回を取り消します（実績の付いた回は残します）`);
      const unpaid = lines.reduce((a, l) => a + l.unpaidPayments, 0);
      if (unpaid) warnings.push(`未払の支払 ${unpaid} 件はそのまま残ります（払うべきもの）`);
      warnings.push("解除日までの実績・検収書・支払は触りません。番号も戻りません");
      return { agreement, lines, warnings };
    } catch (error) { throw translate(error); }
  }

  async terminate(id: number, input: TerminateInput, actor: string)
    : Promise<{ terminationId: number; terminationNo: string | null; conditions: number; schedulesRemoved: number }> {
    const reason = String(input.reason ?? "").trim();
    if (!reason) throw new DomainError("VALIDATION", "解除の理由を書いてください（監査に残ります）");
    const plan = await this.terminatePlan(id, input);
    try {
      return await inTransaction(this.database, async (client) => {
        // 解除合意を親の下に立てる（枝番 -T01）。
        const parent = (await client.query(
          "SELECT id, agreement_no, kind, counterparty_id, domain, direction FROM agreements WHERE id = $1 FOR UPDATE",
          [id])).rows[0] as any;
        const terminationNo = await this.numberFor(client, "termination", null, parent);
        const made = await client.query(
          `INSERT INTO agreements
             (agreement_no, title, counterparty_id, direction, status, kind, domain, parent_id,
              executed_on, effective_on, terminated_on, source_url)
           VALUES ($1, $2, $3, $4, 'executed', 'termination', $5, $6, $7::date, $7::date, $7::date, $8)
           RETURNING id`,
          [terminationNo, input.scope === "whole" ? "解除合意" : "一部条件の解除合意",
           parent.counterparty_id, parent.direction, parent.domain, id, input.on, str(input.sourceUrl)]);
        const terminationId = Number((made.rows[0] as { id: number }).id);

        if (input.scope === "whole") {
          await noteAgreementChange(client, actor, `解除合意 ${terminationNo ?? ""}`.trim());
          await client.query(
            `UPDATE agreements SET status = 'terminated', terminated_on = $2::date, updated_at = now() WHERE id = $1`,
            [id, input.on]);
          await client.query(
            `INSERT INTO term_events (target_type, target_id, kind, on_date, ref_agreement_id, note, created_by)
             VALUES ('agreement', $1, 'terminated', $2::date, $3, $4, $5)`,
            [id, input.on, terminationId, reason, actor]);
        }

        let removed = 0;
        for (const line of plan.lines) {
          // 終了日を解除日に置き換える（条件は無効にしない。番号と履歴はそのまま）。
          await client.query(
            `UPDATE conditions
                SET term_end = CASE WHEN term_end IS NULL OR term_end > $2::date THEN $2::date ELSE term_end END,
                    renew_stopped_on = COALESCE(renew_stopped_on, $2::date),
                    updated_at = now()
              WHERE id = $1`, [line.conditionId, input.on]);
          await client.query(
            `INSERT INTO term_events (target_type, target_id, kind, on_date, ref_agreement_id, note, created_by)
             VALUES ('condition', $1, 'terminated', $2::date, $3, $4, $5)`,
            [line.conditionId, input.on, terminationId, reason, actor]);
          // 解除日より後の予定を取り消す。実績の付いた回は残す。
          const gone = await client.query(
            `DELETE FROM condition_schedules s
              WHERE s.condition_id = $1 AND s.due_on > $2::date
                AND NOT EXISTS (SELECT 1 FROM condition_events e
                                 WHERE e.schedule_id = s.id AND e.status = 'active')`,
            [line.conditionId, input.on]);
          removed += gone.rowCount ?? 0;
        }

        await recordAudit(client, {
          actor, action: "agreement.terminate", targetType: "agreement", targetId: id,
          detail: { on: input.on, scope: input.scope, reason, terminationId, terminationNo,
                    conditionIds: plan.lines.map((l) => l.conditionId), schedulesRemoved: removed }
        });
        return { terminationId, terminationNo, conditions: plan.lines.length, schedulesRemoved: removed };
      });
    } catch (error) { throw translate(error); }
  }
}

// ---------------------------------------------------------------------------
// 行の形と、更新履歴の入力
// ---------------------------------------------------------------------------

function historyOf(row: any, events: TermEvent[]): TermHistory {
  return termHistory({
    termStart: dateStr(row.effective_on) ?? dateStr(row.executed_on),
    termEnd: dateStr(row.expires_on),
    autoRenew: row.auto_renewal === true,
    renewMonths: int(row.renewal_months),
    renewStoppedOn: dateStr(row.renewal_stopped_on),
    terminatedOn: dateStr(row.terminated_on),
    events,
    startBasis: row.status === "executed" ? `締結${dateStr(row.executed_on) ? `（${dateStr(row.executed_on)}）` : ""}`
      : row.status === "negotiating" ? "交渉中" : row.status === "draft" ? "下書き" : "締結"
  });
}

export function mapRow(row: any, events: TermEvent[] = []): AgreementRow {
  const h = historyOf(row, events);
  return {
    id: Number(row.id), agreementNo: str(row.agreement_no), title: String(row.title),
    direction: directionOf(row.direction),
    kind: (row.kind ?? "master") as AgreementKind,
    domain: (str(row.domain) as AgreementDomain | null) ?? null,
    parentId: int(row.parent_id),
    status: String(row.status),
    executedOn: dateStr(row.executed_on), effectiveOn: dateStr(row.effective_on), expiresOn: dateStr(row.expires_on),
    autoRenewal: row.auto_renewal === true, renewalMonths: int(row.renewal_months),
    renewalNoticeMonths: int(row.renewal_notice_months),
    renewalStoppedOn: dateStr(row.renewal_stopped_on), terminatedOn: dateStr(row.terminated_on),
    counterpartyRefNo: str(row.counterparty_ref_no), sourceUrl: str(row.source_url),
    counterparty: { id: Number(row.party_id), name: String(row.party_name ?? "") },
    conditionCount: Number(row.condition_count ?? 0), documentCount: Number(row.document_count ?? 0),
    totalFlat: Number(row.total_flat ?? 0),
    currentEnd: h.currentEnd, renewals: h.renewals
  };
}

/**
 * 条件の更新履歴の入力。自分の規則が無ければ親の契約の規則を借りる。
 * 契約が解除されていれば、条件もその日で切れる。
 */
export function termInputForCondition(
  cond: { term_start?: unknown; term_end?: unknown; auto_renew?: unknown; renew_months?: unknown;
          renew_stopped_on?: unknown; termStart?: string | null; termEnd?: string | null;
          autoRenew?: boolean | null; renewMonths?: number | null; renewStoppedOn?: string | null },
  agreement: AgreementRow | null,
  events: TermEvent[]
): TermInput {
  const termStart = cond.termStart ?? dateStr(cond.term_start);
  const termEnd = cond.termEnd ?? dateStr(cond.term_end);
  const own = cond.autoRenew ?? (cond.auto_renew === null || cond.auto_renew === undefined ? null : Boolean(cond.auto_renew));
  const borrow = own === null && agreement !== null && agreement.autoRenewal;
  return {
    termStart, termEnd,
    autoRenew: borrow ? true : own,
    renewMonths: borrow ? agreement!.renewalMonths : (cond.renewMonths ?? int(cond.renew_months)),
    renewStoppedOn: cond.renewStoppedOn ?? dateStr(cond.renew_stopped_on)
      ?? (borrow ? agreement!.renewalStoppedOn : null),
    terminatedOn: agreement?.terminatedOn ?? null,
    events,
    startBasis: agreement
      ? `${KIND_LABEL[agreement.kind]} ${agreement.agreementNo ?? `#${agreement.id}`}${borrow ? " の規則に従う" : ""}`
      : "登録"
  };
}
