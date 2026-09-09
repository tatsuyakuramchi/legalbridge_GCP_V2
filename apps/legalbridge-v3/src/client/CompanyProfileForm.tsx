import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  COMPANY_PROFILE_FIELDS, COMPANY_PROFILE_REQUIRED
} from "../server/ops/company-profile.js";

/**
 * 自社情報。書類の差込元。
 *
 * これまで settings に読む側しか無く、入れる画面が無かった。V1 の
 * app_settings に入っていなかった項目（電話番号・FAX・振込先・捺印備考）は、
 * 移行しても空のままで、埋める手段がどこにも無かった。
 *
 * 項目とラベルはサーバ側の定義から引く。二重に書くと必ずずれる。
 */
export function CompanyProfileForm(
  { value, onSaved }: { value: unknown; onSaved: () => void }
) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // 保存後の再読み込みでも上書きされるよう、渡ってきた値で組み直す。
  useEffect(() => {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    setDraft(Object.fromEntries(
      COMPANY_PROFILE_FIELDS.map((f) => [f.name, String(source[f.name] ?? "")])));
  }, [JSON.stringify(value)]);

  const empty = COMPANY_PROFILE_REQUIRED.filter((n) => !String(draft[n] ?? "").trim());

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.put("/settings/company_profile", { value: draft });
      setSaved(true);
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>自社情報</h2>
        <span className="faint">発注書・検収書・計算書に差し込まれます</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {empty.length > 0 && (
          <div className="note">
            {empty.map((n) => COMPANY_PROFILE_FIELDS.find((f) => f.name === n)?.label).join("・")}
            {" "}が空です。この項目は書類の本文に出るので、空のまま発行すると相手に渡る紙が欠けます。
          </div>
        )}

        <div className="form-grid">
          {COMPANY_PROFILE_FIELDS.map((f) => (
            <label key={f.name} className={`field${f.long ? " wide" : ""}`}>
              <span>
                {f.label}
                {COMPANY_PROFILE_REQUIRED.includes(f.name) && <b className="req"> 必須</b>}
              </span>
              {f.long
                ? <textarea rows={2} value={draft[f.name] ?? ""} placeholder={f.placeholder}
                            onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })} />
                : <input value={draft[f.name] ?? ""} placeholder={f.placeholder}
                         onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })} />}
            </label>
          ))}
        </div>

        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            保存する
          </button>
          {saved && <span className="faint">保存しました。次に作る書類から反映されます。</span>}
        </div>
        <div className="faint">
          発行済みの書類は、そのときの値を焼き付けてあるので変わりません。
        </div>
      </div>
    </div>
  );
}
