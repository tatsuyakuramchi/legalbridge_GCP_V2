import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

/**
 * 発行済み文書が「どの実績を対象にしたか」を後から直す。
 *
 * 実績と文書の結びつきは、これまで発行の瞬間にしか作れなかった。移行してきた
 * 文書は発行の経路を通っていないので、どれも実績に繋がっていない。API
 * （POST /conditions/:id/events/link-document）は復旧口として前からあったが、
 * 呼ぶ画面がどこにも無く、実質使えなかった。
 *
 * 直すのは索引だけ。発行した紙の内容は変わらない。
 */

interface EventRow {
  id: number; eventType: string; occurredOn: string | null; period: string | null;
  amount: number; status: string;
  documentId: number | null; documentNo: string | null;
}

const EVENT_LABEL: Record<string, string> = {
  manufacturing: "製造", sales: "売上", sublicense_receipt: "再許諾受領",
  inspection: "検収", delivery: "納品", service_period: "役務期間", adjustment: "調整"
};

export function DocumentEvents(
  { documentId, documentNo, conditions, currency = "JPY", onChanged }: {
    documentId: number;
    documentNo: string | null;
    /** この文書に繋がっている条件明細。実績はこの条件のものから選ぶ。 */
    conditions: Array<{ id: number; conditionNo: string | null }>;
    currency?: string;
    onChanged?: () => void;
  }
) {
  const [rows, setRows] = useState<Array<EventRow & { conditionId: number }>>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const key = conditions.map((c) => c.id).join(",");
  useEffect(() => { void load(); }, [key, documentId]);
  async function load() {
    setError(null); setPicked(new Set());
    try {
      const lists = await Promise.all(conditions.map((c) =>
        api.get<{ events: EventRow[] }>(`/conditions/${c.id}/events`)
          .then((r) => r.events.map((e) => ({ ...e, conditionId: c.id })))));
      // 取り消した実績は出さない。結べないし、直す対象でもない。
      setRows(lists.flat().filter((e) => e.status === "active"));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  const mine = rows.filter((e) => e.documentId === documentId);
  const free = rows.filter((e) => e.documentId === null);
  const taken = rows.filter((e) => e.documentId !== null && e.documentId !== documentId);

  async function link() {
    const byCondition = new Map<number, number[]>();
    for (const e of free.filter((x) => picked.has(x.id))) {
      byCondition.set(e.conditionId, [...(byCondition.get(e.conditionId) ?? []), e.id]);
    }
    if (!byCondition.size) return;
    setBusy(true); setError(null); setNote(null);
    try {
      // 条件ごとに呼ぶ。API は条件の中の実績しか受けない（別条件の実績が
      // 混ざったまま通ると、どの条件の何回目かが読めなくなる）。
      for (const [conditionId, eventIds] of byCondition) {
        await api.post(`/conditions/${conditionId}/events/link-document`,
          { documentId, eventIds });
      }
      setNote(`${[...byCondition.values()].flat().length} 件を結びました`);
      await load(); onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function unlink(row: EventRow & { conditionId: number }) {
    if (!window.confirm(
      `${row.occurredOn ?? ""} の実績を ${documentNo ?? "この文書"} から外します。`
      + "\n発行した文書そのものは変わりません。")) return;
    setBusy(true); setError(null); setNote(null);
    try {
      await api.post(`/conditions/${row.conditionId}/events/unlink-document`,
        { documentId, eventIds: [row.id] });
      await load(); onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const line = (e: EventRow) =>
    `${e.occurredOn ?? "日付なし"}　${EVENT_LABEL[e.eventType] ?? e.eventType}`
    + `${e.period ? `　${e.period}` : ""}　${money(e.amount, currency)}`;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>対象の実績</h2>
        <span className="faint">この文書がどの実績について出したものか</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className="note ok">{note}</div>}

        {!conditions.length ? (
          <div className="faint">
            先に条件明細を繋いでください。実績は条件にぶら下がっているので、
            条件が決まらないと選べません。
          </div>
        ) : (<>
          {mine.length > 0 && (
            <div className="picker">
              {mine.map((e) => (
                <div key={e.id} className="pick">
                  <span>{line(e)}</span>
                  <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                          disabled={busy} onClick={() => void unlink(e)}>外す</button>
                </div>
              ))}
            </div>
          )}
          {!mine.length && (
            <div className="faint">この文書に結びついている実績はまだありません。</div>
          )}

          {free.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="row">
                <b>まだどの文書にも結びついていない実績</b>
                <span className="faint">{free.length} 件</span>
                <button className="btn btn-sm primary" style={{ marginLeft: "auto" }}
                        disabled={busy || !picked.size} onClick={() => void link()}>
                  {/* 0 件のときに「選んだ 0 件を結ぶ」と出ると、押せない理由が
                      ボタンの外にあるように読める。何をすればいいかを書く。 */}
                  {picked.size ? `選んだ ${picked.size} 件を結ぶ` : "結ぶものを選ぶ"}
                </button>
              </div>
              <div className="picker">
                {free.map((e) => (
                  <label key={e.id} className="pick">
                    <input type="checkbox" checked={picked.has(e.id)}
                           onChange={(ev) => setPicked((prev) => {
                             const next = new Set(prev);
                             if (ev.target.checked) next.add(e.id); else next.delete(e.id);
                             return next;
                           })} />
                    <span>{line(e)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 他の文書が持っている実績も見せる。隠すと「候補に出ない」理由が
              分からず、同じ実績を探し続けることになる。 */}
          {taken.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="faint">他の文書が対象にしている実績（{taken.length} 件）</span>
              <div className="picker">
                {taken.map((e) => (
                  <div key={e.id} className="pick faint">
                    <span>{line(e)}</span>
                    <span className="code" style={{ marginLeft: "auto" }}>
                      {e.documentNo ?? `#${e.documentId}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>)}
      </div>
    </div>
  );
}
