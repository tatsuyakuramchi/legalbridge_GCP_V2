import { useEffect, useMemo, useState } from "react";

type LedgerItem = { id: string; code: string; title: string; subtitle: string };
type OverlapLine = {
  id: number; conditionName: string; direction: string | null; flowDirection: string | null;
  sourceMaterialId: number | null; materialName: string | null;
  amountExTax: number | null; mgAmount: number | null; currency: string | null; documentNumber: string | null;
};
type Overlap = { workId: number; total: number; receivableCount: number; payableCount: number; lines: OverlapLine[] };
type Kind = "license" | "product";
type FormState = {
  workId: string; counterpartyId: string; conditionName: string; transactionKind: Kind;
  territory: string; languages: string; exclusivity: "exclusive" | "non_exclusive" | "sole";
  sublicenseAllowed: boolean; termStart: string; termEnd: string; currency: string;
  paymentScheme: "royalty" | "per_unit" | "lump_sum"; ratePct: string;
  amountExTax: string; mgAmount: string; advanceAmount: string; reportingCycle: string;
  paymentTerms: string; royaltyBase: string; incoterms: string; minimumQuantity: string;
  sellOffPeriod: string; withholdingTaxTreatment: string; documentNumber: string; notes: string;
};

const initial: FormState = {
  workId: "", counterpartyId: "", conditionName: "", transactionKind: "license",
  territory: "", languages: "", exclusivity: "non_exclusive", sublicenseAllowed: false,
  termStart: "", termEnd: "", currency: "JPY", paymentScheme: "royalty", ratePct: "",
  amountExTax: "", mgAmount: "", advanceAmount: "", reportingCycle: "", paymentTerms: "",
  royaltyBase: "", incoterms: "", minimumQuantity: "", sellOffPeriod: "",
  withholdingTaxTreatment: "", documentNumber: "", notes: ""
};

