import { useEffect, useMemo, useState } from "react";
import type { DocumentFormData, DocumentFormSchema } from "../types";
import { isIndividualEntity } from "../honorific";

type MasterType = "vendor" | "staff" | "document" | "work" | "company";
type Item = {
  id: string;
  type: MasterType;
  label: string;
  description?: string;
  values: Record<string, unknown>;
};

const labels: Record<MasterType, string> = {
  vendor: "取引先",
  staff: "担当者",
  document: "契約・文書",
  work: "作品・原作",
  company: "自社"
};

export function MasterDataPicker({
  schema,
  formData,
  onApply
}: {
  schema: DocumentFormSchema;
  formData: DocumentFormData;
  onApply: (patch: DocumentFormData, message: string) => void;
}) {
  const availableTypes = useMemo(() => typesForSchema(schema), [schema]);
  // 検収書の文書タブは「親の発注書を選ぶ」専用（検索対象を発注書に絞る）。
  const parentPoMode = isInspectionSchema(schema);
  const [type, setType] = useState<MasterType>(availableTypes[0] ?? "vendor");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  // ログイン中ユーザーのメール。担当者タブの「自分」ワンクリック引用に使う
  // （V1 発注書フォームの Sync Staff 相当。V1 は事前選択が要ったがここでは不要）。
  const [myEmail, setMyEmail] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/v2/me")
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (!cancelled) setMyEmail(String(body?.user?.email ?? "")); })
      .catch(() => { /* 引用の補助機能なので取得失敗は無視 */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!availableTypes.includes(type)) setType(availableTypes[0] ?? "vendor");
  }, [availableTypes, type]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const templateFilter = type === "document" && parentPoMode
        ? "&template=purchase_order,intl_purchase_order" : "";
      fetch(`/api/v2/master-data/search?type=${type}&q=${encodeURIComponent(query)}${templateFilter}`, {
        signal: controller.signal
      })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("master search failed")))
        .then((result) => setItems(result.items ?? []))
        .catch((error) => {
          if (error.name !== "AbortError") setItems([]);
        })
        .finally(() => setLoading(false));
    }, type === "company" ? 0 : 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [type, query, parentPoMode]);

  // 担当者タブの「自分」：メール完全一致の staff を1件だけ引いて適用する。
  // 一致が無い＝担当者マスタ未登録なので、その旨を通知して何も書き換えない。
  async function applySelf() {
    if (!myEmail) return;
    try {
      const response = await fetch(
        `/api/v2/master-data/search?type=staff&q=${encodeURIComponent(myEmail)}`);
      if (!response.ok) throw new Error("staff lookup failed");
      const result = await response.json();
      const me = findSelfStaff(result.items ?? [], myEmail);
      if (!me) {
        onApply({}, `担当者マスタに ${myEmail} が見つかりませんでした（担当者マスタに登録してください）`);
        return;
      }
      const patch = buildPatch(schema, formData, me);
      const count = Object.keys(patch).length;
      onApply(patch, count > 0
        ? `${me.label}（自分）の情報を${count}項目に入力しました`
        : `${me.label}：この文書に担当者の項目がありません`);
    } catch {
      onApply({}, "担当者情報の取得に失敗しました");
    }
  }

  return <section className="master-picker">
    <div className="master-picker-head">
      <div><span>DBから引用</span><strong>登録済みデータを差し込む</strong></div>
      <small>取引先などを選ぶと、該当する項目だけ入力されます。入力後の修正も可能です。</small>
    </div>
    <div className="master-tabs">
      {availableTypes.map((candidate) =>
        <button type="button" className={candidate === type ? "active" : ""}
          key={candidate} onClick={() => { setType(candidate); setQuery(""); }}>
          {candidate === "document" && parentPoMode ? "親の発注書" : labels[candidate]}
        </button>)}
    </div>
    {type !== "company" &&
      <div className="master-search-row">
        <input className="master-search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={type === "document" && parentPoMode
            ? "発注番号・件名・取引先名で発注書を検索"
            : `${labels[type]}の名称または番号を入力`} />
        {type === "staff" && myEmail &&
          <button type="button" className="master-self" onClick={() => applySelf()}>
            自分（{myEmail}）を引用
          </button>}
      </div>}
    <div className="master-results">
      {loading && <p>検索しています…</p>}
      {!loading && !items.length && <p>該当するデータがありません。</p>}
      {!loading && items.map((item) =>
        <button type="button" key={item.id}
          onClick={() => {
            const patch = buildPatch(schema, formData, item);
            const count = Object.keys(patch).length;
            onApply(patch, count > 0
              ? `${item.label}の情報を${count}項目に入力しました`
              : `${item.label}：この文書に対応する項目が見つかりませんでした（項目名を教えていただければ対応を追加します）`);
          }}>
          <strong>{item.label}</strong><small>{item.description}</small>
        </button>)}
    </div>
  </section>;
}

