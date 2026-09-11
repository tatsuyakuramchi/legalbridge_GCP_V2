import { useState } from "react";
import { StatusTag } from "./labels.js";
import { api, ApiError } from "./api.js";

type Verdict = "covered" | "expiring" | "expired" | "none" | "ambiguous";
interface Result {
  query: string; verdict: Verdict; message: string; needsLegalReview: boolean;
  matches: Array<{ partyId: number; partyName: string; partyCode: string | null; matchedOn: string }>;
  agreements: Array<{
    id: number; agreementNo: string | null; title: string; status: string;
    effectiveOn: string | null; expiresOn: string | null; autoRenewal: boolean;
    daysToExpiry: number | null;
  }>;
  conditions: Array<{
    id: number; conditionNo: string | null; name: string; direction: string;
    status: string; termStart: string | null; termEnd: string | null;
  }>;
}

const VERDICT: Record<Verdict, { label: string; tone: string }> = {
  covered: { label: "契約あり", tone: "good" },
  expiring: { label: "まもなく満了", tone: "warn" },
  expired: { label: "満了済み", tone: "danger" },
  none: { label: "契約なし", tone: "danger" },
  ambiguous: { label: "候補が複数", tone: "warn" }
};

/**
 * 契約チェック。依頼の前に「この相手と契約があるか」を自分で確かめる。
 * 判定は保守的にしてある（「たぶん大丈夫」は返さない）。
 */
export function ContractCheck() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setError(null);
    try { setResult(await api.get<Result>(`/contract-check?q=${encodeURIComponent(query)}`)); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>契約チェック</h2>
        <span className="faint">発注の前に自分で確かめる</span>
      </div>
      <div className="panel-bd">
        <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: 240 }}>
            <span>相手先の名前</span>
            <input value={query} placeholder="株式会社◯◯"
                   onChange={(e) => setQuery(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter" && query.trim()) void run(); }} />
          </label>
          <button className="btn primary" onClick={run} disabled={busy || !query.trim()}>
            {busy ? "確認中…" : "確かめる"}
          </button>
        </div>

        {error && <div className="alert">{error}</div>}

        {result && (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ gap: 10, alignItems: "center" }}>
              <span className={`tag ${VERDICT[result.verdict].tone}`}>
                {VERDICT[result.verdict].label}
              </span>
              <b>{result.message}</b>
            </div>
            {result.needsLegalReview && (
              <div className="alert">この内容では発注できません。法務に相談してください。</div>
            )}

            {result.verdict === "ambiguous" && (
              <div className="tablewrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>コード</th><th>名称</th><th>一致した理由</th></tr></thead>
                  <tbody>
                    {result.matches.map((m) => (
                      <tr key={m.partyId}>
                        <td className="code">{m.partyCode ?? `#${m.partyId}`}</td>
                        <td>
                          <button className="btn btn-sm"
                                  onClick={() => { setQuery(m.partyName); }}>
                            {m.partyName}
                          </button>
                        </td>
                        <td className="faint">{m.matchedOn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.agreements.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>契約</h3>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr><th>番号</th><th>件名</th><th>状態</th><th>発効</th><th>満了</th><th>残り</th></tr>
                    </thead>
                    <tbody>
                      {result.agreements.map((a) => (
                        <tr key={a.id} className={(a.daysToExpiry ?? 1) < 0 ? "overdue" : undefined}>
                          <td className="code">{a.agreementNo ?? `#${a.id}`}</td>
                          <td>{a.title}</td>
                          <td><StatusTag kind="agreement" value={a.status} /></td>
                          <td className="code">{a.effectiveOn ?? "—"}</td>
                          <td className="code">{a.expiresOn ?? "定めなし"}</td>
                          <td className="num">
                            {a.daysToExpiry === null ? "—"
                              : a.daysToExpiry < 0 ? `${-a.daysToExpiry} 日超過`
                              : `${a.daysToExpiry} 日`}
                            {a.autoRenewal && <span className="faint"> 自動更新</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {result.conditions.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>有効な条件 {result.conditions.length}</h3>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>番号</th><th>条件名</th><th>向き</th><th>開始</th><th>終了</th></tr></thead>
                    <tbody>
                      {result.conditions.map((c) => (
                        <tr key={c.id}>
                          <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                          <td>{c.name}</td>
                          <td>{c.direction === "in" ? "IN 取得" : "OUT 許諾"}</td>
                          <td className="code">{c.termStart ?? "—"}</td>
                          <td className="code">{c.termEnd ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
