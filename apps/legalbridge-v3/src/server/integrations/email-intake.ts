import type { MatterKind } from "../matters/write-service.js";

/**
 * 受信メールの読み取り。
 *
 * 契約のやり取りはメールで始まることが多い。法務の共有アドレスに届いた
 * ものを人が転記していると、転記されなかったものが案件として存在しない
 * ことになる。届いた時点で案件を立て、番号を返して、以後はその番号で
 * 呼べるようにする。
 *
 * ここは純関数だけにしてある。Gmail を相手にせずに規則を確かめられる
 * ようにするため。実際の取得は mail-source.ts、業務への反映は
 * email-intake-service.ts。
 */

export interface MailAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

export interface InboundMail {
  /** Gmail のメッセージID。取り込みの冪等キーにする。 */
  messageId: string;
  /** スレッドID。同じやり取りの続きを同じ案件へ寄せるのに使う。 */
  threadId: string;
  /** RFC822 の Message-ID。Gmail 以外から取り込む余地を残す。 */
  rfcMessageId: string | null;
  from: string;
  fromName: string | null;
  to: string[];
  subject: string;
  body: string;
  receivedAt: string | null;
  attachments: MailAttachment[];
}

/** 案件番号。本文でも件名でも拾う。 */
export const MATTER_NO_PATTERN = /\bMTR-(\d{4})-(\d{4,6})\b/i;
/** 文書番号。こちらが発行した書面への返信を見分ける。 */
export const DOCUMENT_NO_PATTERN = /\b([A-Z]{2,4}-[A-Z]{2,4}-\d{4}-\d{3,5})\b/;

/** 差出人欄からアドレスと表示名を取り出す。 */
export function parseAddress(raw: string): { email: string; name: string | null } {
  const s = String(raw ?? "").trim();
  const angled = s.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
    return { email: angled[2].trim().toLowerCase(), name: name || null };
  }
  return { email: s.toLowerCase(), name: null };
}

/** 件名から Re: / Fwd: / 【】 の飾りを落とす。案件名にそのまま使うため。 */
export function normalizeSubject(subject: string): string {
  let s = String(subject ?? "").trim();
  // 「Re: Fwd: Re:」のように重なるので、無くなるまで剥がす。
  for (let i = 0; i < 10; i += 1) {
    const stripped = s.replace(/^\s*(re|fw|fwd|返信|転送)\s*(\[\d+\])?\s*[:：]\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  return s.trim();
}

/**
 * 自動返信・不達通知。案件を立てても意味がないので取り込まない。
 * 見落とすと、不在通知のたびに案件が1件増える。
 */
export function isMachineMail(mail: Pick<InboundMail, "from" | "subject" | "body">): boolean {
  const from = parseAddress(mail.from).email;
  if (/^(mailer-daemon|postmaster|no-?reply|noreply|donotreply)@/.test(from)) return true;
  const subject = String(mail.subject ?? "");
  return [
    /自動返信/, /自動応答/, /不在/, /配信不能/, /^auto(matic)?[ -]?reply/i,
    /out of office/i, /undelivered mail/i, /delivery status notification/i,
    /mail delivery (failed|subsystem)/i
  ].some((re) => re.test(subject));
}

/** 依頼の種類。件名と本文の言葉から寄せる。決められなければ single。 */
export function inferKind(text: string): MatterKind {
  const s = String(text ?? "");
  // 発注側の言葉が先。委託と許諾の両方が出てきたら、金を払う側の話として扱う。
  if (/(発注|業務委託|外注|見積|請書|請求|検収|納品)/.test(s)) return "outsourcing";
  if (/(許諾|ライセンス|使用許諾|二次利用|グッズ化|映像化|翻案)/.test(s)) return "work";
  return "single";
}

export interface MailReading {
  /** 本文・件名に書かれていた案件番号。 */
  matterNo: string | null;
  /** 本文・件名に書かれていた文書番号。 */
  documentNo: string | null;
  kind: MatterKind;
  /** 案件名にする文字列。 */
  title: string;
  sender: { email: string; name: string | null };
  machine: boolean;
}

export function readMail(mail: InboundMail): MailReading {
  const haystack = `${mail.subject ?? ""}\n${mail.body ?? ""}`;
  const matter = haystack.match(MATTER_NO_PATTERN);
  const document = haystack.match(DOCUMENT_NO_PATTERN);
  const title = normalizeSubject(mail.subject) || "（件名なし）";
  return {
    matterNo: matter ? matter[0].toUpperCase() : null,
    documentNo: document ? document[1].toUpperCase() : null,
    kind: inferKind(haystack),
    title: title.slice(0, 200),
    sender: parseAddress(mail.from),
    machine: isMachineMail(mail)
  };
}

/** 案件の備考に残す文面。誰から何が届いて案件になったかを一目で分かるようにする。 */
export function describeMail(mail: InboundMail, reading: MailReading): string {
  const lines = [
    `メールから受付（${reading.sender.name ? `${reading.sender.name} <${reading.sender.email}>` : reading.sender.email}）`,
    `件名：${mail.subject}`,
    mail.receivedAt ? `受信：${mail.receivedAt}` : null
  ].filter(Boolean) as string[];
  if (mail.attachments.length) {
    lines.push(`添付：${mail.attachments.map((a) => `${a.filename}（${a.mimeType}）`).join("、")}`);
  }
  // 本文はそのまま残さない。長文が備考を埋めると、他の記載が読めなくなる。
  const excerpt = String(mail.body ?? "").trim().replace(/\r\n/g, "\n").slice(0, 800);
  if (excerpt) lines.push("", excerpt);
  return lines.join("\n");
}
