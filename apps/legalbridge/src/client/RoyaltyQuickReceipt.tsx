import { useEffect, useState } from "react";
import type { DocumentFormData } from "../types";
import {
  buildQuickReceiptPatch, emptyQuickReceipt, quickReceiptJpy, type QuickEconomics, type QuickLine, type QuickReceipt
} from "./royalty-quick-receipt";

// 利用許諾料計算書「かんたん受領入力」（ライセンスアウト入金 → 許諾者への支払・2026-09-04）。
// 計算書の欄が多くて作れない、という指摘への対応。入力は ①支払先（イン条件）②入金元（アウト条件）
// ③入金額 の 3 つ。適用すると計算書の欄（ライセンサー・原著作物・製品名・契約番号・入金企業・
// デザイナー／権利者・カテゴリー・通貨・受領行・イン側料率）がまとめて埋まり、多明細モードで
// 支払額・消費税・税込が自動計算される。確定するとイン条件へ消化イベントが記帳される。

type LineRow = QuickLine & { direction: string | null; ratePct: number | null; effective: boolean; ledgerStatus?: string | null };

function LineSearch({ label, hint, direction, value, onPick }: {
  label: string; hint: string; direction: "in" | "out"; value: QuickLine | null; onPick: (line: LineRow | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<LineRow[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v2/condition-lines?q=${encodeURIComponent(query.trim())}&limit=200`, { signal: controller.signal });
        if (!response.ok) { setItems([]); return; }
        const rows = ((await response.json()).items ?? []) as LineRow[];
        setItems(rows
          .filter((r) => (direction === "out" ? r.direction === "receivable" : r.direction !== "receivable"))
          .filter((r) => direction === "out" || r.ratePct != null)
          .slice(0, 40));
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setItems([]);
      } finally { setLoading(false); }
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query, direction]);
  return <label className="ledger-combobox-label">
    <span>{label}</span><small>{hint}</small>
    <div className="ledger-combobox">
      {value ? <div className="ledger-selection">
        <div><strong>{value.vendorName || "（相手先未設定）"}</strong>
          <small>{[value.documentNumber, value.conditionName, value.workTitle].filter(Boolean).join("・")}</small></div>
        <button type="button" onClick={() => { onPick(null); setQuery(""); }}>変更</button>
      </div> : <>
        <input role="combobox" aria-expanded={open} value={query} placeholder="契約番号・条件名・相手先・作品で検索…"
          onFocus={() => setOpen(true)} onChange={(e) => { setQuery(e.target.value); setOpen(true); }} />
        {open && <div className="ledger-combobox-results" role="listbox">
          {loading && <p>検索中…</p>}
          {!loading && !items.length && <p>一致する条件明細がありません</p>}
          {!loading && items.map((r) => <button type="button" role="option" key={r.id} disabled={!r.effective}
            title={!r.effective ? "無効・下書きの条件は選べません" : undefined}
            onClick={() => { onPick(r); setOpen(false); }}>
            <strong>{r.vendorName || "（相手先未設定）"}</strong>
            <span>{r.documentNumber ?? "—"}{r.ratePct != null ? `・${r.ratePct}%` : ""}</span>
            <small>{[r.conditionName, r.workTitle].filter(Boolean).join("／")}{!r.effective ? "（無効）" : ""}</small>
          </button>)}
        </div>}
      </>}
    </div>
  </label>;
}

export function RoyaltyQuickReceipt({ formData, onApply }: {
  formData: DocumentFormData;
  onApply: (patch: DocumentFormData, message: string) => void;
}) {
  const [inLine, setInLine] = useState<QuickLine | null>(null);
  const [outLine, setOutLine] = useState<QuickLine | null>(null);
  const [economics, setEconomics] = useState<QuickEconomics | null>(null);
  const [economicsNote, setEconomicsNote] = useState("");
  const [receipt, setReceipt] = useState<QuickReceipt>(emptyQuickReceipt());
  const [companyName, setCompanyName] = useState("");
  const [open, setOpen] = useState(!formData.rsConditionLineId);

  useEffect(() => {
    fetch("/api/v2/master-data/search?type=company&q=")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { const item = d?.items?.[0]; if (item?.values?.name) setCompanyName(String(item.values.name)); })
      .catch(() => undefined);
  }, []);

  async function pickIn(line: LineRow | null) {
    setInLine(line); setEconomics(null); setEconomicsNote("");
    if (!line) return;
    const response = await fetch(`/api/v2/royalty/condition-economics/${line.id}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setEconomicsNote(`✗ ${data.error ?? "条件の経済条件を取得できませんでした"}`); return; }
    setEconomics(data.economics);
    setEconomicsNote(`✓ イン側料率 ${data.economics.ratePct}%・MG ¥${Number(data.economics.mgAmount || 0).toLocaleString("ja-JP")}・AG消化済み ¥${Number(data.economics.agConsumed || 0).toLocaleString("ja-JP")}`);
  }
  function pickOut(line: LineRow | null) {
    setOutLine(line);
    if (line) setReceipt((r) => ({ ...r, sublicensee: line.vendorName || r.sublicensee, currency: (line.currency ?? r.currency) || "JPY" }));
  }

  const jpy = quickReceiptJpy(receipt);
  const foreign = (receipt.currency || "JPY").toUpperCase() !== "JPY";
  const ready = Boolean(inLine && economics && (receipt.sublicensee.trim() || outLine) && Number(receipt.amount) > 0 && (!foreign || receipt.fxMode === "post" || Number(receipt.fxRate) > 0));
  const preview = economics && jpy > 0 ? Math.ceil(jpy * economics.ratePct / 100) : 0;

  function apply() {
    if (!inLine || !economics) return;
    const patch = buildQuickReceiptPatch({ inLine, economics, outLine, receipt, companyName, existing: formData });
    onApply(patch, `かんたん受領入力を反映しました: ${receipt.sublicensee.trim() || outLine?.vendorName} からの入金 ¥${jpy.toLocaleString("ja-JP")} × ${economics.ratePct}% → ${inLine.vendorName} への支払。契約・当事者・製品名も埋めました（右の計算結果と下の欄を確認して確定）`);
    setReceipt(emptyQuickReceipt());
    setOpen(false);
  }

  return <div className="quick-receipt">
    <div className="mode-inline">
      <span className="mode-label">かんたん受領入力</span>
      <small>ライセンスアウトの入金額から、許諾者への支払計算書を 3 つの入力で作る（相手先は条件台帳から選ぶ）</small>
      <button type="button" className="matter-chip" onClick={() => setOpen((v) => !v)}>{open ? "閉じる" : "開く"}</button>
    </div>
    {open && <>
      <div className="field-grid">
        <LineSearch label="① 支払先（許諾者）＝利用許諾 イン の条件明細" hint="当社が支払う料率。記帳先になり、料率・MG/AG・AG消化累計が入る" direction="in" value={inLine} onPick={(l) => void pickIn(l)} />
        <LineSearch label="② 入金元（サブライセンシー）＝利用許諾 アウト の条件明細" hint="無ければ下の名称欄に直接入力" direction="out" value={outLine} onPick={pickOut} />
      </div>
      {economicsNote && <small className={economicsNote.startsWith("✓") ? "settings-effective" : "fx-warn"}>{economicsNote}</small>}
      <div className="field-grid">
        <label><span>入金元の名称</span><input value={receipt.sublicensee} placeholder={outLine?.vendorName || "例: Meridian Games"} onChange={(e) => setReceipt({ ...receipt, sublicensee: e.target.value })} /></label>
        <label><span>③ 入金額</span><input type="number" value={String(receipt.amount)} onChange={(e) => setReceipt({ ...receipt, amount: e.target.value === "" ? "" : Number(e.target.value) })} /></label>
        <label><span>受領日</span><input type="date" value={receipt.receivedOn} onChange={(e) => setReceipt({ ...receipt, receivedOn: e.target.value })} /></label>
        <label><span>通貨</span><input value={receipt.currency} onChange={(e) => setReceipt({ ...receipt, currency: e.target.value.toUpperCase() })} /></label>
        {foreign && <>
          <label><span>換算</span><select value={receipt.fxMode} onChange={(e) => setReceipt({ ...receipt, fxMode: e.target.value as "pre" | "post" })}>
            <option value="pre">交換前（外貨入金・入金日レートで円換算）</option>
            <option value="post">交換後（円転済みの円額を入力）</option></select></label>
          <label><span>レート</span><input type="number" step="0.0001" value={String(receipt.fxRate)} onChange={(e) => setReceipt({ ...receipt, fxRate: e.target.value === "" ? "" : Number(e.target.value) })} /></label>
        </>}
      </div>
      <div className="mode-inline">
        <button type="button" className="primary" disabled={!ready} onClick={apply}>この内容で計算書の欄を埋める</button>
        {economics && jpy > 0 && <small>円換算 base ¥{jpy.toLocaleString("ja-JP")} × {economics.ratePct}% ＝ 支払（税抜）¥{preview.toLocaleString("ja-JP")}（消費税・税込は右の計算結果）</small>}
        {!ready && <small>①の条件明細、入金元の名称（または②）、入金額を入れると適用できます</small>}
      </div>
    </>}
  </div>;
}
