// CloudSign 連携アダプタの共通契約。Gmail/Slack と同じく「ローカル(送信なし)」と
// 「ライブ(CloudSign API)」を差し替え可能にし、ゲートで既定OFFを担保する。
// 実URL・トークンは有効化時に確定する足場。API契約は CloudSign v2 の一般形
//（OAuth2 でトークン取得 → /documents 系）を想定し、orchestration を分離して
// 差し替え・テスト可能にしている。

export interface CloudSignParticipant {
  email: string;
  name: string;
  organization?: string;
}

// CC（CloudSign の共有先＝reportees）。署名はせず、書類の閲覧・完了通知を受け取る。
export interface CloudSignCc {
  email: string;
  name?: string;
}

export interface CloudSignSignatureRequest {
  documentTitle: string;
  note?: string;
  filename: string;
  pdf: Buffer;
  // 同じ CloudSign 書類に追加で添付するファイル（案件内の複数文書の一括依頼・V1 相当）。
  extraFiles?: Array<{ filename: string; pdf: Buffer }>;
  participants: CloudSignParticipant[];
  // CC（任意）。V1 の reportees 相当。
  cc?: CloudSignCc[];
  // true のときだけ即時送信する。false/未指定は「下書きで作成」＝CloudSign 画面で
  // 印影・フリーテキストを配置してから送信する運用（V1 の draft 相当・既定）。
  sendNow?: boolean;
  idempotencyKey: string;
}

export interface CloudSignSignatureReceipt {
  cloudSignDocumentId: string;
  status: string;
  participantIds: string[];
}

export interface CloudSignParticipantStatus {
  email: string;
  status: string;
}
export interface CloudSignStatus {
  cloudSignDocumentId: string;
  status: string;      // draft / sent / completed / canceled 等
  completed: boolean;
  participants: CloudSignParticipantStatus[];
}

export interface CloudSignAdapter {
  readonly configured: boolean;
  requestSignature(request: CloudSignSignatureRequest): Promise<CloudSignSignatureReceipt>;
  fetchStatus(cloudSignDocumentId: string): Promise<CloudSignStatus>;
}

// CloudSign の status コード/文字列を安定ラベルへ正規化する。
// 数値(0=下書き,1=送信済,2=完了,3=取消)・文字列いずれも受ける。
export function normalizeCloudSignStatus(raw: unknown): { status: string; completed: boolean } {
  const value = typeof raw === "number" ? String(raw) : String(raw ?? "").trim().toLowerCase();
  const map: Record<string, string> = {
    "0": "draft", "1": "sent", "2": "completed", "3": "canceled",
    draft: "draft", sent: "sent", completed: "completed", canceled: "canceled", cancelled: "canceled"
  };
  const status = map[value] ?? (value || "unknown");
  return { status, completed: status === "completed" };
}

export class CloudSignError extends Error {
  constructor(message: string, readonly code: string, readonly status: number | null = null) {
    super(message);
    this.name = "CloudSignError";
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

// 宛先allowlist（V1 CLOUDSIGN_ALLOWED_RECIPIENTS 相当）。カンマ区切りの小文字集合。
// 検証中の誤送信防止ガード：設定時は全宛先が集合内であることを要求する。
export function parseAllowedRecipients(raw?: string | null): Set<string> {
  const set = new Set<string>();
  for (const item of String(raw ?? "").split(",")) {
    const email = item.trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

// CloudSign コンソール（Web画面）のURLを API ベースURLから導出する（V1 準拠）。
// 下書き作成後に印影・フリーテキストを配置して送信する画面へ誘導するために使う。
//   https://api.cloudsign.jp → https://app.cloudsign.jp
//   https://api-sandbox.cloudsign.jp → https://sandbox.cloudsign.jp
export function cloudSignConsoleUrl(apiBaseUrl: string, cloudSignDocumentId: string): string {
  const base = String(apiBaseUrl || "https://api.cloudsign.jp").replace(/\/+$/, "");
  const app = /\/\/api-sandbox\./.test(base)
    ? base.replace(/\/\/api-sandbox\./, "//sandbox.")
    : base.replace(/\/\/api\./, "//app.");
  return `${app}/documents/${encodeURIComponent(cloudSignDocumentId)}`;
}

// allowlist が空なら制限なし（null）。設定時は最初の非許可メールを返す。
export function findDisallowedRecipient(emails: string[], allowlist: Set<string>): string | null {
  if (allowlist.size === 0) return null;
  for (const email of emails) {
    if (!allowlist.has(email.trim().toLowerCase())) return email;
  }
  return null;
}

// 送信しないローカル実装。ゲートが integration_local でブロックするため
// requestSignature が呼ばれることは無いが、安全側に倒して明示的に失敗させる。
export class LocalCloudSignAdapter implements CloudSignAdapter {
  readonly configured = false;
  async requestSignature(): Promise<CloudSignSignatureReceipt> {
    throw new Error("CloudSign is in local mode; external signature requests are disabled");
  }
  async fetchStatus(): Promise<CloudSignStatus> {
    throw new Error("CloudSign is in local mode; status is unavailable");
  }
}
