import { useEffect, useState } from "react";
import type { ConditionSummary } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";

/**
 * 作品 › 刊行物（版元・ISBN・刊行日・本体価格。docs/work-editions.md）。
 *
 * 1 つの作品が版元を変えて何度も出るので、版元は作品ではなく刊行物に持つ。
 * 再許諾の刊行物は、版元との OUT 条件（作品 × 版元で 1 本）を根拠として指す。
 * 自社刊行・グループ会社（料率の取り決めが無い）は条件を持たない。
 */

type Relation = "own" | "group" | "sublicense" | "oem";
/** 出版は刊行物（版元・ISBN）、ボードゲームは製品（販売元・JAN）と呼ぶ。どちらか分からなければ両方の言い方。 */
export type EditionFamily = "publishing" | "game" | "neutral";
const WORDS: Record<EditionFamily, { thing: string; partner: string; code: string; date: string; price: string; own: string; codeHint: string }> = {
  publishing: { thing: "刊行物", partner: "版元", code: "ISBN", date: "刊行日", price: "本体価格", own: "自社刊行", codeHint: "9784047294646" },
  game: { thing: "製品", partner: "販売元", code: "JAN", date: "発売日", price: "希望小売価格", own: "自社製造・自社販売", codeHint: "4901234567894" },
  neutral: { thing: "刊行物・製品", partner: "版元・販売元", code: "ISBN／JAN", date: "刊行日・発売日", price: "本体価格", own: "自社", codeHint: "9784047294646" }
};
/** 作品の事業区分と、付いている作者の条件の利用形態から決める（純粋関数）。 */
export function editionFamilyOf(businessLine: string | null | undefined, usageTypes: Array<string | null>): EditionFamily {
  const line = String(businessLine ?? "");
  if (/ゲーム|game/i.test(line)) return "game";
  if (/出版|書籍|publish/i.test(line)) return "publishing";
  if (usageTypes.some((u) => String(u ?? "").startsWith("pub_"))) return "publishing";
  if (usageTypes.some((u) => u === "in_house" || u === "oem")) return "game";
  return "neutral";
}
interface Edition {
  id: number; workId: number; publisherPartyId: number | null; publisherName: string | null;
  relation: Relation; relationLabel: string; isbn: string | null; editionTitle: string | null;
  publishedOn: string | null; listPrice: number | null;
  outConditionId: number | null; outConditionNo: string | null; outRatePct: number | null;
  notes: string | null; warnings: string[];
}
const relationsFor = (f: EditionFamily): Array<{ value: Relation; label: string; hint: string }> => {
  const w = WORDS[f];
  return [
    { value: "sublicense", label: "再許諾", hint: `${w.partner}から当社に料率で入金がある。${w.partner}との再許諾の条件（OUT）を選ぶ` },
    ...(f === "publishing" ? [] : [{ value: "oem" as const, label: "他社販売（OEM）", hint: `当社が作って${w.partner}が売る。${w.partner}との OEM の条件（OUT）を選ぶ` }]),
    { value: "group", label: "グループ会社（料率なし）", hint: `料率の取り決めが無い。${w.partner}を記録するだけ` },
    { value: "own", label: w.own, hint: `当社が出す。${w.partner}は空でよい` }
  ];
};
const OUT_USAGE: Partial<Record<Relation, string>> = { sublicense: "sublicense", oem: "oem" };
interface Draft { publisherPartyId: string; publisherName: string | null; relation: Relation; isbn: string; publishedOn: string;
                  listPrice: string; outConditionId: string; editionTitle: string; notes: string }
const EMPTY: Draft = { publisherPartyId: "", publisherName: null, relation: "sublicense", isbn: "", publishedOn: "",
                       listPrice: "", outConditionId: "", editionTitle: "", notes: "" };

