import { inTransaction, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { CONDITION_KINDS_BY_MATTER } from "./link-service.js";

export type MatterKind = "work" | "outsourcing" | "single";
export type MatterStatus = "open" | "waiting" | "blocked" | "done" | "canceled";

export interface MatterInput {
  title: string;
  /** 進め方。他社レビュー／自社ドラフト／自社テンプレート。 */
  documentStyle?: "counterparty_review" | "own_draft" | "own_template" | null;
  /** 取引モデル。必須項目も使えるテンプレートもこれが決める制御列。 */
  kind: MatterKind;
  ownerStaffId?: number | null;
  counterpartyId?: number | null;
  requesterEmail?: string | null;
  dueOn?: string | null;
  remarks?: string | null;
  matterNo?: string | null;
}

export interface TaskInput {
  title: string;
  taskType?: string | null;
  description?: string | null;
  assigneeStaffId?: number | null;
  dueAt?: string | null;
}

/** 案件番号の採番規則。条件から作る経路でも同じ番号帯を使う。 */
export const MATTER_NUMBER = { prefix: "MTR", table: "matters", column: "matter_no" };
const NUMBER = MATTER_NUMBER;

export class MatterWriteService {
  constructor(private readonly database: Transactable) {}

  /**
   * 案件の登録。案件は制御レイヤーなので、条件・文書・支払を持たない空の器として作る。
   * 中身は後からぶら下げる。
   */
  async create(input: MatterInput, actor: string): Promise<{ id: number; matterNo: string | null }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "案件名は必須です");
    if (!["work", "outsourcing", "single"].includes(input.kind)) {
      throw new DomainError("VALIDATION", "取引モデルは work / outsourcing / single のいずれかです");
    }

    try {
      return await inTransaction(this.database, async (client) => {
        if (input.counterpartyId) {
          const p = await client.query("SELECT id FROM parties WHERE id = $1", [input.counterpartyId]);
          if (!p.rows[0]) {
            throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);
          }
        }
        if (input.ownerStaffId) {
          const s = await client.query("SELECT id FROM staff WHERE id = $1", [input.ownerStaffId]);
          if (!s.rows[0]) {
            throw new DomainError("NOT_FOUND", `担当者 ${input.ownerStaffId} が見つかりません`);
          }
        }

        const no = String(input.matterNo ?? "").trim() || await allocateNumber(client, NUMBER);
        const inserted = await client.query(
          `INSERT INTO matters (matter_no, title, kind, status, owner_staff_id, counterparty_id,
                                requester_email, due_on, remarks, document_style, created_by)
           VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, matter_no`,
          [no, title, input.kind, input.ownerStaffId ?? null, input.counterpartyId ?? null,
           input.requesterEmail ?? null, input.dueOn ?? null, input.remarks ?? null,
           input.documentStyle ?? null, actor]);
        const row = inserted.rows[0] as { id: number; matter_no: string | null };
        const id = Number(row.id);

        await recordAudit(client, {
          actor, action: "matter.create", targetType: "matter", targetId: id,
          detail: { title, kind: input.kind, matterNo: row.matter_no,
                    counterpartyId: input.counterpartyId ?? null }
        });
        return { id, matterNo: row.matter_no };
      });
    } catch (error) { throw translate(error); }
  }

  /** 案件の状態変更。blocked にするときは理由が要る（CHECK 制約と同じ規則）。 */
  async changeStatus(
    id: number, status: MatterStatus, actor: string, blockedReason?: string | null
  ) {
    const reason = String(blockedReason ?? "").trim() || null;
    if (status === "blocked" && !reason) {
      throw new DomainError("VALIDATION", "止める理由を書いてください。理由なしでは止められません");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await client.query("SELECT status FROM matters WHERE id = $1", [id]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);

        await client.query(
          `UPDATE matters SET status = $2,
                  blocked_reason = CASE WHEN $2 = 'blocked' THEN $3 ELSE NULL END,
                  closed_at = CASE WHEN $2 IN ('done','canceled') THEN now() ELSE NULL END,
                  updated_at = now()
            WHERE id = $1`, [id, status, reason]);

        await recordAudit(client, {
          actor, action: "matter.change_status", targetType: "matter", targetId: id,
          detail: { from: (before.rows[0] as { status: string }).status, to: status, reason }
        });
        return { id, status };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 案件の担当者を決める・付け替える。
   *
   * これまで案件を作るときにしか設定できず、あとから直す経路が無かった。
   * 検収書の【ご連絡先】は案件の担当者から部署・氏名・メールを差すので、
   * 担当者が空の案件から出した書類は連絡先が丸ごと空になる。それなのに
   * 埋める手段が無かった（移行してきた案件はここが空のことがある）。
   *
   * null を渡すと外せる。外すとその案件から出す書類の連絡先が空になるので、
   * 外すのは付け替えの途中だけにしたい。
   */
  async changeOwner(id: number, ownerStaffId: number | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await client.query(
          "SELECT owner_staff_id FROM matters WHERE id = $1", [id]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);

        let name: string | null = null;
        if (ownerStaffId !== null) {
          // 実在と在籍を確かめる。退職者を担当にすると、その名前が書類に出る。
          const staff = await client.query(
            "SELECT id, name, status FROM staff WHERE id = $1", [ownerStaffId]);
          const row = staff.rows[0] as { name: string; status: string } | undefined;
          if (!row) throw new DomainError("NOT_FOUND", `担当者 ${ownerStaffId} が見つかりません`);
          if (row.status !== "active") {
            throw new DomainError("VALIDATION",
              `${row.name} は退職になっています。書類に出る担当者なので、在籍している人を選んでください`);
          }
          name = row.name;
        }

        await client.query(
          "UPDATE matters SET owner_staff_id = $2, updated_at = now() WHERE id = $1",
          [id, ownerStaffId]);
        await recordAudit(client, {
          actor, action: "matter.change_owner", targetType: "matter", targetId: id,
          detail: {
            from: (before.rows[0] as { owner_staff_id: number | null }).owner_staff_id,
            to: ownerStaffId, name
          }
        });
        return { id, ownerStaffId, ownerName: name };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 進め方の設定・変更。取引モデル（案件の種別）だけでは実際に何をするかが決まらないので、
   * 他社レビュー／自社ドラフト／自社テンプレートのどれで進めるかをここで決める。
   * 既存案件は未設定のまま残るので、後から入れられる必要がある。
   */
  async changeDocumentStyle(
    id: number, style: "counterparty_review" | "own_draft" | "own_template" | null, actor: string
  ) {
    if (style !== null && !["counterparty_review", "own_draft", "own_template"].includes(style)) {
      throw new DomainError("VALIDATION",
        "進め方は 他社文書レビュー型 / 自社ドラフト型 / 自社テンプレートドラフト型 のいずれかです");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await client.query(
          "SELECT document_style FROM matters WHERE id = $1", [id]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);

        await client.query(
          "UPDATE matters SET document_style = $2, updated_at = now() WHERE id = $1", [id, style]);
        await recordAudit(client, {
          actor, action: "matter.change_document_style", targetType: "matter", targetId: id,
          detail: { from: (before.rows[0] as { document_style: string | null }).document_style,
                    to: style }
        });
        return { id, documentStyle: style };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 取引モデルを変える。
   *
   * 取引モデルは案件が扱うものを決めるので、作るときに間違えると後戻りできなかった。
   * 実際には「文書作成のつもりが委託だった」がよく起きる。
   *
   * すでに繋がっている条件の種類が新しいモデルで使えないときは断る。黙って変えると、
   * 案件から辿れるのに新しく繋ぎ直せない条件が残る。外してから変えてもらう。
   */
  async changeKind(id: number, kind: MatterKind, actor: string) {
    if (!["work", "outsourcing", "single"].includes(kind)) {
      throw new DomainError("VALIDATION", "取引モデルは ライセンス / 業務委託 / 文書作成 のいずれかです");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const before = await client.query(
          "SELECT kind FROM matters WHERE id = $1 FOR UPDATE", [id]);
        if (!before.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);
        const from = String((before.rows[0] as { kind: string }).kind);
        if (from === kind) return { id, kind };

        const allowed = CONDITION_KINDS_BY_MATTER[kind] ?? [];
        const linked = await client.query(
          `SELECT DISTINCT c.kind, c.condition_no
             FROM matter_links l
             JOIN conditions c ON c.id::text = l.target_ref
            WHERE l.matter_id = $1 AND l.target_type = 'condition'`, [id]);
        const stuck = (linked.rows as Array<{ kind: string; condition_no: string | null }>)
          .filter((r) => !allowed.some((a) => a.value === r.kind));
        if (stuck.length) {
          throw new DomainError("CONFLICT",
            `繋がっている条件が新しい取引モデルで使えません（${
              stuck.map((r) => r.condition_no ?? r.kind).join("・")}）。` +
            "先に条件を外してから変えてください");
        }

        await client.query(
          "UPDATE matters SET kind = $2, updated_at = now() WHERE id = $1", [id, kind]);
        await recordAudit(client, {
          actor, action: "matter.change_kind", targetType: "matter", targetId: id,
          detail: { from, to: kind }
        });
        return { id, kind };
      });
    } catch (error) { throw translate(error); }
  }

  async addTask(matterId: number, input: TaskInput, actor: string): Promise<{ id: number }> {
    const title = String(input.title ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "タスク名は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const m = await client.query("SELECT id FROM matters WHERE id = $1", [matterId]);
        if (!m.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${matterId} が見つかりません`);

        const inserted = await client.query(
          `INSERT INTO tasks (matter_id, title, task_type, description, assignee_staff_id, due_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'todo') RETURNING id`,
          [matterId, title, input.taskType ?? null, input.description ?? null,
           input.assigneeStaffId ?? null, input.dueAt ?? null]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "matter.add_task", targetType: "matter", targetId: matterId,
          detail: { taskId: id, title, dueAt: input.dueAt ?? null }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }
}
