import { inTransaction, dateStr, int, str, type Queryable, type Transactable } from "../core/db.js";
import { termHistory } from "../agreements/term-history.js";
import { type BusinessLine, composeMatterTitle } from "./title.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { allocateNumber } from "../core/numbering.js";
import { CONDITION_KINDS_BY_MATTER } from "./link-service.js";

export type MatterKind = "work" | "outsourcing" | "single";
export type MatterStatus = "open" | "waiting" | "blocked" | "done" | "canceled";

export interface MatterInput {
  /** 件名。空なら軸（作品か業務）から組む（title.ts）。その他案件は必須。 */
  title?: string | null;
  /** 作品案件の軸。 */
  workId?: number | null;
  /** 業務案件の事業区分と業務名。 */
  businessLine?: BusinessLine | null;
  businessName?: string | null;
  /** 作品案件に制作委託があるか。null は未決定。 */
  production?: boolean | null;
  /** 親案件（プロジェクト）。 */
  parentId?: number | null;
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
    const manualTitle = String(input.title ?? "").trim();
    if (!["work", "outsourcing", "single"].includes(input.kind)) {
      throw new DomainError("VALIDATION", "案件の種類は 作品案件 / 業務案件 / その他案件 のいずれかです");
    }
    // 軸。作品案件は作品、業務案件は事業区分と業務名。その他は件名を人が打つ。
    if (input.kind === "work" && !input.workId) {
      throw new DomainError("VALIDATION", "作品案件は作品を選んでください（作品 1 つが 1 案件）");
    }
    if (input.kind === "outsourcing" && (!input.businessLine || !String(input.businessName ?? "").trim())) {
      throw new DomainError("VALIDATION", "業務案件は事業区分（出版事業／ボードゲーム事業／イベント事業／店舗事業／管理事業／その他）と業務名を入れてください");
    }
    if (input.kind === "single" && !manualTitle) {
      throw new DomainError("VALIDATION", "その他案件は件名を入れてください");
    }
    // 相手先と担当者。契約の当て・契約チェック・期限の通知はここに依存する。
    if (input.kind !== "single" && !input.counterpartyId) {
      throw new DomainError("VALIDATION", "相手先を選んでください（作品案件は最初の相手先 1 社）");
    }
    if (!input.ownerStaffId) {
      throw new DomainError("VALIDATION", "担当者を選んでください（期限の通知先になります）");
    }

