import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { parseVariables, type TemplateVariable } from "./binding.js";
import { LICENSE_TERMS_VARIABLES, isLicenseTermsTemplate } from "./license-terms.js";
import { PUB_TERMS_VARIABLES, isPubTermsTemplate } from "./pub-terms.js";
import { printedDocumentNumber, showRevisionOf } from "./numbering.js";
import { DEFAULT_TAX_ROUNDING, TAX_ROUNDING_INPUT, TAX_ROUNDING_LABEL } from "../core/rounding.js";

export interface DocumentSummary {
  id: number;
  documentNo: string | null;
  /**
   * 紙・メールに出る番号。訂正版は社内の番号に枝番（-R2）が付くが、紙には本体の番号を
   * 印字し、改訂の印「（改訂 n）」は訂正版ごとの選択で添える。1 版目は documentNo と同じ。
   */
  printedNo: string | null;
  status: string;
  templateKey: string | null;
  templateLabel: string | null;
  title: string | null;
  /** 外で作られた文書。ひな形が無いので、作り直しも再レンダリングもできない。 */
  imported: boolean;
  /** 相手方が付けた文書番号の控え（A-072）。無ければ null。 */
  counterpartyDocNo: string | null;
  counterparty: string | null;
  matterId: number | null;
  matterNo: string | null;
  /** この文書が属する契約（基本契約・個別契約・単体契約）。無ければ null。 */
  agreementId: number | null;
  conditionCount: number;
  /** 紐づく条件明細。件数ではなく番号を出す（何から出た書類かが分かる）。 */
  conditions: Array<{ id: number; conditionNo: string | null }>;
  /** この版が差し替えた前の版。 */
  supersedesId: number | null;
  /** この版を差し替えた新しい版。あるとき、この版はもう使わない。 */
  supersededById: number | null;
  supersededByNo: string | null;
  issuedAt: string | null;
  storageUrl: string | null;
  /**
   * 人が見る段階。状態（status）は保存の都合で draft / issued / superseded /
   * void の4つだが、実務は「下書き → 決定 → 送信」で進む。送ったかどうかは
   * 送信の記録（audit_events）から導くので、ここで畳んで返す。
   *   draft     … まだ決めていない。中身を直せる
   *   decided   … 決めた（番号が振られた）。まだ送っていない
   *   sent      … 相手に送った（確認メールか CloudSign）
   *   superseded / void … 退いた版・無効
   */
  phase: DocumentPhase;
  /** 最後に送った日時と経路。送っていなければ null。 */
  sentAt: string | null;
  /** gmail / cloudsign / post / hand / email_other / past / other（documents/delivery.ts）。 */
  sentVia: string | null;
  /** 相手が受け取ったと確かめた日時と経路（署名済みの控え・返信・CloudSign 締結など）。 */
  receivedAt: string | null;
  receivedVia: string | null;
  /** 過去分（一括で送付済み扱い）。 */
  past: boolean;
  /** 相手から受け取った文書（取込）。送付・受領を追わない。 */
  inbound: boolean;
  /** 一括作成の束。CSV から作った文書だけ持つ。 */
  batchId: number | null;
}

export type DocumentPhase = "draft" | "decided" | "sent" | "superseded" | "void";

export interface DocumentDetail extends DocumentSummary {
  templateVersionId: number | null;
  agreementId: number | null;
  /** なぜ前の版を差し替えたか。 */
  supersedeReason: string | null;
  renderedValues: Record<string, unknown>;
  manualInputs: Record<string, unknown>;
  /**
   * 結びついている実績。訂正版の下書きは前の版のものを引き継いで出す。
   * これが無いと、訂正のたびに実績を選び直すことになる。
   */
  eventIds: number[];
  conditions: Array<{ id: number; conditionNo: string | null; name: string; lineNo: number;
    /** 改訂で旧版になっていれば、いまの版の id（そうでなければ id と同じ）。 */
    currentId: number }>;
  /**
   * この文書の実績にもう立っている支払（取消済みを除く）。
   *
   * 画面はこれを見て「支払を立てる」を出し分ける。無いと、すでに立てた支払が
   * あっても押せてしまい、押してから「すでに支払 #26 があります」と断られる。
   * 断られる操作を差し出さない。
   */
  payments: Array<{
    id: number; paymentNo: string | null; status: string;
    amount: number; dueOn: string | null;
  }>;
}

