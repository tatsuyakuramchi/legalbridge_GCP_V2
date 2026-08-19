import { useEffect, useState } from "react";
import type { DocumentFormData } from "../types";
import { isFieldVisible } from "./field-visibility";
import {
  type FieldDefinition, itemFields, intlItemFields, expenseFields, feeFields, conditionFields
} from "./document-line-fields";

type Row = Record<string, unknown>;

type Props = {
  templateKey: string;
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
};

export function SpecializedDocumentForms({ templateKey, formData, onChange }: Props) {
  if (templateKey === "purchase_order" || templateKey === "intl_purchase_order") {
    return <SpecializedSection title="明細・金銭条件" description="発注明細と、必要な場合だけ経費・手数料・利用許諾条件を追加します。">
      <ArrayEditor title="発注明細" itemLabel="明細" dataKey="items" rows={rows(formData.items)}
        fields={templateKey === "intl_purchase_order" ? intlItemFields : itemFields}
        onChange={onChange} defaultRow={{ quantity: 1 }} />
      <ArrayEditor title="経費" itemLabel="経費" dataKey="expenses" rows={rows(formData.expenses)}
        fields={expenseFields} onChange={onChange} />
      <ArrayEditor title="その他手数料" itemLabel="手数料" dataKey="other_fees" rows={rows(formData.other_fees)}
        fields={feeFields} onChange={onChange} />
      <ArrayEditor title="利用許諾・業績連動条件" itemLabel="金銭条件" dataKey="financial_conditions"
        rows={rows(formData.financial_conditions)} fields={conditionFields} onChange={onChange}
        defaultRow={{ currency: "JPY" }} />
    </SpecializedSection>;
  }

  if (templateKey === "individual_license_terms") {
    return <SpecializedSection title="利用許諾の詳細条件" description="利用許諾の金銭条件と、再許諾先がある場合の情報を入力します。">
      <ArrayEditor title="金銭条件" itemLabel="条件" dataKey="financial_conditions"
        rows={rows(formData.financial_conditions)} fields={conditionFields} onChange={onChange}
        defaultRow={{ currency: "JPY" }} />
      <ArrayEditor title="サブライセンシー" itemLabel="サブライセンシー" dataKey="サブライセンシー一覧"
        rows={rows(formData["サブライセンシー一覧"])}
        fields={[
          { name: "name", label: "名称" },
          { name: "region", label: "地域" },
          { name: "language", label: "言語" },
          { name: "contract_date", label: "契約日", type: "date" },
          { name: "rate_pct", label: "料率（%）", type: "number" },
          { name: "note", label: "備考", type: "textarea" }
        ]} onChange={onChange} />
    </SpecializedSection>;
  }

  if (templateKey === "royalty_statement") {
    return <SpecializedSection title="実績と計算" description="実績を入力すると、グロス→MG/AG→消費税→源泉前合計まで自動計算されます（PDFと同一の計算式）。">
      <RoyaltyStatementEditor formData={formData} onChange={onChange} />
      {rows(formData.lines).length > 0 &&
        <ArrayEditor title="計算明細（旧形式・この下書きが使用中）" itemLabel="計算明細" dataKey="lines" rows={rows(formData.lines)}
          fields={[
            { name: "productName", label: "対象商品・契約" },
            { name: "sales_amount", label: "基準売上額", type: "number" },
            { name: "rate_pct", label: "料率（%）", type: "number" },
            { name: "royalty_amount", label: "利用許諾料", type: "number" },
            { name: "basisNote", label: "計算根拠・控除", type: "textarea" }
          ]} onChange={onChange} />}
    </SpecializedSection>;
  }

  if (templateKey === "inspection_certificate") {
    return <SpecializedSection title="検収・支払明細" description="検収した成果物を入力し、必要な場合だけ手数料・経費・変更履歴を追加します。">
      <InspectionLineCards formData={formData} onChange={onChange} />
      {rows(formData.po_expenses).length || rows(formData.po_other_fees).length
        ? <InspectionSettlement formData={formData} onChange={onChange} />
        : <>
          <ArrayEditor title="その他手数料" itemLabel="手数料" dataKey="other_fees"
            rows={rows(formData.other_fees)} fields={feeFields} onChange={onChange} />
          <ArrayEditor title="経費" itemLabel="経費" dataKey="expenses" rows={rows(formData.expenses)}
            fields={expenseFields} onChange={onChange} />
        </>}
      <ArrayEditor title="変更履歴" itemLabel="変更" dataKey="changeLogs" rows={rows(formData.changeLogs)}
        fields={[
          { name: "changedAt", label: "変更日", type: "date" },
          { name: "fieldLabel", label: "変更項目" },
          { name: "beforeValue", label: "変更前" },
          { name: "afterValue", label: "変更後" },
          { name: "reason", label: "変更理由", type: "textarea" }
        ]} onChange={onChange} />
    </SpecializedSection>;
  }

  return null;
}

