import { useEffect, useState } from "react";

// 作品詳細（Phase 2・読み取り専用）。作品を起点に 概要/系譜/素材/条件/権利ソース/
// 料率対象 を一望する。作品ピッカー（検索）で選択 → GET /works/:id/detail を集約表示。
// 権限未付与（grant 007 未適用）のセクションは null で届くため注記して縮退する。

type Summary = { id: number; workCode: string | null; title: string | null; kind: string | null; isOriginal: boolean | null; parentWorkId: number | null };
type Tier = { workId: number; title: string | null; workCode: string | null; label: string; isSelected: boolean };
type Node = { workId: number; title: string | null; workCode: string | null };
type Lineage = { chain: Tier[]; children: Node[]; unlinkedRelationParents: Node[]; depth: number; isDerivative: boolean };
type Material = { id: number; materialCode: string | null; materialName: string | null; materialType: string | null; materialRole: string | null; acquisitionType: string | null; rightsType: string | null; rightsHolderLabel: string | null; isRoyaltyBearing: boolean | null; categoryName: string | null; territory: string | null; language: string | null };
type RightsSource = { id: number; materialName: string | null; sourceType: string | null; sourceWorkTitle: string | null; rightsHolderName: string | null; sourceRole: string | null; isPrimary: boolean | null; validFrom: string | null; validTo: string | null };
type Cond = { id: number; conditionName: string | null; direction: string | null; sourceMaterialId: number | null; materialName: string | null; sublicenseAllowed: boolean | null; parentLicenseConditionId: number | null; ratePct: number | null; amountExTax: number | null; mgAmount: number | null; currency: string | null; documentNumber: string | null };
type Conditions = { receivable: Cond[]; payable: Cond[]; sublicense: Cond[]; workLevel: Cond[]; materialLinked: Cond[]; totals: { count: number; receivableCount: number; payableCount: number; sublicenseCount: number; workLevelCount: number } };
type Core = Summary & { titleKana: string | null; workType: string | null; status: string | null; derivationType: string | null; rightsHolderName: string | null; creatorName: string | null; publisherName: string | null; ledgerCode: string | null; remarks: string | null };
type Detail = { work: Core; lineage: Lineage | null; materials: Material[] | null; rightsSources: RightsSource[] | null; conditions: Conditions | null };

type Tab = "overview" | "lineage" | "materials" | "conditions" | "rights" | "rates";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "概要" },
  { key: "lineage", label: "系譜" },
  { key: "materials", label: "素材" },
  { key: "conditions", label: "条件" },
  { key: "rights", label: "権利ソース" },
  { key: "rates", label: "料率対象" }
];

const yen = (v: number | null, ccy: string | null) => v == null ? "—" : `${ccy && ccy !== "JPY" ? ccy + " " : "¥"}${new Intl.NumberFormat("ja-JP").format(Math.round(v))}`;
const kindLabel = (k: string | null) => k === "licensed_in" ? "ライセンスイン" : k === "own" ? "自社作品" : (k ?? "—");

function Degraded() {
  return <div className="empty-state">このセクションは表示権限（GRANT 007）が未付与のため取得できませんでした。付与後に自動表示されます。</div>;
}

