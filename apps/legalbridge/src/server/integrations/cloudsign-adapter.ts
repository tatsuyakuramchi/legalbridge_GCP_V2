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

export interface CloudSignSignatureRequest {
  documentTitle: string;
  note?: string;
  filename: string;
  pdf: Buffer;
  participants: CloudSignParticipant[];
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
