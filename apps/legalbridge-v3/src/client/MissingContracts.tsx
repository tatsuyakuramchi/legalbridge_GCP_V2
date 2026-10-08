import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 契約書の無い相手先（出版）。基本契約（出版許諾契約書）＋出版条件書をまとめて起こす。
 *
 * 条件書の無い条件を相手先ごとに集めて一覧にし、選んだ相手先に文書セットを
 * 相手先ごとに決定する。試算で必須の欄の不足を見てから決定する。
 * 1 相手先の失敗で他を止めない（結果に理由が残る）。
 * 共著の受取人（取り分を直接払う条件の、相手先以外の人）も 1 行に出る。受取人宛ての
 * 基本契約＋条件書を作る（計算書は受取人宛てに出るので、その番号が計算書に載る）。
 */
interface Party {
  key: string; role: "party" | "payee"; representatives?: string[];
  partyId: number; partyName: string; partyKind: string | null; email: string | null;
  master: { id: number; agreementNo: string | null; title: string } | null;
  conditions: Array<{ id: number; conditionNo: string | null; workTitle: string | null; usageType: string | null; hasTerms: boolean }>;
  missingTerms: number; missingWorks: number;
}
interface Outcome {
  key: string; role: "party" | "payee";
  partyId: number; partyName: string; status: "ok" | "missing" | "error" | "nothing"; problems: string[];
  plan: { master: "existing" | "create"; masterTemplateKey: string | null; termsTemplateKey: string; conditionIds: number[] } | null;
  result?: { agreement: { agreementNo: string | null; created: boolean } | null;
             documents: Array<{ role: string; templateKey: string; id: number; documentNo: string | null }>; error?: string } | null;
}
const STATUS: Record<Outcome["status"], string> = { ok: "作れる", missing: "必須の欄が空", error: "エラー", nothing: "対象なし" };
const today = () => new Date().toISOString().slice(0, 10);