// 検索結果から「自分」の担当者行を選ぶ。メール完全一致のみ採用する
// （部分一致検索の結果に他人が混ざるため、曖昧一致では引用しない）。
export function findSelfStaff(
  items: Array<{ values?: Record<string, unknown> }>,
  email: string
): Item | null {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const matched = items.filter((item) =>
    String(item.values?.email ?? "").trim().toLowerCase() === target);
  // 同一メールが複数あるのは担当者マスタの異常。曖昧な引用を避けて何もしない。
  return matched.length === 1 ? matched[0] as Item : null;
}

function typesForSchema(schema: DocumentFormSchema): MasterType[] {
  const types = new Set<MasterType>(["vendor", "staff", "company"]);
  if (schema.fields.some((field) =>
    /基本契約|契約番号|発注番号|親 PO|親発注/.test(`${field.name} ${field.label ?? ""}`))) {
    types.add("document");
  }
  // 検収書は親の発注書から明細・件名を引用する（V1 のステップ1相当）。
  // 以前は「発注番号」ラベルの項目の有無で出していたが、055 で孤児項目として
  // 削除された際に文書タブごと消えていた。テンプレート種別で常に出す。
  if (isInspectionSchema(schema)) types.add("document");
  if (schema.fields.some((field) =>
    /作品|原著作物|素材|work_id|台帳ID/.test(`${field.name} ${field.label ?? ""}`))) {
    types.add("work");
  }
  return [...types];
}

export function buildPatch(schema: DocumentFormSchema, _formData: DocumentFormData, item: Item) {
  const patch: DocumentFormData = {};
  const values = item.type === "vendor" ? vendorSourceValues(item.values) : item.values;
  for (const field of schema.fields) {
    if (!field.dbField?.startsWith(`${item.type}.`)) continue;
    const sourceKey = field.dbField.slice(item.type.length + 1);
    // 対応表と同じ規則：null は空にする（前の相手の値を残さない）。
    setIfField(schema, patch, field.name, values[sourceKey]);
  }
  if (item.type === "vendor") {
    applyVendorAliases(schema, patch, values);
    // 「甲/乙」はテンプレごとに立場が入れ替わるため、単独では判定に使わない。
    // 相手方を示す語（取引先・売主・受託者…）がある項目のみ対象。自社を示す語があれば除外。
    applyPatternAliases(schema, patch, values,
      /甲|相手方|取引先|先方|許諾者|ライセンサ|委託先|発注先|受託者|売主/,
      [[/電話|TEL/i, "phone"], [/メール|mail/i, "email"], [/代表/, "vendor_rep"],
       [/住所/, "address"], [/担当/, "contact_name"],
       [/名称|会社名|法人名|氏名/, "vendor_name"]],
      /委託者|発注者|自社|当社|弊社|アークライト|Licensee/i);
  }
  if (item.type === "staff") applyStaffAliases(schema, patch, item.values);
  if (item.type === "company") {
    applyCompanyAliases(schema, patch, item.values);
    // 「乙」を文脈に含めない：販売・業務委託テンプレでは乙＝相手方（売主・受託者）のため、
    // 乙だけを根拠に自社情報を入れると誤り。NDA 等の「乙（自社想定）」は「自社」で拾える。
    applyPatternAliases(schema, patch, item.values,
      /自社|当社|弊社|アークライト|Licensee/i,
      [[/電話/, "tel"], [/住所/, "address"], [/代表/, "rep"],
       [/名称|会社名|法人名|氏名/, "name"]],
      // ライセンシーを除外：ライセンスアウト英文契約では Licensee＝相手方。
      // ライセンスイン系の Licensee_名称（自社）は対応表（exact）が先に埋めるため影響なし。
      /相手方|取引先|先方|売主|受託者|許諾者|ライセンサ|ライセンシー|委託先|発注先/);
  }
  if (item.type === "document") {
    applyDocumentAliases(schema, patch, item.values);
    if (isInspectionSchema(schema) && isPurchaseOrderDocument(item.values)) {
      applyParentPurchaseOrderQuote(schema, patch, item.values);
    }
  }
  if (item.type === "work") applyWorkAliases(schema, patch, item.values);
  return patch;
}

