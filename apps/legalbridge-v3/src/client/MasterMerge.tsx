import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { MapAgreement } from "../server/agreements/party-map.js";
import type { MergeMastersPreview, ReplacePreview } from "../server/agreements/master-merge.js";
import type { AgreementRow } from "../server/agreements/service.js";
import type { DocumentSummary } from "../server/documents/repository.js";

const KIND_LABEL: Record<string, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "個別契約・覚書", termination: "解除合意", document: "文書だけ"
};
/** 訂正版の枝番（-R3 など）を外した番号（サーバの baseNumber と同じ）。 */
const baseNumber = (no: string) => no.replace(/-R\d+$/i, "");

type Choice = { key: string; kind: "a"; id: number; no: string | null; title: string; note: string }
  | { key: string; kind: "d"; id: number; no: string | null; title: string; note: string };

/**
 * 基本契約を差し替える。
 *
 * この基本契約を、この取引先の別の契約（どの種類でも。基本契約でなければ基本契約にする）か、
 * 文書（基本契約書の紙。その文書から基本契約を立てる）に置き換える。下の個別契約・条件・文書・案件は
 * 新しい基本契約へ移り、この基本契約は解除扱い（番号は残る）になる。1 回の操作で済む。
 * 下の決定済み文書には基本契約の件名・締結日が入っているので、あとで訂正版で出し直せる。
 */
