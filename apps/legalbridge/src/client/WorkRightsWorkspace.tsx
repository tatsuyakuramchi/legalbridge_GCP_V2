import { useEffect, useMemo, useState } from "react";

type WorkSummary = {
  id: number; workCode: string; title: string; kind: string;
  parentWorkId: number | null; derivationType: string | null;
  materialCount: number; conditionCount: number; contractCount: number;
};
type WorkDetail = {
  work: WorkSummary & {
    workType: string | null; status: string | null; creatorName: string | null;
    publisherName: string | null; defaultRightsHolder: string | null; remarks: string | null;
  };
  parent: { id: number; workCode: string; title: string; relationType: string | null } | null;
  children: Array<{ id: number; workCode: string; title: string; relationType: string | null }>;
  materials: Array<{
    id: number; materialCode: string | null; name: string; materialType: string | null;
    materialRole: string | null; acquisitionType: string | null; rightsType: string | null;
    rightsHolder: string | null; territory: string | null; language: string | null; royaltyBearing: boolean;
  }>;
  conditions: Array<{
    id: number; name: string; direction: string | null; flowDirection: string | null;
    transactionKind: string | null; paymentScheme: string | null; calcType: string | null;
    ratePct: number | null; amountExTax: number | null; mgAmount: number | null; agAmount: number | null;
    currency: string | null; territory: string | null; language: string | null; exclusivity: string | null;
    sublicenseAllowed: boolean | null; termStart: string | null; termEnd: string | null;
    parentLicenseConditionId: number | null; sourceMaterialId: number | null; sourceMaterialName: string | null;
    counterparty: string | null; documentNumber: string | null;
  }>;
  contracts: Array<{
    id: number; documentNumber: string | null; title: string; contractType: string | null;
    status: string | null; effectiveDate: string | null; expirationDate: string | null;
    role: string | null; counterparty: string | null;
  }>;
};

type Tab = "overview" | "materials" | "rights" | "conditions" | "contracts" | "lineage";

