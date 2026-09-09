/**
 * 画面と画面をつなぐ関連（ハブ）。
 *
 * これまで、繋ぐ操作は片側の画面にしか無かった。案件から条件は繋げるのに
 * 条件から案件は繋げない、案件から文書は繋げるのに文書から案件は繋げない。
 * 参照の向きは実装の都合であって、人がどちらから作業を始めるかとは関係ない。
 *
 * ここに関連の定義を1か所へ集め、どの画面からでも同じ操作ができるようにする。
 * 定義が持つのは「読む SQL」「繋ぐ SQL」「外す SQL」「候補を探す SQL」の4つ。
 * 参照の向き（案件 → 条件、文書 → 案件）はデータベースのまま変えない。
 */

import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";

export type EntityKind = "matter" | "condition" | "document" | "agreement" | "work" | "party";

export interface LinkItem {
  id: number;
  /** 番号。文書番号・条件番号・案件番号。 */
  code: string | null;
  label: string;
  /** 状態や種別など、行の右に薄く出す説明。 */
  note: string | null;
  /** 開く先の画面。押すとその画面へ飛ぶ。 */
  kind: EntityKind;
}

export interface RelationDefinition {
  /** 相手の種類。押したときに開く画面。 */
  target: EntityKind;
  label: string;
  /** 1件だけ持てる関連（合意・案件など）か、複数持てるか。 */
  single: boolean;
  /** 付け外しできるか。できないものは読むだけ（改訂の親子など）。 */
  editable: boolean;
  /** 付け外しの説明。画面にそのまま出す。 */
  hint?: string;
  list(client: Queryable, id: number): Promise<LinkItem[]>;
  attach?(client: Queryable, id: number, targetId: number): Promise<void>;
  detach?(client: Queryable, id: number, targetId: number): Promise<void>;
  candidates?(client: Queryable, id: number, keyword: string): Promise<LinkItem[]>;
}

const rows = (r: { rows: unknown[] }) => r.rows as Array<Record<string, any>>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const like = (keyword: string) => `%${keyword.trim()}%`;

// ---------------------------------------------------------------------------
// 行の形をそろえる
// ---------------------------------------------------------------------------

const asMatter = (r: Record<string, any>): LinkItem => ({
  id: Number(r.id), code: str(r.matter_no), label: String(r.title),
  note: [matterKindLabel(String(r.kind)), statusLabel(String(r.status))].filter(Boolean).join("／"),
  kind: "matter"
});

const asCondition = (r: Record<string, any>): LinkItem => ({
  id: Number(r.id), code: str(r.condition_no), label: String(r.name),
  note: [conditionKindLabel(String(r.kind)), statusLabel(String(r.status))].filter(Boolean).join("／"),
  kind: "condition"
});

const asDocument = (r: Record<string, any>): LinkItem => ({
  id: Number(r.id), code: str(r.document_no), label: String(r.label ?? "（種別なし）"),
  note: statusLabel(String(r.status)), kind: "document"
});

const asAgreement = (r: Record<string, any>): LinkItem => ({
  id: Number(r.id), code: str(r.agreement_no), label: String(r.title),
  note: [r.direction === "in" ? "IN" : "OUT", statusLabel(String(r.status))].join("／"),
  kind: "agreement"
});

const asParty = (r: Record<string, any>): LinkItem => ({
  id: Number(r.id), code: str(r.party_code), label: String(r.name),
  note: r.kind === "individual" ? "個人" : "法人", kind: "party"
});

const asWork = (r: Record<string, any>): LinkItem => ({
  id: Number(r.id), code: str(r.work_code), label: String(r.title),
  note: str(r.kind), kind: "work"
});

/** 状態は画面にそのまま出る。英語のまま出すと読めない。 */
const STATUS_LABEL: Record<string, string> = {
  // 案件
  open: "対応中", waiting: "待ち", blocked: "止まっている", done: "完了", canceled: "取り消し",
  // 条件
  draft: "下書き", active: "有効", scheduled: "適用待ち", superseded: "差し替え済み", void: "無効",
  // 文書
  issued: "発行済み",
  // 契約
  negotiating: "交渉中", executed: "締結済み", expired: "満了", terminated: "解約"
};
const statusLabel = (value: string) => STATUS_LABEL[value] ?? value;

