import { useEffect, useState, type ReactNode } from "react";
import type { DocumentFormData } from "../types";
import { isFieldVisible } from "./field-visibility";
import {
  type FieldDefinition, itemFields, intlItemFields, expenseFields, feeFields
} from "./document-line-fields";
import {
  generatePaymentSchedule, normalizePaymentSchedule, type PaymentScheduleRow
} from "./payment-schedule";
import { canSplitSubscription, splitCount, splitSubscriptionLine } from "./subscription-split";

type Row = Record<string, unknown>;

type Props = {
  templateKey: string;
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
};

export function SpecializedDocumentForms({ templateKey, formData, onChange }: Props) {
  if (templateKey === "purchase_order" || templateKey === "intl_purchase_order") {
    return <SpecializedSection title="明細・金銭条件" description="発注明細と、必要な場合だけ経費・手数料を追加します。利用許諾・業績連動条件は条件台帳から引用されます（ここでは編集しません）。">
      <ArrayEditor title="発注明細" itemLabel="明細" dataKey="items" rows={rows(formData.items)}
        fields={templateKey === "intl_purchase_order" ? intlItemFields : itemFields}
        onChange={onChange} defaultRow={{ quantity: 1 }}
        renderRowExtra={(row, replace) =>
          // 支払スケジュール表を印字するのは国内発注書のみ（海外は 063 で表を廃止し
          // Payment Date 欄＝billing_note に一本化）。編集UIも国内だけに出す。
          templateKey === "purchase_order" && String(row.calc_method ?? "") === "SUBSCRIPTION"
            ? <PaymentScheduleEditor row={row}
                onRows={(schedule) => replace({ payment_schedule: schedule })} />
            : null} />
      <ArrayEditor title="経費" itemLabel="経費" dataKey="expenses" rows={rows(formData.expenses)}
        fields={expenseFields} onChange={onChange} />
      <ArrayEditor title="その他手数料" itemLabel="手数料" dataKey="other_fees" rows={rows(formData.other_fees)}
        fields={feeFields} onChange={onChange} />
      <ConditionQuoteTable formData={formData} />
    </SpecializedSection>;
  }

  if (templateKey === "individual_license_terms") {
    return <SpecializedSection title="利用許諾の詳細条件" description="金銭条件は条件台帳から引用されます。再許諾先がある場合の情報を入力します。">
      <ConditionQuoteTable formData={formData} />
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

// 条件台帳から引用した利用許諾・業績連動条件（読み取り専用・2026-09-04 段階3）。
// 条件明細は「条件を登録する」で作り、文書は引用するだけ。ここで編集できると台帳と
// 文書がずれて二重の正になるため、フォーム側の条件エディタは撤去した。
function ConditionQuoteTable({ formData }: { formData: DocumentFormData }) {
  const conditions = rows(formData.financial_conditions);
  const ledgerNumber = String(formData.condition_ledger_number ?? "").trim();
  const text = (v: unknown) => (v == null || v === "" ? "—" : String(v));
  const money = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return v == null || v === "" || !Number.isFinite(n) ? "—" : `¥${n.toLocaleString("ja-JP")}`; };
  return <section className="repeater condition-quote">
    <div className="repeater-title"><div>
      <h3>利用許諾・業績連動条件{ledgerNumber ? `（条件台帳 ${ledgerNumber} から引用）` : ""}</h3>
      <small>{conditions.length
        ? "台帳の条件明細をそのまま印字します。料率・MG/AG・地域を直すときは条件台帳側で直し、文書を再度起こしてください。"
        : "この文書は条件台帳に紐づいていません。料率・MG/AG などの条件は「権利・条件 → 条件を登録する」で条件明細として登録し、③「新規文書に紐づける」からこの文書を起こすと引用されます。"}</small>
    </div></div>
    {conditions.length > 0 && <div className="table-scroll"><table className="cf-table">
      <thead><tr><th>条件名</th><th>対象素材</th><th>料率</th><th>MG</th><th>AG</th><th>許諾地域・言語</th><th>条件明細キー</th></tr></thead>
      <tbody>{conditions.map((c, i) => <tr key={i}>
        <td>{text(c.condition_name)}</td><td>{text(c.material_code)}</td>
        <td>{c.rate_pct == null || c.rate_pct === "" ? "—" : `${c.rate_pct}%`}</td><td>{money(c.mg_amount)}</td><td>{money(c.ag_amount)}</td>
        <td>{[c.region_territory, c.region_language].filter(Boolean).join("／") || "—"}</td>
        <td className="mono">{text(c.condition_line_code)}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
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

export function ArrayEditor({
  title,
  itemLabel,
  dataKey,
  rows: currentRows,
  fields,
  onChange,
  defaultRow = {},
  renderRowExtra
}: {
  title: string;
  itemLabel: string;
  dataKey: string;
  rows: Row[];
  fields: FieldDefinition[];
  onChange: (name: string, value: unknown) => void;
  defaultRow?: Row;
  // 行の列グリッドに収まらない入れ子の編集UI（サブスクの支払予定日表など）を
  // 行カードの末尾に差し込む。replace はその行への部分更新。
  renderRowExtra?: (row: Row, replace: (patch: Row) => void, index: number) => ReactNode;
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
      {renderRowExtra?.(row, (patch) => replace(index, patch), index)}
    </article>)}
  </div>;
}

// ── サブスク明細の支払予定日（payment_schedule）編集 ─────────────────────
// 国内発注書テンプレートは明細ごとの payment_schedule 配列を「支払スケジュール」表
// としてそのまま印字する。V1 では周期からの自動生成＋行編集ができたが V2 の
// フォームに editor が無く、支払条件を変えても表が古いまま残っていた。
// 海外発注書は 063 で表を廃止したため対象外（Payment Date 欄に一本化）。
function PaymentScheduleEditor({ row, onRows }: {
  row: Row;
  onRows: (schedule: PaymentScheduleRow[]) => void;
}) {
  const schedule = normalizePaymentSchedule(row.payment_schedule);
  // 終了日が空のときに自動生成する回数。
  const [periods, setPeriods] = useState(12);
  const money = (value: number) => `¥${value.toLocaleString("ja-JP")}`;
  const replaceRow = (index: number, patch: Partial<PaymentScheduleRow>) =>
    onRows(schedule.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  const total = schedule.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);

  return <div className="payment-schedule-editor">
    <div className="repeater-title">
      <div><h3>支払予定日（各回の支払日）</h3><small>{schedule.length}回</small></div>
      <div className="row-actions">
        <label className="schedule-periods">回数
          <input type="number" min={1} max={600} value={periods}
            title="終了日が空のときに生成する回数"
            onChange={(event) => setPeriods(Math.max(1, Number(event.target.value) || 1))} />
        </label>
        <button type="button" title="周期・期間・支払日から支払予定日を自動生成（既存リストは置換）"
          onClick={() => onRows(generatePaymentSchedule(row, periods))}>⟳ 自動生成</button>
      </div>
    </div>
    {!schedule.length
      ? <p className="inline-empty">「⟳ 自動生成」で周期から展開するか、「＋ 行追加」で支払日を個別に列挙できます（空のままなら PDF に支払スケジュール表は出ません）。</p>
      : <div className="table-scroll"><table className="settlement-table">
        <thead><tr><th>#</th><th>支払予定日</th><th className="right">金額</th><th aria-label="操作"></th></tr></thead>
        <tbody>
          {schedule.map((entry, index) => <tr key={index}>
            <td>{index + 1}</td>
            <td><input type="date" value={entry.date}
              onChange={(event) => replaceRow(index, { date: event.target.value })} /></td>
            <td className="right"><input type="number" value={String(entry.amount ?? "")}
              onChange={(event) => replaceRow(index,
                { amount: event.target.value === "" ? undefined : Number(event.target.value) })} /></td>
            <td><button type="button" onClick={() => onRows(schedule.filter((_, i) => i !== index))}>削除</button></td>
          </tr>)}
        </tbody>
        <tfoot><tr>
          <td colSpan={2} className="right">合計（{schedule.length}回）</td>
          <td className="right"><b>{money(total)}</b></td><td></td>
        </tr></tfoot>
      </table></div>}
    <div className="row-actions">
      <button type="button" onClick={() =>
        onRows([...schedule, { date: "", amount: Number(row.unit_price) || 0 }])}>＋ 行追加</button>
    </div>
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
  const modeRaw = String(formData.statementMode ?? "");
  const mode = modeRaw === "multi" ? "multi" : modeRaw === "bundle" ? "bundle" : "single";
  const basis = String(formData.rsCalcType ?? "") === "period" ? "period" : "event";
  const basisKind = String(formData.rsBasisKind ?? "") === "sublicense" ? "sublicense" : "sales";
  const receipts = rows(formData.rs_receipts);
  const bundle = rows(formData.rs_bundle);
  const replaceBundle = (index: number, patch: Row) =>
    onChange("rs_bundle", bundle.map((row, i) => i === index ? { ...row, ...patch } : row));
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
      <button type="button" className={`matter-chip ${mode === "bundle" ? "active" : ""}`}
        onClick={() => onChange("statementMode", "bundle")}>束ね（複数契約を1枚）</button>
      <small>単票＝製造/売上ベースの1件計算。多明細＝サブライセンス受領額を基に支払を明細ごとに計算。束ね＝複数の条件明細（契約）を契約ごとに計算して1枚にまとめる</small>
    </div>

    {mode === "bundle" && <>
      <div className="repeater-title">
        <div><h3>束ねる契約（条件明細）</h3><small>{bundle.length}件・契約ごとに単票と同じ計算（グロス→MG→AG充当）をして合計します</small></div>
        <button type="button" onClick={() => onChange("rs_bundle",
          [...bundle, { conditionLineId: "", contractTitle: "", contractNumber: "", conditionName: "", calcType: "period", basisKind: "sales" }])}>＋ 契約を追加</button>
      </div>
      <p className="hint-note">「後続文書 → 利用許諾料計算書」で複数の条件明細にチェックして開くと、条件明細ID・料率・MG/AG・AG消化済み累計が入った状態で始まります。確定すると条件明細ごとに消化イベントが自動記帳されます。</p>
      {bundle.map((row, index) => <BundleEntryCard key={index} row={row} index={index}
        onPatch={(patch) => replaceBundle(index, patch)}
        onRemove={() => onChange("rs_bundle", bundle.filter((_, i) => i !== index))} />)}
    </>}

    {mode === "single" && <>
      <ConditionEconomicsFetch formData={formData} onChange={onChange} />
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

// ── 束ね（複数契約）の 1 契約分の入力カード ─────────────────────────────
// 条件明細IDから料率・MG/AG・AG消化済み累計を取得し、実績（基準額・数量）を入れる。
// 計算は共有エンジン（buildBundleStatementPatch）＝右レール・PDF と同じ。
function BundleEntryCard({ row, index, onPatch, onRemove }: {
  row: Row; index: number; onPatch: (patch: Row) => void; onRemove: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const calcType = String(row.calcType) === "event" ? "event" : "period";
  const basisKind = String(row.basisKind) === "sublicense" ? "sublicense" : "sales";
  const numInput = (key: string, label: string, help?: string) =>
    <label key={key}><span>{label}</span>
      <input type="number" value={String(row[key] ?? "")}
        onChange={(e) => onPatch({ [key]: e.target.value === "" ? "" : Number(e.target.value) })} />
      {help && <small>{help}</small>}
    </label>;
  async function fetchEconomics() {
    const id = Number(row.conditionLineId);
    if (!id) return;
    setBusy(true); setNote("");
    try {
      const response = await fetch(`/api/v2/royalty/condition-economics/${id}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setNote(`✗ ${data.error ?? "取得に失敗しました"}`); return; }
      const e = data.economics;
      onPatch({
        conditionLineId: e.representativeLineId ?? id, conditionName: String(row.conditionName ?? "") || String(e.conditionName ?? ""),
        ratePct: e.ratePct, mgAmount: e.mgAmount, agAmount: e.agAmount, agConsumedBefore: e.agConsumed
      });
      setNote(`✓ ${e.conditionName ?? "条件"}: 料率${e.ratePct}%・MG¥${Number(e.mgAmount || 0).toLocaleString("ja-JP")}・AG消化済み¥${Number(e.agConsumed || 0).toLocaleString("ja-JP")} を反映しました`);
    } catch { setNote("✗ 通信に失敗しました"); } finally { setBusy(false); }
  }
  return <div className="bundle-entry">
    <div className="mode-inline">
      <span className="mode-label">契約 {index + 1}</span>
      <input type="number" style={{ width: "110px" }} placeholder="条件明細ID" value={String(row.conditionLineId ?? "")}
        onChange={(e) => onPatch({ conditionLineId: e.target.value === "" ? "" : Number(e.target.value) })} />
      <button type="button" className="matter-chip" disabled={busy || !Number(row.conditionLineId)} onClick={() => void fetchEconomics()}>{busy ? "取得中…" : "条件から取得"}</button>
      <button type="button" className={`matter-chip ${calcType === "period" ? "active" : ""}`} onClick={() => onPatch({ calcType: "period" })}>期間（時限式）</button>
      <button type="button" className={`matter-chip ${calcType === "event" ? "active" : ""}`} onClick={() => onPatch({ calcType: "event" })}>イベント（製造時等）</button>
      <button type="button" className="link-button" onClick={onRemove}>この契約を外す</button>
      {note && <small className={note.startsWith("✓") ? "settings-effective" : "fx-warn"}>{note}</small>}
    </div>
    <div className="field-grid">
      <label><span>契約名・作品</span><input value={String(row.contractTitle ?? "")} onChange={(e) => onPatch({ contractTitle: e.target.value })} placeholder="例: 「エピローグ」原作許諾" /></label>
      <label><span>契約番号</span><input value={String(row.contractNumber ?? "")} onChange={(e) => onPatch({ contractNumber: e.target.value })} placeholder="例: CT-2026-00042" /></label>
      <label><span>条件名（明細の見出し）</span><input value={String(row.conditionName ?? "")} onChange={(e) => onPatch({ conditionName: e.target.value })} /></label>
      {calcType === "event" ? <>
        {numInput("msrp", "基準価格・上代（税抜）")}
        {numInput("quantity", "製造数量（総数）")}
        {numInput("sampleQuantity", "販促サンプル数", "計算対象外として控除")}
      </> : <>
        <label><span>基準額の種類</span>
          <select value={basisKind} onChange={(e) => onPatch({ basisKind: e.target.value })}>
            <option value="sales">報告売上高（売上報告ベース）</option>
            <option value="sublicense">被許諾者受領額（サブライセンス）</option>
          </select></label>
        <label><span>算定期間 From</span><input type="date" value={String(row.periodFrom ?? "")} onChange={(e) => onPatch({ periodFrom: e.target.value })} /></label>
        <label><span>算定期間 To</span><input type="date" value={String(row.periodTo ?? "")} onChange={(e) => onPatch({ periodTo: e.target.value })} /></label>
        {numInput("msrp", basisKind === "sublicense" ? "被許諾者受領額（税抜）" : "報告売上高（税抜）")}
      </>}
      {numInput("ratePct", "料率（%）")}
      {numInput("mgAmount", "MG・最低保証（円）", "グロスが下回ったら MG を採用（floor）")}
      {numInput("agAmount", "AG・前払保証金（円）", "累積消化で支払から充当")}
      {numInput("agConsumedBefore", "AG消化済み累計（円）")}
    </div>
  </div>;
}

// ── 条件明細とのひも付け（計算書 → 消化管理の連動）──────────────────────
// 条件明細ID を入れて「条件から取得」すると、料率・MG/AG・AG消化済み累計を
// DB（condition_lines / condition_events）から取得してプリフィルする＝手入力による
// 契約条件とのズレ・AG充当の過大過少を防ぐ（V1 getRoyaltyConditionEconomics 相当）。
// ひも付けたまま確定すると、消化イベント（royalty_calc）がサーバ再計算値で自動記帳される。
function ConditionEconomicsFetch({ formData, onChange }: {
  formData: DocumentFormData;
  onChange: (name: string, value: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const idValue = String(formData.rsConditionLineId ?? "");
  const yen = (v: number) => `¥${Number(v || 0).toLocaleString("ja-JP")}`;

  async function fetchEconomics() {
    setBusy(true); setNote("");
    try {
      const response = await fetch(`/api/v2/royalty/condition-economics/${Number(idValue)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setNote(`✗ ${data.error ?? "取得に失敗しました"}`); return; }
      const economics = data.economics;
      onChange("rsRatePct", economics.ratePct);
      onChange("rsMgAmount", economics.mgAmount);
      onChange("rsAgAmount", economics.agAmount);
      onChange("rsAgConsumedBefore", economics.agConsumed);
      // 加算型でセル行のIDを入れた場合は、記帳先を代表行へ正規化する。
      if (economics.representativeLineId && economics.representativeLineId !== Number(idValue)) {
        onChange("rsConditionLineId", economics.representativeLineId);
      }
      setNote(`✓ ${economics.conditionName ?? "条件"}: 料率${economics.ratePct}%・MG${yen(economics.mgAmount)}・AG${yen(economics.agAmount)}`
        + `（消化済み${yen(economics.agConsumed)}・残${yen(economics.agRemaining)}）を反映しました`);
    } catch { setNote("✗ 通信に失敗しました"); } finally { setBusy(false); }
  }

  return <div className="mode-inline">
    <span className="mode-label">条件明細:</span>
    <input type="number" style={{ width: "110px" }} placeholder="条件明細ID"
      value={idValue}
      onChange={(e) => onChange("rsConditionLineId", e.target.value === "" ? "" : Number(e.target.value))} />
    <button type="button" className="matter-chip" disabled={busy || !Number(idValue)}
      onClick={() => void fetchEconomics()}>{busy ? "取得中…" : "条件から取得"}</button>
    <small>「お金 → 条件明細」のIDを入れて取得すると、料率・MG/AG・<b>AG消化済み累計</b>が台帳から自動で入ります。ひも付けたまま確定すると消化イベントも自動記帳されます（空欄なら従来どおり手動）</small>
    {note && <small className={note.startsWith("✓") ? "settings-effective" : "fx-warn"}>{note}</small>}
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
        {canSplitSubscription(row) && <div className="split-band">
          <button type="button" onClick={() => onChange("delivery_line_items",
            [...lines.slice(0, index), ...(splitSubscriptionLine(row) ?? [row]), ...lines.slice(index + 1)])}>
            ⑃ 周期ごとに分割（{splitCount(row)}期）
          </button>
          <small>1周期＝1明細に分けます（支払予定日があれば各期の日付・金額を引き継ぎます）。
            分割後は全期が「未検収」で始まるので、支払済みの期を「検収済み」、今期分を「今回検収」に切り替えてください。</small>
        </div>}
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
                <label><span>{String(row.calc_method ?? "") === "SUBSCRIPTION" ? "今回周期数" : "今回数量"}</span>
                  <input type="number" className="num" value={String(row.inspected_quantity ?? "")}
                  onChange={(event) => {
                    const quantity = event.target.value === "" ? "" : Number(event.target.value);
                    const unit = toNum(row.unit_price);
                    // 単価がある明細は 金額 = 単価 × 数量 を自動再計算（V1 DeliverableCards と同じ）。
                    // 定期支払は「1周期の金額 × 周期数」。単価が無い明細は金額を手入力のまま維持。
                    replace(index, {
                      inspected_quantity: quantity,
                      ...(unit > 0 && quantity !== "" && !isRoyalty
                        ? { inspected_amount_ex_tax: Math.round(unit * Number(quantity)) }
                        : {})
                    });
                  }} /></label>
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
                  <option value="SUBSCRIPTION">定期支払（サブスク）</option>
                </select></label>
              {toNum(row.unit_price) > 0 && !isRoyalty && status === "now" &&
                <small className="unit-calc-note">
                  金額（税抜）＝ {String(row.calc_method ?? "") === "SUBSCRIPTION" ? "1周期" : "単価"}
                  ¥{toNum(row.unit_price).toLocaleString("ja-JP")} × {String(row.calc_method ?? "") === "SUBSCRIPTION" ? "周期数" : "数量"}
                  {" "}{toNum(row.inspected_quantity) || 0}（自動計算・金額の直接修正も可能）
                </small>}
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
