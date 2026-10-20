import type { Transactable } from "../core/db.js";
import { dateStr, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import type { Column } from "../exports/csv.js";

/**
 * 監査レポート。取適法（業務委託の支払期日）の遵守状況と、システムの使われ方を
 * 期間を区切って1画面に集める。内部監査への報告で毎回 SQL を流していたものの置き換え
 * （infra/v3/diag/compliance-status.sql と同じ数え方）。
 *
 * 数え方の約束。
 * - 期間は日本時間の日付で、両端を含む。
 * - 部署は依頼者の部署だけで決める。担当（法務）の部署へは落とさない。落とすと
 *   法務が代わりに起こした案件が「法務部の依頼」に見える（実データで5件中5件がそうだった）。
 *   依頼者の無い案件は「（依頼者未入力）」にまとめ、一覧を別に出して直せるようにする。
 * - 支払の種類は割り当てた条件の種類で決める。60日の検査はシステム上は種類を問わず
 *   掛かるが、報告で見るのは業務委託の行。印税・許諾料の「受領日」は利用期間の末日で、
 *   給付の受領ではない。
 * - 移行の空の控え（0円の支払）は数えない。
 */

export interface AuditPeriod { since: string; until: string }

const DAY = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (value: string): boolean =>
  ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** 期間を決める。既定は今日まで30日。 */
export function parsePeriod(
  query: { since?: unknown; until?: unknown }, today: string
): AuditPeriod {
  const until = query.until ? String(query.until) : today;
  const since = query.since ? String(query.since)
    : new Date(new Date(`${until}T00:00:00Z`).getTime() - 30 * DAY).toISOString().slice(0, 10);
  if (!validDate(since) || !validDate(until)) {
    throw new DomainError("VALIDATION", "期間は YYYY-MM-DD で指定してください");
  }
  if (since > until) throw new DomainError("VALIDATION", "期間の始まりが終わりより後です");
  return { since, until };
}

export type PayKind = "outsourcing" | "license" | "other" | "unallocated";
export type DueVerdict = "ok" | "over_limit" | "unset";

export interface AuditReport {
  period: AuditPeriod;
  summary: {
    requests: number; matters: number; outsourcingMatters: number;
    purchaseOrders: number; documents: number;
    payments: number; individualPayments: number;
    outsourcingPayments: number; outsourcingOk: number; outsourcingOverLimit: number; outsourcingUnset: number;
    outsourcingMaxDays: number | null;
    licenseOverLimit: number; overduePayments: number;
    openHighIssues: number; unattributedMatters: number;
  };
  departments: Array<{ month: string; department: string; matters: number; outsourcing: number; purchaseOrders: number }>;
  intake: Array<{ month: string; department: string; requests: number; accepted: number }>;
  dueVerdicts: Array<{ partyKind: string; payKind: PayKind; verdict: DueVerdict; count: number; amount: number; maxDays: number | null }>;
  dueExceptions: Array<{
    paymentNo: string | null; party: string; partyKind: string; payKind: PayKind; amount: number;
    basisReceivedOn: string | null; dueOn: string | null; days: number | null; status: string;
  }>;
  outsourcingWithoutPo: Array<{ paymentNo: string | null; party: string; amount: number; createdOn: string | null; conditions: string }>;
  unattributedMatters: Array<{ matterNo: string | null; title: string; kind: string; owner: string | null; counterparties: string; createdOn: string | null }>;
  quality: Array<{ ruleCode: string; severity: string; open: number; resolved: number; ignored: number; lastDetected: string | null }>;
  jobs: Array<{ action: string; runs: number; days: number; lastRun: string | null }>;
}

// 期間の絞り。$1 = since, $2 = until（日本時間の日付、両端を含む）。
const inPeriod = (column: string) =>
  `(${column} AT TIME ZONE 'Asia/Tokyo')::date BETWEEN $1::date AND $2::date`;

/** 支払の種類。業務委託（役務・製品）を1本でも含めば業務委託。 */
const PAY_KIND = `(SELECT CASE
           WHEN bool_or(c.kind IN ('service', 'product')) THEN 'outsourcing'
           WHEN bool_and(c.kind = 'license')              THEN 'license'
           WHEN count(c.id) = 0                           THEN 'unallocated'
           ELSE 'other'
         END
    FROM payment_allocations a JOIN conditions c ON c.id = a.condition_id
   WHERE a.payment_id = p.id)`;

const VERDICT = `CASE
           WHEN p.basis_received_on IS NULL OR p.due_on IS NULL THEN 'unset'
           WHEN p.due_on - p.basis_received_on > 60          THEN 'over_limit'
           ELSE 'ok'
         END`;

const OUT_PAYMENTS = `
  SELECT p.*, pt.name AS party_name, pt.kind AS party_kind,
         ${PAY_KIND} AS pay_kind, ${VERDICT} AS verdict,
         p.due_on - p.basis_received_on AS days
    FROM payments p
    JOIN parties pt ON pt.id = p.party_id
   WHERE p.direction = 'out' AND p.status <> 'canceled' AND p.amount > 0
     AND ${inPeriod("p.created_at")}`;

const PURCHASE_ORDERS = `
  SELECT d.*
    FROM documents d
    JOIN document_template_versions v ON v.id = d.template_version_id
    JOIN document_templates t         ON t.id = v.template_id
   WHERE t.template_key IN ('purchase_order', 'intl_purchase_order')
     AND d.status IN ('issued', 'superseded')`;

/** 案件の依頼部署。依頼者だけで決める。 */
const MATTERS = `
  SELECT mt.*, NULLIF(rs.department, '') AS requester_department, os.name AS owner_name
    FROM matters mt
    LEFT JOIN staff rs ON lower(rs.email) = lower(mt.requester_email)
    LEFT JOIN staff os ON os.id = mt.owner_staff_id
   WHERE mt.merged_into_id IS NULL AND ${inPeriod("mt.created_at")}`;

const UNATTRIBUTED = "（依頼者未入力）";
const NO_DEPARTMENT = "（部署未登録）";

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ts = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);

