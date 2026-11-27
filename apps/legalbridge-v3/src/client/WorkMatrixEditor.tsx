import { Fragment, useEffect, useMemo, useState, type ReactElement } from "react";
import { api, ApiError } from "./api.js";
import { useDebounced } from "./ListTools.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { CONDITION_USAGE_TYPES } from "../server/core/condition-usage.js";
import type { MatrixApplyResult, MatrixCondition, MatrixSearchHit, MatrixWork } from "../server/works/matrix.js";
import { roundToMillion, sharePpmFromEffective } from "../server/works/share-math.js";

/**
 * 作品の条件をまとめて直す（作品の画面の「まとめて直す」）。サーバは works/matrix.ts。
 *
 *   1. 作品を探して表に置く（著者名・作品名・作品コード）
 *   2. 表の値を押して直す（何か所でも。保存はまだ）。直したところは「旧 → 新」
 *        作品の行 … 著作権表示・共著者表記（クレジット表記の履歴に、適用開始日つきで足す）
 *        条件の行 … 取引モデル名（その場で直す）・料率・共著者と取り分（改訂か訂正）
 *   3. 取引モデル名の表記ゆれを、規則の名前（作品名｜取引モデル）にまとめてそろえる
 *   4. 理由を入れて「確かめる」（試算。何も変えない）→「この内容で変更する」
 */

type ShareEdit = { partyId: number; partyName: string; sharePpm: number; note: string | null };
interface CondEdit { name?: string; ratePpm?: number; shares?: ShareEdit[] }
interface WorkEdit { copyrightNotice?: string; thirdPartyRights?: string | null }
type Cell = { kind: "work"; id: number; field: "copyrightNotice" | "thirdPartyRights" }
  | { kind: "cond"; id: number; field: "name" | "ratePpm" | "shares" };

const USAGE_LABEL = Object.fromEntries(CONDITION_USAGE_TYPES.map((u) => [u.value, u.label])) as Record<string, string>;
const BASIS_LABEL: Record<string, string> = { list: "定価・本体価格", supply: "卸価格", receipts: "受領額" };
const pct = (ppm: number | null | undefined) =>
  ppm === null || ppm === undefined ? "—" : `${String(Number((ppm / 10_000).toFixed(4)))}%`;
