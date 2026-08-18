import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { FeatureLockedNote } from "./FeatureLockedNote";
import { parseEnabled, matchesChannelQuery, type NotificationDefinition } from "../notification-settings";

// システム設定（Phase 11-1 → 2-5 で連携設定・APIキータブを追加）。
//   会社プロファイル＝帳票・請求で使う自社情報。
//   連携設定＝Backlog/Slack/Gmail/CloudSign の非秘密の運用パラメータ（app_settings・V1 と共有）。
//   APIキー＝秘密情報の投入口。保存先は Secret Manager のみ（DB に入れない）・書き込み専用
//     （登録状況だけ表示し、値は二度と表示しない）。live/disabled 切替はデプロイ管理のまま。
type Field = { key: string; label: string; placeholder?: string };
type SecretField = { key: string; label: string; hint?: string; secretName: string; patternHint?: string };
type SecretStatus = { registered: boolean; version?: string; updatedAt?: string };
type SlackChannel = { id: string; name: string; isPrivate: boolean; isMember: boolean };
type ChannelListing = { available: boolean; channels: SlackChannel[]; reason?: string; truncated?: boolean };
type Tab = "company" | "integration" | "notifications" | "secrets";

export function SettingsWorkspace({ canEdit = false }: { canEdit?: boolean }) {
  const [tab, setTab] = useState<Tab>("company");
  const [fields, setFields] = useState<Field[]>([]);
  const [integrationFields, setIntegrationFields] = useState<Field[]>([]);
  const [effective, setEffective] = useState<Record<string, string>>({});
  const [notificationDefs, setNotificationDefs] = useState<NotificationDefinition[]>([]);
  const [fallbackChannel, setFallbackChannel] = useState("");
  const [channelListing, setChannelListing] = useState<ChannelListing | null>(null);
  // チャンネルは数百件になることがあるため、通知ごとに絞り込み語を持つ（選択肢だけを絞る）。
  const [channelFilter, setChannelFilter] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [secretFields, setSecretFields] = useState<SecretField[]>([]);
  const [secretStatuses, setSecretStatuses] = useState<Record<string, SecretStatus>>({});
  const [secretsAvailable, setSecretsAvailable] = useState(false);
  const [secretsWriteEnabled, setSecretsWriteEnabled] = useState(false);
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  function loadSecrets() {
    return fetch("/api/v2/settings/secrets")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => {
        setSecretFields(d.fields ?? []);
        setSecretStatuses(d.statuses ?? {});
        setSecretsAvailable(Boolean(d.available));
        setSecretsWriteEnabled(Boolean(d.writeEnabled));
      });
  }

  useEffect(() => {
    setLoading(true); setError("");
    Promise.all([
      fetch("/api/v2/settings")
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((d) => {
          setFields(d.fields ?? []);
          setIntegrationFields(d.integrationFields ?? []);
          setEffective(d.integrationEffective ?? {});
          setNotificationDefs(d.notificationDefinitions ?? []);
          setFallbackChannel(d.notificationFallbackChannel ?? "");
          setValues(d.values ?? {}); setDraft(d.values ?? {});
        }),
      loadSecrets().catch(() => { /* APIキータブのみ利用不可表示 */ })
    ])
      .catch(() => setError("設定を取得できませんでした（管理者のみ閲覧できます）。"))
      .finally(() => setLoading(false));
  }, []);

  // チャンネル一覧は通知タブを開いたときだけ取りに行く（設定画面を開くたびに Slack を叩かない）。
  useEffect(() => {
    if (tab !== "notifications" || channelListing) return;
    fetch("/api/v2/settings/slack-channels")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d: ChannelListing) => setChannelListing(d))
      .catch(() => setChannelListing({
        available: false, channels: [], reason: "チャンネル一覧を取得できませんでした。"
      }));
  }, [tab, channelListing]);

  // 通知タブの保存対象キー（ON/OFF と宛先）。会社・連携タブと同じ保存経路に載せる。
  const notificationFields: Field[] = notificationDefs.flatMap((d) => [
    { key: d.enabledKey, label: `${d.label}（配信）` },
    { key: d.channelKey, label: `${d.label}（宛先）` }
  ]);
  const activeFields = tab === "company" ? fields
    : tab === "integration" ? integrationFields
    : tab === "notifications" ? notificationFields
    : [];
  const secretChanged = secretFields.filter((f) => (secretDraft[f.key] ?? "").trim() !== "");
  const dirty = tab === "secrets"
    ? secretChanged.length > 0
    : activeFields.some((f) => (draft[f.key] ?? "") !== (values[f.key] ?? ""));

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
          : tab === "notifications"
            ? `通知設定を保存しました（${data.saved}件）。次回の配信から適用されます。`
            : `連携設定を保存しました（${data.saved}件）。即時反映されます（全サーバへは約1分以内）。`,
        "success");
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  async function saveSecrets() {
    const payload: Record<string, string> = {};
    for (const f of secretChanged) payload[f.key] = (secretDraft[f.key] ?? "").trim();
    if (!Object.keys(payload).length) return;
    setSaving(true);
    try {
      const response = await fetch("/api/v2/settings/secrets", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: payload })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status !== 200 && response.status !== 207) {
        toast.push(data.error ?? "保存に失敗しました。", "error"); return;
      }
      const results: Record<string, { ok: boolean; error?: string }> = data.results ?? {};
      const failed = Object.entries(results).filter(([, r]) => !r.ok);
      // 成功したキーの入力欄だけクリア（値は画面に残さない）。
      setSecretDraft((prev) => {
        const next = { ...prev };
        for (const [key, r] of Object.entries(results)) if (r.ok) delete next[key];
        return next;
      });
      await loadSecrets().catch(() => { /* 状況の再取得失敗は無視 */ });
      if (failed.length === 0) {
        toast.push(`APIキーを保存しました（${data.saved}件）。有効化済みの連携には約1分以内に反映されます。`, "success");
      } else {
        toast.push(failed.map(([key, r]) =>
          `${secretFields.find((f) => f.key === key)?.label ?? key}: ${r.error ?? "保存失敗"}`).join(" / "), "error");
      }
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setSaving(false); }
  }

  function statusLabel(key: string): string {
    const status = secretStatuses[key];
    if (!status?.registered) return "未登録";
    const when = status.updatedAt ? new Date(status.updatedAt).toLocaleString("ja-JP") : "";
    return `登録済み${status.version ? `（v${status.version}${when ? `・${when} 更新` : ""}）` : ""}`;
  }

  const secretsEditable = canEdit && secretsAvailable && secretsWriteEnabled;

  return <section className="page">
    <div className="page-title">
      <div><p>SYSTEM SETTINGS</p><h1>システム設定</h1>
        <small>会社プロファイル・連携の運用パラメータ・APIキーを管理します</small></div>
    </div>
    <div className="settings-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "company"}
        className={tab === "company" ? "active" : ""} onClick={() => setTab("company")}>会社プロファイル</button>
      <button role="tab" aria-selected={tab === "integration"}
        className={tab === "integration" ? "active" : ""} onClick={() => setTab("integration")}>連携設定</button>
      <button role="tab" aria-selected={tab === "notifications"}
        className={tab === "notifications" ? "active" : ""} onClick={() => setTab("notifications")}>通知</button>
      <button role="tab" aria-selected={tab === "secrets"}
        className={tab === "secrets" ? "active" : ""} onClick={() => setTab("secrets")}>APIキー</button>
    </div>
    {!canEdit && <FeatureLockedNote>設定の編集は未有効化です（管理者権限＋有効化が必要）。閲覧のみ可能です。</FeatureLockedNote>}
    {error && <div className="async-error">{error}</div>}
    {tab === "integration" && !error && (
      <div className="settings-note" role="note">
        <strong>連携設定について</strong>
        <ul>
          <li>保存すると<b>即時に反映</b>されます（複数サーバ構成でも約1分以内に全体へ自動反映。デプロイ不要）。</li>
          <li>空欄の項目は、デプロイ時の環境変数の値（各欄の「現在の実効値」）がそのまま使われます。</li>
          <li>APIキー・トークンなどの<b>秘密情報</b>は「APIキー」タブから登録します。
            各連携の <b>live/disabled 切替</b>は、安全のためデプロイ設定で管理します。</li>
        </ul>
      </div>
    )}
    {tab === "notifications" && !error && (
      <div className="settings-note" role="note">
        <strong>定期通知について</strong>
        <ul>
          <li>通知ごとに<b>配信の ON/OFF</b> と <b>投稿先チャンネル</b> を指定できます。</li>
          <li>宛先が「既定」のままの通知は、<b>法務相談チャンネル</b>
            {fallbackChannel ? `（${fallbackChannel}）` : "（未設定）"}へ投稿されます。</li>
          <li>投稿先には<b>Bot を参加させてください</b>（未参加のチャンネルには投稿できません）。</li>
          <li>変更は<b>次回の配信から</b>適用されます（配信時刻は各通知の説明のとおり）。</li>
        </ul>
        {channelListing && !channelListing.available && (
          <p><b>チャンネルの一覧を取得できないため、チャンネルIDを直接入力してください。</b>
            {channelListing.reason ? ` ${channelListing.reason}` : ""}</p>
        )}
        {/* 一覧は出せたが一部だけ（片方のスコープしか無い等）のときも、その旨を出す。 */}
        {channelListing?.available && channelListing.reason && <p>{channelListing.reason}</p>}
        {channelListing?.available && channelListing.truncated && (
          <p>チャンネルが多いため一覧は途中までです。見つからない場合はチャンネルIDを直接入力してください。</p>
        )}
      </div>
    )}
    {tab === "secrets" && !error && (
      <div className="settings-note" role="note">
        <strong>APIキーの登録について</strong>
        <ul>
          <li>保存先は <b>Secret Manager</b> です（アプリのデータベースには保存されません）。</li>
          <li>この画面は<b>書き込み専用</b>です。登録した値は二度と表示されません（登録状況のみ表示）。</li>
          <li><b>有効化済みの連携</b>には約1分以内に反映されます（キーのローテーションもデプロイ不要）。
            まだ有効化していない連携のキーは、先に登録しておけば<b>有効化デプロイ時</b>に自動で使われます。</li>
          <li>各連携の live/disabled 切替と Google Workspace SA 鍵（JSON）は、安全のためこの画面では扱いません。</li>
        </ul>
        {!secretsAvailable && <p><b>この環境では Secret Manager 未接続のため閲覧のみです（Cloud Run 上で利用できます）。</b></p>}
      </div>
    )}
    {loading ? <p className="hub-note">読み込み中…</p> :
      <div className="panel settings-form">
        {tab === "notifications" && notificationDefs.map((d) => {
          const enabled = parseEnabled(draft[d.enabledKey]);
          const channel = draft[d.channelKey] ?? "";
          // 一覧が取れていて、かつ選んだIDが一覧に無い場合（削除された・別ワークスペース）は
          // 選択肢に出せないため、直接入力へ落とす。設定済みの値を黙って捨てない。
          const listed = channelListing?.available === true;
          const known = !channel || channelListing?.channels.some((c) => c.id === channel);
          return <div key={d.id} className="settings-notification">
            <div className="settings-notification-head">
              <label className="settings-toggle">
                <input type="checkbox" checked={enabled} disabled={!canEdit}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [d.enabledKey]: e.target.checked ? "true" : "false" }))} />
                <b>{d.label}</b>
              </label>
              <small>{d.schedule}</small>
            </div>
            <p className="settings-notification-desc">{d.description}</p>
            <label className="settings-field">
              <span>投稿先チャンネル</span>
              {listed && known
                ? <div className="settings-channel-picker">
                    <input className="settings-channel-filter" placeholder="チャンネル名で絞り込み"
                      value={channelFilter[d.id] ?? ""} disabled={!canEdit || !enabled}
                      onChange={(e) => setChannelFilter((prev) => ({ ...prev, [d.id]: e.target.value }))} />
                    <select value={channel} disabled={!canEdit || !enabled}
                      onChange={(e) => setDraft((prev) => ({ ...prev, [d.channelKey]: e.target.value }))}>
                      <option value="">既定（法務相談チャンネル{fallbackChannel ? `：${fallbackChannel}` : "：未設定"}）</option>
                      {channelListing!.channels
                        // 選択中のチャンネルは、絞り込みに外れても選択肢から消さない（表示が空になるため）。
                        .filter((c) => c.id === channel || matchesChannelQuery(c, channelFilter[d.id] ?? ""))
                        .map((c) => <option key={c.id} value={c.id}>
                          {c.isPrivate ? "🔒 " : "# "}{c.name}{c.isMember ? "" : "（Bot 未参加）"}
                        </option>)}
                    </select>
                  </div>
                : <input maxLength={500} value={channel} placeholder={`既定（${fallbackChannel || "未設定"}）`}
                    disabled={!canEdit || !enabled}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [d.channelKey]: e.target.value }))} />}
              <small className="settings-effective">
                {enabled
                  ? `実際の投稿先: ${channel || fallbackChannel || "（未設定のため配信されません）"}`
                  : "この通知は停止中です。"}
              </small>
            </label>
          </div>;
        })}
        {(tab === "company" || tab === "integration") && activeFields.map((f) => <label key={f.key} className="settings-field">
          <span>{f.label}</span>
          <input maxLength={500} value={draft[f.key] ?? ""} placeholder={f.placeholder ?? ""} disabled={!canEdit}
            onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value }))} />
          {tab === "integration" && (
            <small className="settings-effective">
              現在の実効値: {effective[f.key] ? effective[f.key] : "（未設定）"}
            </small>
          )}
        </label>)}
        {tab === "secrets" && secretFields.map((f) => <label key={f.key} className="settings-field">
          <span>{f.label} <small className="settings-effective">（{statusLabel(f.key)}）</small></span>
          <input type="password" autoComplete="new-password"
            value={secretDraft[f.key] ?? ""}
            placeholder={secretStatuses[f.key]?.registered ? "新しい値で更新する場合のみ入力" : "値を貼り付け（保存後は表示されません）"}
            disabled={!secretsEditable}
            onChange={(e) => setSecretDraft((prev) => ({ ...prev, [f.key]: e.target.value }))} />
          {f.hint && <small className="settings-effective">{f.hint}</small>}
        </label>)}
        {canEdit && <div className="matter-form-actions">
          <button className="primary" disabled={saving || !dirty || (tab === "secrets" && !secretsEditable)}
            onClick={() => void (tab === "secrets" ? saveSecrets() : save())}>
            {saving ? "保存中…" : tab === "secrets" ? `保存（${secretChanged.length}件を Secret Manager へ）` : "保存"}
          </button>
        </div>}
      </div>}
  </section>;
}