const matterKindLabel = (kind: string) =>
  ({ work: "ライセンス", outsourcing: "業務委託", single: "文書作成" } as Record<string, string>)[kind] ?? kind;

const conditionKindLabel = (kind: string) =>
  ({ license: "許諾料", product: "製品", service: "委託料", expense: "実費", fee: "手数料" } as
    Record<string, string>)[kind] ?? kind;

// ---------------------------------------------------------------------------
// 共通の断片
// ---------------------------------------------------------------------------

const DOCUMENT_SELECT = `
  d.id, d.document_no, d.status,
  COALESCE(t.label, d.manual_inputs->>'documentKind') AS label
  FROM documents d
  LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id`;

async function assertExists(client: Queryable, table: string, id: number, name: string) {
  const r = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new DomainError("NOT_FOUND", `${name} ${id} が見つかりません`);
}

// ---------------------------------------------------------------------------
// 定義
// ---------------------------------------------------------------------------

export const RELATIONS: Record<EntityKind, Record<string, RelationDefinition>> = {
  matter: {
    conditions: {
      target: "condition", label: "条件明細", single: false, editable: false,
      hint: "この案件が扱う取引条件。契約書（合意）の明細にあたります。",
      list: async (c, id) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status
           FROM matter_links ml JOIN conditions co ON co.id::text = ml.target_ref
          WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
          ORDER BY co.id`, [id])).map(asCondition),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status
           FROM conditions co
          WHERE co.status NOT IN ('void', 'superseded')
            AND ($2 = '' OR co.name ILIKE $2 OR COALESCE(co.condition_no,'') ILIKE $2)
            AND NOT EXISTS (SELECT 1 FROM matter_links ml
                             WHERE ml.matter_id = $1 AND ml.target_type = 'condition'
                               AND ml.target_ref = co.id::text)
          ORDER BY co.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asCondition)
      // 付け外しは案件の画面（/matters/:id/conditions）が持つ。取引モデルと
      // 条件の種類の突き合わせがあるので、そちらに寄せる。
    },
    documents: {
      target: "document", label: "文書", single: false, editable: false,
      hint: "この案件で出した書類。",
      list: async (c, id) => rows(await c.query(
        `SELECT ${DOCUMENT_SELECT} WHERE d.matter_id = $1 ORDER BY d.id DESC`, [id])).map(asDocument),
      candidates: async (_c, _id, _q) => []
      // 付け外しは案件の画面（/matters/:id/documents）が持つ。
    }
  },

  condition: {
    agreement: {
      target: "agreement", label: "契約（合意）", single: true, editable: true,
      hint: "この条件が載っている契約。条件は契約の明細であって、それ自体が契約書ではありません。",
      list: async (c, id) => rows(await c.query(
        `SELECT a.id, a.agreement_no, a.title, a.direction, a.status
           FROM conditions co JOIN agreements a ON a.id = co.agreement_id
          WHERE co.id = $1`, [id])).map(asAgreement),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT a.id, a.agreement_no, a.title, a.direction, a.status
           FROM agreements a
          WHERE ($2 = '' OR a.title ILIKE $2 OR COALESCE(a.agreement_no,'') ILIKE $2)
            AND a.direction = (SELECT direction FROM conditions WHERE id = $1)
          ORDER BY a.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asAgreement),
      attach: async (c, id, targetId) => {
        await assertExists(c, "agreements", targetId, "契約");
        const d = await c.query(
          `SELECT co.direction AS cd, a.direction AS ad
             FROM conditions co, agreements a WHERE co.id = $1 AND a.id = $2`, [id, targetId]);
        const row = d.rows[0] as { cd: string; ad: string } | undefined;
        if (!row) throw new DomainError("NOT_FOUND", "条件または契約が見つかりません");
        if (row.cd !== row.ad) {
          throw new DomainError("VALIDATION",
            "向きが違う契約には載せられません（IN の条件は IN の契約へ）");
        }
        await c.query("UPDATE conditions SET agreement_id = $2 WHERE id = $1", [id, targetId]);
      },
      detach: async (c, id) => {
        await c.query("UPDATE conditions SET agreement_id = NULL WHERE id = $1", [id]);
      }
    },
    matters: {
      target: "matter", label: "案件", single: false, editable: false,
      hint: "この条件を扱っている案件。付け外しは上の「案件」からできます。",
      list: async (c, id) => rows(await c.query(
        `SELECT m.id, m.matter_no, m.title, m.kind, m.status
           FROM matter_links ml JOIN matters m ON m.id = ml.matter_id
          WHERE ml.target_type = 'condition' AND ml.target_ref = $1::text
          ORDER BY m.id`, [id])).map(asMatter),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT m.id, m.matter_no, m.title, m.kind, m.status
           FROM matters m
          WHERE ($2 = '' OR m.title ILIKE $2 OR COALESCE(m.matter_no,'') ILIKE $2)
            AND NOT EXISTS (SELECT 1 FROM matter_links ml
                             WHERE ml.matter_id = m.id AND ml.target_type = 'condition'
                               AND ml.target_ref = $1::text)
          ORDER BY m.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asMatter)
      // 付け外しは /conditions/:id/matters（案件を作る経路も持つ）に任せる。
    },
    documents: {
      target: "document", label: "文書", single: false, editable: true,
      hint: "この条件から出した書類。",
      list: async (c, id) => rows(await c.query(
        `SELECT ${DOCUMENT_SELECT}
           JOIN document_conditions dc ON dc.document_id = d.id
          WHERE dc.condition_id = $1 ORDER BY d.id DESC`, [id])).map(asDocument),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT ${DOCUMENT_SELECT}
          WHERE d.status <> 'void'
            AND ($2 = '' OR COALESCE(d.document_no,'') ILIKE $2)
            AND NOT EXISTS (SELECT 1 FROM document_conditions dc
                             WHERE dc.document_id = d.id AND dc.condition_id = $1)
          ORDER BY d.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asDocument),
      attach: async (c, id, targetId) => {
        await assertExists(c, "documents", targetId, "文書");
        const seq = await c.query(
          "SELECT COALESCE(max(line_no), 0) + 1 AS next FROM document_conditions WHERE document_id = $1",
          [targetId]);
        await c.query(
          `INSERT INTO document_conditions (document_id, condition_id, line_no)
           VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
          [targetId, id, Number((seq.rows[0] as { next: number }).next)]);
      },
      detach: async (c, id, targetId) => {
        await c.query(
          "DELETE FROM document_conditions WHERE document_id = $1 AND condition_id = $2",
          [targetId, id]);
      }
    },
    party: {
      target: "party", label: "相手先", single: true, editable: false,
      hint: "この条件の相手先。付け替えは上の「相手先」からできます。",
      list: async (c, id) => rows(await c.query(
        `SELECT p.id, p.party_code, p.name, p.kind
           FROM conditions co JOIN parties p ON p.id = co.counterparty_id
          WHERE co.id = $1`, [id])).map(asParty)
    },
    work: {
      target: "work", label: "作品", single: true, editable: true,
      hint: "この条件が扱う作品。",
      list: async (c, id) => rows(await c.query(
        `SELECT w.id, w.work_code, w.title, w.kind
           FROM conditions co JOIN works w ON w.id = co.work_id
          WHERE co.id = $1`, [id])).map(asWork),
      candidates: async (c, _id, q) => rows(await c.query(
        `SELECT w.id, w.work_code, w.title, w.kind FROM works w
          WHERE w.status = 'active'
            AND ($1 = '' OR w.title ILIKE $1 OR COALESCE(w.work_code,'') ILIKE $1)
          ORDER BY w.title LIMIT 20`, [q ? like(q) : ""])).map(asWork),
      attach: async (c, id, targetId) => {
        await assertExists(c, "works", targetId, "作品");
        await c.query("UPDATE conditions SET work_id = $2 WHERE id = $1", [id, targetId]);
      },
      detach: async (c, id) => {
        await c.query("UPDATE conditions SET work_id = NULL WHERE id = $1", [id]);
      }
    }
  },

  document: {
    matter: {
      target: "matter", label: "案件", single: true, editable: true,
      hint: "この書類が属する案件。",
      list: async (c, id) => rows(await c.query(
        `SELECT m.id, m.matter_no, m.title, m.kind, m.status
           FROM documents d JOIN matters m ON m.id = d.matter_id
          WHERE d.id = $1`, [id])).map(asMatter),
      candidates: async (c, _id, q) => rows(await c.query(
        `SELECT m.id, m.matter_no, m.title, m.kind, m.status FROM matters m
          WHERE ($1 = '' OR m.title ILIKE $1 OR COALESCE(m.matter_no,'') ILIKE $1)
          ORDER BY m.id DESC LIMIT 20`, [q ? like(q) : ""])).map(asMatter),
      attach: async (c, id, targetId) => {
        await assertExists(c, "matters", targetId, "案件");
        await c.query("UPDATE documents SET matter_id = $2 WHERE id = $1", [id, targetId]);
      },
      detach: async (c, id) => {
        await c.query("UPDATE documents SET matter_id = NULL WHERE id = $1", [id]);
      }
    },
    conditions: {
      target: "condition", label: "条件明細", single: false, editable: true,
      hint: "この書類が載せている条件。書類は条件の出力物なので、ここが中身にあたります。",
      list: async (c, id) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status
           FROM document_conditions dc JOIN conditions co ON co.id = dc.condition_id
          WHERE dc.document_id = $1 ORDER BY dc.line_no`, [id])).map(asCondition),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status FROM conditions co
          WHERE co.status NOT IN ('void', 'superseded')
            AND ($2 = '' OR co.name ILIKE $2 OR COALESCE(co.condition_no,'') ILIKE $2)
            AND NOT EXISTS (SELECT 1 FROM document_conditions dc
                             WHERE dc.document_id = $1 AND dc.condition_id = co.id)
          ORDER BY co.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asCondition),
      attach: async (c, id, targetId) => {
        await assertExists(c, "conditions", targetId, "条件");
        const seq = await c.query(
          "SELECT COALESCE(max(line_no), 0) + 1 AS next FROM document_conditions WHERE document_id = $1",
          [id]);
        await c.query(
          `INSERT INTO document_conditions (document_id, condition_id, line_no)
           VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
          [id, targetId, Number((seq.rows[0] as { next: number }).next)]);
      },
      detach: async (c, id, targetId) => {
        await c.query(
          "DELETE FROM document_conditions WHERE document_id = $1 AND condition_id = $2",
          [id, targetId]);
      }
    },
    agreement: {
      target: "agreement", label: "契約（合意）", single: true, editable: true,
      hint: "この書類が属する契約。",
      list: async (c, id) => rows(await c.query(
        `SELECT a.id, a.agreement_no, a.title, a.direction, a.status
           FROM documents d JOIN agreements a ON a.id = d.agreement_id
          WHERE d.id = $1`, [id])).map(asAgreement),
      candidates: async (c, _id, q) => rows(await c.query(
        `SELECT a.id, a.agreement_no, a.title, a.direction, a.status FROM agreements a
          WHERE ($1 = '' OR a.title ILIKE $1 OR COALESCE(a.agreement_no,'') ILIKE $1)
          ORDER BY a.id DESC LIMIT 20`, [q ? like(q) : ""])).map(asAgreement),
      attach: async (c, id, targetId) => {
        await assertExists(c, "agreements", targetId, "契約");
        await c.query("UPDATE documents SET agreement_id = $2 WHERE id = $1", [id, targetId]);
      },
      detach: async (c, id) => {
        await c.query("UPDATE documents SET agreement_id = NULL WHERE id = $1", [id]);
      }
    }
  },

  agreement: {
    conditions: {
      target: "condition", label: "条件明細", single: false, editable: true,
      hint: "この契約に載っている条件。金額や料率はここで持ちます。",
      list: async (c, id) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status
           FROM conditions co WHERE co.agreement_id = $1 ORDER BY co.id`, [id])).map(asCondition),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status FROM conditions co
          WHERE co.agreement_id IS DISTINCT FROM $1
            AND co.direction = (SELECT direction FROM agreements WHERE id = $1)
            AND ($2 = '' OR co.name ILIKE $2 OR COALESCE(co.condition_no,'') ILIKE $2)
          ORDER BY co.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asCondition),
      attach: async (c, id, targetId) => {
        await assertExists(c, "conditions", targetId, "条件");
        await c.query("UPDATE conditions SET agreement_id = $1 WHERE id = $2", [id, targetId]);
      },
      detach: async (c, id, targetId) => {
        await c.query(
          "UPDATE conditions SET agreement_id = NULL WHERE id = $2 AND agreement_id = $1",
          [id, targetId]);
      }
    },
    party: {
      target: "party", label: "相手先", single: true, editable: false,
      hint: "この契約の相手先。契約の相手先は締結の記録なので、ここでは変えません。",
      list: async (c, id) => rows(await c.query(
        `SELECT p.id, p.party_code, p.name, p.kind
           FROM agreements a JOIN parties p ON p.id = a.counterparty_id
          WHERE a.id = $1`, [id])).map(asParty)
    },
    documents: {
      target: "document", label: "文書", single: false, editable: true,
      hint: "この契約について出した書類。",
      list: async (c, id) => rows(await c.query(
        `SELECT ${DOCUMENT_SELECT} WHERE d.agreement_id = $1 ORDER BY d.id DESC`, [id]))
        .map(asDocument),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT ${DOCUMENT_SELECT}
          WHERE d.agreement_id IS DISTINCT FROM $1 AND d.status <> 'void'
            AND ($2 = '' OR COALESCE(d.document_no,'') ILIKE $2)
          ORDER BY d.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asDocument),
      attach: async (c, id, targetId) => {
        await assertExists(c, "documents", targetId, "文書");
        await c.query("UPDATE documents SET agreement_id = $1 WHERE id = $2", [id, targetId]);
      },
      detach: async (c, id, targetId) => {
        await c.query(
          "UPDATE documents SET agreement_id = NULL WHERE id = $2 AND agreement_id = $1",
          [id, targetId]);
      }
    }
  },

  work: {
    conditions: {
      target: "condition", label: "条件明細", single: false, editable: true,
      hint: "この作品を扱っている条件。",
      list: async (c, id) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status
           FROM conditions co WHERE co.work_id = $1 ORDER BY co.id`, [id])).map(asCondition),
      candidates: async (c, id, q) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status FROM conditions co
          WHERE co.work_id IS DISTINCT FROM $1
            AND ($2 = '' OR co.name ILIKE $2 OR COALESCE(co.condition_no,'') ILIKE $2)
          ORDER BY co.id DESC LIMIT 20`, [id, q ? like(q) : ""])).map(asCondition),
      attach: async (c, id, targetId) => {
        await assertExists(c, "conditions", targetId, "条件");
        await c.query("UPDATE conditions SET work_id = $1 WHERE id = $2", [id, targetId]);
      },
      detach: async (c, id, targetId) => {
        await c.query("UPDATE conditions SET work_id = NULL WHERE id = $2 AND work_id = $1",
          [id, targetId]);
      }
    }
  },

  party: {
    agreements: {
      target: "agreement", label: "契約（合意）", single: false, editable: false,
      hint: "この取引先との契約。",
      list: async (c, id) => rows(await c.query(
        `SELECT a.id, a.agreement_no, a.title, a.direction, a.status
           FROM agreements a WHERE a.counterparty_id = $1 ORDER BY a.id DESC`, [id]))
        .map(asAgreement)
    },
    conditions: {
      target: "condition", label: "条件明細", single: false, editable: false,
      hint: "この取引先との取引条件。",
      list: async (c, id) => rows(await c.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.status
           FROM conditions co WHERE co.counterparty_id = $1 ORDER BY co.id DESC LIMIT 100`, [id]))
        .map(asCondition)
    }
  }
};

export function relationFor(kind: string, relation: string): RelationDefinition {
  const group = RELATIONS[kind as EntityKind];
  if (!group) throw new DomainError("NOT_FOUND", `${kind} という種類はありません`);
  const definition = group[relation];
  if (!definition) throw new DomainError("NOT_FOUND", `${kind} に ${relation} という関連はありません`);
  return definition;
}