export function WorkDetail() {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // 作品検索（デバウンス）。
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams();
      if (keyword.trim()) params.set("keyword", keyword.trim());
      params.set("limit", "50");
      try {
        const res = await fetch(`/api/v2/works?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) { setResults([]); if (res.status === 403) setError("閲覧権限がありません"); return; }
        const data = await res.json();
        setResults(data.works ?? []); setError("");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResults([]);
      }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [keyword]);

  // 選択された作品の詳細取得。
  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    const controller = new AbortController();
    (async () => {
      setLoading(true); setError("");
      try {
        const res = await fetch(`/api/v2/works/${selectedId}/detail`, { signal: controller.signal });
        if (!res.ok) { setDetail(null); setError(res.status === 403 ? "閲覧権限がありません" : res.status === 404 ? "作品が見つかりません" : "取得に失敗しました"); return; }
        setDetail(await res.json()); setTab("overview");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setDetail(null); setError("通信に失敗しました");
      } finally { setLoading(false); }
    })();
    return () => controller.abort();
  }, [selectedId]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>WORKS</p>
          <h1>作品</h1>
          <small>作品を起点に系譜・素材・条件・権利ソース・料率対象を一望（読み取り専用）</small>
        </div>
      </div>

      <div className="wd-layout">
        <div className="wd-picker">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="作品名・作品コードで検索" />
          <div className="wd-picker-list">
            {results.map((w) => (
              <button key={w.id} className={selectedId === w.id ? "selected" : ""} onClick={() => setSelectedId(w.id)}>
                <strong>{w.workCode ? <small>{w.workCode} </small> : ""}{w.title ?? `作品#${w.id}`}</strong>
                <span>{w.isOriginal ? "原作" : w.parentWorkId ? "派生" : ""} {kindLabel(w.kind)}</span>
              </button>
            ))}
            {!results.length && <div className="empty-state">該当する作品がありません。</div>}
          </div>
        </div>

        <div className="wd-pane">
          {error && <div className="async-error"><span>{error}</span></div>}
          {!selectedId && !error && <div className="empty-state">左の一覧から作品を選ぶと詳細を表示します。</div>}
          {loading && <div className="empty-state">読込中…</div>}

          {detail && !loading && <>
            <div className="wd-head">
              <div>
                <strong>{detail.work.workCode ? <small>{detail.work.workCode} </small> : ""}{detail.work.title ?? `作品#${detail.work.id}`}</strong>
                {detail.work.titleKana && <em>{detail.work.titleKana}</em>}
              </div>
              <div className="wd-badges">
                {detail.work.isOriginal && <span className="status">原作</span>}
                {detail.lineage?.isDerivative && <span className="status">派生{detail.lineage.depth}段</span>}
                <span className="status">{kindLabel(detail.work.kind)}</span>
              </div>
            </div>

            <div className="ledger-tabs">
              {TABS.map((t) => (
                <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>{t.label}</button>
              ))}
            </div>

            {tab === "overview" && (
              <dl className="wd-overview">
                <div><dt>作品種別</dt><dd>{detail.work.workType ?? "—"}</dd></div>
                <div><dt>ステータス</dt><dd>{detail.work.status ?? "—"}</dd></div>
                <div><dt>派生種別</dt><dd>{detail.work.derivationType ?? "—"}</dd></div>
                <div><dt>権利者</dt><dd>{detail.work.rightsHolderName ?? "—"}</dd></div>
                <div><dt>作者</dt><dd>{detail.work.creatorName ?? "—"}</dd></div>
                <div><dt>出版社</dt><dd>{detail.work.publisherName ?? "—"}</dd></div>
                <div><dt>台帳コード</dt><dd>{detail.work.ledgerCode ?? "—"}</dd></div>
                <div className="wide"><dt>備考</dt><dd>{detail.work.remarks ?? "—"}</dd></div>
              </dl>
            )}

            {tab === "lineage" && (detail.lineage ? <>
              <div className="wd-chain">
                {detail.lineage.chain.map((t) => (
                  <div key={t.workId} className={`wd-node${t.isSelected ? " current" : ""}`}>
                    <span className="wd-node-label">{t.label}</span>
                    <strong>{t.workCode ? <small>{t.workCode} </small> : ""}{t.title ?? `作品#${t.workId}`}</strong>
                  </div>
                ))}
              </div>
              <h4>直接の派生作品</h4>
              {detail.lineage.children.length
                ? <ul className="wd-list">{detail.lineage.children.map((c) => <li key={c.workId}><button onClick={() => setSelectedId(c.workId)}>{c.workCode ? c.workCode + " " : ""}{c.title ?? `作品#${c.workId}`}</button></li>)}</ul>
                : <div className="empty-state">派生作品はありません。</div>}
              {detail.lineage.unlinkedRelationParents.length > 0 && <>
                <h4>系譜に未反映の親（work_relations のみ）</h4>
                <ul className="wd-list warn">{detail.lineage.unlinkedRelationParents.map((c) => <li key={c.workId}><button onClick={() => setSelectedId(c.workId)}>{c.workCode ? c.workCode + " " : ""}{c.title ?? `作品#${c.workId}`}</button></li>)}</ul>
                <small className="hint">parent_work_id 系譜に現れない親です。系譜（親子）の整合を確認してください。</small>
              </>}
            </> : <Degraded />)}

            {tab === "materials" && (detail.materials ? (
              detail.materials.length ? <table>
                <thead><tr><th>コード</th><th>素材名</th><th>種別</th><th>役割</th><th>取得</th><th>権利</th><th>権利者</th><th>ロイヤリティ</th></tr></thead>
                <tbody>{detail.materials.map((m) => <tr key={m.id}>
                  <td>{m.materialCode ?? "—"}</td><td>{m.materialName ?? "—"}</td><td>{m.materialType ?? "—"}</td>
                  <td>{m.materialRole ?? "—"}</td><td>{m.acquisitionType ?? "—"}</td><td>{m.rightsType ?? "—"}</td>
                  <td>{m.rightsHolderLabel ?? "—"}</td><td>{m.isRoyaltyBearing ? "対象" : "—"}</td>
                </tr>)}</tbody>
              </table> : <div className="empty-state">登録された素材はありません。</div>
            ) : <Degraded />)}

            {tab === "conditions" && (detail.conditions ? <>
              <div className="wd-cond-summary">
                <span>受領 {detail.conditions.totals.receivableCount}</span>
                <span>支払 {detail.conditions.totals.payableCount}</span>
                <span>サブライセンス {detail.conditions.totals.sublicenseCount}</span>
                <span>作品レベル {detail.conditions.totals.workLevelCount}</span>
              </div>
              {detail.conditions.totals.count ? <table>
                <thead><tr><th>方向</th><th>条件名</th><th>素材</th><th>料率</th><th>金額</th><th>MG</th><th>サブL</th><th>文書</th></tr></thead>
                <tbody>{[...detail.conditions.receivable, ...detail.conditions.payable].map((c) => <tr key={c.id}>
                  <td>{c.direction === "receivable" ? "受領" : c.direction === "payable" ? "支払" : "—"}</td>
                  <td>{c.conditionName ?? "—"}</td><td>{c.materialName ?? (c.sourceMaterialId ? `#${c.sourceMaterialId}` : "作品レベル")}</td>
                  <td>{c.ratePct != null ? `${c.ratePct}%` : "—"}</td><td>{yen(c.amountExTax, c.currency)}</td><td>{yen(c.mgAmount, c.currency)}</td>
                  <td>{c.sublicenseAllowed || c.parentLicenseConditionId != null ? "○" : ""}</td><td>{c.documentNumber ?? "—"}</td>
                </tr>)}</tbody>
              </table> : <div className="empty-state">紐づく条件明細はありません。</div>}
            </> : <Degraded />)}

            {tab === "rights" && (detail.rightsSources ? (
              detail.rightsSources.length ? <table>
                <thead><tr><th>素材</th><th>ソース種別</th><th>ソース作品</th><th>権利者</th><th>役割</th><th>主</th><th>有効期間</th></tr></thead>
                <tbody>{detail.rightsSources.map((r) => <tr key={r.id}>
                  <td>{r.materialName ?? "—"}</td><td>{r.sourceType ?? "—"}</td><td>{r.sourceWorkTitle ?? "—"}</td>
                  <td>{r.rightsHolderName ?? "—"}</td><td>{r.sourceRole ?? "—"}</td><td>{r.isPrimary ? "○" : ""}</td>
                  <td>{[r.validFrom, r.validTo].filter(Boolean).join(" 〜 ") || "—"}</td>
                </tr>)}</tbody>
              </table> : <div className="empty-state">登録された権利ソースはありません。</div>
            ) : <Degraded />)}

            {tab === "rates" && (
              <>
                <h4>ロイヤリティ対象素材</h4>
                {detail.materials == null ? <Degraded /> : (
                  detail.materials.filter((m) => m.isRoyaltyBearing).length
                    ? <ul className="wd-list">{detail.materials.filter((m) => m.isRoyaltyBearing).map((m) => <li key={m.id}>{m.materialCode ? m.materialCode + " " : ""}{m.materialName}</li>)}</ul>
                    : <div className="empty-state">ロイヤリティ対象の素材はありません。</div>
                )}
                <h4>料率を持つ条件</h4>
                {detail.conditions == null ? <Degraded /> : (
                  [...detail.conditions.receivable, ...detail.conditions.payable].filter((c) => c.ratePct != null).length
                    ? <table>
                      <thead><tr><th>方向</th><th>条件名</th><th>素材</th><th>料率</th><th>ロイヤリティ基礎</th></tr></thead>
                      <tbody>{[...detail.conditions.receivable, ...detail.conditions.payable].filter((c) => c.ratePct != null).map((c) => <tr key={c.id}>
                        <td>{c.direction === "receivable" ? "受領" : "支払"}</td><td>{c.conditionName ?? "—"}</td>
                        <td>{c.materialName ?? "作品レベル"}</td><td>{c.ratePct}%</td><td>{yen(c.amountExTax, c.currency)}</td>
                      </tr>)}</tbody>
                    </table>
                    : <div className="empty-state">料率を持つ条件はありません。</div>
                )}
              </>
            )}
          </>}
        </div>
      </div>
    </section>
  );
}
