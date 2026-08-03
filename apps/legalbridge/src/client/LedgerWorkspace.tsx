import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
type LedgerType = "vendors" | "works" | "conditions";
type Item = { id: string; type: LedgerType; code: string; title: string; subtitle: string; status?: string; updatedAt?: string; detail: Record<string, unknown> };
const labels: Record<LedgerType, string> = { vendors: "取引先", works: "作品・原作", conditions: "金銭条件" };

export function LedgerWorkspace({ initialType, initialQuery, selectedId, canEditVendors = false }:
  { initialType?: LedgerType; initialQuery?: string; selectedId?: string; canEditVendors?: boolean }) {
  const [type, setType] = useState<LedgerType>(initialType ?? "vendors");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingVendorId, setEditingVendorId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (initialType) setType(initialType);
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialType, initialQuery]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setSelected(null); setCreating(false); setEditingVendorId(null);
      setError("");
      fetch(`/api/v2/ledgers/${type}?q=${encodeURIComponent(query)}&limit=200`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setItems(data.items ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("台帳を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [type, query, reload]);
  useEffect(() => {
    if (!selectedId) return;
    const item = items.find((candidate) => candidate.id === selectedId);
    if (item) setSelected(item);
  }, [items, selectedId]);
  const canCreate = type === "vendors" && canEditVendors;
  return <section className="page ledger-page">
    <div className="page-title"><div><p>MASTER LEDGERS</p><h1>台帳</h1><small>既存マスターと契約条件を横断確認します</small></div>
      {canCreate && <button className="primary" onClick={() => { setCreating(true); setSelected(null); }}>＋ 新規取引先</button>}
    </div>
    <div className="ledger-tabs">{(Object.keys(labels) as LedgerType[]).map((key) =>
      <button className={type === key ? "active" : ""} key={key} onClick={() => { setType(key); setQuery(""); }}>{labels[key]}</button>)}</div>
    <div className="ledger-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)}
      placeholder={`${labels[type]}を名称・コード・文書番号で検索`} /><span>{loading ? "検索中…" : `${items.length}件`}</span></div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    <div className="ledger-layout">
      <div className="ledger-list">{items.map((item) => <button key={item.id}
        className={selected?.id === item.id ? "selected" : ""} onClick={() => { setCreating(false); setSelected(item); }}>
        <span>{item.code}</span><strong>{item.title}</strong><small>{item.subtitle || "—"}</small>
      </button>)}{!loading && !items.length && <div className="empty-state">該当するデータがありません。</div>}</div>
      {creating
        ? <VendorForm onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); setReload((v) => v + 1); }} />
        : editingVendorId !== null
          ? <VendorForm vendorId={editingVendorId} onCancel={() => setEditingVendorId(null)} onSaved={() => { setEditingVendorId(null); setReload((v) => v + 1); }} />
          : <LedgerDetail item={selected} canEdit={canCreate}
              onEdit={(item) => { setEditingVendorId(Number(item.id)); }} />}
    </div>
  </section>;
}

function LedgerDetail({ item, canEdit = false, onEdit }:
  { item: Item | null; canEdit?: boolean; onEdit?: (item: Item) => void }) {
  if (!item) return <aside className="panel ledger-detail empty-detail">一覧から項目を選択してください。</aside>;
  const entries = Object.entries(item.detail).filter(([, value]) => value !== null && value !== "");
  return <aside className="panel ledger-detail">
    <div className="matter-detail-head"><span className="detail-kicker">LEDGER DETAIL</span>
      {canEdit && onEdit && <button onClick={() => onEdit(item)}>編集</button>}</div>
    <h2>{item.title}</h2><p>{item.code}　{item.subtitle}</p>
    <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "boolean" ? (value ? "はい" : "いいえ") : String(value)}</dd></div>)}</dl>
    <small className="mask-note">口座情報は表示しません。電話番号・メールアドレスはマスキングされています。</small>
  </aside>;
}

type VendorValues = {
  vendorName: string; vendorCode: string; tradeName: string; penName: string; entityType: string;
  email: string; phone: string; contactName: string; contactDepartment: string; address: string;
  invoiceRegistrationNumber: string; isInvoiceIssuer: boolean; withholdingEnabled: boolean;
};
const emptyVendor: VendorValues = {
  vendorName: "", vendorCode: "", tradeName: "", penName: "", entityType: "",
  email: "", phone: "", contactName: "", contactDepartment: "", address: "",
  invoiceRegistrationNumber: "", isInvoiceIssuer: false, withholdingEnabled: false
};

