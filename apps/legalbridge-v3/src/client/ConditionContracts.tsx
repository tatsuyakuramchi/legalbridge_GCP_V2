import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 条件明細の「基本契約」と「個別契約」。条件詳細の上に出す。
 *
 * これまで基本契約は「つながり」の「契約（合意）」、個別契約（条件書）は「文書」の
 * 一覧に紛れていて、計算書の「契約番号」がどれから出るのか読めなかった。
 * ここで 2 つを並べ、紙に出る契約番号もその場で見せる。付け替えは同じ繋ぎ（/links）を使う。
 */

interface Agreement { id: number; no: string | null; title: string; kind: string; status: string }
interface Terms { id: number; no: string | null; label: string; status: string; issuedOn: string | null; agreementNo: string | null; used: boolean }
interface Contracts {
  agreement: Agreement | null; master: Agreement | null; terms: Terms[]; contractRef: string;
  candidates: { masters: Agreement[]; terms: Terms[] };
}

const KIND_LABEL: Record<string, string> = { master: "基本契約", standalone: "単体契約", supplement: "個別契約・覚書", termination: "解除合意", document: "文書" };
const STATUS_LABEL: Record<string, string> = { issued: "決定済", draft: "下書き", superseded: "訂正版あり", reserved: "番号のみ" };

export function ConditionContracts({ conditionId, onOpen, onChanged }: {
  conditionId: number;
  onOpen?: (kind: "agreement" | "document", id: number) => void;
  onChanged?: () => void;
}) {
  const [c, setC] = useState<Contracts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickMaster, setPickMaster] = useState(false);
  const [pickTerms, setPickTerms] = useState(false);

  const load = () => api.get<Contracts>(`/conditions/${conditionId}/contracts`)
    .then((r) => { setC(r); setError(null); }).catch((e: ApiError) => setError(e.message));
  useEffect(() => { void load(); setPickMaster(false); setPickTerms(false); }, [conditionId]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await load(); onChanged?.(); setPickMaster(false); setPickTerms(false); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const setMaster = (id: number | null) => run(() => id
    ? api.post(`/links/condition/${conditionId}/agreement`, { targetId: id })
    : api.del(`/links/condition/${conditionId}/agreement/${c?.agreement?.id}`));
  const addTerms = (id: number) => run(() => api.post(`/links/condition/${conditionId}/documents`, { targetId: id }));
  const removeTerms = (t: Terms) => {
    if (!window.confirm(`${t.no ?? t.label} をこの条件の個別契約から外します（文書は消えません）。`)) return;
    void run(() => api.del(`/links/condition/${conditionId}/documents/${t.id}`));
  };

  if (!c) return error ? <div className="alert">{error}</div> : null;
  const used = c.terms.find((t) => t.used) ?? null;
  const viaSupplement = c.agreement && c.master && c.agreement.id !== c.master.id;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>契約の紐づけ</h2>
        <span className="faint">基本契約と個別契約（条件書）。計算書の「契約番号」は両方の番号、発注書・条件書の基本契約欄は基本契約の番号</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 10 }}>
        {error && <div className="alert">{error}</div>}

        <div className="note" style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="faint">計算書に出る契約番号</span>
          <b className="code">{c.contractRef || "（なし）"}</b>
          <span className="faint">＝ 基本契約{used ? " / 個別契約の文書番号" : ""}。下を変えると、これから作る文書と下書きのプレビューに反映されます（決定済みの文書は変わりません）</span>
        </div>

        {/* 基本契約 */}
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}>
            <b>基本契約</b>
            <span className="faint">この条件が明細として載っている契約</span>
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setPickMaster(!pickMaster)}>
              {pickMaster ? "やめる" : c.master ? "付け替える" : "選ぶ"}
            </button>
          </div>
          {c.master ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="code">{c.master.no ?? `#${c.master.id}`}</span>
              <span>{c.master.title}</span>
              <span className="tag">{KIND_LABEL[c.master.kind] ?? c.master.kind}</span>
              {onOpen && <button className="btn btn-sm" onClick={() => onOpen("agreement", c.master!.id)}>開く</button>}
              {!viaSupplement && <button className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm("基本契約から外します。")) void setMaster(null); }}>外す</button>}
            </div>
          ) : <span className="faint">どの基本契約にも載っていません。基本契約が無い単発の許諾なら空のままで構いません。</span>}
          {viaSupplement && (
            <span className="faint">条件は補助文書 {c.agreement!.no ?? `#${c.agreement!.id}`}（{c.agreement!.title}）に載っています。基本契約はその親です。</span>
          )}
          {pickMaster && (
            <div className="picker">
              {c.candidates.masters.length === 0 && <span className="faint">この相手先・向きの基本契約がありません。契約の画面で作ってから選んでください。</span>}
              {c.candidates.masters.map((a) => (
                <div key={a.id} className="pick">
                  <span className="code">{a.no ?? `#${a.id}`}</span><span>{a.title}</span>
                  <span className="faint">{KIND_LABEL[a.kind] ?? a.kind}</span>
                  <button className="btn btn-sm primary" style={{ marginLeft: "auto" }} disabled={busy || a.id === c.master?.id}
                          onClick={() => void setMaster(a.id)}>{a.id === c.master?.id ? "いまの基本契約" : "これにする"}</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 個別契約 */}
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}>
            <b>個別契約（条件書）</b>
            <span className="faint">この条件を載せた個別利用許諾条件書・出版条件書、取り込んだ利用許諾契約書・覚書</span>
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setPickTerms(!pickTerms)}>
              {pickTerms ? "やめる" : "繋ぐ"}
            </button>
          </div>
          {c.terms.length ? (
            <div className="picker">
              {c.terms.map((t) => (
                <div key={t.id} className="pick">
                  <span className="code">{t.no ?? `#${t.id}`}</span><span>{t.label}</span>
                  <span className="faint">{STATUS_LABEL[t.status] ?? t.status}{t.issuedOn ? ` · ${t.issuedOn}` : ""}{t.agreementNo ? ` · 合意 ${t.agreementNo}` : ""}</span>
                  {t.used && <span className="tag ok">契約番号に使う</span>}
                  <span className="row" style={{ marginLeft: "auto", gap: 4 }}>
                    {onOpen && <button className="btn btn-sm" onClick={() => onOpen("document", t.id)}>開く</button>}
                    <button className="btn btn-sm" disabled={busy} onClick={() => removeTerms(t)}>外す</button>
                  </span>
                </div>
              ))}
            </div>
          ) : <span className="faint">個別契約の文書は繋がっていません（基本契約の番号だけが出ます）。</span>}
          {c.terms.length > 1 && (
            <span className="faint">複数あるときは、決定済みで新しいものを契約番号に使います。違うものを使うなら、使わない方を「外す」。</span>
          )}
          {pickTerms && (
            <div className="picker">
              {c.candidates.terms.length === 0 && <span className="faint">この相手先の条件書・利用許諾契約書で、まだ繋いでいないものはありません。</span>}
              {c.candidates.terms.map((t) => (
                <div key={t.id} className="pick">
                  <span className="code">{t.no ?? `#${t.id}`}</span><span>{t.label}</span>
                  <span className="faint">{STATUS_LABEL[t.status] ?? t.status}{t.issuedOn ? ` · ${t.issuedOn}` : ""}</span>
                  <button className="btn btn-sm primary" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void addTerms(t.id)}>繋ぐ</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