export function WorkRightsWorkspace({
  onStartLicenseContract,
  onStartSettlement
}: {
  onStartLicenseContract: (workId: number, workTitle: string) => void;
  onStartSettlement: (workId: number, workTitle: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetch(`/api/v2/work-rights?q=${encodeURIComponent(query)}&limit=200`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => {
          const rows = data.works ?? [];
          setWorks(rows);
          setSelectedId((current) => current ?? rows[0]?.id ?? null);
        })
        .catch((error) => { if (error?.name !== "AbortError") setNotice("作品・権利情報を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    fetch(`/api/v2/work-rights/${selectedId}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(setDetail)
      .catch((error) => { if (error?.name !== "AbortError") setNotice("作品詳細を取得できませんでした。"); });
    return () => controller.abort();
  }, [selectedId]);

  const inbound = useMemo(
    () => detail?.conditions.filter((c) => c.flowDirection === "in" || c.direction === "payable") ?? [],
    [detail]
  );
  const outbound = useMemo(
    () => detail?.conditions.filter((c) => c.flowDirection === "out" || c.direction === "receivable") ?? [],
    [detail]
  );

  return <section className="page work-rights-workspace">
    <div className="page-title">
      <div><p>WORK & RIGHTS</p><h1>作品・権利</h1>
        <small>原作・自社作品・派生作品と素材、権利ソース、IN/OUT条件を作品起点で管理します。</small>
      </div>
      {detail && <div className="actions">
        <button onClick={() => onStartSettlement(detail.work.id, detail.work.title)}>利用許諾料を精算</button>
        <button className="primary" onClick={() => onStartLicenseContract(detail.work.id, detail.work.title)}>＋ ライセンス契約</button>
      </div>}
    </div>
    {notice && <div className="context-banner">{notice}</div>}

    <div className="work-rights-layout">
      <aside className="panel work-rights-list">
        <div className="ledger-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="作品名・作品コード・著者で検索" />
          <span>{loading ? "取得中…" : `${works.length}件`}</span>
        </div>
        <div className="work-rights-items">
          {works.map((work) => <button key={work.id}
            className={work.id === selectedId ? "selected" : ""}
            onClick={() => { setSelectedId(work.id); setTab("overview"); }}>
            <span>{work.workCode}</span><strong>{work.title}</strong>
            <small>素材 {work.materialCount} ・ 条件 {work.conditionCount} ・ 契約 {work.contractCount}</small>
          </button>)}
        </div>
      </aside>

      <div className="panel work-rights-detail">
        {!detail && <div className="empty-detail">作品を選択してください。</div>}
        {detail && <>
          <header className="work-rights-head">
            <div><span className="detail-kicker">{detail.work.workCode}</span><h2>{detail.work.title}</h2>
              <p>{detail.work.creatorName || detail.work.defaultRightsHolder || "権利者未設定"} ・ {detail.work.workType || detail.work.kind}</p></div>
            <div className="work-rights-kpis">
              <span><b>{detail.materials.length}</b>素材</span>
              <span><b>{inbound.length}</b>IN</span>
              <span><b>{outbound.length}</b>OUT</span>
            </div>
          </header>

          <nav className="workspace-tabs">
            {([
              ["overview","概要"],["materials","素材"],["rights","権利ソース"],
              ["conditions","IN/OUT条件"],["contracts","関連契約"],["lineage","系譜"]
            ] as Array<[Tab,string]>).map(([key,label]) =>
              <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}
          </nav>

          {tab === "overview" && <div className="work-rights-body">
            <h3>作品3層ビュー</h3>
            <div className="rights-three-layer">
              <article><span>SOURCE / 原作</span><strong>{detail.parent?.title || (detail.work.kind === "source" ? detail.work.title : "原作未設定")}</strong>
                <small>{detail.parent?.workCode || ""}</small></article>
              <i>→</i>
              <article><span>OWN / 自社管理作品</span><strong>{detail.work.title}</strong><small>{detail.work.workCode}</small></article>
              <i>→</i>
              <article><span>DERIVATIVES / 派生</span><strong>{detail.children.length}件</strong>
                <small>{detail.children.map((child) => child.title).join(" / ") || "派生作品なし"}</small></article>
            </div>
            <h3>権利チェーン</h3>
            <div className="rights-chain">
              {inbound.slice(0, 3).map((condition) => <article key={condition.id}>
                <span>IN #{condition.id}</span><strong>{condition.name}</strong>
                <small>{condition.counterparty || "相手方未設定"} / {condition.territory || "地域未設定"} / {condition.sublicenseAllowed ? "再許諾可" : "再許諾条件要確認"}</small>
              </article>)}
              <i>→</i><article className="work-node"><span>WORK</span><strong>{detail.work.title}</strong><small>{detail.work.workCode}</small></article><i>→</i>
              <div className="outbound-stack">{outbound.slice(0,4).map((condition) => <article key={condition.id}>
                <span>OUT #{condition.id}</span><strong>{condition.counterparty || condition.name}</strong>
                <small>{condition.territory || "地域未設定"} / {condition.ratePct ?? "—"}%</small>
              </article>)}</div>
            </div>
          </div>}

          {tab === "materials" && <div className="work-rights-body table-scroll"><table>
            <thead><tr><th>素材コード</th><th>素材名</th><th>類型</th><th>取得区分</th><th>権利</th><th>権利者</th><th>Royalty</th></tr></thead>
            <tbody>{detail.materials.map((m) => <tr key={m.id}><td>{m.materialCode || `#${m.id}`}</td><td><b>{m.name}</b></td>
              <td>{m.materialType || "—"}</td><td>{m.acquisitionType || "—"}</td><td>{m.rightsType || "—"}</td>
              <td>{m.rightsHolder || "—"}</td><td>{m.royaltyBearing ? "対象" : "対象外"}</td></tr>)}</tbody>
          </table></div>}

          {tab === "rights" && <div className="work-rights-body rights-source-grid">
            {inbound.map((c) => <article key={c.id} className="rights-source-card">
              <span>IN CONDITION #{c.id}</span><h3>{c.name}</h3><p>{c.counterparty || "権利元未設定"}</p>
              <dl><div><dt>地域</dt><dd>{c.territory || "—"}</dd></div><div><dt>言語</dt><dd>{c.language || "—"}</dd></div>
                <div><dt>再許諾</dt><dd>{c.sublicenseAllowed === null ? "要確認" : c.sublicenseAllowed ? "可" : "不可"}</dd></div>
                <div><dt>期間</dt><dd>{c.termStart || "—"} ～ {c.termEnd || "—"}</dd></div></dl>
              {c.documentNumber && <small>根拠文書: {c.documentNumber}</small>}
            </article>)}
            {!inbound.length && <div className="empty-state">IN権利条件が登録されていません。</div>}
          </div>}

          {tab === "conditions" && <ConditionMatrix inbound={inbound} outbound={outbound} />}

          {tab === "contracts" && <div className="work-rights-body table-scroll"><table>
            <thead><tr><th>契約番号</th><th>役割</th><th>契約名</th><th>相手方</th><th>期間</th><th>状態</th></tr></thead>
            <tbody>{detail.contracts.map((c) => <tr key={c.id}><td>{c.documentNumber || `CTR #${c.id}`}</td><td>{c.role || "—"}</td>
              <td><b>{c.title || c.contractType || "契約"}</b></td><td>{c.counterparty || "—"}</td>
              <td>{c.effectiveDate || "—"} ～ {c.expirationDate || "—"}</td><td>{c.status || "—"}</td></tr>)}</tbody>
          </table></div>}

          {tab === "lineage" && <div className="work-rights-body">
            <div className="lineage-list">
              {detail.parent && <article><span>親作品</span><strong>{detail.parent.title}</strong><small>{detail.parent.workCode} / {detail.parent.relationType || "parent"}</small></article>}
              <article className="current"><span>現在</span><strong>{detail.work.title}</strong><small>{detail.work.workCode}</small></article>
              {detail.children.map((child) => <article key={child.id}><span>派生</span><strong>{child.title}</strong><small>{child.workCode} / {child.relationType || "derived"}</small></article>)}
            </div>
          </div>}
        </>}
      </div>
    </div>
  </section>;
}

function ConditionMatrix({
  inbound,
  outbound
}: {
  inbound: WorkDetail["conditions"];
  outbound: WorkDetail["conditions"];
}) {
  const base = inbound[0] ?? null;
  const fields: Array<[string,(c: WorkDetail["conditions"][number]) => string]> = [
    ["地域", (c) => c.territory || "—"],
    ["言語", (c) => c.language || "—"],
    ["独占性", (c) => c.exclusivity || "—"],
    ["再許諾", (c) => c.sublicenseAllowed === null ? "—" : c.sublicenseAllowed ? "可" : "不可"],
    ["期間", (c) => `${c.termStart || "—"} ～ ${c.termEnd || "—"}`],
    ["支払方式", (c) => c.paymentScheme || c.calcType || "—"],
    ["料率", (c) => c.ratePct === null ? "—" : `${c.ratePct}%`],
    ["MG", (c) => c.mgAmount === null ? "—" : `${c.currency || ""} ${c.mgAmount}`],
    ["AG", (c) => c.agAmount === null ? "—" : `${c.currency || ""} ${c.agAmount}`]
  ];
  return <div className="work-rights-body">
    <div className="context-banner">IN条件を基準にOUT条件を横並びで確認します。parent_license_condition_idがあるOUTは根拠IN条件との関係を保持します。</div>
    <div className="table-scroll"><table className="rights-matrix">
      <thead><tr><th>条件</th><th>{base ? `IN #${base.id}` : "IN"}</th>
        {outbound.map((c) => <th key={c.id}>OUT #{c.id}<small>{c.counterparty || c.name}</small></th>)}</tr></thead>
      <tbody>{fields.map(([label, read]) => <tr key={label}><th>{label}</th><td>{base ? read(base) : "—"}</td>
        {outbound.map((c) => <td key={c.id} className={matrixClass(base, c, label)}>{read(c)}</td>)}</tr>)}</tbody>
    </table></div>
  </div>;
}

function matrixClass(
  inbound: WorkDetail["conditions"][number] | null,
  outbound: WorkDetail["conditions"][number],
  label: string
) {
  if (!inbound) return "";
  if (outbound.parentLicenseConditionId && outbound.parentLicenseConditionId !== inbound.id) return "matrix-warn";
  if (label === "再許諾" && inbound.sublicenseAllowed === false) return "matrix-ng";
  if (label === "期間" && inbound.termEnd && outbound.termEnd && outbound.termEnd > inbound.termEnd) return "matrix-ng";
  return "";
}
