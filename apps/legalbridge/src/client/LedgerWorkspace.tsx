import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { CsvImport, vendorCsvConfig, workCsvConfig, materialCsvConfig } from "./CsvImport";
type LedgerType = "vendors" | "works" | "materials" | "conditions";
type Item = { id: string; type: LedgerType; code: string; title: string; subtitle: string; status?: string; updatedAt?: string; detail: Record<string, unknown> };
const labels: Record<LedgerType, string> = { vendors: "取引先", works: "作品・原作", materials: "原作マテリアル", conditions: "金銭条件" };

export function LedgerWorkspace({ initialType, initialQuery, selectedId, canEditVendors = false, canEditWorks = false, canEditMaterials = false, onNavigate }:
  { initialType?: LedgerType; initialQuery?: string; selectedId?: string; canEditVendors?: boolean; canEditWorks?: boolean; canEditMaterials?: boolean; onNavigate?: (target: string) => void }) {
  const [type, setType] = useState<LedgerType>(initialType ?? "vendors");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingVendorId, setEditingVendorId] = useState<number | null>(null);
  const [editingWorkId, setEditingWorkId] = useState<number | null>(null);
  const [editingMaterialId, setEditingMaterialId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
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
      setLoading(true); setSelected(null); setCreating(false); setEditingVendorId(null); setEditingWorkId(null); setEditingMaterialId(null); setImporting(false);
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
  const canCreateVendor = type === "vendors" && canEditVendors;
  const canCreateWork = type === "works" && canEditWorks;
  const canCreateMaterial = type === "materials" && canEditMaterials;
  const canCreate = canCreateVendor || canCreateWork || canCreateMaterial;
  return <section className="page ledger-page">
    <div className="page-title"><div><p>MASTER LEDGERS</p><h1>台帳</h1><small>既存マスターと契約条件を横断確認します</small></div>
      {canCreateVendor && <div className="matter-detail-actions">
        <button onClick={() => { setImporting(true); setCreating(false); setSelected(null); }}>CSV取込</button>
        <button className="primary" onClick={() => { setCreating(true); setImporting(false); setSelected(null); }}>＋ 新規取引先</button>
      </div>}
      {canCreateWork && <div className="matter-detail-actions">
        <button onClick={() => { setImporting(true); setCreating(false); setSelected(null); }}>CSV取込</button>
        <button className="primary" onClick={() => { setCreating(true); setImporting(false); setSelected(null); }}>＋ 新規作品</button>
      </div>}
      {canCreateMaterial && <div className="matter-detail-actions">
        <button onClick={() => { setImporting(true); setCreating(false); setSelected(null); }}>CSV取込</button>
        <button className="primary" onClick={() => { setCreating(true); setImporting(false); setSelected(null); }}>＋ 新規マテリアル</button>
      </div>}
    </div>
    {onNavigate && type === "works" && <div className="surface-xref" role="navigation" aria-label="作品の関連画面">
      <span className="surface-xref-here">マスタ編集（ここ）</span>
      <button type="button" onClick={() => onNavigate("works")}>作品ビュー → 作品（系譜・条件）</button>
    </div>}
    <div className="ledger-tabs">{(Object.keys(labels) as LedgerType[]).map((key) =>
      <button className={type === key ? "active" : ""} key={key} onClick={() => { setType(key); setQuery(""); }}>{labels[key]}</button>)}</div>
    <div className="ledger-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)}
      placeholder={`${labels[type]}を名称・コード・文書番号で検索`} /><span>{loading ? "検索中…" : `${items.length}件`}</span></div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    <div className="ledger-layout">
      <div className="ledger-list">{items.map((item) => <button key={item.id}
        className={selected?.id === item.id ? "selected" : ""} onClick={() => { setCreating(false); setSelected(item); }}>
        <span>{item.code}</span><strong>{item.title}</strong><small>{item.subtitle || "—"}</small>
      </button>)}{!loading && !items.length && <EmptyState compact icon="▤" title="該当するデータがありません" />}</div>
      {importing
        ? <CsvImport config={type === "works" ? workCsvConfig : type === "materials" ? materialCsvConfig : vendorCsvConfig}
            onCancel={() => setImporting(false)} onDone={() => setReload((v) => v + 1)} />
        : creating && type === "materials"
        ? <MaterialForm onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); setReload((v) => v + 1); }} />
        : creating && type === "works"
        ? <WorkForm onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); setReload((v) => v + 1); }} />
        : creating
        ? <VendorForm onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); setReload((v) => v + 1); }} />
        : editingVendorId !== null
        ? <VendorForm vendorId={editingVendorId} onCancel={() => setEditingVendorId(null)} onSaved={() => { setEditingVendorId(null); setReload((v) => v + 1); }} />
        : editingWorkId !== null
        ? <WorkForm workId={editingWorkId} onCancel={() => setEditingWorkId(null)} onSaved={() => { setEditingWorkId(null); setReload((v) => v + 1); }} />
        : editingMaterialId !== null
          ? <MaterialForm materialId={editingMaterialId} onCancel={() => setEditingMaterialId(null)} onSaved={() => { setEditingMaterialId(null); setReload((v) => v + 1); }} />
          : <LedgerDetail item={selected} canEdit={canCreate}
              onEdit={(item) => { if (type === "works") setEditingWorkId(Number(item.id)); else if (type === "materials") setEditingMaterialId(Number(item.id)); else setEditingVendorId(Number(item.id)); }} />}
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
  invoiceRegistrationNumber: string; isInvoiceIssuer: boolean; withholdingEnabled: boolean; isActive: boolean;
};
const emptyVendor: VendorValues = {
  vendorName: "", vendorCode: "", tradeName: "", penName: "", entityType: "",
  email: "", phone: "", contactName: "", contactDepartment: "", address: "",
  invoiceRegistrationNumber: "", isInvoiceIssuer: false, withholdingEnabled: false, isActive: true
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
          isInvoiceIssuer: Boolean(v.isInvoiceIssuer), withholdingEnabled: Boolean(v.withholdingEnabled),
          isActive: v.isActive !== false
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
      isInvoiceIssuer: values.isInvoiceIssuer, withholdingEnabled: values.withholdingEnabled,
      isActive: values.isActive
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
    <label className="task-primary-toggle"><input type="checkbox" checked={values.isActive} onChange={(e) => set("isActive", e.target.checked)} />有効（オフで無効化＝台帳の既定検索から除外）</label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : isEdit ? "保存" : "登録"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}

