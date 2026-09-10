import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { taxRatePercentFor } from "./legacy-totals.js";

/**
 * テンプレート変数の供給元になる文脈を、条件・合意・当事者・作品から組み立てる。
 * ここが V2 の form_data に相当する位置だが、値は全部ドメインから来る。
 */
export interface DocumentContextInput {
  conditionIds: number[];
  agreementId?: number | null;
  matterId?: number | null;
  documentNumber?: string | null;
  issuedOn?: string | null;
  /** 実績。検収書・納品書はここの日付と金額が要る。 */
  eventIds?: number[];
  /** 計算結果。利用許諾料計算書は、発行の時点でこれが要る。 */
  royalty?: Record<string, unknown> | null;
}

const MINOR: Record<string, number> = { JPY: 1, KRW: 1, VND: 1 };
/** 最小通貨単位から表示用の額へ戻す。 */
export const toMajor = (amount: number | null, currency: string): number | null =>
  amount === null || amount === undefined ? null : amount / (MINOR[currency] ?? 100);

const honorificFor = (kind: string | null) => (kind === "individual" ? "様" : "御中");

export class DocumentContextRepository {
  constructor(private readonly database: Transactable) {}

  async build(input: DocumentContextInput, client: Queryable = this.database) {
    try {
      const conditions = await this.conditions(client, input.conditionIds);
      if (input.conditionIds.length && !conditions.length) {
        throw new DomainError("NOT_FOUND", "指定された条件が見つかりません");
      }
      const agreementId = input.agreementId ?? conditions[0]?.agreementId ?? null;
      // 案件は文書に指定されていなくても、条件から辿れば分かる。
      // 辿らないと担当者（検収者）と件名が空のままになり、案件を指定して
      // 作ったときだけ埋まる、という不揃いな画面になっていた。
      const matterId = input.matterId ?? await this.matterIdForConditions(client, input.conditionIds);
      // client はトランザクションの接続で渡ってくることがある。1本の接続に
      // 同時に問い合わせられないので、順に読む。
      const agreement = agreementId ? await this.agreement(client, agreementId) : null;
      const matter = matterId ? await this.matter(client, matterId) : null;
      const company = await this.company(client);
      const events = input.eventIds?.length ? await this.events(client, input.eventIds) : [];
      // 予定明細。発注書の明細表はここから組む（これから何回いくら払うか）。
      const schedules = conditions.length ? await this.schedules(client, conditions.map((c) => c.id)) : [];
      // 取引先の担当者（署名者・請求先）と、案件の担当スタッフ。
      // 書類の宛名や検収者はここから引ける。
      const partyId = conditions[0]?.counterpartyId ?? null;
      const contacts = partyId ? await this.contacts(client, partyId) : [];
      const bank = partyId ? await this.bank(client, partyId) : null;
      const owner = matterId ? await this.owner(client, matterId) : null;
      // 同じ条件から出ている他の書類。検収書は親の発注番号を見出しに出す。
      const related = input.conditionIds.length
        ? await this.relatedDocuments(client, input.conditionIds) : [];
      const backlogKey = matterId ? await this.backlogKey(client, matterId) : null;
      // 作品の取得条件。条件書の「構成要素」はここから並ぶ（許諾できる上限を
      // 決めているのは作品の取得条件なので、書類に並ぶのもそれ）。
      const workIds = [...new Set(conditions.map((c) => c.workId).filter((id): id is number => Boolean(id)))];
      const acquisitions = workIds.length ? await this.acquisitions(client, workIds) : [];

      const currency = conditions[0]?.currency ?? "JPY";
      /**
       * 合計。**実績を選んでいればその金額が対象**で、条件の総額ではない。
       * ここが条件の総額だけを見ていたので、実績から出した検収書の消費税が
       * つねに 0 円になっていた（税抜は実績、消費税は条件、という取り合わせ）。
       *
       * 税率は条件の税区分ごと（課税10% / 軽減8% / 非課税0%）。区分をまとめて
       * 10% で掛けると、軽減や非課税の混じった書類が合わなくなる。
       */
      const bases = events.length
        ? events.map((e) => ({
            minor: e.amountMinor,
            taxCategory: conditions.find((c) => c.id === e.conditionId)?.taxCategory ?? "taxable"
          }))
        : conditions.map((c) => ({ minor: c.flatAmountMinor ?? 0, taxCategory: c.taxCategory }));
      const exTax = bases.reduce((sum, b) => sum + b.minor, 0);
      // 端数は税区分ごとに切り上げる。区分をまたいで足してから切り上げると
      // 1円ずれる（V1 の inspectionTaxBreakdown と同じ扱い）。
      const byCategory = new Map<string, number>();
      for (const b of bases) {
        byCategory.set(b.taxCategory, (byCategory.get(b.taxCategory) ?? 0) + b.minor);
      }
      let tax = 0;
      for (const [category, minor] of byCategory) {
        tax += Math.ceil((minor * taxRatePercentFor(category)) / 100);
      }
      const taxRate = bases.length
        ? Math.max(...bases.map((b) => taxRatePercentFor(b.taxCategory)))
        : 10;

      return {
        document: {
          number: input.documentNumber ?? null,
          issuedOn: input.issuedOn ?? dateStr(new Date())
        },
        company,
        matter,
        agreement,
        conditions,
        /** 単一条件のテンプレートはこちらを使う。 */
        condition: conditions[0] ?? null,
        events,
        /** 予定明細。発注書・支払通知書の明細はここから組む。 */
        schedules,
        /** 取引先の担当者。role ごとに引ける（primary / signer / billing）。 */
        contacts,
        /** 振込先。支払通知書・請求書はこれが無いと成立しない。 */
        bank,
        /** 案件の担当スタッフ。検収者の既定になりうる。 */
        owner,
        /**
         * 同じ条件から出ている書類。検収書の見出しに出る「発注番号」は
         * この中の発注書から来る。人に打たせるものではない。
         */
        related,
        /** 案件に繋がっている Backlog 課題のキー。 */
        backlogKey,
        /**
         * この文書の条件が指している作品の取得条件（IN）。
         * 個別利用許諾条件書の「構成要素」の表はここから組む。
         */
        acquisitions,
        /** 実績が1件のときはこちら。検収書はこの日付と金額を使う。 */
        event: events[0] ?? null,
        /** その実績の予定明細。支払期日はここから来る。 */
        schedule: events[0]?.schedule ?? null,
        /** 計算書の金額。試算の結果をそのまま渡す。無ければ null。 */
        royalty: input.royalty ?? null,
        totals: {
          exTax: toMajor(exTax, currency),
          tax: toMajor(tax, currency),
          incTax: toMajor(exTax + tax, currency),
          /** 本文の「消費税(x%)」に差す率。 */
          taxRate,
          currency
        }
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 実績。検収書の「実納品日」「納品額」はここから来る。
   * これまでコンテキストに入っておらず、実績から検収書を作っても
   * 日付も金額も人が打ち直すことになっていた。
   */
  /**
   * 予定明細。発注書は「これから何回いくら払うか」を書く書類なので、
   * 明細行の出どころはここ以外にない。
   */
  private async schedules(client: Queryable, conditionIds: number[]) {
    const r = await client.query(
      `SELECT s.id, s.condition_id, s.seq, s.trigger_kind, s.planned_amount,
              s.due_on, s.pay_on, s.label, c.currency
         FROM condition_schedules s JOIN conditions c ON c.id = s.condition_id
        WHERE s.condition_id = ANY($1::bigint[])
        ORDER BY s.condition_id, s.seq`, [conditionIds]);
    return (r.rows as Array<Record<string, any>>).map((row) => {
      const currency = String(row.currency ?? "JPY");
      return {
        id: Number(row.id),
        conditionId: Number(row.condition_id),
        seq: Number(row.seq),
        triggerKind: String(row.trigger_kind),
        plannedAmount: toMajor(int(row.planned_amount), currency),
        dueOn: dateStr(row.due_on),
        payOn: dateStr(row.pay_on),
        label: str(row.label),
        currency
      };
    });
  }

  /** 取引先の担当者。役割ごとに1件までなので、そのまま並べる。 */
  private async contacts(client: Queryable, partyId: number) {
    const r = await client.query(
      `SELECT role, name, email, phone, department FROM party_contacts
        WHERE party_id = $1 ORDER BY role`, [partyId]);
    return (r.rows as Array<Record<string, any>>).map((row) => ({
      role: String(row.role),
      name: str(row.name), email: str(row.email),
      phone: str(row.phone), department: str(row.department)
    }));
  }

  /**
   * 振込先。読み取りだけ許可してある（003_grants）。
   * 権限が無い環境でも書類の作成そのものは止めないよう、失敗は握って null を返す。
   */
  private async bank(client: Queryable, partyId: number) {
    try {
      const r = await client.query(
        `SELECT bank_name, branch_name, account_type, account_number, account_holder_kana
           FROM party_bank_accounts WHERE party_id = $1`, [partyId]);
      const row = r.rows[0] as Record<string, any> | undefined;
      if (!row) return null;
      const bank = {
        bankName: str(row.bank_name), branchName: str(row.branch_name),
        accountType: str(row.account_type), accountNumber: str(row.account_number),
        holderKana: str(row.account_holder_kana)
      };
      // 口座種別しか入っていない行は口座ではない（V1 のフォームの初期値
      // 「普通」だけが保存されたもの。移行時点で98件あった）。
      // 種別だけを書類に出すと、振込先があるように見えてしまう。
      const payable = bank.bankName ?? bank.accountNumber ?? bank.holderKana ?? bank.branchName;
      return payable === null || payable === undefined ? null : bank;
    } catch {
      // 口座表への権限が無い環境（閉じたまま運用する場合）。書類は作れる。
      return null;
    }
  }

  /**
   * 条件から案件を辿る。参照は案件 → 条件の向きしか無いので反転して読む。
   * 複数に繋がっているときはいちばん古い案件（元の取引）を使う。
   */
  private async matterIdForConditions(client: Queryable, conditionIds: number[]) {
    if (!conditionIds.length) return null;
    const r = await client.query(
      `SELECT ml.matter_id
         FROM matter_links ml
        WHERE ml.target_type = 'condition'
          AND ml.target_ref = ANY($1::text[])
        ORDER BY ml.matter_id
        LIMIT 1`, [conditionIds.map((id) => String(id))]);
    const row = r.rows[0] as { matter_id: number } | undefined;
    return row ? Number(row.matter_id) : null;
  }

  /**
   * 同じ条件から出ている書類。種別ごとに新しいものを1件。
   * 検収書が「どの発注に対する検収か」を書けるのは、これが読めるときだけ。
   */
  /**
   * 同じ条件から出ている書類。条件ごと・ひな形ごとに最新の1件。
   * 検収書は条件をまたいで1枚にできるので、行ごとにその条件の発注番号を
   * 出せるよう、どの条件の書類かを持たせる。
   */
  private async relatedDocuments(client: Queryable, conditionIds: number[]) {
    const r = await client.query(
      `SELECT DISTINCT ON (dc.condition_id, t.template_key)
              d.id, d.document_no, d.issued_at, t.template_key, dc.condition_id
         FROM document_conditions dc
         JOIN documents d ON d.id = dc.document_id
         JOIN document_template_versions tv ON tv.id = d.template_version_id
         JOIN document_templates t ON t.id = tv.template_id
        WHERE dc.condition_id = ANY($1::bigint[]) AND d.status = 'issued'
        ORDER BY dc.condition_id, t.template_key, d.id DESC`, [conditionIds]);
    return (r.rows as Array<Record<string, any>>).map((row) => ({
      id: Number(row.id),
      conditionId: Number(row.condition_id),
      documentNo: str(row.document_no),
      templateKey: str(row.template_key),
      issuedAt: row.issued_at ? new Date(String(row.issued_at)).toISOString() : null
    }));
  }

  /** 案件に繋がっている Backlog 課題。書類の見出しに出るものがある。 */
  private async backlogKey(client: Queryable, matterId: number) {
    const r = await client.query(
      `SELECT target_ref FROM matter_links
        WHERE matter_id = $1 AND target_type = 'backlog_issue'
        ORDER BY id LIMIT 1`, [matterId]);
    return str((r.rows[0] as { target_ref?: string } | undefined)?.target_ref);
  }

  /** 案件の担当者。検収書の「検収者」はたいていこの人。 */
  private async owner(client: Queryable, matterId: number) {
    const r = await client.query(
      `SELECT s.name, s.email, s.department, s.staff_code, to_jsonb(s) AS staff_row
         FROM matters m JOIN staff s ON s.id = m.owner_staff_id
        WHERE m.id = $1`, [matterId]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      name: String(row.name), email: str(row.email),
      department: str(row.department), phone: str(row.staff_row?.phone),
      staffCode: str(row.staff_code)
    };
  }

  private async events(client: Queryable, ids: number[]) {
    const r = await client.query(
      `SELECT e.id, e.condition_id, e.event_type, e.occurred_on, e.period, e.quantity,
              e.gross_amount, e.deductions, e.amount, e.note,
              e.deliverable, e.inspected_on, e.inspector_dept, e.inspector_name,
              c.currency, s.label AS schedule_label, s.seq AS schedule_seq,
              s.due_on AS schedule_due_on, s.pay_on AS schedule_pay_on,
              s.planned_amount AS schedule_planned
         FROM condition_events e
         JOIN conditions c ON c.id = e.condition_id
         LEFT JOIN condition_schedules s ON s.id = e.schedule_id
        WHERE e.id = ANY($1::bigint[]) AND e.status = 'active'
        ORDER BY e.occurred_on, e.id`, [ids]);
    return (r.rows as Array<Record<string, any>>).map((row) => {
      const currency = String(row.currency ?? "JPY");
      return {
        id: Number(row.id),
        conditionId: Number(row.condition_id),
        eventType: String(row.event_type),
        occurredOn: dateStr(row.occurred_on),
        period: str(row.period) ?? str(row.schedule_label),
        seq: int(row.schedule_seq),
        quantity: int(row.quantity),
        grossAmount: toMajor(int(row.gross_amount), currency),
        deductions: toMajor(int(row.deductions), currency),
        amount: toMajor(int(row.amount), currency),
        amountMinor: int(row.amount) ?? 0,
        /** その回の予定額。実績と違えば「金額変更」として本文の変更履歴に出る。 */
        plannedAmount: toMajor(int(row.schedule_planned), currency),
        note: str(row.note),
        currency,
        /** 検収書がそのまま使う項目。実績に入っていれば文書側で人が入れずに済む。 */
        deliverable: str(row.deliverable),
        inspectedOn: dateStr(row.inspected_on),
        inspectorDept: str(row.inspector_dept),
        inspectorName: str(row.inspector_name),
        /** その回の予定。支払期日は支払通知書に要る。 */
        schedule: row.schedule_seq === null ? null : {
          seq: int(row.schedule_seq), label: str(row.schedule_label),
          dueOn: dateStr(row.schedule_due_on), payOn: dateStr(row.schedule_pay_on)
        }
      };
    });
  }

  private async conditions(client: Queryable, ids: number[]) {
    if (!ids.length) return [];
    const result = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.direction, c.kind, c.currency, c.pricing_model,
              c.rate_ppm, c.unit_amount, c.flat_amount, c.mg_amount, c.ag_amount,
              c.term_start, c.term_end, c.tax_category, c.payment_terms, c.cycle,
              c.agreement_id, c.exclusivity, c.sublicensable, c.notes, c.spec, c.deliverable_ownership,
              c.order_no,
              c.counterparty_id, c.work_id,
              p.name AS party_name, p.name_kana AS party_kana, p.kind AS party_kind,
              p.invoice_no AS party_invoice_no, p.corporate_no AS party_corporate_no,
              p.withholding AS party_withholding,
              -- 住所・電話・メールは A-008 で足した列。当てる前のデータベースでも
              -- 落ちないよう、列を名指しせず行ごと受けて読む。
              to_jsonb(p) AS party_row,
              w.title AS work_title, w.work_code, wp.name AS part_name
         FROM conditions c
         LEFT JOIN parties p    ON p.id = c.counterparty_id
         LEFT JOIN works w      ON w.id = c.work_id
         LEFT JOIN work_parts wp ON wp.id = c.work_part_id
        WHERE c.id = ANY($1::bigint[])
        ORDER BY array_position($1::bigint[], c.id)`,
      [ids]
    );
    return result.rows.map((row: Record<string, any>) => {
      const currency = String(row.currency ?? "JPY");
      return {
        id: Number(row.id),
        conditionNo: str(row.condition_no),
        name: String(row.name ?? ""),
        direction: String(row.direction),
        kind: String(row.kind),
        currency,
        pricingModel: String(row.pricing_model),
        ratePct: row.rate_ppm === null || row.rate_ppm === undefined
          ? null : Number(row.rate_ppm) / 10000,
        unitAmount: toMajor(int(row.unit_amount), currency),
        flatAmount: toMajor(int(row.flat_amount), currency),
        mgAmount: toMajor(int(row.mg_amount), currency),
        agAmount: toMajor(int(row.ag_amount), currency),
        flatAmountMinor: int(row.flat_amount) ?? 0,
        termStart: dateStr(row.term_start),
        termEnd: dateStr(row.term_end),
        taxCategory: String(row.tax_category ?? "taxable"),
        paymentTerms: str(row.payment_terms),
        cycle: str(row.cycle),
        exclusivity: str(row.exclusivity),
        /** 書類に印字する言い方。列は enum なので、そのまま出すと英語が出る。 */
        exclusivityLabel: row.exclusivity === "exclusive" ? "独占"
          : row.exclusivity === "non_exclusive" ? "非独占" : null,
        sublicensable: row.sublicensable,
        notes: str(row.notes),
        spec: str(row.spec),
        deliverableOwnership: str(row.deliverable_ownership),
        /** 外部で出した発注番号。V3 の発注書が無いときの控え。 */
        orderNo: str(row.order_no),
        agreementId: int(row.agreement_id),
        counterpartyId: int(row.counterparty_id),
        /** 作品。条件書の構成要素は、この作品の取得条件から並ぶ。 */
        workId: int(row.work_id),
        counterparty: {
          name: str(row.party_name) ?? "",
          kana: str(row.party_kana),
          kind: str(row.party_kind),
          invoiceNo: str(row.party_invoice_no),
          corporateNo: str(row.party_corporate_no),
          address: str(row.party_row?.address),
          phone: str(row.party_row?.phone),
          email: str(row.party_row?.email),
          withholding: row.party_withholding === true,
          honorific: honorificFor(str(row.party_kind))
        },
        work: { title: str(row.work_title), code: str(row.work_code), part: str(row.part_name) },
        scopes: { region: [] as string[], language: [] as string[], media: [] as string[] }
      };
    }).map((condition, index, all) => ({ ...condition, index: index + 1, total: all.length }));
  }

  private async agreement(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT a.id, a.agreement_no, a.title, a.direction, a.status,
              a.executed_on, a.effective_on, a.expires_on,
              a.auto_renewal, a.renewal_notice_months,
              p.name AS party_name, p.name_kana AS party_kana, p.kind AS party_kind,
              p.invoice_no, p.corporate_no
         FROM agreements a LEFT JOIN parties p ON p.id = a.counterparty_id
        WHERE a.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      no: str(row.agreement_no),
      title: String(row.title ?? ""),
      direction: String(row.direction),
      status: String(row.status),
      executedOn: dateStr(row.executed_on),
      effectiveOn: dateStr(row.effective_on),
      expiresOn: dateStr(row.expires_on),
      autoRenewal: row.auto_renewal === true,
      renewalNoticeMonths: int(row.renewal_notice_months),
      counterparty: {
        name: str(row.party_name) ?? "",
        kana: str(row.party_kana),
        kind: str(row.party_kind),
        honorific: honorificFor(str(row.party_kind)),
        invoiceNo: str(row.invoice_no),
        corporateNo: str(row.corporate_no)
      }
    };
  }

  private async matter(client: Queryable, id: number) {
    const r = await client.query(
      `SELECT m.id, m.matter_no, m.title, m.kind, s.name AS owner_name
         FROM matters m LEFT JOIN staff s ON s.id = m.owner_staff_id
        WHERE m.id = $1`, [id]);
    const row = r.rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id), no: str(row.matter_no), title: String(row.title ?? ""),
      kind: String(row.kind), ownerName: str(row.owner_name)
    };
  }

  /** 自社情報は settings から（V2 の会社プロファイルに相当）。 */
  private async company(client: Queryable) {
    const r = await client.query("SELECT value FROM settings WHERE key = 'company_profile'");
    const value = (r.rows[0] as { value?: Record<string, unknown> } | undefined)?.value;
    return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  }

  /**
   * 作品の取得条件（IN）。個別利用許諾条件書の「構成要素」の表になる。
   *
   * 許諾できる上限を決めているのは作品の取得条件なので、条件書に並べる
   * 構成要素もそれ。範囲（地域・言語）は取得条件に付いた範囲をそのまま出す。
   */
  private async acquisitions(client: Queryable, workIds: number[]) {
    const r = await client.query(
      `SELECT c.id, c.condition_no, c.name, c.rate_ppm, c.currency,
              c.mg_amount, c.ag_amount,
              p.name AS party_name, wp.name AS part_name, w.title AS work_title,
              a.agreement_no,
              (SELECT array_agg(s.label ORDER BY s.sort_order, s.label)
                 FROM condition_scopes s
                WHERE s.condition_id = c.id AND s.scope_type = 'region')   AS regions,
              (SELECT array_agg(s.label ORDER BY s.sort_order, s.label)
                 FROM condition_scopes s
                WHERE s.condition_id = c.id AND s.scope_type = 'language') AS languages
         FROM conditions c
         LEFT JOIN parties p     ON p.id = c.counterparty_id
         LEFT JOIN works w       ON w.id = c.work_id
         LEFT JOIN work_parts wp ON wp.id = c.work_part_id
         LEFT JOIN agreements a  ON a.id = c.agreement_id
        WHERE c.work_id = ANY($1::bigint[])
          AND c.direction = 'in' AND c.status = 'active'
        ORDER BY wp.part_no NULLS LAST, c.id`, [workIds]);
    return (r.rows as Array<Record<string, any>>).map((row) => ({
      id: Number(row.id),
      conditionNo: str(row.condition_no),
      name: String(row.name ?? ""),
      partName: str(row.part_name),
      workTitle: str(row.work_title),
      counterparty: str(row.party_name),
      agreementNo: str(row.agreement_no),
      ratePct: row.rate_ppm === null || row.rate_ppm === undefined
        ? null : Number(row.rate_ppm) / 10000,
      currency: String(row.currency ?? "JPY"),
      regions: (row.regions ?? []) as string[],
      languages: (row.languages ?? []) as string[]
    }));
  }

  /** 範囲は行数が多いので条件をまとめて1回で引く。 */
  async attachScopes(client: Queryable, conditions: Array<{ id: number; scopes: Record<string, string[]> }>) {
    if (!conditions.length) return;
    const r = await client.query(
      `SELECT condition_id, scope_type, label FROM condition_scopes
        WHERE condition_id = ANY($1::bigint[]) ORDER BY sort_order, label`,
      [conditions.map((c) => c.id)]
    );
    for (const row of r.rows as Array<Record<string, any>>) {
      const target = conditions.find((c) => c.id === Number(row.condition_id));
      const bucket = target?.scopes[String(row.scope_type)];
      if (bucket) bucket.push(String(row.label));
    }
  }
}
