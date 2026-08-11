import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { FeatureLockedNote } from "./FeatureLockedNote";

// システム設定（Phase 11-1 → 2-5 で連携設定タブを追加）。
//   会社プロファイル＝帳票・請求で使う自社情報。
//   連携設定＝Backlog/Slack/Gmail/CloudSign の非秘密の運用パラメータ（app_settings・V1 と共有）。
//     秘密（APIキー・トークン・SA鍵等）と live/disabled 切替はデプロイ管理のため、この画面では扱わない。
type Field = { key: string; label: string; placeholder?: string };
type Tab = "company" | "integration";

export function SettingsWorkspace({ canEdit = false }: { canEdit?: boolean }) {
  const [tab, setTab] = useState<Tab>("company");
  const [fields, setFields] = useState<Field[]>([]);
  const [integrationFields, setIntegrationFields] = useState<Field[]>([]);
  const [effective, setEffective] = useState<Record<string, string>>({});
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
      .then((d) => {
        setFields(d.fields ?? []);
        setIntegrationFields(d.integrationFields ?? []);
        setEffective(d.integrationEffective ?? {});
        setValues(d.values ?? {}); setDraft(d.values ?? {});
      })
      .catch(() => setError("設定を取得できませんでした（管理者のみ閲覧できます）。"))
      .finally(() => setLoading(false));
  }, []);

  const activeFields = tab === "company" ? fields : integrationFields;
  const dirty = activeFields.some((f) => (draft[f.key] ?? "") !== (values[f.key] ?? ""));

  async function save() {
    // 表示中タブの変更キーのみ送る。
    const changed: Record<string, string> = {};
    for (const f of activeFields) {
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
      toast.push(
        tab === "company"
          ? `会社プロファイルを保存しました（${data.saved}件）。`
          : `連携設定を保存しました（${data.saved}件）。即時反映されます（全サーバへは約1分以内）。`,
        "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  return <section className="page">
    <div className="page-title">
      <div><p>SYSTEM SETTINGS</p><h1>システム設定</h1>
        <small>会社プロファイルと連携の運用パラメータを管理します</small></div>
    </div>
    <div className="settings-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "company"}
        className={tab === "company" ? "active" : ""} onClick={() => setTab("company")}>会社プロファイル</button>
      <button role="tab" aria-selected={tab === "integration"}
        className={tab === "integration" ? "active" : ""} onClick={() => setTab("integration")}>連携設定</button>
    </div>
    {!canEdit && <FeatureLockedNote>設定の編集は未有効化です（管理者権限＋有効化が必要）。閲覧のみ可能です。</FeatureLockedNote>}
    {error && <div className="async-error">{error}</div>}
    {tab === "integration" && !error && (
      <div className="settings-note" role="note">
        <strong>連携設定について</strong>
        <ul>
          <li>保存すると<b>即時に反映</b>されます（複数サーバ構成でも約1分以内に全体へ自動反映。デプロイ不要）。</li>
          <li>空欄の項目は、デプロイ時の環境変数の値（各欄の「現在の実効値」）がそのまま使われます。</li>
          <li>APIキー・トークン・署名シークレット・CloudSign クライアントID・SA鍵などの<b>秘密情報</b>と、
            各連携の <b>live/disabled 切替</b>は、安全のためこの画面では扱いません（Secret Manager とデプロイ設定で管理）。</li>
        </ul>
      </div>
    )}
    {loading ? <p className="hub-note">読み込み中…</p> :
      <div className="panel settings-form">
        {activeFields.map((f) => <label key={f.key} className="settings-field">
          <span>{f.label}</span>
          <input value={draft[f.key] ?? ""} placeholder={f.placeholder ?? ""} disabled={!canEdit}
            onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))} />
          {tab === "integration" && (
            <small className="settings-effective">
              現在の実効値: {effective[f.key] ? effective[f.key] : "（未設定）"}
            </small>
          )}
        </label>)}
        {canEdit && <div className="matter-form-actions">
          <button className="primary" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>}
      </div>}
  </section>;
}