export function WorkEditions({ workId, editable, conditions, onOpenCondition, family = "neutral" }: {
  workId: number; editable: boolean; conditions: ConditionSummary[]; onOpenCondition?: (id: number) => void; family?: EditionFamily;
}) {
  const w = WORDS[family];
  const RELATIONS = relationsFor(family);
  const relLabel = (e: Edition) => e.relation === "own" ? w.own : RELATIONS.find((r) => r.value === e.relation)?.label ?? e.relationLabel;
  const [data, setData] = useState<{ available: boolean; editions: Edition[] } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => api.get<{ available: boolean; editions: Edition[] }>(`/works/${workId}/editions`)
    .then(setData).catch((e: ApiError) => setError(e.message));
  useEffect(() => { setDraft(null); setEditingId(null); setError(null); void reload(); }, [workId]);

  // 相手との条件（OUT）の候補：この作品の生きた許諾（OUT）で、関係の利用形態が合い、選んだ相手が相手先のもの。
  const outs = conditions.filter((c) => c.direction === "out" && c.status !== "void"
    && (!draft || (c as { usageType?: string | null }).usageType === OUT_USAGE[draft.relation])
    && (!draft?.publisherPartyId || String(c.counterparty?.id ?? "") === draft.publisherPartyId));

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    const body = {
      publisherPartyId: draft.publisherPartyId ? Number(draft.publisherPartyId) : null, relation: draft.relation,
      isbn: draft.isbn.trim() || null, publishedOn: draft.publishedOn || null,
      listPrice: draft.listPrice.trim() ? Number(draft.listPrice.replace(/[,，円]/g, "")) : null,
      outConditionId: OUT_USAGE[draft.relation] && draft.outConditionId ? Number(draft.outConditionId) : null,
      editionTitle: draft.editionTitle.trim() || null, notes: draft.notes.trim() || null
    };
    try {
      if (editingId) await api.put(`/work-editions/${editingId}`, body);
      else await api.post(`/works/${workId}/editions`, body);
      setDraft(null); setEditingId(null); await reload();
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  async function remove(e: Edition) {
    if (!window.confirm(`${w.thing} ${e.isbn ?? e.editionTitle ?? `#${e.id}`} を外します。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try { await api.del(`/work-editions/${e.id}`); await reload(); }
    catch (x) { setError((x as ApiError).message); } finally { setBusy(false); }
  }
  const edit = (e: Edition) => {
    setEditingId(e.id);
    setDraft({ publisherPartyId: e.publisherPartyId ? String(e.publisherPartyId) : "", publisherName: e.publisherName,
               relation: e.relation, isbn: e.isbn ?? "", publishedOn: e.publishedOn ?? "",
               listPrice: e.listPrice === null ? "" : String(e.listPrice), outConditionId: e.outConditionId ? String(e.outConditionId) : "",
               editionTitle: e.editionTitle ?? "", notes: e.notes ?? "" });
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{w.thing}（{w.partner}・{w.code}）</h2>
        <span className="faint">{w.partner}を変えて出し直したら 1 つずつ足す。再許諾・他社販売は{w.partner}との条件（作品 × {w.partner}で 1 本）を指す。版が増えても条件は増えない</span>
        {editable && data?.available && !draft && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => { setEditingId(null); setDraft({ ...EMPTY }); }}>{w.thing}を足す</button>
        )}
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        {error && <div className="alert">{error}</div>}
        {data && !data.available && <span className="faint">{w.thing}の台帳がまだありません（infra/v3/193 を当てると使えます）</span>}
        {data?.available && (data.editions.length ? (
          <div className="tablewrap"><table>
            <thead><tr><th>{w.partner}</th><th>関係</th><th>{w.code}</th><th>{w.date}</th><th className="num">{w.price}</th><th>{w.partner}との条件</th><th /></tr></thead>
            <tbody>{data.editions.map((e) => (
              <tr key={e.id}>
                <td>{e.publisherName ?? "当社"}{e.editionTitle && <div className="faint">{e.editionTitle}</div>}</td>
                <td>{relLabel(e)}</td>
                <td className="code">{e.isbn ?? <span className="tag warn">なし</span>}</td>
                <td>{e.publishedOn ?? "—"}</td>
                <td className="num">{e.listPrice === null ? "—" : `¥${e.listPrice.toLocaleString()}`}</td>
                <td>
                  {e.outConditionId
                    ? <button className="linky code" onClick={() => onOpenCondition?.(e.outConditionId!)}>{e.outConditionNo ?? `#${e.outConditionId}`}</button>
                    : OUT_USAGE[e.relation] ? <span className="tag warn">なし</span> : <span className="faint">持たない</span>}
                  {e.outRatePct !== null && <span className="faint"> {e.outRatePct}%</span>}
                  {e.warnings.map((w) => <div key={w} className="faint" style={{ color: "var(--warn, #a15c00)" }}>{w}</div>)}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {editable && <>
                    <button className="linky" disabled={busy} onClick={() => edit(e)}>直す</button>
                    <button className="linky" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void remove(e)}>外す</button>
                  </>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <span className="faint">まだありません。一括登録（出版作品・ゲーム作品）の{w.partner}・{w.code} の列からも入ります</span>)}

        {draft && (
          <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--line, #ddd)", paddingTop: 8 }}>
            <div role="radiogroup" aria-label={`${w.partner}との関係`} className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              {RELATIONS.map((r) => (
                <label key={r.value} title={r.hint}>
                  <input type="radio" name="edition-relation" checked={draft.relation === r.value}
                         onChange={() => set({ relation: r.value, outConditionId: r.value === "sublicense" ? draft.outConditionId : "" })} /> {r.label}
                </label>
              ))}
            </div>
            <span className="faint">{RELATIONS.find((r) => r.value === draft.relation)?.hint}</span>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <label>{w.partner}{draft.relation === "own" ? "（空なら当社）" : ""}
                <SearchSelect value={draft.publisherPartyId} valueLabel={draft.publisherName} search={searchParties}
                              placeholder="取引先を探す" emptyLabel={draft.relation === "own" ? "当社" : undefined}
                              onChange={(v, o) => set({ publisherPartyId: v, publisherName: o?.label ?? null, outConditionId: "" })} />
              </label>
              <label>{w.code}<input value={draft.isbn} placeholder={w.codeHint} onChange={(e) => set({ isbn: e.target.value })} /></label>
              <label>{w.date}<input type="date" value={draft.publishedOn} onChange={(e) => set({ publishedOn: e.target.value })} /></label>
              <label>{w.price}（円）<input value={draft.listPrice} inputMode="numeric" style={{ width: 110 }} onChange={(e) => set({ listPrice: e.target.value })} /></label>
            </div>
            {OUT_USAGE[draft.relation] && (
              <label>{w.partner}との条件（OUT）
                <select value={draft.outConditionId} onChange={(e) => set({ outConditionId: e.target.value })}>
                  <option value="">（後で付ける）</option>
                  {outs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.conditionNo ?? `#${c.id}`} {c.counterparty?.name ?? ""}{c.ratePpm !== null ? ` ${c.ratePpm / 10000}%` : ""}
                    </option>
                  ))}
                </select>
                {!outs.length && <span className="faint"> この作品に{draft.publisherName ? ` ${draft.publisherName} との` : ""}{draft.relation === "oem" ? "他社販売（OEM）" : "再許諾"}の条件（OUT）がありません。条件明細で作れます{draft.relation === "sublicense" ? `（一括登録の「${family === "game" ? "販売元料率" : "版元料率"}」でも作れます）` : ""}</span>}
              </label>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <label>版の名前（任意）<input value={draft.editionTitle} placeholder={family === "game" ? "新版・拡張・海外版 など" : "新装版・文庫版 など"} onChange={(e) => set({ editionTitle: e.target.value })} /></label>
              <label>備考<input value={draft.notes} style={{ width: 320 }} onChange={(e) => set({ notes: e.target.value })} /></label>
            </div>
            <div className="row">
              <button className="btn btn-sm primary" disabled={busy} onClick={() => void save()}>{editingId ? "直す" : "足す"}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => { setDraft(null); setEditingId(null); }}>やめる</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
