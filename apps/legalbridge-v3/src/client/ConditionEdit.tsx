import { useState } from "react";
import { api, ApiError, money, rate } from "./api.js";
import type { ConditionDetail } from "../server/core/model.js";

/**
 * 条件の編集。
 *
 * 作ったあと直す手段が「MGを10万円足す」ボタンしか無く、条件名も料率も
 * 期間も税区分も画面から直せなかった。サーバ側は前から11項目＋相手先＋
 * 権利の範囲を受け付けている。
 *
 * 実績があるかどうかで保存の意味が変わる。
 *   実績なし … その場で書き換える
 *   実績あり … 旧版を残して新版を作る（改訂）。番号が変わる
 * 押す前にどちらになるかを見せる。あとから「番号が変わった」と驚かせない。
 */

export interface EditResult {
  changed: Array<{ target: string; rows: number }>;
  resolvesThrough: Array<{ target: string; rows: number }>;
  /** 改訂になった場合の新しい条件ID。 */
  revisedTo?: number;
}

type Values = Record<string, string>;

const asMoney = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const asPct = (ppm: number | null | undefined) =>
  ppm === null || ppm === undefined ? "" : String(ppm / 10000);

/** 空欄は「変更なし」ではなく「空にする」。両者を取り違えないよう明示的に分ける。 */
const patchText = (next: string, before: string | null) => {
  const value = next.trim() === "" ? null : next.trim();
  return value === (before ?? null) ? undefined : value;
};
const patchInt = (next: string, before: number | null) => {
  const value = next.trim() === "" ? null : Math.round(Number(next.replace(/[^0-9-]/g, "")));
  if (value !== null && !Number.isFinite(value)) return undefined;
  return value === (before ?? null) ? undefined : value;
};

