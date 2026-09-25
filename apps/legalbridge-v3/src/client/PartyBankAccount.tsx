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

/**
 * 海外送金の項目（A-051）。海外版の発注書の Bank Account 欄に出る。
 * 例はすべて架空の値。
 */
const OVERSEAS_FIELDS = [
  { name: "bankName", label: "Bank name（銀行名）", placeholder: "Example Bank N.A." },
  { name: "branchName", label: "Branch（支店・任意）", placeholder: "Main Branch" },
  { name: "accountHolderName", label: "Beneficiary（受取人名・英字）", placeholder: "EXAMPLE STUDIO LLC" },
  { name: "accountNumber", label: "Account No.（口座番号）", placeholder: "000123456789" },
  { name: "iban", label: "IBAN（欧州など）", placeholder: "GB00EXAM00000000000000" },
  { name: "swiftBic", label: "SWIFT/BIC", placeholder: "EXAMUS33" },
  { name: "routingNumber", label: "Routing No.（米国 ABA など・任意）", placeholder: "000000000" },
  { name: "bankCountry", label: "Bank country（国コード 2 文字）", placeholder: "US" },
  { name: "currency", label: "Currency（受取通貨・任意）", placeholder: "USD" },
  { name: "bankAddress", label: "Bank address（銀行の住所・任意）", placeholder: "1 Example Street, New York, NY" },
  { name: "intermediaryBankName", label: "Intermediary bank（中継銀行・任意）", placeholder: "" },
  { name: "intermediaryBankSwift", label: "Intermediary SWIFT（任意）", placeholder: "" }
] as const;

type Field = (typeof FIELDS)[number]["name"] | (typeof OVERSEAS_FIELDS)[number]["name"];
type Account = Record<Field, string>;
type Scope = "domestic" | "overseas";

const EMPTY: Account = {
  bankName: "", branchName: "", accountType: "",
  accountNumber: "", accountHolderKana: "",
  accountHolderName: "", swiftBic: "", iban: "", routingNumber: "",
  bankCountry: "", bankAddress: "", currency: "",
  intermediaryBankSwift: "", intermediaryBankName: ""
};
const ALL_FIELDS = Object.keys(EMPTY) as Field[];
const OVERSEAS_ONLY: Field[] = ["accountHolderName", "swiftBic", "iban", "routingNumber",
  "bankCountry", "bankAddress", "currency", "intermediaryBankSwift", "intermediaryBankName"];

/** 振り込むのに要る4つ。種別は書かない運用もあるので数えない。 */
const NEEDED: Field[] = ["bankName", "branchName", "accountNumber", "accountHolderKana"];

/** 海外送金に要るもの。口座番号か IBAN のどちらか。 */
function missingOverseas(d: Account): string[] {
  const out: string[] = [];
  if (!d.bankName.trim()) out.push("銀行名");
  if (!d.accountHolderName.trim()) out.push("受取人名");
  if (!d.accountNumber.trim() && !d.iban.trim()) out.push("口座番号か IBAN");
  if (!d.swiftBic.trim()) out.push("SWIFT/BIC");
  return out;
}

export function PartyBankAccount(
  { partyId, partyName, onSaved }: {
    partyId: number; partyName: string; onSaved?: () => void;
  }
) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Account>(EMPTY);
  const [scope, setScope] = useState<Scope>("domestic");
  // 海外の列（A-051）があるデータベースか。無ければ国内の5項目だけ扱う。
  const [overseasReady, setOverseasReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // 取引先を切り替えたら閉じる。前の相手の口座を開いたまま残さない。
  useEffect(() => { setOpen(false); setLoaded(false); setNote(null); setError(null); }, [partyId]);

  useEffect(() => {
    if (!open || loaded) return;
    api.get<Partial<Record<Field, string | null>> & {
      exists: boolean; accountScope?: string | null; overseasReady?: boolean;
    }>(`/parties/${partyId}/bank-account`)
      .then((r) => {
        setDraft(Object.fromEntries(ALL_FIELDS.map((n) => [n, r[n] ?? ""])) as Account);
        setScope(r.accountScope === "overseas" ? "overseas" : "domestic");
        setOverseasReady(Boolean(r.overseasReady));
        setLoaded(true);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [open, loaded, partyId]);

  const overseas = overseasReady && scope === "overseas";
  const missing = overseas
    ? missingOverseas(draft)
    : NEEDED.filter((n) => !draft[n].trim())
        .map((n) => FIELDS.find((f) => f.name === n)?.label ?? n);
  const shown = overseas ? OVERSEAS_FIELDS : FIELDS;

  async function save() {
    setBusy(true); setError(null); setNote(null);
    try {
      // 海外の列が無いデータベースには国内の5項目だけ送る。
      const body: Record<string, string> = overseasReady
        ? { ...draft, accountScope: scope }
        : Object.fromEntries(ALL_FIELDS.filter((n) => !OVERSEAS_ONLY.includes(n))
            .map((n) => [n, draft[n]]));
      await api.put(`/parties/${partyId}/bank-account`, body);
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
          {overseasReady && (
            <div className="row">
              <label className={`opt${scope === "domestic" ? " on" : ""}`}>
                <input type="radio" name={`bank-scope-${partyId}`} checked={scope === "domestic"}
                       disabled={busy} onChange={() => setScope("domestic")} /> 国内の口座
              </label>
              <label className={`opt${scope === "overseas" ? " on" : ""}`}>
                <input type="radio" name={`bank-scope-${partyId}`} checked={scope === "overseas"}
                       disabled={busy} onChange={() => setScope("overseas")} /> 海外の口座（海外送金）
              </label>
            </div>
          )}
          {missing.length > 0 && (
            <div className="note warn">
              {missing.join("・")}
              {" "}が空です。{overseas
                ? "この状態だと海外版の発注書の Bank Account 欄が欠けたまま出ます。"
                : "この状態だと検収書や支払通知書の振込先が欠けたまま出ます。"}
            </div>
          )}
          {overseas && (
            <div className="faint">
              海外版の発注書（Bank Account 欄）に英語で出ます。国コード・通貨は英字の略号で
              （例 US・USD）。SWIFT と IBAN は保存時に大文字へ揃えます。
            </div>
          )}
          <div className="form-grid">
            {shown.map((f) => (
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
