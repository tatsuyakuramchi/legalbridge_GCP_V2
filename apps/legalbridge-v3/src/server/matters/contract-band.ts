import type { Queryable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { translate } from "../core/errors.js";
import { signStateOf, signStateSql, type SignState } from "../documents/sign-state.js";

/**
 * マップの「契約のみ（条件なし）」の帯（docs/navigation.md §11）。
 *
 * IN／OUT の帯は条件が 1 行。条件を持たない契約（基本契約・NDA・覚書・解除合意・番号だけ取った文書）は
 * そこに出ないので、契約 1 本を 1 行にして、締結までの段（文書 → 送付 → 締結 → 期限）を並べる。
 *
 * 行の出どころ
 *   - 文書：どの条件にも結ばれていない文書（無効・退いた版を除く）。番号だけ取った文書（reserved）を含む。
 *   - 契約：文書も条件も持たない契約の記録（登録だけした基本契約など）。
 * 切り口
 *   - 案件：案件に付いた文書（documents.matter_id・繋がり）と、繋がりで付けた契約。
 *     会社全体で結ぶ契約は、会社全体の案件を立ててそこに付ける（取引先の無い行になる）。
 *   - 取引先：その取引先の文書（v_document_display の相手先）と契約。
 *   - 作品：作品を軸にした案件に付いた文書と契約。
 *
 * 番号だけ取った文書は、ファイル（PDF）を取り込み、締結を記録するまで止まりにする（記録を求める）。
 */

export type ContractScope = { matterId: number } | { partyId: number } | { workId: number };
export type StepState = "ok" | "stop" | "wait" | "none";
export interface ContractStep { state: StepState; label: string; sub?: string | null }

export interface ContractRow {
  key: string;
  source: "document" | "agreement";
  /** 文書なら文書の id、契約なら契約の id。 */
  id: number;
  number: string | null;
  title: string | null;
  /** 種類（ひな形の名前・取り込みの種別・契約の種類）。 */
  kindLabel: string;
  party: { id: number; name: string } | null;
  /** 契約の根（基本契約・単体契約）。覚書なら親の基本契約。 */
  contract: { id: number; agreementNo: string | null; kind: string } | null;
  /** 文書が結ばれている契約（自分が契約の記録なら自分）。 */
  agreementId: number | null;
  /** 番号だけ取った文書（ファイル待ち・取り込んだ後も印として残す）。 */
  numberOnly: boolean;
  /** ひな形の無い文書（取り込み・番号だけ）。送付は外で行うので段に出さない。 */
  external: boolean;
  sign: SignState;
  steps: { document: ContractStep; send: ContractStep; sign: ContractStep; term: ContractStep };
  /** いま止まっている段（行の先頭の赤）。無ければ null。 */
  stuck: "document" | "send" | "sign" | null;
}

/** 満了がこの日数以内なら期限の段を待ち（黄）にする。 */
const TERM_WARN_DAYS = 60;

const md = (d: string | null) => (d ? d.slice(5).replace("-", "/") : null);

interface RawRow {
  source: "document" | "agreement"; id: number; number: string | null; title: string | null; kindLabel: string;
  party: ContractRow["party"]; contract: ContractRow["contract"]; agreementId: number | null;
  status: string; reserved: boolean; external: boolean; hasFile: boolean; sentAt: string | null; sign: SignState;
  executedOn: string | null; expiresOn: string | null; autoRenewal: boolean; agreementStatus: string | null;
}

/** 段を組む。DB を触らない（テストしやすいように分けておく）。 */
export function stepsOf(r: RawRow, today: string): Pick<ContractRow, "steps" | "stuck"> {
  // 文書の段：番号だけ（ファイル待ち）／下書き／決定済み。契約の記録だけなら記録あり。
  let document: ContractStep;
  if (r.source === "agreement") {
    document = { state: "ok", label: "契約の記録", sub: "文書なし" };
  } else if (r.reserved && !r.hasFile) {
    document = { state: "stop", label: "ファイル待ち", sub: "番号だけ取った（PDF を取り込む）" };
  } else if (r.status === "draft") {
    document = { state: "stop", label: "下書き", sub: "決定する" };
  } else {
    document = { state: "ok", label: r.external ? "取込済み" : "決定済み" };
  }

  const executed = r.sign.status === "executed" || (r.source === "agreement" && r.agreementStatus === "executed");
  const signedOn = r.sign.status === "executed" ? r.sign.at : r.executedOn;

  // 送付の段：ひな形の文書だけ。取り込み・番号だけ・契約の記録は外でやり取りするので「—」。
  let send: ContractStep;
  if (r.external || r.source === "agreement") {
    send = { state: "none", label: "—", sub: "外で送付" };
  } else if (r.sentAt || ["sent", "executed", "terminated"].includes(r.sign.status)) {
    send = { state: "ok", label: `送付済${r.sentAt ? ` ${md(r.sentAt)}` : ""}` };
  } else if (document.state === "ok" && !executed) {
    send = { state: "stop", label: "未送付" };
  } else {
    send = { state: "none", label: "—" };
  }

  // 締結の段：CloudSign の状態（手で記録したものを含む）か、契約の締結日。
  let sign: ContractStep;
  if (executed) {
    sign = { state: "ok", label: `締結済${signedOn ? ` ${md(signedOn)}` : ""}`, sub: r.sign.source === "manual" ? "手で記録" : null };
  } else if (r.sign.status === "terminated") {
    sign = { state: "stop", label: "取下げ", sub: r.sign.at ? md(r.sign.at) : null };
  } else if (r.sign.status === "sent" || r.sign.status === "drafted") {
    sign = { state: "wait", label: "署名待ち", sub: r.sign.at ? `送信 ${md(r.sign.at)}` : null };
  } else {
    sign = { state: "stop", label: "まだ", sub: "締結を記録する" };
  }

  // 期限の段：契約の満了・自動更新。近づいたら待ち（黄）、過ぎたら止まり。
  let term: ContractStep;
  if (r.expiresOn) {
    const days = Math.round((Date.parse(r.expiresOn) - Date.parse(today)) / 86_400_000);
    term = days < 0 ? { state: "stop", label: `満了 ${r.expiresOn}`, sub: "満了を過ぎた" }
      : days <= TERM_WARN_DAYS ? { state: "wait", label: `満了 ${r.expiresOn}`, sub: `あと ${days} 日${r.autoRenewal ? "（自動更新）" : ""}` }
      : { state: "ok", label: `満了 ${r.expiresOn}`, sub: r.autoRenewal ? "自動更新" : null };
  } else if (r.autoRenewal) {
    term = { state: "ok", label: "自動更新" };
  } else {
    term = { state: "none", label: "—" };
  }

  // 止まりは前の段から 1 つだけ（束の画面と同じ「いま止まっている手」）。
  const stuck = document.state === "stop" ? "document" : send.state === "stop" ? "send" : sign.state === "stop" ? "sign" : null;
  const quiet = (s: ContractStep, k: string): ContractStep => (s.state === "stop" && stuck !== k ? { ...s, state: "none" } : s);
  return {
    steps: { document, send: quiet(send, "send"), sign: quiet(sign, "sign"), term },
    stuck
  };
}

export class ContractBandService {
  constructor(private readonly database: Queryable, private readonly today: () => string = () => new Date().toISOString().slice(0, 10)) {}

  async rows(scope: ContractScope): Promise<ContractRow[]> {
    try {
      const { docWhere, agrWhere, agrConditions, param } = scopeSql(scope);
      const docs = await this.database.query(
        `SELECT d.id, d.document_no, d.status, d.agreement_id, d.storage_url,
                (d.template_version_id IS NULL) AS external,
                COALESCE((d.manual_inputs ->> 'reserved')::boolean, false) AS reserved,
                COALESCE(NULLIF(d.manual_inputs ->> 'title', ''), v.title) AS title,
                COALESCE(t.label, NULLIF(d.manual_inputs ->> 'documentKind', ''), '文書') AS kind_label,
                v.counterparty_id AS party_id, v.counterparty AS party_name,
                (SELECT dv.sent_at FROM document_delivery(d.id) dv) AS sent_at,
                ${signStateSql("d.id")} AS sign,
                r.id AS root_id, r.agreement_no AS root_no, COALESCE(r.kind, 'master') AS root_kind,
                a.executed_on, a.expires_on, a.auto_renewal, a.status AS agreement_status
           FROM documents d
           LEFT JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
           LEFT JOIN agreements a ON a.id = d.agreement_id
           LEFT JOIN agreements r ON r.id = COALESCE(a.parent_id, a.id)
          WHERE d.status NOT IN ('void', 'superseded')
            AND NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)
            AND (${docWhere})
          ORDER BY d.id DESC
          LIMIT 300`, [param]);
      const agrs = await this.database.query(
        `SELECT a.id, a.agreement_no, a.title, COALESCE(a.kind, 'master') AS kind, a.status, a.executed_on, a.expires_on,
                a.auto_renewal, p.id AS party_id, p.name AS party_name,
                r.id AS root_id, r.agreement_no AS root_no, COALESCE(r.kind, 'master') AS root_kind
           FROM agreements a
           LEFT JOIN parties p ON p.id = a.counterparty_id
           LEFT JOIN agreements r ON r.id = a.parent_id
          WHERE a.order_document_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.agreement_id = a.id AND d.status <> 'void')
            AND NOT EXISTS (SELECT 1 FROM conditions c JOIN agreements ca ON ca.id = c.agreement_id
                             WHERE (ca.id = a.id OR ca.parent_id = a.id) AND c.status NOT IN ('void', 'superseded')
                               AND (${agrConditions}))
            AND (${agrWhere})
          ORDER BY a.id DESC
          LIMIT 200`, [param]);
      const today = this.today();
      const KIND: Record<string, string> = { master: "基本契約", standalone: "単体契約", supplement: "覚書・個別契約", termination: "解除合意", document: "文書" };
      const raws: RawRow[] = [
        ...(docs.rows as any[]).map((x): RawRow => ({
          source: "document", id: Number(x.id), number: str(x.document_no), title: str(x.title), kindLabel: String(x.kind_label),
          party: x.party_id ? { id: Number(x.party_id), name: String(x.party_name ?? "") } : null,
          contract: x.root_id ? { id: Number(x.root_id), agreementNo: str(x.root_no), kind: String(x.root_kind) } : null,
          agreementId: int(x.agreement_id), status: String(x.status), reserved: x.reserved === true,
          external: x.external === true, hasFile: Boolean(x.storage_url) || x.external !== true,
          sentAt: dateStr(x.sent_at), sign: signStateOf(x.sign),
          executedOn: dateStr(x.executed_on), expiresOn: dateStr(x.expires_on), autoRenewal: x.auto_renewal === true,
          agreementStatus: str(x.agreement_status)
        })),
        ...(agrs.rows as any[]).map((x): RawRow => ({
          source: "agreement", id: Number(x.id), number: str(x.agreement_no), title: str(x.title),
          kindLabel: KIND[String(x.kind)] ?? "契約",
          party: x.party_id ? { id: Number(x.party_id), name: String(x.party_name ?? "") } : null,
          contract: x.root_id ? { id: Number(x.root_id), agreementNo: str(x.root_no), kind: String(x.root_kind) } : null,
          agreementId: Number(x.id), status: "issued", reserved: false, external: true, hasFile: true,
          sentAt: null, sign: signStateOf(null),
          executedOn: dateStr(x.executed_on), expiresOn: dateStr(x.expires_on), autoRenewal: x.auto_renewal === true,
          agreementStatus: str(x.status)
        }))
      ];
      return raws.map((r) => ({
        key: `${r.source}:${r.id}`, source: r.source, id: r.id, number: r.number, title: r.title, kindLabel: r.kindLabel,
        party: r.party, contract: r.contract, agreementId: r.agreementId, numberOnly: r.reserved, external: r.external,
        sign: r.sign, ...stepsOf(r, today)
      }));
    } catch (error) { throw translate(error); }
  }
}

/** 切り口ごとの絞り込み（文書は d・v、契約は a）。$1 が切り口の id。 */
function scopeSql(scope: ContractScope): { docWhere: string; agrWhere: string; agrConditions: string; param: number } {
  if ("matterId" in scope) {
    return {
      param: scope.matterId,
      // 案件の切り口：契約に条件があっても、その条件がこの案件に入っていなければ帯に出す
      // （会社全体の案件に付けた基本契約は、条件が別の案件にあっても、ここでは契約として見える）。
      agrConditions: `EXISTS (SELECT 1 FROM matter_links mc WHERE mc.matter_id = $1 AND mc.target_type = 'condition'
                               AND mc.target_ref = c.id::text)`,
      docWhere: `d.matter_id = $1
        OR EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $1 AND ml.target_type = 'document' AND ml.target_ref = d.id::text)
        OR (d.agreement_id IS NOT NULL AND EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $1
              AND ml.target_type = 'agreement' AND ml.target_ref = d.agreement_id::text))`,
      agrWhere: `EXISTS (SELECT 1 FROM matter_links ml WHERE ml.matter_id = $1 AND ml.target_type = 'agreement' AND ml.target_ref = a.id::text)`
    };
  }
  if ("partyId" in scope) {
    return { param: scope.partyId, docWhere: "v.counterparty_id = $1", agrWhere: "a.counterparty_id = $1", agrConditions: "true" };
  }
  return {
    param: scope.workId,
    agrConditions: "true",
    docWhere: `d.matter_id IN (SELECT m.id FROM matters m WHERE m.work_id = $1)
        OR EXISTS (SELECT 1 FROM matter_links ml JOIN matters m ON m.id = ml.matter_id
                    WHERE m.work_id = $1 AND ml.target_type = 'document' AND ml.target_ref = d.id::text)`,
    agrWhere: `EXISTS (SELECT 1 FROM matter_links ml JOIN matters m ON m.id = ml.matter_id
                        WHERE m.work_id = $1 AND ml.target_type = 'agreement' AND ml.target_ref = a.id::text)`
  };
}