// 個人の取引先に「担当者」「担当部署」「代表者」は無い。V1 も個人では空にしている
// （purchaseOrder.tsx「担当者・部署は法人の概念。個人取引先では空にする」）。
// V2 はマスタの値をそのまま引いていたため、担当者名に口座名義カナが入っている
// 取引先で、宛名の下に「<カナ>　<カナ> 様」が出ていた（ARC-PO-2026-0117 ほか11件）。
// 値を無かったものとして渡す（null＝空にする指示。undefined だと「触らない」になる）。
function vendorSourceValues(values: Record<string, unknown>): Record<string, unknown> {
  if (!isIndividualEntity(values.entity_type)) return values;
  return { ...values, contact_name: null, contact_department: null, vendor_rep: null };
}

function applyVendorAliases(schema: DocumentFormSchema, patch: DocumentFormData, values: Record<string, unknown>) {
  const aliases: Record<string, string> = {
    VENDOR_NAME: "vendor_name", VENDOR_ADDRESS: "address", VENDOR_REP: "vendor_rep",
    VENDOR_EMAIL: "email", VENDOR_CONTACT_NAME: "contact_name",
    VENDOR_CONTACT_DEPARTMENT: "contact_department", VENDOR_CONTACT_PHONE: "phone",
    BANK_NAME: "bank_name", BRANCH_NAME: "branch_name", ACCOUNT_TYPE: "account_type",
    ACCOUNT_NUMBER: "account_number", ACCOUNT_HOLDER_KANA: "account_holder_kana",
    INVOICE_REGISTRATION_NUMBER: "invoice_registration_number",
    Licensor_名称: "vendor_name", Licensor_氏名会社名: "vendor_name",
    Licensor_住所: "address", Licensor_代表者名: "vendor_rep",
    Licensor_担当者: "contact_name", Licensor_電話: "phone", Licensor_メール: "email",
    counterparty: "vendor_name", 許諾者: "vendor_name", 許諾者住所: "address",
    許諾者氏名: "vendor_name", 許諾者法人名: "vendor_name",
    代表者氏名: "vendor_rep", 担当者氏名: "contact_name",
    担当者電話番号: "phone", 担当者メール: "email",
    振込先銀行名: "bank_name", 支店名: "branch_name", 口座種別: "account_type",
    口座番号: "account_number", 口座名義カナ: "account_holder_kana",
    インボイス登録番号: "invoice_registration_number",
    // 英語ラベルテンプレ（海外委託等）・通知先(乙)・緊急連絡先・インボイス（V1全項目照合で追加）。
    CONTRACTOR_NAME: "vendor_name", CONTRACTOR_ADDRESS: "address", CONTRACTOR_EMAIL: "email",
    CONTACT_EMAIL: "email", EMERGENCY_EMAIL: "email", EMERGENCY_PHONE: "phone",
    NOTICE_CONTACT_NAME: "contact_name", NOTICE_CONTACT_PHONE: "phone",
    NOTICE_CONTACT_EMAIL: "email",
    invoiceRegistrationNumber: "invoice_registration_number",
    invoiceRegistrationDisplay: "invoice_registration_number",
    VENDOR_PHONE: "phone", licensor: "vendor_name",
    counterpartyTni: "invoice_registration_number",
    // camelCase の振込先欄（検収書・報告系テンプレ）。
    bankName: "bank_name", branchName: "branch_name", accountType: "account_type",
    accountNo: "account_number", accountHolder: "account_holder_kana"
  };
  applyExistingFields(schema, patch, values, aliases);
  setIfField(schema, patch, "VENDOR_IS_CORPORATION", values.entity_type !== "個人" ? "法人" : "個人");
  setIfField(schema, patch, "LICENSOR_IS_CORPORATION", values.entity_type !== "個人");
  setIfField(schema, patch, "COUNTERPARTY_IS_CORPORATION", values.entity_type !== "個人" ? "法人" : "個人");
  setIfField(schema, patch, "許諾者種別", values.entity_type !== "個人" ? "法人" : "個人");
  setIfField(schema, patch, "VENDOR_SUFFIX", values.entity_type !== "個人" ? "御中" : "様");
  setIfField(schema, patch, "LICENSOR_SUFFIX", values.entity_type !== "個人" ? "御中" : "様");
  // 「代表者名 (＋様)」欄は敬称込みで持つ（V1 と同じ）。ラベル推定に任せると
  // 敬称なしの氏名が入る。個人は上で空にしているのでこの欄も空になる。
  const repName = `${values.vendor_rep || values.contact_name || ""}`.trim();
  setIfField(schema, patch, "VENDOR_REPRESENTATIVE_SAMA", repName ? `${repName} 様` : "");
}

