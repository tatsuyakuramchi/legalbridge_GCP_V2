import { inTransaction, dateStr, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import {
  OFFICER_TITLES, RptEngine, TXN_TYPES, txnLabel, type Judgement, type Masters, type PartyRef
} from "./engine.js";

/**
 * 関連当事者（A-054）。V1 の gas/RPT.gs・relatedParty.ts・relatedPartyReads.ts の置き換え。
 *
 *   台帳   … 判定に使う会社（取引先に印）・取締役会の有無・株主構成・役員と役職
 *   判定   … engine.ts（V1 の判定エンジンをそのまま移したもの）
 *   議案   … 判定を取締役会の議案として起票する。稟議の B- 番号を振り（A-053）、
 *             判定書を一緒に残す。状態（未上程／承認／否決／継続審議）を稟議に写す。
 *
 * 株主構成と役職は「丸ごと差し替え」で直す（差し替え前は監査に残す）。
 */

export const RPT_THRESHOLDS_KEY = "rpt_thresholds";
export const DEFAULT_THRESHOLDS = { company: null as number | null, person: 10_000_000 as number | null };

export const AGENDA_STATUSES = ["pending", "approved", "rejected", "deferred"] as const;
export type AgendaStatus = typeof AGENDA_STATUSES[number];
/** 議案の状態を稟議の状態へ写す。 */
const RINGI_STATUS_OF: Record<AgendaStatus, string> = {
  pending: "open", approved: "approved", rejected: "rejected", deferred: "open"
};

export interface RptEntity {
  partyId: number; name: string; partyCode: string | null; hasBoard: boolean;
  shareholders: Array<{ holderKind: "party" | "officer"; holderId: number; holderName: string; pct: number }>;
}
export interface RptOfficer {
  id: number; officerKey: string; name: string; staffId: number | null; voided: boolean;
  roles: Array<{ partyId: number; partyName: string; title: string }>;
}
export interface AgendaItem {
  ringiId: number; ringiNo: string; title: string; meetingOn: string | null; txnType: string;
  partyA: string; partyB: string; amountExTax: number | null; isConflict: boolean; isRelatedParty: boolean;
  relatedCategory: string | null; excludedOfficers: string[]; status: AgendaStatus; note: string | null;
  createdAt: string | null;
}

/** 判定に渡す当事者。会社は取引先 ID、個人は役員 ID。 */
export interface JudgeInput {
  a: string;   // "company:12" ／ "person:3"
  b: string;
  txn: string;
  amount?: number | null;
  competing?: boolean;
  thresholds?: { company?: number | null; person?: number | null };
}

const parseRef = (v: string): PartyRef => {
  const m = /^(company|person):(\d+)$/.exec(String(v ?? "").trim());
  if (!m) throw new DomainError("VALIDATION", "取引当事者を選んでください");
  return { kind: m[1] as PartyRef["kind"], id: m[2] };
};
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export class RptService {
  constructor(private readonly database: Transactable) {}

  // ---------------------------------------------------------------- 台帳

  async entities(client: Queryable = this.database): Promise<RptEntity[]> {
    // トランザクションの中からも呼ぶので、同じ接続に並べて投げない（順に待つ）。
    const ents = await client.query(
        `SELECT id, name, party_code, has_board FROM parties
          WHERE rpt_entity AND status <> 'merged' ORDER BY name`);
    const sh = await client.query(
        `SELECT s.party_id, s.holder_kind, COALESCE(s.holder_party_id, s.holder_officer_id) AS holder_id,
                COALESCE(hp.name, ho.name, '?') AS holder_name, s.voting_pct
           FROM party_shareholdings s
           LEFT JOIN parties hp ON hp.id = s.holder_party_id
           LEFT JOIN officers ho ON ho.id = s.holder_officer_id
          ORDER BY s.party_id, s.voting_pct DESC`);
    return (ents.rows as any[]).map((e) => ({
      partyId: Number(e.id), name: String(e.name), partyCode: str(e.party_code), hasBoard: Boolean(e.has_board),
      shareholders: (sh.rows as any[]).filter((s) => Number(s.party_id) === Number(e.id)).map((s) => ({
        holderKind: s.holder_kind as "party" | "officer", holderId: Number(s.holder_id),
        holderName: String(s.holder_name), pct: Number(s.voting_pct)
      }))
    }));
  }

  async officers(client: Queryable = this.database, includeVoided = false): Promise<RptOfficer[]> {
    const os = await client.query(
        `SELECT id, officer_key, name, staff_id, voided_at FROM officers
          ${includeVoided ? "" : "WHERE voided_at IS NULL"} ORDER BY name`);
    const roles = await client.query(
        `SELECT r.officer_id, r.party_id, p.name AS party_name, r.title
           FROM officer_roles r JOIN parties p ON p.id = r.party_id
          ORDER BY r.officer_id, p.name`);
    return (os.rows as any[]).map((o) => ({
      id: Number(o.id), officerKey: String(o.officer_key), name: String(o.name),
      staffId: o.staff_id ? Number(o.staff_id) : null, voided: Boolean(o.voided_at),
      roles: (roles.rows as any[]).filter((r) => Number(r.officer_id) === Number(o.id)).map((r) => ({
        partyId: Number(r.party_id), partyName: String(r.party_name), title: String(r.title)
      }))
    }));
  }

  async thresholds(client: Queryable = this.database) {
    const r = await client.query("SELECT value FROM settings WHERE key = $1", [RPT_THRESHOLDS_KEY]);
    const v = ((r.rows[0] as any)?.value ?? {}) as { company?: unknown; person?: unknown };
    return {
      company: v.company === undefined ? DEFAULT_THRESHOLDS.company : num(v.company),
      person: v.person === undefined ? DEFAULT_THRESHOLDS.person : num(v.person)
    };
  }

  async masters(client: Queryable = this.database) {
    try {
      const entities = await this.entities(client);
      const officers = await this.officers(client);
      const thresholds = await this.thresholds(client);
      return { entities, officers, thresholds, txnTypes: TXN_TYPES, titles: OFFICER_TITLES };
    } catch (error) { throw translate(error); }
  }

  /** 判定エンジンに渡す形。会社の ID は取引先 ID、役員の ID は役員 ID（種類ごとに別）。 */
  static toEngine(entities: RptEntity[], officers: RptOfficer[]): Masters {
    return {
      companies: entities.map((e) => ({
        id: String(e.partyId), name: e.name, board: e.hasBoard,
        shareholders: e.shareholders.map((s) => ({
          holderKind: s.holderKind === "officer" ? "person" as const : "company" as const,
          holderId: String(s.holderId), pct: s.pct
        }))
      })),
      directors: officers.filter((o) => !o.voided).map((o) => ({
        id: String(o.id), name: o.name,
        roles: o.roles.map((r) => ({ companyId: String(r.partyId), title: r.title }))
      }))
    };
  }

  async saveEntity(partyId: number, input: { hasBoard: boolean }, actor: string) {
    try {
      await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `UPDATE parties SET rpt_entity = true, has_board = $2, updated_at = now()
            WHERE id = $1 AND status <> 'merged' RETURNING name`, [partyId, input.hasBoard]);
        if (!r.rows[0]) throw new DomainError("NOT_FOUND", "取引先が見つかりません");
        await recordAudit(client, { actor, action: "rpt.entity.save", targetType: "party", targetId: partyId,
                                    detail: { hasBoard: input.hasBoard } });
      });
      return this.masters();
    } catch (error) { throw translate(error); }
  }

  async voidEntity(partyId: number, actor: string) {
    try {
      await inTransaction(this.database, async (client) => {
        await client.query("UPDATE parties SET rpt_entity = false, updated_at = now() WHERE id = $1", [partyId]);
        await recordAudit(client, { actor, action: "rpt.entity.void", targetType: "party", targetId: partyId, detail: {} });
      });
      return this.masters();
    } catch (error) { throw translate(error); }
  }

  /** 株主構成を丸ごと差し替える。合計が 100% を超えるなら保存させない。 */
  async setShareholdings(
    partyId: number,
    list: Array<{ holderKind: "party" | "officer"; holderId: number; pct: number }>,
    actor: string
  ) {
    const total = list.reduce((s, x) => s + Number(x.pct || 0), 0);
    if (total > 100.0001) throw new DomainError("VALIDATION", `議決権の合計が ${total}% で 100% を超えています`);
    for (const x of list) {
      if (!(Number(x.pct) > 0 && Number(x.pct) <= 100)) throw new DomainError("VALIDATION", "議決権は 0 より大きく 100 以下で入れてください");
      if (x.holderKind === "party" && Number(x.holderId) === partyId) throw new DomainError("VALIDATION", "自社を自社の株主にはできません");
    }
    const keys = list.map((x) => `${x.holderKind}:${x.holderId}`);
    if (new Set(keys).size !== keys.length) throw new DomainError("VALIDATION", "同じ株主が2回入っています");
    try {
      await inTransaction(this.database, async (client) => {
        const before = await client.query(
          "SELECT holder_kind, holder_party_id, holder_officer_id, voting_pct FROM party_shareholdings WHERE party_id = $1",
          [partyId]);
        await client.query("DELETE FROM party_shareholdings WHERE party_id = $1", [partyId]);
        for (const x of list) {
          await client.query(
            `INSERT INTO party_shareholdings (party_id, holder_kind, holder_party_id, holder_officer_id, voting_pct)
             VALUES ($1, $2, $3, $4, $5)`,
            [partyId, x.holderKind, x.holderKind === "party" ? x.holderId : null,
             x.holderKind === "officer" ? x.holderId : null, x.pct]);
        }
        await recordAudit(client, { actor, action: "rpt.shareholdings.replace", targetType: "party", targetId: partyId,
                                    detail: { before: before.rows, after: list } });
      });
      return this.masters();
    } catch (error) { throw translate(error); }
  }

  /** 役員を足す・直す。役職は丸ごと差し替える。 */
  async saveOfficer(
    input: { id?: number; name: string; staffId?: number | null; roles: Array<{ partyId: number; title: string }> },
    actor: string
  ) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new DomainError("VALIDATION", "役員の氏名は空にできません");
    for (const r of input.roles) {
      if (!(OFFICER_TITLES as readonly string[]).includes(r.title)) throw new DomainError("VALIDATION", `役職 ${r.title} は使えません`);
    }
    try {
      await inTransaction(this.database, async (client) => {
        let id = input.id ?? null;
        if (id) {
          const r = await client.query("UPDATE officers SET name = $2, staff_id = $3, updated_at = now() WHERE id = $1 RETURNING id",
            [id, name, input.staffId ?? null]);
          if (!r.rows[0]) throw new DomainError("NOT_FOUND", "役員が見つかりません");
        } else {
          // 職員なら職員コード、社外の人なら氏名を鍵にする（V1 と同じ）。
          const key = input.staffId
            ? String(((await client.query("SELECT staff_code FROM staff WHERE id = $1", [input.staffId])).rows[0] as any)?.staff_code ?? `staff:${input.staffId}`)
            : name;
          const r = await client.query(
            `INSERT INTO officers (officer_key, name, staff_id) VALUES ($1, $2, $3)
             ON CONFLICT (officer_key) DO UPDATE SET name = EXCLUDED.name, voided_at = NULL, updated_at = now()
             RETURNING id`, [key, name, input.staffId ?? null]);
          id = Number((r.rows[0] as any).id);
        }
        const before = await client.query("SELECT party_id, title FROM officer_roles WHERE officer_id = $1", [id]);
        await client.query("DELETE FROM officer_roles WHERE officer_id = $1", [id]);
        for (const r of input.roles) {
          await client.query(
            `INSERT INTO officer_roles (officer_id, party_id, title, is_director) VALUES ($1, $2, $3, $4)
             ON CONFLICT (officer_id, party_id, title) DO NOTHING`,
            [id, r.partyId, r.title, ["代表取締役", "取締役", "社外取締役"].includes(r.title)]);
        }
        await recordAudit(client, { actor, action: "rpt.officer.save", targetType: "officer", targetId: id,
                                    detail: { name, rolesBefore: before.rows, rolesAfter: input.roles } });
      });
      return this.masters();
    } catch (error) { throw translate(error); }
  }

  async voidOfficer(id: number, actor: string) {
    try {
      await inTransaction(this.database, async (client) => {
        await client.query("UPDATE officers SET voided_at = now(), updated_at = now() WHERE id = $1", [id]);
        await recordAudit(client, { actor, action: "rpt.officer.void", targetType: "officer", targetId: id, detail: {} });
      });
      return this.masters();
    } catch (error) { throw translate(error); }
  }

  async saveThresholds(input: { company: number | null; person: number | null }, actor: string) {
    for (const v of [input.company, input.person]) {
      if (v !== null && !(Number.isFinite(v) && v >= 0)) throw new DomainError("VALIDATION", "基準額は 0 以上の数で入れてください");
    }
    try {
      await inTransaction(this.database, async (client) => {
        await client.query(
          `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [RPT_THRESHOLDS_KEY, JSON.stringify(input), actor]);
        await recordAudit(client, { actor, action: "rpt.thresholds.save", targetType: "settings", detail: input });
      });
      return this.thresholds();
    } catch (error) { throw translate(error); }
  }

  // ---------------------------------------------------------------- 判定

  async judge(input: JudgeInput, client: Queryable = this.database): Promise<Judgement> {
    const a = parseRef(input.a), b = parseRef(input.b);
    if (a.kind === b.kind && a.id === b.id) throw new DomainError("VALIDATION", "当事者 A と B が同じです");
    if (!TXN_TYPES.some((t) => t.id === input.txn)) throw new DomainError("VALIDATION", "取引種別を選んでください");
    const amount = num(input.amount);
    if (amount !== null && !(Number.isFinite(amount) && amount >= 0)) throw new DomainError("VALIDATION", "金額が正しくありません");
    const entities = await this.entities(client);
    const officers = await this.officers(client);
    const saved = await this.thresholds(client);
    const engine = new RptEngine(RptService.toEngine(entities, officers));
    return engine.judge({
      a, b, txn: input.txn, amount, competing: Boolean(input.competing),
      thresholds: {
        company: input.thresholds?.company !== undefined ? num(input.thresholds.company) : saved.company,
        person: input.thresholds?.person !== undefined ? num(input.thresholds.person) : saved.person
      }
    });
  }

  // ---------------------------------------------------------------- 議案

  /**
   * 判定を取締役会の議案として起票する。サーバで判定し直し、稟議の B- 番号を振る。
   * 番号は B- の最大の次（V1 と同じ）。同時に起票しても重ならないよう、鍵を取ってから数える。
   */
  async fileAgenda(input: JudgeInput & { meetingOn?: string | null; note?: string | null }, actor: string) {
    const meetingOn = str(input.meetingOn)?.trim() || null;
    if (meetingOn && !/^\d{4}-\d{2}-\d{2}$/.test(meetingOn)) throw new DomainError("VALIDATION", "取締役会の日付は YYYY-MM-DD で入れてください");
    try {
      return await inTransaction(this.database, async (client) => {
        const j = await this.judge(input, client);
        await client.query("SELECT pg_advisory_xact_lock(hashtext('v3.ringi.board_resolution'))");
        const max = await client.query(
          `SELECT COALESCE(max(substring(ringi_no from 3)::int), 0) AS n FROM ringi WHERE ringi_no LIKE 'B-%'`);
        const ringiNo = `B-${String(Number((max.rows[0] as any).n) + 1).padStart(5, "0")}`;
        const title = `${j.aLabel} ⇄ ${j.bLabel}（${txnLabel(j.txn)}）`;
        const r = await client.query(
          `INSERT INTO ringi (ringi_no, decision_type, title, category, status, total_budget, created_by)
           VALUES ($1, 'board_resolution', $2, '関連当事者取引', 'open', $3, $4) RETURNING id`,
          [ringiNo, title, j.amount, actor]);
        const ringiId = Number((r.rows[0] as any).id);
        const excluded = [...new Set(Object.values(j.method).flatMap((m) => m.excluded))];
        const entity = [j.a, j.b].find((p) => p.kind === "company");
        await client.query(
          `INSERT INTO ringi_related_party (ringi_id, party_id, meeting_on, txn_type, party_a, party_b, amount_ex_tax,
                                            is_conflict, is_related_party, related_category, conflict_types,
                                            excluded_officers, judgement, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14)`,
          [ringiId, entity ? Number(entity.id) : null, meetingOn, j.txn, j.aLabel, j.bLabel, j.amount,
           j.conflict.hit, j.disclosure.related, j.disclosure.rel?.category ?? null,
           JSON.stringify([...new Set(j.conflict.findings.map((f) => f.type))]),
           JSON.stringify(excluded), JSON.stringify(j), str(input.note)?.trim() || null]);
        await recordAudit(client, { actor, action: "rpt.agenda.file", targetType: "ringi", targetId: ringiId,
                                    detail: { ringiNo, title, isConflict: j.conflict.hit, isRelatedParty: j.disclosure.related } });
        return { ringiId, ringiNo, title, judgement: j };
      });
    } catch (error) { throw translate(error); }
  }

  async agenda(options: { from?: string; to?: string } = {}): Promise<AgendaItem[]> {
    const params: unknown[] = [];
    const where = ["r.decision_type = 'board_resolution'"];
    if (options.from && /^\d{4}-\d{2}-\d{2}$/.test(options.from)) { params.push(options.from); where.push(`x.meeting_on >= $${params.length}`); }
    if (options.to && /^\d{4}-\d{2}-\d{2}$/.test(options.to)) { params.push(options.to); where.push(`x.meeting_on <= $${params.length}`); }
    try {
      const r = await this.database.query(
        `SELECT r.id, r.ringi_no, r.title, r.created_at, x.meeting_on, x.txn_type, x.party_a, x.party_b,
                x.amount_ex_tax, x.is_conflict, x.is_related_party, x.related_category, x.excluded_officers,
                x.rp_status, x.note
           FROM ringi r JOIN ringi_related_party x ON x.ringi_id = r.id
          WHERE ${where.join(" AND ")}
          ORDER BY x.meeting_on DESC NULLS FIRST, r.ringi_no DESC LIMIT 500`, params);
      return (r.rows as any[]).map((x) => ({
        ringiId: Number(x.id), ringiNo: String(x.ringi_no), title: String(x.title), meetingOn: dateStr(x.meeting_on),
        txnType: String(x.txn_type), partyA: String(x.party_a), partyB: String(x.party_b),
        amountExTax: x.amount_ex_tax === null ? null : Number(x.amount_ex_tax),
        isConflict: Boolean(x.is_conflict), isRelatedParty: Boolean(x.is_related_party),
        relatedCategory: str(x.related_category),
        excludedOfficers: Array.isArray(x.excluded_officers) ? x.excluded_officers.map(String) : [],
        status: x.rp_status as AgendaStatus, note: str(x.note),
        createdAt: x.created_at ? new Date(x.created_at).toISOString() : null
      }));
    } catch (error) { throw translate(error); }
  }

  /** 議案の判定書（起票したときのもの）。 */
  async agendaJudgement(ringiId: number): Promise<Judgement | null> {
    const r = await this.database.query("SELECT judgement FROM ringi_related_party WHERE ringi_id = $1", [ringiId]);
    const j = (r.rows[0] as any)?.judgement;
    return j && Object.keys(j).length ? (j as Judgement) : null;
  }

  async setAgendaStatus(ringiId: number, input: { status: string; meetingOn?: string | null; note?: string | null }, actor: string) {
    if (!(AGENDA_STATUSES as readonly string[]).includes(input.status)) throw new DomainError("VALIDATION", `状態 ${input.status} は使えません`);
    const status = input.status as AgendaStatus;
    const meetingOn = input.meetingOn === undefined ? undefined : (str(input.meetingOn)?.trim() || null);
    if (meetingOn && !/^\d{4}-\d{2}-\d{2}$/.test(meetingOn)) throw new DomainError("VALIDATION", "取締役会の日付は YYYY-MM-DD で入れてください");
    try {
      await inTransaction(this.database, async (client) => {
        const before = await client.query("SELECT rp_status FROM ringi_related_party WHERE ringi_id = $1 FOR UPDATE", [ringiId]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", "議案が見つかりません");
        await client.query(
          `UPDATE ringi_related_party
              SET rp_status = $2, meeting_on = CASE WHEN $3::boolean THEN $4::date ELSE meeting_on END,
                  note = COALESCE($5, note), updated_at = now()
            WHERE ringi_id = $1`,
          [ringiId, status, meetingOn !== undefined, meetingOn ?? null, str(input.note)?.trim() || null]);
        await client.query(
          `UPDATE ringi SET status = $2,
                  approved_on = CASE WHEN $2 = 'approved'
                                     THEN COALESCE(approved_on, $3::date,
                                                   (SELECT meeting_on FROM ringi_related_party WHERE ringi_id = $1),
                                                   current_date)
                                     ELSE approved_on END,
                  updated_at = now()
            WHERE id = $1`, [ringiId, RINGI_STATUS_OF[status], meetingOn ?? null]);
        await recordAudit(client, { actor, action: "rpt.agenda.status", targetType: "ringi", targetId: ringiId,
                                    detail: { from: (before.rows[0] as any).rp_status, to: status } });
      });
      return (await this.agenda()).find((a) => a.ringiId === ringiId) ?? null;
    } catch (error) { throw translate(error); }
  }
}