export function ConditionEdit(
  { detail, onDone, onCancel }:
  { detail: ConditionDetail; onDone: (result: EditResult) => void; onCancel: () => void }
) {
  const [v, setV] = useState<Values>({
    name: detail.name,
    termStart: detail.termStart ?? "",
    termEnd: detail.termEnd ?? "",
    ratePct: asPct(detail.ratePpm),
    flatAmount: asMoney(detail.flatAmount),
    unitAmount: asMoney(detail.unitAmount),
    mgAmount: asMoney(detail.mgAmount),
    agAmount: asMoney(detail.agAmount),
    taxCategory: detail.taxCategory,
    paymentTerms: detail.paymentTerms ?? "",
    notes: detail.notes ?? ""
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, value: string) => setV({ ...v, [k]: value });

  // 実績があると、保存は改訂（旧版を残して新版を作る）になる。
  const willRevise = detail.events.length > 0;
  const readOnly = detail.status === "void" || detail.status === "superseded";

  function buildPatch() {
    const patch: Record<string, unknown> = {};
    const name = v.name.trim();
    if (name && name !== detail.name) patch.name = name;

    const pairs: Array<[string, unknown]> = [
      ["termStart", patchText(v.termStart, detail.termStart)],
      ["termEnd", patchText(v.termEnd, detail.termEnd)],
      ["paymentTerms", patchText(v.paymentTerms, detail.paymentTerms)],
      ["notes", patchText(v.notes, detail.notes)],
      ["flatAmount", patchInt(v.flatAmount, detail.flatAmount)],
      ["unitAmount", patchInt(v.unitAmount, detail.unitAmount)],
      ["mgAmount", patchInt(v.mgAmount, detail.mgAmount)],
      ["agAmount", patchInt(v.agAmount, detail.agAmount)]
    ];
    for (const [key, value] of pairs) if (value !== undefined) patch[key] = value;

    // 画面は % で受け、保存は ppm（百万分率）。12.5% → 125000
    const pct = v.ratePct.trim();
    const ppm = pct === "" ? null : Math.round(Number(pct) * 10000);
    if (ppm !== (detail.ratePpm ?? null) && (ppm === null || Number.isFinite(ppm))) {
      patch.ratePpm = ppm;
    }
    if (v.taxCategory !== detail.taxCategory) patch.taxCategory = v.taxCategory;
    return patch;
  }

  const patch = buildPatch();
  const changedKeys = Object.keys(patch);

  async function save() {
    setBusy(true); setError(null);
    try {
      onDone(await api.patch<EditResult>(`/conditions/${detail.id}`, patch));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (readOnly) {
    return (
      <div className="panel create-form">
        <div className="panel-hd"><h2>条件の編集</h2></div>
        <div className="panel-bd">
          <div className="note warn">
            {detail.status === "void"
              ? "無効にした条件は編集できません。"
              : "旧版の条件は編集できません。最新版を開いて編集してください。"}
          </div>
          <div className="row"><button className="btn" onClick={onCancel}>閉じる</button></div>
        </div>
      </div>
    );
  }

  const field = (name: string, label: string, extra?: { type?: string; hint?: string; wide?: boolean }) => (
    <label className={extra?.wide ? "field wide" : "field"} key={name}>
      <span>{label}</span>
      {extra?.type === "textarea"
        ? <textarea rows={3} value={v[name] ?? ""} onChange={(e) => set(name, e.target.value)} />
        : <input type={extra?.type ?? "text"} value={v[name] ?? ""}
                 inputMode={extra?.type === "number" ? "numeric" : undefined}
                 onChange={(e) => set(name, e.target.value)} />}
      {extra?.hint && <small className="faint">{extra.hint}</small>}
    </label>
  );

  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>条件の編集</h2>
        <span className="code">{detail.conditionNo ?? `#${detail.id}`}</span>
        <span className="faint" style={{ marginLeft: "auto" }}>
          {changedKeys.length ? `${changedKeys.length} 項目を変更` : "変更なし"}
        </span>
      </div>

      <div className="panel-bd">
        <div className={willRevise ? "note warn" : "note"} style={{ marginBottom: 12 }}>
          {willRevise
            ? <>この条件には実績が {detail.events.length} 件あります。保存すると
                <b>旧版を残したまま新版を作ります（改訂）</b>。条件番号が新しくなり、
                いまの版は「差し替え済み」になります。過去の計算書は旧版を指したままです。</>
            : <>実績がまだ無いので、保存すると<b>その場で書き換えます</b>。
                実績が付いたあとは、同じ操作が改訂（新版の作成）になります。</>}
        </div>

        <div className="form-grid">
          {field("name", "条件名")}
          <label className="field">
            <span>税区分</span>
            <select value={v.taxCategory} onChange={(e) => set("taxCategory", e.target.value)}>
              <option value="taxable">課税 10%</option>
              <option value="reduced">軽減 8%</option>
              <option value="exempt">非課税・不課税</option>
            </select>
          </label>
          {field("termStart", "開始", { type: "date" })}
          {field("termEnd", "終了", { type: "date", hint: "空欄は期限なし" })}

          {detail.pricingModel === "revenue_rate" &&
            field("ratePct", "料率（%）", { type: "number", hint: `いまの値 ${rate(detail.ratePpm)}` })}
          {detail.pricingModel === "fixed" &&
            field("flatAmount", "定額（最小通貨単位）", { type: "number",
              hint: `いまの値 ${money(detail.flatAmount, detail.currency)}` })}
          {detail.pricingModel === "unit_rate" &&
            field("unitAmount", "単価（最小通貨単位）", { type: "number",
              hint: `いまの値 ${money(detail.unitAmount, detail.currency)}` })}

          {detail.direction === "out" && (<>
            {field("mgAmount", "MG 最低保証", { type: "number",
              hint: "毎期独立の下限。消化しないので残高を持たない" })}
            {field("agAmount", "AG 前払保証", { type: "number",
              hint: detail.balance
                ? `消化済み ${money(detail.balance.agConsumed, detail.currency)}／残 ${money(detail.balance.agRemaining, detail.currency)}`
                : "実績で相殺していく前払い" })}
          </>)}

          {field("paymentTerms", "支払条件", { wide: true, hint: "例：検収月の翌月末払い" })}
          {field("notes", "備考", { type: "textarea", wide: true })}
        </div>

        {error && <div className="alert">{error}</div>}

        <div className="row">
          <button className="btn primary" disabled={busy || !changedKeys.length}
                  onClick={() => void save()}>
            {busy ? "保存中…" : willRevise ? "改訂して保存" : "保存する"}
          </button>
          <button className="btn" onClick={onCancel} disabled={busy}>やめる</button>
          {!changedKeys.length && <span className="faint">変更された項目がありません</span>}
        </div>

        <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
          相手先の付け替えと権利の範囲は、それぞれ別の操作です（下の欄から行えます）。
          計算方式そのもの（定額・料率・単価）は変えられません。変えると過去の計算根拠が
          変わってしまうため、新しい条件を作ってください。
        </p>
      </div>
    </div>
  );
}