function SpecializedSection({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return <section id="specialized-fields" className="specialized-editor">
    <div className="specialized-heading">
      <div><span>追加項目</span><h2>{title}</h2><p>{description}</p></div>
    </div>
    {children}
  </section>;
}

function ArrayEditor({
  title,
  itemLabel,
  dataKey,
  rows: currentRows,
  fields,
  onChange,
  defaultRow = {}
}: {
  title: string;
  itemLabel: string;
  dataKey: string;
  rows: Row[];
  fields: FieldDefinition[];
  onChange: (name: string, value: unknown) => void;
  defaultRow?: Row;
}) {
  const replace = (index: number, patch: Row) =>
    onChange(dataKey, currentRows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const remove = (index: number) =>
    onChange(dataKey, currentRows.filter((_, rowIndex) => rowIndex !== index));
  return <div className="array-editor">
    <div className="repeater-title">
      <div><h3>{title}</h3><small>{currentRows.length}件</small></div>
      <button type="button" onClick={() => onChange(dataKey, [...currentRows, { ...defaultRow }])}>＋ {itemLabel}を追加</button>
    </div>
    {!currentRows.length && <p className="inline-empty">必要な場合は「＋ {itemLabel}を追加」を押してください。</p>}
    {currentRows.map((row, index) => <article className="repeater-card" key={index}>
      <div className="repeater-card-head">
        <strong>{itemLabel} {index + 1}</strong>
        <div className="row-actions">
          <button type="button" disabled={index === 0} onClick={() => moveRow(dataKey, currentRows, index, -1, onChange)}>↑</button>
          <button type="button" disabled={index === currentRows.length - 1} onClick={() => moveRow(dataKey, currentRows, index, 1, onChange)}>↓</button>
          <button type="button" onClick={() => remove(index)}>削除</button>
        </div>
      </div>
      <div className="field-grid">
        {/* 出し分けは行ごと。判定対象は同じ行の値なので、明細1でROYALTYを選んでも
            明細2の列は変わらない。 */}
        {fields.filter((field) => isFieldVisible(field, row)).map((field) =>
          <DynamicField key={field.name} definition={field}
            value={row[field.name]} onChange={(value) => replace(index, { [field.name]: value })} />)}
      </div>
    </article>)}
  </div>;
}

function DynamicField({
  definition,
  value,
  onChange
}: {
  definition: FieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const inputValue = String(value ?? "");
  return <label>
    <span>
      {definition.label}
      {/* 長文欄は定型文からの貼り付けが多いので、別タブで開く導線を見出し横に置く。 */}
      {definition.type === "textarea" &&
        <a className="field-snippets" href="/?view=snippets" target="_blank" rel="noreferrer"
          title="定型文を別タブで開く">定型文</a>}
    </span>
    {definition.type === "textarea"
      ? <textarea value={inputValue} onChange={(event) => onChange(event.target.value)} />
      : definition.type === "select"
        ? <select value={inputValue} onChange={(event) => onChange(event.target.value)}>
          <option value="">選択してください</option>
          {definition.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        : <input type={definition.type === "number" ? "number" : definition.type === "date" ? "date" : "text"}
          value={inputValue}
          onChange={(event) => onChange(definition.type === "number" && event.target.value !== ""
            ? Number(event.target.value)
            : event.target.value)} />}
    {definition.helpText && <small>{definition.helpText}</small>}
  </label>;
}

function moveRow(
  dataKey: string,
  currentRows: Row[],
  index: number,
  direction: -1 | 1,
  onChange: (name: string, value: unknown) => void
) {
  const target = index + direction;
  if (target < 0 || target >= currentRows.length) return;
  const reordered = [...currentRows];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  onChange(dataKey, reordered);
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((item): item is Row => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}


// ── 利用許諾料計算書の構造化入力（再設計）───────────────────────────
// 計算書タイプ（単票/多明細）と算定タイプ（イベント式/時限式）を切り替え、
// 生の実績値（rs* フィールド）だけを入力してもらう。グロス・MG/AG・合計などの
// テンプレート変数はサーバ（template-context-adapters）が共有エンジンで組み立てる。
// 多明細はサブライセンシーごとの入金行＝行ごとに通貨・換算方法を持てる
// （交換前=入金日レートで円換算 / 交換後=円転済み額＋適用レートは記録として印字）。
function RoyaltyStatementEditor({ formData, onChange }: {
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
}) {
  const mode = String(formData.statementMode ?? "") === "multi" ? "multi" : "single";
  const basis = String(formData.rsCalcType ?? "") === "period" ? "period" : "event";
  const basisKind = String(formData.rsBasisKind ?? "") === "sublicense" ? "sublicense" : "sales";
  const receipts = rows(formData.rs_receipts);
  const numField = (name: string, label: string, helpText?: string) =>
    <label key={name}><span>{label}</span>
      <input type="number" value={String(formData[name] ?? "")}
        onChange={(event) => onChange(name, event.target.value === "" ? "" : Number(event.target.value))} />
      {helpText && <small>{helpText}</small>}
    </label>;
  const replaceReceipt = (index: number, patch: Row) =>
    onChange("rs_receipts", receipts.map((row, i) => i === index ? { ...row, ...patch } : row));
  const jpyBase = (row: Row): number => {
    const amount = Number(String(row.amount ?? "").replace(/,/g, "")) || 0;
    const isPre = String(row.fxMode ?? "pre") !== "post";
    const foreign = String(row.currency ?? "JPY").toUpperCase() !== "JPY";
    if (isPre && foreign) return Math.round(amount * (Number(row.fxRate) || 0));
    return Math.round(amount);
  };

  return <div className="royalty-editor">
    <div className="mode-inline">
      <span className="mode-label">計算書タイプ:</span>
      <button type="button" className={`matter-chip ${mode === "single" ? "active" : ""}`}
        onClick={() => onChange("statementMode", "single")}>単票（1件計算）</button>
      <button type="button" className={`matter-chip ${mode === "multi" ? "active" : ""}`}
        onClick={() => onChange("statementMode", "multi")}>多明細（受領→支払）</button>
      <small>単票＝製造/売上ベースの1件計算。多明細＝サブライセンス受領額を基に支払を明細ごとに計算</small>
    </div>

    {mode === "single" && <>
      <div className="mode-inline">
        <span className="mode-label">算定タイプ:</span>
        <button type="button" className={`matter-chip ${String(formData.rsCalcType ?? "") === "period" ? "active" : ""}`}
          onClick={() => onChange("rsCalcType", "period")}>期間（時限式）</button>
        <button type="button" className={`matter-chip ${String(formData.rsCalcType ?? "") === "event" ? "active" : ""}`}
          onClick={() => onChange("rsCalcType", "event")}>イベント（製造時等）</button>
        <small>期間＝算定期間内の売上報告ベース／イベント＝製造・出荷等の発生時に数量×単価で算定</small>
      </div>
      {!formData.rsCalcType &&
        <p className="hint-note">算定タイプを選ぶと実績入力が始まります（グロス・MG/AG・合計は自動計算になり、手入力の計算欄は隠れます）。</p>}
      {Boolean(formData.rsCalcType) && (basis === "event"
        ? <div className="field-grid">
          {numField("rsMsrp", "基準価格・上代（税抜）")}
          {numField("rsQuantity", "製造数量（総数）")}
          {numField("rsSampleQuantity", "販促サンプル数", "計算対象外として控除")}
          {numField("rsRatePct", "料率（%）")}
          {numField("rsMgAmount", "MG・最低保証（円）", "グロスが下回ったら MG を採用（floor）")}
          {numField("rsAgAmount", "AG・前払保証金（円）", "累積消化で支払から充当")}
          {numField("rsAgConsumedBefore", "AG消化済み累計（円）", "これまでの計算書で充当した合計")}
        </div>
        : <>
          <div className="field-grid">
            <label><span>基準額の種類</span>
              <select value={basisKind} onChange={(event) => onChange("rsBasisKind", event.target.value)}>
                <option value="sales">報告売上高（売上報告ベース）</option>
                <option value="sublicense">被許諾者受領額（サブライセンス）</option>
              </select></label>
            <label><span>算定期間 From</span>
              <input type="date" value={String(formData.rsPeriodFrom ?? "")}
                onChange={(event) => onChange("rsPeriodFrom", event.target.value)} /></label>
            <label><span>算定期間 To</span>
              <input type="date" value={String(formData.rsPeriodTo ?? "")}
                onChange={(event) => onChange("rsPeriodTo", event.target.value)} /></label>
            {numField("rsMsrp", basisKind === "sublicense" ? "被許諾者受領額（税抜）" : "報告売上高（税抜）")}
            {numField("rsRatePct", "料率（%）")}
            {numField("rsMgAmount", "MG・最低保証（円）", "グロスが下回ったら MG を採用（floor）")}
            {numField("rsAgAmount", "AG・前払保証金（円）", "累積消化で支払から充当")}
            {numField("rsAgConsumedBefore", "AG消化済み累計（円）")}
          </div>
          <p className="hint-note">算定期間は PDF の備考に「算定期間: From〜To」として印字されます。</p>
        </>)}
    </>}

    {mode === "multi" && <>
      <div className="repeater-title">
        <div><h3>サブライセンシー入金（受領明細）</h3><small>{receipts.length}件</small></div>
        <button type="button" onClick={() => onChange("rs_receipts",
          [...receipts, { sublicensee: "", currency: "JPY", fxMode: "pre" }])}>＋ 入金行を追加</button>
      </div>
      <p className="hint-note">行ごとに通貨・換算方法を持てます。<b>交換前</b>＝外貨入金→入金日レートで円換算（round）／<b>交換後</b>＝円転済みの円額を base に、適用レートは記録として PDF に印字。</p>
      {receipts.length > 0 && <div className="table-scroll"><table className="receipt-lines-table">
        <thead><tr>
          <th>サブライセンシー</th><th>受領日</th><th>通貨</th><th className="right">入金額</th>
          <th>換算</th><th className="right">レート</th><th className="right">円換算 base</th><th aria-label="操作"></th>
        </tr></thead>
        <tbody>
          {receipts.map((row, index) => {
            const isPost = String(row.fxMode ?? "pre") === "post";
            const foreign = String(row.currency ?? "JPY").toUpperCase() !== "JPY";
            return <tr key={index}>
              <td><input value={String(row.sublicensee ?? "")}
                onChange={(event) => replaceReceipt(index, { sublicensee: event.target.value })} /></td>
              <td><input type="date" value={String(row.receivedOn ?? "")}
                onChange={(event) => replaceReceipt(index, { receivedOn: event.target.value })} /></td>
              <td><input className="currency" value={String(row.currency ?? "JPY")}
                onChange={(event) => replaceReceipt(index, { currency: event.target.value.toUpperCase() })} /></td>
              <td className="right"><input type="number" value={String(row.amount ?? "")}
                onChange={(event) => replaceReceipt(index, { amount: event.target.value === "" ? "" : Number(event.target.value) })} /></td>
              <td><select value={isPost ? "post" : "pre"}
                onChange={(event) => replaceReceipt(index, { fxMode: event.target.value })}>
                <option value="pre">交換前（外貨入金）</option>
                <option value="post">交換後（円転済み）</option>
              </select></td>
              <td className="right"><input type="number" step="0.0001" value={String(row.fxRate ?? "")}
                placeholder={!isPost && foreign ? "必須" : "記録用"}
                onChange={(event) => replaceReceipt(index, { fxRate: event.target.value === "" ? "" : Number(event.target.value) })} /></td>
              <td className="right base">¥{jpyBase(row).toLocaleString("ja-JP")}
                {!isPost && foreign && !Number(row.fxRate) && <small className="fx-warn">レート未入力</small>}</td>
              <td><button type="button" onClick={() => onChange("rs_receipts", receipts.filter((_, i) => i !== index))}>削除</button></td>
            </tr>;
          })}
        </tbody>
      </table></div>}
      <div className="field-grid">
        {numField("rsInRatePct", "イン側料率（%）", "円 base 合計 × この料率 = 支払額（行ごとに ceil）")}
      </div>
    </>}
  </div>;
}

// ── 明細ごとの検収（ロジック再構成 2026-08-18・承認済みモック準拠）──────────
// 軸は明細ごとの検収状態:
//   今回検収(now)  = この検収書で検収する。金額が発注額と違えば理由を書く（PDFに注記）。
//   検収済み(paid) = 過去に検収・支払済みの分をこの検収書にまとめて記載。支払日は
//                    同じ親POの確定済み検収書履歴から補完。PDFは支払日ごとのグループ表示。
//   未検収(skip)   = この検収書に載せない（後続の検収書で拾う）。
type HistoryEntry = {
  documentNumber: string | null; itemName: string; deliveryDate: string;
  paidDate: string; amountExTax: number; inspectionCompletedAt: string;
};

function InspectionLineCards({ formData, onChange }: {
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
}) {
  const lines = rows(formData.delivery_line_items);
  const parentPo = String(formData.parent_po_number ?? "").trim();
  // 同じ親POの確定済み検収書の明細履歴（検収済み行の支払日・金額の補完に使う）。
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  useEffect(() => {
    if (!parentPo) { setHistory(null); return; }
    let cancelled = false;
    fetch(`/api/v2/documents/inspection-history?po=${encodeURIComponent(parentPo)}`)
      .then((response) => response.ok ? response.json() : { entries: [] })
      .then((data) => { if (!cancelled) setHistory(Array.isArray(data.entries) ? data.entries : []); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [parentPo]);

  const replace = (index: number, patch: Row) =>
    onChange("delivery_line_items", lines.map((row, i) => i === index ? { ...row, ...patch } : row));
  const remove = (index: number) =>
    onChange("delivery_line_items", lines.filter((_, i) => i !== index));
  const add = () => onChange("delivery_line_items",
    [...lines, { item_name: "", inspection_status: "now", inspected_quantity: 1, acceptance_ratio: 1, calc_method: "FIXED" }]);
  const toNum = (value: unknown): number => {
    const parsed = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const statusOf = (row: Row): "now" | "paid" | "skip" => {
    const status = String(row.inspection_status ?? "");
    return status === "paid" || status === "skip" ? status : "now";
  };
  const setStatus = (index: number, status: "now" | "paid" | "skip") => {
    const row = lines[index];
    const patch: Row = { inspection_status: status };
    if (status === "paid" && !String(row.paid_date ?? "").trim()) {
      // 同じ品目の過去実績（最新）から支払日・金額を補完する。
      const match = (history ?? [])
        .filter((entry) => entry.itemName && entry.itemName === String(row.item_name ?? "").trim())
        .at(-1);
      if (match) {
        patch.paid_date = match.paidDate;
        patch.inspected_on = match.inspectionCompletedAt;
        if (!toNum(row.inspected_amount_ex_tax)) patch.inspected_amount_ex_tax = match.amountExTax;
        patch.history_source = match.documentNumber ?? "";
      }
    }
    replace(index, patch);
  };
  const counts = {
    now: lines.filter((row) => statusOf(row) === "now").length,
    paid: lines.filter((row) => statusOf(row) === "paid").length,
    skip: lines.filter((row) => statusOf(row) === "skip").length
  };

  return <div className="inspection-lines">
    <div className="repeater-title">
      <div><h3>明細ごとの検収</h3>
        <small>今回{counts.now}件・済{counts.paid}件・未検収{counts.skip}件</small></div>
      <button type="button" onClick={add}>＋ 明細を追加</button>
    </div>
    {!lines.length && <p className="inline-empty">
      親の発注書から引用するか、「＋ 明細を追加」で入力してください（明細を使わない場合は下の単票入力に金額を直接入力します）。
    </p>}
    {lines.length > 0 &&
      <p className="partial-hint"><b>今回検収</b>＝この検収書で検収（発注額と違えば理由を記載）／<b>検収済み</b>＝過去分をまとめて記載（支払日は履歴から補完・PDFは支払日ごとのグループ表示）／<b>未検収</b>＝今回は載せない（後続の検収書で）。</p>}
    {lines.map((row, index) => {
      const status = statusOf(row);
      const isRoyalty = String(row.calc_method ?? "") === "ROYALTY";
      const ordered = toNum(row.ordered_amount_ex_tax);
      const orderedQty = toNum(row.ordered_quantity);
      const amount = toNum(row.inspected_amount_ex_tax);
      const differs = status !== "skip" && ordered > 0 && amount !== ordered && !(isRoyalty && !amount);
      return <article className={`line-card${status === "skip" ? " skip" : ""}`} key={index}>
        <div className="line-head">
          <input className="line-name" value={String(row.item_name ?? "")} placeholder="品目・成果物"
            onChange={(event) => replace(index, { item_name: event.target.value })} />
          <span className="order-info">
            {orderedQty ? `発注: ${orderedQty.toLocaleString("ja-JP")}点` : ""}
            {ordered ? ` ¥${ordered.toLocaleString("ja-JP")}` : ""}
          </span>
          {status === "paid" && <span className="paid-badge">支払済</span>}
          {status === "now" && !isRoyalty && <span className="plan-badge">支払予定</span>}
          <span className="seg">
            <button type="button" className={status === "now" ? "on-now" : ""}
              onClick={() => setStatus(index, "now")}>今回検収</button>
            <button type="button" className={status === "paid" ? "on-paid" : ""}
              onClick={() => setStatus(index, "paid")}>検収済み</button>
            <button type="button" className={status === "skip" ? "on-skip" : ""}
              onClick={() => setStatus(index, "skip")}>未検収</button>
          </span>
          <button type="button" className="line-remove" onClick={() => remove(index)}>削除</button>
        </div>
        {status === "skip"
          ? <div className="line-body">
            <span className="skip-note">この検収書には載りません。後続の検収書で同じ親POから検収できます。</span>
          </div>
          : <div className="line-body">
            <div className="line-grid">
              {status === "paid" && <>
                <label><span>検収日（過去分）</span><input type="date" value={String(row.inspected_on ?? "")}
                  onChange={(event) => replace(index, { inspected_on: event.target.value })} /></label>
                <label><span>支払日</span><input type="date" value={String(row.paid_date ?? "")}
                  onChange={(event) => replace(index, { paid_date: event.target.value })} /></label>
              </>}
              {status === "now" && <>
                <label><span>今回数量</span><input type="number" className="num" value={String(row.inspected_quantity ?? "")}
                  onChange={(event) => replace(index, { inspected_quantity: event.target.value === "" ? "" : Number(event.target.value) })} /></label>
                <label><span>納品日</span><input type="date" value={String(row.delivery_date ?? "")}
                  onChange={(event) => replace(index, { delivery_date: event.target.value })} /></label>
              </>}
              {isRoyalty && !amount
                ? <span className="line-royalty"><span className="tag-royalty">業績連動</span>
                  {String(row.deliverable_ownership ?? "") === "発注者" ? "別途算定" : "利用許諾料に含む"}
                  <small>支払額に含めない</small></span>
                : <label><span>金額（税抜）</span><input type="number" className="num" value={String(row.inspected_amount_ex_tax ?? "")}
                  onChange={(event) => replace(index, { inspected_amount_ex_tax: event.target.value === "" ? "" : Number(event.target.value) })} /></label>}
              <label><span>報酬方式</span>
                <select value={String(row.calc_method ?? "FIXED")}
                  onChange={(event) => replace(index, { calc_method: event.target.value })}>
                  <option value="FIXED">固定額</option>
                  <option value="ROYALTY">業績連動</option>
                </select></label>
            </div>
            <input className="line-spec" value={String(row.spec ?? "")} placeholder="仕様（PDFに補足として印字）"
              onChange={(event) => replace(index, { spec: event.target.value })} />
            {status === "paid" && Boolean(row.history_source) &&
              <span className="skip-note">✓ 履歴（{String(row.history_source)}）から補完しました。</span>}
            {differs && <div className="diff-note">
              ⚠ 発注額 ¥{ordered.toLocaleString("ja-JP")} と違います
              （{amount > ordered ? "+" : "−"}¥{Math.abs(amount - ordered).toLocaleString("ja-JP")}）。
              変更理由を記載してください（PDF に注記されます）:
              <input value={String(row.change_reason ?? "")} placeholder="例: 仕様変更による減額合意"
                onChange={(event) => replace(index, { change_reason: event.target.value })} />
            </div>}
          </div>}
      </article>;
    })}
  </div>;
}

// ── 経費・手数料の精算（V1 ステップ2-b/2-c の移植）──────────────────────
// 親POから引用した経費・手数料の一覧から「今回の支払に含める」行をチェックで選ぶ。
// 「最終検収」を ON にすると全行を一括で含める（V1 の isFinalInspection と同じ）。
// 選んだ行だけを expenses / other_fees に書く＝PDF と総支払額はそこから計算される。
function InspectionSettlement({ formData, onChange }: {
  formData: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const poExpenses = Array.isArray(formData.po_expenses) ? formData.po_expenses as Array<Record<string, unknown>> : [];
  const poFees = Array.isArray(formData.po_other_fees) ? formData.po_other_fees as Array<Record<string, unknown>> : [];
  const isFinal = Boolean(formData.isFinalInspection);
  const selectedExpenses = new Set((Array.isArray(formData.selectedExpenseLineNos) ? formData.selectedExpenseLineNos : []) as number[]);
  const selectedFees = new Set((Array.isArray(formData.selectedOtherFeeLineNos) ? formData.selectedOtherFeeLineNos : []) as number[]);

  const apply = (nextExpenseNos: number[], nextFeeNos: number[], nextFinal: boolean) => {
    onChange("isFinalInspection", nextFinal);
    onChange("selectedExpenseLineNos", nextExpenseNos);
    onChange("selectedOtherFeeLineNos", nextFeeNos);
    const expenseSet = new Set(nextExpenseNos);
    const feeSet = new Set(nextFeeNos);
    onChange("expenses", poExpenses.filter((row) => expenseSet.has(Number(row.line_no))));
    onChange("other_fees", poFees.filter((row) => feeSet.has(Number(row.line_no))));
  };
  const toggleFinal = () => {
    const next = !isFinal;
    apply(next ? poExpenses.map((row) => Number(row.line_no)) : [...selectedExpenses],
      next ? poFees.map((row) => Number(row.line_no)) : [...selectedFees], next);
  };
  const toggleRow = (kind: "expense" | "fee", lineNo: number) => {
    if (isFinal) return;
    const set = new Set(kind === "expense" ? selectedExpenses : selectedFees);
    if (set.has(lineNo)) set.delete(lineNo); else set.add(lineNo);
    apply(kind === "expense" ? [...set] : [...selectedExpenses],
      kind === "fee" ? [...set] : [...selectedFees], isFinal);
  };
  const amountOf = (row: Record<string, unknown>) =>
    Number(String(row.amount_inc_tax ?? row.amount_ex_tax ?? row.amount ?? 0).replace(/,/g, "")) || 0;

  return <div className="inspection-settlement">
    <div className="inspection-settlement-head">
      <h4>経費・手数料の精算（親PO連動）</h4>
      <button type="button" className={`matter-chip ${isFinal ? "active" : ""}`} onClick={toggleFinal}
        title="ON にすると全行を「今回含める」にします">
        {isFinal ? "✓ 最終検収（全行を含む）" : "最終検収にする"}
      </button>
    </div>
    <p className="hub-note">チェックした行だけが今回の総支払額に加算され PDF に載ります。チェックしない行は今回の検収では精算しません（後続の検収書で精算できます）。</p>
    {poExpenses.length > 0 && <table className="settlement-table"><thead>
      <tr><th></th><th>経費</th><th className="right">金額（税込）</th></tr></thead><tbody>
      {poExpenses.map((row) => {
        const lineNo = Number(row.line_no);
        return <tr key={`e${lineNo}`}>
          <td><input type="checkbox" checked={isFinal || selectedExpenses.has(lineNo)}
            disabled={isFinal} onChange={() => toggleRow("expense", lineNo)} /></td>
          <td>{String(row.expense_name ?? row.item_name ?? row.name ?? `経費 ${lineNo}`)}</td>
          <td className="right">¥{amountOf(row).toLocaleString("ja-JP")}</td>
        </tr>;
      })}
    </tbody></table>}
    {poFees.length > 0 && <table className="settlement-table"><thead>
      <tr><th></th><th>その他手数料</th><th className="right">金額（税抜）</th></tr></thead><tbody>
      {poFees.map((row) => {
        const lineNo = Number(row.line_no);
        return <tr key={`f${lineNo}`}>
          <td><input type="checkbox" checked={isFinal || selectedFees.has(lineNo)}
            disabled={isFinal} onChange={() => toggleRow("fee", lineNo)} /></td>
          <td>{String(row.fee_name ?? row.item_name ?? row.name ?? `手数料 ${lineNo}`)}</td>
          <td className="right">¥{amountOf(row).toLocaleString("ja-JP")}</td>
        </tr>;
      })}
    </tbody></table>}
  </div>;
}