type WorkValues = { title: string; workCode: string; ledgerCode: string; remarks: string; isActive: boolean };
const emptyWork: WorkValues = { title: "", workCode: "", ledgerCode: "", remarks: "", isActive: true };

function WorkForm({ workId, onCancel, onSaved }: { workId?: number; onCancel: () => void; onSaved: () => void }) {
  const isEdit = workId !== undefined;
  const [values, setValues] = useState<WorkValues>(emptyWork);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    fetch(`/api/v2/works/${workId}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        const w = data.work;
        setValues({ title: w.title ?? "", workCode: w.workCode ?? "", ledgerCode: w.ledgerCode ?? "", remarks: w.remarks ?? "", isActive: Boolean(w.isActive) });
      })
      .catch(() => setError("作品の情報を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, [workId, isEdit]);
  function set<K extends keyof WorkValues>(key: K, value: WorkValues[K]) { setValues((prev) => ({ ...prev, [key]: value })); }
  async function submit() {
    if (!values.title.trim()) { setError("作品名は必須です。"); return; }
    setSaving(true); setError("");
    const body: Record<string, unknown> = {
      title: values.title.trim(), ledgerCode: values.ledgerCode, remarks: values.remarks, isActive: values.isActive
    };
    if (values.workCode.trim()) body.workCode = values.workCode.trim();
    try {
      const response = await fetch(isEdit ? `/api/v2/works/${workId}` : "/api/v2/works", {
        method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error ?? "保存に失敗しました。"); setSaving(false); return;
      }
      const saved = await response.json();
      toast.push(isEdit ? "作品を更新しました" : `作品を登録しました（${saved.workCode ?? ""}）`, "success");
      onSaved();
    } catch { setError("通信に失敗しました。"); setSaving(false); }
  }
  if (loading) return <aside className="panel ledger-detail"><div className="empty-inline">読み込み中…</div></aside>;
  return <aside className="panel ledger-detail matter-editor">
    <span className="detail-kicker">{isEdit ? "EDIT WORK" : "NEW WORK"}</span><h2>{isEdit ? "作品を編集" : "新規作品"}</h2>
    {error && <div className="async-error">{error}</div>}
    <label>作品名 *<input value={values.title} onChange={(e) => set("title", e.target.value)} /></label>
    <div className="matter-form-grid">
      <label>作品コード<input value={values.workCode} onChange={(e) => set("workCode", e.target.value)} placeholder="未入力で自動採番" /></label>
      <label>台帳コード<input value={values.ledgerCode} onChange={(e) => set("ledgerCode", e.target.value)} /></label>
    </div>
    <label>備考<textarea rows={3} value={values.remarks} onChange={(e) => set("remarks", e.target.value)} /></label>
    <label className="task-primary-toggle"><input type="checkbox" checked={values.isActive} onChange={(e) => set("isActive", e.target.checked)} />有効</label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : isEdit ? "保存" : "登録"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}

const materialTypeOptions = [
  { value: "manuscript", label: "原稿" }, { value: "scenario", label: "シナリオ" },
  { value: "illustration", label: "イラスト" }, { value: "game_design", label: "ゲームデザイン" },
  { value: "other", label: "その他" }
];
const materialRoleOptions = [
  { value: "core_logic", label: "中核" }, { value: "sub_component", label: "補助" }
];
const acquisitionTypeOptions = [
  { value: "license", label: "ライセンス" }, { value: "buyout_commission", label: "買切・委託" },
  { value: "in_house", label: "内製" }
];
const rightsTypeOptions = [
  { value: "license", label: "ライセンス" }, { value: "owned", label: "自社保有" }
];
type MaterialValues = {
  materialName: string; materialType: string; materialRole: string; acquisitionType: string;
  rightsType: string; rightsHolderLabel: string; territory: string; language: string;
  isDefault: boolean; isRoyaltyBearing: boolean; remarks: string;
};
const emptyMaterial: MaterialValues = {
  materialName: "", materialType: "manuscript", materialRole: "core_logic", acquisitionType: "license",
  rightsType: "license", rightsHolderLabel: "", territory: "", language: "",
  isDefault: false, isRoyaltyBearing: false, remarks: ""
};

function MaterialForm({ materialId, onCancel, onSaved }: { materialId?: number; onCancel: () => void; onSaved: () => void }) {
  const isEdit = materialId !== undefined;
  const [values, setValues] = useState<MaterialValues>(emptyMaterial);
  const [workId, setWorkId] = useState<number | null>(null);
  const [workLabel, setWorkLabel] = useState("");
  const [workQuery, setWorkQuery] = useState("");
  const [workOptions, setWorkOptions] = useState<{ id: number; workCode: string | null; title: string }[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    fetch(`/api/v2/materials/${materialId}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        const m = data.material;
        setWorkId(Number(m.workId));
        setWorkLabel([m.workCode, m.workTitle].filter(Boolean).join(" ") || `作品 ${m.workId}`);
        setValues({
          materialName: m.materialName ?? "", materialType: m.materialType ?? "manuscript",
          materialRole: m.materialRole ?? "core_logic", acquisitionType: m.acquisitionType ?? "license",
          rightsType: m.rightsType ?? "license", rightsHolderLabel: m.rightsHolderLabel ?? "",
          territory: m.territory ?? "", language: m.language ?? "",
          isDefault: Boolean(m.isDefault), isRoyaltyBearing: Boolean(m.isRoyaltyBearing), remarks: m.remarks ?? ""
        });
      })
      .catch(() => setError("素材の情報を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, [materialId, isEdit]);
  useEffect(() => {
    if (isEdit) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/v2/materials/works?q=${encodeURIComponent(workQuery)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setWorkOptions(data.works ?? []))
        .catch(() => undefined);
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [workQuery, isEdit]);
  function set<K extends keyof MaterialValues>(key: K, value: MaterialValues[K]) { setValues((prev) => ({ ...prev, [key]: value })); }
  async function submit() {
    if (!isEdit && workId === null) { setError("作品を選択してください。"); return; }
    if (!values.materialName.trim()) { setError("素材名は必須です。"); return; }
    setSaving(true); setError("");
    const body: Record<string, unknown> = {
      materialName: values.materialName.trim(), materialRole: values.materialRole,
      acquisitionType: values.acquisitionType, rightsType: values.rightsType,
      rightsHolderLabel: values.rightsHolderLabel, territory: values.territory, language: values.language,
      isDefault: values.isDefault, isRoyaltyBearing: values.isRoyaltyBearing, remarks: values.remarks
    };
    if (!isEdit) { body.workId = workId; body.materialType = values.materialType; }
    try {
      const response = await fetch(isEdit ? `/api/v2/materials/${materialId}` : "/api/v2/materials", {
        method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error ?? "保存に失敗しました。"); setSaving(false); return;
      }
      const saved = await response.json();
      toast.push(isEdit ? "素材を更新しました" : `素材を登録しました（${saved.materialCode ?? ""}）`, "success");
      onSaved();
    } catch { setError("通信に失敗しました。"); setSaving(false); }
  }
  if (loading) return <aside className="panel ledger-detail"><div className="empty-inline">読み込み中…</div></aside>;
  return <aside className="panel ledger-detail matter-editor">
    <span className="detail-kicker">{isEdit ? "EDIT MATERIAL" : "NEW MATERIAL"}</span><h2>{isEdit ? "素材を編集" : "新規マテリアル"}</h2>
    {error && <div className="async-error">{error}</div>}
    {isEdit
      ? <label>所属作品<input value={workLabel} disabled /></label>
      : <label>所属作品 *
          <input value={workLabel || workQuery} placeholder="作品名・コードで検索"
            onChange={(e) => { setWorkQuery(e.target.value); setWorkLabel(""); setWorkId(null); }} />
          {!workId && workOptions.length > 0 && <div className="ledger-list work-picker">{workOptions.map((w) =>
            <button key={w.id} onClick={() => { setWorkId(w.id); setWorkLabel([w.workCode, w.title].filter(Boolean).join(" ")); setWorkOptions([]); }}>
              <span>{w.workCode ?? "—"}</span><strong>{w.title}</strong></button>)}</div>}
        </label>}
    <label>素材名 *<input value={values.materialName} onChange={(e) => set("materialName", e.target.value)} /></label>
    <div className="matter-form-grid">
      <label>素材区分{isEdit ? "（変更不可）" : ""}
        <select value={values.materialType} disabled={isEdit} onChange={(e) => set("materialType", e.target.value)}>
          {materialTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>構成上の役割<select value={values.materialRole} onChange={(e) => set("materialRole", e.target.value)}>
        {materialRoleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>取得区分<select value={values.acquisitionType} onChange={(e) => set("acquisitionType", e.target.value)}>
        {acquisitionTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>権利区分<select value={values.rightsType} onChange={(e) => set("rightsType", e.target.value)}>
        {rightsTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>権利者表記<input value={values.rightsHolderLabel} onChange={(e) => set("rightsHolderLabel", e.target.value)} /></label>
      <label>地域<input value={values.territory} onChange={(e) => set("territory", e.target.value)} /></label>
      <label>言語<input value={values.language} onChange={(e) => set("language", e.target.value)} /></label>
    </div>
    <label>備考<textarea rows={3} value={values.remarks} onChange={(e) => set("remarks", e.target.value)} /></label>
    <label className="task-primary-toggle"><input type="checkbox" checked={values.isDefault} onChange={(e) => set("isDefault", e.target.checked)} />代表素材</label>
    <label className="task-primary-toggle"><input type="checkbox" checked={values.isRoyaltyBearing} onChange={(e) => set("isRoyaltyBearing", e.target.checked)} />ロイヤリティ対象</label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : isEdit ? "保存" : "登録"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}
