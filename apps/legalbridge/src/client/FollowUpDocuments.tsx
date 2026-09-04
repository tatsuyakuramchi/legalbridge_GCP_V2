import { useEffect, useState } from "react";

// 後続文書の入口（2026-09-04）。検収書と利用許諾料計算書は、条件を登録した時点ではなく
// 時間差（納品後・算定期間の終了後）で依頼が来るため、条件登録フローとは別の入口にする。
//   検収書        … 発注書（発注番号・件名・相手先で検索）を選び、明細・経費・手数料を引いて作る。
//                   分納なら同じ発注書から何度でも（検収済み行は検収書フォーム側で履歴から補完）。
//   利用許諾料計算書 … 有効な条件明細（条件台帳・条件書の料率行）を選び、料率・MG/AG・AG消化累計を
//                   台帳から取得した状態でフォームを開く。旧版・無効・下書きの条件は選べない。

type PurchaseOrder = {
  id: number; documentNumber: string | null; templateType: string; title: string; counterparty: string;
  createdAt: string; lifecycleStatus?: string;
};
type ConditionLine = {
  id: number; documentNumber: string | null; templateType: string | null; direction: string | null; flowDirection: string | null;
  conditionName: string; vendorName: string; workTitle: string; territory: string | null; ratePct: number | null;
  mgAmount: number | null; amountExTax: number | null; currency: string | null; effective: boolean; supersededBy: string | null;
  ledgerStatus?: "draft" | "final" | null;
};

export type FollowUpTab = "inspection" | "statement";

