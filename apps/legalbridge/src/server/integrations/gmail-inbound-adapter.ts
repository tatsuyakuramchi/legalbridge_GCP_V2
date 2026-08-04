// Gmail 受信取込アダプタの共通契約。対象メールボックスの契約メール（PDF添付）を
// 検索・取得する読取専用連携。外部メールボックス閲覧は機微なため、既定OFF＋
// 専用スコープ(gmail-inbound)＋ドメイン委任(subject=対象メールボックス)で守る。

export interface InboundAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface InboundContractMessage {
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  date: string | null;
  attachments: InboundAttachment[];
}

export interface GmailInboundAdapter {
  readonly configured: boolean;
  listContracts(query: string, maxResults: number): Promise<InboundContractMessage[]>;
  fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

export class LocalGmailInboundAdapter implements GmailInboundAdapter {
  readonly configured = false;
  async listContracts(): Promise<InboundContractMessage[]> {
    throw new Error("Gmail inbound is in local mode; mailbox access is disabled");
  }
  async fetchAttachment(): Promise<Buffer> {
    throw new Error("Gmail inbound is in local mode; mailbox access is disabled");
  }
}

// Gmail payload（ネストした parts）を再帰的に走査し、ファイル名と attachmentId を
// 持つ PDF 添付だけを抽出する。
export function extractPdfAttachments(payload: unknown): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const walk = (part: unknown) => {
    if (!part || typeof part !== "object") return;
    const node = part as Record<string, unknown>;
    const filename = typeof node.filename === "string" ? node.filename : "";
    const mimeType = typeof node.mimeType === "string" ? node.mimeType : "";
    const body = node.body as Record<string, unknown> | undefined;
    const attachmentId = body && typeof body.attachmentId === "string" ? body.attachmentId : "";
    const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(filename);
    if (filename && attachmentId && isPdf) {
      out.push({
        attachmentId, filename, mimeType: mimeType || "application/pdf",
        sizeBytes: body && typeof body.size === "number" ? body.size : 0
      });
    }
    if (Array.isArray(node.parts)) node.parts.forEach(walk);
  };
  walk(payload);
  return out;
}

// 取得したバイト列が PDF（%PDF- マジックバイト）かを確認する。
export function isPdfBufferSafe(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function headerValue(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return "";
  const lower = name.toLowerCase();
  for (const header of headers) {
    const record = header as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.toLowerCase() === lower) {
      return typeof record.value === "string" ? record.value : "";
    }
  }
  return "";
}
