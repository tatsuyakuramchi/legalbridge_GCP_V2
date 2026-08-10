// 外部 Webhook ペイロードの解釈（純関数・Phase 9-5/9-7）。外部由来＝untrusted のため
// 想定フィールドのみを型安全に抽出し、判別できないものは null を返す（副作用させない）。

export interface CloudSignEvent {
  cloudSignDocumentId: string;
  status: "completed" | "declined" | "sent" | "other";
  raw: { statusNum: number | null; text: string };
}

// CloudSign Webhook: { documentID, status(1=先方確認中/2=締結済/3=取消却下/13=インポート), text }
export function parseCloudSignEvent(payload: unknown): CloudSignEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const ev = payload as Record<string, unknown>;
  const id = String(ev.documentID ?? ev.document_id ?? ev.id ?? "").trim();
  if (!id) return null;
  const statusNum = ev.status == null || Number.isNaN(Number(ev.status)) ? null : Number(ev.status);
  const text = String(ev.text ?? ev.event ?? "").toLowerCase();
  const completed = statusNum === 2 || /complete|done|finish|締結/.test(text);
  const declined = statusNum === 3 || /declin|reject|却下|cancel|取消/.test(text);
  const status: CloudSignEvent["status"] =
    completed ? "completed" : declined ? "declined" : statusNum === 1 ? "sent" : "other";
  return { cloudSignDocumentId: id, status, raw: { statusNum, text } };
}

export interface BacklogIssueCreated {
  issueKey: string;
  summary: string;
}

// Backlog Webhook: { type(1=課題追加/2=更新…), project:{projectKey}, content:{key_id, summary} }
// 課題追加(type=1)のみを対象化。issueKey = projectKey-key_id。
export function parseBacklogIssueCreated(payload: unknown): BacklogIssueCreated | null {
  if (!payload || typeof payload !== "object") return null;
  const ev = payload as Record<string, unknown>;
  if (Number(ev.type) !== 1) return null;
  const project = (ev.project ?? {}) as Record<string, unknown>;
  const content = (ev.content ?? {}) as Record<string, unknown>;
  const projectKey = String(project.projectKey ?? "").trim();
  const keyId = content.key_id ?? content.keyId;
  if (!projectKey || keyId == null || Number.isNaN(Number(keyId))) return null;
  const summary = String(content.summary ?? "").trim();
  return { issueKey: `${projectKey}-${Number(keyId)}`, summary };
}
