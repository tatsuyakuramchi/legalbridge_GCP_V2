import { dateStr, type Queryable } from "../core/db.js";

/**
 * 支払文書の依頼（検収書・利用許諾計算書）を案件にせず処理する。docs/v3-request-inbox.md §8
 *
 * 毎期の計算書・検収書は定型業務で、案件にしても Slack・Backlog・Drive の入れ物を
 * 使う場面がほとんど無い。一方で「誰がいつまでにやるか」と「依頼者への連絡」は要る。
 * そこで依頼（REQ-…）そのものを小さなチケットにして、
 *
 *   受付 → 作成 → 送付 → 支払予定 → 支払
 *
 * を追う。工程は保存しない（案件の工程と同じく、文書・送付・支払から導く）。
 *
 * 発注書が案件に入っている検収書は、その案件で作る（案件の工程・スレッドに揃える）。
 * ここで直に処理するのは、案件に入っていない発注書の検収書と、利用許諾計算書。
 */

export type PaymentPurpose = "inspection" | "royalty";

export const PAYMENT_PURPOSES: PaymentPurpose[] = ["inspection", "royalty"];

export const isPaymentPurpose = (v: unknown): v is PaymentPurpose =>
  v === "inspection" || v === "royalty";

/**
 * デイリータスク（A-064）にできる依頼の種別。支払の書類のほかに、
 * 定型文書（当社ひな形の NDA など）と その他 を受ける。
 * 支払の書類だけが対象の番号から条件を引き当て、支払まで自動で追う。
 */
export type DailyPurpose = PaymentPurpose | "template" | "other";

export const DAILY_PURPOSES: DailyPurpose[] = ["inspection", "royalty", "template", "other"];

export const isDailyPurpose = (v: unknown): v is DailyPurpose =>
  isPaymentPurpose(v) || v === "template" || v === "other";

/** 依頼の種類の呼び名（通知の文面に使う）。 */
export const paymentDocLabel = (purpose: DailyPurpose) =>
  purpose === "inspection" ? "検収書" : purpose === "royalty" ? "利用許諾計算書"
    : purpose === "template" ? "定型文書" : "文書";

/** 検収書のテンプレート。graph-service・template-context と同じ集合。 */
export const INSPECTION_TEMPLATE_KEYS = [
  "inspection_certificate", "intl_inspection_certificate", "acceptance_certificate", "delivery_note"
];

/**
 * 依頼者が打った番号を揃える。全角・空白・小文字が混じって届く
 * （Slack のフォームは自由記述）。
 */
export function normalizeDocNo(value: unknown): string | null {
  const s = String(value ?? "")
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[‐‑‒–—―ー－]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
  return s || null;
}

/**
 * 番号の欄を番号の並びに分ける。「A, B／C」のように複数書ける。
 * 数字を含まないもの（「わからない」「不明」など）は番号ではないので落とす。
 * 揃えた番号を返す（空なら []）。
 */
