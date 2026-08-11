import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { FeatureLockedNote } from "./FeatureLockedNote";
import { EmptyState } from "./EmptyState";

// 契約マスタ（Phase 11-4）。既存 contracts の一覧・中核項目編集・ライフサイクル状態変更。
// 登録(INSERT)は契約取込が担うため、ここでは既存行の更新のみ。編集は capability 有効時のみ。
type Contract = {
  id: number;
  documentNumber: string | null;
  contractTitle: string | null;
  contractCategory: string | null;
  contractType: string | null;
  lifecycleStage: string | null;
  contractStatus: string | null;
  primaryVendorId: number | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  autoRenewal: boolean;
  renewalNoticeMonths: number | null;
  alertLeadMonths: number | null;
  reviewDueDate: string | null;
};

const LIFECYCLE_STAGES = [
  "requested", "drafting", "reviewing", "awaiting_signature", "executed",
  "on_hold", "cancelled", "expired", "terminated"
] as const;
const STAGE_LABELS: Record<string, string> = {
  requested: "起票", drafting: "作成中", reviewing: "審査中", awaiting_signature: "署名待ち",
  executed: "締結済", on_hold: "保留", cancelled: "中止", expired: "満了", terminated: "解約"
};
// 契約を実質終わらせる遷移。確認バナーで明示的な警告を出す。
const DESTRUCTIVE_STAGES = new Set(["cancelled", "expired", "terminated"]);
function stageLabel(stage: string | null): string {
  if (!stage) return "（未設定）";
  return STAGE_LABELS[stage] ?? stage;   // V1 由来の enum 外値（draft 等）は素通し表示
}
// 状態バッジの色分け（DocumentRegistry と同じ registry-state 語彙）。
function stageBadgeClass(stage: string | null): string {
  if (stage === "executed") return "registry-state complete";
  if (stage === "cancelled" || stage === "expired" || stage === "terminated") return "registry-state voided";
  if (!stage) return "registry-state neutral";
  return "registry-state pending";   // 進行中（起票〜署名待ち・保留・V1 由来値）
}