export function FollowUpDocuments({ seed, onCreateInspection, onCreateStatement, onCreateBundleStatement, onOpenConditionLine }: {
  seed: { tab?: FollowUpTab; q?: string };
  onCreateInspection: (purchaseOrder: { id: number; documentNumber: string | null }) => void;
  onCreateStatement: (conditionLineId: number) => void;
  // 複数の条件明細（契約）を 1 枚の計算書に束ねる（statementMode: bundle・2026-09-04）。
  onCreateBundleStatement?: (conditionLineIds: number[]) => void;
  onOpenConditionLine?: (conditionLineId: number) => void;
}) {
  const [tab, setTab] = useState<FollowUpTab>(seed.tab ?? "inspection");
  const [query, setQuery] = useState(seed.q ?? "");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [lines, setLines] = useState<ConditionLine[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const togglePick = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function search() {
    setLoading(true); setError("");
    try {
      if (tab === "inspection") {
        const q = encodeURIComponent(query.trim());
        const [po, intl] = await Promise.all([
          fetch(`/api/v2/documents?q=${q}&template_type=purchase_order&lifecycle=active&limit=60`),
          fetch(`/api/v2/documents?q=${q}&template_type=intl_purchase_order&lifecycle=active&limit=30`)
        ]);
        if (!po.ok) { setError("発注書を検索できませんでした"); return; }
        const list: PurchaseOrder[] = [...((await po.json()).documents ?? []), ...(intl.ok ? (await intl.json()).documents ?? [] : [])];
        list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        setOrders(list);
      } else {
        const response = await fetch(`/api/v2/condition-lines?q=${encodeURIComponent(query.trim())}&limit=300`);
        if (!response.ok) { setError("条件明細を検索できませんでした"); return; }
        const items: ConditionLine[] = (await response.json()).items ?? [];
        setLines(items.filter((l) => l.ratePct != null));
      }
    } catch { setError("通信に失敗しました"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void search(); }, [tab]);

  const visibleLines = (lines ?? []).filter((l) => (direction === "out" ? l.direction === "receivable" : l.direction !== "receivable"));
  const yen = (v: number | null, cur: string | null) => (v == null ? "—" : `${cur && cur !== "JPY" ? cur + " " : "¥"}${v.toLocaleString("ja-JP")}`);

  return <section className="page wce fu">
    <div className="page-title"><div>
      <p>FOLLOW-UP DOCUMENTS</p>
      <h1>後続文書を作る — 検収書・利用許諾料計算書</h1>
      <small>登録済みの契約（発注書・条件明細）を呼び出して作ります。1つの発注に複数回の検収、算定期間ごとの計算書に対応。条件の登録はここではなく「条件を登録する」から。</small>
    </div></div>

    <div className="panel wce-card">
      <div className="wdl-grid cf-entry" style={{ gridTemplateColumns: "repeat(2, minmax(220px, 1fr))" }}>
        <button type="button" className={tab === "inspection" ? "primary" : ""} onClick={() => { setTab("inspection"); }}>
          <b>検収書</b><small>発注番号・件名・相手先で発注書を探し、明細・経費・手数料を引く。分納なら何度でも</small></button>
        <button type="button" className={tab === "statement" ? "primary" : ""} onClick={() => { setTab("statement"); }}>
          <b>利用許諾料計算書</b><small>作品・取引先・契約番号で有効な条件明細を探し、料率・MG/AG・AG消化累計を台帳から入れる</small></button>
      </div>
      <div className="wi-grid" style={{ alignItems: "end" }}>
        <label>{tab === "inspection" ? "発注番号・件名・相手先で検索" : "契約番号（CT-…／文書番号）・作品・取引先・条件名で検索"}
          <input value={query} placeholder={tab === "inspection" ? "例: ARC-PO-2026-0201／スタジオ雨宿り" : "例: CT-2026-00042／エピローグ"}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} /></label>
        {tab === "statement" && <label>方向<select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
          <option value="in">イン（当社が支払う）</option><option value="out">アウト（当社が受け取る）</option></select></label>}
        <label>&nbsp;<button type="button" className="primary" disabled={loading} onClick={() => void search()}>{loading ? "検索中…" : "呼び出す"}</button></label>
      </div>
      {error && <div className="async-error">{error}</div>}

      {tab === "inspection" && orders && <>
        {orders.length === 0 && <p className="wz-hint">該当する発注書がありません。発注書は「条件を登録する」→「新規文書に紐づける」または文書作成から作れます。</p>}
        {orders.length > 0 && <div className="table-scroll"><table className="cf-table fu-table">
          <thead><tr><th>発注番号</th><th>件名</th><th>相手先</th><th>種別</th><th>発行日</th><th></th></tr></thead>
          <tbody>{orders.map((o) => <tr key={o.id}>
            <td className="mono">{o.documentNumber ?? `#${o.id}`}</td><td>{o.title || "—"}</td><td>{o.counterparty || "—"}</td>
            <td>{o.templateType === "intl_purchase_order" ? "海外発注書" : "発注書"}</td><td>{String(o.createdAt ?? "").slice(0, 10)}</td>
            <td><button type="button" className="primary small" onClick={() => onCreateInspection({ id: o.id, documentNumber: o.documentNumber })}>この発注書の検収書を作る →</button></td>
          </tr>)}</tbody></table></div>}
        <p className="wz-hint">検収書フォームでは発注明細が「今回検収」で入り、過去に検収済みの行は同じ発注書の確定済み検収書から補完されます。取込んだ過去の発注書に明細が無いときは、紐づく条件台帳の支払・経費・手数料から明細を補います（条件明細キー・税区分付き）。</p>
      </>}

      {tab === "statement" && lines && <>
        {visibleLines.length === 0 && <p className="wz-hint">該当する料率の条件明細がありません。条件は「条件を登録する」の利用許諾（イン／アウト）から登録します。</p>}
        {onCreateBundleStatement && visibleLines.some((l) => l.effective) && <div className="wz-next" style={{ margin: "6px 18px 0" }}>
          <button type="button" className="primary" disabled={picked.length < 2}
            onClick={() => onCreateBundleStatement(picked)}>選んだ {picked.length} 件を 1 枚の計算書に束ねる →</button>
          <small>複数契約（条件明細）をまとめて 1 枚にするときはチェックして束ねる。1 件だけなら行の「計算書を作る」。同じ相手先への支払を 1 枚にする用途。</small>
        </div>}
        {visibleLines.length > 0 && <div className="table-scroll"><table className="cf-table fu-table">
          <thead><tr>{onCreateBundleStatement && <th style={{ width: 30 }}></th>}<th>契約・文書</th><th>条件名</th><th>相手先</th><th>作品</th><th>料率</th><th>MG</th><th>許諾地域</th><th>状態</th><th></th></tr></thead>
          <tbody>{visibleLines.map((l) => {
            const blocked = !l.effective;
            const state = l.ledgerStatus === "draft" ? "下書き（未確定）" : l.supersededBy ? `無効（旧版 → ${l.supersededBy}）` : l.effective ? "有効" : "無効";
            return <tr key={l.id} className={blocked ? "old" : ""}>
              {onCreateBundleStatement && <td><input type="checkbox" disabled={blocked} checked={picked.includes(l.id)} onChange={() => togglePick(l.id)} aria-label={`${l.conditionName} を束ねる`} /></td>}
              <td className="mono">{l.documentNumber ?? "—"}</td><td>{l.conditionName || "—"}</td><td>{l.vendorName || "—"}</td><td>{l.workTitle || "—"}</td>
              <td>{l.ratePct != null ? `${l.ratePct}%` : "—"}</td><td>{yen(l.mgAmount, l.currency)}</td><td>{l.territory ?? "—"}</td>
              <td>{blocked ? <span className="wz-tag warn">{state}</span> : <span className="wz-tag eff">{state}</span>}</td>
              <td className="fu-actions">
                <button type="button" className="primary small" disabled={blocked} title={blocked ? "無効・下書きの条件は計算書の下地にできません" : undefined}
                  onClick={() => onCreateStatement(l.id)}>計算書を作る →</button>
                {onOpenConditionLine && <button type="button" className="link-button" onClick={() => onOpenConditionLine(l.id)}>条件明細</button>}
              </td>
            </tr>;
          })}</tbody></table></div>}
        <p className="wz-hint">計算書フォームは選んだ条件明細をひも付けた状態で開き、料率・MG/AG・AG消化済み累計が台帳から入ります。ひも付けたまま確定すると消化イベントが自動記帳されます。加算型（同じグループ）の行はどれを選んでも代表行に正規化されます。</p>
      </>}
    </div>
  </section>;
}
