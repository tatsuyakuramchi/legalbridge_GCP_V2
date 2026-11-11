import { useCallback, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { AgreementDomain } from "../server/agreements/service.js";
import type { ConditionCategory, MapAgreement, MapCondition, MapOrder, MapPayment, MapSettlement, PartyMap } from "../server/agreements/party-map.js";

/**
 * 契約のマッピング（取引先 ⇔ 基本契約 の中心の表示）。
 *
 *   基本契約 → 個別契約（条件書・発注書・単体契約） → 条件明細 → 支払文書（検収書・計算書） → 支払
 *
 * を左から右に並べ、つながりを線で結ぶ。
 *   ・基本契約は ライセンス／業務委託／ハイブリッド（／その他）／基本契約なし に分ける
 *   ・条件明細は ライセンスの明細／業務委託の明細／種類未設定 に分ける（server の conditionCategory）
 *   ・カードを押すと、つながっている元と先が光る（ほかは薄くなる）
 *   ・個別契約のカードを基本契約のカードへ、条件明細のカードを個別契約のカードへドラッグして付け替える
 *     （サーバの口はこれまでと同じ：demote／promote／親の付け替え／発注書を基本契約の下へ／条件の割り当て）
 */

export type Cat = "lic" | "svc" | "hyb" | "unset" | "other" | "none";
const CAT_OF_DOMAIN = (d: AgreementDomain | null): Cat =>
  d === "license" ? "lic" : d === "service" ? "svc" : d === "hybrid" ? "hyb" : d ? "other" : "none";
export const CAT_OF_COND: Record<ConditionCategory, Cat> = { license: "lic", service: "svc", unset: "unset" };
export const MASTER_SECTIONS: Array<[Cat, string]> = [["lic", "ライセンス"], ["svc", "業務委託"], ["hyb", "ハイブリッド"], ["other", "その他の種別"]];
const COND_SECTIONS: Array<[Cat, string]> = [["lic", "ライセンスの明細"], ["svc", "業務委託の明細"], ["unset", "種類未設定"]];
export const PAY_STATUS: Record<string, string> = { planned: "支払予定", approved: "承認済", paid: "支払済" };
/** 1 つの個別契約の条件がこれより多ければ、先頭だけ出して残りを畳む。 */
const FOLD_OVER = 10;
const FOLD_SHOW = 6;

interface Node {
  id: string;
  cls: string;
  tag?: { text: string; cls: string };
  no?: string | null;
  title?: string;
  meta?: string;
  right?: string;
  warn?: string | null;
  badge?: { text: string; cls: string } | null;
  open?: () => void;
  /** ドラッグして動かせる（動かす先の判定と処理）。 */
  drag?: "contract" | "condition";
  fold?: string;
}
type Item = { sec: string; label: string; cls: string; count?: number } | { node: Node };

const no = (a: { agreementNo: string | null; id: number }) => a.agreementNo ?? `#${a.id}`;
export const condTerms = (c: MapCondition) =>
  c.ratePpm ? `${Number((c.ratePpm / 10000).toFixed(3))}%` : c.flatAmount !== null ? money(c.flatAmount, c.currency) : "";

export function ContractFlow(
  { map, onOpen, onChanged, onError }: {
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  openRef.current = onOpen;
  const [catFilter, setCatFilter] = useState<"all" | "lic" | "svc" | "unset">("all");
  const [show, setShow] = useState<"all" | "loose" | "unsettled">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const model = useMemo(() => buildContractModel(map), [map]);

  // ---- 絞り込み ----
  const view = useMemo(() => {
    const settledConds = new Set(model.settlements.flatMap((s) => s.conditionIds));
    const conds = model.conds.filter((c) => (catFilter === "all" || CAT_OF_COND[c.category] === catFilter)
      && (show !== "loose" || model.condHolder(c) === "loose")
      && (show !== "unsettled" || !settledConds.has(c.id)));
    const condIds = new Set(conds.map((c) => c.id));
    const filtering = catFilter !== "all" || show !== "all";
    const contractNodes = model.contracts.filter((k) => !filtering || conds.some((c) => model.condHolder(c) === k.id)
      || (show === "loose" && k.warn));
    const contractIds = new Set(contractNodes.map((k) => k.id));
    const masterIds = new Set(model.contracts.filter((k) => contractIds.has(k.id)).map((k) => model.parentOf.get(k.id)));
    const masters = model.masters.filter((m) => !filtering || masterIds.has(m.node.id));
    const settlements = model.settlements.filter((s) => s.conditionIds.some((id) => condIds.has(id)));
    const sIds = new Set(settlements.map((s) => s.id));
    const payments = model.payments.filter((p) => p.documentIds.some((id) => sIds.has(id))
      || p.conditionIds.some((id) => condIds.has(id)));
    return { conds, contractNodes, masters, settlements, payments, filtering };
  }, [model, catFilter, show]);

  // ---- 列を組む ----
  const columns = useMemo(() => {
    const colM: Item[] = [], colA: Item[] = [], colC: Item[] = [], colS: Item[] = [], colP: Item[] = [];
    const edges: Array<[string, string]> = [];
    // 基本契約
    for (const [cat, label] of MASTER_SECTIONS) {
      const list = view.masters.filter((m) => m.cat === cat);
      if (!list.length && (view.filtering || cat === "other")) continue;
      colM.push({ sec: `m-${cat}`, label, cls: cat, count: list.length });
      if (!list.length) colM.push({ node: { id: `m-empty-${cat}`, cls: "empty", title: `（${label}の基本契約なし）` } });
      for (const m of list) colM.push({ node: m.node });
    }
    if (!view.filtering || view.contractNodes.some((k) => model.parentOf.get(k.id) === "none")) {
      colM.push({ sec: "m-none", label: "基本契約なし", cls: "none" });
      colM.push({ node: model.nodeOf("none")! });
    }
    // 個別契約：基本契約の並び順
    const mOrder = colM.flatMap((x) => ("node" in x ? [x.node.id] : []));
    const rank = (id: string) => { const i = mOrder.indexOf(model.parentOf.get(id) ?? ""); return i < 0 ? 999 : i; };
    const contracts = [...view.contractNodes].sort((a, b) => rank(a.id) - rank(b.id));
    for (const k of contracts) {
      colA.push({ node: k });
      const p = model.parentOf.get(k.id);
      if (p && mOrder.includes(p)) edges.push([p, k.id]);
    }
    // 条件明細：分類 → 個別契約の並び。多ければ畳む。
    const aOrder = contracts.map((k) => k.id);
    const condNode = new Map<number, string>();
    for (const [cat, label] of COND_SECTIONS) {
      if (catFilter !== "all" && catFilter !== cat) continue;
      const list = view.conds.filter((c) => CAT_OF_COND[c.category] === cat);
      if (!list.length && (view.filtering || cat === "unset")) continue;
      colC.push({ sec: `c-${cat}`, label, cls: cat, count: list.length });
      if (!list.length) { colC.push({ node: { id: `c-empty-${cat}`, cls: "empty", title: "（なし）" } }); continue; }
      for (const holder of aOrder) {
        const mine = list.filter((c) => model.condHolder(c) === holder);
        if (!mine.length) continue;
        const foldKey = `${cat}:${holder}`;
        const fold = mine.length > FOLD_OVER && !open.has(foldKey);
        const shown = fold ? mine.slice(0, FOLD_SHOW) : mine;
        for (const c of shown) {
          const id = `c${c.id}`;
          condNode.set(c.id, id);
          colC.push({ node: model.condNodes.get(c.id)! });
          edges.push([holder, id]);
        }
        if (mine.length > FOLD_OVER) {
          const fid = `fold-${foldKey}`;
          for (const c of mine.slice(shown.length)) condNode.set(c.id, fid);
          colC.push({ node: { id: fid, cls: "fold", fold: foldKey, title: fold ? `ほか ${mine.length - shown.length} 件を開く` : "畳む" } });
          if (fold) edges.push([holder, fid]);
        }
      }
    }
    // 支払文書：つながる条件の並び順
    const cOrder = colC.flatMap((x) => ("node" in x ? [x.node.id] : []));
    const pos = (ids: string[]) => Math.min(999999, ...ids.map((x) => cOrder.indexOf(x)).filter((i) => i >= 0));
    const sNodes = view.settlements
      .map((s) => ({ s, at: pos(s.conditionIds.map((id) => condNode.get(id) ?? "")) }))
      .sort((a, b) => a.at - b.at);
    for (const cat of ["lic", "svc"] as const) {
      const list = sNodes.filter((x) => (x.s.category === "license" ? "lic" : "svc") === cat);
      if (!list.length) continue;
      colS.push({ sec: `s-${cat}`, label: cat === "lic" ? "計算書（ライセンス）" : "検収書など（業務委託）", cls: cat, count: list.length });
      for (const { s } of list) {
        const id = `s${s.id}`;
        colS.push({ node: model.settlementNode(s) });
        for (const cid of new Set(s.conditionIds.map((x) => condNode.get(x)).filter((x): x is string => Boolean(x)))) edges.push([cid, id]);
      }
    }
    // 支払：支払文書（無ければ条件）の並び順
    const sOrder = colS.flatMap((x) => ("node" in x ? [x.node.id] : []));
    const pPos = (p: MapPayment) => {
      const viaDoc = p.documentIds.map((id) => sOrder.indexOf(`s${id}`)).filter((i) => i >= 0);
      return viaDoc.length ? Math.min(...viaDoc) : 1000 + pos(p.conditionIds.map((id) => condNode.get(id) ?? ""));
    };
    for (const p of [...view.payments].sort((a, b) => pPos(a) - pPos(b))) {
      const id = `p${p.id}`;
      colP.push({ node: model.paymentNode(p) });
      const docs = p.documentIds.filter((d) => sOrder.includes(`s${d}`));
      if (docs.length) for (const d of docs) edges.push([`s${d}`, id]);
      else for (const cid of new Set(p.conditionIds.map((x) => condNode.get(x)).filter((x): x is string => Boolean(x)))) edges.push([cid, id]);
    }
    return { cols: [colM, colA, colC, colS, colP], edges };
  }, [view, model, open, catFilter]);

  // ---- 選んだカードのつながり ----
  const related = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    const walk = (dir: 0 | 1) => {
      const stack = [selected];
      while (stack.length) {
        const x = stack.pop()!;
        for (const e of columns.edges) {
          if (e[1 - dir] === x && !set.has(e[dir])) { set.add(e[dir]); stack.push(e[dir]); }
        }
      }
    };
    walk(0); walk(1);
    return set;
  }, [selected, columns]);

  // ---- 線 ----
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Array<{ key: string; d: string; hot: boolean | null }>>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const root = wrap.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const at = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>("[data-node]").forEach((n) => at.set(n.dataset.node!, n.getBoundingClientRect()));
    const out: Array<{ key: string; d: string; hot: boolean | null }> = [];
    for (const [a, b] of columns.edges) {
      const ra = at.get(a), rb = at.get(b);
      if (!ra || !rb) continue;
      const x1 = ra.right - box.left, y1 = ra.top + ra.height / 2 - box.top;
      const x2 = rb.left - box.left, y2 = rb.top + rb.height / 2 - box.top;
      const mx = (x1 + x2) / 2;
      out.push({ key: `${a}>${b}`, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
                 hot: related ? related.has(a) && related.has(b) : null });
    }
    setLines(out);
    setSize({ w: root.scrollWidth, h: root.scrollHeight });
  }, [columns, related]);
  useLayoutEffect(() => {
    measure();
    const root = wrap.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  // ---- 付け替え ----
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dropReason = (from: string, to: string): string | null => {
    const src = model.nodeOf(from), dst = model.nodeOf(to);
    if (!src || !dst) return "動かせません";
    if (src.drag === "contract") {
      if (!(to === "none" || to.startsWith("m"))) return "個別契約は基本契約へ動かします";
      if (model.parentOf.get(from) === to) return "いまここにあります";
      return model.canPutContract(from, to);
    }
    if (src.drag === "condition") {
      if (!(to.startsWith("a") || to.startsWith("o") || to === "loose")) return "条件明細は個別契約へ動かします";
      const c = model.condById(from);
      if (c && model.condHolder(c) === to) return "いまここにあります";
      return model.canPutCondition(from, to);
    }
    return "動かせません";
  };
  async function drop(from: string, to: string) {
    const why = dropReason(from, to);
    if (why) { if (why !== "いまここにあります") onError(why); return; }
    setBusy(true);
    try { onChanged(await model.move(from, to)); setSelected(null); }
    catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  // ---- 表示 ----
  const pathText = useMemo(() => {
    if (!related) return null;
    const pick = (col: Item[]) => col.flatMap((x) => ("node" in x && related.has(x.node.id) && x.node.no ? [x.node.no] : []));
    const names = ["基本契約", "個別契約", "条件明細", "支払文書", "支払"];
    return columns.cols.map((col, i) => {
      const v = pick(col);
      return { k: names[i]!, v: v.length > 4 ? `${v.slice(0, 4).join("・")} ほか ${v.length - 4}` : v.join("・") || "なし" };
    });
  }, [related, columns]);

  const heads = ["基本契約", "個別契約", "条件明細", "支払文書", "支払"];
  const counts = [
    view.masters.length, view.contractNodes.filter((k) => k.id !== "loose").length, view.conds.length,
    view.settlements.length, view.payments.length
  ];
  const units = ["本", "本", "本", "枚", "件"];

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="faint">種別</span>
        <div className="chips" role="group" aria-label="種別で絞る">
          {([["all", "すべて"], ["lic", "ライセンス"], ["svc", "業務委託"], ["unset", "種類未設定"]] as const).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={catFilter === k} onClick={() => { setCatFilter(k); setSelected(null); }}>{l}</button>
          ))}
        </div>
        <span className="faint">絞り込み</span>
        <div className="chips" role="group" aria-label="絞り込み">
          {([["all", "すべて"], ["loose", "持ち主なし・ずれ"], ["unsettled", "支払文書のない条件"]] as const).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={show === k} onClick={() => { setShow(k); setSelected(null); }}>{l}</button>
          ))}
        </div>
        {busy && <span className="faint">付け替えています…</span>}
        <span className="faint" style={{ marginLeft: "auto" }}>
          {readOnly ? "読み取り専用です" : "条件明細 → 個別契約へ、個別契約 → 基本契約へドラッグして付け替え"}
        </span>
      </div>

      <div className="cf-scroll">
        <div className="cf-flow" ref={wrap}>
          <svg className="cf-lines" width={size.w} height={size.h} aria-hidden="true">
            {lines.map((l) => <path key={l.key} d={l.d} className={l.hot === null ? undefined : l.hot ? "hot" : "cold"} />)}
          </svg>
          {columns.cols.map((col, i) => (
            <div key={i} className="cf-col">
              <div className="cf-head">{heads[i]} <span className="faint">{counts[i]} {units[i]}</span></div>
              {col.map((x) => "sec" in x
                ? <div key={x.sec} className={`cf-sec ${x.cls}`}>{x.label}{x.count !== undefined && <span className="faint">{x.count}</span>}</div>
                : <FlowCard key={x.node.id} n={x.node} sel={selected === x.node.id} dim={Boolean(related && !related.has(x.node.id))}
                    over={over === x.node.id}
                    draggable={!readOnly && !busy && Boolean(x.node.drag)}
                    onClick={() => {
                      if (x.node.fold) { setOpen((s) => { const n = new Set(s); if (n.has(x.node.fold!)) n.delete(x.node.fold!); else n.add(x.node.fold!); return n; }); return; }
                      if (x.node.cls === "empty") return;
                      setSelected((s) => (s === x.node.id ? null : x.node.id));
                    }}
                    onDragStart={(e) => { setDragging(x.node.id); e.dataTransfer.setData("text/plain", x.node.id); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    onDragOver={(e) => {
                      if (!dragging || readOnly || busy || dragging === x.node.id) return;
                      const why = dropReason(dragging, x.node.id);
                      if (why === null) { e.preventDefault(); setOver(x.node.id); }
                    }}
                    onDragLeave={() => setOver((o) => (o === x.node.id ? null : o))}
                    onDrop={(e) => { e.preventDefault(); setOver(null); const from = e.dataTransfer.getData("text/plain") || dragging; setDragging(null); if (from) void drop(from, x.node.id); }} />)}
            </div>
          ))}
        </div>
      </div>

      <div className="cf-path">
        {pathText
          ? pathText.map((p, i) => <span key={p.k}>{i > 0 && " › "}<b>{p.k}</b> {p.v}</span>)
          : <span className="faint">カードを押すと、つながっている元と先が光り、ここに「基本契約 › 個別契約 › 条件明細 › 支払文書 › 支払」が出ます。</span>}
      </div>
      <div className="row faint" style={{ gap: 14, flexWrap: "wrap", fontSize: 12 }}>
        <span><span className="tag cf-tag lic">ライセンス</span> 許諾料の明細・条件書・計算書</span>
        <span><span className="tag cf-tag svc">業務委託</span> 委託料・実費・手数料・製品（OEM）の明細・発注書・検収書</span>
        <span><span className="tag cf-tag hyb">ハイブリッド</span> 両方の個別契約を持てる基本契約</span>
        <span><span className="tag cf-tag unset">種類未設定</span> 名前の無い条件（中身を入れると振り分け）</span>
      </div>
    </div>
  );
}