export interface TemplateSource {
  templateId: number;
  templateVersionId: number;
  templateKey: string;
  label: string;
  /** 部分テンプレート（他のひな形に差し込む約款など）は 'partial'。 */
  category: string | null;
  numberPrefix: string | null;
  htmlSource: string;
  variables: TemplateVariable[];
}

const LIST_SELECT = `
  d.id, d.document_no, d.status, d.matter_id, d.agreement_id, d.issued_at, d.storage_url,
  d.supersedes_id, d.batch_id, d.counterparty_doc_no,
  d.manual_inputs->>'_showRevision' AS show_revision,
  -- 受取人（共著の取り分）宛ての文書は、相手先を受取人にする。表示の view は 1 本目の条件の相手先
  -- （共著の代表）を出すので、脇屋さん宛ての計算書が「麻生涼介」と出て中身と食い違っていた。
  COALESCE(pp.name, v.counterparty) AS counterparty,
  v.condition_count, t.template_key,
  m.matter_no,
  -- この版を差し替えた新しい版。参照は新→旧の向きしか無いので反転して読む。
  nx.id AS superseded_by_id, nx.document_no AS superseded_by_no,
  snd.sent_at, snd.sent_via, snd.received_at, snd.received_via, snd.past, d.inbound,
  -- 条件明細は件数ではなく番号で出す。件数だけでは何に紐づくか分からない。
  (SELECT array_agg(json_build_object('id', c.id, 'conditionNo', c.condition_no)
                    ORDER BY dc.line_no)
     FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
    WHERE dc.document_id = d.id) AS condition_refs,
  -- 取込文書はひな形を持たないので、種別が空欄になる。登録時に入れた種別で埋める。
  COALESCE(v.template_label, d.manual_inputs->>'documentKind') AS template_label,
  -- 同じ理由で件名も空になる。表示の view は件名が無いと文書番号で埋めるので、
  -- 取込文書は登録時の文書名を先に見る（でないと件名が番号になる）。
  COALESCE(CASE WHEN d.template_version_id IS NULL THEN NULLIF(d.manual_inputs->>'title', '') END,
           v.title, d.manual_inputs->>'title')
    -- 件名は 1 本目の条件（代表の条件）の名前なので、受取人宛てなら誰の取り分かを添える。
    || CASE WHEN pp.id IS NOT NULL AND pp.id IS DISTINCT FROM v.counterparty_id
            THEN '（' || pp.name || ' の取り分）' ELSE '' END AS title,
  (d.template_version_id IS NULL) AS imported`;

const LIST_FROM = `
  FROM documents d
  LEFT JOIN v_document_display v ON v.document_id = d.id
  LEFT JOIN parties pp ON pp.id = CASE WHEN d.manual_inputs->>'_payeePartyId' ~ '^[0-9]+$'
                                       THEN (d.manual_inputs->>'_payeePartyId')::bigint END
  LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
  LEFT JOIN document_templates t ON t.id = tv.template_id
  LEFT JOIN matters m ON m.id = d.matter_id
  -- 後継は1件だけ引く。結合のままだと、万一2件あったとき一覧の行が増える。
  LEFT JOIN LATERAL (
    SELECT n.id, n.document_no FROM documents n
     WHERE n.supersedes_id = d.id AND n.status <> 'void'
     ORDER BY n.id DESC LIMIT 1
  ) nx ON true
  -- 送った記録。送信は audit_events に1本で残しているので、そこから最後の1件を引く。
  LEFT JOIN LATERAL (
    SELECT dv.sent_at, dv.sent_via, dv.received_at, dv.received_via, dv.past
      FROM document_delivery(d.id) dv
  ) snd ON true`;