const toPpm = (text: string): number | null => {
  const n = Number(String(text).replace(/[%％\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10_000) : null;
};
/** 取り分の表示。料率が分かれば実質料率（料率 × 取り分）も添える。 */
const sharesText = (s: ShareEdit[], ratePpm?: number | null) => (s.length
  ? s.map((x) => `${x.partyName} ${pct(x.sharePpm)}${ratePpm ? `（実質 ${pct(Math.round((ratePpm * x.sharePpm) / 1_000_000))}）` : ""}${x.note ? `［${x.note}］` : ""}`).join(" ／ ")
  : "（取り分なし＝相手先に全額）");
const sameShares = (a: ShareEdit[], b: ShareEdit[]) =>
  a.length === b.length && a.every((x, i) => x.partyId === b[i]!.partyId && x.sharePpm === b[i]!.sharePpm && (x.note ?? "") === (b[i]!.note ?? ""));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function WorkMatrixEditor({ onClose, onOpenCondition, initialWorkIds }: {
  onClose: () => void;
  onOpenCondition?: (id: number) => void;
  initialWorkIds?: number[];
}) {
  const [q, setQ] = useState("");
  const query = useDebounced(q, 300);
  const [hits, setHits] = useState<MatrixSearchHit[] | null>(null);
  const [placed, setPlaced] = useState<number[]>(initialWorkIds ?? []);
  const [works, setWorks] = useState<MatrixWork[]>([]);
  const [condEdits, setCondEdits] = useState<Map<number, CondEdit>>(new Map());
  const [workEdits, setWorkEdits] = useState<Map<number, WorkEdit>>(new Map());
  const [cell, setCell] = useState<Cell | null>(null);
  const [mode, setMode] = useState<"revise" | "correct">("revise");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [creditFrom, setCreditFrom] = useState(todayStr());
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<MatrixApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!query.trim()) { setHits(null); return; }
    let live = true;
    api.get<{ works: MatrixSearchHit[] }>(`/work-matrix/search?q=${encodeURIComponent(query.trim())}`)
      .then((r) => { if (live) setHits(r.works); }).catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [query]);

  useEffect(() => {
    if (!placed.length) { setWorks([]); return; }
    let live = true;
    api.get<{ works: MatrixWork[] }>(`/work-matrix?ids=${placed.join(",")}`)
      .then((r) => { if (live) setWorks(r.works); }).catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [placed, version]);

  const conds = useMemo(() => works.flatMap((w) => w.conditions.map((c) => ({ ...c, workTitle: w.title }))), [works]);
  const condById = useMemo(() => new Map(conds.map((c) => [c.id, c])), [conds]);
  const workById = useMemo(() => new Map(works.map((w) => [w.id, w])), [works]);

  // 直したところ（元と同じ値に戻したものは数えない）。
  const changes = useMemo(() => {
    const c: Array<{ id: number; edit: CondEdit }> = [];
    for (const [id, e] of condEdits) {
      const base = condById.get(id);
      if (!base) continue;
      const out: CondEdit = {};
      if (e.name !== undefined && e.name.trim() && e.name.trim() !== base.name) out.name = e.name.trim();
      if (e.ratePpm !== undefined && e.ratePpm !== base.ratePpm) out.ratePpm = e.ratePpm;
      if (e.shares !== undefined && !sameShares(e.shares, base.shares)) out.shares = e.shares;
      if (Object.keys(out).length) c.push({ id, edit: out });
    }
    const w: Array<{ id: number; edit: WorkEdit }> = [];
    for (const [id, e] of workEdits) {
      const base = workById.get(id);
      if (!base) continue;
      const out: WorkEdit = {};
      if (e.copyrightNotice !== undefined && e.copyrightNotice.trim() && e.copyrightNotice.trim() !== (base.copyrightNotice ?? "")) out.copyrightNotice = e.copyrightNotice.trim();
      if (e.thirdPartyRights !== undefined && (e.thirdPartyRights ?? "").trim() !== (base.thirdPartyRights ?? "")) out.thirdPartyRights = (e.thirdPartyRights ?? "").trim() || null;
      if (Object.keys(out).length) w.push({ id, edit: out });
    }
    return { conditions: c, works: w };
  }, [condEdits, workEdits, condById, workById]);
  const counts = {
    name: changes.conditions.filter((x) => x.edit.name !== undefined).length,
    rate: changes.conditions.filter((x) => x.edit.ratePpm !== undefined).length,
    shares: changes.conditions.filter((x) => x.edit.shares !== undefined).length,
    credit: changes.works.length
  };
  const total = counts.name + counts.rate + counts.shares + counts.credit;
  const touchesEconomics = counts.rate + counts.shares > 0;

  const setCond = (id: number, patch: CondEdit) => {
    setCondEdits((m) => { const n = new Map(m); n.set(id, { ...(n.get(id) ?? {}), ...patch }); return n; });
    setPreview(null);
  };
  const setWork = (id: number, patch: WorkEdit) => {
    setWorkEdits((m) => { const n = new Map(m); n.set(id, { ...(n.get(id) ?? {}), ...patch }); return n; });
    setPreview(null);
  };
  const undoCond = (id: number, field: keyof CondEdit) => setCondEdits((m) => {
    const n = new Map(m); const e = { ...(n.get(id) ?? {}) }; delete e[field]; n.set(id, e); return n;
  });
  const undoWork = (id: number, field: keyof WorkEdit) => setWorkEdits((m) => {
    const n = new Map(m); const e = { ...(n.get(id) ?? {}) }; delete e[field]; n.set(id, e); return n;
  });

  const place = (id: number) => setPlaced((p) => (p.includes(id) ? p : [...p, id]));
  const unplace = (id: number) => {
    setPlaced((p) => p.filter((x) => x !== id));
    const w = workById.get(id);
    if (w) {
      setCondEdits((m) => { const n = new Map(m); for (const c of w.conditions) n.delete(c.id); return n; });
      setWorkEdits((m) => { const n = new Map(m); n.delete(id); return n; });
    }
  };

  // 取引モデル名の表記ゆれ：規則の名前と違う条件を、取引モデルごとにまとめる。
  const nameGroups = useMemo(() => {
    const groups = new Map<string, MatrixCondition[]>();
    for (const c of conds) {
      if (!c.suggestedName) continue;
      const edited = condEdits.get(c.id)?.name;
      if (edited !== undefined && edited.trim() === c.suggestedName) continue;
      const key = c.usageType ?? "";
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    return [...groups.entries()];
  }, [conds, condEdits]);

  async function run(dry: boolean) {
    setBusy(true); setError(null); setNotice(null);
    const body = {
      conditions: changes.conditions.map((x) => ({
        id: x.id, ...x.edit,
        ...(x.edit.shares ? { shares: x.edit.shares.map((s) => ({ partyId: s.partyId, sharePpm: s.sharePpm, note: s.note })) } : {})
      })),
      works: changes.works.map((x) => ({ id: x.id, ...x.edit })),
      mode, effectiveFrom: effectiveFrom || null, creditFrom: creditFrom || null, reason: reason.trim()
    };
    try {
      const r = await api.post<MatrixApplyResult>(dry ? "/work-matrix/preview" : "/work-matrix/apply", body);
      if (dry || !r.applied) { setPreview(r); return; }
      const revised = r.items.filter((i) => i.revisedTo).length;
      setNotice(`まとめて変更しました（${r.items.length} 件${revised ? `・改訂 ${revised} 本` : ""}）`);
      setCondEdits(new Map()); setWorkEdits(new Map()); setPreview(null); setCell(null);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /** セル：押すと入力欄。直していれば「旧 → 新」と元に戻す×。 */
  const shown = (opts: { open: boolean; changed: boolean; old: string; now: string; onOpen: () => void; onUndo: () => void; editor: () => ReactElement; mono?: boolean }) => (
    opts.open ? opts.editor() : (
      <span className={`mx-cell${opts.changed ? " mx-chg" : ""}${opts.mono ? " mono" : ""}`} role="button" tabIndex={0}
            title="押して直す" onClick={opts.onOpen} onKeyDown={(e) => { if (e.key === "Enter") opts.onOpen(); }}>
        {opts.changed && <span className="mx-old">{opts.old || "（空）"}</span>}
        {opts.now || <span className="faint">（空）</span>}
        {opts.changed && <button type="button" className="linky mx-undo" title="元に戻す"
                                 onClick={(e) => { e.stopPropagation(); opts.onUndo(); }}>×</button>}
      </span>
    )
  );
  const isOpen = (c: Cell) => cell !== null && cell.kind === c.kind && cell.id === c.id && cell.field === c.field;

  return (
    <div className="panel mx">
      <div className="panel-hd">
        <h2>作品の条件をまとめて直す</h2>
        <span className="faint">作品を探して表に置く → 値を押して直す（何か所でも）→ 理由を入れて、まとめて変更する</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>
      <div className="panel-bd stack" style={{ gap: 12 }}>
        {error && <div className="alert">{error}</div>}
        {notice && <div className="note ok">{notice}</div>}

        {/* 1. 探して置く */}
        <section className="stack" style={{ gap: 6 }}>
          <b>1. 作品を探して表に置く</b>
          <div className="row" style={{ gap: 8 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 320 }} aria-label="作品を探す"
                   placeholder="著者名・作品名・作品コード（著者名は条件の相手先と共著者から引く）" />
            {hits && hits.length > 0 && (
              <button className="btn btn-sm" onClick={() => setPlaced((p) => [...p, ...hits.map((h) => h.id).filter((id) => !p.includes(id))])}>
                表示中をすべて置く（{hits.length}）</button>
            )}
            {placed.length > 0 && <button className="btn btn-sm" onClick={() => { setPlaced([]); setCondEdits(new Map()); setWorkEdits(new Map()); }}>表を空にする</button>}
          </div>
          {hits && (
            <div className="mx-hits">
              {hits.map((h) => {
                const on = placed.includes(h.id);
                return (
                  <button key={h.id} type="button" className={`mx-hit${on ? " on" : ""}`} onClick={() => (on ? unplace(h.id) : place(h.id))}
                          title={h.authors.length ? `著者：${h.authors.join("・")}` : undefined}>
                    {on ? "✓ " : "＋ "}{h.title}
                    {h.workCode && <span className="code faint"> {h.workCode}</span>}
                    <span className="faint">　条件 {h.conditionCount}</span>
                  </button>
                );
              })}
              {!hits.length && <span className="faint">見つかりません</span>}
            </div>
          )}
        </section>

        {/* 2. 表 */}
        {works.length > 0 && (
          <section className="stack" style={{ gap: 6 }}>
            <b>2. 表（{works.length} 作品・条件明細 {conds.length} 本）<span className="faint" style={{ fontWeight: 400 }}>　値を押すと入力欄。直したところは黄色で「旧 → 新」。保存は下の「まとめて変更する」まで行いません</span></b>
            <div className="tablewrap">
              <table className="mx-table">
                <thead><tr><th>条件番号</th><th>取引モデル名（条件名）</th><th>利用区分</th><th className="num">料率</th><th>算定の基礎</th><th>共著者と取り分</th><th>状態</th></tr></thead>
                <tbody>
                  {works.map((w) => {
                    const we = workEdits.get(w.id) ?? {};
                    return (
                      <Fragment key={w.id}>
                        <tr className="mx-work">
                          <td colSpan={7}>
                            <div className="row" style={{ gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
                              <span><b>{w.title}</b> {w.workCode && <span className="code faint">{w.workCode}</span>}</span>
                              <span><span className="faint">著作権表示 </span>
                                {shown({
                                  open: isOpen({ kind: "work", id: w.id, field: "copyrightNotice" }),
                                  changed: we.copyrightNotice !== undefined && we.copyrightNotice !== (w.copyrightNotice ?? ""),
                                  old: w.copyrightNotice ?? "", now: we.copyrightNotice ?? w.copyrightNotice ?? "",
                                  onOpen: () => setCell({ kind: "work", id: w.id, field: "copyrightNotice" }),
                                  onUndo: () => undoWork(w.id, "copyrightNotice"),
                                  editor: () => <TextEditor initial={we.copyrightNotice ?? w.copyrightNotice ?? ""} width={280}
                                    onDone={(v) => { if (v !== null) setWork(w.id, { copyrightNotice: v }); setCell(null); }} />
                                })}</span>
                              <span><span className="faint">共著者表記 </span>
                                {shown({
                                  open: isOpen({ kind: "work", id: w.id, field: "thirdPartyRights" }),
                                  changed: we.thirdPartyRights !== undefined && (we.thirdPartyRights ?? "") !== (w.thirdPartyRights ?? ""),
                                  old: w.thirdPartyRights ?? "", now: (we.thirdPartyRights !== undefined ? we.thirdPartyRights : w.thirdPartyRights) ?? "",
                                  onOpen: () => setCell({ kind: "work", id: w.id, field: "thirdPartyRights" }),
                                  onUndo: () => undoWork(w.id, "thirdPartyRights"),
                                  editor: () => <TextEditor initial={(we.thirdPartyRights !== undefined ? we.thirdPartyRights : w.thirdPartyRights) ?? ""} width={280}
                                    placeholder="例：共著：見本 花子／挿絵：見本 次郎"
                                    onDone={(v) => { if (v !== null) setWork(w.id, { thirdPartyRights: v }); setCell(null); }} />
                                })}</span>
                              {w.pendingCredit && <span className="tag" title={w.pendingCredit.copyrightNotice}>表記の予約 {w.pendingCredit.effectiveFrom}</span>}
                              <button className="linky" style={{ marginLeft: "auto" }} onClick={() => unplace(w.id)}>表から外す</button>
                            </div>
                          </td>
                        </tr>
                        {!w.conditions.length && <tr><td colSpan={7} className="faint">ライセンスの条件明細がありません</td></tr>}
                        {w.conditions.map((c) => {
                          const e = condEdits.get(c.id) ?? {};
                          const rateEditable = c.pricingModel === "revenue_rate";
                          const sharesEditable = rateEditable && c.direction === "in";
                          const nowShares = e.shares ?? c.shares;
                          return (
                            <tr key={c.id}>
                              <td className="code">
                                {onOpenCondition ? <button className="linky code" onClick={() => onOpenCondition(c.id)}>{c.conditionNo ?? `#${c.id}`}</button> : c.conditionNo}
                                {c.status === "scheduled" && <div><span className="tag">予約 {c.effectiveFrom}</span></div>}
                              </td>
                              <td>{shown({
                                open: isOpen({ kind: "cond", id: c.id, field: "name" }),
                                changed: e.name !== undefined && e.name !== c.name, old: c.name, now: e.name ?? c.name,
                                onOpen: () => setCell({ kind: "cond", id: c.id, field: "name" }),
                                onUndo: () => undoCond(c.id, "name"),
                                editor: () => <TextEditor initial={e.name ?? c.name} width={300}
                                  onDone={(v) => { if (v !== null && v.trim()) setCond(c.id, { name: v.trim() }); setCell(null); }} />
                              })}</td>
                              <td><span className={`tag ${c.direction === "in" ? "in" : "out"}`}>{c.direction === "in" ? "IN" : "OUT"}</span> {USAGE_LABEL[c.usageType ?? ""] ?? "—"}
                                {c.counterpartyName && <div className="faint">{c.counterpartyName}</div>}</td>
                              <td className="num">{rateEditable ? shown({
                                open: isOpen({ kind: "cond", id: c.id, field: "ratePpm" }), mono: true,
                                changed: e.ratePpm !== undefined && e.ratePpm !== c.ratePpm, old: pct(c.ratePpm), now: pct(e.ratePpm ?? c.ratePpm),
                                onOpen: () => setCell({ kind: "cond", id: c.id, field: "ratePpm" }),
                                onUndo: () => undoCond(c.id, "ratePpm"),
                                editor: () => <RateEditor cond={c} initial={e.ratePpm ?? c.ratePpm} conds={conds}
                                  onDone={(ppm, ids) => { if (ppm !== null) for (const id of ids) setCond(id, { ratePpm: ppm }); setCell(null); }} />
                              }) : <span className="faint">{c.flatAmount !== null ? `定額 ${c.flatAmount.toLocaleString("ja-JP")}` : "—"}</span>}</td>
                              <td className="faint">{BASIS_LABEL[c.priceBasis ?? ""] ?? "—"}</td>
                              <td>{sharesEditable ? shown({
                                open: isOpen({ kind: "cond", id: c.id, field: "shares" }),
                                changed: e.shares !== undefined && !sameShares(e.shares, c.shares), old: sharesText(c.shares, c.ratePpm), now: sharesText(nowShares, e.ratePpm ?? c.ratePpm),
                                onOpen: () => setCell({ kind: "cond", id: c.id, field: "shares" }),
                                onUndo: () => undoCond(c.id, "shares"),
                                editor: () => <SharesEditor cond={c} initial={nowShares} conds={conds} ratePpm={e.ratePpm ?? c.ratePpm}
                                  onDone={(list, ids) => { if (list) for (const id of ids) setCond(id, { shares: list }); setCell(null); }} />
                              }) : <span className="faint">{c.shares.length ? sharesText(c.shares, c.ratePpm) : "—"}</span>}</td>
                              <td>{c.hasDocument && <span className="tag ok">文書あり</span>}{c.hasEvents && <span className="tag">実績あり</span>}{c.hasPayment && <span className="tag warn">支払あり</span>}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* 3. 取引モデル名の表記ゆれ */}
        {works.length > 0 && (
          <section className="stack" style={{ gap: 6 }}>
            <b>3. 取引モデル名をそろえる</b>
            {!nameGroups.length
              ? <span className="faint">表に置いた条件の取引モデル名は、規則（作品名｜取引モデル）どおりです。個別に直すときは表の名前を押してください。</span>
              : (
                <>
                  <span className="faint">規則の名前（作品名｜取引モデル）と書き方が違う条件です。そろえると表のセルに入ります（保存は下で）。
                    目的を書いた名前（二次利用の「商品化」など）は対象にしていません。</span>
                  {nameGroups.map(([usage, list]) => (
                    <div key={usage} className="mx-group">
                      <div className="row" style={{ gap: 8 }}>
                        <b>{USAGE_LABEL[usage] ?? usage}</b><span className="faint">{list.length} 本</span>
                        <button className="btn btn-sm" onClick={() => { for (const c of list) setCond(c.id, { name: c.suggestedName! }); }}>
                          規則の名前にそろえる（{list.length} 本）</button>
                      </div>
                      <ul>
                        {list.map((c) => <li key={c.id}><span className="mx-old">{condEdits.get(c.id)?.name ?? c.name}</span> → {c.suggestedName}</li>)}
                      </ul>
                    </div>
                  ))}
                </>
              )}
          </section>
        )}

        {/* 試算の結果 */}
        {preview && (
          <section className="stack" style={{ gap: 6 }}>
            <b>確かめた結果 {preview.items.every((i) => i.ok)
              ? <span className="tag ok">すべて当てられます</span>
              : <span className="tag warn">{preview.items.filter((i) => !i.ok).length} 件が断られます（直すか元に戻してから、もう一度確かめる）</span>}</b>
            <table className="mx-table">
              <thead><tr><th>対象</th><th>直すもの</th><th>結果</th></tr></thead>
              <tbody>
                {preview.items.map((i) => (
                  <tr key={`${i.target}-${i.id}`}>
                    <td>{i.label}</td><td>{i.what.join("・")}</td>
                    <td>{i.ok
                      ? (i.revisedTo
                          ? <>新しい版 <span className="code">{i.revisedTo.conditionNo}</span>（{i.revisedTo.status === "scheduled" ? `${i.revisedTo.effectiveFrom} から` : "今日から"}）</>
                          : i.target === "work" ? <>クレジット表記の履歴に {creditFrom || "今日"} の行を足す</> : <>その場で直す</>)
                      : <span style={{ color: "var(--out)" }}>{i.message}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      {/* 下の帯 */}
      {works.length > 0 && (
        <div className="mx-bar">
          <b>変更 {total} か所</b>
          <span className="faint">（料率 {counts.rate}・取り分 {counts.shares}・取引モデル名 {counts.name}・クレジット {counts.credit}）</span>
          {touchesEconomics && (
            <label className="row" style={{ gap: 6 }}>料率・取り分の当て方
              <select value={mode} onChange={(e) => { setMode(e.target.value as "revise" | "correct"); setPreview(null); }}>
                <option value="revise">改訂する（適用日から新しい版。旧版と文書はそのまま）</option>
                <option value="correct">訂正する（その場で直す。最初から間違っていたとき）</option>
              </select>
              {mode === "revise" && <>適用日 <input type="date" value={effectiveFrom} onChange={(e) => { setEffectiveFrom(e.target.value); setPreview(null); }} />
                <span className="faint">{effectiveFrom ? "" : "空なら今日"}</span></>}
            </label>
          )}
          {counts.credit > 0 && (
            <label className="row" style={{ gap: 6 }}>クレジットの適用開始日
              <input type="date" value={creditFrom} onChange={(e) => { setCreditFrom(e.target.value); setPreview(null); }} /></label>
          )}
          <label className="row" style={{ gap: 6, flex: "1 1 280px" }}>理由
            <input value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }}
                   placeholder="例：2027年1月からの料率改定（覚書 2026-12-10）" aria-label="変更理由" /></label>
          <button className="btn" disabled={busy || !total} onClick={() => void run(true)}>確かめる</button>
          <button className="btn primary" disabled={busy || !total || !reason.trim() || !preview || !preview.items.every((i) => i.ok)}
                  title={!preview ? "先に「確かめる」で結果を見てください" : undefined}
                  onClick={() => void run(false)}>{busy ? "変更しています…" : "この内容で変更する"}</button>
        </div>
      )}
    </div>
  );
}

function TextEditor({ initial, onDone, width, placeholder }: {
  initial: string; onDone: (value: string | null) => void; width?: number; placeholder?: string;
}) {
  const [v, setV] = useState(initial);
  return (
    <span className="mx-edit">
      <input autoFocus value={v} style={{ width: width ?? 220 }} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter") onDone(v); if (e.key === "Escape") onDone(null); }} />
      <button className="btn btn-sm primary" onClick={() => onDone(v)}>入れる</button>
      <button className="btn btn-sm" onClick={() => onDone(null)}>やめる</button>
    </span>
  );
}

/** 料率。同じ取引モデルの表示中の行にもまとめて入れられる。 */
function RateEditor({ cond, initial, conds, onDone }: {
  cond: MatrixCondition; initial: number | null; conds: MatrixCondition[];
  onDone: (ppm: number | null, ids: number[]) => void;
}) {
  const [v, setV] = useState(initial === null ? "" : String(Number((initial / 10_000).toFixed(4))));
  const [all, setAll] = useState(false);
  const same = conds.filter((c) => c.id !== cond.id && c.usageType === cond.usageType && c.direction === cond.direction
    && c.pricingModel === "revenue_rate");
  const ppm = toPpm(v);
  const done = () => onDone(ppm, [cond.id, ...(all ? same.map((c) => c.id) : [])]);
  return (
    <span className="mx-edit mx-pop">
      <span><input autoFocus value={v} style={{ width: 80 }} onChange={(e) => setV(e.target.value)} aria-label="料率（%）"
                   onKeyDown={(e) => { if (e.key === "Enter" && ppm !== null) done(); if (e.key === "Escape") onDone(null, []); }} /> %
        <span className="faint">（いま {pct(cond.ratePpm)}）</span></span>
      {same.length > 0 && (
        <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          表示中の「{USAGE_LABEL[cond.usageType ?? ""] ?? "同じ取引モデル"}」{same.length} 本にも入れる</label>
      )}
      {ppm === null && v.trim() && <span style={{ color: "var(--out)" }}>0〜100 の数で</span>}
      <span><button className="btn btn-sm primary" disabled={ppm === null} onClick={done}>入れる</button>
        <button className="btn btn-sm" onClick={() => onDone(null, [])}>やめる</button></span>
    </span>
  );
}

/** 共著者と取り分。共著者（取引先）を足す・外す、％と表記を入れる。同じ作品のほかの料率の条件にも入れられる。 */
function SharesEditor({ cond, initial, conds, ratePpm, onDone }: {
  cond: MatrixCondition; initial: ShareEdit[]; conds: MatrixCondition[];
  /** 条件の料率（表で直していれば直した値）。実質料率で入れるときの割る数。 */
  ratePpm: number | null;
  onDone: (list: ShareEdit[] | null, ids: number[]) => void;
}) {
  const rate = ratePpm && ratePpm > 0 ? ratePpm : null;
  const num = (ppm: number) => String(Number((ppm / 10_000).toFixed(4)));
  // 取り分がまだ無い条件は、相手先 100% から始める（共著者を足して分ける）。
  const start: ShareEdit[] = initial.length || !cond.counterpartyId ? initial
    : [{ partyId: cond.counterpartyId, partyName: cond.counterpartyName ?? `#${cond.counterpartyId}`, sharePpm: 1_000_000, note: null }];
  // 1 行ずつ、取り分（100 分率）と実質料率のどちらで入れたかを持つ。打った方が正で、もう片方は計算して見せる。
  type Line = ShareEdit & { share: string; eff: string; by: "share" | "eff" };
  const [rows, setRows] = useState<Line[]>(start.map((s) => ({
    ...s, share: num(s.sharePpm), eff: rate ? num(Math.round((rate * s.sharePpm) / 1_000_000)) : "", by: "share"
  })));
  const [adding, setAdding] = useState("");
  const [toWork, setToWork] = useState(true);
  const siblings = conds.filter((c) => c.id !== cond.id && c.workId === cond.workId && c.direction === "in" && c.pricingModel === "revenue_rate");

  // 取り分（百万分率）。実質料率で入れた行は 料率で割る。端数のずれだけなら合計を 100% にそろえる。
  const raw = rows.map((r) => {
    if (r.by === "eff" && rate) { const e = toPpm(r.eff); return e === null ? 0 : (e / rate) * 1_000_000; }
    return toPpm(r.share) ?? 0;
  });
  const ppm = rows.some((r) => r.by === "eff") && rate
    ? roundToMillion(raw)
    : raw.map((v) => Math.round(v));
  const typed: ShareEdit[] = rows.map((r, i) => ({ partyId: r.partyId, partyName: r.partyName, sharePpm: ppm[i]!, note: r.note?.trim() || null }));
  // 相手先 1 人の 100% だけなら、取り分なし（相手先に全額）と同じ。取り分の行は作らない。
  const list: ShareEdit[] = typed.length === 1 && typed[0]!.partyId === cond.counterpartyId && typed[0]!.sharePpm === 1_000_000 && !typed[0]!.note
    ? [] : typed;
  const sum = typed.reduce((n, s) => n + s.sharePpm, 0);
  const effSum = rate ? typed.reduce((n, s) => n + (rate * s.sharePpm) / 1_000_000, 0) : 0;
  const ok = !typed.length || (sum === 1_000_000 && typed.every((s) => s.sharePpm > 0) && new Set(typed.map((s) => s.partyId)).size === typed.length);

  const setShare = (i: number, v: string) => setRows((x) => x.map((y, j) => {
    if (j !== i) return y;
    const p = toPpm(v);
    return { ...y, share: v, by: "share", eff: rate && p !== null ? num(Math.round((rate * p) / 1_000_000)) : y.eff };
  }));
  const setEff = (i: number, v: string) => setRows((x) => x.map((y, j) => {
    if (j !== i) return y;
    const e = toPpm(v);
    return { ...y, eff: v, by: "eff", share: rate && e !== null ? num(sharePpmFromEffective([e], rate)[0]!) : y.share };
  }));

  return (
    <div className="mx-edit mx-pop mx-shares">
      <div className="faint">条件の料率 {rate ? <b>{pct(rate)}</b> : "—"}。取り分（100 分率）か実質料率（料率 × 取り分）のどちらかを入れる</div>
      <table>
        <thead><tr><th>共著者</th><th>取り分（100 分率）</th><th>実質料率</th><th>表記</th><th></th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.partyId}>
              <td>{r.partyName}</td>
              <td><input value={r.by === "share" ? r.share : num(ppm[i]!)} style={{ width: 76 }} aria-label={`${r.partyName} の取り分（%）`}
                         className={r.by === "eff" ? "mx-derived" : undefined} onChange={(e) => setShare(i, e.target.value)} /> %</td>
              <td>{rate
                ? <><input value={r.eff} style={{ width: 64 }} aria-label={`${r.partyName} の実質料率（%）`}
                           className={r.by === "share" ? "mx-derived" : undefined} onChange={(e) => setEff(i, e.target.value)} /> %</>
                : <span className="faint">料率なし</span>}</td>
              <td><input value={r.note ?? ""} style={{ width: 120 }} placeholder="例：原案" aria-label={`${r.partyName} の表記`}
                         onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, note: e.target.value } : y)))} /></td>
              <td><button className="linky" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} title="外す">×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ gap: 6 }}>
        <span style={{ minWidth: 240 }}>
          <SearchSelect value={adding} search={searchParties} placeholder="＋ 共著者を足す（取引先を探す）"
            onChange={(v, opt) => {
              const id = Number(v);
              if (id && !rows.some((r) => r.partyId === id)) {
                setRows((x) => [...x, { partyId: id, partyName: opt?.label ?? `#${id}`, sharePpm: 0, note: null, share: "", eff: "", by: "share" }]);
              }
              setAdding("");
            }} />
        </span>
        <span className={ok ? "faint" : ""} style={ok ? undefined : { color: "var(--out)" }}>
          取り分の合計 {pct(sum)}{rate ? `・実質料率の合計 ${pct(Math.round(effSum))}` : ""}
          {typed.length ? (ok ? " ✓" : rate ? `（取り分は 100%、実質料率は ${pct(rate)} にする）` : "（100% にする）") : "（空にすると相手先に全額）"}</span>
      </div>
      {siblings.length > 0 && (
        <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={toWork} onChange={(e) => setToWork(e.target.checked)} />
          この作品のほかの料率の条件（{siblings.length} 本）にも同じ取り分
          <span className="faint">（入るのは取り分の比率。料率が違う条件では実質料率も変わる）</span></label>
      )}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn btn-sm primary" disabled={!ok} onClick={() => onDone(list, [cond.id, ...(toWork ? siblings.map((s) => s.id) : [])])}>入れる</button>
        <button className="btn btn-sm" onClick={() => onDone(null, [])}>やめる</button>
      </div>
    </div>
  );
}
