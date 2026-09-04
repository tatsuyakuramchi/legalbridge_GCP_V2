import { useEffect, useMemo, useState } from "react";
import type { DocumentFormData } from "../types";
import {
  buildGrantCoverage, buildRightsTree, exclusivityLabel, type RightsLine
} from "../rights-aggregation";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import { checkWorkConditions, summarizeFindings } from "./contract-check";
import { FeatureLockedNote } from "./FeatureLockedNote";
import { buildLicenseTermsSeed, businessLineLabel, emptyIntakeMaterial } from "./work-intake";
import { WorkDocumentLauncher } from "./WorkDocumentLauncher";

// 作品詳細（Phase 2・読み取り専用）。作品を起点に 概要/系譜/素材/条件/権利ソース/
// 料率対象 を一望する。作品ピッカー（検索）で選択 → GET /works/:id/detail を集約表示。
// 権限未付与（grant 007 未適用）のセクションは null で届くため注記して縮退する。

type Summary = { id: number; workCode: string | null; title: string | null; kind: string | null; isOriginal: boolean | null; parentWorkId: number | null };
type Tier = { workId: number; title: string | null; workCode: string | null; label: string; isSelected: boolean };
type Node = { workId: number; title: string | null; workCode: string | null; kind?: string | null; status?: string | null };
type Lineage = { chain: Tier[]; children: Node[]; unlinkedRelationParents: Node[]; depth: number; isDerivative: boolean };
type Material = { id: number; materialCode: string | null; materialName: string | null; materialType: string | null; materialRole: string | null; acquisitionType: string | null; rightsType: string | null; rightsHolderLabel: string | null; isRoyaltyBearing: boolean | null; categoryName: string | null; territory: string | null; language: string | null; remarks: string | null };
type RightsSource = { id: number; materialId: number | null; materialName: string | null; sourceType: string | null; sourceWorkId: number | null; sourceWorkTitle: string | null; rightsHolderVendorId: number | null; rightsHolderName: string | null; sourceDocumentId: number | null; sourceContractId: number | null; sourceRole: string | null; isPrimary: boolean | null; validFrom: string | null; validTo: string | null };
type Cond = { id: number; conditionName: string | null; direction: string | null; sourceMaterialId: number | null; materialName: string | null; sublicenseAllowed: boolean | null; parentLicenseConditionId: number | null; ratePct: number | null; amountExTax: number | null; mgAmount: number | null; currency: string | null; documentNumber: string | null; effective?: boolean; supersededBy?: string | null };
type Conditions = { receivable: Cond[]; payable: Cond[]; sublicense: Cond[]; workLevel: Cond[]; materialLinked: Cond[]; totals: { count: number; receivableCount: number; payableCount: number; sublicenseCount: number; workLevelCount: number } };
type Core = Summary & { titleKana: string | null; workType: string | null; status: string | null; businessLine?: string | null; derivationType: string | null; rightsHolderName: string | null; rightsHolderVendorId?: number | null; creatorName: string | null; publisherName: string | null; ledgerCode: string | null; remarks: string | null };
type Detail = { work: Core; lineage: Lineage | null; materials: Material[] | null; rightsSources: RightsSource[] | null; conditions: Conditions | null; rightsLines?: RightsLine[] | null };

// タブは4つに統合（2026-09-01 利用者指摘「行程と項目の意味が分かりにくい」）。
// 旧: 概要/系譜/製品/素材/条件/権利ツリー/権利ソース/料率対象/契約チェック の9タブは
// 概念が重複していた（製品≒系譜の派生作品、料率対象≒条件の絞り込み、
// 権利ツリー≒条件の地図表示）。基本情報（＋系譜）/素材と権利元（＋権利ソース）/
// 条件・料率（＋権利ツリー）/契約チェック に束ねる。
type Tab = "overview" | "materials" | "conditions" | "check";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "基本情報" },
  { key: "materials", label: "素材と権利元" },
  { key: "conditions", label: "条件・料率" },
  { key: "check", label: "契約チェック" }
];
const sevLabel: Record<"high" | "medium" | "low", string> = { high: "重大", medium: "注意", low: "軽微" };

const yen = (v: number | null, ccy: string | null) => v == null ? "—" : `${ccy && ccy !== "JPY" ? ccy + " " : "¥"}${new Intl.NumberFormat("ja-JP").format(Math.round(v))}`;
const kindLabel = (k: string | null) => k === "licensed_in" ? "ライセンスイン" : k === "own" ? "自社作品" : (k ?? "—");

