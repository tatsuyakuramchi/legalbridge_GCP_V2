import { useState } from "react";

// 債権マップ（読み取り）。作品の派生系譜を段（tier）として、受領・分配・留保を
// 段跨ぎカスケードで俯瞰する。V1 ReceivableMapPanel 相当（作品中心）。

type Upstream = { licensorName: string | null; ratePct: number | null; inherited: boolean; distributeAmount: number | null };
type Tier = { workId: number; workTitle: string | null; workCode: string | null; received: number; cascadeBase: number; distributed: number; retained: number; upstream: Upstream[] };
type Cascade = { chain: Tier[]; totals: { received: number; distributed: number; retained: number } };

const yen = (v: number | null) => `¥${new Intl.NumberFormat("ja-JP").format(Math.round(v ?? 0))}`;

export function ReceivableMap() {
  const [workId, setWorkId] = useState("");
  const [map, setMap] = useState<Cascade | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!/^\d+$/.test(workId)) { setError("作品ID（数値）を入力してください"); setMap(null); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/v2/receivable-map?workId=${encodeURIComponent(workId)}`);
      if (response.status === 404) { setMap(null); setError("この作品の債権マップはありません"); return; }
      if (!response.ok) { setMap(null); setError(response.status === 403 ? "閲覧権限がありません" : "取得に失敗しました"); return; }
      const data = await response.json();
      setMap(data.map ?? null);
    } catch {
      setMap(null); setError("通信に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>RECEIVABLE MAP</p>
          <h1>債権マップ</h1>
          <small>作品を軸に、受領・上流分配・留保を派生系譜で俯瞰（読み取り専用）</small>
        </div>
      </div>

      <div className="rmap-toolbar">
        <input value={workId} onChange={(e) => setWorkId(e.target.value)} placeholder="作品ID（数値）"
          onKeyDown={(e) => e.key === "Enter" && load()} />
        <button className="primary" onClick={load} disabled={loading}>{loading ? "読込中…" : "表示"}</button>
      </div>

      {error && <div className="async-error"><span>{error}</span></div>}

      {map && <>
        <div className="rmap-totals">
          <article><span>受領 合計</span><strong>{yen(map.totals.received)}</strong></article>
          <article className="warn"><span>上流分配 合計</span><strong>{yen(map.totals.distributed)}</strong></article>
          <article className="ok"><span>留保 合計</span><strong>{yen(map.totals.retained)}</strong></article>
        </div>
        <div className="rmap-chain">
          {map.chain.map((tier, index) => (
            <article className="rmap-tier" key={tier.workId}>
              <div className="rmap-tier-head">
                <span className="rmap-tier-no">{index === 0 ? "原作" : `派生${index}`}</span>
                <strong>{tier.workCode ? <small>{tier.workCode} </small> : ""}{tier.workTitle ?? `作品#${tier.workId}`}</strong>
              </div>
              <dl className="rmap-tier-figures">
                <div><dt>受領</dt><dd>{yen(tier.received)}</dd></div>
                <div><dt>分配基礎</dt><dd>{yen(tier.cascadeBase)}</dd></div>
                <div><dt>上流分配</dt><dd className="rmap-dist">{yen(tier.distributed)}</dd></div>
                <div><dt>留保</dt><dd className="rmap-retain">{yen(tier.retained)}</dd></div>
              </dl>
              {tier.upstream.length > 0 && (
                <ul className="rmap-upstream">
                  {tier.upstream.map((u, i) => (
                    <li key={i}>
                      <span>{u.licensorName ?? "ライセンサー"}</span>
                      <em>{u.ratePct != null ? `${u.ratePct}%` : "料率不明"}</em>
                      <b>{u.inherited ? "上位段で計上済" : (u.distributeAmount != null ? yen(u.distributeAmount) : "—")}</b>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </>}

      {!map && !error && <div className="empty-state">作品IDを入力して「表示」を押すと、債権（分配構造）マップを表示します。</div>}
    </section>
  );
}
