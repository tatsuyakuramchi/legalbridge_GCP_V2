import type { Queryable } from "../core/db.js";
import { recordAudit } from "../core/audit.js";
import { recordCommunication, slackRef } from "../matters/communication-service.js";

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
 * Backlog の課題の状態が「終わった」を意味するか。
 * 既定の状態は 未対応(1) 処理中(2) 処理済み(3) 完了(4)。
 * 処理済みは担当者が終えただけで、依頼者が閉じたわけではない。閉じたのは完了のみ。
 */
export function isBacklogClosed(statusName: string, statusId?: number | string | null): boolean {
  const id = Number(statusId);
  if (Number.isFinite(id) && id > 0) return id === 4;
  const s = String(statusName ?? "").trim().toLowerCase();
  return ["完了", "closed", "done"].includes(s);
}

/** Backlog の webhook から課題キーを組み立てる。読み取れなければ空文字。 */
export function backlogIssueKey(payload: any): string {
  const direct = String(payload?.issueKey ?? "").trim();
  if (direct) return direct;
  const project = String(payload?.project?.projectKey ?? "").trim();
  const keyId = payload?.content?.key_id;
  return project && keyId ? `${project}-${keyId}` : "";
}

/**
 * Backlog の課題更新。
 *
 * 案件の状態は動かさない。Backlog で課題が閉じても、契約が締結できたとは
 * 限らない（課題は作業の単位、案件は取り決めの単位）。ここでやるのは
 *   1. 今の Backlog の状態を案件の紐づけに写す（画面で見えるようにする）
 *   2. 課題が閉じたのに案件が開いたままなら、突き合わせの課題として残す
 * の2つ。判断は人がする。放置されないように見えるところへ出しておく。
 */