export function MissingContracts({ onOpenDocument }: { onOpenDocument?: (id: number) => void }) {
  const readOnly = useReadOnly();
  const [parties, setParties] = useState<Party[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [signedOn, setSignedOn] = useState(today());
  const [preview, setPreview] = useState<Outcome[] | null>(null);
  const [done, setDone] = useState<{ outcomes: Outcome[]; issued: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setBusy("読んでいます"); setError(null);
    try { const r = await api.get<{ parties: Party[] }>("/document-sets/missing"); setParties(r.parties); setSelected(new Set()); setPreview(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  useEffect(() => { void load(); }, []);

  const keys = [...selected];
  async function tryIt() {
    setBusy("試算しています"); setError(null); setDone(null);
    try { setPreview((await api.post<{ outcomes: Outcome[] }>("/document-sets/missing/preview", { keys, signedOn })).outcomes); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setPreview(null); }
    finally { setBusy(null); }
  }
  async function run() {
    const okKeys = (preview ?? []).filter((o) => o.status === "ok").map((o) => o.key);
    if (!okKeys.length) return;
    if (!window.confirm(`${okKeys.length} 件の相手先・受取人に基本契約と条件書を決定します。番号が振られ、合意が立ちます。よいですか？`)) return;
    setBusy("決定しています"); setError(null);
    try {
      const r = await api.post<{ outcomes: Outcome[]; issued: number }>("/document-sets/missing/run", { keys: okKeys, signedOn });
      setDone(r); setPreview(null); await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  const toggleAll = (on: boolean) => setSelected(on ? new Set((parties ?? []).map((p) => p.key)) : new Set());

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>契約書の無い相手先（出版）</h2>
        <span className="faint">条件書に載っていない出版の条件を相手先ごとに。基本契約（出版許諾契約書）＋出版条件書をまとめて決定する</span>
      </div>
      <div className="panel-bd stack">
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label className="field"><span>締結日（両方の文書）</span>
            <input type="date" value={signedOn} onChange={(e) => { setSignedOn(e.target.value); setPreview(null); }} />
          </label>
          <button className="btn btn-sm" disabled={!!busy || !keys.length} onClick={() => void tryIt()}>選んだ {keys.length} 件を試算</button>
          {preview && !readOnly && (
            <button className="btn btn-sm primary" disabled={!!busy || !preview.some((o) => o.status === "ok")} onClick={() => void run()}>
              作れる {preview.filter((o) => o.status === "ok").length} 件を決定
            </button>
          )}
          <button className="btn btn-sm ghost" disabled={!!busy} onClick={() => void load()}>読み直す</button>
          {busy && <span className="faint">{busy}…</span>}
        </div>
        <div className="faint">
          基本契約が無い相手先は出版許諾契約書（個人／法人）を基本契約として作ります。条件書は作品が 12 点を超えると別紙形式。
          決定した条件書は基本契約の下の個別契約になります。送るのは文書の画面か「まとめて送る」から。
          「共著の受取人」は取り分を直接払う条件の、相手先以外の取り分の人です。受取人宛ての基本契約・条件書を作ります
          （条件は代表との契約のまま）。計算書は受取人宛てに出るので、その番号が載ります。
        </div>
        {error && <div className="alert">{error}</div>}
        {done && (
          <div className="notice">
            {done.issued} 件の相手先に決定しました。
            {done.outcomes.filter((o) => o.status !== "ok").length > 0 && <> 止まった相手先 {done.outcomes.filter((o) => o.status !== "ok").length} 件（下の表）。</>}
          </div>
        )}
        {(preview ?? done?.outcomes) && (
          <div className="tablewrap">
            <table>
              <thead><tr><th>相手先</th><th>判定</th><th>基本契約</th><th>条件書</th><th>理由・結果</th></tr></thead>
              <tbody>
                {(preview ?? done!.outcomes).map((o) => (
                  <tr key={o.key}>
                    <td>{o.partyName}{o.role === "payee" && <> <span className="tag">共著の受取人</span></>}</td>
                    <td><span className={`tag ${o.status === "ok" ? "ok" : o.status === "nothing" ? "" : "warn"}`}>{STATUS[o.status]}</span></td>
                    <td className="faint">{o.plan ? (o.plan.master === "existing" ? "既存を使う" : `作る（${o.plan.masterTemplateKey}）`) : "—"}</td>
                    <td className="faint">{o.plan ? `${o.plan.termsTemplateKey}（条件 ${o.plan.conditionIds.length} 本）` : "—"}</td>
                    <td>
                      {o.problems.map((p, i) => <div key={i} className="warn">{p}</div>)}
                      {o.result?.documents?.map((d) => (
                        <div key={d.id}>
                          {d.role === "master" ? "基本契約書" : "条件書"}：
                          {onOpenDocument ? <a href="#" onClick={(e) => { e.preventDefault(); onOpenDocument(d.id); }}>{d.documentNo ?? `#${d.id}`}</a> : (d.documentNo ?? `#${d.id}`)}
                        </div>
                      ))}
                      {o.result?.agreement && <div className="faint">基本契約 {o.result.agreement.agreementNo ?? ""}{o.result.agreement.created ? "（新規）" : ""}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" checked={!!parties?.length && selected.size === parties.length} onChange={(e) => toggleAll(e.target.checked)} /></th>
                <th>相手先</th><th>区分</th><th>メール</th><th>基本契約</th><th className="num">条件書の無い作品</th><th>作品</th>
              </tr>
            </thead>
            <tbody>
              {(parties ?? []).map((p) => {
                const missing = p.conditions.filter((c) => !c.hasTerms);
                const works = [...new Set(missing.map((c) => c.workTitle ?? c.conditionNo ?? `#${c.id}`))];
                return (
                  <tr key={p.key}>
                    <td><input type="checkbox" checked={selected.has(p.key)}
                      onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(p.key); else n.delete(p.key); setSelected(n); setPreview(null); }} /></td>
                    <td>
                      {p.partyName}
                      {p.role === "payee" && (
                        <div><span className="tag">共著の受取人</span>{p.representatives?.length ? <span className="faint"> 代表 {p.representatives.join("・")}</span> : null}</div>
                      )}
                    </td>
                    <td className="faint">{p.partyKind === "individual" ? "個人" : p.partyKind === "corporate" ? "法人" : "—"}</td>
                    <td>{p.email ? <span className="faint">{p.email}</span> : <span className="tag warn">未登録</span>}</td>
                    <td>{p.master ? <span className="faint">{p.master.agreementNo ?? p.master.title}</span> : <span className="tag">なし → 作る</span>}</td>
                    <td className="num">{p.missingWorks}</td>
                    <td className="faint" style={{ fontSize: "0.85em" }}>{works.slice(0, 6).join("、")}{works.length > 6 ? ` ほか ${works.length - 6}` : ""}</td>
                  </tr>
                );
              })}
              {parties && !parties.length && <tr><td colSpan={7} className="faint">条件書の無い出版の条件はありません</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
