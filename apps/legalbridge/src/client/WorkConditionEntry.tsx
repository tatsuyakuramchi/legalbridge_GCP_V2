import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentFormData } from "../types";
import { useToast } from "./Toast";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import { ArrayEditor } from "./SpecializedDocumentForms";
import { importedConditionFields } from "./DocumentRegistry";
import type { FieldDefinition } from "./document-line-fields";
import { DocQuotePicker } from "./WorkIntake";
import { INTAKE_DOC_KINDS } from "./work-intake";

// 作品の条件登録（正の動線・2026-09-03）。作品を起点に
//   ① 文書を選ぶ（この作品に紐づく文書／アップロード／システム内の文書を紐づける）
//   ② その文書の条件明細を入力（素材はこの作品の素材から選ぶ・向きは文書種別から既定）
//   ③ 保存＝文書の form_data へ保存 → 条件同期（work_id つき）→ 作品の条件・料率に即反映
// 旧動線（文書一覧→過去文書取込→詳細を編集→条件明細、素材コード手入力）を置き換える。
// 確定済み（生成）文書の条件は確定時に同期済みのため、ここでは状況表示と導線のみ。

type WorkDoc = {
  id: number; documentNumber: string | null; templateType: string | null;
  templateVersionId: number | null; title: string | null; counterparty: string | null;
  supersededBy: string | null; conditionCount: number;
};
type Material = { id: number; materialCode: string | null; materialName: string | null; materialRole: string | null };

const DOC_KIND_LABELS: Record<string, string> = {
  ...Object.fromEntries(INTAKE_DOC_KINDS.map((k) => [k.value, k.label])),
  individual_license_terms_v3: "個別利用許諾条件書", royalty_statement: "利用許諾料計算書",
  inspection_certificate: "検収書", license_out_en: "ライセンスアウト契約（英文）"
};
// 文書種別から向きの既定を決める。当社が許諾する（受け取る）文書だけアウト。
function defaultFlow(templateType: string | null): "in" | "out" {
  return /license_out|outbound/.test(templateType ?? "") ? "out" : "in";
}

