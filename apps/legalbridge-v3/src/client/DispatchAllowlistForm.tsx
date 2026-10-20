import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  ALLOWLIST_MODE_LABEL, DEFAULT_DISPATCH_ALLOWLIST, DISPATCH_ALLOWLIST_KEY,
  parseDispatchAllowlist, readDispatchAllowlist, type AllowlistMode, type DispatchAllowlistSettings
} from "../server/ops/dispatch-allowlist.js";

/**
 * 検証中の宛先許可リスト。送る（メール・CloudSign）前の関所が見る。
 * .env の DISPATCH_ALLOWLIST を上書きできる（保存した瞬間から効く。app の上げ直しは要らない）。
 */
export function DispatchAllowlistForm({ value, envAllowlist, onSaved }: {
  value: unknown; envAllowlist?: string[]; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<DispatchAllowlistSettings>(DEFAULT_DISPATCH_ALLOWLIST);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const v = readDispatchAllowlist(value);
    setDraft(v); setText(v.addresses.join(", "));
  }, [JSON.stringify(value)]);

  async function save() {
    const parsed = parseDispatchAllowlist({ mode: draft.mode, addresses: text });
    if (parsed.errors.length) { setError(parsed.errors.join(" ／ ")); return; }
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put(`/settings/${DISPATCH_ALLOWLIST_KEY}`, { value: parsed.value });
      setSaved(true); onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const modes: AllowlistMode[] = ["env", "list", "open"];
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>送る宛先の制限（検証中の許可リスト）</h2>
        <span className="faint">メール・CloudSign の to・cc・bcc・署名者を全員見る。1 人でも外にいれば送らない</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        <div className="stack" style={{ gap: 6 }}>
          {modes.map((m) => (
            <label key={m} className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="radio" name="allowlist-mode" checked={draft.mode === m} onChange={() => { setDraft({ ...draft, mode: m }); setSaved(false); }} />
              <span>{ALLOWLIST_MODE_LABEL[m]}</span>
              {m === "env" && <span className="faint">　いまの .env：{envAllowlist?.length ? envAllowlist.join(", ") : "（空＝制限なし）"}</span>}
            </label>
          ))}
        </div>
        <label className="field wide">
          <span>送ってよい宛先（カンマ区切り。「下の宛先だけ」のときに効く）</span>
          <input value={text} placeholder="me@example.com, keiri@example.com" disabled={draft.mode !== "list"}
                 onChange={(e) => { setText(e.target.value); setSaved(false); }} />
        </label>
        <div className="faint">
          複数の文書を 1 通で送るときは、cc に依頼者（または法務の担当）と「いつも cc で入れる宛先」が自動で入ります。cc がリストに無いと止まるので、
          検証中は cc を外すか、ここに足してください。
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>保存する</button>
          {saved && <span className="faint">保存しました。次に送るところから効きます（app の上げ直しは要りません）。</span>}
        </div>
      </div>
    </div>
  );
}
