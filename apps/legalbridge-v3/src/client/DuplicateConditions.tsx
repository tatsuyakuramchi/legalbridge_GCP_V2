import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { DuplicateView } from "../server/conditions/duplicates.js";

/**
 * 同じ内容で重複している条件明細を畳む。
 *
 * 何も先に選んでおかない。以前、明細が同じ紙を重複と判じて本物を3枚消した。
 * 同じ作業を4人に頼めば明細は同じ文字になる。ここで最初からチェックが
 * 入っていると、確かめる前に押せてしまう。
 */
export function DuplicateConditions({ matterId, onChanged, onOpenCondition }: {
  matterId: number;
  onChanged: () => void;
  onOpenCondition?: (id: number) => void;
}) {
  const readOnly = useReadOnly();
  const [view, setView] = useState<DuplicateView | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] =
    useState<{ ok: number; failed: number;
               outcomes: Array<{ id: number; conditionNo: string | null;
                                 ok: boolean; error: string | null }> } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.get<DuplicateView>(`/matters/${matterId}/duplicate-conditions`)
      .then((v) => { if (alive) { setView(v); setPicked(new Set()); setError(null); } })
      .catch((e) => { if (alive) setError((e as ApiError).message); });
    return () => { alive = false; };
  }, [matterId, tick]);

  const toggle = (id: number) => {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicked(next);
  };

  async function run() {
    setBusy(true); setError(null);
    try {
      setResult(await api.post(`/matters/${matterId}/duplicate-conditions/void`,
        { conditionIds: [...picked], reason: reason.trim() }));
      setReason(""); setTick((n) => n + 1);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (error) return <div className="alert">{error}</div>;
  if (!view) return <p className="faint">調べています…</p>;
  if (!view.groups.length) {
    return <p className="faint">同じ内容で重複している条件明細はありません。</p>;
  }

  return (
    <div className="stack">
      <p className="faint">
        相手先・作品・種別・計算方式・金額・契約期間・名前が全部同じものを束ねています。
        どれか1つでも違えば別物として出しません。
      </p>

      {result && (
        <div className={result.failed ? "note warn" : "note ok"}>
          無効にしました：済 {result.ok}／できなかった {result.failed}
          {result.outcomes.filter((o) => !o.ok).length > 0 && (
            <ul style={{ margin: "4px 0 0" }}>
              {result.outcomes.filter((o) => !o.ok).map((o) => (
                <li key={o.id}>{o.conditionNo ?? `#${o.id}`}：{o.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.groups.map((g) => (
        <div key={g.key} className={g.verdict === "undecidable" ? "note warn" : "panel"}>
          <div className="panel-hd">
            <h3 style={{ margin: 0 }}>{g.partyName ?? "—"}／{g.name}</h3>
            <span className="faint">
              {g.workTitle ? `${g.workTitle}　` : ""}
              {g.amount === null ? "" : money(g.amount)}
              {g.termStart || g.termEnd ? `　${g.termStart ?? "—"} 〜 ${g.termEnd ?? "—"}` : ""}
              {"　／　"}{g.members.length} 本
            </span>
          </div>
          <div className="panel-bd stack">
            <div className={g.verdict === "undecidable" ? "danger" : "faint"}>{g.note}</div>
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th style={{ width: 28 }}></th><th>条件</th><th>抱えているもの</th><th></th>
                </tr></thead>
                <tbody>
                  {g.members.map((m) => (
                    <tr key={m.id} className={m.id === g.keepId ? "sel" : ""}>
                      <td>
                        {/* 抱えているものがある条件は選ばせない。押しても断られる。 */}
                        {!m.blocked && (
                          <input type="checkbox" checked={picked.has(m.id)}
                            aria-label={`${m.conditionNo ?? m.id} を無効にする`}
                            onChange={() => toggle(m.id)} />
                        )}
                      </td>
                      <td>
                        <button className="linky code" onClick={() => onOpenCondition?.(m.id)}>
                          {m.conditionNo ?? `#${m.id}`}
                        </button>
                        {m.id === g.keepId && <span className="tag ok" style={{ marginLeft: 6 }}>残す案</span>}
                        <div className="faint">
                          {m.createdAt ? m.createdAt.slice(0, 10) : ""}
                          {m.carries.schedules ? `　予定 ${m.carries.schedules} 回` : ""}
                        </div>
                      </td>
                      <td>
                        {m.blocked
                          ? <span className="danger">{m.blocked}</span>
                          : <span className="faint">何も抱えていません</span>}
                      </td>
                      <td className="faint">
                        {m.blocked && "先に「旧分を畳む」で紙と支払を片づけてください"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}

      <div className="row">
        <input value={reason} style={{ minWidth: 320 }}
          placeholder="無効にする理由（必須。監査に残ります）"
          onChange={(e) => setReason(e.target.value)} />
        <button className="btn danger" disabled={busy || readOnly || !picked.size || !reason.trim()}
          onClick={() => void run()}>
          {busy ? "無効にしています…" : `選んだ ${picked.size} 本を無効にする`}
        </button>
      </div>
    </div>
  );
}
