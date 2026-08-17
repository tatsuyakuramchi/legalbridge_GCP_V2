import { useEffect, useMemo, useState } from "react";
import type { DocumentFormData, DocumentFormSchema } from "../types";

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
      fetch(`/api/v2/master-data/search?type=${type}&q=${encodeURIComponent(query)}`, {
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
  }, [type, query]);

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
          {labels[candidate]}
        </button>)}
    </div>
    {type !== "company" &&
      <div className="master-search-row">
        <input className="master-search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={`${labels[type]}の名称または番号を入力`} />
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
  if (schema.fields.some((field) =>
    /作品|原著作物|素材|work_id|台帳ID/.test(`${field.name} ${field.label ?? ""}`))) {
    types.add("work");
  }
  return [...types];
}

export function buildPatch(schema: DocumentFormSchema, _formData: DocumentFormData, item: Item) {
  const patch: DocumentFormData = {};
  for (const field of schema.fields) {
    if (!field.dbField?.startsWith(`${item.type}.`)) continue;
    const sourceKey = field.dbField.slice(item.type.length + 1);
    if (item.values[sourceKey] !== undefined && item.values[sourceKey] !== null) {
      patch[field.name] = item.values[sourceKey];
    }
  }
  if (item.type === "vendor") {
    applyVendorAliases(schema, patch, item.values);
    // 「甲/乙」はテンプレごとに立場が入れ替わるため、単独では判定に使わない。
    // 相手方を示す語（取引先・売主・受託者…）がある項目のみ対象。自社を示す語があれば除外。
    applyPatternAliases(schema, patch, item.values,
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
  if (item.type === "document") applyDocumentAliases(schema, patch, item.values);
  if (item.type === "work") applyWorkAliases(schema, patch, item.values);
  return patch;
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
  if ("MASTER_CONTRACT_REF" in patch) setIfField(schema, patch, "HAS_BASE_CONTRACT", true);
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
    for (const [labelPattern, sourceKey] of rules) {
      const value = values[sourceKey];
      if (labelPattern.test(text) && value !== undefined && value !== null && value !== "") {
        patch[field.name] = value;
        break;
      }
    }
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

function setIfField(schema: DocumentFormSchema, patch: DocumentFormData, name: string, value: unknown) {
  if (schema.fields.some((field) => field.name === name) && value !== undefined && value !== null) {
    patch[name] = value;
  }
}
