import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError } from "./api.js";
import { sortRows, type Row } from "./LineItems.js";
import {
  RateEditor, SharesEditor, distOf, pct, sameShares, withDist, type Distribution, type ShareEdit
} from "./WorkMatrixEditor.js";
import type { MatrixApplyResult, MatrixCondition } from "../server/works/matrix.js";

/**
 * 出版条件書の対象著作物を表で直す（文書の作成画面の「表で直す」。作品が多い条件書のため）。
 *
 *   文書の文（この文書の一覧だけ）… 原著作物名・対象出版物名・著作権表示・共同著作・第三者権利・発行日・備考
 *   条件明細（台帳）             … 料率（紙・電子・翻訳版）・共著者と取り分・分配方法。作品の「まとめて直す」と同じ
 *                                  処理（POST /work-matrix/apply）で、理由・改訂／訂正・適用日を付けて当てる
 *
 * 台帳を改訂して新しい版ができたら、文書が載せる条件を新しい版に付け替える（onLedgerApplied に 旧 id → 新 id を返す）。
 * 著作権表示・共同著作は「作品のクレジット表記にも反映」を選ぶと、作品の台帳（クレジット表記の履歴）にも入れる。
 */

type DocCol = "title" | "edition" | "copyright" | "third_party" | "published_on" | "note";
const DOC_COLS: Array<{ key: DocCol; label: string; width?: number; date?: boolean }> = [
  { key: "title", label: "原著作物名", width: 200 },
  { key: "edition", label: "対象出版物名", width: 150 },
  { key: "copyright", label: "著作権表示", width: 170 },
  { key: "third_party", label: "共同著作・第三者権利", width: 160 },
  { key: "published_on", label: "発行日", width: 104, date: true },
  { key: "note", label: "備考", width: 220 }
];
type LedgerKey = "print_condition_id" | "digital_condition_id" | "trans_print_condition_id" | "trans_digital_condition_id";
const LEDGER_COLS: Array<{ key: LedgerKey; label: string; text: string; excl: string }> = [
  { key: "print_condition_id", label: "紙", text: "print_rate", excl: "print_exclusivity" },
  { key: "digital_condition_id", label: "電子", text: "digital_rate", excl: "digital_exclusivity" },
  { key: "trans_print_condition_id", label: "翻訳版（紙）", text: "trans_print_rate", excl: "" },
  { key: "trans_digital_condition_id", label: "翻訳版（電子）", text: "trans_digital_rate", excl: "" }
];
interface CondEdit { ratePpm?: number; shares?: ShareEdit[]; distribution?: Distribution }
type Editing = { k: number; col: DocCol } | { k: number; ledger: LedgerKey } | { k: number; shares: true } | null;

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const idOf = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 行の条件 id（紙・電子・翻訳版と、行が持つ condition_ids）を、改訂で付け替えた id に置き換える。 */
export function remapRowIds(row: Row, map: Record<number, number>): Row {
  const out: Row = { ...row };
  for (const c of LEDGER_COLS) { const id = idOf(row[c.key]); if (id && map[id]) out[c.key] = map[id]; }
  if (Array.isArray(row.condition_ids)) out.condition_ids = (row.condition_ids as unknown[]).map((v) => map[Number(v)] ?? v);
  return out;
}