function applyStaffAliases(schema: DocumentFormSchema, patch: DocumentFormData, values: Record<string, unknown>) {
  applyExistingFields(schema, patch, values, {
    STAFF_NAME: "staff_name", STAFF_DEPARTMENT: "department", STAFF_EMAIL: "email",
    STAFF_PHONE: "phone", 監修者: "staff_name", inspectorName: "staff_name",
    inspectorDept: "department", inspectorEmail: "email", RESPONSE_AUTHOR: "staff_name"
  });
}

function applyCompanyAliases(schema: DocumentFormSchema, patch: DocumentFormData, values: Record<string, unknown>) {
  applyExistingFields(schema, patch, values, {
    COMPANY_NAME: "name", COMPANY_ADDRESS: "address", COMPANY_REP: "rep",
    COMPANY_REPRESENTATIVE: "rep", PARTY_A_NAME: "name", PARTY_A_ADDRESS: "address",
    PARTY_A_REP: "rep", Licensee_名称: "name", Licensee_氏名会社名: "name",
    Licensee_住所: "address", Licensee_代表者名: "rep", licensee: "name",
    アークライト住所: "address", アークライト代表者氏名: "rep",
    // 会社プロファイル拡張（1-6・app_settings 由来）。
    COMPANY_NAME_KANA: "name_kana", COMPANY_POSTAL_CODE: "postal_code",
    COMPANY_TEL: "tel", COMPANY_FAX: "fax",
    COMPANY_INVOICE_NO: "invoice_no", 適格請求書発行事業者番号: "invoice_no",
    COMPANY_BANK_INFO: "bank_info", COMPANY_SEAL_NOTE: "seal_note"
  });
}

export function isInspectionSchema(schema: DocumentFormSchema): boolean {
  return schema.templateKey === "inspection_certificate";
}

export function isPurchaseOrderDocument(values: Record<string, unknown>): boolean {
  return /^(intl_)?purchase_order/.test(String(values.template_type ?? ""));
}

