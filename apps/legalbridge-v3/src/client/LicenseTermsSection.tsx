import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api.js";
import { RightsScopePicker } from "./RightsScopePicker.js";
import { CONDITION_USAGE_TYPES } from "../server/core/condition-usage.js";
import { firstEditionBasisText, inLieuSpecialTerms } from "../server/conditions/royalty-in-lieu.js";
import { firstEditionOf, inLieuCheck, licensePeriodMissing, newRate, type Exclusivity, type InLieuRate, type LicenseDeliverable, type LicenseDraft }
  from "../server/conditions/license-draft.js";

export { firstEditionOf, inLieuCheck, licensePayload, licensePeriodMissing, newLicenseDraft, newRate }
  from "../server/conditions/license-draft.js";
export type { Exclusivity, InLieuRate, LicenseDeliverable, LicenseDraft, LicMode } from "../server/conditions/license-draft.js";

/**
 * 受注者帰属の成果物の利用許諾の欄（A-120）。
 *
 * 『業務委託（発注）』のフォームの「権利の扱い」と、条件の登録（1 本）で帰属先を受注者にしたときに
 * 開く欄は同じもの。以前は 1 本の登録から『業務委託（発注）』へ切り替えさせていて、入口が二つあり、
 * 切り替えると画面ががらりと変わって迷った。欄はここに 1 つだけ置き、両方の画面がこれを使う。
 *
 * 値は LicenseDraft にまとめて親が持つ（登録のときに親が送る）。対象の委託料の行（deliverables）は
 * 親から受け取る：仮計算額との突き合わせ・60 日の確かめ・特約の文に使う。
 */

export interface LicenseAgreementOption { id: number; agreementNo: string | null; title: string }

const num = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const int = (v: string) => { const n = Number(v); return Number.isFinite(n) && n ? n : undefined; };
const yen = (n: number) => n.toLocaleString("ja-JP");

/** 併せて作る条件書の下書き（A-080）。利用許諾条件ができていれば起こす。 */
export async function createCompanionDocument(
  d: LicenseDraft, licenseConditionIds: number[], opts: { matterId?: string; agreementId: string }
): Promise<{ id: number; templateKey: string } | null> {
  if (!d.companion || !licenseConditionIds.length) return null;
  const licAgreement = d.agreementId === "" ? int(opts.agreementId) : d.agreementId === "none" ? undefined : int(d.agreementId);
  const doc = await api.post<{ id: number }>("/documents", {
    templateKey: d.companion, conditionIds: licenseConditionIds,
    matterId: int(opts.matterId ?? "") ?? null, agreementId: licAgreement ?? null
  }).catch(() => null);
  return doc ? { id: doc.id, templateKey: d.companion } : null;
}

