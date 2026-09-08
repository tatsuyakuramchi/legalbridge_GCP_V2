import type { InboundMail, MailAttachment } from "./email-intake.js";

/**
 * 受信メールの取得口。
 *
 * 送信側（adapters.ts）と対にして、受信も差し替えられる形にする。
 * 資格情報が無い環境では Memory 版を挿し、取り込みの規則だけを動かせる。
 */
export interface MailSource {
  readonly channel: string;
  readonly configured: boolean;
  /**
   * 未処理のメールを新しい順ではなく**古い順**で返す。
   * 新しい順だと、途中で止まったときに古いものが永久に取り残される。
   */
  list(options: { since?: Date | null; limit?: number }): Promise<InboundMail[]>;
}

const header = (headers: any[], name: string): string => {
  const found = (headers ?? []).find(
    (h: any) => String(h?.name ?? "").toLowerCase() === name.toLowerCase());
  return String(found?.value ?? "").trim();
};

const decode = (data: string | undefined): string =>
  data ? Buffer.from(String(data), "base64url").toString("utf8") : "";

/** MIME の入れ子から本文と添付を取り出す。text/plain を優先する。 */
export function extractParts(payload: any): { body: string; attachments: MailAttachment[] } {
  const attachments: MailAttachment[] = [];
  let plain = "";
  let html = "";

  const walk = (part: any) => {
    if (!part) return;
    const mimeType = String(part.mimeType ?? "");
    const filename = String(part.filename ?? "").trim();
    if (filename) {
      attachments.push({ filename, mimeType, size: Number(part.body?.size ?? 0) });
    } else if (mimeType === "text/plain" && !plain) {
      plain = decode(part.body?.data);
    } else if (mimeType === "text/html" && !html) {
      html = decode(part.body?.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  // 本文が HTML しかないことがある。タグを落として読める形にする。
  const body = plain || html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return { body: body.trim(), attachments };
}

/** Gmail API のメッセージを V3 の形へ。 */
export function toInboundMail(message: any): InboundMail {
  const headers = message?.payload?.headers ?? [];
  const { body, attachments } = extractParts(message?.payload);
  const internal = Number(message?.internalDate ?? 0);
  return {
    messageId: String(message?.id ?? ""),
    threadId: String(message?.threadId ?? ""),
    rfcMessageId: header(headers, "Message-ID") || null,
    from: header(headers, "From"),
    fromName: null,
    to: header(headers, "To").split(",").map((s) => s.trim()).filter(Boolean),
    subject: header(headers, "Subject"),
    body,
    receivedAt: internal > 0 ? new Date(internal).toISOString() : null,
    attachments
  };
}

/**
 * Gmail。ラベルの付いたメールだけを見る。
 *
 * 受信箱すべてを対象にすると、社内の雑談まで案件になる。取り込む範囲は
 * Gmail 側のフィルタでラベルを付けて決める（法務が運用で調整できる）。
 */
export class GmailMailSource implements MailSource {
  readonly channel = "gmail";
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly label: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}
  get configured() { return Boolean(this.label); }

  async list(options: { since?: Date | null; limit?: number } = {}): Promise<InboundMail[]> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const token = await this.accessToken();
    const auth = { Authorization: `Bearer ${token}` };

    const terms = [`label:${this.label}`];
    if (options.since) {
      // Gmail の after: は秒。境界のメールを取りこぼさないよう1秒戻す。
      terms.push(`after:${Math.floor(options.since.getTime() / 1000) - 1}`);
    }
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", terms.join(" "));
    listUrl.searchParams.set("maxResults", String(limit));

    const listed = await this.fetchImpl(listUrl.toString(), { headers: auth });
    if (!listed.ok) {
      throw new Error(`Gmail の一覧取得に失敗しました (${listed.status}): ${(await listed.text()).slice(0, 300)}`);
    }
    const body = await listed.json() as { messages?: Array<{ id: string }> };
    const ids = (body.messages ?? []).map((m) => m.id);

    const mails: InboundMail[] = [];
    for (const id of ids) {
      const got = await this.fetchImpl(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
        { headers: auth });
      if (!got.ok) {
        throw new Error(`Gmail の取得に失敗しました (${got.status}): ${id}`);
      }
      mails.push(toInboundMail(await got.json()));
    }
    // Gmail は新しい順で返す。古い順に直してから渡す。
    return mails.sort((a, b) => String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? "")));
  }
}

/** 取得せずに手元の配列を返す。未設定の環境とテストで使う。 */
export class MemoryMailSource implements MailSource {
  readonly channel = "gmail";
  readonly configured = true;
  constructor(private readonly mails: InboundMail[] = []) {}
  async list(options: { since?: Date | null; limit?: number } = {}): Promise<InboundMail[]> {
    const since = options.since ? options.since.getTime() : null;
    return this.mails
      .filter((m) => since === null || !m.receivedAt || new Date(m.receivedAt).getTime() >= since)
      .slice(0, options.limit ?? 25);
  }
}
