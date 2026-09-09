import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 取引先の振込先。ここが唯一の編集場所。
 *
 * 移行してきた 2498 件のうち 460 件が口座番号か名義を欠いていて、そのままでは
 * 振り込めない（うち 383 件は名義だけが無い）。V1 の元データが同じ形だったので
 * 移し直しでは直らない。V3 に直す先を作った。
 *
 * 口座番号と名義は取引先の詳細（誰でも見られる）には出さない。この欄を開いた
 * ときだけ、admin / legal に絞った経路で取りに行く。
 */

const FIELDS = [
  { name: "bankName", label: "銀行名", placeholder: "みずほ銀行" },
  { name: "branchName", label: "支店名", placeholder: "神保町支店" },
  { name: "accountType", label: "口座種別", placeholder: "普通" },
  { name: "accountNumber", label: "口座番号", placeholder: "1234567" },
  { name: "accountHolderKana", label: "口座名義（カナ）", placeholder: "カ）アークライト" }
] as const;

type Field = (typeof FIELDS)[number]["name"];
type Account = Record<Field, string>;

const EMPTY: Account = {
  bankName: "", branchName: "", accountType: "",
  accountNumber: "", accountHolderKana: ""
};

/** 振り込むのに要る4つ。種別は書かない運用もあるので数えない。 */
const NEEDED: Field[] = ["bankName", "branchName", "accountNumber", "accountHolderKana"];

export function PartyBankAccount(
  { partyId, partyName, onSaved }: {
    partyId: number; partyName: string; onSaved?: () => void;
  }
) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Account>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // 取引先を切り替えたら閉じる。前の相手の口座を開いたまま残さない。
  useEffect(() => { setOpen(false); setLoaded(false); setNote(null); setError(null); }, [partyId]);

  useEffect(() => {
    if (!open || loaded) return;
    api.get<Account & { exists: boolean }>(`/parties/${partyId}/bank-account`)
      .then((r) => {
        setDraft(Object.fromEntries(
          FIELDS.map((f) => [f.name, r[f.name] ?? ""])) as Account);
        setLoaded(true);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [open, loaded, partyId]);

  const missing = NEEDED.filter((n) => !draft[n].trim());

  async function save() {
    setBusy(true); setError(null); setNote(null);
    try {
      await api.put(`/parties/${partyId}/bank-account`, draft);
      setNote("保存しました。次に作る書類から反映されます。");
      onSaved?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)}>振込先を見る・直す</button>
    );
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>振込先</h2>
        <span className="faint">{partyName}</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                onClick={() => setOpen(false)}>閉じる</button>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className="note ok">{note}</div>}
        {!loaded && !error && <div className="faint">読み込んでいます…</div>}

        {loaded && (<>
          {missing.length > 0 && (
            <div className="note warn">
              {missing.map((n) => FIELDS.find((f) => f.name === n)?.label).join("・")}
              {" "}が空です。この状態だと検収書や支払通知書の振込先が欠けたまま出ます。
            </div>
          )}
          <div className="form-grid">
            {FIELDS.map((f) => (
              <label key={f.name} className="field">
                <span>{f.label}</span>
                <input value={draft[f.name]} placeholder={f.placeholder} disabled={busy}
                       onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy}
                    onClick={() => void save()}>保存する</button>
            <span className="faint">
              変更は監査記録に残ります（口座番号そのものは残しません）。
              発行済みの書類は、そのときの値を焼き付けてあるので変わりません。
            </span>
          </div>
        </>)}
      </div>
    </div>
  );
}
