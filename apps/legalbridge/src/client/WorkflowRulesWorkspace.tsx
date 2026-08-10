import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { FeatureLockedNote } from "./FeatureLockedNote";

// 承認ルート（Phase 11-2）。部門ごとの承認者/押印担当/責任者の Slack ID・部署チャンネル・有効フラグを
// 一覧・編集する。編集は capability 有効時のみ。department 一意（upsert）。
type Rule = {
  department: string;
  approverSlackId: string | null;
  stampOperatorSlackId: string | null;
  managerSlackId: string | null;
  slackChannelId: string | null;
  isActive: boolean;
};
type Draft = { department: string; approverSlackId: string; stampOperatorSlackId: string; managerSlackId: string; slackChannelId: string; isActive: boolean };

const empty: Draft = { department: "", approverSlackId: "", stampOperatorSlackId: "", managerSlackId: "", slackChannelId: "", isActive: true };
function toDraft(r: Rule): Draft {
  return {
    department: r.department, approverSlackId: r.approverSlackId ?? "", stampOperatorSlackId: r.stampOperatorSlackId ?? "",
    managerSlackId: r.managerSlackId ?? "", slackChannelId: r.slackChannelId ?? "", isActive: r.isActive
  };
}

export function WorkflowRulesWorkspace({ canEdit = false }: { canEdit?: boolean }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setLoading(true); setError("");
    fetch("/api/v2/workflow-rules")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setRules(d.rules ?? []))
      .catch(() => setError("承認ルートを取得できませんでした（管理者のみ閲覧できます）。"))
      .finally(() => setLoading(false));
  }, [reload]);

  async function save() {
    if (!editing || !editing.department.trim()) { toast.push("部門は必須です。", "error"); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/v2/workflow-rules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department: editing.department.trim(),
          approverSlackId: editing.approverSlackId.trim(),
          stampOperatorSlackId: editing.stampOperatorSlackId.trim(),
          managerSlackId: editing.managerSlackId.trim(),
          slackChannelId: editing.slackChannelId.trim(),
          isActive: editing.isActive
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "保存に失敗しました。", "error"); return; }
      toast.push(`承認ルートを保存しました（${editing.department.trim()}）。`, "success");
      setEditing(null); setReload((v) => v + 1);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setEditing((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  return <section className="page">
    <div className="page-title">
      <div><p>WORKFLOW RULES</p><h1>承認ルート</h1>
        <small>部門ごとの承認者・押印担当・責任者の Slack ID と部署チャンネルを管理します</small></div>
      {canEdit && !editing && <button className="primary" onClick={() => setEditing({ ...empty })}>新規部門</button>}
    </div>
    {!canEdit && <FeatureLockedNote>承認ルートの編集は未有効化です（管理者権限＋有効化が必要）。閲覧のみ可能です。</FeatureLockedNote>}
    {error && <div className="async-error">{error}</div>}

    {editing && <div className="panel settings-form">
      <h3>{rules.some((r) => r.department === editing.department) ? "承認ルートを編集" : "新規承認ルート"}</h3>
      <label className="settings-field"><span>部門 *</span>
        <input value={editing.department} onChange={(e) => set("department", e.target.value)} placeholder="法務部 / 営業部 等" /></label>
      <label className="settings-field"><span>承認者 Slack ID</span>
        <input value={editing.approverSlackId} onChange={(e) => set("approverSlackId", e.target.value)} placeholder="U01ABCDEFGH（空可）" /></label>
      <label className="settings-field"><span>押印担当 Slack ID</span>
        <input value={editing.stampOperatorSlackId} onChange={(e) => set("stampOperatorSlackId", e.target.value)} placeholder="U…（空可）" /></label>
      <label className="settings-field"><span>責任者 Slack ID</span>
        <input value={editing.managerSlackId} onChange={(e) => set("managerSlackId", e.target.value)} placeholder="U…（空可）" /></label>
      <label className="settings-field"><span>部署チャンネル ID</span>
        <input value={editing.slackChannelId} onChange={(e) => set("slackChannelId", e.target.value)} placeholder="C…（空可）" /></label>
      <label className="task-primary-toggle"><input type="checkbox" checked={editing.isActive} onChange={(e) => set("isActive", e.target.checked)} />有効</label>
      <div className="matter-form-actions">
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
        <button disabled={saving} onClick={() => setEditing(null)}>キャンセル</button>
      </div>
    </div>}

    {loading ? <p className="hub-note">読み込み中…</p> :
      <div className="registry-table panel">
        <table>
          <thead><tr><th>部門</th><th>承認者</th><th>押印担当</th><th>責任者</th><th>チャンネル</th><th>状態</th>{canEdit && <th></th>}</tr></thead>
          <tbody>{rules.map((r) => <tr key={r.department}>
            <td><b>{r.department}</b></td>
            <td>{r.approverSlackId ?? "—"}</td>
            <td>{r.stampOperatorSlackId ?? "—"}</td>
            <td>{r.managerSlackId ?? "—"}</td>
            <td>{r.slackChannelId ?? "—"}</td>
            <td>{r.isActive
              ? <span className="registry-state complete">有効</span>
              : <span className="registry-state voided">無効</span>}</td>
            {canEdit && <td><button onClick={() => setEditing(toDraft(r))}>編集</button></td>}
          </tr>)}</tbody>
        </table>
        {!rules.length && <p className="hub-note" style={{ padding: "12px" }}>承認ルートが未登録です。</p>}
      </div>}
  </section>;
}
