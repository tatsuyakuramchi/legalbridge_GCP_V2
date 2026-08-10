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
  // 9-7 完成形（自動起票）で使う追加フィールド。旧受信経路との互換のため summary までは従来どおり。
  description: string;
  issueTypeName: string;
}

function backlogIssueKey(ev: Record<string, unknown>): string | null {
  const project = (ev.project ?? {}) as Record<string, unknown>;
  const content = (ev.content ?? {}) as Record<string, unknown>;
  const projectKey = String(project.projectKey ?? "").trim();
  const keyId = content.key_id ?? content.keyId;
  if (!projectKey || keyId == null || Number.isNaN(Number(keyId))) return null;
  return `${projectKey}-${Number(keyId)}`;
}

// Backlog Webhook: { type(1=課題追加/2=更新…), project:{projectKey}, content:{key_id, summary} }
// 課題追加(type=1)のみを対象化。issueKey = projectKey-key_id。
export function parseBacklogIssueCreated(payload: unknown): BacklogIssueCreated | null {
  if (!payload || typeof payload !== "object") return null;
  const ev = payload as Record<string, unknown>;
  if (Number(ev.type) !== 1) return null;
  const issueKey = backlogIssueKey(ev);
  if (!issueKey) return null;
  const content = (ev.content ?? {}) as Record<string, unknown>;
  const issueType = (content.issueType ?? {}) as Record<string, unknown>;
  return {
    issueKey,
    summary: String(content.summary ?? "").trim(),
    description: String(content.description ?? ""),
    issueTypeName: String(issueType.name ?? "").trim()
  };
}

export interface BacklogStatusChanged {
  issueKey: string;
  status: string;
}

// 課題更新(type=2)のうちステータス名を伴うもの（V1 webhook 互換：content.status.name）。
export function parseBacklogStatusChanged(payload: unknown): BacklogStatusChanged | null {
  if (!payload || typeof payload !== "object") return null;
  const ev = payload as Record<string, unknown>;
  if (Number(ev.type) !== 2) return null;
  const issueKey = backlogIssueKey(ev);
  if (!issueKey) return null;
  const content = (ev.content ?? {}) as Record<string, unknown>;
  const status = (content.status ?? {}) as Record<string, unknown>;
  const name = String(status.name ?? "").trim();
  if (!name) return null;
  return { issueKey, status: name };
}

// Backlog 課題種別名 → V2 依頼種別（V1 worker ISSUE_TYPE_TO_REQUEST_TYPE と同一・未知は legal_consult）。
export const BACKLOG_ISSUE_TYPE_TO_REQUEST_TYPE: Record<string, string> = {
  "法務相談": "legal_consult",
  "NDA": "nda",
  "業務委託基本契約": "outsourcing",
  "ライセンス契約": "license_master",
  "個別利用許諾条件": "lic_individual",
  "売買契約（当社買手）": "sales_master",
  "売買契約（当社売手・標準）": "sales_master",
  "売買契約（当社売手・保証金掛け売り）": "sales_master",
  "発注書": "purchase_order",
  "企画発注書": "purchase_order",
  "出版発注書": "purchase_order",
  "納品リクエスト": "delivery_inspec",
  "製造案件": "delivery_inspec",
  "売上報告案件": "license_calc",
  "海外IP契約（基本契約）": "license_master",
  "海外IP契約（変更合意）": "license_master",
  "契約審査": "outsourcing",
  "事務手続": "legal_consult"
};

// 課題説明文から申請者の Slack ユーザー ID を抽出（V1 同様 <@U…> メンション形式）。
export function extractSlackMention(description: string): string {
  const match = /<@([A-Z0-9]+)>/.exec(description);
  return match ? match[1] : "";
}