export function MasterMerge({ a, onOpen, onDone, onError, onCancel }: {
  a: MapAgreement; onOpen?: (kind: EntityKind, id: number) => void;
  onDone: (msg: string) => void; onError: (msg: string) => void; onCancel: () => void;
}) {
  const readOnly = useReadOnly();
  const [preview, setPreview] = useState<ReplacePreview | null>(null);
  const [agreements, setAgreements] = useState<AgreementRow[]>([]);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Choice | null>(null);
  const [no, setNo] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState<MergeMastersPreview | null>(null);
  const [results, setResults] = useState<Array<{ documentId: number; documentNo: string | null; status: string; newDocumentNo?: string | null; message?: string }> | null>(null);

  useEffect(() => {
    api.get<ReplacePreview>(`/agreement-map/agreements/${a.id}/replace-master/preview`)
      .then(setPreview).catch((e: ApiError) => onError(e.message));
    api.get<{ agreements: AgreementRow[] }>(`/agreements?partyId=${a.counterparty.id}`)
      .then((r) => setAgreements(r.agreements.filter((x) => x.id !== a.id && x.status !== "terminated")))
      .catch(() => setAgreements([]));
    api.get<{ documents: DocumentSummary[] }>(`/documents?partyId=${a.counterparty.id}&status=issued`)
      .then((r) => setDocs(r.documents.filter((d) => d.status === "issued" && !d.inbound && (d.agreementId === null || d.agreementId === a.id)
        && d.templateKey !== "purchase_order" && d.templateKey !== "intl_purchase_order")))
      .catch(() => setDocs([]));
  }, [a.id, a.counterparty.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const picks: Choice[] = [
    ...[...docs].sort((x, y) => Number(y.agreementId === a.id) - Number(x.agreementId === a.id)).map((d) => ({
      key: `d:${d.id}`, kind: "d" as const, id: d.id, no: d.documentNo, title: d.title ?? d.templateLabel ?? "",
      note: `${d.templateLabel ?? "文書"}${d.agreementId === a.id ? "・いまこの基本契約に繋いでいる紙" : "・契約に未登録"} → この文書から基本契約を立てる`
    })),
    ...agreements.map((x) => ({
      key: `a:${x.id}`, kind: "a" as const, id: x.id, no: x.agreementNo, title: x.title,
      note: `${KIND_LABEL[x.kind] ?? x.kind}${x.parentId === a.id ? "（この基本契約の下）" : ""}${x.kind === "master" ? "" : " → 基本契約にする"}`
    }))
  ];
  const shown = picks.filter((p) => !q.trim() || `${p.no ?? ""} ${p.title}`.toLowerCase().includes(q.trim().toLowerCase()) || p.key === pick?.key);
  const choose = (p: Choice) => {
    setPick(p);
    if (p.kind === "d") { setNo(p.no ? baseNumber(p.no) : ""); setTitle(p.title); }
  };

  async function replace() {
    if (!pick) return;
    const into = pick.kind === "d" ? `文書 ${pick.no ?? ""} から立てる基本契約 ${no}` : `${pick.no ?? `#${pick.id}`}（${pick.title}）`;
    if (!window.confirm(`${a.agreementNo ?? `#${a.id}`} を ${into} に差し替えます。下の個別契約・条件・文書・案件は新しい基本契約へ移り、${a.agreementNo ?? ""} は解除扱い（番号は残る）になります。よろしいですか？`)) return;
    setBusy(true);
    try {
      const r = await api.post<MergeMastersPreview & { created: boolean }>(`/agreement-map/agreements/${a.id}/replace-master`,
        pick.kind === "d" ? { documentId: pick.id, agreementNo: no.trim() || null, title: title.trim() || null } : { intoId: pick.id });
      setMerged(r);
      if (!r.reissue.length) onDone(`${r.from.agreementNo ?? ""} を ${r.into.agreementNo ?? ""} に差し替えました${r.created ? "（文書から基本契約を立てました）" : ""}。締結日は新しい基本契約の「編集」で入れてください`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function reissue(ids: number[]) {
    setBusy(true);
    try {
      const r = await api.post<{ reissued: number; results: NonNullable<typeof results> }>("/agreement-map/merge-masters/reissue", { documentIds: ids });
      setResults(r.results);
      const bad = r.results.filter((x) => x.status !== "reissued");
      onDone(`訂正版を ${r.reissued} 枚出しました${bad.length ? `（${bad.length} 枚は出せませんでした）` : ""}。出し直した版は未送付なので、下の「送る」から送ってください`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (merged) {
    return (
      <div className="amap-form stack" style={{ gap: 8 }}>
        <div className="note ok">{merged.from.agreementNo ?? ""} を {merged.into.agreementNo ?? ""} に差し替えました。締結日は新しい基本契約の「編集」で入れてください。</div>
        {merged.reissue.length > 0 && (
          <>
            <div>下の決定済み文書には基本契約の件名・締結日が本文に入っているので、訂正版で出し直します（元の決定日のまま。今の版は退きます）。</div>
            <table>
              <thead><tr><th>文書番号</th><th>件名</th><th>決定日</th><th>結果</th></tr></thead>
              <tbody>
                {merged.reissue.map((d) => {
                  const r = results?.find((x) => x.documentId === d.id);
                  return (
                    <tr key={d.id}>
                      <td className="code">{onOpen ? <button className="linky" onClick={() => onOpen("document", d.id)}>{d.documentNo}</button> : d.documentNo}</td>
                      <td>{d.title ?? ""}</td><td className="faint">{d.issuedOn ?? ""}</td>
                      <td>{r ? (r.status === "reissued" ? <span className="tag ok">訂正版 {r.newDocumentNo ?? ""}</span> : <span className="tag danger">{r.message ?? "失敗"}</span>) : <span className="faint">未</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!results && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={readOnly || busy} onClick={() => void reissue(merged.reissue.map((d) => d.id))}>
                  {merged.reissue.length} 枚を訂正版で出し直す
                </button>
                <button className="btn" onClick={() => onDone(`${merged.from.agreementNo ?? ""} を ${merged.into.agreementNo ?? ""} に差し替えました（出し直しはあとで）`)}>あとで</button>
              </div>
            )}
            {results && <div className="row"><button className="btn" onClick={onCancel}>閉じる</button></div>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="amap-form stack" style={{ gap: 10 }}>
      <b>基本契約を差し替える</b>
      <div className="faint">
        {a.agreementNo ?? `#${a.id}`}（{a.title}）を、別の契約か文書に置き換えます。
        {preview && <>いま下にある 個別契約 {preview.moves.supplements}・条件 {preview.moves.conditions}・文書 {preview.moves.documents}・案件 {preview.moves.matters} は新しい基本契約へ移ります。</>}
        {a.agreementNo ?? ""} は解除扱いになります（番号は残り、件名に「統合済み → 新しい番号」が付きます）。
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span>① 新しい基本契約にするものを選ぶ</span>
        <input value={q} placeholder="番号・件名で絞り込む" onChange={(e) => setQ(e.target.value)} />
        <div className="picker" style={{ maxHeight: 240, overflowY: "auto" }}>
          {shown.map((p) => (
            <label key={p.key} className="row" style={{ gap: 6, padding: "2px 0", cursor: "pointer", alignItems: "baseline" }}>
              <input type="radio" name={`replace-${a.id}`} checked={pick?.key === p.key} onChange={() => choose(p)} />
              <span className="tag ghost">{p.kind === "d" ? "文書" : "契約"}</span>
              <span className="code">{p.no ?? `#${p.id}`}</span><span>{p.title}</span>
              <span className="faint">{p.note}</span>
            </label>
          ))}
          {!shown.length && <span className="faint">この取引先に、差し替え先になる契約・決定済みの文書がありません。先に「契約を登録」で立てるか、紙を取り込んでください</span>}
        </div>
      </div>
      {pick?.kind === "d" && (
        <div className="form-grid">
          <label className="field"><span>② 新しい基本契約の番号</span>
            <input value={no} onChange={(e) => setNo(e.target.value)} />
            <small className="faint">既定は文書番号から訂正版の枝番（-R3 など）を外したもの</small>
          </label>
          <label className="field"><span>件名</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：出版等利用許諾基本契約" />
          </label>
        </div>
      )}
      {preview && preview.reissue.length > 0 && (
        <div className="faint">差し替えのあとに出し直す決定済み文書：{preview.reissue.map((d) => d.documentNo).join("・")}（差し替えたあとに選べます）</div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={readOnly || busy || !pick || (pick.kind === "d" && !no.trim())} onClick={() => void replace()}>
          {busy ? "差し替えています…" : pick ? `${pick.kind === "d" ? no || "新しい基本契約" : pick.no ?? "選んだ契約"} に差し替える` : "差し替える"}
        </button>
        <button className="btn" onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}