export function splitDocNos(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of String(value ?? "").split(/[,，、;；/／\n\r]+|\s{2,}|\s+(?=[A-Za-z０-９0-9])/)) {
    const n = normalizeDocNo(raw);
    if (n && /\d/.test(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

export interface PaymentTarget {
  /** 打たれた番号（揃えたもの）。 */
  docNo: string;
  /** 当たった文書（発注書・契約書）。契約番号で当たったときは null。 */
  documentId: number | null;
  documentNo: string | null;
  agreementId: number | null;
  agreementNo: string | null;
  counterpartyId: number | null;
  counterpartyName: string | null;
  /** 対象の条件。検収書なら発注書に載った条件、計算書なら契約の許諾（IN）の条件。 */
  conditions: Array<{ id: number; conditionNo: string | null; name: string }>;
  /** 発注書・条件が入っている案件（1つに決まるときだけ）。 */
  matter: { id: number; matterNo: string | null; title: string; status: string } | null;
}

/**
 * 対象の番号から、条件と案件を引き当てる。当たらなければ null。
 *
 *   検収書 … 発注書番号 → 発注書 → 載っている条件・発注書の案件
 *   計算書 … 契約書番号 → 合意（agreement_no）か契約書の文書 → 合意の許諾（IN）の条件
 */
export async function resolvePaymentTarget(
  q: Queryable, purpose: PaymentPurpose, rawNo: unknown
): Promise<PaymentTarget | null> {
  const nos = splitDocNos(rawNo);
  if (nos.length > 1) return resolveMany(q, purpose, nos);
  const docNo = nos[0] ?? null;
  if (!docNo) return null;

  const docRow = (await q.query(
    `SELECT d.id, d.document_no, d.agreement_id, d.matter_id
       FROM documents d
      WHERE upper(d.document_no) = $1 AND d.status IN ('issued', 'superseded', 'draft')
      ORDER BY (d.status = 'issued') DESC, d.id DESC
      LIMIT 1`, [docNo])).rows[0] as Record<string, any> | undefined;

  let agreementId: number | null = docRow?.agreement_id ? Number(docRow.agreement_id) : null;
  let conditionIds: number[] = [];

  if (docRow) {
    const c = await q.query(
      `SELECT condition_id FROM document_conditions WHERE document_id = $1 ORDER BY line_no`, [docRow.id]);
    conditionIds = (c.rows as any[]).map((r) => Number(r.condition_id));
  }
  if (!docRow || (purpose === "royalty" && !conditionIds.length)) {
    if (!agreementId) {
      const a = (await q.query(
        "SELECT id FROM agreements WHERE upper(agreement_no) = $1 LIMIT 1", [docNo])).rows[0] as any;
      agreementId = a ? Number(a.id) : null;
    }
    if (agreementId && purpose === "royalty") {
      // 計算書は作者から取った権利（IN の許諾）に対して出す。生きている版だけ。
      const c = await q.query(
        `SELECT id FROM conditions
          WHERE agreement_id = $1 AND direction = 'in' AND kind = 'license'
            AND status IN ('active', 'scheduled')
          ORDER BY condition_no NULLS LAST, id`, [agreementId]);
      conditionIds = (c.rows as any[]).map((r) => Number(r.id));
    }
  }
  if (!docRow && !agreementId) return null;

  const conditions = conditionIds.length
    ? ((await q.query(
        `SELECT c.id, c.condition_no, c.name, c.counterparty_id, p.name AS party_name
           FROM conditions c LEFT JOIN parties p ON p.id = c.counterparty_id
          WHERE c.id = ANY($1::bigint[]) ORDER BY c.condition_no NULLS LAST, c.id`,
        [conditionIds])).rows as any[])
    : [];

  const agreement = agreementId
    ? (await q.query(
        `SELECT a.agreement_no, a.counterparty_id, p.name AS party_name
           FROM agreements a LEFT JOIN parties p ON p.id = a.counterparty_id WHERE a.id = $1`,
        [agreementId])).rows[0] as any
    : null;

  // 案件。発注書そのものが案件に入っていればそれ。無ければ条件が1つの案件に入っているとき。
  let matter: PaymentTarget["matter"] = null;
  const matterQuery = docRow?.matter_id
    ? await q.query(
        `SELECT id, matter_no, title, status, merged_into_id FROM matters WHERE id = $1`, [docRow.matter_id])
    : conditionIds.length
    ? await q.query(
        `SELECT DISTINCT m.id, m.matter_no, m.title, m.status, m.merged_into_id
           FROM matter_links l JOIN matters m ON m.id = l.matter_id
          WHERE l.target_type = 'condition' AND l.target_ref = ANY($1::text[])
            AND m.status <> 'canceled'`, [conditionIds.map(String)])
    : { rows: [] as any[] };
  const matters = matterQuery.rows as any[];
  if (matters.length === 1) {
    let m = matters[0];
    // 統合済みの案件なら統合先へ。
    if (m.merged_into_id) {
      m = (await q.query(`SELECT id, matter_no, title, status FROM matters WHERE id = $1`,
                         [m.merged_into_id])).rows[0] ?? m;
    }
    matter = { id: Number(m.id), matterNo: m.matter_no ?? null, title: String(m.title), status: String(m.status) };
  }

  const first = conditions[0];
  return {
    docNo,
    documentId: docRow ? Number(docRow.id) : null,
    documentNo: docRow?.document_no ?? null,
    agreementId,
    agreementNo: agreement?.agreement_no ?? null,
    counterpartyId: first?.counterparty_id ? Number(first.counterparty_id)
      : agreement?.counterparty_id ? Number(agreement.counterparty_id) : null,
    counterpartyName: first?.party_name ?? agreement?.party_name ?? null,
    conditions: conditions.map((c) => ({ id: Number(c.id), conditionNo: c.condition_no ?? null, name: String(c.name) })),
    matter
  };
}

/**
 * 番号が複数のとき。1 本ずつ引き当てて束ねる。条件は和集合、相手先は最初に当たったもの、
 * 案件は全部が同じ 1 つのときだけ。当たらなかった番号は docNo に残す（人が見て直せる）。
 */
async function resolveMany(q: Queryable, purpose: PaymentPurpose, nos: string[]): Promise<PaymentTarget | null> {
  const hits: PaymentTarget[] = [];
  for (const no of nos) {
    const t = await resolvePaymentTarget(q, purpose, no);
    if (t) hits.push(t);
  }
  if (!hits.length) return null;
  const seen = new Set<number>();
  const conditions = hits.flatMap((t) => t.conditions).filter((c) => !seen.has(c.id) && seen.add(c.id));
  const matterIds = new Set(hits.map((t) => t.matter?.id ?? 0));
  const first = hits[0];
  return {
    docNo: nos.join(", "),
    documentId: hits.length === 1 ? first.documentId : null,
    documentNo: hits.length === 1 ? first.documentNo : null,
    agreementId: hits.length === 1 ? first.agreementId : null,
    agreementNo: hits.length === 1 ? first.agreementNo : null,
    counterpartyId: hits.find((t) => t.counterpartyId)?.counterpartyId ?? null,
    counterpartyName: hits.find((t) => t.counterpartyName)?.counterpartyName ?? null,
    conditions,
    matter: matterIds.size === 1 && first.matter ? first.matter : null
  };
}

// ---------------------------------------------------------------------
// 工程
// ---------------------------------------------------------------------

export type StageKey = "accepted" | "created" | "sent" | "scheduled" | "paid";

export interface RequestStage {
  key: StageKey;
  label: string;
  done: boolean;
  at: string | null;
  detail: string;
}

export interface RequestProgress {
  stages: RequestStage[];
  /** いまの段。全部済んだ（か、人が完了にした）なら null。 */
  current: RequestStage | null;
  complete: boolean;
  documents: Array<{ id: number; documentNo: string | null; status: string; pinned: boolean }>;
  payments: Array<{ id: number; paymentNo: string | null; status: string; dueOn: string | null; paidOn: string | null }>;
}

export interface ProgressFacts {
  purpose: DailyPurpose;
  acceptedAt: string | null;
  /** 作業（tasks）の完了日時。人が完了にした、または支払が済んで自動で完了した。 */
  doneAt: string | null;
  documents: Array<{ id: number; documentNo: string | null; status: string; pinned: boolean;
                     issuedAt?: string | null }>;
  sentAt: string | null;
  payments: RequestProgress["payments"];
}

export const STAGE_LABEL: Record<StageKey, string> = {
  accepted: "受付", created: "作成", sent: "送付", scheduled: "支払予定", paid: "支払"
};

/**
 * 事実から工程を導く。純粋関数（試験できるように）。
 * 支払の書類（検収書・計算書）は 受付→作成→送付→支払予定→支払。
 * 定型文書・その他は 受付→作成→送付 まで（支払は無い。完了は人が付ける）。
 */
export function progressOf(f: ProgressFacts): RequestProgress {
  const label = paymentDocLabel(f.purpose);
  const payment = isPaymentPurpose(f.purpose);
  const issued = f.documents.filter((d) => d.status === "issued");
  const drafts = f.documents.filter((d) => d.status === "draft");
  const live = f.payments.filter((p) => p.status !== "canceled");
  const paid = payment && live.length > 0 && live.every((p) => p.status === "paid");
  const nextDue = live.filter((p) => p.status !== "paid").map((p) => p.dueOn).filter(Boolean).sort()[0] ?? null;
  const lastPaid = live.map((p) => p.paidOn).filter(Boolean).sort().reverse()[0] ?? null;
  const nos = (docs: typeof f.documents) => docs.map((d) => d.documentNo ?? `#${d.id}`).join("・");

  const stages: RequestStage[] = [
    { key: "accepted", label: STAGE_LABEL.accepted, done: f.acceptedAt !== null, at: f.acceptedAt,
      detail: f.acceptedAt ? "受け付けた" : "" },
    { key: "created", label: STAGE_LABEL.created, done: issued.length > 0,
      at: issued.map((d) => d.issuedAt ?? null).filter(Boolean).sort()[0] ?? null,
      detail: issued.length ? `${label}を決定（${nos(issued)}）`
        : drafts.length ? `${label}の下書きあり（${nos(drafts)}）`
        : `${label}はまだ無い` },
    { key: "sent", label: STAGE_LABEL.sent, done: f.sentAt !== null, at: f.sentAt,
      detail: f.sentAt ? "相手方へ送付した（メールか CloudSign）" : "まだ送っていない" },
    ...(payment ? [
      { key: "scheduled" as const, label: STAGE_LABEL.scheduled, done: live.length > 0, at: null,
        detail: live.length
          ? `支払 ${live.map((p) => p.paymentNo ?? `#${p.id}`).join("・")}${nextDue ? `（支払予定日 ${nextDue}）` : ""}`
          : "支払の予定がまだ無い" },
      { key: "paid" as const, label: STAGE_LABEL.paid, done: paid, at: paid ? lastPaid : null,
        detail: paid ? `支払済み${lastPaid ? `（${lastPaid}）` : ""}` : "" }
    ] : [])
  ];
  const complete = paid || f.doneAt !== null;
  return {
    stages,
    current: complete ? null : stages.find((s) => !s.done) ?? null,
    complete,
    documents: f.documents.map(({ id, documentNo, status, pinned }) => ({ id, documentNo, status, pinned })),
    payments: f.payments
  };
}

/** 依頼者に知らせる節目の文面。 */
export function milestoneText(key: StageKey | "done", purpose: DailyPurpose, p: RequestProgress): string {
  const label = paymentDocLabel(purpose);
  const issued = p.documents.filter((d) => d.status === "issued").map((d) => d.documentNo ?? `#${d.id}`);
  const live = p.payments.filter((x) => x.status !== "canceled");
  const due = live.filter((x) => x.status !== "paid").map((x) => x.dueOn).filter(Boolean).sort()[0];
  switch (key) {
    case "accepted": return `受け付けました。${label}を作ります。`;
    case "created": return `${label}を作りました${issued.length ? `（${issued.join("・")}）` : ""}。`;
    case "sent": return `${label}を相手方へ送付しました。`;
    case "scheduled": return `支払の予定を立てました${due ? `（支払予定日 ${due}）` : ""}。`;
    case "paid": return "支払まで済みました。対応を完了します。ありがとうございました。";
    case "done": return "法務の対応を完了しました。ありがとうございました。";
  }
}

/** いま成り立っている節目のキー（受付は受け付けたときに送るので含めない）。 */
export function firedKeys(p: RequestProgress, doneAt: string | null): Array<StageKey | "done"> {
  const keys: Array<StageKey | "done"> = p.stages
    .filter((s) => s.done && s.key !== "accepted").map((s) => s.key);
  if (doneAt && !keys.includes("paid")) keys.push("done");
  return keys;
}

/**
 * 依頼1件の事実を集める。
 *
 * 文書は、人が繋いだもの（intake_request_links の document）と、依頼より後に
 * 作られた文書のうち、依頼の条件（改訂の系列ごと）に載っていて依頼の種類に合うもの
 * （検収書のテンプレート／計算書）。無効にした文書は数えない。
 * 定型文書・その他は条件を持たないので、人が繋いだ文書だけを見る。
 */
export async function loadProgress(
  q: Queryable,
  request: { id: number; purpose: DailyPurpose; createdAt: string; acceptedAt: string | null; doneAt: string | null }
): Promise<RequestProgress> {
  const d = await q.query(
    `SELECT d.id, d.document_no, d.status, d.issued_at, (l.target_id IS NOT NULL) AS pinned
       FROM documents d
       LEFT JOIN document_template_versions v ON v.id = d.template_version_id
       LEFT JOIN document_templates t ON t.id = v.template_id
       LEFT JOIN intake_request_links l
              ON l.request_id = $1 AND l.target_type = 'document' AND l.target_id = d.id
      WHERE d.status IN ('draft', 'issued')
        AND (l.target_id IS NOT NULL
             -- 許諾料の回に繋いだ依頼（A-060）：その回の実績を載せた計算書
             OR EXISTS (SELECT 1 FROM condition_events re
                          JOIN intake_request_links rl ON rl.request_id = $1
                           AND ((rl.target_type = 'schedule' AND re.schedule_id = rl.target_id)
                             OR (rl.target_type = 'event' AND re.id = rl.target_id))
                         WHERE re.document_id = d.id)
             OR ($3 IN ('inspection', 'royalty') AND d.created_at >= $2::timestamptz
                 AND EXISTS (
                   SELECT 1 FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
                    WHERE dc.document_id = d.id
                      AND COALESCE(c.series_id, c.id) IN (
                        SELECT COALESCE(x.series_id, x.id)
                          FROM intake_request_links rl JOIN conditions x ON x.id = rl.target_id
                         WHERE rl.request_id = $1 AND rl.target_type = 'condition'))
                 AND (($3 = 'inspection' AND t.template_key = ANY($4::text[]))
                      OR ($3 = 'royalty' AND (t.template_key LIKE '%statement%'
                                              OR EXISTS (SELECT 1 FROM statements s WHERE s.document_id = d.id))))))
      ORDER BY d.id`,
    [request.id, request.createdAt, request.purpose, INSPECTION_TEMPLATE_KEYS]);
  const documents = (d.rows as any[]).map((r) => ({
    id: Number(r.id), documentNo: r.document_no ?? null, status: String(r.status),
    pinned: Boolean(r.pinned), issuedAt: r.issued_at ? new Date(String(r.issued_at)).toISOString() : null
  }));
  const ids = documents.map((x) => x.id);

  const sent = ids.length
    ? (await q.query(
        `SELECT min(occurred_at) AS at FROM audit_events
          WHERE target_type = 'document' AND target_id = ANY($1::bigint[])
            AND action IN ('gmail.send', 'cloudsign.send')`, [ids])).rows[0] as any
    : null;

  const pay = ids.length
    ? (await q.query(
        `SELECT DISTINCT p.id, p.payment_no, p.status, p.due_on, p.paid_on
           FROM payments p
           JOIN payment_allocations al ON al.payment_id = p.id
           JOIN condition_events e ON e.id = al.event_id
          WHERE e.document_id = ANY($1::bigint[])
          ORDER BY p.id`, [ids])).rows as any[]
    : [];

  return progressOf({
    purpose: request.purpose,
    acceptedAt: request.acceptedAt,
    doneAt: request.doneAt,
    documents,
    sentAt: sent?.at ? new Date(String(sent.at)).toISOString() : null,
    payments: pay.map((p) => ({
      id: Number(p.id), paymentNo: p.payment_no ?? null, status: String(p.status),
      dueOn: dateStr(p.due_on), paidOn: dateStr(p.paid_on)
    }))
  });
}