export function OutboundConditionWorkspace({ onNavigate }: { onNavigate?: (target: string) => void } = {}) {
  const [form, setForm] = useState(initial);
  const [works, setWorks] = useState<LedgerItem[]>([]);
  const [vendors, setVendors] = useState<LedgerItem[]>([]);
  const [notice, setNotice] = useState("入力内容を確認後、管理者だけが保存できます。");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [overlap, setOverlap] = useState<Overlap | null>(null);
  const license = form.transactionKind === "license";

  useEffect(() => {
    Promise.all([
      fetch("/api/v2/ledgers/works?limit=500").then((response) => response.json()),
      fetch("/api/v2/ledgers/vendors?limit=500").then((response) => response.json())
    ]).then(([workData, vendorData]) => {
      setWorks((workData.items ?? []).filter((item: LedgerItem) => item.subtitle.includes("自社作品")));
      setVendors(vendorData.items ?? []);
    }).catch(() => setNotice("作品または相手方の候補を取得できませんでした"));
  }, []);

  const work = useMemo(() => works.find((item) => item.id === form.workId), [works, form.workId]);
  const vendor = useMemo(() => vendors.find((item) => item.id === form.counterpartyId), [vendors, form.counterpartyId]);

  // 作品を選ぶと、その作品に既に紐づく条件を取得して重複警告を出す（導線ガード）。
  // 包括条件と個別（マテリアル由来）条件は別建てで消化実績に合算されるため、
  // 同一方向（受取）の既存条件があれば二重計上に気づけるようにする。
  useEffect(() => {
    const numericId = form.workId.includes(":") ? form.workId.split(":").pop() : form.workId;
    if (!numericId || !/^\d+$/.test(numericId)) { setOverlap(null); return; }
    const controller = new AbortController();
    fetch(`/api/v2/condition-lines/overlap?workId=${numericId}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setOverlap(data.overlap ?? null))
      .catch(() => setOverlap(null));
    return () => controller.abort();
  }, [form.workId]);
  const sameDirectionCount = overlap?.receivableCount ?? 0;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "transactionKind") {
        const nextLicense = value === "license";
        next.paymentScheme = nextLicense ? "royalty" : "per_unit";
        next.ratePct = "";
        next.amountExTax = "";
      }
      return next;
    });
    // preview は破棄しない（破棄すると 保存 が無効化され「修正→再確認→保存」の無限ループになる・監査G2）。
    // 保存時にサーバ側で再検証されるため、ここでは注記のみ。
    setNotice((current) => current && !current.includes("変更") ? `${current}（変更あり・保存時に再検証されます）` : current);
  }

  function requestBody() {
    const number = (value: string) => value === "" ? undefined : Number(value);
    return {
      ...form,
      workLabel: work ? `${work.code} ${work.title}` : "",
      counterpartyLabel: vendor ? `${vendor.code} ${vendor.title}` : "",
      languages: form.languages.split(/[,、]/).map((value) => value.trim()).filter(Boolean),
      termStart: form.termStart || undefined,
      termEnd: form.termEnd || undefined,
      ratePct: number(form.ratePct),
      amountExTax: number(form.amountExTax),
      mgAmount: number(form.mgAmount),
      advanceAmount: number(form.advanceAmount),
      minimumQuantity: number(form.minimumQuantity)
    };
  }

  async function validate() {
    if (!form.documentNumber.trim()) {
      setNotice("根拠文書番号は必須です（実在する文書番号を入力してください）。");
      return;
    }
    setNotice("入力内容を確認しています");
    const response = await fetch("/api/v2/outbound-conditions/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody())
    });
    const result = await response.json();
    if (!response.ok) {
      setPreview(null);
      setNotice((result.errors ?? []).map((error: { message: string }) => error.message).join("／") || "入力内容を確認してください");
      return;
    }
    setPreview(result.condition);
    setNotice("入力内容を確認しました。根拠文書番号と登録予定内容を確認して保存してください。");
  }

  async function save() {
    if (!preview) return;
    if (!form.documentNumber.trim()) {
      setNotice("保存には実在する根拠文書番号が必要です。");
      return;
    }
    if (!window.confirm(`${form.conditionName}を受取条件として本番台帳へ追加します。よろしいですか？`)) return;

    setNotice("アウト条件を保存しています");
    const response = await fetch("/api/v2/outbound-conditions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody())
    });
    const result = await response.json();
    if (!response.ok) {
      const messages = (result.errors ?? result.issues ?? [])
        .map((error: { message?: string }) => error.message)
        .filter(Boolean);
      setNotice(messages.join("／") || result.error || "アウト条件を保存できませんでした");
      return;
    }
    setPreview(null);   // 再押下による重複登録を防ぐ（再登録は再度「入力内容を確認」から）
    setNotice(`アウト条件を保存しました（条件ID: ${result.condition.id}・条件明細画面で確認できます）。外部連携は実行されていません。`);
  }

  return <section className="page outbound-condition">
    <div className="page-title">
      <div><p>OUTBOUND CONDITIONS</p><h1>アウト側契約条件</h1><small>当社が対価を受け取るライセンス・製品販売条件</small></div>
    </div>
    {onNavigate && <div className="surface-xref" role="navigation" aria-label="条件の関連画面">
      <span className="surface-xref-here">作成（ここ）</span>
      <button type="button" onClick={() => onNavigate("conditions")}>閲覧・検収 → 条件明細</button>
    </div>}
    <div className="outbound-direction"><strong>請求方向：受取</strong><span>受取条件として固定されます</span></div>
    <div className="outbound-kind">
      <button className={license ? "active" : ""} onClick={() => update("transactionKind", "license")}>ライセンスアウト</button>
      <button className={!license ? "active" : ""} onClick={() => update("transactionKind", "product")}>プロダクトアウト</button>
    </div>
    {overlap && overlap.total > 0 && <div className={`outbound-overlap${sameDirectionCount > 0 ? " warn" : ""}`}>
      <strong>{sameDirectionCount > 0
        ? `⚠ この作品には既に受取(アウト)条件が${sameDirectionCount}件あります。重複登録に注意してください。`
        : `この作品には既存の条件が${overlap.total}件あります（受取${overlap.receivableCount}／支払${overlap.payableCount}）。`}</strong>
      <small>包括条件と個別（マテリアル由来）条件は別建てで消化実績に合算されます。同じ債権を二重に登録しないでください。</small>
      <ul>{overlap.lines.slice(0, 8).map((line) => <li key={line.id}>
        <span className={`ov-dir ov-${line.direction ?? "unknown"}`}>{line.direction === "receivable" ? "受取" : line.direction === "payable" ? "支払" : "—"}</span>
        <span className="ov-scope">{line.sourceMaterialId === null ? "作品レベル" : `素材：${line.materialName ?? line.sourceMaterialId}`}</span>
        <span className="ov-name">{line.conditionName || "名称未設定"}</span>
        <span className="ov-amt">{line.amountExTax !== null ? `${line.currency ?? ""} ${line.amountExTax.toLocaleString()}` : line.mgAmount !== null ? `MG ${line.mgAmount.toLocaleString()}` : ""}</span>
        {line.documentNumber && <span className="ov-doc">{line.documentNumber}</span>}
      </li>)}{overlap.lines.length > 8 && <li className="ov-more">ほか{overlap.lines.length - 8}件</li>}</ul>
    </div>}
    <div className="outbound-form">
      <fieldset><legend>1. 対象と相手方</legend>
        <label>自社作品<select value={form.workId} onChange={(e) => update("workId", e.target.value)}><option value="">選択してください</option>{works.map((item) => <option key={item.id} value={item.id}>{item.code} {item.title}</option>)}</select></label>
        <label>相手方<select value={form.counterpartyId} onChange={(e) => update("counterpartyId", e.target.value)}><option value="">選択してください</option>{vendors.map((item) => <option key={item.id} value={item.id}>{item.code} {item.title}</option>)}</select></label>
        <label>条件名<input value={form.conditionName} onChange={(e) => update("conditionName", e.target.value)} placeholder={license ? "例：英語版ライセンス条件" : "例：海外卸売条件"} /></label>
        <label>根拠文書番号 <em>必須</em><input value={form.documentNumber} onChange={(e) => update("documentNumber", e.target.value)} placeholder="例：ARC-2026-0001（実在する文書番号）" /></label>
      </fieldset>
      <fieldset><legend>2. 権利範囲</legend>
        <label>対象地域<input value={form.territory} onChange={(e) => update("territory", e.target.value)} placeholder="例：全世界（日本を除く）" /></label>
        <label>対象言語<input value={form.languages} onChange={(e) => update("languages", e.target.value)} placeholder="カンマ区切り" /></label>
        <label>独占性<select value={form.exclusivity} onChange={(e) => update("exclusivity", e.target.value as FormState["exclusivity"])}><option value="non_exclusive">非独占</option><option value="exclusive">独占</option><option value="sole">ソール</option></select></label>
        <label className="check"><input type="checkbox" checked={form.sublicenseAllowed} onChange={(e) => update("sublicenseAllowed", e.target.checked)} />再許諾を認める</label>
        <label>開始日<input type="date" value={form.termStart} onChange={(e) => update("termStart", e.target.value)} /></label>
        <label>終了日<input type="date" value={form.termEnd} onChange={(e) => update("termEnd", e.target.value)} /></label>
        <label>Sell-Off期間<input value={form.sellOffPeriod} onChange={(e) => update("sellOffPeriod", e.target.value)} placeholder="例：6か月（月数で入力）" /></label>
      </fieldset>
      <fieldset><legend>3. 金銭条件</legend>
        <label>通貨<input value={form.currency} maxLength={3} onChange={(e) => update("currency", e.target.value.toUpperCase())} /></label>
        {license ? <>
          <label>ロイヤリティ率（%）<input type="number" min="0" max="100" step="0.01" value={form.ratePct} onChange={(e) => update("ratePct", e.target.value)} /></label>
          <label>算定基礎<input value={form.royaltyBase} onChange={(e) => update("royaltyBase", e.target.value)} placeholder="例：純売上額" /></label>
          <label>最低保証金（MG）<input type="number" min="0" value={form.mgAmount} onChange={(e) => update("mgAmount", e.target.value)} /></label>
          <label>前払金（Advance）<input type="number" min="0" value={form.advanceAmount} onChange={(e) => update("advanceAmount", e.target.value)} /></label>
        </> : <>
          <label>価格方式<select value={form.paymentScheme} onChange={(e) => update("paymentScheme", e.target.value as FormState["paymentScheme"])}><option value="per_unit">単価</option><option value="lump_sum">一括金額</option></select></label>
          <label>税抜金額<input type="number" min="0" value={form.amountExTax} onChange={(e) => update("amountExTax", e.target.value)} /></label>
          <label>最低数量<input type="number" min="0" value={form.minimumQuantity} onChange={(e) => update("minimumQuantity", e.target.value)} /></label>
          <label>インコタームズ<input value={form.incoterms} onChange={(e) => update("incoterms", e.target.value)} placeholder="例：EXW" /></label>
        </>}
      </fieldset>
      <fieldset><legend>4. 報告・支払</legend>
        <label>報告周期<input value={form.reportingCycle} onChange={(e) => update("reportingCycle", e.target.value)} placeholder="例：四半期" /></label>
        <label>支払期限<input value={form.paymentTerms} onChange={(e) => update("paymentTerms", e.target.value)} placeholder="例：報告受領後30日以内" /></label>
        <label>海外源泉税の取扱い<input value={form.withholdingTaxTreatment} onChange={(e) => update("withholdingTaxTreatment", e.target.value)} /></label>
        <label className="wide">備考<textarea value={form.notes} onChange={(e) => update("notes", e.target.value)} /></label>
      </fieldset>
    </div>
    <div className="outbound-actions">
      <button className="primary" onClick={validate}>入力内容を確認</button>
      <button onClick={save} disabled={!preview}>確認済み内容を保存</button>
      <span>{notice}</span>
    </div>
    {preview && <section className="panel outbound-preview"><h2>登録予定内容</h2><dl><dt>作品</dt><dd>{String(preview.workLabel)}</dd><dt>相手方</dt><dd>{String(preview.counterpartyLabel)}</dd><dt>取引</dt><dd>{preview.transactionKind === "license" ? "ライセンスアウト" : "プロダクトアウト"}</dd><dt>方向</dt><dd>受取</dd><dt>地域・言語</dt><dd>{String(preview.territory)}／{(preview.languages as string[]).join("、")}</dd><dt>通貨</dt><dd>{String(preview.currency)}</dd></dl></section>}
  </section>;
}