// 親の発注書 → 検収書の引用（V1 inspectionCertificate.tsx ステップ1相当）。
// 発注明細を検収明細に写す。数量・金額は「全量検収」を初期値にして、分割検収は
// 行の編集・削除で調整してもらう（明細エディタは編集可能）。0円の業績連動・
// 利用許諾行は V1 と同じく金額0のまま取り込む（表記の出し分けに使う列も写す）。
export function applyParentPurchaseOrderQuote(
  schema: DocumentFormSchema, patch: DocumentFormData, values: Record<string, unknown>
) {
  const items = Array.isArray(values.items) ? values.items as Array<Record<string, unknown>> : [];
  if (items.length) {
    patch.delivery_line_items = items.map((line) => ({
      item_name: line.item_name ?? "",
      spec: line.spec ?? "",
      // 発注数量・発注額は「発注 n点 ¥X」表示と金額変更（差分→理由）の判定に使う。
      ordered_quantity: line.quantity ?? 1,
      ordered_amount_ex_tax: line.amount_ex_tax ?? amountFromUnit(line),
      // 単価は今回数量の変更時の自動再計算（単価×数量）に使う（V1 DeliverableCards 相当）。
      // 定期支払（SUBSCRIPTION）は「1周期の金額×周期数」の周期額にあたる。
      unit_price: line.unit_price ?? "",
      // 支払予定日は定期支払の「周期ごとに分割」の情報源（各期の日付・金額）。
      ...(Array.isArray(line.payment_schedule) && line.payment_schedule.length
        ? { payment_schedule: line.payment_schedule } : {}),
      // 検収状態の初期値は「今回検収」。過去分は行で「検収済み」に、対象外は「未検収」に切り替える。
      inspection_status: "now",
      inspected_quantity: line.quantity ?? 1,
      acceptance_ratio: 1,
      inspected_amount_ex_tax: line.amount_ex_tax ?? amountFromUnit(line),
      delivery_date: line.delivery_date ?? "",
      deliverable_ownership: line.deliverable_ownership ?? "発注者",
      calc_method: line.calc_method ?? "FIXED",
      royalty_calc_basis: line.royalty_calc_basis ?? "",
      rate_pct: line.rate_pct ?? ""
    }));
  }
  // 経費・手数料は「精算候補」として持ち込む（自動では支払額に含めない）。
  // V1 ステップ2-b/2-c と同じ：行ごとの「今回含める」チェックか最終検収トグルで
  // 選んだ行だけが expenses / other_fees（＝PDF と総支払額の入力）へ入る。
  const expenses = Array.isArray(values.expenses) ? values.expenses as Array<Record<string, unknown>> : [];
  if (expenses.length) patch.po_expenses = expenses.map((row, i) => ({ line_no: i + 1, ...row }));
  const otherFees = Array.isArray(values.other_fees) ? values.other_fees as Array<Record<string, unknown>> : [];
  if (otherFees.length) patch.po_other_fees = otherFees.map((row, i) => ({ line_no: i + 1, ...row }));

  // 件名・発注日・税率・相手方。項目がテンプレートに無ければ何もしない（setIfField）。
  // title / counterparty / document_date は過去文書取込（import）が form_data に
  // 記録するキー。取り込んだ旧発注書からの引用でも件名・相手方・日付が入るようにする。
  setIfField(schema, patch, "projectTitle",
    values.PROJECT_TITLE ?? values.project_title ?? values.CONTRACT_TITLE ?? values.title);
  setIfField(schema, patch, "orderDate",
    values.ORDER_DATE ?? values.order_date ?? values.issue_date ?? values.DOCUMENT_DATE ?? values.document_date);
  setIfField(schema, patch, "taxRate", values.taxRate ?? values.tax_rate);
  for (const name of ["counterparty", "COUNTERPARTY_NAME", "相手方名称"]) {
    setIfField(schema, patch, name, values.vendor_name ?? values.VENDOR_NAME ?? values.counterparty);
  }
  // 支払予定日・支払条件・振込先は発注書から補完する（検収書フォームでは入力させない方針。
  // 変更があるときだけ支払予定日を上書きしてもらう）。
  setIfField(schema, patch, "paymentDueDate",
    values.summaryPaymentDate ?? values.PAYMENT_DATE ?? values.payment_date);
  setIfField(schema, patch, "paymentConditionSummary",
    values.PAYMENT_TERMS ?? values.summaryPaymentTerms ?? values.payment_terms);
  setIfField(schema, patch, "bankName", values.BANK_NAME ?? values.bank_name);
  setIfField(schema, patch, "branchName", values.BRANCH_NAME ?? values.branch_name);
  setIfField(schema, patch, "accountType", values.ACCOUNT_TYPE ?? values.account_type);
  setIfField(schema, patch, "accountNo", values.ACCOUNT_NUMBER ?? values.account_number);
  setIfField(schema, patch, "accountHolder",
    values.ACCOUNT_HOLDER_KANA ?? values.ACCOUNT_HOLDER ?? values.account_holder_kana);
}

function amountFromUnit(line: Record<string, unknown>): number {
  const quantity = Number(line.quantity ?? 0);
  const unitPrice = Number(line.unit_price ?? 0);
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return 0;
  return quantity * unitPrice;
}

