import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { dateStr, int, num, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { claimSchedule } from "./schedule-service.js";
import { readContractForm } from "./contract-form.js";
import {
  assertUsageInput, basisOf, paymentStageLabel, usageTypeLabel,
  type PaymentStage, type UsageType
} from "../royalty/usage-type.js";
import { ppmToPct } from "../royalty/economics.js";
import { roundRoyalty } from "../royalty/rounding.js";

/**
 * 条件の実績（明細の数値）。
 *
 * これまで condition_events を書けるのは計算書の作成だけだった。製造数も
 * 検収も納品も、画面から記録できず、間違って入った数値を直す手段も無かった。
 *
 * 記録は消さない。取り消しは status を void にして残す。実績は「何がいくつ
 * あったか」の記録なので、消すと後から突き合わせられなくなる。
 *
 * 計算書から作られた実績（document_id を持つもの）はここでは触らない。
 * 触ると計算書の中身と実績が食い違う。直すなら計算書ごと差し替える。
 */

export type EventType =
  | "manufacturing" | "sales" | "sublicense_receipt"
  | "inspection" | "delivery" | "service_period" | "adjustment";

export const EVENT_TYPES: Array<{ value: EventType; label: string }> = [
  { value: "manufacturing", label: "製造" },
  { value: "sales", label: "売上" },
  { value: "sublicense_receipt", label: "再許諾の受領" },
  { value: "inspection", label: "検収" },
  { value: "delivery", label: "納品" },
  { value: "service_period", label: "役務の期間" },
  { value: "adjustment", label: "調整" }
];

export interface EventInput {
  eventType: EventType;
  occurredOn: string;
  period?: string | null;
  quantity?: number | null;
  sampleQuantity?: number | null;
  grossAmount?: number | null;
  deductions?: number | null;
  amount: number;
  note?: string | null;
  /** どの予定の回か。分納の支払日は予定から引くので、ここが繋がっていないと空になる。 */
  scheduleId?: number | null;
  /** 検収書がそのまま使う項目。ここに入れておけば文書を作るとき人が入れずに済む。 */
  deliverable?: string | null;
  inspectedOn?: string | null;
  inspectorDept?: string | null;
  inspectorName?: string | null;
  /** 契約形式（請負・委任など）。空なら予定・条件のものを継ぐ。 */
  contractForm?: string | null;
  /** 役務提供期間。定期払いの回で使う。 */
  serviceFrom?: string | null;
  serviceTo?: string | null;
  /** 権利の使い方。利用許諾料計算書はこれで算定の形が決まる。 */
  usageType?: UsageType | null;
  /** 相手へ許諾したアウト条件。再許諾・他社販売で要る。 */
  outConditionId?: number | null;
  /** どの当社作品の売上か（A-027）。自社製造・自社販売の計算書の製品名になる。 */
  workId?: number | null;
  /** 基準価格（自社販売）／受領価格1個あたり（他社販売）。 */
  unitAmount?: number | null;
  /** その回の料率（百万分率）。既定はイン条件の料率。 */
  ratePpm?: number | null;
  /** 入金区分。前金・後金に分かれる契約で、どちらの入金かを持つ。 */
  paymentStage?: PaymentStage | null;
  /** 受領額・受領価格が税込か。海外からの受領は税込で来る。 */
  taxIncluded?: boolean | null;
  /** 記録時点の予定（条件または予定の回）。差分の記録が条件の改訂で変わらないように写して持つ（A-030）。 */
  expectedQuantity?: number | null;
  expectedAmount?: number | null;
  /** 予定との差分の理由。 */
  varianceNote?: string | null;
  /** 差分への次のアクション。wait=不足分を待つ / settle_short=不足のまま終了（減額） / as_is=意図どおり。 */
  followUp?: "wait" | "settle_short" | "as_is" | null;
  followUpDueOn?: string | null;
}

/**
 * 改訂の系列に属する条件の id。実績は登録した版の id に付いたまま残るので、
 * 新しい版を開いても実績が見えない・結べない、が起きていた（「条件を差し替えたら
 * 実績がついてこない」）。一覧も結びつけも、同じ系列の全版を対象にする。
 */
const SERIES_IDS_SQL = (param: string) =>
  `(SELECT x.id FROM conditions x
     WHERE x.id = ${param}
        OR x.series_id = (SELECT COALESCE(y.series_id, y.id) FROM conditions y WHERE y.id = ${param}))`;

export interface EventRow {
  id: number;
  /** この実績が付いている版。改訂前の版なら番号が違う。 */
  conditionId: number;
  conditionNo: string | null;
  eventType: string;
  occurredOn: string | null;
  period: string | null;
  quantity: number | null;
  sampleQuantity: number | null;
  grossAmount: number | null;
  deductions: number;
  amount: number;
  status: string;
  note: string | null;
  scheduleId: number | null;
  /** 予定の回の呼び名（第1回・2026年4月分など）。画面で回を見分ける。 */
  scheduleLabel: string | null;
  deliverable: string | null;
  inspectedOn: string | null;
  inspectorDept: string | null;
  inspectorName: string | null;
  contractForm: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  usageType: string | null;
  usageLabel: string | null;
  outConditionId: number | null;
  outConditionNo: string | null;
  outConditionName: string | null;
  unitAmount: number | null;
  ratePpm: number | null;
  paymentStage: string | null;
  paymentStageLabel: string | null;
  taxIncluded: boolean | null;
  /** 計算書から作られた実績。画面からは直せない。 */
  documentId: number | null;
  documentNo: string | null;
  /** 結びついている文書の状態。void なら空いている扱い（作り直せる）。 */
  documentStatus: string | null;
  /** 予定との差分（A-030）。 */
  expectedQuantity: number | null;
  expectedAmount: number | null;
  varianceNote: string | null;
  followUp: string | null;
  followUpDueOn: string | null;
  createdAt: string;
  createdBy: string;
}

export class ConditionEventService {
  constructor(private readonly database: Transactable) {}

  async list(conditionId: number): Promise<EventRow[]> {
    try {
      const r = await this.database.query(
        `SELECT e.id, e.event_type, e.occurred_on, e.period, e.quantity, e.sample_quantity,
                e.gross_amount, e.deductions, e.amount, e.status, e.note,
                e.schedule_id, s.label AS schedule_label, s.seq AS schedule_seq,
                e.deliverable, e.inspected_on, e.inspector_dept, e.inspector_name,
                e.contract_form, e.service_from, e.service_to,
                e.usage_type, e.out_condition_id, e.unit_amount, e.rate_ppm, e.payment_stage,
                e.tax_included,
                oc.condition_no AS out_condition_no, oc.name AS out_condition_name,
                e.document_id, d.document_no, d.status AS document_status, e.created_at, e.created_by,
                e.condition_id, ec.condition_no AS own_condition_no,
                e.expected_quantity, e.expected_amount, e.variance_note, e.follow_up, e.follow_up_due_on
           FROM condition_events e
           LEFT JOIN documents d ON d.id = e.document_id
           LEFT JOIN condition_schedules s ON s.id = e.schedule_id
           LEFT JOIN conditions oc ON oc.id = e.out_condition_id
           LEFT JOIN conditions ec ON ec.id = e.condition_id
          WHERE e.condition_id IN ${SERIES_IDS_SQL("$1")}
          ORDER BY e.occurred_on DESC, e.id DESC`, [conditionId]);
      return (r.rows as any[]).map((row) => ({
        id: Number(row.id),
        conditionId: Number(row.condition_id),
        conditionNo: str(row.own_condition_no),
        eventType: String(row.event_type),
        occurredOn: dateStr(row.occurred_on),
        period: str(row.period),
        quantity: num(row.quantity),
        sampleQuantity: num(row.sample_quantity),
        grossAmount: int(row.gross_amount),
        deductions: Number(row.deductions ?? 0),
        amount: Number(row.amount ?? 0),
        status: String(row.status),
        note: str(row.note),
        scheduleId: int(row.schedule_id),
        scheduleLabel: str(row.schedule_label)
          ?? (row.schedule_seq ? `第${Number(row.schedule_seq)}回` : null),
        deliverable: str(row.deliverable),
        inspectedOn: dateStr(row.inspected_on),
        inspectorDept: str(row.inspector_dept),
        inspectorName: str(row.inspector_name),
        contractForm: str(row.contract_form),
        serviceFrom: dateStr(row.service_from),
        serviceTo: dateStr(row.service_to),
        usageType: str(row.usage_type),
        usageLabel: row.usage_type ? usageTypeLabel(row.usage_type) : null,
        outConditionId: int(row.out_condition_id),
        outConditionNo: str(row.out_condition_no),
        outConditionName: str(row.out_condition_name),
        unitAmount: int(row.unit_amount),
        ratePpm: int(row.rate_ppm),
        paymentStage: str(row.payment_stage),
        paymentStageLabel: paymentStageLabel(row.payment_stage) || null,
        taxIncluded: row.tax_included === null || row.tax_included === undefined
          ? null : Boolean(row.tax_included),
        documentId: int(row.document_id),
        documentNo: str(row.document_no),
        documentStatus: str(row.document_status),
        expectedQuantity: num(row.expected_quantity),
        expectedAmount: int(row.expected_amount),
        varianceNote: str(row.variance_note),
        followUp: str(row.follow_up),
        followUpDueOn: dateStr(row.follow_up_due_on),
        createdAt: new Date(String(row.created_at)).toISOString(),
        createdBy: String(row.created_by)
      }));
    } catch (error) { throw translate(error); }
  }

  async add(conditionId: number, input: EventInput, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, status, direction, rate_ppm, currency FROM conditions WHERE id = $1",
          [conditionId]);
        const condition = head.rows[0] as {
          id: number; status: string; direction: string;
          rate_ppm: number | null; currency: string;
        } | undefined;
        if (!condition) throw new DomainError("NOT_FOUND", `条件 ${conditionId} が見つかりません`);
        if (condition.status !== "active" && condition.status !== "draft") {
          // 差し替え済み・無効の版に実績を足すと、どの版の実績か分からなくなる。
          // 適用待ちの版はまだ効いていないので、実績はいまの版に付ける。
          throw new DomainError("CONFLICT",
            condition.status === "superseded"
              ? "旧版には実績を足せません。最新版に記録してください"
              : condition.status === "scheduled"
              ? "この版はまだ適用前です。実績はいま有効な版に記録してください"
              : "無効にした条件には実績を足せません");
        }

        // 回を選んでいれば、規則も既定値も予定側に合わせる。
        // 予定の行から作った実績と、ここから作った実績を同じものにする。
        let scheduleId: number | null = null;
        let occurredOn = input.occurredOn;
        let period = str(input.period);
        // 契約形式と役務提供期間は、書いていなければ予定の回から継ぐ。
        // 回ごとに決めたものを、実績を入れるたびに人が写し直すのは無駄で、
        // 写し忘れれば紙が空欄で出る。
        let contractForm = readContractForm(input.contractForm);
        let serviceFrom = input.serviceFrom || null;
        let serviceTo = input.serviceTo || null;
        if (input.scheduleId) {
          const line = await claimSchedule(client, conditionId, input.scheduleId);
          scheduleId = input.scheduleId;
          occurredOn = occurredOn || (dateStr(line.due_on) ?? occurredOn);
          // 予定の名前を実績の期間に写す。「2026年4月分」がそのまま計算書に出る。
          period = period ?? str(line.label);
          contractForm = contractForm ?? readContractForm(line.contract_form);
          serviceFrom = serviceFrom ?? dateStr(line.service_from);
          serviceTo = serviceTo ?? dateStr(line.service_to);
        }
        if (serviceFrom && serviceTo && serviceTo < serviceFrom) {
          throw new DomainError("VALIDATION", "役務提供期間の終了が開始より前です");
        }

        // 権利の使い方。入れてあれば、その形に要る数字が揃っているかを先に見る。
        // 足りないまま実績を作ると、計算書を出す段になって初めて気づく。
        const usageType = (input.usageType ?? null) as UsageType | null;
        const unitAmount = input.unitAmount === null || input.unitAmount === undefined
          ? null : Math.round(input.unitAmount);
        // 料率はイン条件から引く。その回だけ違う料率があれば入力が勝つ。
        const ratePpm = input.ratePpm === null || input.ratePpm === undefined
          ? (usageType ? int(condition.rate_ppm) : null)
          : Math.round(input.ratePpm);
        if (usageType) {
          if (condition.direction !== "in") {
            throw new DomainError("VALIDATION",
              "利用形態を付けられるのは取得（IN）の条件の実績だけです。" +
              "許諾料は作者から取った権利に対して払うものなので、実績はイン条件に載せます");
          }
          await this.assertOutCondition(client, conditionId, input.outConditionId ?? null);
          if (input.workId) {
            const w = await client.query("SELECT id FROM works WHERE id = $1", [input.workId]);
            if (!w.rows[0]) throw new DomainError("NOT_FOUND", `作品 ${input.workId} が見つかりません`);
          }
          assertUsageInput({
            usageType,
            unitAmount, quantity: input.quantity ?? null,
            sampleQuantity: input.sampleQuantity ?? null,
            grossAmount: input.grossAmount ?? null,
            paymentStage: input.paymentStage ?? null,
            taxIncluded: input.taxIncluded ?? null,
            outConditionId: input.outConditionId ?? null
          }, "この実績");
        }

        const gross = input.grossAmount === null || input.grossAmount === undefined
          ? null : Math.round(input.grossAmount);
        const deductions = Math.round(input.deductions ?? 0);

        // 利用形態のある実績は、実額を人が入れるものではない。
        // 算定の基礎（基準価格×個数／受領価格）に料率を掛けた額がそのまま
        // 作者に払う額なので、ここで出す。人に入れさせると、紙の数字と
        // 実績の数字が食い違ったまま残る。
        //
        // 「総額 − 控除 = 実額」の決まりは、報告売上をそのまま実額にしていた
        // 古い形のもの。受領価格に料率を掛ける形では成り立たないので見ない。
        const amount = usageType
          ? roundRoyalty((basisOf({
              usageType, unitAmount, quantity: input.quantity ?? null,
              sampleQuantity: input.sampleQuantity ?? null, grossAmount: gross,
              paymentStage: input.paymentStage ?? null,
              taxIncluded: input.taxIncluded ?? null
            }, "この実績") * ppmToPct(ratePpm)) / 100)
          : Math.round(input.amount);
        if (!usageType && gross !== null && gross - deductions !== amount) {
          // 総額・控除・実額が合わない記録を残すと、あとで検算できない。
          throw new DomainError("VALIDATION",
            `総額 ${gross} − 控除 ${deductions} = ${gross - deductions} が実額 ${amount} と合いません`);
        }
        if (usageType && !(amount > 0)) {
          throw new DomainError("VALIDATION",
            "算定の結果が0になります。基準価格・個数・受領価格・料率を確かめてください");
        }

        const inserted = await client.query(
          `INSERT INTO condition_events
             (condition_id, schedule_id, event_type, occurred_on, period,
              quantity, sample_quantity, gross_amount, deductions, amount, note, created_by,
              deliverable, inspected_on, inspector_dept, inspector_name,
              contract_form, service_from, service_to,
              usage_type, out_condition_id, unit_amount, rate_ppm, payment_stage,
              tax_included, work_id,
              expected_quantity, expected_amount, variance_note, follow_up, follow_up_due_on)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14::date, $15, $16, $17, $18::date, $19::date,
                   $20, $21, $22, $23, $24, $25, $26,
                   $27, $28, $29, $30, $31::date)
           RETURNING id`,
          [conditionId, scheduleId, input.eventType, occurredOn, period,
           input.quantity ?? null, input.sampleQuantity ?? null,
           gross, deductions, amount, str(input.note), actor,
           str(input.deliverable), str(input.inspectedOn),
           str(input.inspectorDept), str(input.inspectorName),
           contractForm, serviceFrom, serviceTo,
           usageType, input.outConditionId ?? null, unitAmount, ratePpm,
           input.paymentStage ?? null, input.taxIncluded ?? null, input.workId ?? null,
           input.expectedQuantity ?? null,
           input.expectedAmount === null || input.expectedAmount === undefined ? null : Math.round(input.expectedAmount),
           str(input.varianceNote), input.followUp ?? null, input.followUpDueOn || null]);
        const id = Number((inserted.rows[0] as { id: number }).id);

        await recordAudit(client, {
          actor, action: "condition.event_add", targetType: "condition", targetId: conditionId,
          detail: { eventId: id, eventType: input.eventType, occurredOn, amount, scheduleId,
                    usageType, outConditionId: input.outConditionId ?? null,
                    ...(input.varianceNote || input.followUp
                      ? { expectedQuantity: input.expectedQuantity ?? null, expectedAmount: input.expectedAmount ?? null,
                          varianceNote: str(input.varianceNote), followUp: input.followUp ?? null,
                          followUpDueOn: input.followUpDueOn || null } : {}) }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 指したアウト条件が使えるものか確かめる。
   *
   * 向きが OUT であること、生きている版であること、自分自身でないこと。
   * ここを見ないと、取得の条件や無効な版を「許諾先」として指した実績が
   * できてしまい、紙に出す許諾地域が別の契約のものになる。
   */
  private async assertOutCondition(
    client: Queryable, conditionId: number, outConditionId: number | null
  ): Promise<void> {
    if (!outConditionId) return;
    if (outConditionId === conditionId) {
      throw new DomainError("VALIDATION", "自分自身をアウト条件には指せません");
    }
    const found = await client.query(
      "SELECT id, direction, status, condition_no FROM conditions WHERE id = $1",
      [outConditionId]);
    const row = found.rows[0] as
      { direction: string; status: string; condition_no: string | null } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `条件 ${outConditionId} が見つかりません`);
    const tag = row.condition_no ?? `#${outConditionId}`;
    if (row.direction !== "out") {
      throw new DomainError("VALIDATION", `${tag} は許諾（OUT）の条件ではありません`);
    }
    if (row.status !== "active" && row.status !== "draft" && row.status !== "scheduled") {
      throw new DomainError("VALIDATION", `${tag} は使える状態ではありません（${row.status}）`);
    }
  }

  /** 取り消し。行は残す。理由を必ず添える。 */
  async void(conditionId: number, eventId: number, reason: string, actor: string) {
    const why = String(reason ?? "").trim();
    if (!why) throw new DomainError("VALIDATION", "取り消しの理由は必須です");
    try {
      return await inTransaction(this.database, async (client) => {
        const found = await client.query(
          `SELECT e.id, e.status, e.amount, e.document_id, d.document_no
             FROM condition_events e
             LEFT JOIN documents d ON d.id = e.document_id
            WHERE e.id = $1 AND e.condition_id = $2`, [eventId, conditionId]);
        const row = found.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `実績 ${eventId} が見つかりません`);
        if (row.status === "void") {
          throw new DomainError("CONFLICT", "すでに取り消されています");
        }
        if (row.document_id) {
          // 計算書の金額はこの実績から出ている。片方だけ消すと食い違う。
          throw new DomainError("CONFLICT",
            `この実績は計算書 ${row.document_no ?? `#${row.document_id}`} から作られています。` +
            "取り消すなら計算書ごと無効にしてください");
        }

        await client.query(
          "UPDATE condition_events SET status = 'void', note = $2 WHERE id = $1",
          [eventId, `取消：${why}`]);
        await recordAudit(client, {
          actor, action: "condition.event_void", targetType: "condition", targetId: conditionId,
          detail: { eventId, amount: Number(row.amount), reason: why }
        });
        return { voided: eventId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 結びつけられるかだけ確かめる。書かない。
   *
   * 文書を発行してから紐づけに失敗すると、番号の振られた文書だけが残り、
   * 人は同じものをもう一度作ることになる。発行の前に弾く。
   *
   * heldBy を渡すと、その文書が持っている実績は「空いている」ものとして扱う。
   * 訂正版は前の版から実績を引き取るので、ここを塞ぐと差し替えのたびに
   * 元の文書を無効にする手間が要る（それが二重作業の原因だった）。
   */
  async assertLinkable(
    conditionId: number, eventIds: number[], heldBy?: number | null
  ): Promise<void> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) return;
    const rows = await this.database.query(
      `SELECT e.id, e.status,
              -- 無効にした文書に結びついたままの実績は、空いているものとして扱う。
              CASE WHEN d.status = 'void' THEN NULL ELSE e.document_id END AS document_id
         FROM condition_events e LEFT JOIN documents d ON d.id = e.document_id
        WHERE e.id = ANY($1::bigint[]) AND e.condition_id IN ${SERIES_IDS_SQL("$2")}`, [ids, conditionId]);
    const found = rows.rows as Array<{ id: number; status: string; document_id: number | null }>;
    if (found.length !== ids.length) {
      throw new DomainError("NOT_FOUND", "この条件に無い実績が混ざっています");
    }
    const voided = found.filter((r) => r.status !== "active");
    if (voided.length) {
      throw new DomainError("CONFLICT",
        `取り消し済みの実績は結びつけられません（#${voided.map((r) => r.id).join("・")}）`);
    }
    const taken = found.filter((r) =>
      r.document_id !== null && (!heldBy || Number(r.document_id) !== Number(heldBy)));
    if (taken.length) {
      throw new DomainError("CONFLICT",
        `すでに別の文書に結びついている実績があります（#${taken.map((r) => r.id).join("・")}）。` +
        "その文書を訂正するか、無効にしてから結び直してください");
    }
  }

  /**
   * 結びつけを外す。
   *
   * 移行してきた文書を実績に結び直す作業では必ず取り違える。外せないと、
   * 間違えた瞬間にその実績は二度と正しい文書に結べなくなる（別の文書に
   * 取られている扱いになる）。直せる道を用意しておく。
   *
   * 外しても文書は変わらない。発行した紙の内容ではなく、
   * 「どの実績を指しているか」の索引を直すだけ。
   */
  async unlinkDocument(
    conditionId: number, eventIds: number[], documentId: number, actor: string
  ): Promise<{ unlinked: number }> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "外す実績がありません");
    try {
      return await inTransaction(this.database, async (client) => {
        // いま見ている文書に結びついているものだけ外す。番号を取り違えたまま
        // 押しても、別の文書の紐づけには手が届かない。
        const updated = await client.query(
          `UPDATE condition_events SET document_id = NULL
            WHERE id = ANY($1::bigint[]) AND condition_id IN ${SERIES_IDS_SQL("$2")} AND document_id = $3`,
          [ids, conditionId, documentId]);
        const unlinked = updated.rowCount ?? 0;
        if (!unlinked) {
          throw new DomainError("CONFLICT",
            "その文書に結びついている実績がありません。画面を読み直してください");
        }
        await recordAudit(client, {
          actor, action: "condition.unlink_document", targetType: "condition",
          targetId: conditionId, detail: { documentId, eventIds: ids, unlinked }
        });
        return { unlinked };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 実績を条件ごとに分ける。1枚の検収書に、委託料と実費のように条件をまたいだ
   * 実績を載せるときの入口。結びつけは条件ごとに行うので、先に束を分ける。
   * 見つからない実績があれば止める（黙って落とすと、その回だけ検収書に載らない）。
   */
  /**
   * 条件 id → 系列（改訂の全版に共通の id）。
   * 文書に繋いだ条件は今の版、実績は旧版に付いたまま、ということが改訂のあとに
   * 起きる。id で突き合わせると「その条件はこの文書に繋がっていません」と
   * 弾いてしまうので、系列で比べる。
   */
  async seriesOf(conditionIds: number[]): Promise<Map<number, number>> {
    const ids = [...new Set(conditionIds.map((n) => Math.trunc(Number(n))))].filter((n) => n > 0);
    const out = new Map<number, number>();
    if (!ids.length) return out;
    const r = await this.database.query(
      "SELECT id, COALESCE(series_id, id) AS series FROM conditions WHERE id = ANY($1::bigint[])", [ids]);
    for (const row of r.rows as Array<{ id: number; series: number }>) out.set(Number(row.id), Number(row.series));
    return out;
  }

  async groupByCondition(eventIds: number[]): Promise<Map<number, number[]>> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(Number(n))))].filter((n) => n > 0);
    const out = new Map<number, number[]>();
    if (!ids.length) return out;
    const r = await this.database.query(
      "SELECT id, condition_id FROM condition_events WHERE id = ANY($1::bigint[])", [ids]);
    const rows = r.rows as Array<{ id: number; condition_id: number }>;
    if (rows.length !== ids.length) {
      const known = new Set(rows.map((x) => Number(x.id)));
      throw new DomainError("NOT_FOUND",
        `実績が見つかりません：${ids.filter((i) => !known.has(i)).join(", ")}`);
    }
    for (const row of rows) {
      const cid = Number(row.condition_id);
      out.set(cid, [...(out.get(cid) ?? []), Number(row.id)]);
    }
    return out;
  }

  /**
   * 実績を発行済み文書に結びつける。検収書・計算書がどの実績から出たかは
   * この列（condition_events.document_id）にしか無く、書く処理が無かったため
   * 「この検収書は何回目の分か」が追えなかった。
   *
   * 文書は発行済みのものだけを受ける。下書きに結ぶと、下書きを捨てたときに
   * 実績だけが宙に浮く。
   */
  async linkDocument(
    conditionId: number, eventIds: number[], documentId: number, actor: string
  ): Promise<{ linked: number; documentNo: string | null }> {
    const ids = [...new Set(eventIds.map((n) => Math.trunc(n)))].filter((n) => n > 0);
    if (!ids.length) throw new DomainError("VALIDATION", "結びつける実績がありません");
    try {
      return await inTransaction(this.database, async (client) => {
        const doc = await client.query(
          "SELECT id, document_no, status FROM documents WHERE id = $1", [documentId]);
        const document = doc.rows[0] as
          { document_no: string | null; status: string } | undefined;
        if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (document.status !== "issued") {
          throw new DomainError("CONFLICT", "発行済みの文書にだけ実績を結びつけられます");
        }

        const rows = await client.query(
          `SELECT e.id, e.status,
              -- 無効にした文書に結びついたままの実績は、空いているものとして扱う。
              CASE WHEN d.status = 'void' THEN NULL ELSE e.document_id END AS document_id
         FROM condition_events e LEFT JOIN documents d ON d.id = e.document_id
        WHERE e.id = ANY($1::bigint[]) AND e.condition_id IN ${SERIES_IDS_SQL("$2")}`, [ids, conditionId]);
        const found = rows.rows as Array<{ id: number; status: string; document_id: number | null }>;
        if (found.length !== ids.length) {
          throw new DomainError("NOT_FOUND", "この条件に無い実績が混ざっています");
        }
        const voided = found.filter((r) => r.status !== "active");
        if (voided.length) {
          throw new DomainError("CONFLICT",
            `取り消し済みの実績は結びつけられません（#${voided.map((r) => r.id).join("・")}）`);
        }
        // bigint は文字列で返る。数に揃えないと "7" !== 7 で、この文書自身が
        // 結んだ実績まで「別の文書のもの」と読んでしまう
        // （訂正版の発行で実績を移したあと、ここで必ず弾かれていた）。
        const taken = found.filter((r) =>
          r.document_id !== null && Number(r.document_id) !== Number(documentId));
        if (taken.length) {
          throw new DomainError("CONFLICT",
            `すでに別の文書に結びついている実績があります（#${taken.map((r) => r.id).join("・")}）。` +
            "作り直すなら、先にその文書を無効にしてください");
        }

        const updated = await client.query(
          `UPDATE condition_events SET document_id = $3
            WHERE id = ANY($1::bigint[]) AND condition_id IN ${SERIES_IDS_SQL("$2")}
              AND (document_id IS NULL
                   OR document_id IN (SELECT x.id FROM documents x WHERE x.status = 'void'))`,
          [ids, conditionId, documentId]);

        const linked = updated.rowCount ?? 0;
        // 何も動いていないなら記録しない。すでに全部この文書を指している
        // （訂正版の発行で移ってきた）ときに linked:0 の行が積もると、
        // 履歴を読む側が「結びつけに失敗した」と誤読する。
        if (linked) {
          await recordAudit(client, {
            actor, action: "condition.link_document", targetType: "condition",
            targetId: conditionId,
            detail: { documentId, documentNo: document.document_no, eventIds: ids, linked }
          });
        }
        return { linked, documentNo: document.document_no };
      });
    } catch (error) { throw translate(error); }
  }
}