export class AuditReportRepository {
  constructor(private readonly database: Transactable) {}

  async report(period: AuditPeriod): Promise<AuditReport> {
    const params = [period.since, period.until];
    const q = async (text: string, values: unknown[] = params) =>
      (await this.database.query(text, values)).rows as Array<Record<string, any>>;
    try {
      const [summary] = await q(`
        WITH op AS (${OUT_PAYMENTS}), m AS (${MATTERS})
        SELECT
          (SELECT count(*) FROM intake_requests r WHERE ${inPeriod("r.created_at")})                AS requests,
          (SELECT count(*) FROM m)                                                                  AS matters,
          (SELECT count(*) FROM m WHERE kind = 'outsourcing')                                       AS outsourcing_matters,
          (SELECT count(*) FROM (${PURCHASE_ORDERS}) po WHERE ${inPeriod("po.issued_at")})          AS purchase_orders,
          (SELECT count(*) FROM documents d WHERE d.status IN ('issued', 'superseded')
                                              AND ${inPeriod("d.issued_at")})                       AS documents,
          (SELECT count(*) FROM op)                                                                 AS payments,
          (SELECT count(*) FROM op WHERE party_kind = 'individual')                                 AS individual_payments,
          (SELECT count(*) FROM op WHERE pay_kind = 'outsourcing')                                  AS outsourcing_payments,
          (SELECT count(*) FROM op WHERE pay_kind = 'outsourcing' AND verdict = 'ok')               AS outsourcing_ok,
          (SELECT count(*) FROM op WHERE pay_kind = 'outsourcing' AND verdict = 'over_limit')       AS outsourcing_over,
          (SELECT count(*) FROM op WHERE pay_kind = 'outsourcing' AND verdict = 'unset')            AS outsourcing_unset,
          (SELECT max(days) FROM op WHERE pay_kind = 'outsourcing')                                 AS outsourcing_max_days,
          (SELECT count(*) FROM op WHERE pay_kind = 'license' AND verdict = 'over_limit')           AS license_over,
          (SELECT count(*) FROM op WHERE status <> 'paid' AND due_on < current_date)                AS overdue,
          (SELECT count(*) FROM data_quality_issues WHERE severity = 'high' AND status = 'open')    AS open_high,
          (SELECT count(*) FROM m WHERE requester_department IS NULL
                                    AND NULLIF(requester_email, '') IS NULL)                        AS unattributed`);

      const departments = await q(`
        WITH m AS (${MATTERS}),
        po AS (SELECT matter_id, count(*) AS n FROM (${PURCHASE_ORDERS}) d
                WHERE ${inPeriod("d.issued_at")} GROUP BY matter_id)
        SELECT to_char(date_trunc('month', m.created_at AT TIME ZONE 'Asia/Tokyo'), 'YYYY-MM') AS month,
               CASE WHEN m.requester_department IS NOT NULL THEN m.requester_department
                    WHEN NULLIF(m.requester_email, '') IS NOT NULL THEN '${NO_DEPARTMENT}'
                    ELSE '${UNATTRIBUTED}' END AS department,
               count(*) AS matters,
               count(*) FILTER (WHERE m.kind = 'outsourcing') AS outsourcing,
               COALESCE(sum(po.n), 0) AS purchase_orders
          FROM m LEFT JOIN po ON po.matter_id = m.id
         GROUP BY 1, 2 ORDER BY 1 DESC, matters DESC, 2`);

      const intake = await q(`
        SELECT to_char(date_trunc('month', r.created_at AT TIME ZONE 'Asia/Tokyo'), 'YYYY-MM') AS month,
               COALESCE(NULLIF(s.department, ''), '${NO_DEPARTMENT}') AS department,
               count(*) AS requests,
               count(*) FILTER (WHERE r.state = 'accepted') AS accepted
          FROM intake_requests r
          -- 依頼者はメールか Slack の ID で引く。二人当たっても1行に絞る
          LEFT JOIN LATERAL (
            SELECT department FROM staff st
             WHERE lower(st.email) = lower(r.requester_email)
                OR (st.slack_user_id IS NOT NULL AND st.slack_user_id = r.requester_slack_id)
             ORDER BY (lower(st.email) = lower(r.requester_email)) DESC NULLS LAST, st.id
             LIMIT 1) s ON true
         WHERE ${inPeriod("r.created_at")}
         GROUP BY 1, 2 ORDER BY 1 DESC, requests DESC, 2`);

      const verdicts = await q(`
        WITH op AS (${OUT_PAYMENTS})
        SELECT party_kind, pay_kind, verdict, count(*) AS n, sum(amount) AS amount, max(days) AS max_days
          FROM op GROUP BY 1, 2, 3
         ORDER BY (pay_kind = 'outsourcing') DESC, pay_kind, (party_kind = 'individual') DESC, verdict`);

      const exceptions = await q(`
        WITH op AS (${OUT_PAYMENTS})
        SELECT payment_no, party_name, party_kind, pay_kind, amount, basis_received_on, due_on, days, status
          FROM op WHERE verdict <> 'ok'
         ORDER BY (pay_kind = 'outsourcing') DESC, (party_kind = 'individual') DESC, days DESC NULLS LAST, payment_no`);

      const withoutPo = await q(`
        WITH op AS (${OUT_PAYMENTS})
        SELECT op.payment_no, op.party_name, op.amount,
               (op.created_at AT TIME ZONE 'Asia/Tokyo')::date AS created_on,
               COALESCE(string_agg(DISTINCT c.condition_no, ', '), '') AS conditions
          FROM op
          LEFT JOIN payment_allocations a ON a.payment_id = op.id
          LEFT JOIN conditions c          ON c.id = a.condition_id
         WHERE op.pay_kind = 'outsourcing'
           AND NOT EXISTS (
             SELECT 1 FROM payment_allocations a2
               JOIN document_conditions dc ON dc.condition_id = a2.condition_id
               JOIN (${PURCHASE_ORDERS}) po ON po.id = dc.document_id
              WHERE a2.payment_id = op.id)
         GROUP BY op.id, op.payment_no, op.party_name, op.amount, op.created_at
         ORDER BY op.created_at DESC`);

      const unattributed = await q(`
        WITH m AS (${MATTERS})
        SELECT m.matter_no, m.title, m.kind, m.owner_name,
               (m.created_at AT TIME ZONE 'Asia/Tokyo')::date AS created_on,
               COALESCE((SELECT string_agg(DISTINCT x.name, '、') FROM (
                 SELECT p.name FROM parties p WHERE p.id = m.counterparty_id
                 UNION
                 SELECT p.name FROM documents d
                   JOIN document_conditions dc ON dc.document_id = d.id
                   JOIN conditions c ON c.id = dc.condition_id
                   JOIN parties p ON p.id = c.counterparty_id
                  WHERE d.matter_id = m.id) x), '') AS counterparties
          FROM m
         WHERE m.requester_department IS NULL AND NULLIF(m.requester_email, '') IS NULL
         ORDER BY m.created_at`);

      // 品質は期間で区切らない。いま開いているものを見る。
      const quality = await q(`
        SELECT rule_code, severity,
               count(*) FILTER (WHERE status = 'open')     AS open,
               count(*) FILTER (WHERE status = 'resolved') AS resolved,
               count(*) FILTER (WHERE status = 'ignored')  AS ignored,
               max(detected_at) AS last_detected
          FROM data_quality_issues
         GROUP BY rule_code, severity
         ORDER BY (severity = 'high') DESC, open DESC, rule_code`, []);

      const jobs = await q(`
        SELECT action, count(*) AS runs,
               count(DISTINCT (occurred_at AT TIME ZONE 'Asia/Tokyo')::date) AS days,
               max(occurred_at) AS last_run
          FROM audit_events
         WHERE action LIKE 'job.%' AND ${inPeriod("occurred_at")}
         GROUP BY action ORDER BY action`);

      const s = summary ?? {};
      return {
        period,
        summary: {
          requests: num(s.requests), matters: num(s.matters), outsourcingMatters: num(s.outsourcing_matters),
          purchaseOrders: num(s.purchase_orders), documents: num(s.documents),
          payments: num(s.payments), individualPayments: num(s.individual_payments),
          outsourcingPayments: num(s.outsourcing_payments), outsourcingOk: num(s.outsourcing_ok),
          outsourcingOverLimit: num(s.outsourcing_over), outsourcingUnset: num(s.outsourcing_unset),
          outsourcingMaxDays: numOrNull(s.outsourcing_max_days),
          licenseOverLimit: num(s.license_over), overduePayments: num(s.overdue),
          openHighIssues: num(s.open_high), unattributedMatters: num(s.unattributed)
        },
        departments: departments.map((r) => ({
          month: String(r.month), department: String(r.department),
          matters: num(r.matters), outsourcing: num(r.outsourcing), purchaseOrders: num(r.purchase_orders)
        })),
        intake: intake.map((r) => ({
          month: String(r.month), department: String(r.department),
          requests: num(r.requests), accepted: num(r.accepted)
        })),
        dueVerdicts: verdicts.map((r) => ({
          partyKind: String(r.party_kind), payKind: String(r.pay_kind) as PayKind,
          verdict: String(r.verdict) as DueVerdict, count: num(r.n), amount: num(r.amount),
          maxDays: numOrNull(r.max_days)
        })),
        dueExceptions: exceptions.map((r) => ({
          paymentNo: str(r.payment_no), party: String(r.party_name ?? ""), partyKind: String(r.party_kind),
          payKind: String(r.pay_kind) as PayKind, amount: num(r.amount),
          basisReceivedOn: dateStr(r.basis_received_on), dueOn: dateStr(r.due_on),
          days: numOrNull(r.days), status: String(r.status)
        })),
        outsourcingWithoutPo: withoutPo.map((r) => ({
          paymentNo: str(r.payment_no), party: String(r.party_name ?? ""), amount: num(r.amount),
          createdOn: dateStr(r.created_on), conditions: String(r.conditions ?? "")
        })),
        unattributedMatters: unattributed.map((r) => ({
          matterNo: str(r.matter_no), title: String(r.title ?? ""), kind: String(r.kind),
          owner: str(r.owner_name), counterparties: String(r.counterparties ?? ""), createdOn: dateStr(r.created_on)
        })),
        quality: quality.map((r) => ({
          ruleCode: String(r.rule_code), severity: String(r.severity),
          open: num(r.open), resolved: num(r.resolved), ignored: num(r.ignored),
          lastDetected: ts(r.last_detected)
        })),
        jobs: jobs.map((r) => ({
          action: String(r.action), runs: num(r.runs), days: num(r.days), lastRun: ts(r.last_run)
        }))
      };
    } catch (error) { throw translate(error); }
  }
}

