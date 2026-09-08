import type { Queryable } from "../core/db.js";
import { recordAudit } from "../core/audit.js";

/**
 * 受信した出来事を業務に反映する。
 *
 * V3 はこれまで webhook を audit_events に記録するだけで、文書も合意も
 * 動かしていなかった。署名が完了しても画面上は「発行済み」のままで、
 * 誰かが手で直すまで気づけない。
 *
 * 反映は「保存先1箇所を書く」だけにする。CloudSign の署名完了で
 * 動かすのは合意の状態であって、文書の状態ではない（文書は出力物で、
 * 署名されたのは合意そのもの）。
 *
 * 外部の出来事を業務データに変換する境界なので、対応が付かないものは
 * 黙って捨てず、理由を残してそのままにする。
 */

export interface HandledResult {
  /** 何かを更新したか。 */
  applied: boolean;
  /** 何をしたか、しなかったならなぜか。 */
  detail: Record<string, unknown>;
}

/** CloudSign の状態を V3 の合意の状態へ。対応の付かないものは null。 */
export function mapCloudSignStatus(status: string): "executed" | "terminated" | null {
  const s = String(status ?? "").trim().toLowerCase();
  if (["completed", "signed", "done", "3"].includes(s)) return "executed";
  if (["declined", "canceled", "cancelled", "rejected", "4"].includes(s)) return "terminated";
  return null;   // sent / viewed などは途中経過。合意の状態は動かさない。
}

/**
 * CloudSign の署名結果。
 * 文書に控えてある外部IDから合意を辿り、合意の状態を動かす。
 */
export async function handleCloudSign(
  client: Queryable, input: { externalId: string; payload: Record<string, unknown>; }
): Promise<HandledResult> {
  const p = input.payload;
  const documentRef = String(
    p.documentID ?? p.documentId ?? p.document_id ?? input.externalId ?? "").trim();
  const rawStatus = String(p.status ?? p.event ?? p.type ?? "");
  const status = mapCloudSignStatus(rawStatus);

  if (!status) {
    return { applied: false, detail: { reason: "途中経過のため合意は動かさない", rawStatus } };
  }

  // 送信時の監査記録から、その外部IDで送った文書を引く。
  const found = await client.query(
    `SELECT a.target_id AS document_id, d.document_no, d.agreement_id
       FROM audit_events a
       JOIN documents d ON d.id = a.target_id
      WHERE a.action = 'cloudsign.send' AND a.target_type = 'document'
        AND a.detail->>'externalId' = $1
      ORDER BY a.id DESC LIMIT 1`, [documentRef]);
  const row = found.rows[0] as any;

  if (!row) {
    return { applied: false, detail: { reason: "この外部IDで送った文書が見つからない", documentRef, status } };
  }
  if (!row.agreement_id) {
    return {
      applied: false,
      detail: { reason: "文書が合意に紐づいていないため状態を動かせない",
                documentId: Number(row.document_id), documentNo: row.document_no, status }
    };
  }

  const updated = await client.query(
    `UPDATE agreements SET status = $2, updated_at = now()
      WHERE id = $1 AND status <> $2 RETURNING agreement_no, status`,
    [row.agreement_id, status]);

  return {
    applied: (updated.rowCount ?? 0) > 0,
    detail: {
      agreementId: Number(row.agreement_id),
      agreementNo: (updated.rows[0] as any)?.agreement_no ?? null,
      documentId: Number(row.document_id), documentNo: row.document_no,
      status, rawStatus,
      ...((updated.rowCount ?? 0) === 0 ? { reason: "すでにその状態" } : {})
    }
  };
}

/**
 * Backlog の課題更新。案件に紐づく課題の状態をタスクへ反映する。
 * 紐づいていない課題は無視する（Backlog 全体を取り込むのが目的ではない）。
 */
export async function handleBacklog(
  client: Queryable, input: { externalId: string; payload: Record<string, unknown>; }
): Promise<HandledResult> {
  const p = input.payload as any;
  const issueKey = String(p.issueKey ?? p.content?.key_id ?? p.project?.projectKey ?? "").trim()
    || String(p.content?.summary ?? "").trim();
  const key = String(p.issueKey ?? "").trim()
    || (p.project?.projectKey && p.content?.key_id ? `${p.project.projectKey}-${p.content.key_id}` : "");

  const ref = key || issueKey;
  if (!ref) return { applied: false, detail: { reason: "課題キーを読み取れない" } };

  // matter_links に 'backlog' として登録されている案件を探す。
  const found = await client.query(
    `SELECT m.id, m.matter_no, m.status
       FROM matter_links l JOIN matters m ON m.id = l.matter_id
      WHERE l.target_type = 'backlog' AND l.target_ref = $1
      LIMIT 1`, [ref]);
  const row = found.rows[0] as any;
  if (!row) {
    return { applied: false, detail: { reason: "この課題に紐づく案件が無い", issueKey: ref } };
  }

  const statusName = String(p.content?.status?.name ?? p.status ?? "").trim();
  return {
    applied: false,
    detail: { matterId: Number(row.id), matterNo: row.matter_no, issueKey: ref, statusName,
              reason: "案件を特定した。状態の自動変更はしない（人が判断する）" }
  };
}

/** 受信を業務へ反映する入口。source ごとの処理をここで束ねる。 */
export async function applyInbound(
  client: Queryable,
  input: { source: string; externalId: string; payload: Record<string, unknown>; }
): Promise<HandledResult> {
  const handler = input.source === "cloudsign" ? handleCloudSign
    : input.source === "backlog" ? handleBacklog
    : null;
  if (!handler) return { applied: false, detail: { reason: "反映の対象外", source: input.source } };

  const result = await handler(client, input);
  await recordAudit(client, {
    actor: "system",
    action: `${input.source}.applied`,
    targetType: "webhook",
    detail: { externalId: input.externalId, applied: result.applied, ...result.detail }
  });
  return result;
}
