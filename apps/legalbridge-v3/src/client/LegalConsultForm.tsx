import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  LEGAL_CONSULT_KEY, parseLegalConsultSettings, readLegalConsultSettings, type LegalConsultSettings
} from "../server/ops/legal-consult-settings.js";

/**
 * 法務相談窓口（Slack のチャンネル）。案件の「Slack で送る」で「法務相談窓口へ」を
 * 選ぶと、このチャンネルに案件ごとのスレッドを立てて送る。
 */
export function LegalConsultForm({ value, onSaved }: { value: unknown; onSaved: () => void }) {
  const [draft, setDraft] = useState<LegalConsultSettings>(readLegalConsultSettings(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setDraft(readLegalConsultSettings(value)); }, [JSON.stringify(value)]);
  const set = (patch: Partial<LegalConsultSettings>) => { setDraft({ ...draft, ...patch }); setSaved(false); };

  async function save() {
    const parsed = parseLegalConsultSettings(draft);
    if (parsed.errors.length) { setError(parsed.errors.join(" ／ ")); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put(`/settings/${LEGAL_CONSULT_KEY}`, { value: parsed.value });
      setSaved(true);
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>法務相談窓口（Slack）</h2>
        <span className="faint">案件の「Slack で送る」から、このチャンネルに案件ごとのスレッドを立てて送ります</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        <div className="form-grid">
          <label className="field">
            <span>チャンネル ID</span>
            <input value={draft.channelId} placeholder="C0123ABCD"
                   onChange={(e) => set({ channelId: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>呼び名（画面に出す）</span>
            <input value={draft.label} placeholder="#法務相談窓口"
                   onChange={(e) => set({ label: e.target.value })} />
          </label>
        </div>
        <div className="faint">
          チャンネル ID はチャンネル名を右クリック →「チャンネル詳細を表示」の一番下にあります（C で始まる英数字）。
          LegalBridge の Slack アプリをそのチャンネルに招待しておいてください（招待していないと
          <span className="code">not_in_channel</span> で送れません）。空にすると窓口へは送れなくなります。
        </div>
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => void save()}>保存</button>
          {saved && <span className="faint">保存しました</span>}
        </div>
      </div>
    </div>
  );
}
