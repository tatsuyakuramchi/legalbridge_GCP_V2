import { useEffect, useState } from "react";
import { checkWorkConditions, summarizeFindings } from "./contract-check";

// 作品詳細（Phase 2・読み取り専用）。作品を起点に 概要/系譜/素材/条件/権利ソース/
// 料率対象 を一望する。作品ピッカー（検索）で選択 → GET /works/:id/detail を集約表示。
// 権限未付与（grant 007 未適用）のセクションは null で届くため注記して縮退する。

type Summary = { id: number; workCode: string | null; title: string | null; kind: string | null; isOriginal: boolean | null; parentWorkId: number | null };
type Tier = { workId: number; title: string | null; workCode: string | null; label: string; isSelected: boolean };
type Node = { workId: number; title: string | null; workCode: string | null; kind?: string | null; status?: string | null };
type Lineage = { chain: Tier[]; children: Node[]; unlinkedRelationParents: Node[]; depth: number; isDerivative: boolean };
type Material = { id: number; materialCode: string | null; materialName: string | null; materialType: string | null; materialRole: string | null; acquisitionType: string | null; rightsType: string | null; rightsHolderLabel: string | null; isRoyaltyBearing: boolean | null; categoryName: string | null; territory: string | null; language: string | null };
type RightsSource = { id: number; materialId: number | null; materialName: string | null; sourceType: string | null; sourceWorkId: number | null; sourceWorkTitle: string | null; rightsHolderVendorId: number | null; rightsHolderName: string | null; sourceDocumentId: number | null; sourceContractId: number | null; sourceRole: string | null; isPrimary: boolean | null; validFrom: string | null; validTo: string | null };
type Cond = { id: number; conditionName: string | null; direction: string | null; sourceMaterialId: number | null; materialName: string | null; sublicenseAllowed: boolean | null; parentLicenseConditionId: number | null; ratePct: number | null; amountExTax: number | null; mgAmount: number | null; currency: string | null; documentNumber: string | null };
type Conditions = { receivable: Cond[]; payable: Cond[]; sublicense: Cond[]; workLevel: Cond[]; materialLinked: Cond[]; totals: { count: number; receivableCount: number; payableCount: number; sublicenseCount: number; workLevelCount: number } };
type Core = Summary & { titleKana: string | null; workType: string | null; status: string | null; derivationType: string | null; rightsHolderName: string | null; creatorName: string | null; publisherName: string | null; ledgerCode: string | null; remarks: string | null };
type Detail = { work: Core; lineage: Lineage | null; materials: Material[] | null; rightsSources: RightsSource[] | null; conditions: Conditions | null };

type Tab = "overview" | "lineage" | "products" | "materials" | "conditions" | "rights" | "rates" | "check";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概要" },
  { key: "lineage", label: "系譜" },
  { key: "products", label: "製品" },
  { key: "materials", label: "素材" },
  { key: "conditions", label: "条件" },
  { key: "rights", label: "権利ソース" },
  { key: "rates", label: "料率対象" },
  { key: "check", label: "契約チェック" }
];
const sevLabel: Record<"high" | "medium" | "low", string> = { high: "重大", medium: "注意", low: "軽微" };

const yen = (v: number | null, ccy: string | null) => v == null ? "—" : `${ccy && ccy !== "JPY" ? ccy + " " : "¥"}${new Intl.NumberFormat("ja-JP").format(Math.round(v))}`;
const kindLabel = (k: string | null) => k === "licensed_in" ? "ライセンスイン" : k === "own" ? "自社作品" : (k ?? "—");

function Degraded() {
  return <div className="empty-state">このセクションは現在表示できません（表示権限が未付与）。管理者が有効化すると自動的に表示されます。</div>;
}

type EditForm = {
  title: string; titleKana: string; workType: string; kind: "" | "licensed_in" | "own";
  derivationType: string; isOriginal: boolean; parentWorkId: string;
  creatorName: string; publisherName: string; ledgerCode: string; remarks: string;
};

type RightsForm = {
  id: number | null; materialId: string; sourceType: string; sourceRole: string;
  isPrimary: boolean; validFrom: string; validTo: string;
  sourceWorkId: string; rightsHolderVendorId: string; sourceDocumentId: string; sourceContractId: string;
};

