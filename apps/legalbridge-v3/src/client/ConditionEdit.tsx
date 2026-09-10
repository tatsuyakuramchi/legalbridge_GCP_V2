import { useEffect, useState } from "react";
import { api, ApiError, money, rate } from "./api.js";
import type { ConditionDetail } from "../server/core/model.js";
import { CONDITION_KIND_LABEL } from "./labels.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";

/**
 * 条件の編集。
 *
 * 登録のフォーム（ConditionCreateForm）と同じ項目を同じ並びで出す。以前は
 * 編集が金額と期間だけで、相手先・作品・独占性・地域・言語は別の場所に
 * 散っていて、登録した画面と編集の画面が別物に見えた。
 *
 * 変えられないものも同じ場所に出す（向き・種類・通貨・計算方式）。変えると
 * 過去の計算根拠が変わるので、そこは新しい条件を作ってもらう。
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

const today = () => new Date().toISOString().slice(0, 10);

type Values = Record<string, string>;

const asMoney = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const asPct = (ppm: number | null | undefined) =>
  ppm === null || ppm === undefined ? "" : String(ppm / 10000);
const joinScopes = (detail: ConditionDetail, type: string) =>
  detail.scopes.filter((s) => s.scopeType === type).map((s) => s.label).join(", ");
const splitScopes = (v: string) => v.split(/[,、]/).map((x) => x.trim()).filter(Boolean);

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

const PRICING_LABEL: Record<string, string> = {
  fixed: "定額", revenue_rate: "料率", unit_rate: "単価×数量", subscription: "定期課金", none: "計算しない"
};

export function ConditionEdit(
  { detail, onDone, onCancel }:
  { detail: ConditionDetail; onDone: (result: EditResult) => void; onCancel: () => void }
) {
  const [v, setV] = useState<Values>({
    name: detail.name,
    counterpartyId: detail.counterparty ? String(detail.counterparty.id) : "",
    workId: detail.work ? String(detail.work.id) : "",
    termStart: detail.termStart ?? "",
    termEnd: detail.termEnd ?? "",
    ratePct: asPct(detail.ratePpm),
    flatAmount: asMoney(detail.flatAmount),
    unitAmount: asMoney(detail.unitAmount),
    mgAmount: asMoney(detail.mgAmount),
    agAmount: asMoney(detail.agAmount),
    exclusivity: detail.exclusivity ?? "",
    taxCategory: detail.taxCategory,
    paymentTerms: detail.paymentTerms ?? "",
    spec: detail.spec ?? "",
    orderNo: detail.orderNo ?? "",
    deliverableOwnership: detail.deliverableOwnership ?? "",
    regions: joinScopes(detail, "region"),
    languages: joinScopes(detail, "language"),
    notes: detail.notes ?? ""
  });
  const [works, setWorks] = useState<Array<{ id: number; title: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 適用開始日。未来を入れると「予約された改訂」になり、いまの版は生きたまま残る。
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const set = (k: string, value: string) => setV({ ...v, [k]: value });

  useEffect(() => {
    api.get<{ works: Array<{ id: number; title: string }> }>("/works")
      .then((w) => setWorks(w.works)).catch(() => undefined);
  }, []);

  const later = effectiveFrom !== "" && effectiveFrom > today();
  // 実績があると、保存は改訂（旧版を残して新版を作る）になる。
  const willRevise = detail.events.length > 0;
  const readOnly = detail.status === "void" || detail.status === "superseded";

  /** 金額・期間・作品・独占性。PATCH /conditions/:id。 */
  function buildPatch() {
    const patch: Record<string, unknown> = {};
    const name = v.name.trim();
    if (name && name !== detail.name) patch.name = name;

    const pairs: Array<[string, unknown]> = [
      ["termStart", patchText(v.termStart, detail.termStart)],
      ["termEnd", patchText(v.termEnd, detail.termEnd)],
      ["paymentTerms", patchText(v.paymentTerms, detail.paymentTerms)],
      ["notes", patchText(v.notes, detail.notes)],
      ["spec", patchText(v.spec, detail.spec)],
      ["orderNo", patchText(v.orderNo, detail.orderNo)],
      ["deliverableOwnership", patchText(v.deliverableOwnership, detail.deliverableOwnership)],
      ["flatAmount", patchInt(v.flatAmount, detail.flatAmount)],
      ["unitAmount", patchInt(v.unitAmount, detail.unitAmount)],
      ["mgAmount", patchInt(v.mgAmount, detail.mgAmount)],
      ["agAmount", patchInt(v.agAmount, detail.agAmount)],
      ["workId", patchInt(v.workId, detail.work?.id ?? null)],
      ["exclusivity", patchText(v.exclusivity, detail.exclusivity)]
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
  const counterpartyChanged = v.counterpartyId !== "" && Number(v.counterpartyId) !== (detail.counterparty?.id ?? null);
  const scopesChanged = v.regions !== joinScopes(detail, "region") || v.languages !== joinScopes(detail, "language");
  const changedCount = Object.keys(patch).length + (counterpartyChanged ? 1 : 0) + (scopesChanged ? 1 : 0);

  /**
   * 保存の順は 相手先 → 範囲 → 金額。金額は改訂で新しい版を作ることがあり、
   * 新しい版は相手先も範囲も元から写すので、先に元を直しておく。
   */
  async function save() {
    setBusy(true); setError(null);
    try {
      if (counterpartyChanged) {
        await api.patch(`/conditions/${detail.id}/counterparty`, { partyId: Number(v.counterpartyId) });
      }
      if (scopesChanged) {
        // 地域・言語だけ差し替える。媒体・チャネル（下の「権利の範囲」で扱う）は残す。
        const kept = detail.scopes.filter((s) => s.scopeType !== "region" && s.scopeType !== "language")
          .map((s) => ({ scopeType: s.scopeType, label: s.label, code: s.code ?? null }));
        await api.put(`/conditions/${detail.id}/scopes`, { scopes: [
          ...kept,
          ...splitScopes(v.regions).map((label) => ({ scopeType: "region", label, code: null })),
          ...splitScopes(v.languages).map((label) => ({ scopeType: "language", label, code: null }))
        ] });
      }
      if (Object.keys(patch).length) {
        onDone(await api.patch<EditResult>(`/conditions/${detail.id}`,
          { ...patch, effectiveFrom: effectiveFrom || null }));
      } else {
        onDone({ changed: [
          ...(counterpartyChanged ? [{ target: "conditions（相手先）", rows: 1 }] : []),
          ...(scopesChanged ? [{ target: "condition_scopes", rows: 1 }] : [])
        ], resolvesThrough: [] });
      }
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

  const field = (name: string, label: string, extra?: { type?: string; hint?: string; wide?: boolean; placeholder?: string }) => (
    <label className={extra?.wide ? "field wide" : "field"} key={name}>
      <span>{label}</span>
      {extra?.type === "textarea"
        ? <textarea rows={3} value={v[name] ?? ""} placeholder={extra.placeholder} onChange={(e) => set(name, e.target.value)} />
        : <input type={extra?.type ?? "text"} value={v[name] ?? ""} placeholder={extra?.placeholder}
                 inputMode={extra?.type === "number" ? "numeric" : undefined}
                 onChange={(e) => set(name, e.target.value)} />}
      {extra?.hint && <small className="faint">{extra.hint}</small>}
    </label>
  );
  /** 変えられない項目。登録と同じ場所に出し、なぜ変えられないかを添える。 */
  const fixed = (label: string, value: string, why: string) => (
    <label className="field" key={label}>
      <span>{label}</span>
      <input value={value} readOnly disabled />
      <small className="faint">{why}</small>
    </label>
  );

  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>条件の編集</h2>
        <span className="code">{detail.conditionNo ?? `#${detail.id}`}</span>
        <span className="faint" style={{ marginLeft: "auto" }}>
          {changedCount ? `${changedCount} 項目を変更` : "変更なし"}
        </span>
      </div>

      <div className="panel-bd">
        <div className={willRevise || later ? "note warn" : "note"} style={{ marginBottom: 12 }}>
          {later
            ? <>適用開始日が先なので、保存すると<b>{effectiveFrom} から効く改訂として予約します</b>。
                いまの版はその日まで生きたままで、集計にも計算書にも今までどおり使われます。
                当日になると自動で切り替わります（人が押す必要はありません）。</>
            : willRevise
            ? <>この条件には実績が {detail.events.length} 件あります。保存すると
                <b>旧版を残したまま新版を作ります（改訂）</b>。条件番号が新しくなり、
                いまの版は「差し替え済み」になります。過去の計算書は旧版を指したままです。</>
            : <>実績がまだ無いので、保存すると<b>その場で書き換えます</b>。
                実績が付いたあとは、同じ操作が改訂（新版の作成）になります。</>}
        </div>

        {/* 並びは登録のフォームと同じ。 */}
        <div className="form-grid">
          {field("name", "条件名")}
          {fixed("向き", detail.direction === "in" ? "IN 取得（費用側）" : "OUT 許諾（収入側）",
            "向きは変えられません。逆向きなら新しい条件を作ってください")}
          {fixed("種類", CONDITION_KIND_LABEL[detail.kind] ?? detail.kind,
            "種類は案件の取引モデルと結びついているので変えられません")}
          <label className="field">
            <span>相手先</span>
            <SearchSelect value={v.counterpartyId} search={searchParties}
                          valueLabel={detail.counterparty?.name ?? null}
                          placeholder="取引先名・コードで探す"
                          onChange={(id) => set("counterpartyId", id)} />
            <small className="faint">付け替えても、この条件を出した文書や過去の支払は書き換わりません</small>
          </label>
          <label className="field">
            <span>作品</span>
            <SearchSelect value={v.workId} emptyLabel="—"
                          options={works.map((w) => ({ value: String(w.id), label: w.title }))}
                          valueLabel={detail.work?.title ?? null}
                          placeholder="作品名で探す"
                          onChange={(id) => set("workId", id)} />
          </label>
          {field("termStart", "開始", { type: "date" })}
          {field("termEnd", "終了", { type: "date", hint: "空欄は期限なし" })}
          {fixed("通貨", detail.currency, "通貨は変えられません。金額の意味が変わるため")}
          {fixed("計算方式", PRICING_LABEL[detail.pricingModel] ?? detail.pricingModel,
            "計算方式は変えられません。変えると過去の計算根拠が変わるので、新しい条件を作ってください")}

          {detail.pricingModel === "fixed" &&
            field("flatAmount", "定額（最小通貨単位）", { type: "number",
              hint: `円なら円単位。いまの値 ${money(detail.flatAmount, detail.currency)}` })}
          {detail.pricingModel === "revenue_rate" &&
            field("ratePct", "料率（%）", { type: "number", hint: `小数で入れる。いまの値 ${rate(detail.ratePpm)}` })}
          {detail.pricingModel === "unit_rate" &&
            field("unitAmount", "単価（最小通貨単位）", { type: "number",
              hint: `いまの値 ${money(detail.unitAmount, detail.currency)}` })}

          {detail.direction === "out" && (<>
            {field("mgAmount", "MG 最低保証", { type: "number",
              hint: "毎期独立の下限。消化しないので残高を持たない" })}
            {field("agAmount", "AG 前払保証", { type: "number",
              hint: detail.balance
                ? `消化済み ${money(detail.balance.agConsumed, detail.currency)}／残 ${money(detail.balance.agRemaining, detail.currency)}`
                : "累積で充当する。消化しきるまで実額が出ない" })}
          </>)}
          {detail.kind === "license" && (
            <label className="field">
              <span>独占性</span>
              <select value={v.exclusivity} onChange={(e) => set("exclusivity", e.target.value)}>
                <option value="">—</option>
                <option value="exclusive">独占</option>
                <option value="non_exclusive">非独占</option>
              </select>
            </label>
          )}
          <label className="field">
            <span>税区分</span>
            <select value={v.taxCategory} onChange={(e) => set("taxCategory", e.target.value)}>
              <option value="taxable">課税</option>
              <option value="reduced">軽減</option>
              <option value="exempt">非課税</option>
            </select>
          </label>
          {field("paymentTerms", "支払条件", { placeholder: "検収後30日 など" })}
          {field("spec", "仕様・成果物", { type: "textarea",
            placeholder: "カラーイラスト1点（表紙用）、A4 相当 など",
            hint: "発注書・検収書の明細の「仕様・成果物」にそのまま出る" })}
          {field("orderNo", "発注番号（外部）", {
            placeholder: "ARC-PO-2025-0123",
            hint: "V1・V2 や紙で出した発注書の番号。検収書の発注番号に出る。V3 で発注書を出したらそちらが優先される" })}
          <label className="field">
            <span>成果物の帰属先</span>
            <select value={v.deliverableOwnership} onChange={(e) => set("deliverableOwnership", e.target.value)}>
              <option value="">—</option>
              <option value="orderer">発注者（譲渡型）</option>
              <option value="contractor">受注者（利用許諾型）</option>
            </select>
            <small className="faint">発注書の明細に出る</small>
          </label>
          {detail.kind === "license" && (<>
            {field("regions", "地域（許諾範囲）", { placeholder: "日本, 台湾",
              hint: "カンマ区切り。空なら全世界として扱う。媒体・チャネルは下の「権利の範囲」で" })}
            {field("languages", "言語（許諾範囲）", { placeholder: "日本語, 繁体字" })}
          </>)}
          {field("notes", "備考", { type: "textarea", wide: true })}

          <label className="field wide">
            <span>この変更の適用開始日</span>
            <input type="date" value={effectiveFrom}
                   onChange={(e) => setEffectiveFrom(e.target.value)} />
            <small className="faint">
              契約変更で「2027-04-01 から料率が変わる」ときは、その日を入れます。
              契約期間そのものは動きません。空欄なら今日から効きます。
              {detail.effectiveFrom && `　いまの版は ${detail.effectiveFrom} から適用中`}
            </small>
          </label>
        </div>

        {error && <div className="alert">{error}</div>}

        <div className="row">
          <button className="btn primary" disabled={busy || !changedCount}
                  onClick={() => void save()}>
            {busy ? "保存中…" : later ? `${effectiveFrom} からの改訂を予約`
              : willRevise && Object.keys(patch).length ? "改訂して保存" : "保存する"}
          </button>
          <button className="btn" onClick={onCancel} disabled={busy}>やめる</button>
          {!changedCount && <span className="faint">変更された項目がありません</span>}
        </div>
      </div>
    </div>
  );
}