function FlowCard({ n, sel, dim, over, draggable, onClick, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }: {
  n: Node; sel: boolean; dim: boolean; over: boolean; draggable: boolean;
  onClick: () => void;
  onDragStart: (e: DragEvent) => void; onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void;
}) {
  return (
    <div data-node={n.id} role="button" tabIndex={0}
         className={`cf-card ${n.cls}${sel ? " sel" : ""}${dim ? " dim" : ""}${over ? " over" : ""}`}
         draggable={draggable} onClick={onClick}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
         onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {(n.tag || n.no || n.right || n.badge) && (
        <div className="cf-top">
          {n.tag && <span className={`tag cf-tag ${n.tag.cls}`}>{n.tag.text}</span>}
          {n.no && (n.open
            ? <button className="linky code" onClick={(e) => { e.stopPropagation(); n.open!(); }}>{n.no}</button>
            : <span className="code">{n.no}</span>)}
          {n.badge && <span className={`tag ${n.badge.cls}`}>{n.badge.text}</span>}
          {n.right && <span className="cf-right">{n.right}</span>}
        </div>
      )}
      {n.title && <div className="cf-title">{n.title}</div>}
      {n.meta && <div className="cf-meta">{n.meta}</div>}
      {n.warn && <div className="amap-issue">{n.warn}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// データ → ノード・つながり・付け替え
// ---------------------------------------------------------------------------

/** データ → ノード・つながり・付け替え。表（ContractTable.tsx）も使う。 */
export function buildContractModel(map: PartyMap) {
  const orders = map.orders ?? [];
  const conds = map.conditions ?? [];
  const settlements = map.settlements ?? [];
  const payments = map.payments ?? [];
  const masters = map.roots.filter((r) => r.kind === "master")
    .sort((a, b) => Number(Boolean(a.terminatedOn)) - Number(Boolean(b.terminatedOn)) || a.id - b.id);
  const masterIds = new Set(masters.map((m) => m.id));
  const nodes = new Map<string, Node>();
  const parentOf = new Map<string, string>();
  /** 契約（agreements.id）→ 個別契約の列のノード。発注書の器は発注書のノード。 */
  const holderOfAgreement = new Map<number, string>();
  const catOf = new Map<string, Cat>();
  const agreementIdOf = new Map<string, number | null>();
  const contracts: Node[] = [];

  const condCats = (agreementId: number) => new Set(conds.filter((c) => c.agreementId === agreementId).map((c) => CAT_OF_COND[c.category]));
  const contractCat = (a: MapAgreement): Cat => {
    const d = CAT_OF_DOMAIN(a.domain);
    if (d === "lic" || d === "svc" || d === "hyb") return d;
    const cs = condCats(a.id);
    return cs.has("lic") && cs.has("svc") ? "hyb" : cs.has("lic") ? "lic" : cs.has("svc") ? "svc" : "none";
  };
  const TAG: Record<Cat, string> = { lic: "ライセンス", svc: "業務委託", hyb: "ハイブリッド", unset: "種類未設定", other: "その他", none: "" };

  const masterNodes = masters.map((m) => {
    const cat = CAT_OF_DOMAIN(m.domain);
    const node: Node = {
      id: `m${m.id}`, cls: `master ${cat}`, tag: { text: TAG[cat] || "種別なし", cls: cat }, no: no(m), title: m.title,
      meta: [m.direction === "in" ? "IN" : m.direction === "out" ? "OUT" : null, m.executedOn ? `${m.executedOn} 締結` : "未締結",
             m.terminatedOn ? `解除 ${m.terminatedOn}` : null].filter(Boolean).join("・"),
      warn: m.conditionCount > 0 ? `基本契約に直付けの条件 ${m.conditionCount}（条件明細を個別契約へ）` : null
    };
    nodes.set(node.id, node); catOf.set(node.id, cat);
    return { node, cat: (cat === "none" ? "other" : cat) as Cat, master: m };
  });
  nodes.set("none", { id: "none", cls: "none", no: "基本契約なし", title: "単体契約・発注書の約款で取引" });

  const KIND_TAG: Record<string, string> = { standalone: "単体契約", supplement: "個別契約", termination: "解除合意", document: "文書だけ" };
  const addAgreement = (a: MapAgreement, parent: string, warn: string | null) => {
    const cat = contractCat(a);
    const isTerms = cat === "lic" && a.kind === "supplement";
    const node: Node = {
      id: `a${a.id}`, cls: cat, tag: { text: isTerms ? "条件書" : KIND_TAG[a.kind] ?? a.kind, cls: cat },
      no: no(a), title: a.title, meta: `条件 ${a.conditionCount}・文書 ${a.documentCount}`, warn, drag: "contract",
      open: undefined
    };
    nodes.set(node.id, node); parentOf.set(node.id, parent); catOf.set(node.id, cat);
    holderOfAgreement.set(a.id, node.id); agreementIdOf.set(node.id, a.id);
    contracts.push(node);
    return node;
  };
  const addOrder = (o: MapOrder, parent: string) => {
    const node: Node = {
      id: `o${o.id}`, cls: "svc", tag: { text: o.imported ? "発注書（取込）" : "発注書", cls: "svc" },
      no: o.documentNo ?? `#${o.id}`, title: o.title ?? "", meta: `条件 ${o.conditions.length}${o.issuedOn ? `・${o.issuedOn}` : ""}`,
      warn: o.agreementId ? null : "器がありません（決定前・取込の発注書。条件の付け替えは「検索して紐づける」で）",
      drag: "contract"
    };
    nodes.set(node.id, node); parentOf.set(node.id, parent); catOf.set(node.id, "svc");
    if (o.agreementId) holderOfAgreement.set(o.agreementId, node.id);
    agreementIdOf.set(node.id, o.agreementId);
    contracts.push(node);
  };
  for (const m of masters) {
    const root = map.roots.find((r) => r.id === m.id)!;
    for (const c of root.children) addAgreement(c, `m${m.id}`, null);
    for (const o of orders.filter((x) => x.masterId === m.id)) addOrder(o, `m${m.id}`);
  }
  for (const r of map.roots.filter((x) => x.kind === "standalone")) {
    addAgreement(r, "none", null);
    for (const c of r.children) addAgreement(c, "none", `単体契約 ${no(r)} の下`);
  }
  for (const a of map.loose) addAgreement(a, "none", "親が無い・親が基本契約でない（基本契約へドラッグ）");
  for (const o of orders.filter((x) => x.masterId === null)) addOrder(o, "none");
  const loose: Node = { id: "loose", cls: "loose", title: "どの個別契約にも載っていない条件明細", no: "契約に載っていない" };
  nodes.set("loose", loose); agreementIdOf.set("loose", null);

  const condHolder = (c: MapCondition): string =>
    c.agreementId !== null && !masterIds.has(c.agreementId) ? holderOfAgreement.get(c.agreementId) ?? "loose" : "loose";
  const condNodes = new Map<number, Node>();
  for (const c of conds) {
    const cat = CAT_OF_COND[c.category];
    const onMaster = c.agreementId !== null && masterIds.has(c.agreementId);
    const node: Node = {
      id: `c${c.id}`, cls: cat, no: c.conditionNo ?? `#${c.id}`, right: condTerms(c),
      title: c.name || "（無題の条件）",
      meta: c.workTitle && !c.name.includes(c.workTitle) ? c.workTitle : undefined,
      badge: condHolder(c) === "loose" ? { text: onMaster ? "基本契約に直付け" : "持ち主なし", cls: "warn" } : null,
      drag: "condition"
    };
    node.open = undefined;
    nodes.set(node.id, node); condNodes.set(c.id, node); catOf.set(node.id, cat);
  }
  if (conds.some((c) => condHolder(c) === "loose")) {
    loose.badge = { text: `${conds.filter((c) => condHolder(c) === "loose").length} 本`, cls: "warn" };
    contracts.push(loose); parentOf.set("loose", "");
  }

  const settlementNode = (s: MapSettlement): Node => {
    const cat: Cat = s.category === "license" ? "lic" : "svc";
    const node: Node = {
      id: `s${s.id}`, cls: cat, tag: { text: /royalty|statement/.test(s.templateKey) ? "計算書" : s.label.replace(/（.*$/, ""), cls: cat },
      no: s.documentNo ?? "（下書き）", meta: `${s.issuedOn ?? "未決定"}・条件 ${s.conditionIds.length}`,
      badge: s.status === "draft" ? { text: "下書き", cls: "" } : null,
      open: () => openRef.current?.("document", s.id)
    };
    nodes.set(node.id, node);
    return node;
  };
  const paymentNode = (p: MapPayment): Node => {
    const node: Node = {
      id: `p${p.id}`, cls: p.status === "paid" ? "paid" : "", no: p.paymentNo ?? `#${p.id}`, right: money(p.amount, p.currency),
      meta: p.paidOn ? `${p.paidOn} 支払` : p.dueOn ? `${p.dueOn} 期日` : "期日なし",
      badge: { text: PAY_STATUS[p.status] ?? p.status, cls: p.status === "paid" ? "ok" : p.status === "approved" ? "" : "warn" }
    };
    nodes.set(node.id, node);
    return node;
  };
  // 開くリンクは描画のたびに作らない（ノードに付けておく）。
  // 基本契約・個別契約の番号は、いま有効な文書の画面（送る・訂正などのある画面）を開く。文書が無ければ契約の画面。
  const allAgreements = [...map.roots, ...map.roots.flatMap((r) => r.children), ...map.loose];
  const openAgreementOrDoc = (aid: number) => {
    const d = allAgreements.find((x) => x.id === aid)?.currentDocument;
    return d ? () => openRef.current?.("document", d.id) : () => openRef.current?.("agreement", aid);
  };
  for (const [id, n] of nodes) {
    if (/^m\d+$/.test(id)) n.open = openAgreementOrDoc(Number(id.slice(1)));
    if (/^a\d+$/.test(id)) n.open = openAgreementOrDoc(Number(id.slice(1)));
    if (id.startsWith("o")) { const did = Number(id.slice(1)); n.open = () => openRef.current?.("document", did); }
    if (id.startsWith("c")) { const cid = Number(id.slice(1)); n.open = () => openRef.current?.("condition", cid); }
  }

  const condById = (id: string) => conds.find((c) => `c${c.id}` === id);
  const canPutContract = (from: string, to: string): string | null => {
    const src = catOf.get(from) ?? "none";
    if (to === "none") {
      const a = map.roots.flatMap((r) => [r, ...r.children]).concat(map.loose).find((x) => `a${x.id}` === from);
      if (a?.kind === "termination") return "解除合意は基本契約の下にだけ置けます";
      if (from.startsWith("o") && !agreementIdOf.get(from)) return "器のない発注書は基本契約から外せません";
      return null;
    }
    const m = masters.find((x) => `m${x.id}` === to);
    if (!m) return "基本契約が見つかりません";
    const dst = CAT_OF_DOMAIN(m.domain);
    if (dst !== "hyb" && dst !== "none" && dst !== "other" && (src === "lic" || src === "svc") && src !== dst) {
      return `${src === "lic" ? "ライセンス" : "業務委託"}の個別契約は、${dst === "lic" ? "ライセンス" : "業務委託"}の基本契約の下には入れられません（ハイブリッドなら入れられます）`;
    }
    const a = map.roots.flatMap((r) => [r, ...r.children]).concat(map.loose).find((x) => `a${x.id}` === from);
    if (a && m.direction && a.direction && m.direction !== a.direction) return "基本契約と向き（IN／OUT）が違います";
    if (a?.kind === "standalone" && m.terminatedOn) return "解除済みの基本契約の下には入れられません";
    if (from.startsWith("o")) {
      const o = orders.find((x) => `o${x.id}` === from);
      if (o && !o.conditions.length) return "先に条件明細を紐づけてください";
    }
    return null;
  };
  const canPutCondition = (from: string, to: string): string | null => {
    if (to === "loose") return null;
    const aid = agreementIdOf.get(to);
    if (!aid) return "器のない発注書には載せられません（「検索して紐づける」で）";
    const c = condById(from);
    const dst = catOf.get(to);
    const cat = c ? CAT_OF_COND[c.category] : "unset";
    if ((cat === "lic" || cat === "svc") && (dst === "lic" || dst === "svc") && cat !== dst) {
      return `${cat === "lic" ? "ライセンス" : "業務委託"}の明細は、${dst === "lic" ? "条件書（ライセンス）" : "発注書（業務委託）"}には載せられません`;
    }
    return null;
  };
  const move = async (from: string, to: string): Promise<string> => {
    const name = (id: string) => nodes.get(id)?.no ?? id;
    if (from.startsWith("c")) {
      const cid = Number(from.slice(1));
      const aid = to === "loose" ? null : agreementIdOf.get(to) ?? null;
      await api.post("/agreement-map/conditions/assign", { conditionIds: [cid], agreementId: aid });
      return aid === null ? `${name(from)} を契約から外しました` : `${name(from)} を ${name(to)} に載せました`;
    }
    if (from.startsWith("o")) {
      const did = Number(from.slice(1));
      if (to === "none") {
        await api.patch(`/agreement-map/agreements/${agreementIdOf.get(from)}`, { kind: "standalone", parentId: null });
        return `${name(from)} を基本契約なし（発注書の約款）にしました`;
      }
      await api.post(`/agreement-map/orders/${did}/master`, { agreementId: Number(to.slice(1)) });
      return `${name(from)} を ${name(to)} の下の発注書にしました`;
    }
    const aid = Number(from.slice(1));
    const a = map.roots.flatMap((r) => [r, ...r.children]).concat(map.loose).find((x) => x.id === aid);
    if (to === "none") {
      await api.post(`/agreement-map/agreements/${aid}/promote`, {});
      return `${name(from)} を単体契約にしました`;
    }
    const mid = Number(to.slice(1));
    if (a?.kind === "standalone") await api.post(`/agreement-map/agreements/${aid}/demote`, { masterId: mid });
    else await api.patch(`/agreement-map/agreements/${aid}`, { parentId: mid });
    return `${name(from)} を ${name(to)} の下にしました`;
  };

  return {
    masters: masterNodes, contracts, conds, condNodes, settlements, payments, parentOf,
    condHolder, condById, settlementNode, paymentNode, canPutContract, canPutCondition, move,
    nodeOf: (id: string) => nodes.get(id),
    agreementIdOf: (id: string) => agreementIdOf.get(id) ?? null,
    catOf: (id: string) => catOf.get(id) ?? null
  };
}

/** 開く口。描画のたびに変わる onOpen を、作り置きのノード（build）から呼ぶ。 */
const openRef: { current: ((kind: EntityKind, id: number) => void) | undefined } = { current: undefined };
/** 表（ContractTable）など、ContractFlow を描かずに buildContractModel のノードを使う画面が開く口を渡す。 */
export function setContractOpener(onOpen: ((kind: EntityKind, id: number) => void) | undefined) { openRef.current = onOpen; }