/** 状態と送信の有無から、人が見る段階を決める。 */
export function phaseOf(status: string, sentAt: unknown): DocumentPhase {
  if (status === "draft") return "draft";
  if (status === "issued") return sentAt ? "sent" : "decided";
  if (status === "superseded") return "superseded";
  return "void";
}

function mapSummary(row: Record<string, any>): DocumentSummary {
  return {
    id: Number(row.id),
    documentNo: str(row.document_no),
    printedNo: row.document_no
      ? printedDocumentNumber(String(row.document_no), showRevisionOf({ _showRevision: row.show_revision })) : null,
    status: String(row.status),
    templateKey: str(row.template_key),
    templateLabel: str(row.template_label),
    title: str(row.title),
    imported: row.imported === true,
    counterpartyDocNo: str(row.counterparty_doc_no),
    counterparty: str(row.counterparty),
    matterId: int(row.matter_id),
    matterNo: str(row.matter_no),
    agreementId: int(row.agreement_id),
    conditionCount: Number(row.condition_count ?? 0),
    conditions: ((row.condition_refs ?? []) as Array<{ id: number; conditionNo: string | null }>)
      .map((c) => ({ id: Number(c.id), conditionNo: c.conditionNo ?? null })),
    supersedesId: int(row.supersedes_id),
    supersededById: int(row.superseded_by_id),
    supersededByNo: str(row.superseded_by_no),
    issuedAt: row.issued_at ? new Date(String(row.issued_at)).toISOString() : null,
    storageUrl: str(row.storage_url),
    phase: phaseOf(String(row.status), row.sent_at),
    sentAt: row.sent_at ? new Date(String(row.sent_at)).toISOString() : null,
    sentVia: str(row.sent_via),
    receivedAt: row.received_at ? new Date(String(row.received_at)).toISOString() : null,
    receivedVia: str(row.received_via),
    past: row.past === true,
    inbound: row.inbound === true,
    batchId: int(row.batch_id)
  };
}

/**
 * ひな形の項目。宣言が空のときだけコードの一覧で補う。
 *
 * 個別利用許諾条件書は V1・V2 でも項目の一覧がコードの中にあり、データベースの
 * field_schema は空だった。移行はその列だけを引き継いだので、V3 ではこの書類の
 * 項目が1つも無く、ひな形を選んでも入力欄が出なかった。V2 と同じ規則にする
 * （データベースに宣言があればそちらが勝つ。あとから版で足せる）。
 */
function variablesFor(templateKey: string, declared: TemplateVariable[]): TemplateVariable[] {
  if (TAX_ROUNDING_TEMPLATES.has(templateKey)) return withTaxRounding(declared);
  if (declared.length) return declared;
  if (isLicenseTermsTemplate(templateKey)) return LICENSE_TERMS_VARIABLES;
  // 出版の条件書（V3）も項目はコードが持つ。ひな形の SQL は本文だけを運ぶ。
  if (isPubTermsTemplate(templateKey)) return PUB_TERMS_VARIABLES;
  return declared;
}

/**
 * 消費税の端数処理を選ぶ欄を持つひな形。国内の検収書と役務提供完了通知書。
 * 海外用の検収書は税を上乗せしない（税率 0）ので要らない。
 */
const TAX_ROUNDING_TEMPLATES = new Set(["inspection_certificate", "acceptance_certificate", "service_completion_notice"]);

export const TAX_ROUNDING_VARIABLE: TemplateVariable = {
  name: TAX_ROUNDING_INPUT,
  label: "消費税の端数処理",
  type: "select",
  group: "II. 金額",
  options: [TAX_ROUNDING_LABEL.ceil, TAX_ROUNDING_LABEL.floor, TAX_ROUNDING_LABEL.round],
  default: TAX_ROUNDING_LABEL[DEFAULT_TAX_ROUNDING],
  helpText: "発注書の消費税と 1 円ずれるときに合わせる。支払の消費税も同じ丸め方で計算する",
  noGuess: true
};