function applyDocumentAliases(schema: DocumentFormSchema, patch: DocumentFormData, values: Record<string, unknown>) {
  const number = values.document_number;
  const title = values.CONTRACT_TITLE ?? values.基本契約名 ?? values.PROJECT_TITLE ?? number;
  for (const name of ["MASTER_CONTRACT_REF", "基本契約名"]) setIfField(schema, patch, name, title);
  for (const name of ["基本契約番号", "linked_contract_number", "parent_po_number"]) {
    setIfField(schema, patch, name, number);
  }
  // ORDER_NO は「親発注書番号」の意味で持つテンプレート（maintenance_spec）だけに書く。
  // 発注書の ORDER_NO は自分の発注番号なので、基本契約の番号を入れると PDF の
  // 発注番号がその契約番号に化ける。ラベルで役割を見分ける。
  const orderNo = schema.fields.find((field) => field.name === "ORDER_NO");
  if (orderNo && /親|基本契約/.test(`${orderNo.label ?? ""}`)) {
    setIfField(schema, patch, "ORDER_NO", number);
  }
  // 発注書は「基本契約あり」フラグで準拠契約の条項とスポット約款を出し分ける。
  // 契約を選んだのにフラグが立たないと、基本契約名だけ入って条項はスポット約款の
  // まま出ていた。フラグは表示項目なので、違っていれば外して確定できる。
  if (patch.MASTER_CONTRACT_REF) setIfField(schema, patch, "HAS_BASE_CONTRACT", true);
}

function applyWorkAliases(schema: DocumentFormSchema, patch: DocumentFormData, values: Record<string, unknown>) {
  const code = values.code;
  const title = values.title;
  for (const name of ["work_id", "WORK_ID", "台帳ID"]) setIfField(schema, patch, name, code);
  for (const name of ["原著作物名", "対象作品予定名", "対象製品予定名"]) setIfField(schema, patch, name, title);
}

// テンプレ固有の項目名に依存しない汎用対応（W4・NDA等）。
// グループ名/ラベルに「甲・取引先・許諾者…」を含む項目は相手方側、「乙・自社…」は自社側と判定し、
// ラベルの種別（名称/住所/代表者/担当/電話/メール）でマスタ値を差し込む。既に対応表で埋まった項目は触らない。
function applyPatternAliases(
  schema: DocumentFormSchema,
  patch: DocumentFormData,
  values: Record<string, unknown>,
  contextPattern: RegExp,
  rules: Array<[RegExp, string]>,
  excludePattern?: RegExp
) {
  for (const field of schema.fields) {
    if (field.name in patch) continue;
    const text = `${field.group ?? ""} ${field.name} ${field.label ?? ""}`.replace(/\s+/g, "");
    if (excludePattern?.test(text)) continue;
    // 職名・役職の欄に人名（代表者名）を入れない。
    if (/職名|役職|肩書/.test(text)) continue;
    if (!contextPattern.test(text)) continue;
    // ラベルに最初に当たった規則だけを使う。以前は「値が空なら次の規則へ」だったため、
    // 「代表者名称」のような欄で代表者名が空だと会社名が入っていた。役割はラベルで
    // 決まる。値が空ならその欄も空にする（前に引いた相手の値を残さない）。
    const rule = rules.find(([labelPattern]) => labelPattern.test(text));
    if (rule) setIfField(schema, patch, field.name, values[rule[1]]);
  }
}

function applyExistingFields(
  schema: DocumentFormSchema,
  patch: DocumentFormData,
  values: Record<string, unknown>,
  aliases: Record<string, string>
) {
  for (const [fieldName, sourceKey] of Object.entries(aliases)) {
    setIfField(schema, patch, fieldName, values[sourceKey]);
  }
}

// マスタの値をフォーム項目へ。
//   null（マスタに列はあるが空）は **空にする**。ここを「触らない」にしていたため、
//   マスタで担当部署・担当者名を消しても、フォームには前に引いた値が残り続けていた
//   （消したのに直らない、という報告の原因）。
//   undefined（マスタがその列を返していない）は触らない。口座情報のように権限で
//   返らない項目や、種別違いのマスタでは、消してよいか判断できない。
function setIfField(schema: DocumentFormSchema, patch: DocumentFormData, name: string, value: unknown) {
  if (value === undefined) return;
  if (!schema.fields.some((field) => field.name === name)) return;
  patch[name] = value === null ? "" : value;
}