export function LicenseTermsSection(
  { draft, onChange, deliverables, workId, agreements, baseAgreementId, servicePeriod, title, onFillProvisional, workNote, periodicChosen }: {
    draft: LicenseDraft;
    onChange: (patch: Partial<LicenseDraft>) => void;
    /** 受注者帰属の委託料の行。 */
    deliverables: LicenseDeliverable[];
    /** クレジット表記を引用する作品。 */
    workId: string;
    /** 載せる契約の候補（相手先の契約）。 */
    agreements: LicenseAgreementOption[];
    /** 業務委託の基本契約（"" なら無し）。 */
    baseAgreementId: string;
    /** 業務期間（特約の文に出る）。 */
    servicePeriod: { start: string; end: string };
    /** 件名（行の品目名が空のときの名前）。 */
    title: string;
    /** 行が複数のとき、仮計算額を先頭の行に入れるボタン。 */
    onFillProvisional?: () => void;
    /** 作品が無い行の注意など、欄の下に出す親の文。 */
    workNote?: ReactNode;
    /** 支払方法が定期払い（初版利用許諾料は定期払いにできない）。 */
    periodicChosen?: boolean;
  }
) {
  const d = draft;
  const [showTermsPreview, setShowTermsPreview] = useState(false);
  /** 引用する作品の今のクレジット表記（著作権表示／第三者権利）。作品が無い・未登録なら null。 */
  const [workCredit, setWorkCredit] = useState<string | null>(null);
  useEffect(() => {
    if (!workId) { setWorkCredit(null); return; }
    let alive = true;
    api.get<{ current: { copyrightNotice: string; thirdPartyRights: string | null } | null }>(`/works/${workId}/credits`)
      .then((r) => { if (alive) setWorkCredit(r.current ? [r.current.copyrightNotice, r.current.thirdPartyRights].filter(Boolean).join("／") : null); })
      .catch(() => { if (alive) setWorkCredit(null); });
    return () => { alive = false; };
  }, [workId]);
  const creditText = d.creditFromWork ? (workCredit ?? d.creditNotice.trim()) : d.creditNotice.trim();

  const check = inLieuCheck(d, deliverables);
  const { firstEdition, provisional, rowsTotal, feOk } = check;
  const setRate = (key: number, patch: Partial<InLieuRate>) =>
    onChange({ rates: d.rates.map((x) => (x.key === key ? { ...x, ...patch } : x)) });
  const termsPreview = d.mode === "in_lieu" ? inLieuSpecialTerms({
    servicePeriod: { start: servicePeriod.start || null, end: servicePeriod.end || deliverables.map((l) => l.deliveryDue).filter(Boolean).sort().at(-1) || null },
    licensePeriod: { start: d.termStart || servicePeriod.start || null, end: d.termEnd || null },
    deliverables: deliverables.map((l) => ({ name: l.name || title, amount: l.amount })),
    firstEdition, provisionalAmount: rowsTotal || provisional,
    confirmWithinDays: check.confirmOk ? num(d.confirmDays) : null,
    payOn: d.payOn || null,
    laterRates: d.rates.filter((r) => num(r.ratePct) > 0).map((r) => ({ usageType: r.usageType, ratePct: num(r.ratePct) })),
    laterExemptPct: d.exemptLater.trim() === "" ? null : num(d.exemptLater),
    masterAgreement: (() => {
      const id = d.agreementId === "" ? baseAgreementId : d.agreementId === "none" ? "" : d.agreementId;
      const a = agreements.find((x) => String(x.id) === id);
      return a ? { no: a.agreementNo, title: a.title } : null;
    })(),
    creditNotice: creditText || null,
    sublicense: d.sublicense
  }) : "";

  return (
    <div className="note stack" style={{ gap: 8 }}>
      <b>利用許諾の条件（成果物の権利は受注者に残る）</b>
      <span className="faint">受注者に権利が残る成果物は、当社は許諾を受けて使います。許諾の条件を作品 × 受託者の利用許諾条件（IN）として立て、発注書の「■ 利用許諾条件」に差し込みます。</span>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {([["separate", "別途（許諾料を払う）"], ["included", "委託報酬に含む（推奨）"], ["free", "無償"],
           ["in_lieu", "初版の利用許諾料を報酬として払う（仮計算 → 納品後に確定）"], ["none", "条件を立てない（例外）"]] as const).map(([v, label]) => (
          <button key={v} type="button" className="chip" aria-pressed={d.mode === v} onClick={() => onChange({ mode: v })}>{label}</button>
        ))}
      </div>
      {/* 許諾期間（A-121）。納期（いつ納めるか）・役務提供期間（いつ働くか）とは別の、当社が成果物を使える期間。 */}
      {d.mode !== "none" && (
        <div className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
            <b>許諾期間</b>
            <span className="faint">当社がこの成果物を使える期間。上の「納期」「役務提供期間」とは別です</span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="chip" aria-pressed={d.termKind === "perpetual"} onClick={() => onChange({ termKind: "perpetual", termEnd: "" })}>
              無期限（期間の定めなし）
            </button>
            <button type="button" className="chip" aria-pressed={d.termKind === "fixed"} onClick={() => onChange({ termKind: "fixed" })}>
              有期（終了日まで）
            </button>
          </div>
          <div className="form-grid">
            <label className="field"><span>許諾開始</span>
              <input type="date" value={d.termStart} onChange={(e) => onChange({ termStart: e.target.value })} />
              <small className="faint">空なら業務（役務提供）の開始日から{servicePeriod.start ? `（${servicePeriod.start}）` : ""}</small></label>
            {d.termKind === "fixed" && (
              <label className="field"><span>許諾終了 <em className="req">必須</em></span>
                <input type="date" value={d.termEnd} onChange={(e) => onChange({ termEnd: e.target.value })} />
                {licensePeriodMissing(d) && <small className="bad">{licensePeriodMissing(d)}</small>}</label>
            )}
          </div>
        </div>
      )}
      {d.mode === "in_lieu" && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="faint">
            別途の制作報酬は払わず、<b>初版の出版に係る利用許諾料</b>を対価にします。発注時は見込みの本体価格・初版部数・料率で<b>仮計算</b>した額を
            制作報酬（{deliverables.map((l) => l.label).join("・") || "受注者帰属の行"}）の確定額にし、納品後 60 日以内に本体価格・部数を確定して検収書で払います
            （確定額が仮計算額を下回っても仮計算額＝減額にしない）。2 版目以降・電子は出版基本契約の個別契約による印税で、初版は計算書の対象外です。
            発注書には特約（下の文）が既定で入ります（文書の欄で直せます）。
          </span>
          <div className="form-grid">
            <label className="field"><span>価格の基準</span>
              <select value={d.fePriceBasis} onChange={(e) => onChange({ fePriceBasis: e.target.value as LicenseDraft["fePriceBasis"] })}>
                <option value="">定価（本体価格）× 部数 × 料率</option>
                {d.fePriceBasis === "supply" && <option value="supply">卸価格（再許諾先への供給価格）※ 使わない</option>}
                <option value="receipts">受領した再許諾料 × 料率（部数は使わない）</option>
              </select>
              <small className="faint">自社出版（アークライト名・新紀元社名）も他社出版（KADOKAWA 等）も定価が基準。受領した再許諾料から分配するときだけ受領額。2 版目以降の式にも使う（A-101）</small></label>
            <label className="field"><span>{d.fePriceBasis === "supply" ? "見込み卸価格（税抜・円）" : d.fePriceBasis === "receipts" ? "見込みの再許諾料の受領額（税抜・円）" : "見込み本体価格（税抜・円）"}</span>
              <input inputMode="numeric" value={d.fePrice} placeholder={d.fePriceBasis === "receipts" ? "10000000" : "1000"} onChange={(e) => onChange({ fePrice: e.target.value })} /></label>
            {d.fePriceBasis !== "receipts" && <label className="field"><span>見込み初版部数</span>
              <input inputMode="numeric" value={d.feCopies} placeholder="3000" onChange={(e) => onChange({ feCopies: e.target.value })} /></label>}
            <label className="field"><span>初版の料率（%）</span>
              <input inputMode="decimal" value={d.feRate} placeholder="10" onChange={(e) => onChange({ feRate: e.target.value })} /></label>
            {d.fePriceBasis !== "receipts" && <label className="field"><span>初版の非加算部数（献本・見本等）</span>
              <input inputMode="numeric" value={d.feExempt} placeholder="0" onChange={(e) => onChange({ feExempt: e.target.value })} />
              <small className="faint">既定 0（全部数）。入れると算定方法に「− ○部」が明記される（利用許諾料の算定方法の一部。製造委託の製造代金とは別の整理）</small></label>}
          </div>
          <div className="row" style={{ gap: 18, flexWrap: "wrap", alignItems: "center" }}>
            <span>仮計算額 <b>¥{yen(provisional)}</b>{feOk && <span className="faint">　{firstEditionBasisText(firstEdition).replace("算定の基礎（見込み）：", "＝ ")}</span>}</span>
            <span className={rowsTotal === provisional ? "faint" : "tag warn"}>制作報酬の合計 ¥{yen(rowsTotal)}{rowsTotal !== provisional && feOk ? "（仮計算額と合っていません）" : ""}</span>
            {feOk && rowsTotal !== provisional && deliverables.length > 1 && onFillProvisional && (
              <button type="button" className="btn btn-sm" onClick={onFillProvisional}>仮計算額を先頭の受注者帰属の行に入れる</button>
            )}
            {feOk && deliverables.length === 1 && (
              <span className="faint">制作報酬が 1 本なので、仮計算額がそのまま金額に入ります（¥{yen(provisional)}）</span>
            )}
            {deliverables.length > 1 && (
              <span className="faint">内訳：{deliverables.map((l) => `${l.name || title} ¥${yen(l.amount)}`).join("、")}</span>
            )}
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <b style={{ fontSize: "0.9em" }}>2 版目以降・電子の料率（利用形態ごとに利用許諾条件が 1 本立ちます）</b>
            {d.rates.map((r, i) => (
              <div key={r.key} className="row" style={{ gap: 6, alignItems: "center" }}>
                <select value={r.usageType} aria-label={`${i + 1} 番目の利用形態`} onChange={(e) => setRate(r.key, { usageType: e.target.value })}>
                  {CONDITION_USAGE_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
                <input style={{ width: 80, textAlign: "right" }} inputMode="decimal" value={r.ratePct} aria-label={`${i + 1} 番目の料率`}
                       onChange={(e) => setRate(r.key, { ratePct: e.target.value })} />
                <span>%</span>
                <select value={r.exclusivity} aria-label={`${i + 1} 番目の独占性`}
                        onChange={(e) => setRate(r.key, { exclusivity: e.target.value as Exclusivity })}>
                  <option value="">独占性：共通の設定</option>
                  <option value="exclusive">独占</option>
                  <option value="non_exclusive">非独占</option>
                </select>
                <span className="faint">{r.usageType === "pub_print" ? "本体価格 × 発行部数 × 料率" : "当社の受領額 × 料率"}</span>
                {d.rates.length > 1 && <button type="button" className="linky" onClick={() => onChange({ rates: d.rates.filter((x) => x.key !== r.key) })} aria-label="料率の行を外す">✕</button>}
              </div>
            ))}
            <div><button type="button" className="btn btn-sm" onClick={() => onChange({ rates: [...d.rates, newRate("in_house", "")] })}>利用形態を足す</button></div>
            <small className="faint">紙と電子の両方を出すなら両方の行を残す（利用形態ごとに利用許諾条件が 1 本立ち、発注書の表に 1 行ずつ出る）。電子を出さないなら電子の行を ✕ で外す</small>
          </div>
          <div className="form-grid">
            <label className="field"><span>確定の期限（受領後 ○ 日）</span>
              <input inputMode="numeric" value={d.confirmDays} placeholder="45" onChange={(e) => onChange({ confirmDays: e.target.value })} />
              <small className="faint">本体価格・初版部数を書面で通知し受注者の確認を得る期限。60 日以内</small></label>
            <label className="field"><span>支払期日</span>
              <input type="date" value={d.payOn} onChange={(e) => onChange({ payOn: e.target.value })} />
              <small className="faint">成果物の受領（納期）から 60 日以内。予定明細の支払日になり、発注書の支払期日に出る。期限までに確定しなければ仮計算額を払い、差額は確定後 30 日以内</small></label>
            <label className="field"><span>非加算：2 版目以降（発行部数の %）</span>
              <input inputMode="decimal" value={d.exemptLater} placeholder="1" onChange={(e) => onChange({ exemptLater: e.target.value })} />
              <small className="faint">献本等。空なら非加算なし。初版の非加算とは別の欄</small></label>
            <div className="field wide">
              <span>利用許諾料の支払</span>
              <div className="stack" style={{ gap: 4 }}>
                <div><b>初回（初版）</b>：発注書の制作報酬に含む（検収書で支払。計算書の対象外）</div>
                <label className="row" style={{ gap: 8, alignItems: "center" }}>
                  <b>2 版目以降・電子</b>
                  <input style={{ flex: 1 }} value={d.paymentTerms} placeholder="刊行日を含む月の翌月末日 など"
                         onChange={(e) => onChange({ paymentTerms: e.target.value })} />
                </label>
              </div>
              <small className="faint">2 版目以降の文は利用許諾条件の支払条件に入り、出版等利用許諾条件書の支払時期と計算書の回に連動する。空なら条件書の既定（翌月末日）</small>
            </div>
            <label className="field"><span>独占／非独占（利用許諾条件の既定）</span>
              <select value={d.exclusivity} onChange={(e) => onChange({ exclusivity: e.target.value as Exclusivity })}>
                <option value="">未設定（発注書の表に「独占性 未設定」と出る）</option>
                <option value="exclusive">独占</option>
                <option value="non_exclusive">非独占</option>
              </select>
              <small className="faint">発注書の利用許諾条件の表と条件書の独占区分に出る。紙と電子で違うなら上の料率の行で上書き</small></label>
            <label className="field"><span>再許諾（第三者への翻訳出版等）</span>
              <select value={d.sublicense} onChange={(e) => onChange({ sublicense: e.target.value as LicenseDraft["sublicense"] })}>
                <option value="consent">可（都度合意）：受注者の事前の書面同意を得て行う（既定）</option>
                <option value="covered">可（包括同意）：本特約で同意済み。翻訳出版が前提の案件だけ</option>
                <option value="no">不可：自社出版のみ</option>
              </select>
              <small className="faint">可否と同意の要否はここで決め、再許諾先・料率・範囲は個別出版条件書で。再許諾の料率を先に決めるなら上の料率に「翻訳版再許諾」を足す</small></label>
          </div>
          {check.sixtyDayOver.length > 0 && (
            <div className="alert">支払期日 {d.payOn} が納期から 60 日を超えています（{check.sixtyDayOver.map((l) => `${l.label} ${l.deliveryDue}`).join("・")}）。取適法・フリーランス法の支払期日に合わせてください</div>
          )}
          {periodicChosen && <div className="alert">初版の利用許諾料は受領後に 1 回で払うので、支払方法を定期払いにはできません</div>}
          <div className="stack" style={{ gap: 4 }}>
            <button className="linky" type="button" onClick={() => setShowTermsPreview((v) => !v)}>
              {showTermsPreview ? "特約の文を閉じる" : "発注書に入る特約の文を見る"}
            </button>
            {showTermsPreview && <textarea rows={14} readOnly value={termsPreview} aria-label="発注書に入る特約の文" />}
          </div>
        </div>
      )}
      {d.mode !== "none" && (
        <div className="form-grid">
          <label className="field"><span>利用許諾条件を載せる契約（出版基本契約）</span>
            <select value={d.agreementId} onChange={(e) => onChange({ agreementId: e.target.value })}>
              <option value="">{baseAgreementId ? "業務委託の基本契約と同じ" : "（業務委託と同じ：契約に載せない）"}</option>
              {agreements.filter((a) => String(a.id) !== baseAgreementId).map((a) =>
                <option key={a.id} value={a.id}>{[a.agreementNo, a.title].filter(Boolean).join(" ")}</option>)}
              {baseAgreementId && <option value="none">契約に載せない（個別出版条件書のみ）</option>}
            </select>
            <small className="faint">成果物を出版・再許諾するときの利用許諾は、業務委託の基本契約とは別に、出版基本契約の個別契約として扱えます。発注書の利用許諾条件の表と特約に「その個別契約」と出ます</small></label>
          <label className="field"><span>条件書も併せて作る（任意）</span>
            <select value={d.companion} onChange={(e) => onChange({ companion: e.target.value as LicenseDraft["companion"] })}>
              <option value="">作らない（発注書だけ）</option>
              <option value="pub_license_terms_v3">出版等利用許諾条件書（作品追加の合意）{d.rates.some((r) => r.usageType.startsWith("pub_")) ? "（おすすめ）" : ""}</option>
              <option value="individual_license_terms_v4">個別利用許諾条件書（ゲーム）{d.mode !== "in_lieu" || d.rates.every((r) => !r.usageType.startsWith("pub_")) ? "（おすすめ）" : ""}</option>
            </select>
            <small className="faint">利用許諾条件を載せた条件書の下書きを発注書とは別に起こします（既存のひな形）。発注書の特約に「本発注書の利用許諾の条件はこの条件書に当たる」と入ります</small></label>
          <div className="field wide stack" style={{ gap: 4 }}>
            <span>クレジット表記（成果物を利用するときの表示）</span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button type="button" className="chip" aria-pressed={d.creditFromWork} onClick={() => onChange({ creditFromWork: true })}>作品のクレジット表記を引用</button>
              <button type="button" className="chip" aria-pressed={!d.creditFromWork} onClick={() => onChange({ creditFromWork: false })}>この条件で文言を定める</button>
            </div>
            {d.creditFromWork ? (
              <small className="faint">
                {workId
                  ? (workCredit
                    ? <>作品の今の表記：<b>{workCredit}</b>（文書を作る日時点の表記を差します。重版で変われば作品側で履歴を足してください）</>
                    : <>作品にクレジット表記が登録されていません。作品の画面で登録するか、下に文言を入れると控えとして使います。</>)
                  : "作品を選ぶと、その作品のクレジット表記を引用できます"}
              </small>
            ) : null}
            <textarea rows={2} value={d.creditNotice} aria-label="クレジット表記の文言"
                      placeholder={d.creditFromWork ? "（作品に表記が無いときの控え）© 2026 山田太郎／イラスト：山田太郎" : "© 2026 山田太郎／イラスト：山田太郎"}
                      onChange={(e) => onChange({ creditNotice: e.target.value })} />
            <small className="faint">発注書の利用許諾条件の下と特約に出ます。</small>
          </div>
          {/* 許諾の中身。報酬に含む・無償なら範囲だけ、別途なら料金（料率・定額）も。 */}
          {d.mode !== "in_lieu" && (
            <div className="form-section field wide">
              <b>{d.mode === "separate" ? "許諾条件（許諾料と範囲）" : "許諾の範囲"}</b>
              <small>{d.mode === "separate"
                ? "委託報酬とは別に払う許諾料（料率か定額）と、利用形態・独占性・地域・言語"
                : "許諾料は委託報酬に含む（または無償）。どう使えるか（利用形態・独占性・地域・言語）だけ決めます"}</small>
            </div>)}
          {d.mode !== "in_lieu" && (
            <label className="field"><span>利用形態</span>
              <select value={d.usage} onChange={(e) => onChange({ usage: e.target.value })}>
                {CONDITION_USAGE_TYPES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select></label>)}
          {d.mode === "separate" && (<>
            <label className="field"><span>料率（%）</span><input value={d.rate} placeholder="8" onChange={(e) => onChange({ rate: e.target.value })} /></label>
            <label className="field"><span>または 定額（税抜）</span><input value={d.flat} placeholder="料率が空のとき" onChange={(e) => onChange({ flat: e.target.value })} /></label>
          </>)}
          {d.mode !== "in_lieu" && (
            <label className="field"><span>独占／非独占</span>
              <select value={d.exclusivity} onChange={(e) => onChange({ exclusivity: e.target.value as Exclusivity })}>
                <option value="">未設定（発注書の表に「独占性 未設定」と出る）</option>
                <option value="exclusive">独占</option>
                <option value="non_exclusive">非独占</option>
              </select></label>)}
          <div className="field"><span>地域（許諾範囲）</span><RightsScopePicker kind="region" value={d.regions} onChange={(v) => onChange({ regions: v })} /></div>
          <div className="field"><span>言語（許諾範囲）</span><RightsScopePicker kind="language" value={d.languages} onChange={(v) => onChange({ languages: v })} /></div>
          {workNote}
        </div>
      )}
      {d.mode === "none" && <span className="faint">発注書に許諾条項が出ず、台帳からも権利が見えません。</span>}
    </div>
  );
}
