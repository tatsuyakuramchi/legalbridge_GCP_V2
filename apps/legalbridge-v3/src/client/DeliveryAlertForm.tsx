import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  DEFAULT_DELIVERY_ALERT, DELIVERY_ALERT_FIELDS, DELIVERY_ALERT_KEY,
  parseDeliveryAlertSettings, readDeliveryAlertSettings, type DeliveryAlertSettings
} from "../server/ops/delivery-alert-settings.js";

/**
 * 納期アラートの設定。知らせる内容（何日前・超過・文面）と送り先（依頼者・担当・
 * チャンネル・部署ごとのチャンネル）をここで変える。
 *
 * 定義はサーバと同じもの（ops/delivery-alert-settings.ts）を読む。保存前に同じ規則で
 * 確かめ、サーバでももう一度確かめる。
 */

interface PreviewAlert {
  key: string; kind: "before" | "overdue"; matterNo: string | null; due: string;
  daysUntil: number; recipients: string[]; body?: string;
}
interface Preview {
  date: string; pending: number; alerts: PreviewAlert[]; alreadySent: number;
  noRecipient: Array<{ conditionId: number; matterNo: string | null; due: string }>;
}

export function DeliveryAlertForm({ value, onSaved }: { value: unknown; onSaved: () => void }) {
  const [draft, setDraft] = useState<DeliveryAlertSettings>(DEFAULT_DELIVERY_ALERT);
  const [daysText, setDaysText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    const v = readDeliveryAlertSettings(value);
    setDraft(v);
    setDaysText(v.daysBefore.join(", "));
  }, [JSON.stringify(value)]);

  const set = (patch: Partial<DeliveryAlertSettings>) => { setDraft({ ...draft, ...patch }); setSaved(false); };
  const withDays = (): DeliveryAlertSettings => ({
    ...draft,
    daysBefore: daysText.split(/[,、\s]+/).filter(Boolean).map(Number)
  });

  async function save() {
    const parsed = parseDeliveryAlertSettings(withDays());
    if (parsed.errors.length) { setError(parsed.errors.join(" ／ ")); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put(`/settings/${DELIVERY_ALERT_KEY}`, { value: parsed.value });
      setSaved(true);
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function loadPreview() {
    setBusy(true); setError(null);
    try { setPreview(await api.get<Preview>("/jobs/delivery-alert/preview")); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const check = (label: string, on: boolean, patch: (v: boolean) => Partial<DeliveryAlertSettings>) => (
    <label className="row" style={{ gap: 6 }}>
      <input type="checkbox" checked={on} onChange={(e) => set(patch(e.target.checked))} />
      <span>{label}</span>
    </label>
  );

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>納期アラート</h2>
        <span className="faint">発注したものの納期が近い・過ぎているときに Slack で知らせます（毎朝）</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}

        {check("納期アラートを送る", draft.enabled, (v) => ({ enabled: v }))}

        <h3>知らせる内容</h3>
        <div className="form-grid">
          <label className="field">
            <span>納期の何日前に知らせるか</span>
            <input value={daysText} placeholder="7, 3, 1"
                   onChange={(e) => { setDaysText(e.target.value); setSaved(false); }} />
          </label>
          <label className="field">
            <span>超過を知らせ続ける日数（0 = 納品まで毎回）</span>
            <input type="number" min={0} max={365} value={draft.overdueUntilDays}
                   onChange={(e) => set({ overdueUntilDays: Number(e.target.value) })} />
          </label>
        </div>
        {check("納期を過ぎたら知らせる", draft.overdue, (v) => ({ overdue: v }))}
        {check("超過は平日だけ知らせる", draft.overdueWeekdaysOnly, (v) => ({ overdueWeekdaysOnly: v }))}

        <label className="field wide">
          <span>納期前の文面</span>
          <textarea rows={6} value={draft.templates.before}
                    onChange={(e) => set({ templates: { ...draft.templates, before: e.target.value } })} />
        </label>
        <label className="field wide">
          <span>超過の文面</span>
          <textarea rows={6} value={draft.templates.overdue}
                    onChange={(e) => set({ templates: { ...draft.templates, overdue: e.target.value } })} />
        </label>
        <div className="faint">
          差し込めるもの：{DELIVERY_ALERT_FIELDS.map((f) => (
            <span key={f.name} title={f.label}><span className="code">{`{${f.name}}`}</span>（{f.label}）　</span>
          ))}
          <br />Slack の書式（<span className="code">*太字*</span>・改行）がそのまま使えます。
          <button className="btn" style={{ marginLeft: 8 }}
                  onClick={() => set({ templates: DEFAULT_DELIVERY_ALERT.templates })}>文面を既定に戻す</button>
        </div>

        <h3>送り先</h3>
        {check("案件の依頼者に DM する", draft.notifyRequester, (v) => ({ notifyRequester: v }))}
        {check("案件の担当（法務）に DM する", draft.notifyOwner, (v) => ({ notifyOwner: v }))}

        <div className="field wide">
          <span>いつも送るチャンネル</span>
          <table>
            <thead><tr><th>チャンネル ID</th><th>メモ（チャンネル名など）</th><th /></tr></thead>
            <tbody>
              {draft.channels.map((c, i) => (
                <tr key={i}>
                  <td><input value={c.id} placeholder="C0123ABCD"
                             onChange={(e) => set({ channels: draft.channels.map((x, j) => j === i ? { ...x, id: e.target.value.trim() } : x) })} /></td>
                  <td><input value={c.label} placeholder="#legal-alerts"
                             onChange={(e) => set({ channels: draft.channels.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} /></td>
                  <td><button className="btn" onClick={() => set({ channels: draft.channels.filter((_, j) => j !== i) })}>外す</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn" onClick={() => set({ channels: [...draft.channels, { id: "", label: "" }] })}>チャンネルを足す</button>
        </div>

        <div className="field wide">
          <span>依頼者の部署ごとに送るチャンネル</span>
          <table>
            <thead><tr><th>部署（職員の「部署」と同じ書き方）</th><th>チャンネル ID</th><th /></tr></thead>
            <tbody>
              {draft.departmentChannels.map((c, i) => (
                <tr key={i}>
                  <td><input value={c.department} placeholder="制作部"
                             onChange={(e) => set({ departmentChannels: draft.departmentChannels.map((x, j) => j === i ? { ...x, department: e.target.value } : x) })} /></td>
                  <td><input value={c.id} placeholder="C0123ABCD"
                             onChange={(e) => set({ departmentChannels: draft.departmentChannels.map((x, j) => j === i ? { ...x, id: e.target.value.trim() } : x) })} /></td>
                  <td><button className="btn" onClick={() => set({ departmentChannels: draft.departmentChannels.filter((_, j) => j !== i) })}>外す</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn" onClick={() => set({ departmentChannels: [...draft.departmentChannels, { department: "", id: "" }] })}>部署を足す</button>
        </div>
        <div className="faint">
          チャンネル ID は Slack でチャンネル名を右クリック →「チャンネル詳細を表示」の一番下にあります。
          アプリ（LegalBridge）をそのチャンネルに招待しておかないと届きません。
        </div>

        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>保存する</button>
          <button className="btn" onClick={() => void loadPreview()} disabled={busy}>今日なら何を送るか見る</button>
          {saved && <span className="faint">保存しました。次の朝の実行から反映されます。</span>}
        </div>

        {preview && (
          <div className="stack">
            <div className="faint">
              {preview.date} 時点：納期の近い・過ぎた未納品 {preview.pending} 件のうち、今日知らせるもの {preview.alerts.length} 件
              {preview.alreadySent ? `（今日送信済み ${preview.alreadySent} 件）` : ""}。保存前の変更は反映されていません。
            </div>
            {preview.noRecipient.length > 0 && (
              <div className="note">
                送り先が無いため知らせられないものが {preview.noRecipient.length} 件あります
                （{preview.noRecipient.slice(0, 5).map((n) => n.matterNo ?? `条件 #${n.conditionId}`).join("・")}…）。
                チャンネルを足すか、案件に依頼者を入れてください。
              </div>
            )}
            <div className="tablewrap">
              <table>
                <thead><tr><th>案件</th><th>納期</th><th>種類</th><th>送り先</th><th>文面</th></tr></thead>
                <tbody>
                  {preview.alerts.map((a) => (
                    <tr key={a.key}>
                      <td className="code">{a.matterNo ?? "—"}</td>
                      <td className="code">{a.due}</td>
                      <td>{a.kind === "before" ? `あと ${a.daysUntil} 日` : `超過 ${-a.daysUntil} 日`}</td>
                      <td className="code">{a.recipients.join(", ")}</td>
                      <td style={{ whiteSpace: "pre-wrap" }}>{a.body}</td>
                    </tr>
                  ))}
                  {preview.alerts.length === 0 && <tr><td colSpan={5} className="faint">今日知らせるものはありません</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