export function PubTitlesTable({ rows, seed, onClose, onApply, onLedgerApplied }: {
  /** いまの一覧（手で直していなければ自動の行）。 */
  rows: Row[]; seed: Row[];
  onClose: () => void;
  /** 文書の一覧を置き換える（直していなければ呼ばない）。 */
  onApply: (rows: Row[]) => void;
  /** 台帳を直した（改訂なら 旧 id → 新 id）。文書の条件の付け替えと、自動の行・プレビューの読み直しに使う。 */
  onLedgerApplied: (revised: Record<number, number>) => void;
}) {
  const base = useMemo<Row[]>(() => rows.map((r, k) => ({ ...r, __k: k })), [rows]);
  const [work, setWork] = useState<Row[]>(base);
  const [conds, setConds] = useState<MatrixCondition[]>([]);
  const [condEdits, setCondEdits] = useState<Map<number, CondEdit>>(new Map());
  const [editing, setEditing] = useState<Editing>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "noCopyright" | "shares" | "noDate" | "changed">("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkCol, setBulkCol] = useState<DocCol>("copyright");
  const [bulkValue, setBulkValue] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const [mode, setMode] = useState<"revise" | "correct">("revise");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [creditToWork, setCreditToWork] = useState(true);
  const [preview, setPreview] = useState<MatrixApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allIds = useMemo(() => [...new Set(base.flatMap((r) => LEDGER_COLS.map((c) => idOf(r[c.key])).filter((n): n is number => n !== null)))], [base]);
  useEffect(() => {
    if (!allIds.length) return;
    let live = true;
    api.get<{ conditions: MatrixCondition[] }>(`/work-matrix/conditions?ids=${allIds.join(",")}`)
      .then((r) => { if (live) setConds(r.conditions); }).catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [allIds.join(",")]);
  const condById = useMemo(() => new Map(conds.map((c) => [c.id, c])), [conds]);
  const baseByK = useMemo(() => new Map(base.map((r) => [Number(r.__k), r])), [base]);
  const usedLedger = LEDGER_COLS.filter((c) => base.some((r) => idOf(r[c.key])));

  // 直したところ
  const docChanged = (r: Row, col: DocCol) => s(r[col]) !== s(baseByK.get(Number(r.__k))?.[col] ?? seedValue(r, col));
  function seedValue(r: Row, col: DocCol): unknown {
    if (col !== "published_on") return undefined;
    const name = s(r.title ?? r.item_name).trim();
    return seed.find((x) => s(x.title ?? x.item_name).trim() === name)?.published_on;
  }
  const docEdits = work.flatMap((r) => DOC_COLS.filter((c) => docChanged(r, c.key)).map((c) => ({ k: Number(r.__k), col: c.key })));
  const ledgerChanges = useMemo(() => {
    const out: Array<{ id: number; ratePpm?: number; shares?: ShareEdit[]; distribution?: Distribution }> = [];
    for (const [id, e] of condEdits) {
      const c = condById.get(id);
      if (!c) continue;
      const x: { id: number; ratePpm?: number; shares?: ShareEdit[]; distribution?: Distribution } = { id };
      if (e.ratePpm !== undefined && e.ratePpm !== c.ratePpm) x.ratePpm = e.ratePpm;
      if (e.shares !== undefined && !sameShares(e.shares, c.shares)) x.shares = e.shares;
      if (e.distribution !== undefined && e.distribution !== distOf(c.distribution)) x.distribution = e.distribution;
      if (Object.keys(x).length > 1) out.push(x);
    }
    return out;
  }, [condEdits, condById]);
  // 作品のクレジット表記にも反映するもの（著作権表示・共同著作を直した行。作品は行の条件から）
  const workChanges = useMemo(() => {
    if (!creditToWork) return [];
    const byWork = new Map<number, { id: number; copyrightNotice?: string; thirdPartyRights?: string | null }>();
    for (const r of work) {
      const wid = LEDGER_COLS.map((c) => condById.get(idOf(r[c.key]) ?? -1)?.workId).find((v) => v);
      if (!wid) continue;
      const cc = docChanged(r, "copyright"), tc = docChanged(r, "third_party");
      if (!cc && !tc) continue;
      const e = byWork.get(wid) ?? { id: wid };
      if (cc && s(r.copyright).trim()) e.copyrightNotice = s(r.copyright).trim();
      if (tc) e.thirdPartyRights = s(r.third_party).trim() || null;
      byWork.set(wid, e);
    }
    return [...byWork.values()].filter((w) => w.copyrightNotice !== undefined || w.thirdPartyRights !== undefined);
  }, [work, creditToWork, condById]);
  const touchesLedger = ledgerChanges.length > 0 || workChanges.length > 0;

  // 絞り込み
  const shown = work.filter((r) => {
    const text = [r.title, r.item_name, r.edition, r.terms_no, r.copyright, r.third_party, r.note].map(s).join(" ");
    if (q.trim() && !text.includes(q.trim())) return false;
    if (only === "noCopyright") return !s(r.copyright).trim();
    if (only === "noDate") return !s(r.published_on ?? seedValue(r, "published_on")).trim();
    if (only === "shares") return LEDGER_COLS.some((c) => (condById.get(idOf(r[c.key]) ?? -1)?.shares.length ?? 0) > 0);
    if (only === "changed") return DOC_COLS.some((c) => docChanged(r, c.key))
      || LEDGER_COLS.some((c) => ledgerChanges.some((x) => x.id === idOf(r[c.key])));
    return true;
  });
  const count = (f: typeof only) => work.filter((r) => {
    if (f === "noCopyright") return !s(r.copyright).trim();
    if (f === "noDate") return !s(r.published_on ?? seedValue(r, "published_on")).trim();
    if (f === "shares") return LEDGER_COLS.some((c) => (condById.get(idOf(r[c.key]) ?? -1)?.shares.length ?? 0) > 0);
    return false;
  }).length;

  const setCell = (k: number, col: DocCol, value: string) => {
    setWork((w) => w.map((r) => (Number(r.__k) === k ? { ...r, [col]: value === "" ? null : value } : r)));
    setPreview(null);
  };
  const setCond = (id: number, patch: CondEdit) => {
    setCondEdits((m) => { const n = new Map(m); n.set(id, { ...(n.get(id) ?? {}), ...patch }); return n; });
    setPreview(null);
  };
  /** Enter：下の行の同じ列へ。Tab：右の列へ。 */
  const moveFrom = (k: number, col: DocCol, how: "down" | "right") => {
    const i = shown.findIndex((r) => Number(r.__k) === k);
    if (how === "down") {
      const next = shown[i + 1];
      setEditing(next ? { k: Number(next.__k), col } : null);
    } else {
      const ci = DOC_COLS.findIndex((c) => c.key === col);
      const nc = DOC_COLS[ci + 1];
      setEditing(nc ? { k, col: nc.key } : null);
    }
  };
  const targets = () => (picked.size ? shown.filter((r) => picked.has(Number(r.__k))) : shown);

  async function confirmLedger(dry: boolean): Promise<MatrixApplyResult | null> {
    const body = {
      conditions: ledgerChanges.map((x) => ({
        id: x.id, ...(x.ratePpm !== undefined ? { ratePpm: x.ratePpm } : {}),
        ...(x.shares ? { shares: x.shares.map((v) => ({ partyId: v.partyId, sharePpm: v.sharePpm, note: v.note })) } : {}),
        ...(x.distribution ? { distribution: x.distribution } : {})
      })),
      works: workChanges, mode, effectiveFrom: effectiveFrom || null, creditFrom: todayStr(), reason: reason.trim()
    };
    return api.post<MatrixApplyResult>(dry ? "/work-matrix/preview" : "/work-matrix/apply", body);
  }
  async function check() {
    setBusy(true); setError(null);
    try { setPreview(await confirmLedger(true)); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  async function finish() {
    setBusy(true); setError(null);
    try {
      let map: Record<number, number> = {};
      if (touchesLedger) {
        const r = await confirmLedger(false);
        if (!r || !r.applied) { setPreview(r); setError("台帳に当てられない項目があります。下の結果を見て直してください"); return; }
        for (const i of r.items) if (i.target === "condition" && i.revisedTo) map[i.id] = i.revisedTo.id;
      }
      const remapped = Object.keys(map).length ? work.map((r) => remapRowIds(r, map)) : work;
      if (docEdits.length || Object.keys(map).length) {
        onApply(remapped.map(({ __k, ...r }) => r));
      }
      if (touchesLedger) onLedgerApplied(map);
      onClose();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const ready = !touchesLedger || (reason.trim() && preview && preview.items.every((i) => i.ok));
  const total = docEdits.length + ledgerChanges.length;

  return (
    <div className="pt-overlay" role="dialog" aria-label="対象著作物を表で直す">
      <div className="pt-sheet">
        <div className="pt-hd">
          <h2>対象著作物を表で直す</h2>
          <span className="faint">作品 {work.length} 点。値を押して直す（Enter で下へ・Tab で右へ・Esc でやめる）</span>
          <span style={{ marginLeft: "auto" }} className="faint">直したところ {total}</span>
          <button className="btn btn-sm" onClick={onClose} disabled={busy}>閉じる（直した内容を捨てる）</button>
        </div>
        <div className="pt-tools">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="作品名・番号・著作権表示で絞る" style={{ width: 240 }} aria-label="絞り込み" />
          <span className="faint">{shown.length} / {work.length} 点</span>
          {([["all", "すべて"], ["noCopyright", `著作権表示が空 ${count("noCopyright")}`], ["shares", `取り分あり ${count("shares")}`],
             ["noDate", `発行日なし ${count("noDate")}`], ["changed", "直したところ"]] as const).map(([k, label]) => (
            <button key={k} type="button" className="chip" aria-pressed={only === k} onClick={() => setOnly(k)}>{label}</button>
          ))}
          <span className="pt-sep" />
          <button className="btn btn-sm" onClick={() => setWork((w) => sortRows(w, seed, "published_on"))}>発行日順に並べる</button>
          <button className="btn btn-sm" onClick={() => setWork((w) => sortRows(w, seed, "published_on", true))}>新しい順</button>
          <span className="pt-sep" />
          <b>{picked.size ? `選んだ ${picked.size} 行に` : `表示中の ${shown.length} 行に`}</b>
          <select value={bulkCol} onChange={(e) => setBulkCol(e.target.value as DocCol)} aria-label="まとめて入れる列">
            {DOC_COLS.map((c) => <option key={c.key} value={c.key}>{c.key === "note" ? "備考に足す" : c.label}</option>)}
          </select>
          <input value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} style={{ width: 200 }} aria-label="まとめて入れる値" />
          <button className="btn btn-sm" disabled={!bulkValue.trim()} onClick={() => {
            for (const r of targets()) {
              const k = Number(r.__k);
              const v = bulkCol === "note" ? [s(r.note).trim(), bulkValue.trim()].filter(Boolean).join("／") : bulkValue.trim();
              setCell(k, bulkCol, v);
            }
          }}>まとめて入れる</button>
          <button className="btn btn-sm" onClick={() => setPaste("")}>Excel から貼り付け</button>
        </div>

        {paste !== null && (
          <div className="pt-paste">
            <b>Excel から貼り付け</b>
            <span className="faint">列を選んで、Excel で縦にコピーした値を貼る。{picked.size ? "選んだ行" : "表示中の行"}に上から順に入る</span>
            <select value={bulkCol} onChange={(e) => setBulkCol(e.target.value as DocCol)} aria-label="貼り付ける列">
              {DOC_COLS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} style={{ width: 360 }} aria-label="貼り付ける値" />
            <button className="btn btn-sm primary" onClick={() => {
              const lines = (paste ?? "").replace(/\r/g, "").split("\n");
              if (lines.length && lines[lines.length - 1] === "") lines.pop();
              targets().forEach((r, i) => { if (i < lines.length) setCell(Number(r.__k), bulkCol, lines[i]!.trim()); });
              setPaste(null);
            }}>入れる（{(paste ?? "").replace(/\r/g, "").split("\n").filter((l, i, a) => i < a.length - 1 || l !== "").length} 行）</button>
            <button className="btn btn-sm" onClick={() => setPaste(null)}>やめる</button>
          </div>
        )}

        {error && <div className="alert" style={{ margin: "8px 16px 0" }}>{error}</div>}
        <div className="pt-body">
          <table className="mx-table pt-table">
            <thead>
              <tr>
                <th style={{ width: 28 }}><input type="checkbox" aria-label="表示中をすべて選ぶ"
                  checked={shown.length > 0 && shown.every((r) => picked.has(Number(r.__k)))}
                  onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => Number(r.__k))) : new Set())} /></th>
                <th style={{ width: 36 }}>No</th>
                <th style={{ width: 150 }}>条件書番号</th>
                {DOC_COLS.slice(0, 4).map((c) => <th key={c.key} style={{ minWidth: c.width }}>{c.label}</th>)}
                {usedLedger.map((c) => <th key={c.key} className="pt-ledger" style={{ minWidth: 96 }}>料率（{c.label}）<div className="faint">台帳</div></th>)}
                <th className="pt-ledger" style={{ minWidth: 220 }}>共著者・取り分・分配<div className="faint">台帳</div></th>
                {DOC_COLS.slice(4).map((c) => <th key={c.key} style={{ minWidth: c.width }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const k = Number(r.__k);
                const no = work.findIndex((x) => Number(x.__k) === k) + 1;
                const docCell = (c: typeof DOC_COLS[number]) => {
                  const open = editing !== null && "col" in editing && editing.k === k && editing.col === c.key;
                  const value = s(r[c.key] ?? (c.key === "published_on" ? seedValue(r, c.key) : ""));
                  const changed = docChanged(r, c.key);
                  return (
                    <td key={c.key} className={changed ? "mx-chg" : undefined} onClick={() => !open && setEditing({ k, col: c.key })}>
                      {open
                        ? <CellInput initial={value} date={c.date} multiline={c.key === "note"}
                            onDone={(v, how) => { if (v !== null) setCell(k, c.key, v); if (how) moveFrom(k, c.key, how); else setEditing(null); }} />
                        : (value || <span className="faint">{c.key === "third_party" ? "なし" : "—"}</span>)}
                    </td>
                  );
                };
                const sharesCond = [idOf(r.print_condition_id), idOf(r.digital_condition_id)]
                  .map((id) => (id ? condById.get(id) : undefined)).find((c) => c && c.direction === "in" && c.pricingModel === "revenue_rate");
                const rowConds = LEDGER_COLS.map((c) => condById.get(idOf(r[c.key]) ?? -1)).filter((c): c is MatrixCondition => Boolean(c));
                return (
                  <tr key={k} className={picked.has(k) ? "pt-picked" : undefined}>
                    <td><input type="checkbox" checked={picked.has(k)} aria-label={`No ${no} を選ぶ`}
                               onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(k); else n.delete(k); return n; })} /></td>
                    <td>{no}</td>
                    <td className="code">{s(r.terms_no) || <span className="faint">（決定で振る）</span>}</td>
                    {DOC_COLS.slice(0, 4).map(docCell)}
                    {usedLedger.map((lc) => {
                      const id = idOf(r[lc.key]);
                      const c = id ? condById.get(id) : undefined;
                      if (!c) return <td key={lc.key} className="pt-ro">{s(r[lc.text]) || "—"}</td>;
                      const e = condEdits.get(c.id) ?? {};
                      const open = editing !== null && "ledger" in editing && editing.k === k && editing.ledger === lc.key;
                      const changed = e.ratePpm !== undefined && e.ratePpm !== c.ratePpm;
                      return (
                        <td key={lc.key} className={`pt-led${changed ? " mx-chg" : ""}`} onClick={() => !open && c.pricingModel === "revenue_rate" && setEditing({ k, ledger: lc.key })}>
                          {open
                            ? <RateEditor cond={c} initial={e.ratePpm ?? c.ratePpm} conds={conds}
                                onDone={(ppm, ids) => { if (ppm !== null) for (const x of ids) setCond(x, { ratePpm: ppm }); setEditing(null); }} />
                            : <>{changed && <span className="mx-old">{pct(c.ratePpm)}</span>}{pct(e.ratePpm ?? c.ratePpm)}
                                {lc.excl && s(r[lc.excl]) && s(r[lc.excl]) !== "—" && <span className="faint">・{s(r[lc.excl])}</span>}</>}
                        </td>
                      );
                    })}
                    <td className={`pt-led${sharesCond && ((condEdits.get(sharesCond.id)?.shares && !sameShares(condEdits.get(sharesCond.id)!.shares!, sharesCond.shares))
                          || (condEdits.get(sharesCond.id)?.distribution !== undefined && condEdits.get(sharesCond.id)!.distribution !== distOf(sharesCond.distribution))) ? " mx-chg" : ""}`}
                        onClick={() => sharesCond && !(editing && "shares" in editing && editing.k === k) && setEditing({ k, shares: true })}>
                      {sharesCond && editing !== null && "shares" in editing && editing.k === k
                        ? <SharesEditor cond={sharesCond} conds={rowConds}
                            initial={condEdits.get(sharesCond.id)?.shares ?? sharesCond.shares}
                            ratePpm={condEdits.get(sharesCond.id)?.ratePpm ?? sharesCond.ratePpm}
                            distribution={condEdits.get(sharesCond.id)?.distribution ?? distOf(sharesCond.distribution)}
                            onDone={(list, ids, dist) => { if (list) for (const x of ids) setCond(x, { shares: list, distribution: dist }); setEditing(null); }} />
                        : sharesCond
                          ? withDist(condEdits.get(sharesCond.id)?.shares ?? sharesCond.shares,
                                     condEdits.get(sharesCond.id)?.distribution ?? distOf(sharesCond.distribution),
                                     condEdits.get(sharesCond.id)?.ratePpm ?? sharesCond.ratePpm)
                          : <span className="faint">{s(r.co_authors) || "—"}</span>}
                    </td>
                    {DOC_COLS.slice(4).map(docCell)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {preview && (
          <div className="pt-result">
            <b>台帳を確かめた結果 </b>
            {preview.items.every((i) => i.ok)
              ? <span className="tag ok">すべて当てられます</span>
              : <span className="tag warn">{preview.items.filter((i) => !i.ok).length} 件が断られます</span>}
            <ul>
              {preview.items.map((i) => (
                <li key={`${i.target}-${i.id}`}>{i.label}：{i.what.join("・")} → {i.ok
                  ? (i.revisedTo ? `新しい版 ${i.revisedTo.conditionNo}（${i.revisedTo.status === "scheduled" ? `${i.revisedTo.effectiveFrom} から` : "今日から"}）。この文書は新しい版を載せる`
                    : i.target === "work" ? "作品のクレジット表記に今日の行を足す" : "その場で直す")
                  : <span style={{ color: "var(--out)" }}>{i.message}</span>}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="pt-ft">
          <span><b>直したところ {total}</b>
            <span className="faint">（文書の文 {docEdits.length}・台帳 {ledgerChanges.length}{workChanges.length ? `・作品のクレジット ${workChanges.length}` : ""}）</span></span>
          {(docEdits.some((d) => d.col === "copyright" || d.col === "third_party")) && (
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={creditToWork} onChange={(e) => { setCreditToWork(e.target.checked); setPreview(null); }} />
              著作権表示・共同著作を作品のクレジット表記にも反映</label>
          )}
          {touchesLedger && (
            <>
              {ledgerChanges.length > 0 && (
                <label className="row" style={{ gap: 4 }}>当て方
                  <select value={mode} onChange={(e) => { setMode(e.target.value as "revise" | "correct"); setPreview(null); }}>
                    <option value="revise">改訂（適用日から新しい版）</option>
                    <option value="correct">訂正（その場で直す）</option>
                  </select>
                  {mode === "revise" && <input type="date" value={effectiveFrom} onChange={(e) => { setEffectiveFrom(e.target.value); setPreview(null); }} aria-label="適用日" />}
                </label>
              )}
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="台帳を直す理由（履歴に残る）" style={{ flex: "1 1 220px" }} aria-label="台帳を直す理由" />
              <button className="btn btn-sm" disabled={busy} onClick={() => void check()}>台帳を確かめる</button>
            </>
          )}
          <button className="btn primary" style={{ marginLeft: "auto" }} disabled={busy || !ready || total + workChanges.length === 0}
                  title={touchesLedger && !preview ? "先に「台帳を確かめる」で結果を見てください" : undefined}
                  onClick={() => void finish()}>{busy ? "反映しています…" : touchesLedger ? "台帳に当てて一覧に入れる" : "一覧に入れて閉じる"}</button>
        </div>
      </div>
    </div>
  );
}

/** セルの入力欄。Enter で入れて下へ、Tab で右へ、Esc でやめる（備考は Ctrl+Enter で入れる）。 */
function CellInput({ initial, onDone, date, multiline }: {
  initial: string; date?: boolean; multiline?: boolean;
  onDone: (value: string | null, how: "down" | "right" | null) => void;
}) {
  const [v, setV] = useState(initial);
  // 1 回だけ返す（キーで返したあと、消える入力欄の blur でもう一度返さない）。
  const sent = useRef(false);
  const done = (value: string | null, how: "down" | "right" | null) => { if (sent.current) return; sent.current = true; onDone(value, how); };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); done(null, null); }
    else if (e.key === "Tab") { e.preventDefault(); done(v, "right"); }
    else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); done(v, "down"); }
  };
  return multiline
    ? <textarea autoFocus value={v} rows={3} style={{ width: "100%" }} onChange={(e) => setV(e.target.value)} onKeyDown={key}
                onBlur={() => done(v, null)} />
    : <input autoFocus type={date ? "date" : "text"} value={v} style={{ width: "100%" }} onChange={(e) => setV(e.target.value)} onKeyDown={key}
             onBlur={() => done(v, null)} />;
}

