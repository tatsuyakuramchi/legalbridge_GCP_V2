import { useEffect, useMemo, useState } from "react";

type Condition = {
  id: number; name: string; workId: number | null; workCode: string | null; workTitle: string | null;
  direction: string | null; flowDirection: string | null; paymentScheme: string | null; calcType: string | null;
  ratePct: number | null; amountExTax: number | null; unitAmount: number | null;
  mgAmount: number | null; agAmount: number | null; currency: string; paymentTerms: string | null;
  royaltyBase: string | null; deductibleCosts: string | null; parentLicenseConditionId: number | null;
  counterparty: string | null; documentNumber: string | null; contractTitle: string | null;
};
type Trigger = "manufacturing" | "sale" | "sublicense_receipt";
type Preview = {
  sourceCondition: Condition; settlementCondition: Condition; trigger: Trigger; occurredAt: string;
  productName: string; edition: string; quantity: number; sampleQuantity: number; billableQuantity: number;
  unitBase: number; grossEventAmount: number; deductions: number; basisAmount: number;
  ratePct: number | null; grossRoyalty: number; actualRoyalty: number; currency: string;
  formula: string; warnings: string[];
};

export function LicenseSettlementWorkspace({
  initialIssueKey = "",
  initialWorkId,
  onOpenDraft
}: {
  initialIssueKey?: string;
  initialWorkId?: number;
  onOpenDraft: (issueKey: string, templateType: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [conditionId, setConditionId] = useState<number | null>(null);
  const [trigger, setTrigger] = useState<Trigger>("sublicense_receipt");
  const [issueKey, setIssueKey] = useState(initialIssueKey);
  const [occurredAt, setOccurredAt] = useState(today());
  const [productName, setProductName] = useState("");
  const [edition, setEdition] = useState("");
  const [quantity, setQuantity] = useState("0");
  const [sampleQuantity, setSampleQuantity] = useState("0");
  const [unitBase, setUnitBase] = useState("0");
  const [grossAmount, setGrossAmount] = useState("0");
  const [deductions, setDeductions] = useState("0");
  const [useNetBasis, setUseNetBasis] = useState(true);
  const [taxRate, setTaxRate] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/v2/license-settlements/conditions?q=${encodeURIComponent(query)}&limit=300`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => {
          const rows: Condition[] = data.conditions ?? [];
          const filtered = initialWorkId ? rows.filter((row) => row.workId === initialWorkId) : rows;
          setConditions(filtered);
          setConditionId((current) => current ?? preferredCondition(filtered)?.id ?? null);
        })
        .catch((error) => { if (error?.name !== "AbortError") setNotice("ライセンス条件を取得できませんでした。"); });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, initialWorkId]);

  const selected = useMemo(() => conditions.find((row) => row.id === conditionId) ?? null, [conditions, conditionId]);

  useEffect(() => {
    if (!selected) return;
    if (!productName) setProductName(selected.workTitle || selected.name);
  }, [selected]);

  function body() {
    return {
      issueKey: issueKey.trim(),
      conditionLineId: conditionId,
      trigger,
      occurredAt: new Date(`${occurredAt}T00:00:00+09:00`).toISOString(),
      productName: productName.trim(),
      edition: edition.trim(),
      quantity: numberValue(quantity),
      sampleQuantity: numberValue(sampleQuantity),
      unitBase: numberValue(unitBase),
      grossAmount: numberValue(grossAmount),
      deductions: numberValue(deductions),
      useNetBasis,
      taxRate: taxRate === "" ? undefined : Number(taxRate)
    };
  }

  async function calculate() {
    if (!conditionId) { setNotice("対象条件を選択してください。"); return; }
    setWorking(true); setNotice("契約条件を読み込み、精算額を計算しています…"); setPreview(null);
    try {
      const { issueKey: _issueKey, ...payload } = body();
      const response = await fetch("/api/v2/license-settlements/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) { setNotice(result.error ?? "計算できませんでした。"); return; }
      setPreview(result.preview);
      setNotice("計算結果を確認してください。");
    } catch {
      setNotice("精算計算APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function createDraft() {
    if (!issueKey.trim()) { setNotice("Backlog課題キー / Request番号を入力してください。"); return; }
    if (!conditionId) { setNotice("対象条件を選択してください。"); return; }
    if (taxRate === "") { setNotice("計算書へ反映する消費税率を確認してください。"); return; }
    setWorking(true); setNotice("利用許諾料計算書のドラフトを作成しています…");
    try {
      const response = await fetch("/api/v2/license-settlements/draft", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body())
      });
      const result = await response.json();
      if (!response.ok) { setNotice(result.error ?? "ドラフトを作成できませんでした。"); return; }
      setPreview(result.preview);
      setNotice("利用許諾料計算書のドラフトを作成しました。");
      onOpenDraft(result.draft.issueKey, "royalty_statement");
    } catch {
      setNotice("ドラフト作成APIへ接続できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  return <section className="page settlement-workspace">
    <div className="page-title">
      <div><p>LICENSE SETTLEMENT</p><h1>利用許諾料の精算</h1>
        <small>期間締めだけでなく、製造・販売・サブライセンス料入金をトリガーに精算します。</small></div>
    </div>
    {notice && <div className="context-banner">{notice}</div>}

    <div className="settlement-flow">
      <span className="active">1. 発生イベント</span><i>→</i><span>2. OUT/IN条件</span><i>→</i>
      <span>3. 自動計算</span><i>→</i><span>4. 計算書</span><i>→</i><span>5. 共有・支払</span>
    </div>

    <div className="settlement-layout">
      <div className="panel settlement-form">
        <section>
          <h2>1. 何が発生しましたか？</h2>
          <div className="trigger-selector">
            <button className={trigger === "manufacturing" ? "active" : ""} onClick={() => setTrigger("manufacturing")}>
              <strong>製造した</strong><small>製造数・MSRP等を基準に精算</small>
            </button>
            <button className={trigger === "sale" ? "active" : ""} onClick={() => setTrigger("sale")}>
              <strong>販売した</strong><small>売上額または販売数量を基準に精算</small>
            </button>
            <button className={trigger === "sublicense_receipt" ? "active" : ""} onClick={() => setTrigger("sublicense_receipt")}>
              <strong>サブライセンス料が入金された</strong><small>入金額・控除後実受領額を基準に精算</small>
            </button>
          </div>
        </section>

        <section>
          <h2>2. 対象条件</h2>
          <input className="wide-search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="作品・相手方・条件名・文書番号を検索" />
          <select value={conditionId ?? ""} onChange={(event) => setConditionId(Number(event.target.value) || null)}>
            <option value="">条件を選択</option>
            {conditions.map((c) => <option key={c.id} value={c.id}>
              #{c.id} {c.workTitle || "作品未設定"} / {c.name || "条件"} / {c.direction || ""} / {c.counterparty || ""}
            </option>)}
          </select>
          {selected && <div className="selected-condition">
            <div><span>選択条件</span><strong>#{selected.id} {selected.name}</strong></div>
            <div><span>作品</span><strong>{selected.workTitle || "—"}</strong></div>
            <div><span>方向</span><strong>{selected.flowDirection || "—"} / {selected.direction || "—"}</strong></div>
            <div><span>料率</span><strong>{selected.ratePct === null ? "—" : `${selected.ratePct}%`}</strong></div>
            <div><span>根拠IN条件</span><strong>{selected.parentLicenseConditionId ? `#${selected.parentLicenseConditionId}` : "自己条件"}</strong></div>
            <div><span>支払条件</span><strong>{selected.paymentTerms || "—"}</strong></div>
          </div>}
        </section>

        <section>
          <h2>3. 実績</h2>
          <div className="settlement-fields">
            <label>Request / Backlog課題キー<input value={issueKey} onChange={(event) => setIssueKey(event.target.value)} placeholder="LEGAL-1234" /></label>
            <label>発生日<input type="date" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
            <label>対象商品・契約<input value={productName} onChange={(event) => setProductName(event.target.value)} /></label>
            <label>版<input value={edition} onChange={(event) => setEdition(event.target.value)} placeholder="通常版等" /></label>
            {trigger !== "sublicense_receipt" && <>
              <label>数量<input type="number" min="0" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
              <label>サンプル数<input type="number" min="0" value={sampleQuantity} onChange={(event) => setSampleQuantity(event.target.value)} /></label>
              <label>基準単価 / MSRP<input type="number" min="0" step="0.01" value={unitBase} onChange={(event) => setUnitBase(event.target.value)} /></label>
              <label>売上・イベント総額（任意）<input type="number" min="0" step="0.01" value={grossAmount} onChange={(event) => setGrossAmount(event.target.value)} /></label>
            </>}
            {trigger === "sublicense_receipt" && <>
              <label>サブライセンス料入金額<input type="number" min="0" step="0.01" value={grossAmount} onChange={(event) => setGrossAmount(event.target.value)} /></label>
              <label>海外源泉税・送金手数料等<input type="number" min="0" step="0.01" value={deductions} onChange={(event) => setDeductions(event.target.value)} /></label>
              <label className="settlement-check"><input type="checkbox" checked={useNetBasis} onChange={(event) => setUseNetBasis(event.target.checked)} />
                控除後の実受領額を算定基礎にする</label>
            </>}
            <label>消費税率（計算書反映）
              <select value={taxRate} onChange={(event) => setTaxRate(event.target.value)}>
                <option value="">確認してください</option>
                <option value="10">10%</option>
                <option value="8">8%</option>
                <option value="0">0% / 対象外</option>
              </select>
            </label>
          </div>
          <div className="settlement-actions"><button className="primary" disabled={working || !conditionId} onClick={calculate}>
            {working ? "計算中…" : "精算額を計算"}</button></div>
        </section>
      </div>

      <aside className="panel settlement-preview">
        <span className="detail-kicker">CALCULATION PREVIEW</span><h2>計算プレビュー</h2>
        {!preview && <div className="empty-detail">条件と実績を入力して「精算額を計算」を押してください。</div>}
        {preview && <>
          <dl className="settlement-summary">
            <div><dt>トリガー</dt><dd>{triggerLabel(preview.trigger)}</dd></div>
            <div><dt>作品</dt><dd>{preview.settlementCondition.workTitle || preview.productName}</dd></div>
            <div><dt>起点条件</dt><dd>#{preview.sourceCondition.id} {preview.sourceCondition.name}</dd></div>
            <div><dt>支払根拠条件</dt><dd>#{preview.settlementCondition.id} {preview.settlementCondition.name}</dd></div>
            <div><dt>イベント総額</dt><dd>{money(preview.grossEventAmount, preview.currency)}</dd></div>
            <div><dt>控除</dt><dd>{money(preview.deductions, preview.currency)}</dd></div>
            <div className="emphasis"><dt>算定基礎</dt><dd>{money(preview.basisAmount, preview.currency)}</dd></div>
            <div><dt>料率</dt><dd>{preview.ratePct === null ? "—" : `${preview.ratePct}%`}</dd></div>
            <div><dt>計算式</dt><dd>{preview.formula}</dd></div>
            <div className="total"><dt>利用許諾料</dt><dd>{money(preview.actualRoyalty, preview.currency)}</dd></div>
          </dl>
          {preview.warnings.length > 0 && <div className="settlement-warnings">
            {preview.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
          </div>}
          <button className="primary settlement-draft-button" disabled={working || !issueKey.trim() || taxRate === ""} onClick={createDraft}>
            利用許諾料計算書を作成
          </button>
          <small className="settlement-note">royalty_statement の下書きを自動作成し、計算根拠・OUT→IN条件・イベント情報を保存します。</small>
        </>}
      </aside>
    </div>
  </section>;
}

function preferredCondition(rows: Condition[]) {
  return rows.find((c) => c.direction === "receivable" && c.parentLicenseConditionId)
    ?? rows.find((c) => c.direction === "payable")
    ?? rows[0];
}
function numberValue(value: string) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function triggerLabel(value: Trigger) {
  if (value === "manufacturing") return "製造";
  if (value === "sale") return "販売";
  return "サブライセンス料入金";
}
function money(value: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 2 }).format(value)}`;
}