function VendorForm({ vendorId, onCancel, onSaved }: { vendorId?: number; onCancel: () => void; onSaved: () => void }) {
  const isEdit = vendorId !== undefined;
  const [values, setValues] = useState<VendorValues>(emptyVendor);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    fetch(`/api/v2/vendors/${vendorId}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        const v = data.vendor;
        setValues({
          vendorName: v.vendorName ?? "", vendorCode: v.vendorCode ?? "", tradeName: v.tradeName ?? "",
          penName: v.penName ?? "", entityType: v.entityType ?? "", email: v.email ?? "", phone: v.phone ?? "",
          contactName: v.contactName ?? "", contactDepartment: v.contactDepartment ?? "", address: v.address ?? "",
          invoiceRegistrationNumber: v.invoiceRegistrationNumber ?? "",
          isInvoiceIssuer: Boolean(v.isInvoiceIssuer), withholdingEnabled: Boolean(v.withholdingEnabled)
        });
      })
      .catch(() => setError("取引先の情報を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, [vendorId, isEdit]);
  function set<K extends keyof VendorValues>(key: K, value: VendorValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }
  async function submit() {
    if (!values.vendorName.trim()) { setError("取引先名は必須です。"); return; }
    setSaving(true); setError("");
    const body: Record<string, unknown> = {
      vendorName: values.vendorName.trim(),
      tradeName: values.tradeName, penName: values.penName, entityType: values.entityType,
      email: values.email, phone: values.phone, contactName: values.contactName,
      contactDepartment: values.contactDepartment, address: values.address,
      invoiceRegistrationNumber: values.invoiceRegistrationNumber,
      isInvoiceIssuer: values.isInvoiceIssuer, withholdingEnabled: values.withholdingEnabled
    };
    if (values.vendorCode.trim()) body.vendorCode = values.vendorCode.trim();
    try {
      const response = await fetch(isEdit ? `/api/v2/vendors/${vendorId}` : "/api/v2/vendors", {
        method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error ?? "保存に失敗しました。"); setSaving(false); return;
      }
      const saved = await response.json();
      toast.push(isEdit ? "取引先を更新しました" : `取引先を登録しました（${saved.vendorCode ?? ""}）`, "success");
      onSaved();
    } catch {
      setError("通信に失敗しました。"); setSaving(false);
    }
  }
  if (loading) return <aside className="panel ledger-detail"><div className="empty-inline">読み込み中…</div></aside>;
  return <aside className="panel ledger-detail matter-editor">
    <span className="detail-kicker">{isEdit ? "EDIT VENDOR" : "NEW VENDOR"}</span><h2>{isEdit ? "取引先を編集" : "新規取引先"}</h2>
    {error && <div className="async-error">{error}</div>}
    <label>取引先名 *<input value={values.vendorName} onChange={(e) => set("vendorName", e.target.value)} /></label>
    <div className="matter-form-grid">
      <label>取引先コード<input value={values.vendorCode} onChange={(e) => set("vendorCode", e.target.value)} placeholder="未入力で自動採番" /></label>
      <label>種別<input value={values.entityType} onChange={(e) => set("entityType", e.target.value)} placeholder="法人 / 個人 等" /></label>
      <label>屋号<input value={values.tradeName} onChange={(e) => set("tradeName", e.target.value)} /></label>
      <label>ペンネーム<input value={values.penName} onChange={(e) => set("penName", e.target.value)} /></label>
      <label>担当者<input value={values.contactName} onChange={(e) => set("contactName", e.target.value)} /></label>
      <label>担当部署<input value={values.contactDepartment} onChange={(e) => set("contactDepartment", e.target.value)} /></label>
      <label>メール<input value={values.email} onChange={(e) => set("email", e.target.value)} /></label>
      <label>電話<input value={values.phone} onChange={(e) => set("phone", e.target.value)} /></label>
      <label>インボイス番号<input value={values.invoiceRegistrationNumber} onChange={(e) => set("invoiceRegistrationNumber", e.target.value)} /></label>
    </div>
    <label>住所<input value={values.address} onChange={(e) => set("address", e.target.value)} /></label>
    <label className="task-primary-toggle"><input type="checkbox" checked={values.isInvoiceIssuer} onChange={(e) => set("isInvoiceIssuer", e.target.checked)} />インボイス発行事業者</label>
    <label className="task-primary-toggle"><input type="checkbox" checked={values.withholdingEnabled} onChange={(e) => set("withholdingEnabled", e.target.checked)} />源泉徴収対象</label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : isEdit ? "保存" : "登録"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}