/**
 * 端数処理の欄を足す。field_schema は変えない（ひな形の版に手を入れない）ので、
 * 欄はコードが持つ。データベースに同じ名前の宣言があればそちらが勝つ。
 * 区分は「II. 金額」。III 以降の区分の前に置く（区分は最初に出た順に並ぶ）。
 */
function withTaxRounding(declared: TemplateVariable[]): TemplateVariable[] {
  if (declared.some((v) => v.name === TAX_ROUNDING_VARIABLE.name)) return declared;
  const at = declared.findIndex((v) => /^(III|IV|V|VI|VII|VIII|IX|X)\./.test(String(v.group ?? "")));
  return at < 0 ? [...declared, TAX_ROUNDING_VARIABLE]
    : [...declared.slice(0, at), TAX_ROUNDING_VARIABLE, ...declared.slice(at)];
}

export class DocumentRepository {
  constructor(private readonly database: Transactable) {}

  /**
   * unlinked を渡すと、条件明細が1件も繋がっていない文書だけを返す。
   * 移行してきた文書はほとんど条件が付いていない（V1 が持っていなかった）。
   * 繋ぎ直す作業は「まだ繋がっていないものを出す」から始まるので、
   * 探す手段が無いと一覧を上から目で追うことになる。
   */
  async list(query: {
    keyword?: string; status?: string; matterId?: number;
    unlinked?: boolean; limit?: number;
    /** 人が見る段階で絞る。decided は「決めたがまだ送っていない」。 */
    phase?: DocumentPhase;
    /** 一括作成の束で絞る。 */
    batchId?: number;
    /** 相手先で絞る（統合を辿る）。メールに一緒に添える文書を選ぶとき。 */
    partyId?: number;
  } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.keyword?.trim()) {
      params.push(`%${query.keyword.trim()}%`);
      const i = params.length;
      // 取り込んだ文書の名前（manual_inputs.title）も件名として当てる。契約も案件も
      // 条件も付いていない取り込み文書は表示名が文書番号に落ちるので、名前で探せなかった。
      // 条件明細の番号・名前でも当てる（デイリータスクで「この条件の文書」を探して繋ぐ）。
      where.push(`(COALESCE(d.document_no,'') ILIKE $${i} OR COALESCE(v.title,'') ILIKE $${i}
                   OR COALESCE(d.counterparty_doc_no,'') ILIKE $${i}
                   OR COALESCE(d.manual_inputs->>'title','') ILIKE $${i}
                   OR (pp.id IS NULL AND COALESCE(v.counterparty,'') ILIKE $${i})
                   OR COALESCE(pp.name,'') ILIKE $${i}
                   OR EXISTS (SELECT 1 FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
                               WHERE dc.document_id = d.id
                                 AND (COALESCE(c.condition_no,'') ILIKE $${i} OR COALESCE(c.name,'') ILIKE $${i})))`);
    }
    if (query.status) { params.push(query.status); where.push(`d.status = $${params.length}`); }
    if (query.phase === "draft") where.push("d.status = 'draft'");
    if (query.phase === "decided") where.push("d.status = 'issued' AND snd.sent_at IS NULL");
    if (query.phase === "sent") where.push("d.status = 'issued' AND snd.sent_at IS NOT NULL");
    if (query.phase === "superseded") where.push("d.status = 'superseded'");
    if (query.phase === "void") where.push("d.status = 'void'");
    if (query.matterId) { params.push(query.matterId); where.push(`d.matter_id = $${params.length}`); }
    if (query.batchId) { params.push(query.batchId); where.push(`d.batch_id = $${params.length}`); }
    if (query.partyId) {
      params.push(query.partyId);
      // 受取人宛ての文書は受取人で当てる（代表の文書として出さない）。
      // 関係当事者（連名の文書）としても当てる。
      where.push(`(COALESCE(pp.id, v.counterparty_id) IN (SELECT party_id FROM v_party_resolved
                    WHERE resolved_id = (SELECT resolved_id FROM v_party_resolved WHERE party_id = $${params.length}))
                   OR EXISTS (SELECT 1 FROM document_parties xp JOIN v_party_resolved xr ON xr.party_id = xp.party_id
                               WHERE xp.document_id = d.id
                                 AND xr.resolved_id = (SELECT resolved_id FROM v_party_resolved WHERE party_id = $${params.length})))`);
    }
    if (query.unlinked) {
      where.push(`NOT EXISTS (SELECT 1 FROM document_conditions dc WHERE dc.document_id = d.id)`);
    }
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 500));
    try {
      const r = await this.database.query(
        `SELECT ${LIST_SELECT} ${LIST_FROM}
          ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY d.issued_at DESC NULLS FIRST, d.id DESC
          LIMIT $${params.length}`, params);
      return r.rows.map(mapSummary);
    } catch (error) { throw translate(error); }
  }

  async find(id: number): Promise<DocumentDetail | null> {
    const r = await this.database.query(
      `SELECT ${LIST_SELECT}, d.template_version_id, d.agreement_id, d.supersede_reason,
              d.rendered_values, d.manual_inputs
         ${LIST_FROM}
        WHERE d.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    // 改訂で旧版になった条件は、いまの版（superseded_by_id の先。何段でも）も添える。
    // 画面はいまの版を選び直し、決定はいまの版に付け替える（issue-service.followRevisions）。
    const conditions = await this.database.query(
      `WITH RECURSIVE chain AS (
         SELECT c.id AS start_id, c.id, c.superseded_by_id, 0 AS depth
           FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id WHERE dc.document_id = $1
         UNION ALL
         SELECT ch.start_id, n.id, n.superseded_by_id, ch.depth + 1
           FROM chain ch JOIN conditions n ON n.id = ch.superseded_by_id WHERE ch.depth < 50
       ), latest AS (SELECT DISTINCT ON (start_id) start_id, id AS current_id FROM chain ORDER BY start_id, depth DESC)
       SELECT c.id, c.condition_no, c.name, c.status, dc.line_no, l.current_id
         FROM document_conditions dc JOIN conditions c ON c.id = dc.condition_id
         LEFT JOIN latest l ON l.start_id = c.id
        WHERE dc.document_id = $1 ORDER BY dc.line_no`, [id]);
    // 実績はこの文書のもの。まだ発行していない訂正版は、前の版のものを引き継ぐ。
    const events = await this.database.query(
      `SELECT id FROM condition_events
        WHERE status = 'active' AND document_id = COALESCE($2::bigint, $1::bigint)
        ORDER BY occurred_on, id`,
      [id, row.status === "draft" ? int(row.supersedes_id) : null]);

    // この文書の実績に立っている支払。訂正版の下書きは前の版の実績を見るので、
    // 上の events と同じ引き方にそろえる。
    const payments = await this.database.query(
      `SELECT DISTINCT y.id, y.payment_no, y.status, y.amount, y.due_on
         FROM condition_events e
         JOIN payment_allocations a ON a.event_id = e.id
         JOIN payments y ON y.id = a.payment_id AND y.status <> 'canceled'
        WHERE e.status = 'active'
          AND e.document_id = COALESCE($2::bigint, $1::bigint)
        ORDER BY y.id`,
      [id, row.status === "draft" ? int(row.supersedes_id) : null]);

    return {
      ...mapSummary(row),
      templateVersionId: int(row.template_version_id),
      agreementId: int(row.agreement_id),
      supersedeReason: str(row.supersede_reason),
      eventIds: (events.rows as Array<{ id: number }>).map((e) => Number(e.id)),
      renderedValues: (row.rendered_values as Record<string, unknown>) ?? {},
      manualInputs: (row.manual_inputs as Record<string, unknown>) ?? {},
      conditions: conditions.rows.map((c: Record<string, any>) => ({
        id: Number(c.id), conditionNo: str(c.condition_no),
        name: String(c.name), lineNo: Number(c.line_no),
        currentId: Number(c.current_id ?? c.id)
      })),
      payments: (payments.rows as Array<Record<string, any>>).map((y) => ({
        id: Number(y.id), paymentNo: str(y.payment_no), status: String(y.status),
        amount: Number(y.amount ?? 0), dueOn: dateStr(y.due_on)
      }))
    };
  }

  /** テンプレートの現行版。発行済み文書の再描画は版を固定して引く。 */
  async templateSource(client: Queryable, options: { templateKey?: string; versionId?: number }): Promise<TemplateSource> {
    const r = options.versionId
      ? await client.query(
          `SELECT t.id AS template_id, tv.id AS version_id, t.template_key, t.label,
                  t.category, t.number_prefix, tv.html_source, tv.variables
             FROM document_template_versions tv JOIN document_templates t ON t.id = tv.template_id
            WHERE tv.id = $1`, [options.versionId])
      : await client.query(
          `SELECT t.id AS template_id, tv.id AS version_id, t.template_key, t.label,
                  t.category, t.number_prefix, tv.html_source, tv.variables
             FROM document_templates t JOIN document_template_versions tv ON tv.id = t.current_version_id
            WHERE t.template_key = $1 AND t.is_active`, [options.templateKey]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) {
      throw new DomainError("NOT_FOUND",
        options.versionId
          ? `テンプレートの版 ${options.versionId} が見つかりません`
          : `テンプレート ${options.templateKey} が見つかりません`);
    }
    return {
      templateId: Number(row.template_id),
      templateVersionId: Number(row.version_id),
      templateKey: String(row.template_key),
      label: String(row.label),
      category: str(row.category),
      numberPrefix: str(row.number_prefix),
      htmlSource: String(row.html_source),
      variables: variablesFor(String(row.template_key), parseVariables(row.variables))
    };
  }

  async listTemplates() {
    const r = await this.database.query(
      `SELECT t.id, t.template_key, t.label, t.category, t.number_prefix,
              tv.id AS version_id, tv.version_no
         FROM document_templates t
         -- 版の無いひな形は選ばせない。選択肢に出すと、選んだ瞬間に
         -- 「テンプレートが見つかりません」で下書きも作れない行になる。
         JOIN document_template_versions tv ON tv.id = t.current_version_id
        WHERE t.is_active
          -- 部分テンプレートは他のひな形に差し込むもので、単独では発行できない。
          AND t.category IS DISTINCT FROM 'partial'
          AND t.template_key NOT LIKE '\\_%'
        ORDER BY t.category NULLS LAST, t.label`);
    return r.rows.map((t: Record<string, any>) => ({
      id: Number(t.id), templateKey: String(t.template_key), label: String(t.label),
      category: str(t.category), numberPrefix: str(t.number_prefix),
      versionId: int(t.version_id), versionNo: int(t.version_no)
    }));
  }

  /**
   * 差し込み用の部分テンプレート。
   *
   * V2 は kind='partial' で持ち、名前は template_key そのもの
   * （{{> terms_spot_2026}}）。V3 は移行でそれを category に写している。
   * ここを template_key の "_" 始まりで探していたため1件も見つからず、
   * 部分を差し込むひな形が「The partial ... could not be found」で
   * 全部落ちていた。
   *
   * "_" 始まりの規約も残す。どちらの名前でも引けるようにしておく。
   */
  async partials(): Promise<Record<string, string>> {
    const r = await this.database.query(
      `SELECT t.template_key, tv.html_source
         FROM document_templates t JOIN document_template_versions tv ON tv.id = t.current_version_id
        WHERE t.is_active
          AND (t.category = 'partial' OR t.template_key LIKE '\\_%')`);
    const out: Record<string, string> = {};
    for (const row of r.rows as Array<Record<string, any>>) {
      const key = String(row.template_key);
      const html = String(row.html_source);
      out[key] = html;
      if (key.startsWith("_")) out[key.slice(1)] = html;
    }
    return out;
  }
}

export { dateStr };