const MATERIAL_TYPES = ["game_design", "illustration", "scenario", "manuscript", "other"] as const;
const MATERIAL_ROLES = ["core_logic", "sub_component"] as const;
const ACQUISITION_TYPES = ["license", "buyout_commission", "in_house"] as const;
const RIGHTS_TYPES = ["owned", "license"] as const;
type MaterialForm = {
  id: number | null; materialName: string; materialType: typeof MATERIAL_TYPES[number];
  materialRole: typeof MATERIAL_ROLES[number]; acquisitionType: typeof ACQUISITION_TYPES[number];
  rightsType: typeof RIGHTS_TYPES[number]; rightsHolderLabel: string; isRoyaltyBearing: boolean; remarks: string;
};
const emptyMaterial = (): MaterialForm => ({
  id: null, materialName: "", materialType: "other", materialRole: "sub_component",
  acquisitionType: "license", rightsType: "license", rightsHolderLabel: "", isRoyaltyBearing: false, remarks: ""
});

export function WorkDetail({ canEdit = false, canEditRights = false, canEditMaterials = false, onNavigate }: { canEdit?: boolean; canEditRights?: boolean; canEditMaterials?: boolean; onNavigate?: (target: string) => void }) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [rightsForm, setRightsForm] = useState<RightsForm | null>(null);
  const [rightsSaving, setRightsSaving] = useState(false);
  const [rightsError, setRightsError] = useState("");
  const [relParentId, setRelParentId] = useState("");
  const [relSaving, setRelSaving] = useState(false);
  const [relError, setRelError] = useState("");
  const [matForm, setMatForm] = useState<MaterialForm | null>(null);
  const [matSaving, setMatSaving] = useState(false);
  const [matError, setMatError] = useState("");

  // 作品検索（デバウンス）。
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams();
      if (keyword.trim()) params.set("keyword", keyword.trim());
      params.set("limit", "50");
      try {
        const res = await fetch(`/api/v2/works?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) { setResults([]); if (res.status === 403) setError("閲覧権限がありません"); return; }
        const data = await res.json();
        setResults(data.works ?? []); setError("");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResults([]);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [keyword]);

  // 選択された作品の詳細取得。
  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    const controller = new AbortController();
    (async () => {
      setLoading(true); setError("");
      try {
        const res = await fetch(`/api/v2/works/${selectedId}/detail`, { signal: controller.signal });
        if (!res.ok) { setDetail(null); setError(res.status === 403 ? "閲覧権限がありません" : res.status === 404 ? "作品が見つかりません" : "取得に失敗しました"); return; }
        setDetail(await res.json());
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setDetail(null); setError("通信に失敗しました");
      } finally { setLoading(false); }
    })();
    return () => controller.abort();
  }, [selectedId, reload]);

  // 作品を切り替えたら編集状態・タブを初期化。
  useEffect(() => { setEditing(false); setForm(null); setSaveError(""); setTab("overview"); setRightsForm(null); setRightsError(""); setRelParentId(""); setRelError(""); }, [selectedId]);

  async function addRelation(parentWorkId: number) {
    if (selectedId == null) return;
    setRelSaving(true); setRelError("");
    try {
      const res = await fetch("/api/v2/work-relations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childWorkId: selectedId, parentWorkId })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRelError(data.error ?? (res.status === 503 ? "系譜編集は現在無効です" : res.status === 403 ? "編集権限がありません" : "保存に失敗しました"));
        return;
      }
      setRelParentId(""); setReload((n) => n + 1);
    } catch { setRelError("通信に失敗しました"); }
    finally { setRelSaving(false); }
  }

  const emptyRights = (materialId: number | null): RightsForm => ({
    id: null, materialId: materialId != null ? String(materialId) : "", sourceType: "direct_contract",
    sourceRole: "", isPrimary: false, validFrom: "", validTo: "",
    sourceWorkId: "", rightsHolderVendorId: "", sourceDocumentId: "", sourceContractId: ""
  });

  async function saveRights() {
    if (!rightsForm) return;
    const materialId = Number(rightsForm.materialId);
    if (!materialId) { setRightsError("素材を選択してください"); return; }
    setRightsSaving(true); setRightsError("");
    const numOrNull = (s: string) => s.trim() ? Number(s.trim()) : null;
    const body: Record<string, unknown> = {
      sourceType: rightsForm.sourceType.trim(),
      sourceRole: rightsForm.sourceRole.trim() || null,
      isPrimary: rightsForm.isPrimary,
      validFrom: rightsForm.validFrom || null,
      validTo: rightsForm.validTo || null,
      sourceWorkId: numOrNull(rightsForm.sourceWorkId),
      rightsHolderVendorId: numOrNull(rightsForm.rightsHolderVendorId),
      sourceDocumentId: numOrNull(rightsForm.sourceDocumentId),
      sourceContractId: numOrNull(rightsForm.sourceContractId)
    };
    const isNew = rightsForm.id == null;
    if (isNew) body.materialId = materialId;
    try {
      const res = await fetch(isNew ? "/api/v2/rights-sources" : `/api/v2/rights-sources/${rightsForm.id}`, {
        method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRightsError(data.error ?? (res.status === 503 ? "権利ソース編集は現在無効です" : res.status === 403 ? "編集権限がありません" : "保存に失敗しました"));
        return;
      }
      setRightsForm(null); setReload((n) => n + 1);
    } catch { setRightsError("通信に失敗しました"); }
    finally { setRightsSaving(false); }
  }

  async function saveMaterial() {
    if (!matForm || selectedId == null) return;
    if (!matForm.materialName.trim()) { setMatError("素材名は必須です"); return; }
    setMatSaving(true); setMatError("");
    const isNew = matForm.id == null;
    const body: Record<string, unknown> = {
      materialName: matForm.materialName.trim(), materialType: matForm.materialType,
      materialRole: matForm.materialRole, acquisitionType: matForm.acquisitionType,
      rightsType: matForm.rightsType,
      rightsHolderLabel: matForm.rightsHolderLabel.trim() || (isNew ? undefined : null),
      isRoyaltyBearing: matForm.isRoyaltyBearing,
      remarks: matForm.remarks.trim() || (isNew ? undefined : null)
    };
    if (isNew) body.workId = selectedId;
    try {
      const res = await fetch(isNew ? "/api/v2/materials" : `/api/v2/materials/${matForm.id}`, {
        method: isNew ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setMatError(d.error ?? "保存に失敗しました"); setMatSaving(false); return;
      }
      setMatForm(null); setReload((n) => n + 1);
    } catch { setMatError("通信に失敗しました"); }
    finally { setMatSaving(false); }
  }

  function startEdit() {
    if (!detail) return;
    const w = detail.work;
    setForm({
      title: w.title ?? "", titleKana: w.titleKana ?? "", workType: w.workType ?? "",
      kind: (w.kind === "licensed_in" || w.kind === "own") ? w.kind : "",
      derivationType: w.derivationType ?? "", isOriginal: w.isOriginal === true,
      parentWorkId: w.parentWorkId != null ? String(w.parentWorkId) : "",
      creatorName: w.creatorName ?? "", publisherName: w.publisherName ?? "",
      ledgerCode: w.ledgerCode ?? "", remarks: w.remarks ?? ""
    });
    setSaveError(""); setEditing(true);
  }

  async function save() {
    if (!form || selectedId == null) return;
    setSaving(true); setSaveError("");
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      titleKana: form.titleKana.trim() || null,
      workType: form.workType.trim() || null,
      derivationType: form.derivationType.trim() || null,
      isOriginal: form.isOriginal,
      parentWorkId: form.parentWorkId.trim() ? Number(form.parentWorkId.trim()) : null,
      creatorName: form.creatorName.trim() || null,
      publisherName: form.publisherName.trim() || null,
      ledgerCode: form.ledgerCode.trim() || null,
      remarks: form.remarks.trim() || null
    };
    if (form.kind) body.kind = form.kind;
    try {
      const res = await fetch(`/api/v2/works/${selectedId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error ?? (res.status === 503 ? "編集は現在無効です" : res.status === 403 ? "編集権限がありません" : "保存に失敗しました"));
        return;
      }
      setEditing(false); setForm(null); setReload((n) => n + 1);
    } catch { setSaveError("通信に失敗しました"); }
    finally { setSaving(false); }
  }

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>WORKS</p>
          <h1>作品</h1>
          <small>作品を起点に系譜・素材・条件・権利ソース・料率対象を一望（読み取り専用）</small>
        </div>
      </div>
      {onNavigate && <div className="surface-xref" role="navigation" aria-label="作品の関連画面">
        <span className="surface-xref-here">作品ビュー（ここ・閲覧）</span>
        <button type="button" onClick={() => onNavigate("ledgers-works")}>マスタ編集 → 台帳（作品・原作）</button>
      </div>}

      <div className="wd-layout">
        <div className="wd-picker">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="作品名・作品コードで検索" />
          <div className="wd-picker-list">
            {results.map((w) => (
              <button key={w.id} className={selectedId === w.id ? "selected" : ""} onClick={() => setSelectedId(w.id)}>
                <strong>{w.workCode ? <small>{w.workCode} </small> : ""}{w.title ?? `作品#${w.id}`}</strong>
                <span>{w.isOriginal ? "原作" : w.parentWorkId ? "派生" : ""} {kindLabel(w.kind)}</span>
              </button>
            ))}
            {!results.length && <div className="empty-state">該当する作品がありません。</div>}
          </div>
        </div>

        <div className="wd-pane">
          {error && <div className="async-error"><span>{error}</span></div>}
          {!selectedId && !error && <div className="empty-state">左の一覧から作品を選ぶと詳細を表示します。</div>}
          {loading && <div className="empty-state">読込中…</div>}

          {detail && !loading && <>
            <div className="wd-head">
              <div>
                <strong>{detail.work.workCode ? <small>{detail.work.workCode} </small> : ""}{detail.work.title ?? `作品#${detail.work.id}`}</strong>
                {detail.work.titleKana && <em>{detail.work.titleKana}</em>}
              </div>
              <div className="wd-badges">
                {detail.work.isOriginal && <span className="status">原作</span>}
                {detail.lineage?.isDerivative && <span className="status">派生{detail.lineage.depth}段</span>}
                <span className="status">{kindLabel(detail.work.kind)}</span>
                {canEdit && !editing && <button onClick={startEdit}>編集</button>}
              </div>
            </div>

            <div className="ledger-tabs">
              {TABS.map((t) => (
                <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>{t.label}</button>
              ))}
            </div>

            {tab === "overview" && (editing && form ? (
              <div className="wd-edit">
                {saveError && <div className="async-error"><span>{saveError}</span></div>}
                <div className="wd-edit-grid">
                  <label>作品名<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
                  <label>作品名カナ<input value={form.titleKana} onChange={(e) => setForm({ ...form, titleKana: e.target.value })} /></label>
                  <label>作品種別<input value={form.workType} onChange={(e) => setForm({ ...form, workType: e.target.value })} /></label>
                  <label>区分
                    <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as EditForm["kind"] })}>
                      <option value="">未設定</option><option value="licensed_in">ライセンスイン</option><option value="own">自社作品</option>
                    </select>
                  </label>
                  <label>派生種別<input value={form.derivationType} onChange={(e) => setForm({ ...form, derivationType: e.target.value })} placeholder="licensed_derivative 等" /></label>
                  <label className="wd-check"><input type="checkbox" checked={form.isOriginal} onChange={(e) => setForm({ ...form, isOriginal: e.target.checked })} />原作フラグ</label>
                  <label>親作品ID（系譜）
                    <input value={form.parentWorkId} onChange={(e) => setForm({ ...form, parentWorkId: e.target.value.replace(/[^\d]/g, "") })} placeholder="空で親なし" inputMode="numeric" />
                  </label>
                  <label>作者<input value={form.creatorName} onChange={(e) => setForm({ ...form, creatorName: e.target.value })} /></label>
                  <label>出版社<input value={form.publisherName} onChange={(e) => setForm({ ...form, publisherName: e.target.value })} /></label>
                  <label>台帳コード<input value={form.ledgerCode} onChange={(e) => setForm({ ...form, ledgerCode: e.target.value })} /></label>
                  <label className="wd-wide">備考<textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={2} /></label>
                </div>
                {form.parentWorkId && detail.work.id === Number(form.parentWorkId) && <small className="hint">自身を親には設定できません。</small>}
                <div className="wd-edit-actions">
                  <button onClick={() => { setEditing(false); setForm(null); }} disabled={saving}>キャンセル</button>
                  <button className="primary" onClick={save} disabled={saving || !form.title.trim()}>{saving ? "保存中…" : "保存"}</button>
                </div>
                <small className="hint">親作品IDは左の一覧で対象作品を選ぶとヘッダに表示されるIDを参照できます（系譜の循環はサーバ側で拒否されます）。</small>
              </div>
            ) : (
              <dl className="wd-overview">
                <div><dt>作品種別</dt><dd>{detail.work.workType ?? "—"}</dd></div>
                <div><dt>ステータス</dt><dd>{detail.work.status ?? "—"}</dd></div>
                <div><dt>派生種別</dt><dd>{detail.work.derivationType ?? "—"}</dd></div>
                <div><dt>権利者</dt><dd>{detail.work.rightsHolderName ?? "—"}</dd></div>
                <div><dt>作者</dt><dd>{detail.work.creatorName ?? "—"}</dd></div>
                <div><dt>出版社</dt><dd>{detail.work.publisherName ?? "—"}</dd></div>
                <div><dt>台帳コード</dt><dd>{detail.work.ledgerCode ?? "—"}</dd></div>
                <div><dt>作品ID</dt><dd>{detail.work.id}</dd></div>
                <div className="wide"><dt>備考</dt><dd>{detail.work.remarks ?? "—"}</dd></div>
              </dl>
            ))}

            {tab === "lineage" && (detail.lineage ? <>
              <div className="wd-chain">
                {detail.lineage.chain.map((t) => (
                  <div key={t.workId} className={`wd-node${t.isSelected ? " current" : ""}`}>
                    <span className="wd-node-label">{t.label}</span>
                    <strong>{t.workCode ? <small>{t.workCode} </small> : ""}{t.title ?? `作品#${t.workId}`}</strong>
                  </div>
                ))}
              </div>
              <h4>直接の派生作品</h4>
              {detail.lineage.children.length
                ? <ul className="wd-list">{detail.lineage.children.map((c) => <li key={c.workId}><button onClick={() => setSelectedId(c.workId)}>{c.workCode ? c.workCode + " " : ""}{c.title ?? `作品#${c.workId}`}</button></li>)}</ul>
                : <div className="empty-state">派生作品はありません。</div>}
              {detail.lineage.unlinkedRelationParents.length > 0 && <>
                <h4>系譜に未反映の親（work_relations のみ）</h4>
                <ul className="wd-list warn">{detail.lineage.unlinkedRelationParents.map((c) => <li key={c.workId}><button onClick={() => setSelectedId(c.workId)}>{c.workCode ? c.workCode + " " : ""}{c.title ?? `作品#${c.workId}`}</button></li>)}</ul>
                <small className="hint">parent_work_id 系譜に現れない親です。系譜（親子）の整合を確認してください。</small>
              </>}
              {canEdit && <>
                <h4>系譜（派生元）を追加</h4>
                {relError && <div className="async-error"><span>{relError}</span></div>}
                <div className="wd-edit-actions" style={{ justifyContent: "flex-start" }}>
                  <input value={relParentId} onChange={(e) => setRelParentId(e.target.value.replace(/[^\d]/g, ""))} placeholder="派生元の作品ID" inputMode="numeric" style={{ padding: "8px 10px", border: "1px solid #cbd5e1", borderRadius: 8 }} />
                  <button className="primary" onClick={() => relParentId && addRelation(Number(relParentId))} disabled={relSaving || !relParentId}>{relSaving ? "追加中…" : "派生元を追加"}</button>
                  {detail.work.parentWorkId != null && (
                    <button onClick={() => addRelation(detail.work.parentWorkId!)} disabled={relSaving}>現在の親(#{detail.work.parentWorkId})を系譜に記録</button>
                  )}
                </div>
                <small className="hint">work_relations に derived_from 関係を追加します（parent_work_id 系譜と二重管理の整合用・冪等・循環は拒否）。</small>
              </>}
            </> : <Degraded />)}

            {tab === "products" && (detail.lineage ? <>
              <small className="hint">この作品から生まれた製品（派生作品）と構成素材を集約表示します。※製品専用テーブルは未導入のため、派生作品・素材から代替表示しています。</small>
              <h4>製品（派生作品）</h4>
              {detail.lineage.children.length ? <table>
                <thead><tr><th>コード</th><th>製品名</th><th>区分</th><th>ステータス</th><th></th></tr></thead>
                <tbody>{detail.lineage.children.map((c) => <tr key={c.workId}>
                  <td>{c.workCode ?? "—"}</td><td>{c.title ?? `作品#${c.workId}`}</td>
                  <td>{kindLabel(c.kind ?? null)}</td><td>{c.status ?? "—"}</td>
                  <td><button onClick={() => setSelectedId(c.workId)}>開く</button></td>
                </tr>)}</tbody>
              </table> : <div className="empty-state">この作品を派生元とする製品（派生作品）はありません。</div>}
              <h4>構成素材</h4>
              {detail.materials == null ? <Degraded /> : (
                detail.materials.length
                  ? <ul className="wd-list">{detail.materials.map((m) => <li key={m.id}>{m.materialCode ? m.materialCode + " " : ""}{m.materialName}{m.materialType ? `（${m.materialType}）` : ""}</li>)}</ul>
                  : <div className="empty-state">登録された素材はありません。</div>
              )}
            </> : <Degraded />)}

            {tab === "materials" && (detail.materials ? <>
              {canEditMaterials && !matForm &&
                <div className="wd-actions"><button className="primary" onClick={() => { setMatError(""); setMatForm(emptyMaterial()); }}>素材を追加</button></div>}
              {matForm && <div className="wd-edit-form">
                <h4>{matForm.id == null ? "この作品に素材を追加" : "素材を編集"}</h4>
                {matError && <div className="async-error">{matError}</div>}
                <label>素材名 *<input value={matForm.materialName} onChange={(e) => setMatForm({ ...matForm, materialName: e.target.value })} /></label>
                <div className="matter-form-grid">
                  <label>種別<select value={matForm.materialType} onChange={(e) => setMatForm({ ...matForm, materialType: e.target.value as MaterialForm["materialType"] })}>
                    {MATERIAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
                  <label>役割<select value={matForm.materialRole} onChange={(e) => setMatForm({ ...matForm, materialRole: e.target.value as MaterialForm["materialRole"] })}>
                    {MATERIAL_ROLES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
                  <label>取得<select value={matForm.acquisitionType} onChange={(e) => setMatForm({ ...matForm, acquisitionType: e.target.value as MaterialForm["acquisitionType"] })}>
                    {ACQUISITION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
                  <label>権利<select value={matForm.rightsType} onChange={(e) => setMatForm({ ...matForm, rightsType: e.target.value as MaterialForm["rightsType"] })}>
                    {RIGHTS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
                  <label>権利者<input value={matForm.rightsHolderLabel} onChange={(e) => setMatForm({ ...matForm, rightsHolderLabel: e.target.value })} /></label>
                </div>
                <label>備考<input value={matForm.remarks} onChange={(e) => setMatForm({ ...matForm, remarks: e.target.value })} /></label>
                <label className="task-primary-toggle"><input type="checkbox" checked={matForm.isRoyaltyBearing} onChange={(e) => setMatForm({ ...matForm, isRoyaltyBearing: e.target.checked })} />ロイヤリティ対象（金銭条件を付帯）</label>
                <div className="matter-form-actions">
                  <button className="primary" disabled={matSaving} onClick={() => void saveMaterial()}>{matSaving ? "保存中…" : "保存"}</button>
                  <button disabled={matSaving} onClick={() => setMatForm(null)}>キャンセル</button>
                </div>
              </div>}
              {detail.materials.length ? <table>
                <thead><tr><th>コード</th><th>素材名</th><th>種別</th><th>役割</th><th>取得</th><th>権利</th><th>権利者</th><th>ロイヤリティ</th>{canEditMaterials && <th></th>}</tr></thead>
                <tbody>{detail.materials.map((m) => <tr key={m.id}>
                  <td>{m.materialCode ?? "—"}</td><td>{m.materialName ?? "—"}</td><td>{m.materialType ?? "—"}</td>
                  <td>{m.materialRole ?? "—"}</td><td>{m.acquisitionType ?? "—"}</td><td>{m.rightsType ?? "—"}</td>
                  <td>{m.rightsHolderLabel ?? "—"}</td><td>{m.isRoyaltyBearing ? "対象" : "—"}</td>
                  {canEditMaterials && <td><button onClick={() => { setMatError(""); setMatForm({
                    id: m.id, materialName: m.materialName ?? "",
                    materialType: (MATERIAL_TYPES as readonly string[]).includes(m.materialType ?? "") ? m.materialType as MaterialForm["materialType"] : "other",
                    materialRole: (MATERIAL_ROLES as readonly string[]).includes(m.materialRole ?? "") ? m.materialRole as MaterialForm["materialRole"] : "sub_component",
                    acquisitionType: (ACQUISITION_TYPES as readonly string[]).includes(m.acquisitionType ?? "") ? m.acquisitionType as MaterialForm["acquisitionType"] : "license",
                    rightsType: (RIGHTS_TYPES as readonly string[]).includes(m.rightsType ?? "") ? m.rightsType as MaterialForm["rightsType"] : "license",
                    rightsHolderLabel: m.rightsHolderLabel ?? "", isRoyaltyBearing: Boolean(m.isRoyaltyBearing), remarks: ""
                  }); }}>編集</button></td>}
                </tr>)}</tbody>
              </table> : <div className="empty-state">登録された素材はありません。{canEditMaterials && "「素材を追加」から登録できます。"}</div>}
            </> : <Degraded />)}

            {tab === "conditions" && (detail.conditions ? <>
              <div className="wd-cond-summary">
                <span>受領 {detail.conditions.totals.receivableCount}</span>
                <span>支払 {detail.conditions.totals.payableCount}</span>
                <span>サブライセンス {detail.conditions.totals.sublicenseCount}</span>
                <span>作品レベル {detail.conditions.totals.workLevelCount}</span>
              </div>
              {detail.conditions.totals.count ? <table>
                <thead><tr><th>方向</th><th>条件名</th><th>素材</th><th>料率</th><th>金額</th><th>MG</th><th>サブL</th><th>文書</th></tr></thead>
                <tbody>{[...detail.conditions.receivable, ...detail.conditions.payable].map((c) => <tr key={c.id}>
                  <td>{c.direction === "receivable" ? "受領" : c.direction === "payable" ? "支払" : "—"}</td>
                  <td>{c.conditionName ?? "—"}</td><td>{c.materialName ?? (c.sourceMaterialId ? `#${c.sourceMaterialId}` : "作品レベル")}</td>
                  <td>{c.ratePct != null ? `${c.ratePct}%` : "—"}</td><td>{yen(c.amountExTax, c.currency)}</td><td>{yen(c.mgAmount, c.currency)}</td>
                  <td>{c.sublicenseAllowed || c.parentLicenseConditionId != null ? "○" : ""}</td><td>{c.documentNumber ?? "—"}</td>
                </tr>)}</tbody>
              </table> : <div className="empty-state">紐づく条件明細はありません。</div>}
            </> : <Degraded />)}

            {tab === "rights" && (detail.rightsSources ? (
              <>
                {canEditRights && !rightsForm && (
                  <div className="wd-edit-actions">
                    <button className="primary" onClick={() => { setRightsError(""); setRightsForm(emptyRights(detail.materials?.[0]?.id ?? null)); }}
                      disabled={!detail.materials || !detail.materials.length}>＋ 権利ソース追加</button>
                  </div>
                )}
                {rightsForm && (
                  <div className="wd-edit">
                    {rightsError && <div className="async-error"><span>{rightsError}</span></div>}
                    <div className="wd-edit-grid">
                      <label>素材
                        <select value={rightsForm.materialId} disabled={rightsForm.id != null}
                          onChange={(e) => setRightsForm({ ...rightsForm, materialId: e.target.value })}>
                          <option value="">選択…</option>
                          {(detail.materials ?? []).map((m) => <option key={m.id} value={m.id}>{m.materialCode ? m.materialCode + " " : ""}{m.materialName}</option>)}
                        </select>
                      </label>
                      <label>ソース種別<input value={rightsForm.sourceType} onChange={(e) => setRightsForm({ ...rightsForm, sourceType: e.target.value })} placeholder="direct_contract 等" /></label>
                      <label>役割<input value={rightsForm.sourceRole} onChange={(e) => setRightsForm({ ...rightsForm, sourceRole: e.target.value })} placeholder="原作者 等" /></label>
                      <label className="wd-check"><input type="checkbox" checked={rightsForm.isPrimary} onChange={(e) => setRightsForm({ ...rightsForm, isPrimary: e.target.checked })} />主たるソース</label>
                      <label>有効開始<input type="date" value={rightsForm.validFrom} onChange={(e) => setRightsForm({ ...rightsForm, validFrom: e.target.value })} /></label>
                      <label>有効終了<input type="date" value={rightsForm.validTo} onChange={(e) => setRightsForm({ ...rightsForm, validTo: e.target.value })} /></label>
                      <label>ソース作品ID<input value={rightsForm.sourceWorkId} onChange={(e) => setRightsForm({ ...rightsForm, sourceWorkId: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" /></label>
                      <label>権利者取引先ID<input value={rightsForm.rightsHolderVendorId} onChange={(e) => setRightsForm({ ...rightsForm, rightsHolderVendorId: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" /></label>
                      <label>ソース文書ID<input value={rightsForm.sourceDocumentId} onChange={(e) => setRightsForm({ ...rightsForm, sourceDocumentId: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" /></label>
                      <label>ソース契約ID<input value={rightsForm.sourceContractId} onChange={(e) => setRightsForm({ ...rightsForm, sourceContractId: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" /></label>
                    </div>
                    <div className="wd-edit-actions">
                      <button onClick={() => setRightsForm(null)} disabled={rightsSaving}>キャンセル</button>
                      <button className="primary" onClick={saveRights} disabled={rightsSaving || !rightsForm.materialId || !rightsForm.sourceType.trim()}>{rightsSaving ? "保存中…" : "保存"}</button>
                    </div>
                  </div>
                )}
                {detail.rightsSources.length ? <table>
                  <thead><tr><th>素材</th><th>ソース種別</th><th>ソース作品</th><th>権利者</th><th>役割</th><th>主</th><th>有効期間</th>{canEditRights && <th></th>}</tr></thead>
                  <tbody>{detail.rightsSources.map((r) => <tr key={r.id}>
                    <td>{r.materialName ?? "—"}</td><td>{r.sourceType ?? "—"}</td><td>{r.sourceWorkTitle ?? "—"}</td>
                    <td>{r.rightsHolderName ?? "—"}</td><td>{r.sourceRole ?? "—"}</td><td>{r.isPrimary ? "○" : ""}</td>
                    <td>{[r.validFrom, r.validTo].filter(Boolean).join(" 〜 ") || "—"}</td>
                    {canEditRights && <td><button onClick={() => { setRightsError(""); setRightsForm({
                      id: r.id, materialId: r.materialId != null ? String(r.materialId) : "", sourceType: r.sourceType ?? "",
                      sourceRole: r.sourceRole ?? "", isPrimary: r.isPrimary === true, validFrom: r.validFrom ?? "", validTo: r.validTo ?? "",
                      sourceWorkId: r.sourceWorkId != null ? String(r.sourceWorkId) : "", rightsHolderVendorId: r.rightsHolderVendorId != null ? String(r.rightsHolderVendorId) : "",
                      sourceDocumentId: r.sourceDocumentId != null ? String(r.sourceDocumentId) : "", sourceContractId: r.sourceContractId != null ? String(r.sourceContractId) : ""
                    }); }}>編集</button></td>}
                  </tr>)}</tbody>
                </table> : <div className="empty-state">登録された権利ソースはありません。</div>}
              </>
            ) : <Degraded />)}

            {tab === "rates" && (
              <>
                <h4>ロイヤリティ対象素材</h4>
                {detail.materials == null ? <Degraded /> : (
                  detail.materials.filter((m) => m.isRoyaltyBearing).length
                    ? <ul className="wd-list">{detail.materials.filter((m) => m.isRoyaltyBearing).map((m) => <li key={m.id}>{m.materialCode ? m.materialCode + " " : ""}{m.materialName}</li>)}</ul>
                    : <div className="empty-state">ロイヤリティ対象の素材はありません。</div>
                )}
                <h4>料率を持つ条件</h4>
                {detail.conditions == null ? <Degraded /> : (
                  [...detail.conditions.receivable, ...detail.conditions.payable].filter((c) => c.ratePct != null).length
                    ? <table>
                      <thead><tr><th>方向</th><th>条件名</th><th>素材</th><th>料率</th><th>ロイヤリティ基礎</th></tr></thead>
                      <tbody>{[...detail.conditions.receivable, ...detail.conditions.payable].filter((c) => c.ratePct != null).map((c) => <tr key={c.id}>
                        <td>{c.direction === "receivable" ? "受領" : "支払"}</td><td>{c.conditionName ?? "—"}</td>
                        <td>{c.materialName ?? "作品レベル"}</td><td>{c.ratePct}%</td><td>{yen(c.amountExTax, c.currency)}</td>
                      </tr>)}</tbody>
                    </table>
                    : <div className="empty-state">料率を持つ条件はありません。</div>
                )}
              </>
            )}

            {tab === "check" && (detail.conditions == null ? <Degraded /> : (() => {
              const all = [...detail.conditions.receivable, ...detail.conditions.payable];
              const findings = checkWorkConditions(all);
              const sum = summarizeFindings(findings);
              return <>
                <small className="hint">この作品の条件明細を作成時ルールで点検します（重複・欠落の横断はデータ品質センター）。</small>
                <div className="wd-cond-summary">
                  <span>重大 {sum.high}</span><span>注意 {sum.medium}</span><span>軽微 {sum.low}</span><span>対象 {all.length}件</span>
                </div>
                {findings.length ? <table>
                  <thead><tr><th>重大度</th><th>条件</th><th>指摘</th></tr></thead>
                  <tbody>{findings.map((f, i) => <tr key={`${f.conditionId}-${i}`}>
                    <td>{sevLabel[f.severity]}</td><td>{f.conditionName}</td><td>{f.message}</td>
                  </tr>)}</tbody>
                </table> : <div className="empty-state">指摘はありません。条件は整合しています。</div>}
              </>;
            })())}
          </>}
        </div>
      </div>
    </section>
  );
}
