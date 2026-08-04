import { useEffect, useMemo, useState } from "react";

// ロイヤリティ試算プレビュー（読み取り専用・DB書込みなし）。
// V1 の RoyaltyPreviewPanel 相当。純関数エンジン（calc/tax）を
// /api/v2/royalty/preview 経由でライブ試算し、確定前の内訳を可視化する。

type Model = "performance" | "fixed" | "subscription" | "revenue";

type PreviewResult = {
  fee: {
    gross_ex_tax: number;
    after_acceptance: number;
    mg_topup_this_time: number;
    mg_floor_applied: boolean;
    ag_offset_this_time: number;
    ag_remaining_after: number;
    ag_fully_consumed: boolean;
    actual_ex_tax: number;
    tax_rate: number;
    tax_amount: number;
    total_inc_tax: number;
    formula_breakdown: string;
  };
  withholdingEnabled: boolean;
  payment: {
    subtotalExTax: number;
    consumptionTax: number;
    taxIncluded: number;
    withholdingTax: number;
    afterTax: number;
    netTransfer: number;
  };
};

const MODELS: Array<{ value: Model; label: string; hint: string }> = [
  { value: "performance", label: "業績連動型", hint: "基準価格 × 個数 × 料率" },
  { value: "fixed", label: "固定額型", hint: "単価 × 個数" },
  { value: "subscription", label: "サブスク型", hint: "期間額 × 期間数 + 初期費用" },
  { value: "revenue", label: "売上報告型", hint: "報告金額 × 料率（数量なし）" }
];

const yen = (value: number) => new Intl.NumberFormat("ja-JP").format(Math.round(value || 0));