// ---- CSV ----

export const PAY_KIND_LABEL: Record<PayKind, string> = {
  outsourcing: "業務委託", license: "印税・許諾料", other: "その他（経費・手数料）", unallocated: "割当なし"
};
export const VERDICT_LABEL: Record<DueVerdict, string> = {
  ok: "適合", over_limit: "期日超過", unset: "期日未設定"
};
const PARTY_KIND_LABEL = (kind: string) => (kind === "individual" ? "個人" : "法人");
const MATTER_KIND_LABEL: Record<string, string> = { outsourcing: "業務委託", work: "作品", single: "単発" };

type Row<K extends keyof AuditReport> = AuditReport[K] extends Array<infer T> ? T : never;

/** 書き出せる表。画面の表と同じ並び。 */
export const AUDIT_CSV = {
  summary: {
    label: "要約",
    rows: (r: AuditReport) => [{ ...r.summary, since: r.period.since, until: r.period.until }],
    columns: [
      { header: "集計開始日", value: (x: any) => x.since },
      { header: "集計終了日", value: (x: any) => x.until },
      { header: "依頼", value: (x: any) => x.requests },
      { header: "案件", value: (x: any) => x.matters },
      { header: "うち業務委託の案件", value: (x: any) => x.outsourcingMatters },
      { header: "発注書", value: (x: any) => x.purchaseOrders },
      { header: "文書", value: (x: any) => x.documents },
      { header: "外注への支払", value: (x: any) => x.payments },
      { header: "業務委託の支払", value: (x: any) => x.outsourcingPayments },
      { header: "業務委託_60日以内", value: (x: any) => x.outsourcingOk },
      { header: "業務委託_期日超過", value: (x: any) => x.outsourcingOverLimit },
      { header: "業務委託_期日未設定", value: (x: any) => x.outsourcingUnset },
      { header: "業務委託_最長日数", value: (x: any) => x.outsourcingMaxDays },
      { header: "印税・許諾料_期日超過（参考）", value: (x: any) => x.licenseOverLimit },
      { header: "期日経過の未払", value: (x: any) => x.overduePayments },
      { header: "依頼者未入力の案件", value: (x: any) => x.unattributedMatters },
      { header: "品質high未解決", value: (x: any) => x.openHighIssues }
    ] as Array<Column<any>>
  },
  departments: {
    label: "依頼部署別の案件",
    rows: (r: AuditReport) => r.departments,
    columns: [
      { header: "月", value: (x: Row<"departments">) => x.month },
      { header: "依頼部署", value: (x: Row<"departments">) => x.department },
      { header: "案件", value: (x: Row<"departments">) => x.matters },
      { header: "うち業務委託", value: (x: Row<"departments">) => x.outsourcing },
      { header: "発注書", value: (x: Row<"departments">) => x.purchaseOrders }
    ] as Array<Column<any>>
  },
  intake: {
    label: "依頼部署別の依頼",
    rows: (r: AuditReport) => r.intake,
    columns: [
      { header: "月", value: (x: Row<"intake">) => x.month },
      { header: "依頼部署", value: (x: Row<"intake">) => x.department },
      { header: "依頼", value: (x: Row<"intake">) => x.requests },
      { header: "受付済", value: (x: Row<"intake">) => x.accepted }
    ] as Array<Column<any>>
  },
  dueVerdicts: {
    label: "支払期日の判定",
    rows: (r: AuditReport) => r.dueVerdicts,
    columns: [
      { header: "種類", value: (x: Row<"dueVerdicts">) => PAY_KIND_LABEL[x.payKind] },
      { header: "区分", value: (x: Row<"dueVerdicts">) => PARTY_KIND_LABEL(x.partyKind) },
      { header: "判定", value: (x: Row<"dueVerdicts">) => VERDICT_LABEL[x.verdict] },
      { header: "件数", value: (x: Row<"dueVerdicts">) => x.count },
      { header: "金額（税抜）", value: (x: Row<"dueVerdicts">) => x.amount },
      { header: "最長日数", value: (x: Row<"dueVerdicts">) => x.maxDays }
    ] as Array<Column<any>>
  },
  dueExceptions: {
    label: "期日超過・未設定の支払",
    rows: (r: AuditReport) => r.dueExceptions,
    columns: [
      { header: "支払番号", value: (x: Row<"dueExceptions">) => x.paymentNo },
      { header: "相手先", value: (x: Row<"dueExceptions">) => x.party },
      { header: "区分", value: (x: Row<"dueExceptions">) => PARTY_KIND_LABEL(x.partyKind) },
      { header: "種類", value: (x: Row<"dueExceptions">) => PAY_KIND_LABEL[x.payKind] },
      { header: "金額（税抜）", value: (x: Row<"dueExceptions">) => x.amount },
      { header: "受領日", value: (x: Row<"dueExceptions">) => x.basisReceivedOn },
      { header: "期日", value: (x: Row<"dueExceptions">) => x.dueOn },
      { header: "日数", value: (x: Row<"dueExceptions">) => x.days },
      { header: "状態", value: (x: Row<"dueExceptions">) => x.status }
    ] as Array<Column<any>>
  },
  outsourcingWithoutPo: {
    label: "発注書の無い業務委託の支払",
    rows: (r: AuditReport) => r.outsourcingWithoutPo,
    columns: [
      { header: "支払番号", value: (x: Row<"outsourcingWithoutPo">) => x.paymentNo },
      { header: "相手先", value: (x: Row<"outsourcingWithoutPo">) => x.party },
      { header: "金額（税抜）", value: (x: Row<"outsourcingWithoutPo">) => x.amount },
      { header: "登録日", value: (x: Row<"outsourcingWithoutPo">) => x.createdOn },
      { header: "条件", value: (x: Row<"outsourcingWithoutPo">) => x.conditions }
    ] as Array<Column<any>>
  },
  unattributedMatters: {
    label: "依頼者未入力の案件",
    rows: (r: AuditReport) => r.unattributedMatters,
    columns: [
      { header: "案件番号", value: (x: Row<"unattributedMatters">) => x.matterNo },
      { header: "案件名", value: (x: Row<"unattributedMatters">) => x.title },
      { header: "種別", value: (x: Row<"unattributedMatters">) => MATTER_KIND_LABEL[x.kind] ?? x.kind },
      { header: "取引先", value: (x: Row<"unattributedMatters">) => x.counterparties },
      { header: "担当", value: (x: Row<"unattributedMatters">) => x.owner },
      { header: "作成日", value: (x: Row<"unattributedMatters">) => x.createdOn }
    ] as Array<Column<any>>
  },
  quality: {
    label: "データ品質",
    rows: (r: AuditReport) => r.quality,
    columns: [
      { header: "ルール", value: (x: Row<"quality">) => x.ruleCode },
      { header: "重大度", value: (x: Row<"quality">) => x.severity },
      { header: "未解決", value: (x: Row<"quality">) => x.open },
      { header: "解決", value: (x: Row<"quality">) => x.resolved },
      { header: "対象外", value: (x: Row<"quality">) => x.ignored },
      { header: "最終検出", value: (x: Row<"quality">) => x.lastDetected }
    ] as Array<Column<any>>
  },
  jobs: {
    label: "定期ジョブ",
    rows: (r: AuditReport) => r.jobs,
    columns: [
      { header: "ジョブ", value: (x: Row<"jobs">) => x.action },
      { header: "回数", value: (x: Row<"jobs">) => x.runs },
      { header: "動いた日数", value: (x: Row<"jobs">) => x.days },
      { header: "最終実行", value: (x: Row<"jobs">) => x.lastRun }
    ] as Array<Column<any>>
  }
} as const;

export type AuditCsvSection = keyof typeof AUDIT_CSV;
export const isAuditCsvSection = (value: string): value is AuditCsvSection =>
  Object.prototype.hasOwnProperty.call(AUDIT_CSV, value);