type Draft = {
  contractTitle: string;
  effectiveDate: string;
  expirationDate: string;
  autoRenewal: boolean;
  renewalNoticeMonths: string;
  alertLeadMonths: string;
  reviewDueDate: string;
};
function toDraft(c: Contract): Draft {
  return {
    contractTitle: c.contractTitle ?? "",
    effectiveDate: c.effectiveDate ?? "",
    expirationDate: c.expirationDate ?? "",
    autoRenewal: c.autoRenewal,
    renewalNoticeMonths: c.renewalNoticeMonths == null ? "" : String(c.renewalNoticeMonths),
    alertLeadMonths: c.alertLeadMonths == null ? "" : String(c.alertLeadMonths),
    reviewDueDate: c.reviewDueDate ?? ""
  };
}
function toInt(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

export function ContractMasterWorkspace({ canEdit = false, onNavigate }: {
  canEdit?: boolean; onNavigate?: (view: string) => void;
}) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // 状態変更は select 直結ではなく2段階（選択→確認バナー→確定）。満了/解約/中止のような
  // 破壊的遷移が誤クリック1回で本番に入るのを防ぐ（監査 P0-9）。
  const [pendingStage, setPendingStage] = useState<{ id: number; label: string; from: string | null; to: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setLoading(true); setError("");
    const q = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    fetch(`/api/v2/contracts${q}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setContracts(d.contracts ?? []))
      .catch(() => setError("契約マスタを取得できませんでした（管理者・法務のみ閲覧できます）。"))
      .finally(() => setLoading(false));
  }, [reload]);

  function startEdit(c: Contract) { setEditingId(c.id); setDraft(toDraft(c)); }
  function cancel() { setEditingId(null); setDraft(null); }
  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  async function saveFields(id: number) {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/v2/contracts/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractTitle: draft.contractTitle.trim() || null,
          effectiveDate: draft.effectiveDate.trim() || null,
          expirationDate: draft.expirationDate.trim() || null,
          autoRenewal: draft.autoRenewal,
          renewalNoticeMonths: toInt(draft.renewalNoticeMonths),
          alertLeadMonths: toInt(draft.alertLeadMonths),
          reviewDueDate: draft.reviewDueDate.trim() || null
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "保存に失敗しました。", "error"); return; }
      toast.push("契約マスタを更新しました。", "success");
      cancel(); setReload((v) => v + 1);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  async function confirmStatusChange() {
    if (!pendingStage) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/v2/contracts/${pendingStage.id}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lifecycleStage: pendingStage.to })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "状態変更に失敗しました。", "error"); return; }
      toast.push(`ライフサイクル状態を「${stageLabel(pendingStage.to)}」に変更しました。`, "success");
      setPendingStage(null); setReload((v) => v + 1);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  return <section className="page">
    <div className="page-title">
      <div><p>CONTRACT MASTER</p><h1>契約マスタ</h1>
        <small>既存契約の中核項目（表題・有効期間・自動更新・アラート）とライフサイクル状態を編集します</small></div>
    </div>
    {onNavigate && <div className="surface-xref" role="navigation" aria-label="契約の関連画面">
      <span className="surface-xref-here">既存契約の編集（ここ）</span>
      <button type="button" onClick={() => onNavigate("contract-intake")}>新規登録 → 契約取込</button>
    </div>}
    {!canEdit && <FeatureLockedNote>契約マスタの編集は未有効化です（管理者・法務権限＋有効化が必要）。閲覧のみ可能です。</FeatureLockedNote>}

    <div className="panel cm-search">
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="文書番号・表題・契約種別で検索"
        onKeyDown={(e) => { if (e.key === "Enter") setReload((v) => v + 1); }} />
      <button onClick={() => setReload((v) => v + 1)}>検索</button>
    </div>
    {error && <div className="async-error">{error}</div>}

    {pendingStage && <div className="panel danger-zone">
      <h3>ライフサイクル状態の変更確認</h3>
      <p>
        <b>{pendingStage.label}</b> の状態を
        「{stageLabel(pendingStage.from)}」→「<b>{stageLabel(pendingStage.to)}</b>」に変更します。
      </p>
      {DESTRUCTIVE_STAGES.has(pendingStage.to) &&
        <p className="hub-note">⚠ 「{stageLabel(pendingStage.to)}」は契約を実質終了させる遷移です。アラート・更新通告の対象からも外れます。</p>}
      <div className="matter-form-actions">
        <button className="primary" disabled={saving} onClick={() => void confirmStatusChange()}>
          {saving ? "変更中…" : "状態を変更"}</button>
        <button disabled={saving} onClick={() => setPendingStage(null)}>キャンセル</button>
      </div>
    </div>}

    {loading ? <p className="hub-note">読み込み中…</p> :
      <div className="registry-table static-rows panel">
        <table>
          <thead><tr>
            <th>文書番号</th><th>表題</th><th>種別</th><th>状態</th><th>有効期間</th><th>自動更新</th>{canEdit && <th></th>}
          </tr></thead>
          <tbody>{contracts.map((c) => {
            const isEditing = editingId === c.id && draft;
            return <tr key={c.id}>
              <td><b>{c.documentNumber ?? `#${c.id}`}</b></td>
              <td>{isEditing
                ? <input value={draft!.contractTitle} onChange={(e) => set("contractTitle", e.target.value)} />
                : (c.contractTitle ?? "—")}</td>
              <td>{c.contractType ?? "—"}</td>
              <td>{canEdit
                ? <select
                    value={pendingStage?.id === c.id ? pendingStage.to : (c.lifecycleStage ?? "")}
                    disabled={saving}
                    onChange={(e) => {
                      const to = e.target.value;
                      if (!to || to === c.lifecycleStage) { setPendingStage(null); return; }
                      // 即時 PATCH しない。確認バナーで内容を見せてから確定する（誤操作防止）。
                      setPendingStage({ id: c.id, label: c.documentNumber ?? c.contractTitle ?? `#${c.id}`, from: c.lifecycleStage, to });
                    }}>
                    {(!c.lifecycleStage || !STAGE_LABELS[c.lifecycleStage]) &&
                      <option value={c.lifecycleStage ?? ""}>{stageLabel(c.lifecycleStage)}</option>}
                    {LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </select>
                : <span className={stageBadgeClass(c.lifecycleStage)}>{stageLabel(c.lifecycleStage)}</span>}</td>
              <td>{isEditing
                ? <span className="cm-inline-fields">
                    <input type="date" value={draft!.effectiveDate} onChange={(e) => set("effectiveDate", e.target.value)} />
                    <input type="date" value={draft!.expirationDate} onChange={(e) => set("expirationDate", e.target.value)} />
                  </span>
                : `${c.effectiveDate ?? "—"} 〜 ${c.expirationDate ?? "—"}`}</td>
              <td>{isEditing
                ? <span className="cm-inline-fields cm-renewal-fields">
                    <label className="task-primary-toggle"><input type="checkbox" checked={draft!.autoRenewal}
                      onChange={(e) => set("autoRenewal", e.target.checked)} />自動更新</label>
                    <label>更新通告<input inputMode="numeric" placeholder="月" title="更新通告（何か月前）"
                      value={draft!.renewalNoticeMonths} onChange={(e) => set("renewalNoticeMonths", e.target.value.replace(/[^\d]/g, ""))} /></label>
                    <label>アラート<input inputMode="numeric" placeholder="月" title="期限アラート（何か月前）"
                      value={draft!.alertLeadMonths} onChange={(e) => set("alertLeadMonths", e.target.value.replace(/[^\d]/g, ""))} /></label>
                    <label>見直し期日<input type="date" value={draft!.reviewDueDate}
                      onChange={(e) => set("reviewDueDate", e.target.value)} /></label>
                  </span>
                : <span title={[
                    c.renewalNoticeMonths != null ? `更新通告 ${c.renewalNoticeMonths}か月前` : null,
                    c.alertLeadMonths != null ? `アラート ${c.alertLeadMonths}か月前` : null,
                    c.reviewDueDate ? `見直し ${c.reviewDueDate}` : null
                  ].filter(Boolean).join("・") || undefined}>{c.autoRenewal ? "○" : "—"}</span>}</td>
              {canEdit && <td>{isEditing
                ? <span className="cm-inline-fields">
                    <button className="primary" disabled={saving} onClick={() => void saveFields(c.id)}>{saving ? "保存中…" : "保存"}</button>
                    <button disabled={saving} onClick={cancel}>キャンセル</button>
                  </span>
                : <button onClick={() => startEdit(c)}>編集</button>}</td>}
            </tr>;
          })}</tbody>
        </table>
        {!contracts.length && <EmptyState compact icon="▤" title="該当する契約がありません" />}
      </div>}
  </section>;
}
