import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { dateStr } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { DispatchService } from "../integrations/dispatch-service.js";

/**
 * 日次の点検。
 *
 * 画面を開かないと気づけないものを、決まった時刻に洗い出す。実データでは
 * 6〜7週間放置されたタスクが誰にも知られずに残っていた。人が見に来るのを
 * 待つ設計では、忙しい時期ほど見落とす。
 *
 * 通知は外部送信のゲートを通す。off のままなら洗い出しだけ行い、
 * 何を送るはずだったかを記録する。ジョブが勝手に外へ出すことはない。
 *
 * 冪等。同じ日に二度動かしても通知は重複しない（送信の冪等キーが弾く）。
 */

export interface DailyFinding {
  kind: "agreement_expiring" | "agreement_expired" | "task_overdue" | "payment_due" | "payment_overdue";
  refType: string;
  refId: number;
  refNo: string | null;
  title: string;
  dueOn: string | null;
  /** 期日までの日数。負なら超過。 */
  days: number | null;
  detail: Record<string, unknown>;
}

export interface DailyReport {
  runOn: string;
  findings: DailyFinding[];
  counts: Record<string, number>;
  /** 通知したか。ゲートが off なら false。 */
  notified: boolean;
  notifyDetail?: Record<string, unknown>;
}

/** 満了までこの日数を切ったら知らせる。更新の手続きに要る時間から決める。 */
const EXPIRY_NOTICE_DAYS = 60;

export class DailyJob {
  constructor(
    private readonly database: Transactable,
    private readonly dispatch?: DispatchService
  ) {}

  async run(options: { notifyChannel?: string; notifyTo?: string } = {}): Promise<DailyReport> {
    try {
      const findings = await inTransaction(this.database, async (client) => {
        const found = await this.collect(client);
        await recordAudit(client, {
          actor: "system", action: "job.daily", targetType: "job",
          detail: {
            counts: countBy(found),
            // 何を見つけたかを残す。あとから「あの日は出ていたか」を追える。
            findings: found.map((f) => ({ kind: f.kind, refNo: f.refNo, dueOn: f.dueOn }))
          }
        });
        return found;
      });

      const report: DailyReport = {
        runOn: dateStr(new Date()) ?? "",
        findings, counts: countBy(findings), notified: false
      };

      if (findings.length && this.dispatch && options.notifyChannel && options.notifyTo) {
        const outcome = await this.dispatch.dispatch({
          channel: options.notifyChannel as any,
          targetType: "job", targetId: 0, actor: "system",
          request: {
            recipient: options.notifyTo,
            subject: `【LegalBridge】要対応 ${findings.length} 件（${report.runOn}）`,
            body: formatBody(findings, report.runOn)
          }
        });
        report.notified = outcome.sent;
        report.notifyDetail = {
          sent: outcome.sent, blockers: outcome.gate.blockers,
          duplicated: outcome.duplicated ?? false
        };
      }
      return report;
    } catch (error) { throw translate(error); }
  }

  private async collect(client: Queryable): Promise<DailyFinding[]> {
    // 1本のトランザクション接続に同時に問い合わせない（pg は多重実行を
    // 受け付けない。並べても速くならず、pg@9 では動かなくなる）。
    const agreements = await client.query(
      `SELECT a.id, a.agreement_no, a.title, a.expires_on, a.auto_renewal,
              a.renewal_notice_months, p.name AS party,
              (a.expires_on - current_date) AS days
         FROM agreements a JOIN parties p ON p.id = a.counterparty_id
        WHERE a.status = 'executed' AND a.expires_on IS NOT NULL
          AND a.expires_on <= current_date + $1::int
        ORDER BY a.expires_on`, [EXPIRY_NOTICE_DAYS]);

    const tasks = await client.query(
      `SELECT t.id, t.title, t.due_at, m.matter_no, m.title AS matter_title,
              s.name AS assignee,
              ((t.due_at AT TIME ZONE 'Asia/Tokyo')::date - current_date) AS days
         FROM tasks t
         JOIN matters m ON m.id = t.matter_id
         LEFT JOIN staff s ON s.id = t.assignee_staff_id
        WHERE t.status <> 'done' AND t.due_at IS NOT NULL
          AND (t.due_at AT TIME ZONE 'Asia/Tokyo')::date < current_date
        ORDER BY t.due_at`);

    const payments = await client.query(
      `SELECT y.id, y.payment_no, y.due_on, y.amount, y.currency, y.status,
              p.name AS party, p.kind AS party_kind,
              (y.due_on - current_date) AS days
         FROM payments y JOIN parties p ON p.id = y.party_id
        WHERE y.status IN ('planned', 'approved') AND y.due_on IS NOT NULL
          AND y.due_on <= current_date + 7
        ORDER BY y.due_on`);

    const findings: DailyFinding[] = [];

    for (const a of agreements.rows as any[]) {
      const days = Number(a.days);
      findings.push({
        kind: days < 0 ? "agreement_expired" : "agreement_expiring",
        refType: "agreement", refId: Number(a.id), refNo: a.agreement_no ?? null,
        title: `${a.party}：${a.title}`,
        dueOn: dateStr(a.expires_on), days,
        detail: { autoRenewal: a.auto_renewal === true,
                  noticeMonths: a.renewal_notice_months ?? null }
      });
    }

    for (const t of tasks.rows as any[]) {
      findings.push({
        kind: "task_overdue",
        refType: "matter", refId: Number(t.id), refNo: t.matter_no ?? null,
        title: t.title, dueOn: dateStr(t.due_at), days: Number(t.days),
        detail: { matter: t.matter_title, assignee: t.assignee ?? null }
      });
    }

    for (const y of payments.rows as any[]) {
      const days = Number(y.days);
      findings.push({
        kind: days < 0 ? "payment_overdue" : "payment_due",
        refType: "payment", refId: Number(y.id), refNo: y.payment_no ?? null,
        title: `${y.party} への支払`,
        dueOn: dateStr(y.due_on), days,
        detail: { amount: Number(y.amount), currency: y.currency,
                  partyKind: y.party_kind, status: y.status }
      });
    }

    return findings;
  }
}

function countBy(findings: DailyFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

const LABEL: Record<DailyFinding["kind"], string> = {
  agreement_expired: "契約が満了しています",
  agreement_expiring: "契約がまもなく満了します",
  task_overdue: "タスクの期日を過ぎています",
  payment_overdue: "支払の期日を過ぎています",
  payment_due: "支払の期日が近づいています"
};

/** 通知の本文。超過が古いものから並べる。放っておいた分だけ重い。 */
export function formatBody(findings: DailyFinding[], runOn: string): string {
  const groups = new Map<string, DailyFinding[]>();
  for (const f of findings) {
    (groups.get(f.kind) ?? groups.set(f.kind, []).get(f.kind)!).push(f);
  }
  const lines = [`${runOn} 時点で対応が要るもの ${findings.length} 件`, ""];
  for (const [kind, list] of groups) {
    lines.push(`■ ${LABEL[kind as DailyFinding["kind"]]}（${list.length} 件）`);
    for (const f of [...list].sort((a, b) => (a.days ?? 0) - (b.days ?? 0))) {
      const when = f.days === null ? ""
        : f.days < 0 ? `${-f.days}日超過` : `あと${f.days}日`;
      lines.push(`  ${f.refNo ?? `#${f.refId}`} ${f.title}（${f.dueOn ?? "期日なし"}・${when}）`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