export async function handleBacklog(
  client: Queryable, input: { externalId: string; payload: Record<string, unknown>; }
): Promise<HandledResult> {
  const p = input.payload as any;
  const ref = backlogIssueKey(p);
  if (!ref) return { applied: false, detail: { reason: "課題キーを読み取れない" } };

  // matter_links の 'backlog_issue' として登録されている案件を探す。
  const found = await client.query(
    `SELECT l.id AS link_id, m.id, m.matter_no, m.status
       FROM matter_links l JOIN matters m ON m.id = l.matter_id
      WHERE l.target_type = 'backlog_issue' AND l.target_ref = $1
      LIMIT 1`, [ref]);
  const row = found.rows[0] as any;
  if (!row) {
    return { applied: false, detail: { reason: "この課題に紐づく案件が無い", issueKey: ref } };
  }

  const statusName = String(p?.content?.status?.name ?? p?.status?.name ?? p?.status ?? "").trim();
  const statusId = p?.content?.status?.id ?? p?.status?.id ?? null;
  const summary = String(p?.content?.summary ?? "").trim();
  const closed = isBacklogClosed(statusName, statusId);
  const matterId = Number(row.id);
  const matterOpen = ["open", "waiting", "blocked"].includes(String(row.status));

  // 状態を紐づけに写す。案件そのものは動かさない。
  await client.query(
    `UPDATE matter_links
        SET snapshot = snapshot || $2::jsonb
      WHERE id = $1`,
    [Number(row.link_id), JSON.stringify({
      statusName: statusName || null, statusId: statusId ?? null,
      summary: summary || null, closed, seenAt: new Date().toISOString()
    })]);

  // 課題は閉じたのに案件が開いたまま。どちらが正しいかは人が決める。
  if (closed && matterOpen) {
    await client.query(
      `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
       VALUES ('BACKLOG_CLOSED_MATTER_OPEN', 'matter', $1, 'low', $2::jsonb)
       ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
         detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
      [matterId, JSON.stringify({ issueKey: ref, statusName, matterNo: row.matter_no })]);
  } else if (!closed && !matterOpen) {
    // 逆向き。案件を閉じたのに課題が動いている。
    await client.query(
      `INSERT INTO data_quality_issues (rule_code, target_type, target_id, severity, detail)
       VALUES ('BACKLOG_OPEN_MATTER_CLOSED', 'matter', $1, 'low', $2::jsonb)
       ON CONFLICT (rule_code, target_type, target_id) DO UPDATE SET
         detail = EXCLUDED.detail, detected_at = now(), status = 'open'`,
      [matterId, JSON.stringify({ issueKey: ref, statusName, matterNo: row.matter_no })]);
  } else {
    // 食い違いが解けたら課題を閉じる。開きっぱなしにしない。
    await client.query(
      `UPDATE data_quality_issues SET status = 'resolved', resolved_at = now()
        WHERE target_type = 'matter' AND target_id = $1 AND status = 'open'
          AND rule_code IN ('BACKLOG_CLOSED_MATTER_OPEN', 'BACKLOG_OPEN_MATTER_CLOSED')`,
      [matterId]);
  }

  return {
    applied: true,
    detail: { matterId, matterNo: row.matter_no, issueKey: ref, statusName, closed,
              matterStatus: String(row.status),
              reason: "Backlog の状態を写した。案件の状態は人が決める" }
  };
}

/**
 * Slack の Events API。担当者からの返信を案件のやり取りとして残す。
 *
 * 案件との対応は2通り。
 *   1. 案件のスレッド（matter_links の slack_thread）への返信
 *   2. 依頼者との DM（matters.requester_slack_id）
 * どちらにも当たらなければ残さない（無関係なチャンネルの雑談まで拾わない）。
 *
 * 証憑なので、本文だけでなく Slack が送ってきた payload をそのまま evidence に持つ。
 */
export async function handleSlack(
  client: Queryable, input: { externalId: string; payload: Record<string, unknown>; }
): Promise<HandledResult> {
  const p = input.payload as any;
  if (p?.type !== "event_callback" || !p.event) {
    return { applied: false, detail: { reason: "出来事の通知ではない", type: p?.type ?? null } };
  }
  const ev = p.event;
  if (ev.type !== "message") {
    return { applied: false, detail: { reason: "メッセージではない", eventType: ev.type } };
  }
  // 自分（bot）の投稿と、編集・参加などの副次的な出来事は残さない。
  if (ev.bot_id || (ev.subtype && ev.subtype !== "file_share")) {
    return { applied: false, detail: { reason: "bot の投稿か副次的な出来事", subtype: ev.subtype ?? null } };
  }
  const channel = String(ev.channel ?? "");
  const ts = String(ev.ts ?? "");
  const thread = String(ev.thread_ts ?? ev.ts ?? "");
  const user = String(ev.user ?? "");
  if (!channel || !ts) return { applied: false, detail: { reason: "チャンネルか ts が無い" } };

  let matterId: number | null = null;
  let how = "";
  const byThread = await client.query(
    `SELECT matter_id FROM matter_links
      WHERE target_type = 'slack_thread'
        AND (target_ref = $1 OR (snapshot->>'channelId' = $2 AND snapshot->>'threadTs' = $3))
      LIMIT 1`, [slackRef(channel, thread), channel, thread]);
  if (byThread.rows[0]) { matterId = Number((byThread.rows[0] as any).matter_id); how = "thread"; }
  if (!matterId && ev.channel_type === "im" && user) {
    const byDm = await client.query(
      `SELECT id FROM matters WHERE requester_slack_id = $1
        ORDER BY (status IN ('open','waiting','blocked')) DESC, created_at DESC LIMIT 1`, [user]);
    if (byDm.rows[0]) { matterId = Number((byDm.rows[0] as any).id); how = "dm"; }
  }
  if (!matterId) {
    return { applied: false, detail: { reason: "この投稿に対応する案件が無い", channel, thread } };
  }

  const files = Array.isArray(ev.files)
    ? ev.files.map((f: any) => ({ id: f.id, name: f.name, url: f.url_private ?? null })) : [];
  const occurredAt = Number.isFinite(Number(ts)) ? new Date(Number(ts) * 1000).toISOString() : null;
  const id = await recordCommunication(client, {
    matterId, channel: "slack", direction: "in", occurredAt,
    actor: user || "slack", counterpart: channel,
    body: String(ev.text ?? ""), externalRef: slackRef(channel, ts),
    evidence: { matchedBy: how, event: ev, eventId: input.externalId, files }
  });
  return {
    applied: id !== null,
    detail: { matterId, matchedBy: how, channel, ts, communicationId: id,
              ...(id === null ? { reason: "同じ投稿を記録済み" } : {}) }
  };
}

/** 受信を業務へ反映する入口。source ごとの処理をここで束ねる。 */
export async function applyInbound(
  client: Queryable,
  input: { source: string; externalId: string; payload: Record<string, unknown>; }
): Promise<HandledResult> {
  const handler = input.source === "cloudsign" ? handleCloudSign
    : input.source === "backlog" ? handleBacklog
    : input.source === "slack" ? handleSlack
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
