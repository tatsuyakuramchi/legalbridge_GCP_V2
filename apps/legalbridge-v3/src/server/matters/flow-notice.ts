import { inTransaction, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import type { FlowFacts, FlowStep } from "./flow.js";

/**
 * 工程の節目を依頼者に Slack で知らせる。docs/v3-request-inbox.md §6
 *
 * V3 は工程を保存しない（案件に揃っているものから導く）。だから「工程が進んだ」
 * という出来事はどこにも起きない。定期的に工程を導き直し、前回までに知らせた
 * 節目（audit_events の matter.flow_notice）と比べて、新しく成り立ったものだけを知らせる。
 *
 *   - 初めて見る案件は、いま成り立っている節目を記録するだけで送らない。
 *     動かし始めた日に過去の節目が一斉に届くのを防ぐため。
 *   - 同じ節目は二度送らない（冪等キー flow-notice:<案件>:<節目>）。
 *   - 1回の実行で1案件につき1通にまとめる（取り込みで一度に進んだときに何通も届かない）。
 *   - 送り先は 案件のスレッド → 案件の依頼者の DM。受付箱から繋いだ別の依頼者にも DM。
 *   - Slack のゲートで止まっても節目は記録する（開けた日に溜まった分が届かないように）。
 */

export interface MilestoneRule {
  /** 工程の段の名前。 */
  step: string;
  /** done＝済になったら ／ current＝いまの段になったら */
  mode: "done" | "current";
  text: (ctx: NoticeContext) => string;
}

export interface NoticeContext { matterNo: string | null; title: string }

const no = (c: NoticeContext) => c.matterNo ?? "案件番号";

/** 知らせる節目。依頼者が知りたいところだけ（社内の細かい段は入れない）。 */
export const MILESTONES: MilestoneRule[] = [
  { step: "相手方の文書を確認", mode: "current",
    text: () => "相手方から届いた文書を法務で確認しています（相手方との調整に入りました）。" },
  { step: "基本契約の確認", mode: "done", text: () => "相手方との契約（基本契約）を確認しました。" },
  { step: "契約書の締結", mode: "done", text: () => "契約を締結しました。" },
  { step: "条件の合意", mode: "done", text: () => "許諾の条件がまとまりました。" },
  { step: "発注", mode: "done", text: () => "発注書を決定しました。相手方への送付・署名に進みます。" },
  { step: "相手方の文書を確認", mode: "done", text: () => "相手方の文書の確認が終わり、決定しました。" },
  { step: "ひな形から文書を決定", mode: "done", text: () => "文書を決定しました。相手方への送付・署名に進みます。" },
  { step: "自社ドラフトを決定", mode: "done", text: () => "文書を決定しました。相手方への送付・署名に進みます。" },
  { step: "納品・報告", mode: "current",
    text: (c) => `履行に入りました。納品を受けたら Slack の /法務依頼 で「業務委託・発注」を選び、`
      + `件名か内容に ${no(c)} を書いて知らせてください（検収に進みます）。` },
  { step: "検収", mode: "done", text: () => "検収が済みました。支払の手続きに進みます。" },
  { step: "支払", mode: "done", text: () => "支払まで済みました。" },
  { step: "実績の受領", mode: "current",
    text: (c) => `利用の実績（売上・製造・再許諾の受領）が出たら、Slack の /法務依頼 で「作品の権利」を選び、`
      + `件名か内容に ${no(c)} を書いて知らせてください（計算書を作ります）。` },
  { step: "計算書と分配", mode: "done", text: () => "計算書を出しました。" },
  { step: "決定", mode: "done", text: () => "法務の対応が決まりました。" }
];

export interface FiredMilestone { key: string; text: string }

/** いま成り立っている節目。キーは ブロック:段:mode（作品案件は制作委託と許諾に同じ名の段がある）。 */
export function firedMilestones(
  flow: { steps: FlowStep[]; current: FlowStep | null },
  matter: { status: string } & NoticeContext,
  rules: MilestoneRule[] = MILESTONES
): FiredMilestone[] {
  const out: FiredMilestone[] = [];
  for (const step of flow.steps) {
    for (const rule of rules) {
      if (rule.step !== step.name) continue;
      const hit = rule.mode === "done" ? step.done : flow.current?.no === step.no;
      if (hit) out.push({ key: `${step.block ?? "-"}:${step.name}:${rule.mode}`, text: rule.text(matter) });
    }
  }
  if (matter.status === "done") out.push({ key: "matter:done", text: "案件を完了しました。ありがとうございました。" });
  return out;
}

/** 1案件1通にまとめた文面。 */
export function noticeBody(matter: NoticeContext, fired: FiredMilestone[]): string {
  return [
    `📌 ${matter.matterNo ?? ""} ${matter.title}`.trim(),
    ...fired.map((f) => `・${f.text}`),
    "（LegalBridge の案件の工程からお知らせしています）"
  ].join("\n");
}

export interface FlowNoticeDeps {
  database: Transactable;
  /** 案件の工程（MatterLinkService.flow）。 */
  flowOf: (matterId: number) => Promise<{ steps: FlowStep[]; current: FlowStep | null; facts?: FlowFacts }>;
  /** 案件へ送る（MatterCommunicationService.sendSlack：スレッド → 依頼者の DM）。送れたら true。 */
  sendToMatter: (matterId: number, body: string) => Promise<boolean>;
  /** 個人への DM（受付箱から繋いだ別の依頼者）。送れたら true。 */
  sendDm: (matterId: number, slackId: string, body: string) => Promise<boolean>;
}

export interface FlowNoticeReport {
  ran: boolean;
  reason?: string;
  matters: number;
  seeded: number;
  notified: Array<{ matterNo: string | null; keys: string[]; sent: boolean }>;
  failures: Array<{ matterId: number; error: string }>;
}

export const SETTINGS_KEY = "flow_notice";
export const ACTOR = "system:flow-notice";

export class FlowNoticeJob {
  constructor(private readonly deps: FlowNoticeDeps) {}

  async run(options: { limit?: number } = {}): Promise<FlowNoticeReport> {
    const { database } = this.deps;
    const empty = { matters: 0, seeded: 0, notified: [], failures: [] };
    try {
      // 止めるときは settings の flow_notice に {"disabled": true}。段ごとに外すなら {"off": ["検収"]}。
      const s = await database.query("SELECT value FROM settings WHERE key = $1", [SETTINGS_KEY]);
      const setting = ((s.rows[0] as any)?.value ?? {}) as { disabled?: boolean; off?: string[] };
      if (setting.disabled) return { ran: false, reason: "工程の通知は止めてあります（settings の flow_notice）", ...empty };
      const rules = MILESTONES.filter((r) => !(setting.off ?? []).includes(r.step));

      // 知らせる相手がいる案件だけ。閉じた案件は完了の知らせのために数日だけ見る。
      const r = await database.query(
        `SELECT m.id, m.matter_no, m.title, m.status, m.requester_slack_id,
                COALESCE((SELECT array_agg(DISTINCT ir.requester_slack_id)
                            FROM intake_requests ir
                           WHERE ir.matter_id = m.id AND ir.state IN ('accepted', 'duplicate')
                             AND ir.requester_slack_id IS NOT NULL), '{}') AS requesters,
                EXISTS (SELECT 1 FROM matter_links l
                         WHERE l.matter_id = m.id AND l.target_type = 'slack_thread') AS has_thread
           FROM matters m
          WHERE m.merged_into_id IS NULL
            AND m.status <> 'canceled'
            AND (m.status <> 'done' OR m.closed_at > now() - interval '3 days')
            AND (m.requester_slack_id IS NOT NULL
                 OR EXISTS (SELECT 1 FROM intake_requests ir
                             WHERE ir.matter_id = m.id AND ir.requester_slack_id IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM matter_links l
                             WHERE l.matter_id = m.id AND l.target_type = 'slack_thread'))
          ORDER BY m.id
          LIMIT $1`, [options.limit ?? 500]);
      const matters = r.rows as any[];
      const ids = matters.map((m) => Number(m.id));
      const marks = new Map<number, Set<string>>();
      if (ids.length) {
        const k = await database.query(
          `SELECT target_id, detail->>'key' AS key FROM audit_events
            WHERE action = 'matter.flow_notice' AND target_type = 'matter' AND target_id = ANY($1::bigint[])`,
          [ids]);
        for (const row of k.rows as any[]) {
          const id = Number(row.target_id);
          if (!marks.has(id)) marks.set(id, new Set());
          marks.get(id)!.add(String(row.key));
        }
      }

      const report: FlowNoticeReport = { ran: true, ...empty, matters: matters.length, notified: [], failures: [] };
      for (const m of matters) {
        const matterId = Number(m.id);
        try {
          const ctx = { matterNo: m.matter_no ?? null, title: String(m.title), status: String(m.status) };
          const fired = firedMilestones(await this.deps.flowOf(matterId), ctx, rules);
          const seen = marks.get(matterId);

          if (!seen || !seen.has("_seed")) {
            // 初めて見る案件。いまの状態を記録するだけ。
            await this.mark(matterId, [{ key: "_seed", text: "" }, ...fired], { seeded: true, sent: false });
            report.seeded += 1;
            continue;
          }
          const fresh = fired.filter((f) => !seen.has(f.key));
          if (!fresh.length) continue;

          const body = noticeBody(ctx, fresh);
          let sent = await this.deps.sendToMatter(matterId, body);
          for (const slackId of (m.requesters as string[]).filter((x) => x && x !== m.requester_slack_id)) {
            sent = (await this.deps.sendDm(matterId, slackId, body)) || sent;
          }
          await this.mark(matterId, fresh, { seeded: false, sent });
          report.notified.push({ matterNo: m.matter_no ?? null, keys: fresh.map((f) => f.key), sent });
        } catch (error) {
          report.failures.push({ matterId, error: (error as Error)?.message ?? String(error) });
        }
      }

      await inTransaction(database, (client) => recordAudit(client, {
        actor: ACTOR, action: "job.flow_notice", targetType: "job",
        detail: { matters: report.matters, seeded: report.seeded,
                  notified: report.notified.slice(0, 50), failures: report.failures.slice(0, 20) }
      }));
      return report;
    } catch (error) { throw translate(error); }
  }

  /** 節目を記録する。同じ節目は冪等キーで二度書かない。 */
  private async mark(matterId: number, fired: FiredMilestone[], flags: { seeded: boolean; sent: boolean }) {
    await inTransaction(this.deps.database, async (client) => {
      for (const f of fired) {
        await recordAudit(client, {
          actor: ACTOR, action: "matter.flow_notice", targetType: "matter", targetId: matterId,
          idempotencyKey: `flow-notice:${matterId}:${f.key}`,
          detail: { key: f.key, text: f.text, ...flags }
        });
      }
    });
  }
}
