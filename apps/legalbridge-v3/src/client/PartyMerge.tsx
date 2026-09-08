import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

interface Row {
  id: number; partyCode: string | null; name: string; kind: string; status: string;
  invoiceNo: string | null; corporateNo: string | null;
  conditions: number; payments: number; agreements: number; matters: number;
}
interface Candidate { keyName: string; parties: Row[] }
interface Preview {
  from: { id: number; name: string; partyCode: string | null };
  into: { id: number; name: string; partyCode: string | null };
  moves: { conditions: number; payments: number; agreements: number; matters: number };
  blockers: string[]; warnings: string[];
}

/**
 * 取引先の名寄せ。
 *
 * 参照は付け替えず、統合先まで辿って解決する。取り消せるので、
 * 迷ったら統合してよい。ただし区分（法人/個人）が違うものは統合できない。
 */
export function PartyMerge({ onDone }: { onDone: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [from, setFrom] = useState<Row | null>(null);
  const [into, setInto] = useState<Row | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    api.get<{ candidates: Candidate[] }>("/parties/merge/candidates")
      .then((r) => setCandidates(r.candidates))
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(reload, []);

  useEffect(() => {
    if (!from || !into || from.id === into.id) { setPreview(null); return; }
    api.get<Preview>(`/parties/merge/preview?fromId=${from.id}&intoId=${into.id}`)
      .then(setPreview).catch((e: ApiError) => { setPreview(null); setError(e.message); });
  }, [from, into]);

  async function merge() {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      await api.post("/parties/merge", { fromId: preview.from.id, intoId: preview.into.id });
      setNotice(`${preview.from.name} を ${preview.into.name} に統合しました。取り消せます`);
      setFrom(null); setInto(null); setPreview(null);
      reload(); onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const total = (r: Row) => r.conditions + r.payments + r.agreements + r.matters;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>名寄せ</h2>
        <span className="faint">同名・同カナ・同法人番号 {candidates.length} 組</span>
      </div>
      <div className="panel-bd">
        <p className="faint">
          統合しても参照は付け替えない。条件も支払も統合前の相手先を指したままで、
          表示と集計だけが統合先を通る。だから<b>あとから取り消せる</b>。
          表記ゆれの推測はしないので、ここに出るのは完全に一致したものだけ。
        </p>

        {notice && <div className="alert">{notice}</div>}
        {error && <div className="alert">{error}</div>}

        {preview && (
          <div className="panel" style={{ margin: "12px 0" }}>
            <div className="panel-hd"><h3>統合の確認</h3></div>
            <div className="panel-bd">
              <p>
                <b>{preview.from.name}</b>（{preview.from.partyCode ?? `#${preview.from.id}`}）を{" "}
                <b>{preview.into.name}</b>（{preview.into.partyCode ?? `#${preview.into.id}`}）へ統合する。
              </p>
              <p className="faint">
                統合先を通して見えるようになるもの：
                条件 {preview.moves.conditions} ／ 支払 {preview.moves.payments} ／
                合意 {preview.moves.agreements} ／ 案件 {preview.moves.matters}
              </p>
              {preview.blockers.map((b) => (
                <div key={b} className="alert"><b>統合できません：</b>{b}</div>
              ))}
              {preview.warnings.map((w) => (
                <div key={w} className="note">確認：{w}</div>
              ))}
              <div className="row">
                <button className="btn primary" disabled={busy || preview.blockers.length > 0}
                        onClick={merge}>統合する</button>
                <button className="btn" onClick={() => { setFrom(null); setInto(null); }}>やめる</button>
              </div>
            </div>
          </div>
        )}

        {!candidates.length && <p className="faint">候補はありません。</p>}

        {candidates.map((c) => (
          <div key={c.keyName} className="report-group">
            <div className="report-group-hd">
              <b>{c.keyName}</b><span className="faint">{c.parties.length} 件</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>コード</th><th>名称</th><th>区分</th>
                    <th className="num">条件</th><th className="num">支払</th>
                    <th className="num">合意</th><th className="num">案件</th>
                    <th>インボイス</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {c.parties.map((p) => (
                    <tr key={p.id} className={from?.id === p.id || into?.id === p.id ? "sel" : ""}>
                      <td className="code">{p.partyCode ?? `#${p.id}`}</td>
                      <td>{p.name}</td>
                      <td>{p.kind === "individual" ? "個人" : "法人"}</td>
                      <td className="num">{p.conditions}</td>
                      <td className="num">{p.payments}</td>
                      <td className="num">{p.agreements}</td>
                      <td className="num">{p.matters}</td>
                      <td className="faint">{p.invoiceNo ?? "—"}</td>
                      <td>
                        <span className="row">
                          <button className="btn btn-sm" aria-pressed={from?.id === p.id}
                                  onClick={() => setFrom(p)}>統合元</button>
                          <button className="btn btn-sm" aria-pressed={into?.id === p.id}
                                  onClick={() => setInto(p)}>統合先</button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="faint">
              参照の多いほうを統合先にすると、辿る手間が少なくて済む
              （この組の最多は {Math.max(...c.parties.map(total))} 件）。
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
