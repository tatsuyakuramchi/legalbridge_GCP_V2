import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { FeatureLockedNote } from "./FeatureLockedNote";

// システム設定（Phase 11-1）。会社プロファイル（自社情報）の閲覧・編集。編集は capability 有効時のみ。
type Field = { key: string; label: string; placeholder?: string };

export function SettingsWorkspace({ canEdit = false }: { canEdit?: boolean }) {
  const [fields, setFields] = useState<Field[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => {
    setLoading(true); setError("");
    fetch("/api/v2/settings")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => { setFields(d.fields ?? []); setValues(d.values ?? {}); setDraft(d.values ?? {}); })
      .catch(() => setError("設定を取得できませんでした（管理者のみ閲覧できます）。"))
      .finally(() => setLoading(false));
  }, []);

  const dirty = fields.some((f) => (draft[f.key] ?? "") !== (values[f.key] ?? ""));

  async function save() {
    // 変更されたキーのみ送る。
    const changed: Record<string, string> = {};
    for (const f of fields) {
      const next = (draft[f.key] ?? "").trim();
      if (next !== (values[f.key] ?? "")) changed[f.key] = next;
    }
    if (!Object.keys(changed).length) return;
    setSaving(true);
    try {
      const response = await fetch("/api/v2/settings", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: changed })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "保存に失敗しました。", "error"); return; }
      setValues(data.values ?? {}); setDraft(data.values ?? {});
      toast.push(`会社プロファイルを保存しました（${data.saved}件）。`, "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  return <section className="page">
    <div className="page-title">
      <div><p>SYSTEM SETTINGS</p><h1>システム設定</h1>
        <small>帳票・請求で使う自社情報（会社プロファイル）を管理します</small></div>
    </div>
    {!canEdit && <FeatureLockedNote>設定の編集は未有効化です（管理者権限＋有効化が必要）。閲覧のみ可能です。</FeatureLockedNote>}
    {error && <div className="async-error">{error}</div>}
    {loading ? <p className="hub-note">読み込み中…</p> :
      <div className="panel settings-form">
        {fields.map((f) => <label key={f.key} className="settings-field">
          <span>{f.label}</span>
          <input value={draft[f.key] ?? ""} placeholder={f.placeholder ?? ""} disabled={!canEdit}
            onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))} />
        </label>)}
        {canEdit && <div className="matter-form-actions">
          <button className="primary" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>}
      </div>}
  </section>;
}