export function RoyaltyPreview() {
  const [model, setModel] = useState<Model>("performance");
  // モデル別入力
  const [basePrice, setBasePrice] = useState("1000");
  const [ratePct, setRatePct] = useState("10");
  const [quantity, setQuantity] = useState("100");
  const [unitPrice, setUnitPrice] = useState("1000");
  const [periodAmount, setPeriodAmount] = useState("5000");
  const [periodCount, setPeriodCount] = useState("12");
  const [initialFee, setInitialFee] = useState("0");
  const [baseAmount, setBaseAmount] = useState("100000");
  // 調整
  const [acceptanceRatio, setAcceptanceRatio] = useState("1");
  const [sampleQuantity, setSampleQuantity] = useState("0");
  const [mgAmount, setMgAmount] = useState("0");
  const [agAmount, setAgAmount] = useState("0");
  const [agConsumedBefore, setAgConsumedBefore] = useState("0");
  // 税・源泉
  const [taxRatePct, setTaxRatePct] = useState("10");
  const [withholding, setWithholding] = useState(false);
  const [reimbursement, setReimbursement] = useState("0");

  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const num = (v: string) => Number(v) || 0;

  const body = useMemo(() => {
    const terms =
      model === "performance"
        ? { type: "performance", base_price: num(basePrice), rate_pct: num(ratePct), quantity: num(quantity) }
        : model === "fixed"
          ? { type: "fixed", unit_price: num(unitPrice), quantity: num(quantity) }
          : model === "subscription"
            ? { type: "subscription", period_amount: num(periodAmount), period_count: num(periodCount), initial_fee: num(initialFee) }
            : { type: "revenue", base_amount: num(baseAmount), rate_pct: num(ratePct) };
    return {
      terms,
      adjustments: {
        acceptance_ratio: num(acceptanceRatio),
        sample_quantity: num(sampleQuantity),
        mg_amount: num(mgAmount),
        ag_amount: num(agAmount),
        ag_consumed_before: num(agConsumedBefore)
      },
      taxRatePct: num(taxRatePct),
      withholding: { formOverride: withholding },
      reimbursementIncTax: num(reimbursement)
    };
  }, [model, basePrice, ratePct, quantity, unitPrice, periodAmount, periodCount, initialFee, baseAmount,
    acceptanceRatio, sampleQuantity, mgAmount, agAmount, agConsumedBefore, taxRatePct, withholding, reimbursement]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/v2/royalty/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          setResult(null);
          setError("入力値を確認してください");
          return;
        }
        setResult(await response.json());
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResult(null);
        setError("試算の通信に失敗しました");
      } finally {
        setLoading(false);
      }
    }, 300); // デバウンス
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [body]);

  const field = (label: string, value: string, set: (v: string) => void, step?: string) => (
    <label><span>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => set(e.target.value)} /></label>
  );

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>ROYALTY PREVIEW</p>
          <h1>ロイヤリティ試算</h1>
          <small>確定前のライブ試算（読み取り専用・保存しません）</small>
        </div>
      </div>

      <div className="royalty-preview-layout">
        <form className="royalty-preview-form" onSubmit={(e) => e.preventDefault()}>
          <div className="royalty-models">
            {MODELS.map((m) => (
              <button type="button" key={m.value}
                className={model === m.value ? "active" : ""}
                onClick={() => setModel(m.value)} title={m.hint}>{m.label}</button>
            ))}
          </div>
          <p className="royalty-model-hint">{MODELS.find((m) => m.value === model)?.hint}</p>

          <div className="field-grid">
            {model === "performance" && <>
              {field("基準価格（MSRP）", basePrice, setBasePrice)}
              {field("料率（%）", ratePct, setRatePct, "0.01")}
              {field("数量", quantity, setQuantity)}
              {field("不課金数量（sample）", sampleQuantity, setSampleQuantity)}
            </>}
            {model === "fixed" && <>
              {field("単価", unitPrice, setUnitPrice)}
              {field("数量", quantity, setQuantity)}
              {field("不課金数量（sample）", sampleQuantity, setSampleQuantity)}
            </>}
            {model === "subscription" && <>
              {field("期間額", periodAmount, setPeriodAmount)}
              {field("期間数", periodCount, setPeriodCount)}
              {field("初期費用", initialFee, setInitialFee)}
            </>}
            {model === "revenue" && <>
              {field("報告金額", baseAmount, setBaseAmount)}
              {field("料率（%）", ratePct, setRatePct, "0.01")}
            </>}
          </div>

          <h2 className="royalty-section-head">調整</h2>
          <div className="field-grid">
            {field("歩留率（0〜1）", acceptanceRatio, setAcceptanceRatio, "0.01")}
            {field("MG（最低保証）", mgAmount, setMgAmount)}
            {field("AG（前払保証）", agAmount, setAgAmount)}
            {field("AG既消化", agConsumedBefore, setAgConsumedBefore)}
          </div>

          <h2 className="royalty-section-head">税・源泉</h2>
          <div className="field-grid">
            {field("消費税率（%）", taxRatePct, setTaxRatePct)}
            {field("立替金（税込）", reimbursement, setReimbursement)}
            <label className="royalty-check"><span>源泉対象</span>
              <input type="checkbox" checked={withholding} onChange={(e) => setWithholding(e.target.checked)} /></label>
          </div>
        </form>

        <aside className="royalty-preview-result">
          <div className="panel-head"><h2>試算結果</h2><span>{loading ? "計算中…" : "税抜・円"}</span></div>
          {error && <div className="royalty-error">{error}</div>}
          {result && !error && <>
            <dl className="royalty-breakdown">
              <div><dt>グロス（税抜）</dt><dd>¥{yen(result.fee.gross_ex_tax)}</dd></div>
              <div><dt>歩留後</dt><dd>¥{yen(result.fee.after_acceptance)}</dd></div>
              <div className={result.fee.mg_floor_applied ? "hl" : ""}>
                <dt>MG floor 上乗せ</dt><dd>{result.fee.mg_floor_applied ? `+¥${yen(result.fee.mg_topup_this_time)}` : "—"}</dd></div>
              <div className={result.fee.ag_offset_this_time > 0 ? "hl" : ""}>
                <dt>AG 相殺</dt><dd>{result.fee.ag_offset_this_time > 0 ? `−¥${yen(result.fee.ag_offset_this_time)}` : "—"}</dd></div>
              <div><dt>AG 残</dt><dd>¥{yen(result.fee.ag_remaining_after)}{result.fee.ag_fully_consumed ? "（使い切り）" : ""}</dd></div>
            </dl>
            <div className="royalty-total-cards">
              <article><span>実支払（税抜）</span><strong>¥{yen(result.fee.actual_ex_tax)}</strong></article>
              <article><span>消費税</span><strong>¥{yen(result.payment.consumptionTax)}</strong></article>
              <article><span>税込</span><strong>¥{yen(result.payment.taxIncluded)}</strong></article>
              <article className={result.withholdingEnabled ? "warn" : ""}>
                <span>源泉税{result.withholdingEnabled ? "（対象）" : "（対象外）"}</span>
                <strong>{result.withholdingEnabled ? `−¥${yen(result.payment.withholdingTax)}` : "—"}</strong></article>
            </div>
            <div className="royalty-net">
              <span>差引振込額</span><strong>¥{yen(result.payment.netTransfer)}</strong>
            </div>
            <small className="royalty-formula">算式：{result.fee.formula_breakdown}</small>
          </>}
          {!result && !error && <div className="royalty-empty">入力すると試算結果が表示されます。</div>}
        </aside>
      </div>
    </section>
  );
}
