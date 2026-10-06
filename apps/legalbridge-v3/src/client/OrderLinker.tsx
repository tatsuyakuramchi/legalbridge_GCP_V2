import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { DocumentImport } from "./DocumentImport.js";
import type { GridRow } from "../server/matters/grid.js";

/**
 * 発注書を条件に紐づける（取引先の束から）。
 *
 * 発注書は文書として持つ。既にある発注書（このシステムで作ったもの・取り込んだもの）を
 * 条件に紐づけるのが先で、新しく作るのは紙を出し直すときだけ。新しく作る前に既存の
 * 発注書を並べ、同じ取引に発注書が 2 枚できるのを防ぐ。
 *   ① 既存の発注書を紐づける … 同じ相手の発注書から選び、選んだ条件にまとめて紐づける
 *   ② 取り込んで紐づける     … 紙・PDF の発注書を登録し、そのまま紐づける
 *   ③ 新しく作る             … 発注書の下書きへ（選んだ条件を載せて）
 */

interface OrderDoc {
  id: number; documentNo: string | null; status: string; templateKey: string | null; templateLabel: string | null;
  title: string | null; imported: boolean; issuedAt: string | null; conditions: Array<{ id: number; conditionNo: string | null }>;
}

const isOrder = (d: OrderDoc) =>
  d.templateKey === "purchase_order" || d.templateKey === "intl_purchase_order"
  || (d.imported && (d.templateLabel ?? "") === "発注書");

export function OrderLinker(
  { party, rows, focusId, matterId, onCompose, onDone, onCancel }: {
    party: { id: number; name: string };
    /** この取引先の、発注書の無い条件（束の行）。 */
    rows: GridRow[];
    /** 押した行。最初はこれだけ選んでおく。 */
    focusId: number;
    matterId: number;
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null, templateKey?: string | null) => void;
    onDone: (msg: string) => void;
    onCancel: () => void;
  }
) {
  const [picked, setPicked] = useState<Set<number>>(new Set([focusId]));
  const [docs, setDocs] = useState<OrderDoc[] | null>(null);
  const [docId, setDocId] = useState<number | null>(null);
  const [mode, setMode] = useState<"link" | "import" | "new">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 欄は束の上に開く。押した行から離れているので、開いたら見える所まで寄せる。
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, []);

  useEffect(() => {
    api.get<{ documents: OrderDoc[] }>(`/documents?partyId=${party.id}`)
      .then((r) => {
        const list = r.documents.filter((d) => isOrder(d) && d.status !== "void" && d.status !== "superseded");
        setDocs(list);
        if (!list.length) setMode("import");
      })
      .catch(() => setDocs([]));
  }, [party.id]);

  const ids = rows.filter((r) => picked.has(r.conditionId)).map((r) => r.conditionId);
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function link() {
    if (!docId || !ids.length) return;
    setBusy(true); setError(null);
    const done: number[] = [];
    try {
      for (const id of ids) {
        await api.post(`/links/condition/${id}/documents`, { targetId: docId });
        done.push(id);
      }
      const d = docs?.find((x) => x.id === docId);
      onDone(`${d?.documentNo ?? "発注書"} を条件 ${done.length} 本に紐づけました`);
    } catch (e) {
      setError(`${done.length ? `${done.length} 本は紐づけました。` : ""}${e instanceof ApiError ? e.message : String(e)}`);
    } finally { setBusy(false); }
  }

  return (
    <div ref={box} className="note stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{party.name} の発注書を紐づける</b>
        <button className="btn btn-sm" onClick={onCancel}>閉じる</button>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="stack" style={{ gap: 4 }}>
        <span className="faint">紐づける条件（発注書の無い条件。1枚の発注書に載っている条件はまとめて選ぶ）</span>
        {rows.map((r) => (
          <label key={r.conditionId} className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={picked.has(r.conditionId)} onChange={() => toggle(r.conditionId)} />
            <span>{r.name}</span><span className="faint code">{r.conditionNo ?? `#${r.conditionId}`}</span>
          </label>
        ))}
      </div>
      <div className="row" role="group" aria-label="紐づけ方" style={{ gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="chip" aria-pressed={mode === "link"} onClick={() => setMode("link")}>
          ① 既存の発注書を紐づける{docs ? `（${docs.length} 枚）` : ""}
        </button>
        <button type="button" className="chip" aria-pressed={mode === "import"} onClick={() => setMode("import")}>② 紙・PDF を取り込んで紐づける</button>
        {onCompose && <button type="button" className="chip" aria-pressed={mode === "new"} onClick={() => setMode("new")}>③ 新しく作る</button>}
      </div>

      {mode === "link" && (
        docs === null ? <span className="faint">発注書を探しています…</span>
        : !docs.length ? <span className="faint">{party.name} の発注書はまだありません。② で取り込むか、③ で作ってください</span>
        : (
          <div className="stack" style={{ gap: 6 }}>
            <div className="picker" style={{ maxHeight: 220, overflowY: "auto" }}>
              {docs.map((d) => (
                <label key={d.id} className="row" style={{ gap: 6, padding: "2px 0", cursor: "pointer" }}>
                  <input type="radio" name={`order-${party.id}`} checked={docId === d.id} onChange={() => setDocId(d.id)} />
                  <span className="code">{d.documentNo ?? `#${d.id}`}</span>
                  <span>{d.title ?? ""}</span>
                  {d.imported && <span className="tag ghost">取込</span>}
                  {d.status === "draft" && <span className="tag warn">下書き</span>}
                  <span className="faint">
                    {d.issuedAt ? d.issuedAt.slice(0, 10) : ""}
                    {d.conditions.length ? `　紐づき：${d.conditions.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}` : "　紐づく条件なし"}
                  </span>
                </label>
              ))}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary btn-sm" disabled={busy || !docId || !ids.length} onClick={() => void link()}>
                {busy ? "紐づけています…" : `選んだ条件 ${ids.length} 本に紐づける`}
              </button>
              <span className="faint">紐づけると発注書の欄が埋まり、検収書の発注番号にも出ます</span>
            </div>
          </div>
        )
      )}

      {mode === "import" && (
        ids.length
          ? <DocumentImport key={ids.join(",")} conditionIds={ids} matterId={matterId} defaultKind="発注書" initialMode="import"
              onDone={() => onDone(`発注書を取り込み、条件 ${ids.length} 本に紐づけました`)} />
          : <span className="faint">紐づける条件を選んでください</span>
      )}

      {mode === "new" && onCompose && (
        <div className="stack" style={{ gap: 6 }}>
          {docs && docs.length > 0 && (
            <div className="alert">
              {party.name} には発注書がもう {docs.length} 枚あります（{docs.slice(0, 3).map((d) => d.documentNo ?? `#${d.id}`).join("・")}{docs.length > 3 ? " ほか" : ""}）。
              同じ取引の発注書なら ① で紐づけてください。新しく作ると、同じ取引に発注書が 2 枚できます。
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" disabled={!ids.length} onClick={() => onCompose(ids, [], matterId, "purchase_order")}>
              選んだ条件 {ids.length} 本で発注書を作る（下書きへ）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
