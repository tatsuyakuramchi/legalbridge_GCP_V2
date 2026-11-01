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

type Relation = "own" | "group" | "sublicense";
interface Edition {
  id: number; workId: number; publisherPartyId: number | null; publisherName: string | null;
  relation: Relation; relationLabel: string; isbn: string | null; editionTitle: string | null;
  publishedOn: string | null; listPrice: number | null;
  outConditionId: number | null; outConditionNo: string | null; outRatePct: number | null;
  notes: string | null; warnings: string[];
}
const RELATIONS: Array<{ value: Relation; label: string; hint: string }> = [
  { value: "sublicense", label: "再許諾", hint: "版元から当社に料率で入金がある。版元との条件（OUT）を選ぶ" },
  { value: "group", label: "グループ会社（料率なし）", hint: "料率の取り決めが無い。版元を記録するだけ" },
  { value: "own", label: "自社刊行", hint: "当社が出す。版元は空でよい" }
];
interface Draft { publisherPartyId: string; publisherName: string | null; relation: Relation; isbn: string; publishedOn: string;
                  listPrice: string; outConditionId: string; editionTitle: string; notes: string }
const EMPTY: Draft = { publisherPartyId: "", publisherName: null, relation: "sublicense", isbn: "", publishedOn: "",
                       listPrice: "", outConditionId: "", editionTitle: "", notes: "" };

export function WorkEditions({ workId, editable, conditions, onOpenCondition }: {
  workId: number; editable: boolean; conditions: ConditionSummary[]; onOpenCondition?: (id: number) => void;
}) {
  const [data, setData] = useState<{ available: boolean; editions: Edition[] } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => api.get<{ available: boolean; editions: Edition[] }>(`/works/${workId}/editions`)
    .then(setData).catch((e: ApiError) => setError(e.message));
  useEffect(() => { setDraft(null); setEditingId(null); setError(null); void reload(); }, [workId]);

  // 版元との条件（OUT）の候補：この作品の生きた許諾（OUT）で、選んだ版元が相手先のもの。
  const outs = conditions.filter((c) => c.direction === "out" && c.status !== "void"
    && (!draft?.publisherPartyId || String(c.counterparty?.id ?? "") === draft.publisherPartyId));

  async function save() {
    if (!draft) return;
    setBusy(true); setError(null);
    const body = {
      publisherPartyId: draft.publisherPartyId ? Number(draft.publisherPartyId) : null, relation: draft.relation,
      isbn: draft.isbn.trim() || null, publishedOn: draft.publishedOn || null,
      listPrice: draft.listPrice.trim() ? Number(draft.listPrice.replace(/[,，円]/g, "")) : null,
      outConditionId: draft.relation === "sublicense" && draft.outConditionId ? Number(draft.outConditionId) : null,
      editionTitle: draft.editionTitle.trim() || null, notes: draft.notes.trim() || null
    };
    try {
      if (editingId) await api.put(`/work-editions/${editingId}`, body);
      else await api.post(`/works/${workId}/editions`, body);
      setDraft(null); setEditingId(null); await reload();
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  async function remove(e: Edition) {
    if (!window.confirm(`刊行物 ${e.isbn ?? e.editionTitle ?? `#${e.id}`} を外します。よろしいですか？`)) return;
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
        <h2>刊行物（版元・ISBN）</h2>
        <span className="faint">版元を変えて出し直したら 1 冊ずつ足す。再許諾は版元との条件（作品 × 版元で 1 本）を指す。重版で ISBN が増えても条件は増えない</span>
        {editable && data?.available && !draft && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => { setEditingId(null); setDraft({ ...EMPTY }); }}>刊行物を足す</button>
        )}
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        {error && <div className="alert">{error}</div>}
        {data && !data.available && <span className="faint">刊行物の台帳がまだありません（infra/v3/193 を当てると使えます）</span>}
        {data?.available && (data.editions.length ? (
          <div className="tablewrap"><table>
            <thead><tr><th>版元</th><th>関係</th><th>ISBN</th><th>刊行日</th><th className="num">本体価格</th><th>版元との条件</th><th /></tr></thead>
            <tbody>{data.editions.map((e) => (
              <tr key={e.id}>
                <td>{e.publisherName ?? "当社"}{e.editionTitle && <div className="faint">{e.editionTitle}</div>}</td>
                <td>{e.relationLabel}</td>
                <td className="code">{e.isbn ?? <span className="tag warn">なし</span>}</td>
                <td>{e.publishedOn ?? "—"}</td>
                <td className="num">{e.listPrice === null ? "—" : `¥${e.listPrice.toLocaleString()}`}</td>
                <td>
                  {e.outConditionId
                    ? <button className="linky code" onClick={() => onOpenCondition?.(e.outConditionId!)}>{e.outConditionNo ?? `#${e.outConditionId}`}</button>
                    : e.relation === "sublicense" ? <span className="tag warn">なし</span> : <span className="faint">持たない</span>}
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
        ) : <span className="faint">まだありません。出版作品の一括登録（版元・ISBN の列）からも入ります</span>)}

        {draft && (
          <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--line, #ddd)", paddingTop: 8 }}>
            <div role="radiogroup" aria-label="版元との関係" className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              {RELATIONS.map((r) => (
                <label key={r.value} title={r.hint}>
                  <input type="radio" name="edition-relation" checked={draft.relation === r.value}
                         onChange={() => set({ relation: r.value, outConditionId: r.value === "sublicense" ? draft.outConditionId : "" })} /> {r.label}
                </label>
              ))}
            </div>
            <span className="faint">{RELATIONS.find((r) => r.value === draft.relation)?.hint}</span>
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <label>版元{draft.relation === "own" ? "（空なら当社）" : ""}
                <SearchSelect value={draft.publisherPartyId} valueLabel={draft.publisherName} search={searchParties}
                              placeholder="取引先を探す" emptyLabel={draft.relation === "own" ? "当社" : undefined}
                              onChange={(v, o) => set({ publisherPartyId: v, publisherName: o?.label ?? null, outConditionId: "" })} />
              </label>
              <label>ISBN<input value={draft.isbn} placeholder="9784047294646" onChange={(e) => set({ isbn: e.target.value })} /></label>
              <label>刊行日<input type="date" value={draft.publishedOn} onChange={(e) => set({ publishedOn: e.target.value })} /></label>
              <label>本体価格（円）<input value={draft.listPrice} inputMode="numeric" style={{ width: 110 }} onChange={(e) => set({ listPrice: e.target.value })} /></label>
            </div>
            {draft.relation === "sublicense" && (
              <label>版元との条件（OUT）
                <select value={draft.outConditionId} onChange={(e) => set({ outConditionId: e.target.value })}>
                  <option value="">（後で付ける）</option>
                  {outs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.conditionNo ?? `#${c.id}`} {c.counterparty?.name ?? ""}{c.ratePpm !== null ? ` ${c.ratePpm / 10000}%` : ""}
                    </option>
                  ))}
                </select>
                {!outs.length && <span className="faint"> この作品に{draft.publisherName ? ` ${draft.publisherName} との` : ""}許諾（OUT）の条件がありません。条件明細で作るか、出版作品の一括登録の「版元料率」で作れます</span>}
              </label>
            )}
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              <label>版の名前（任意）<input value={draft.editionTitle} placeholder="新装版・文庫版 など" onChange={(e) => set({ editionTitle: e.target.value })} /></label>
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