function Degraded() {
  // 未有効化の伝え方は FeatureLockedNote に統一（Q2）。
  return <FeatureLockedNote>このセクションは現在表示できません。管理者が有効化すると自動的に表示されます。</FeatureLockedNote>;
}

type EditForm = {
  title: string; titleKana: string; workType: string; status: string; kind: string;
  derivationType: string; isOriginal: boolean; parentWorkId: string;
  creatorName: string; publisherName: string; ledgerCode: string; remarks: string;
  rightsHolderVendorId: string;
  // 編集開始時のステータス・区分（未変更なら送らない＝旧語彙のレガシー値を黙って消さない）。
  statusInitial: string; kindInitial: string;
};

const KNOWN_WORK_STATUSES = ["planning", "in_production", "released"];
const KNOWN_WORK_KINDS = ["licensed_in", "own"];

type RightsForm = {
  id: number | null; materialId: string; sourceType: string; sourceRole: string;
  isPrimary: boolean; validFrom: string; validTo: string;
  sourceWorkId: string; rightsHolderVendorId: string; sourceDocumentId: string; sourceContractId: string;
};


export function WorkDetail({ canEdit = false, canEditRights = false, canEditMaterials = false, onNavigate, onAddGrant, onCreateLicenseTerms, onCreateDocumentFromWork, onEditWork, onEnterConditions, initialWorkId = null }: {
  canEdit?: boolean; canEditRights?: boolean; canEditMaterials?: boolean; onNavigate?: (target: string) => void; onAddGrant?: (workId: number) => void;
  onCreateLicenseTerms?: (seed: DocumentFormData, workCode: string | null) => void;
  // 出版個別条件書・出版基本契約・発注書を作品から起こす（初期値は App 側で差し込む）。
  onCreateDocumentFromWork?: (
    choice: "pub_license_terms" | "pub_master" | "purchase_order",
    work: { workId: number; workCode: string | null; title: string; vendorId: number | null }
  ) => void;
  onEditWork?: (workId: number) => void; initialWorkId?: number | null;
  // 作品の条件登録（正の動線）。旧「取込→詳細編集→条件明細」の案内はこれに置き換えた。
  onEnterConditions?: (workId: number, documentId?: number) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(initialWorkId);
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
  // 派生元の追加は生ID入力ではなく検索ピッカーで選ぶ（監査 P1-14）。
  const [relQuery, setRelQuery] = useState("");
  const [relOptions, setRelOptions] = useState<Summary[]>([]);
  const [relParent, setRelParent] = useState<Summary | null>(null);
  const [relSaving, setRelSaving] = useState(false);
  const [relError, setRelError] = useState("");

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

  // 派生元候補の検索（デバウンス・選択中の作品自身は除外）。
  useEffect(() => {
    if (!relQuery.trim()) { setRelOptions([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ keyword: relQuery.trim(), limit: "8" });
        const res = await fetch(`/api/v2/works?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) { setRelOptions([]); return; }
        const data = await res.json();
        setRelOptions(((data.works ?? []) as Summary[]).filter((w) => w.id !== selectedId));
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setRelOptions([]);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [relQuery, selectedId]);

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
  useEffect(() => { setEditing(false); setForm(null); setSaveError(""); setTab("overview"); setRightsForm(null); setRightsError(""); setRelParent(null); setRelQuery(""); setRelError(""); }, [selectedId]);

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
      setRelParent(null); setRelQuery(""); setReload((n) => n + 1);
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

  function startEdit() {
    if (!detail) return;
    const w = detail.work;
    setForm({
      title: w.title ?? "", titleKana: w.titleKana ?? "", workType: w.workType ?? "",
      // 旧語彙（suspended 等）はそのまま保持して「（旧データ）」として表示する。
      // "" に丸めると保存時に status:null が送られてレガシー値が黙って消える（監査④）。
      status: w.status ?? "", statusInitial: w.status ?? "",
      kind: w.kind ?? "", kindInitial: w.kind ?? "",
      derivationType: w.derivationType ?? "", isOriginal: w.isOriginal === true,
      parentWorkId: w.parentWorkId != null ? String(w.parentWorkId) : "",
      creatorName: w.creatorName ?? "", publisherName: w.publisherName ?? "",
      ledgerCode: w.ledgerCode ?? "", remarks: w.remarks ?? "",
      rightsHolderVendorId: w.rightsHolderVendorId != null ? String(w.rightsHolderVendorId) : ""
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
      remarks: form.remarks.trim() || null,
      rightsHolderVendorId: form.rightsHolderVendorId ? Number(form.rightsHolderVendorId) : null
    };
    // ステータス・区分は「変更したときだけ」送る（監査④）：
    //   - 旧語彙（suspended 等）のまま無関係な項目を編集しても消えない
    //   - 区分は works.kind が NOT NULL のため未変更で null を送ると保存不能だった
    if (form.status !== form.statusInitial) body.status = form.status || null;
    if (form.kind !== form.kindInitial && KNOWN_WORK_KINDS.includes(form.kind)) body.kind = form.kind;
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
          <small>作品を起点に系譜・素材・条件・権利ソース・料率対象を一望・編集します</small>
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
                {canEdit && !editing && onEditWork && <button className="primary"
                  title="登録画面と同じ流れ（基本情報→原作→素材→既存文書）で一括編集します"
                  onClick={() => onEditWork(detail.work.id)}>一括編集</button>}
                {canEdit && !editing && <button onClick={startEdit} title="この画面のまま基本情報だけ修正します">詳細項目の編集</button>}
              </div>
            </div>

            {(onCreateLicenseTerms || onCreateDocumentFromWork) && <div className="wd-launcher">
              <WorkDocumentLauncher businessLine={detail.work.businessLine ?? null} compact
                onPick={(choice) => {
                  if (choice.templateKey === "individual_license_terms_v3") {
                    // 既存作品から条件書を作る（作品登録と同じ橋渡し）。イン料率は
                    // 既存の条件文書側にあるためここでは展開せず、条件書側で入力する。
                    const seed = buildLicenseTermsSeed(
                      { workCode: detail.work.workCode, title: detail.work.title ?? "",
                        holderLabel: detail.work.rightsHolderName ?? "" },
                      (detail.materials ?? []).map((m) => ({
                        material: {
                          ...emptyIntakeMaterial(m.rightsHolderLabel ?? detail.work.rightsHolderName ?? ""),
                          name: m.materialName ?? m.materialCode ?? "",
                          royalty: Boolean(m.isRoyaltyBearing),
                          region: m.territory ?? "全世界",
                          language: m.language ?? "全言語"
                        },
                        materialCode: m.materialCode
                      })));
                    onCreateLicenseTerms?.(seed, detail.work.workCode);
                    return;
                  }
                  onCreateDocumentFromWork?.(choice.templateKey, {
                    workId: detail.work.id, workCode: detail.work.workCode, title: detail.work.title ?? "",
                    vendorId: detail.work.rightsHolderVendorId ?? null
                  });
                }} />
            </div>}

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
                  <label>ステータス
                    <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                      <option value="">未設定</option><option value="planning">企画中</option>
                      <option value="in_production">制作中</option><option value="released">発売済み</option>
                      {form.status !== "" && !KNOWN_WORK_STATUSES.includes(form.status) &&
                        <option value={form.status}>{form.status}（旧データ）</option>}
                    </select>
                  </label>
                  <label>区分
                    <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                      <option value="licensed_in">ライセンスイン</option><option value="own">自社作品</option>
                      {!KNOWN_WORK_KINDS.includes(form.kind) &&
                        <option value={form.kind}>{form.kind ? `${form.kind}（旧データ）` : "（未設定・変更しない）"}</option>}
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
                  <SearchableLedgerSelect type="vendors" value={form.rightsHolderVendorId}
                    label="権利者（取引先）" placeholder="名前・コードで検索"
                    onChange={(value) => setForm({ ...form, rightsHolderVendorId: value })} />
                  <label className="wd-wide">備考<textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} rows={4} /></label>
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
                <div><dt>展開区分</dt><dd>{businessLineLabel(detail.work.businessLine)}{!detail.work.businessLine && canEdit ? "（一括編集で設定）" : ""}</dd></div>
                <div><dt>作品ID</dt><dd>{detail.work.id}</dd></div>
                <div className="wide"><dt>備考</dt><dd>{detail.work.remarks ?? "—"}</dd></div>
              </dl>
            ))}

            {tab === "overview" && !editing && (detail.lineage ? <>
              <h4>系譜（原作 → この作品 → 派生）</h4>
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
                <h4>系譜に未反映の親（関連付けのみ）</h4>
                <ul className="wd-list warn">{detail.lineage.unlinkedRelationParents.map((c) => <li key={c.workId}><button onClick={() => setSelectedId(c.workId)}>{c.workCode ? c.workCode + " " : ""}{c.title ?? `作品#${c.workId}`}</button></li>)}</ul>
                <small className="hint">親子系譜には現れない関連付け上の親です。系譜（親子）の整合を確認してください。</small>
              </>}
              {canEdit && <>
                <h4>系譜（派生元）を追加</h4>
                {relError && <div className="async-error"><span>{relError}</span></div>}
                <div className="wd-rel-picker">
                  {relParent
                    ? <span className="wd-rel-selected">
                        <strong>{relParent.workCode ? `${relParent.workCode} ` : ""}{relParent.title ?? `作品#${relParent.id}`}</strong>
                        <button type="button" onClick={() => { setRelParent(null); setRelQuery(""); }}>選び直す</button>
                      </span>
                    : <>
                        <input value={relQuery} onChange={(e) => setRelQuery(e.target.value)}
                          placeholder="派生元の作品を名称・コードで検索" />
                        {relOptions.length > 0 && <div className="wd-rel-options">
                          {relOptions.map((w) => <button key={w.id} type="button"
                            onClick={() => { setRelParent(w); setRelOptions([]); }}>
                            {w.workCode ? <small>{w.workCode} </small> : ""}{w.title ?? `作品#${w.id}`}
                          </button>)}
                        </div>}
                      </>}
                  <button className="primary" onClick={() => relParent && addRelation(relParent.id)}
                    disabled={relSaving || !relParent}>{relSaving ? "追加中…" : "派生元を追加"}</button>
                  {detail.work.parentWorkId != null && (
                    <button onClick={() => addRelation(detail.work.parentWorkId!)} disabled={relSaving}>現在の親を系譜に記録</button>
                  )}
                </div>
                <small className="hint">「この作品の派生元」の関連付けを追加します（既に登録済みなら重複しません・循環する指定は拒否されます）。</small>
              </>}
            </> : <Degraded />)}

            {tab === "materials" && (detail.materials ? <>
              {/* 素材の追加・編集は一括編集（作品登録と同じ流れ）に一本化（2026-09-03 レガシー整理）。
                  旧・インライン編集フォームは廃止。 */}
              {canEditMaterials && onEditWork &&
                <div className="wd-actions"><button className="primary" onClick={() => onEditWork(detail.work.id)}>一括編集で素材を追加・編集</button></div>}
              {detail.materials.length ? <div className="table-scroll"><table>
                <thead><tr><th>コード</th><th>素材名</th><th>種別</th><th>役割</th><th>取得</th><th>権利</th><th>権利者</th><th>ロイヤリティ</th></tr></thead>
                <tbody>{detail.materials.map((m) => <tr key={m.id}>
                  <td>{m.materialCode ?? "—"}</td><td>{m.materialName ?? "—"}</td><td>{m.materialType ?? "—"}</td>
                  <td>{m.materialRole ?? "—"}</td><td>{m.acquisitionType ?? "—"}</td><td>{m.rightsType ?? "—"}</td>
                  <td>{m.rightsHolderLabel ?? "—"}</td><td>{m.isRoyaltyBearing ? "対象" : "—"}</td>
                </tr>)}</tbody>
              </table></div> : <div className="empty-state">登録された素材はありません。{canEditMaterials && "「一括編集」の②③から登録できます。"}</div>}
            </> : <Degraded />)}

            {tab === "conditions" && <>
              {/* 条件は手入力の一覧ではなく「文書から自動で登録される」。この行程が
                  画面から読めず「どこで入力するのか分からない」となっていたため、
                  入口をボタン付きで明示する。 */}
              <div className="wd-guide">
                <strong>条件の登録・編集は「作品の条件登録」画面で行います。</strong>
                <p>文書（発注書・条件書・契約書）を選び、この作品の素材から対象を選んで料率・MG/AG・支払を入れると、保存で条件台帳へ同期されここに載ります。締結済みの契約は文書を新しく作りません。これから条件書を新規発行する場合は上の「この作品から作る文書」から（確定時に載ります）。</p>
                <div className="wz-next">
                  {onEnterConditions && <button type="button" className="primary" onClick={() => onEnterConditions(detail.work.id)}>条件を登録・編集する →</button>}
                  {onAddGrant && <button type="button" onClick={() => onAddGrant(detail.work.id)}>アウト条件を追記（当社が許諾して受け取る側）</button>}
                </div>
              </div>
              {detail.conditions == null ? <Degraded /> : <>
                <div className="wd-cond-summary">
                  <span>支払う（イン） {detail.conditions.totals.payableCount}</span>
                  <span>受け取る（アウト） {detail.conditions.totals.receivableCount}</span>
                  <span>再許諾 {detail.conditions.totals.sublicenseCount}</span>
                  <span title="特定の素材ではなく文書全体に付いた条件">文書全体 {detail.conditions.totals.workLevelCount}</span>
                </div>
                {detail.conditions.totals.count ? <div className="table-scroll"><table>
                  <thead><tr><th>向き</th><th>条件名</th><th>対象素材</th><th>料率</th><th>金額</th><th>MG</th><th>再許諾</th><th>根拠文書</th></tr></thead>
                  <tbody>{[...detail.conditions.receivable, ...detail.conditions.payable].map((c) => <tr key={c.id}>
                    <td>{c.direction === "receivable" ? "受け取る" : c.direction === "payable" ? "支払う" : "—"}</td>
                    <td>{c.conditionName ?? "—"}</td><td>{c.materialName ?? (c.sourceMaterialId ? `#${c.sourceMaterialId}` : "文書全体")}</td>
                    <td>{c.ratePct != null ? `${c.ratePct}%` : "—"}</td><td>{yen(c.amountExTax, c.currency)}</td><td>{yen(c.mgAmount, c.currency)}</td>
                    <td>{c.sublicenseAllowed || c.parentLicenseConditionId != null ? "○" : ""}</td>
                    <td>{c.documentNumber ?? "—"}
                      {c.effective === false && <><br /><span className="cond-ineffective"
                        title={c.supersededBy ? `巻き直し済み。有効版は ${c.supersededBy}` : "無効"}>
                        無効{c.supersededBy ? `（旧版 → ${c.supersededBy}）` : ""}</span></>}</td>
                  </tr>)}</tbody>
                </table></div> : <div className="empty-state">まだ条件がありません。上の1〜3のいずれかで登録してください。</div>}
              </>}
              <h4>ロイヤリティ対象の素材</h4>
              {detail.materials == null ? <Degraded /> : (
                detail.materials.filter((m) => m.isRoyaltyBearing).length
                  ? <ul className="wd-list">{detail.materials.filter((m) => m.isRoyaltyBearing).map((m) => <li key={m.id}>{m.materialCode ? m.materialCode + " " : ""}{m.materialName}</li>)}</ul>
                  : <div className="empty-state">ロイヤリティ対象の素材はありません（「素材と権利元」タブでON/OFFできます）。</div>
              )}
              <h4>許諾の地図（地域×言語の重なりチェック）</h4>
              <RightsTreeTab lines={detail.rightsLines ?? null}
                onAddGrant={onAddGrant ? () => onAddGrant(detail.work.id) : undefined} />
            </>}

            {tab === "materials" && (detail.rightsSources ? (
              <>
                <h4>権利元・根拠（権利ソース）</h4>
                <small className="hint">素材ごとに「誰から・どの契約（文書）で」権利を得ているかの記録です。契約書から素材を引用して登録した場合は自動で付きます。</small>
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
                      <SearchableLedgerSelect type="works" value={rightsForm.sourceWorkId}
                        label="ソース作品" placeholder="作品名・コードで検索"
                        onChange={(value) => setRightsForm({ ...rightsForm, sourceWorkId: value })} />
                      <SearchableLedgerSelect type="vendors" value={rightsForm.rightsHolderVendorId}
                        label="権利者（取引先）" placeholder="名前・コードで検索"
                        onChange={(value) => setRightsForm({ ...rightsForm, rightsHolderVendorId: value })} />
                      <label>ソース文書ID<input value={rightsForm.sourceDocumentId} onChange={(e) => setRightsForm({ ...rightsForm, sourceDocumentId: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" placeholder="文書一覧の詳細で確認" /></label>
                      <label>ソース契約ID<input value={rightsForm.sourceContractId} onChange={(e) => setRightsForm({ ...rightsForm, sourceContractId: e.target.value.replace(/[^\d]/g, "") })} inputMode="numeric" placeholder="契約マスタで確認" /></label>
                    </div>
                    <div className="wd-edit-actions">
                      <button onClick={() => setRightsForm(null)} disabled={rightsSaving}>キャンセル</button>
                      <button className="primary" onClick={saveRights} disabled={rightsSaving || !rightsForm.materialId || !rightsForm.sourceType.trim()}>{rightsSaving ? "保存中…" : "保存"}</button>
                    </div>
                  </div>
                )}
                {detail.rightsSources.length ? <div className="table-scroll"><table>
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
                </table></div> : <div className="empty-state">登録された権利ソースはありません。</div>}
              </>
            ) : <Degraded />)}

            {tab === "check" && (detail.conditions == null ? <Degraded /> : (() => {
              const all = [...detail.conditions.receivable, ...detail.conditions.payable];
              const findings = checkWorkConditions(all);
              const sum = summarizeFindings(findings);
              return <>
                <small className="hint">この作品の条件明細を作成時ルールで点検します（重複・欠落の横断はデータ品質センター）。</small>
                <div className="wd-cond-summary">
                  <span>重大 {sum.high}</span><span>注意 {sum.medium}</span><span>軽微 {sum.low}</span><span>対象 {all.length}件</span>
                </div>
                {findings.length ? <div className="table-scroll"><table>
                  <thead><tr><th>重大度</th><th>条件</th><th>指摘</th></tr></thead>
                  <tbody>{findings.map((f, i) => <tr key={`${f.conditionId}-${i}`}>
                    <td>{sevLabel[f.severity]}</td><td>{f.conditionName}</td><td>{f.message}</td>
                  </tr>)}</tbody>
                </table></div> : <div className="empty-state">指摘はありません。条件は整合しています。</div>}
              </>;
            })())}
          </>}
        </div>
      </div>
    </section>
  );
}


// ── 権利ツリー（R3 再設計・2026-08-18）──────────────────────────────
// 金銭の in/out を左右対称に置き、アウト側は「地域×言語の格子」で許諾状況を出す。
// 許諾地域の被り＝二重許諾は致命的（利用者要件）なので、衝突を最上段に昇格し、
// 該当セルを赤枠で示す。判定は共通集計層（rights-aggregation・V1 ルール継承＋強化）。
function RightsTreeTab({ lines, onAddGrant }: { lines: RightsLine[] | null; onAddGrant?: () => void }) {
  const tree = useMemo(() => lines ? buildRightsTree(lines) : null, [lines]);
  const coverage = useMemo(
    () => tree ? buildGrantCoverage(tree.granted) : null, [tree]);
  if (!lines || !tree || !coverage) return <Degraded />;
  if (!lines.length) return <div className="empty-state">紐づく条件明細はありません。条件明細に作品を紐付けると、ここに権利の取得・許諾状況が表示されます。</div>;

  const errors = coverage.conflicts.filter((c) => c.severity === "error");
  const warnings = coverage.conflicts.filter((c) => c.severity === "warning");
  // 衝突セル（地域×言語）を赤枠にするための索引。
  const conflictCells = new Set(coverage.conflicts.map((c) => `${c.territory}|${c.language}`));

  return <div className="rights-tree">
    <div className="rights-summary">
      <article><span>取得（支払）</span><strong>{tree.totals.acquiredCount}件</strong></article>
      <article><span>買い切り合計</span><strong>{tree.totals.buyoutCount ? `¥${new Intl.NumberFormat("ja-JP").format(tree.totals.buyoutAmount)}` : "—"}</strong></article>
      <article><span>許諾（受領）</span><strong>{tree.totals.grantedCount}件</strong></article>
      <article className={errors.length ? "conflict-error" : warnings.length ? "conflict-warning" : ""}>
        <span>許諾の被り</span>
        <strong>{errors.length ? `⚠ ${errors.length}件` : warnings.length ? `注意 ${warnings.length}件` : "なし"}</strong>
      </article>
      {onAddGrant && <button type="button" className="primary rights-add-grant" onClick={onAddGrant}>
        ＋ 許諾条件を追加
      </button>}
    </div>

    {coverage.conflicts.length > 0 && <div className="rights-conflicts">
      {errors.map((c, i) => <p key={`e${i}`} className="conflict-error">
        <strong>⚠ 二重許諾の疑い</strong> {c.message}
        <small>相手先: {c.parties.join(" / ")}{c.documentNumbers.length ? `　文書: ${c.documentNumbers.join(", ")}` : ""}</small>
      </p>)}
      {warnings.map((c, i) => <p key={`w${i}`} className="conflict-warning">
        <strong>注意</strong> {c.message}
        <small>相手先: {c.parties.join(" / ")}</small>
      </p>)}
    </div>}

    {coverage.rows.length > 0 && <>
      <h3 className="rights-section-title">許諾マップ（アウト側）— 地域 × 言語</h3>
      <p className="hub-note">セル＝その地域・言語で出している許諾（権利 → 相手先）。空欄＝未許諾。赤枠＝被りあり。</p>
      <div className="table-scroll"><table className="rights-coverage">
        <thead><tr><th>地域</th>{coverage.languages.map((lang) => <th key={lang}>{lang}</th>)}</tr></thead>
        <tbody>{coverage.rows.map((row) => <tr key={row.territory} className={row.isWorldwide ? "worldwide" : ""}>
          <th>{row.isWorldwide ? "🌐 " : ""}{row.territory}</th>
          {coverage.languages.map((lang) => {
            const cells = row.languages[lang] ?? [];
            const conflicted = conflictCells.has(`${row.territory}|${lang}`);
            return <td key={lang} className={conflicted ? "cell-conflict" : cells.length ? "cell-granted" : "cell-open"}>
              {cells.map((cell, i) => <div key={i} className="grant-chip">
                <strong>{cell.right}
                  {exclusivityLabel(cell.exclusivity) &&
                    <em className={`excl excl-${cell.exclusivity}`}>{exclusivityLabel(cell.exclusivity)}</em>}
                </strong>
                <span>→ {cell.party}</span>
                {(cell.termStart || cell.termEnd) &&
                  <small>{[cell.termStart, cell.termEnd].filter(Boolean).join(" 〜 ")}</small>}
                {cell.documentNumber && <small>{cell.documentNumber}</small>}
              </div>)}
            </td>;
          })}
        </tr>)}</tbody>
      </table></div>
    </>}

    <div className="rights-columns">
      <section>
        <h3 className="rights-section-title">◀ 取得した権利（当社が支払）</h3>
        {tree.acquired.length ? tree.acquired.map((r) => <div key={r.id} className="rights-row">
          <div className="rights-row-head">
            <strong>{r.name}</strong>
            <span className={`kind-badge kind-${r.kind}`}>{r.kind === "buyout" ? "買い切り" : r.kind === "running" ? "ランニング" : "無償"}</span>
          </div>
          <span>{r.party}</span>
          <span>{r.kind === "buyout" ? r.amountLabel : r.calcLabel}</span>
          {r.documentNumber && <small>{r.documentNumber}</small>}
        </div>) : <div className="empty-state">取得側の条件はありません。</div>}
      </section>
      <section>
        <h3 className="rights-section-title">許諾した権利（当社が受領）▶</h3>
        {tree.granted.length ? tree.granted.map((r) => <div key={r.id} className="rights-row">
          <div className="rights-row-head">
            <strong>{r.name}</strong>
            <span className={`kind-badge kind-${r.kind}`}>{r.kind === "buyout" ? "買い切り" : r.kind === "running" ? "ランニング" : "無償"}</span>
          </div>
          <span>{r.party}</span>
          <span>{[r.territory, r.language].filter(Boolean).join("・") || "地域・言語未設定"}
            {exclusivityLabel(r.exclusivity) && <em className={`excl excl-${r.exclusivity}`}> {exclusivityLabel(r.exclusivity)}</em>}
          </span>
          {(r.termStart || r.termEnd) && <span>{[r.termStart, r.termEnd].filter(Boolean).join(" 〜 ")}</span>}
          <span>{r.kind === "running" ? r.calcLabel : r.amountLabel}</span>
          {r.documentNumber && <small>{r.documentNumber}</small>}
        </div>) : <div className="empty-state">許諾側の条件はありません。</div>}
      </section>
    </div>
  </div>;
}