export function WorkConditionEntry({ workId, initialDocumentId = null, onBack, onAddGrant }: {
  workId: number;
  initialDocumentId?: number | null;
  onBack: () => void;
  onAddGrant?: (workId: number) => void;
}) {
  const toast = useToast();
  const [work, setWork] = useState<{ workCode: string | null; title: string; materials: Material[] } | null>(null);
  const [docs, setDocs] = useState<WorkDoc[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WorkDoc | null>(null);
  const [formData, setFormData] = useState<DocumentFormData | null>(null);
  const [counterpartyVendorId, setCounterpartyVendorId] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadMeta, setUploadMeta] = useState({ templateType: "purchase_order", docNumber: "", date: "" });
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  async function loadWork() {
    const response = await fetch(`/api/v2/works/${workId}/detail`);
    if (!response.ok) { setError("作品を読み込めませんでした"); return; }
    const detail = await response.json();
    setWork({
      workCode: detail.work?.workCode ?? null, title: String(detail.work?.title ?? ""),
      materials: (detail.materials ?? []).map((m: Record<string, unknown>) => ({
        id: Number(m.id), materialCode: (m.materialCode as string | null) ?? null,
        materialName: (m.materialName as string | null) ?? null, materialRole: (m.materialRole as string | null) ?? null
      }))
    });
  }
  async function loadDocs() {
    const response = await fetch(`/api/v2/works/${workId}/documents`);
    if (!response.ok) return;
    const data = await response.json();
    setDocs(data.documents ?? []);
  }
  useEffect(() => { void loadWork(); void loadDocs(); }, [workId]);
  // 作品登録の完了帯・一括編集から文書指定で来たときは、その文書の入力へ直行。
  useEffect(() => {
    if (initialDocumentId == null || selected) return;
    const doc = docs.find((d) => d.id === initialDocumentId);
    if (doc && doc.templateVersionId == null) void openDoc(doc);
  }, [docs, initialDocumentId]);

  async function openDoc(doc: WorkDoc) {
    setError("");
    const response = await fetch(`/api/v2/documents/${doc.id}`);
    if (!response.ok) { setError("文書を読み込めませんでした"); return; }
    const data = await response.json();
    const current = (data.document?.formData ?? {}) as DocumentFormData;
    setFormData({
      ...current,
      flow_direction: current.flow_direction ?? defaultFlow(doc.templateType)
    });
    setCounterpartyVendorId(undefined);
    setSelected(doc);
  }

  // 素材の選択肢（この作品の素材だけ。原作を先頭に）。
  const conditionFields: FieldDefinition[] = useMemo(() => {
    const materials = [...(work?.materials ?? [])].sort((a, b) =>
      (a.materialRole === "core_logic" ? 0 : 1) - (b.materialRole === "core_logic" ? 0 : 1));
    return importedConditionFields.map((field) => field.name === "material_code"
      ? {
        name: "material_code", label: "対象素材（この作品の素材から選択）", type: "select" as const,
        options: [
          { value: "", label: "文書全体（素材を特定しない）" },
          ...materials.filter((m) => m.materialCode).map((m) => ({
            value: m.materialCode as string,
            label: `${m.materialRole === "core_logic" ? "★原作 " : ""}${m.materialName ?? ""}（${m.materialCode}）`
          }))
        ],
        helpText: "素材を選ぶと料率対象・権利マトリクスに載ります。加算型は同じグループ番号でΣ合算"
      }
      : field);
  }, [work]);

  async function save() {
    if (!selected || !formData || !work) return;
    setSaving(true); setError("");
    try {
      // 先に作品へ紐づけ（未紐づけの文書でも条件同期が work_id を解決できるように・冪等）。
      if (work.workCode) {
        await fetch(`/api/v2/documents/${selected.id}/work-link`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workCode: work.workCode })
        });
      }
      const response = await fetch(`/api/v2/documents/${selected.id}/import-details`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formData, ...(counterpartyVendorId !== undefined ? { counterpartyVendorId } : {}) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error ?? "保存に失敗しました"); return; }
      if (data.conditionSyncWarning) toast.push(`保存しました。⚠ ${data.conditionSyncWarning}`, "info");
      else toast.push(`${selected.documentNumber ?? selected.id} の条件明細 ${data.conditionSync?.written ?? 0}件を作品「${work.title}」の台帳へ登録しました`, "success");
      setSelected(null); setFormData(null);
      await loadDocs();
    } catch { setError("通信に失敗しました"); }
    finally { setSaving(false); }
  }

  async function upload() {
    if (!pendingFile || !work?.workCode) return;
    if (!uploadMeta.docNumber.trim()) { toast.push("文書番号を入力してください", "error"); return; }
    setSaving(true);
    try {
      const form = new FormData();
      form.append("file", pendingFile);
      form.append("originalName", pendingFile.name);
      form.append("documentNumber", uploadMeta.docNumber.trim());
      form.append("templateType", uploadMeta.templateType);
      form.append("title", pendingFile.name.replace(/\.[A-Za-z0-9]{1,8}$/, ""));
      if (uploadMeta.date) form.append("documentDate", uploadMeta.date);
      form.append("workCode", work.workCode);
      const response = await fetch("/api/v2/documents/import/upload", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "アップロードに失敗しました", "error"); return; }
      toast.push(`${uploadMeta.docNumber.trim()} を登録しました。続けて条件を入力してください`, "success");
      setPendingFile(null); setUploadMeta({ templateType: "purchase_order", docNumber: "", date: "" });
      await loadDocs();
      const created = Number(data.document?.id);
      if (created) {
        void openDoc({
          id: created, documentNumber: uploadMeta.docNumber.trim(), templateType: uploadMeta.templateType,
          templateVersionId: null, title: null, counterparty: null, supersededBy: null, conditionCount: 0
        });
      }
    } catch { toast.push("通信に失敗しました", "error"); }
    finally { setSaving(false); }
  }

  async function linkExisting(hit: { id: number; documentNumber: string } | null) {
    if (!hit || !work?.workCode) return;
    const response = await fetch(`/api/v2/documents/${hit.id}/work-link`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workCode: work.workCode })
    });
    if (!response.ok) { toast.push("紐づけに失敗しました", "error"); return; }
    toast.push(`${hit.documentNumber} をこの作品に紐づけました`, "success");
    await loadDocs();
  }

  const flow = String(formData?.flow_direction ?? "in");
  const rows = Array.isArray(formData?.financial_conditions) ? formData!.financial_conditions as Array<Record<string, unknown>> : [];

  return <section className="page wce">
    <div className="page-title"><div>
      <p>WORK CONDITIONS</p>
      <h1>作品の条件登録{work ? ` — ${work.workCode ?? ""} ${work.title}` : ""}</h1>
      <small>作品を起点に、契約書・発注書ごとの条件（料率・MG/AG・支払）を登録します。保存すると条件台帳へ同期され、作品の「条件・料率」に載ります。</small>
    </div><div className="matter-detail-actions"><button onClick={onBack}>作品に戻る</button></div></div>
    {error && <div className="async-error">{error}</div>}

    {!selected && <>
      <div className="panel wce-card">
        <div className="wce-head"><span className="wi-step">①</span><h2>条件を入れる文書を選ぶ</h2>
          <small>イン条件（当社が支払う）＝発注書・個別条件書・利用許諾契約。アウト（当社が受け取る）＝ライセンスアウト契約</small></div>
        {docs.length === 0 && <p className="wz-hint">この作品に紐づく文書はまだありません。下からアップロードするか、システム内の文書を紐づけてください。</p>}
        {docs.length > 0 && <ul className="wce-docs">
          {docs.map((doc) => <li key={doc.id} className={doc.supersededBy ? "old" : ""}>
            <b>{doc.documentNumber ?? `#${doc.id}`}</b>
            <span>{DOC_KIND_LABELS[doc.templateType ?? ""] ?? doc.templateType ?? "—"}</span>
            <span className="wz-doctitle">{doc.title ?? ""}{doc.counterparty ? `／${doc.counterparty}` : ""}</span>
            {doc.supersededBy
              ? <span className="wz-tag">旧版（→ {doc.supersededBy}）・条件は無効</span>
              : doc.conditionCount > 0
                ? <span className="wz-tag eff">条件 {doc.conditionCount}件</span>
                : <span className="wz-tag warn">条件未登録</span>}
            <span className="wi-spacer"></span>
            {!doc.supersededBy && doc.templateVersionId == null &&
              <button type="button" className="primary" onClick={() => void openDoc(doc)}>
                {doc.conditionCount > 0 ? "条件を編集" : "条件を入力"}</button>}
            {!doc.supersededBy && doc.templateVersionId != null &&
              <small className="wce-note">確定済み文書 — 条件は確定時に台帳へ同期済み。変更は「特例編集（再発行）」
                {doc.conditionCount === 0 && onAddGrant && <> ／ <button type="button" className="link-button" onClick={() => onAddGrant(workId)}>アウト条件を追記</button></>}</small>}
          </li>)}
        </ul>}
      </div>

      <div className="panel wce-card">
        <div className="wce-head"><h2>文書がまだ無いとき</h2></div>
        <div className="wce-two">
          <div>
            <strong>契約書・発注書をアップロード</strong>
            <input ref={fileInput} type="file" style={{ display: "none" }}
              onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)} />
            <div className="wz-next">
              <button type="button" onClick={() => fileInput.current?.click()}>ファイルを選択</button>
              <small>{pendingFile ? pendingFile.name : "PDF等・30MBまで"}</small>
            </div>
            {pendingFile && <div className="wi-grid">
              <label>種別<select value={uploadMeta.templateType} onChange={(e) => setUploadMeta({ ...uploadMeta, templateType: e.target.value })}>
                {INTAKE_DOC_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select></label>
              <label>文書番号 *<input value={uploadMeta.docNumber} onChange={(e) => setUploadMeta({ ...uploadMeta, docNumber: e.target.value })} placeholder="例: PO-2025-0083" /></label>
              <label>締結日<input type="date" value={uploadMeta.date} onChange={(e) => setUploadMeta({ ...uploadMeta, date: e.target.value })} /></label>
              <div className="wz-next"><button type="button" className="primary" disabled={saving} onClick={() => void upload()}>アップロードして条件入力へ</button></div>
            </div>}
          </div>
          <div>
            <strong>システム内の文書を紐づける</strong>
            <DocQuotePicker note="確定済み文書・取込済みの過去文書を検索して紐づける" quoteNumber="" onPick={(hit) => void linkExisting(hit)} />
          </div>
        </div>
      </div>
    </>}

    {selected && formData && <div className="panel wce-card">
      <div className="wce-head"><span className="wi-step">②</span>
        <h2>{selected.documentNumber ?? selected.id} の条件明細</h2>
        <small>{DOC_KIND_LABELS[selected.templateType ?? ""] ?? selected.templateType}</small>
        <span className="wi-spacer"></span>
        <button type="button" onClick={() => { setSelected(null); setFormData(null); }}>文書の選択に戻る</button>
      </div>
      <div className="wi-grid">
        <label>この契約の向き<select value={flow} onChange={(e) => setFormData({ ...formData, flow_direction: e.target.value })}>
          <option value="in">イン（許諾を受ける＝当社が支払う）</option>
          <option value="out">アウト（許諾する＝当社が受け取る）</option>
        </select></label>
        <SearchableLedgerSelect type="vendors" value={counterpartyVendorId != null ? String(counterpartyVendorId) : ""}
          label="相手先（取引先マスタ）" placeholder="名称・コードで検索…"
          helper={`現在: ${String(formData.counterparty ?? "") || "未設定"}`}
          onChange={(value, item) => {
            setCounterpartyVendorId(value ? Number(value) : undefined);
            if (item) setFormData({ ...formData, counterparty: item.title });
          }} />
      </div>
      <ArrayEditor title="条件" itemLabel="条件" dataKey="financial_conditions" rows={rows}
        fields={conditionFields} defaultRow={{ currency: "JPY", guarantee_type: "NONE" }}
        onChange={(name, value) => setFormData({ ...formData, [name]: value })} />
      <p className="wz-hint">保存すると条件台帳へ同期され、作品「{work?.title}」の条件・料率に載ります（文書のPDFは変わりません）。加算型は原作＋素材を同じグループ番号にするとΣが適用料率になります。</p>
      <div className="wz-next">
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "条件を保存して台帳へ登録"}</button>
        <button type="button" onClick={() => { setSelected(null); setFormData(null); }}>キャンセル</button>
      </div>
    </div>}
  </section>;
}