    try {
      return await inTransaction(this.database, async (client) => {
        let partyName: string | null = null;
        if (input.counterpartyId) {
          const p = await client.query("SELECT id, name FROM parties WHERE id = $1", [input.counterpartyId]);
          if (!p.rows[0]) {
            throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);
          }
          partyName = String((p.rows[0] as { name: string }).name);
        }
        if (input.ownerStaffId) {
          const s = await client.query("SELECT id FROM staff WHERE id = $1", [input.ownerStaffId]);
          if (!s.rows[0]) {
            throw new DomainError("NOT_FOUND", `担当者 ${input.ownerStaffId} が見つかりません`);
          }
        }
        let workTitle: string | null = null;
        if (input.workId) {
          const w = await client.query("SELECT id, title FROM works WHERE id = $1", [input.workId]);
          if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${input.workId} が見つかりません`);
          workTitle = String((w.rows[0] as { title: string }).title);
        }
        if (input.parentId) await assertParentOk(client, null, input.parentId);

        const composed = composeMatterTitle({
          kind: input.kind, workTitle, production: input.production ?? null,
          businessLine: input.businessLine ?? null, partyName, businessName: input.businessName ?? null
        });
        const title = manualTitle || composed;
        if (!title) throw new DomainError("VALIDATION", "件名を入れてください");

        const no = String(input.matterNo ?? "").trim() || await allocateNumber(client, NUMBER);
        const inserted = await client.query(
          `INSERT INTO matters (matter_no, title, kind, status, owner_staff_id, counterparty_id,
                                requester_email, due_on, remarks, document_style, created_by,
                                work_id, business_line, business_name, production, parent_id, title_manual)
           VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING id, matter_no`,
          [no, title, input.kind, input.ownerStaffId ?? null, input.counterpartyId ?? null,
           input.requesterEmail ?? null, input.dueOn ?? null, input.remarks ?? null,
           input.documentStyle ?? null, actor,
           input.workId ?? null, input.businessLine ?? null, str(input.businessName),
           input.production ?? null, input.parentId ?? null, Boolean(manualTitle)]);
        const row = inserted.rows[0] as { id: number; matter_no: string | null };
        const id = Number(row.id);

        await recordAudit(client, {
          actor, action: "matter.create", targetType: "matter", targetId: id,
          detail: { title, kind: input.kind, matterNo: row.matter_no,
                    counterpartyId: input.counterpartyId ?? null, workId: input.workId ?? null,
                    businessLine: input.businessLine ?? null, parentId: input.parentId ?? null }
        });
        return { id, matterNo: row.matter_no };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 軸を直す（作品・事業区分・業務名・制作委託・件名）。件名を空で渡すと
   * 軸から組み直す。人が打った件名は title_manual が立ち、以後は組み直さない。
   */
  async updateAxis(
    id: number,
    patch: { title?: string | null; workId?: number | null; businessLine?: BusinessLine | null;
             businessName?: string | null; production?: boolean | null },
    actor: string
  ) {
    try {
      return await inTransaction(this.database, async (client) => {
        const cur = (await client.query(
          `SELECT m.id, m.kind, m.title, m.title_manual, m.work_id, m.business_line, m.business_name,
                  m.production, p.name AS party_name
             FROM matters m LEFT JOIN parties p ON p.id = m.counterparty_id
            WHERE m.id = $1 FOR UPDATE OF m`, [id])).rows[0] as any;
        if (!cur) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);

        const workId = patch.workId !== undefined ? patch.workId : (cur.work_id ? Number(cur.work_id) : null);
        let workTitle: string | null = null;
        if (workId) {
          const w = await client.query("SELECT title FROM works WHERE id = $1", [workId]);
          if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${workId} が見つかりません`);
          workTitle = String((w.rows[0] as { title: string }).title);
        }
        const businessLine = patch.businessLine !== undefined ? patch.businessLine : (str(cur.business_line) as BusinessLine | null);
        const businessName = patch.businessName !== undefined ? str(patch.businessName) : str(cur.business_name);
        const production = patch.production !== undefined ? patch.production
          : (cur.production === null || cur.production === undefined ? null : Boolean(cur.production));

        // 件名。明示の指定があればそれ（title_manual）。空文字なら自動に戻す。
        let title = String(cur.title);
        let manual = cur.title_manual === true;
        if (patch.title !== undefined) {
          const t = String(patch.title ?? "").trim();
          if (t) { title = t; manual = true; } else { manual = false; }
        }
        if (!manual) {
          const composed = composeMatterTitle({
            kind: cur.kind, workTitle, production, businessLine, partyName: str(cur.party_name), businessName
          });
          if (composed) title = composed;
        }

        await client.query(
          `UPDATE matters SET title = $2, title_manual = $3, work_id = $4, business_line = $5,
                  business_name = $6, production = $7, updated_at = now()
            WHERE id = $1`,
          [id, title, manual, workId, businessLine, businessName, production]);
        await recordAudit(client, {
          actor, action: "matter.update_axis", targetType: "matter", targetId: id,
          detail: { title, titleManual: manual, workId, businessLine, businessName, production }
        });
        return { id, title, titleManual: manual, workId, businessLine, businessName, production };
      });
    } catch (error) { throw translate(error); }
  }

  /** 親案件を付ける・外す。自分や子孫を親にはできない（輪になる）。 */
  async setParent(id: number, parentId: number | null, actor: string) {
    try {
      return await inTransaction(this.database, async (client) => {
        const cur = await client.query("SELECT id, parent_id FROM matters WHERE id = $1 FOR UPDATE", [id]);
        if (!cur.rows[0]) throw new DomainError("NOT_FOUND", `案件 ${id} が見つかりません`);
        if (parentId) await assertParentOk(client, id, parentId);
        await client.query("UPDATE matters SET parent_id = $2, updated_at = now() WHERE id = $1", [id, parentId]);
        await recordAudit(client, {
          actor, action: "matter.set_parent", targetType: "matter", targetId: id,
          detail: { from: (cur.rows[0] as any).parent_id ?? null, to: parentId }
        });
        return { id, parentId };
      });
    } catch (error) { throw translate(error); }
  }

  /** 関連（並列）を付ける・外す。案件そのものは独立のまま。 */
  async relate(id: number, otherId: number, actor: string, remove = false) {
    if (id === otherId) throw new DomainError("VALIDATION", "自分自身とは関連にできません");
    const [a, b] = id < otherId ? [id, otherId] : [otherId, id];
    try {
      return await inTransaction(this.database, async (client) => {
        const both = await client.query("SELECT id FROM matters WHERE id = ANY($1::bigint[])", [[a, b]]);
        if (both.rows.length !== 2) throw new DomainError("NOT_FOUND", "関連にする案件が見つかりません");
        if (remove) {
          await client.query("DELETE FROM matter_relations WHERE a_id = $1 AND b_id = $2", [a, b]);
        } else {
          await client.query(
            `INSERT INTO matter_relations (a_id, b_id, created_by) VALUES ($1, $2, $3)
             ON CONFLICT (a_id, b_id) DO NOTHING`, [a, b, actor]);
        }
        await recordAudit(client, {
          actor, action: remove ? "matter.unrelate" : "matter.relate", targetType: "matter", targetId: id,
          detail: { otherId }
        });
        return { id, otherId, related: !remove };
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

        // 完了は、付帯する契約が全部終わり、子の案件が全部完了してから。
        // 時限払い・製造時払い・料率は契約が終わるまで回るので、案件だけ閉じると
        // 支払文書処理から見えなくなる。
        if (status === "done") {
          const live = await liveAgreementsOf(client, id);
          if (live.length) {
            throw new DomainError("CONFLICT",
              `付帯する契約がまだ生きています（${live.map((a) => a.agreementNo ?? `#${a.id}`).join("・")}）。` +
              "満了・解除・不更新を契約の画面で記録してから完了にしてください");
          }
          const kids = await client.query(
            `SELECT matter_no, title FROM matters WHERE parent_id = $1 AND status NOT IN ('done', 'canceled')`, [id]);
          if (kids.rows.length) {
            throw new DomainError("CONFLICT",
              `子の案件がまだ開いています（${(kids.rows as any[]).map((k) => k.matter_no ?? k.title).join("・")}）。` +
              "先に子を完了にしてください");
          }
        }

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
      throw new DomainError("VALIDATION", "案件の種類は 作品案件 / 業務案件 / その他案件 のいずれかです");
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


// ---------------------------------------------------------------------------

/** 親にできるか。自分自身・自分の子孫は不可（輪になる）。 */
async function assertParentOk(client: Queryable, selfId: number | null, parentId: number): Promise<void> {
  const p = await client.query("SELECT id, parent_id FROM matters WHERE id = $1", [parentId]);
  if (!p.rows[0]) throw new DomainError("NOT_FOUND", `親の案件 ${parentId} が見つかりません`);
  if (selfId === null) return;
  if (parentId === selfId) throw new DomainError("VALIDATION", "自分自身を親にはできません");
  // 親を上へ辿って自分に当たれば輪。
  let cur: number | null = int((p.rows[0] as any).parent_id);
  for (let i = 0; cur !== null && i < 50; i += 1) {
    if (cur === selfId) throw new DomainError("VALIDATION", "自分の子孫を親にはできません（輪になります）");
    const up = await client.query("SELECT parent_id FROM matters WHERE id = $1", [cur]);
    cur = up.rows[0] ? int((up.rows[0] as any).parent_id) : null;
  }
}

/**
 * 案件に付帯する契約のうち生きているもの。条件の合意と文書の合意から辿る。
 * 「生きている」＝締結済みで、解除されておらず、いまの終了日（更新履歴の最終行）が来ていない。
 */
export async function liveAgreementsOf(
  client: Queryable, matterId: number
): Promise<Array<{ id: number; agreementNo: string | null; kind: string; currentEnd: string | null }>> {
  const r = await client.query(
    `SELECT DISTINCT a.id, a.agreement_no, a.status, a.effective_on, a.executed_on, a.expires_on,
            a.auto_renewal, a.renewal_months, a.renewal_stopped_on, a.terminated_on, a.kind
       FROM agreements a
      WHERE a.status = 'executed' AND a.terminated_on IS NULL
        AND COALESCE(a.kind, 'master') IN ('master', 'standalone', 'supplement')
        AND (a.id IN (SELECT c.agreement_id FROM matter_links ml
                        JOIN conditions c ON ml.target_type = 'condition' AND c.id::text = ml.target_ref
                       WHERE ml.matter_id = $1 AND c.agreement_id IS NOT NULL)
          OR a.id IN (SELECT d.agreement_id FROM documents d WHERE d.matter_id = $1 AND d.agreement_id IS NOT NULL))`,
    [matterId]);
  const today = new Date().toISOString().slice(0, 10);
  const out: Array<{ id: number; agreementNo: string | null; kind: string; currentEnd: string | null }> = [];
  for (const a of r.rows as any[]) {
    const h = termHistory({
      termStart: dateStr(a.effective_on) ?? dateStr(a.executed_on), termEnd: dateStr(a.expires_on),
      autoRenew: a.auto_renewal === true, renewMonths: int(a.renewal_months),
      renewStoppedOn: dateStr(a.renewal_stopped_on), terminatedOn: dateStr(a.terminated_on)
    }, today);
    if (h.currentEnd === null || h.currentEnd >= today) {
      out.push({ id: Number(a.id), agreementNo: str(a.agreement_no),
                 kind: String(a.kind ?? "master"), currentEnd: h.currentEnd });
    }
  }
  return out;
}
