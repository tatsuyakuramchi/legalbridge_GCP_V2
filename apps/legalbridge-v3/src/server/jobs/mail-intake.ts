import type { Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { EmailIntakeService, type MailIntakeResult } from "../integrations/email-intake-service.js";
import type { MailSource } from "../integrations/mail-source.js";

/**
 * 受信メールの取り込み。
 *
 * Cloud Scheduler から定期的に叩く。取り込みの冪等キーはメッセージIDなので、
 * 同じ時間帯を二度読んでも案件は増えない。栞（settings）はあくまで
 * 取得量を絞るためのもので、正しさはメッセージIDが担保する。
 *
 * 1通の失敗で残りを落とさない。メールは1通ずつ独立した取り込みなので、
 * 読めないものは記録して次へ進む。栞は「失敗した所より手前」までしか
 * 進めない。進めてしまうと、失敗したメールが二度と読まれない。
 */

const CURSOR_KEY = "mail_intake_cursor";

export interface MailIntakeReport {
  ran: boolean;
  reason?: string;
  fetched: number;
  counts: Record<string, number>;
  results: MailIntakeResult[];
  failures: Array<{ messageId: string; subject: string; error: string }>;
  cursorBefore: string | null;
  cursorAfter: string | null;
}

export class MailIntakeJob {
  private readonly intake: EmailIntakeService;
  constructor(
    private readonly database: Transactable,
    private readonly source: MailSource | null
  ) {
    this.intake = new EmailIntakeService(database);
  }

  async run(options: { limit?: number } = {}): Promise<MailIntakeReport> {
    const empty = {
      fetched: 0, counts: {}, results: [], failures: [],
      cursorBefore: null, cursorAfter: null
    };
    if (!this.source || !this.source.configured) {
      return { ran: false, reason: "受信の設定がありません（ラベル未設定）", ...empty };
    }

    try {
      const cursorBefore = await this.readCursor();
      const mails = await this.source.list({
        since: cursorBefore ? new Date(cursorBefore) : null,
        limit: options.limit ?? 25
      });

      const results: MailIntakeResult[] = [];
      const failures: MailIntakeReport["failures"] = [];
      // 失敗より手前までしか栞を進めない。
      let advanceTo: string | null = cursorBefore;
      let stopped = false;

      for (const mail of mails) {
        try {
          results.push(await this.intake.accept(mail));
          if (!stopped && mail.receivedAt
              && (!advanceTo || mail.receivedAt > advanceTo)) advanceTo = mail.receivedAt;
        } catch (error) {
          stopped = true;
          failures.push({
            messageId: mail.messageId, subject: mail.subject,
            error: (error as Error)?.message ?? String(error)
          });
        }
      }

      if (advanceTo && advanceTo !== cursorBefore) await this.writeCursor(advanceTo);

      const counts: Record<string, number> = {};
      for (const r of results) counts[r.action] = (counts[r.action] ?? 0) + 1;
      if (failures.length) counts.failed = failures.length;

      return {
        ran: true, fetched: mails.length, counts, results, failures,
        cursorBefore, cursorAfter: advanceTo
      };
    } catch (error) { throw translate(error); }
  }

  private async readCursor(): Promise<string | null> {
    const r = await this.database.query(
      "SELECT value->>'since' AS since FROM settings WHERE key = $1", [CURSOR_KEY]);
    const since = (r.rows[0] as any)?.since;
    return since ? String(since) : null;
  }

  private async writeCursor(since: string): Promise<void> {
    await this.database.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'system')
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [CURSOR_KEY, JSON.stringify({ since })]);
  }
}
