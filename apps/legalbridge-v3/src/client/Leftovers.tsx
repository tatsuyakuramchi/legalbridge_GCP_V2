import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import {
  DISPOSE_ORDER, LEFTOVER_LABEL,
  type Leftover, type LeftoverKind, type LeftoverTally
} from "../server/ops/leftovers.js";

/**
 * 修正の残骸の片づけ。
 *
 * 直す作業は必ず途中の産物を残す。訂正版を作りかけて別の直し方にした下書き、
 * 打ち間違えて無効にした実績、作り直したので無効にした条件。一覧からは消えて
 * いても行としては残り、数えると合わない・選ぶときに紛れる。
 *
 * 消す画面なので、押す前に分かることを全部出す。何がいくつ、どういう経緯で
 * 残ったか、捨てられないなら何が指しているか。チェックは1つも入れていない
 * 状態で開く（「全部選ぶ」から始めると、見ずに押せてしまう）。
 */

interface Loaded { items: Leftover[]; tally: LeftoverTally[] }
interface DisposeResult { kind: LeftoverKind; id: number; label: string; removed: boolean; message: string | null }

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function Leftovers() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<DisposeResult[] | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me")
      .then((r) => setIsAdmin(r.user?.role === "admin")).catch(() => setIsAdmin(false));
  }, []);

  useEffect(() => {
    setError(null);
    api.get<Loaded>("/cleanup/leftovers")
      .then((r) => { setData(r); setPicked(new Set()); })
      .catch((e: ApiError) => { setError(e.message); setData({ items: [], tally: [] }); });
  }, [version]);

  const groups = useMemo(() => DISPOSE_ORDER
    .map((kind) => ({ kind, items: (data?.items ?? []).filter((i) => i.kind === kind) }))
    .filter((g) => g.items.length), [data]);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="faint">読み込んでいます…</div>;

  const key = (i: Leftover) => `${i.kind}:${i.id}`;
  const pickedItems = data.items.filter((i) => picked.has(key(i)));

  async function dispose() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ results: DisposeResult[] }>("/cleanup/leftovers/dispose", {
        reason: reason.trim(),
        picks: pickedItems.map((i) => ({ kind: i.kind, id: i.id }))
      });
      setResults(r.results);
      setReason("");
      setVersion((x) => x + 1);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <p className="lede">
        直す作業が残した途中の産物です。<b>出した文書と取り消した支払は出しません</b>
        （番号を振って出した事実と、経理へ出したかどうかは記録なので残します）。
        何かが指しているものも捨てません。指しているものごと消えると、指す先を失います。
      </p>

      {data.items.length === 0 && <div className="note ok">片づけるものはありません。</div>}

      {data.tally.length > 0 && (
        <div className="stagefilter">
          {data.tally.map((t) => (
            <span key={t.kind} className="chip" aria-disabled>
              {t.label} {t.total}（捨てられる {t.disposable}）
            </span>
          ))}
        </div>
      )}

      {results && (
        <div className="note ok">
          {results.map((r) => (
            <div key={`${r.kind}${r.id}`}>
              {r.removed ? "捨てました" : "残しました"}：{r.label}
              {r.message ? <span className="faint">　{r.message}</span> : null}
            </div>
          ))}
        </div>
      )}

      {!isAdmin && data.items.length > 0 && (
        <div className="note warn">
          捨てるのは管理者だけです。条件の削除（無効化 → 削除の2段階）と同じ重さにしています。
        </div>
      )}

      {pickedItems.length > 0 && (
        <div className="fixbar">
          <b>{pickedItems.length} 件を選んでいます</b>
          <label className="field" style={{ gridTemplateColumns: "78px minmax(260px,1fr)", margin: 0 }}>
            <span>捨てる理由<em className="req"> 必須</em></span>
            <input value={reason} placeholder="確認用に作ったものの片づけ"
                   onChange={(e) => setReason(e.target.value)} />
          </label>
          <button className="btn danger" disabled={busy || !reason.trim() || !isAdmin}
                  onClick={() => void dispose()}>
            選んだ {pickedItems.length} 件を捨てる
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => setPicked(new Set())}>選び直す</button>
          <span className="faint">元に戻せません。理由は監査に残ります</span>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.kind} className="panel">
          <div className="panel-hd">
            <h2>{LEFTOVER_LABEL[g.kind]} {g.items.length}</h2>
            <span className="faint">
              {g.kind === "draft" && "番号を振っていない文書だけ。出したものは残します"}
              {g.kind === "event" && "取り消した実績。生きている実績は納品の記録なので出しません"}
              {g.kind === "condition" && "無効にした条件。判定は条件画面の削除と同じです"}
            </span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th></th><th>もの</th><th>経緯</th><th>手がかり</th><th>日付</th><th>捨てられるか</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((i) => (
                  <tr key={key(i)} className={picked.has(key(i)) ? "sel" : undefined}>
                    <td>
                      <input type="checkbox" disabled={!i.disposable || !isAdmin}
                             checked={picked.has(key(i))}
                             aria-label={`${i.label} を選ぶ`}
                             onChange={(e) => setPicked((prev) => {
                               const next = new Set(prev);
                               if (e.target.checked) next.add(key(i)); else next.delete(key(i));
                               return next;
                             })} />
                    </td>
                    <td className="code">{i.label}</td>
                    <td>
                      {i.origin}
                      {/* 直しかけを片づけのつもりで捨てると、直しが取り消される。 */}
                      {i.caution && <div className="tag out" style={{ marginTop: 3 }}>{i.caution}</div>}
                    </td>
                    <td className="faint">{i.context ?? "—"}</td>
                    <td className="faint">{day(i.createdAt)}</td>
                    <td>
                      {i.disposable
                        ? <span className="tag ok">捨てられる</span>
                        : <>
                            <span className="tag">残す</span>
                            <div className="faint">
                              {i.holders.map((h) => `${h.target} ${h.rows} 件`).join("、")} が指しています
                            </div>
                          </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
