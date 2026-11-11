import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, money } from "./api.js";
import { Modal } from "./Modal.js";
import { DocViewButton } from "./DocPeek.js";
import { useDebounced } from "./ListTools.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { MapCondition, MapPayment, MapSearchItem, MapSearchType, MapSettlement, PartyMap } from "../server/agreements/party-map.js";
import { CAT_OF_COND, MASTER_SECTIONS, PAY_STATUS, buildContractModel, condTerms, type Cat } from "./ContractFlow.js";

/**
 * 契約のマッピング（表）。1 行＝条件明細。基本契約・個別契約の欄は縦に結合し、右に支払文書・支払。
 *
 * 追加・解除は画面を切り替えずにポップアップで行う。ポップアップで作品・取引先・条件名・番号・件名から
 * 探して選ぶ（GET /agreement-map/search）。解除は「付け替え先を選ぶ」か「外すだけ」。
 *   基本契約 ⇔ 個別契約 … 個別契約を基本契約の下へ（demote／親の付け替え／発注書を基本契約の下へ）・基本契約なしへ（promote）
 *   個別契約 ⇔ 条件明細 … 条件を契約に載せる／外す（/agreement-map/conditions/assign）
 *   条件明細 ⇔ 支払文書 … 文書のつながり（/links/condition/:id/documents）。実績で結びついているものは外せない
 *   条件明細 ⇔ 支払     … 支払の割り当て（PUT /payments/:id/allocations。全体を置き換える）
 */

const FOLD_OVER = 10;
const FOLD_SHOW = 6;
const CAT_LABEL: Record<string, string> = { lic: "ライセンス", svc: "業務委託", hyb: "ハイブリッド", unset: "種類未設定", other: "その他", none: "" };

type Dialog =
  | { kind: "contract-add"; to: string; toNo: string }
  | { kind: "contract-move"; from: string; fromNo: string; underMaster: boolean }
  | { kind: "cond-add"; to: string; toNo: string }
  | { kind: "cond-move"; cond: MapCondition; holderNo: string | null }
  | { kind: "doc-add"; cond: MapCondition }
  | { kind: "doc-move"; cond: MapCondition; doc: MapSettlement }
  | { kind: "pay-add"; cond: MapCondition }
  | { kind: "pay-move"; cond: MapCondition; pay: MapPayment; amount: number };

export function ContractTable(
  { map, onOpen, onChanged, onError }: {
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  const model = useMemo(() => buildContractModel(map), [map]);
  const [catFilter, setCatFilter] = useState<"all" | "lic" | "svc" | "unset">("all");
  const [show, setShow] = useState<"all" | "loose" | "unsettled" | "unpaid">("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const settlementsOf = (c: MapCondition) => model.settlements.filter((s) => s.conditionIds.includes(c.id));
  const paymentsOf = (c: MapCondition) => model.payments.filter((p) => p.conditionIds.includes(c.id));
  const allocated = (p: MapPayment, c: MapCondition) => p.allocations.filter((a) => a.conditionId === c.id).reduce((t, a) => t + a.amount, 0);

  const condVisible = (c: MapCondition) => (catFilter === "all" || CAT_OF_COND[c.category] === catFilter)
    && (show !== "loose" || model.condHolder(c) === "loose")
    && (show !== "unsettled" || settlementsOf(c).length === 0)
    && (show !== "unpaid" || !paymentsOf(c).some((p) => p.status === "paid"));
  const filtering = catFilter !== "all" || show !== "all";

  // 行を組む：基本契約（種別ごと） → 個別契約 → 条件明細。
  const groups = useMemo(() => {
    const out: Array<{ key: string; sec: string | null; master: { id: string; no: string; title: string; meta: string; cat: Cat } | null;
                       contracts: Array<{ id: string; conds: MapCondition[]; hidden: number }> }> = [];
    const contractsUnder = (parent: string) => model.contracts.filter((k) => (model.parentOf.get(k.id) ?? "") === parent)
      .map((k) => {
        const all = model.conds.filter((c) => model.condHolder(c) === k.id && condVisible(c));
        const folded = all.length > FOLD_OVER && !open.has(k.id);
        return { id: k.id, conds: folded ? all.slice(0, FOLD_SHOW) : all, hidden: folded ? all.length - FOLD_SHOW : 0, total: all.length };
      })
      .filter((k) => !filtering || k.total > 0);
    for (const [cat, label] of MASTER_SECTIONS) {
      const ms = model.masters.filter((m) => m.cat === cat);
      let first = true;
      for (const m of ms) {
        const contracts = contractsUnder(m.node.id);
        if (filtering && !contracts.length) continue;
        out.push({ key: m.node.id, sec: first ? label : null, contracts,
          master: { id: m.node.id, no: m.node.no ?? "", title: m.node.title ?? "", meta: m.node.meta ?? "", cat: m.cat } });
        first = false;
      }
      if (!ms.length && !filtering && cat !== "other") out.push({ key: `empty-${cat}`, sec: label, master: null, contracts: [] });
    }
    const none = [...contractsUnder("none"), ...contractsUnder("")];
    if (none.length || !filtering) out.push({ key: "none", sec: "基本契約なし", master: null, contracts: none });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, catFilter, show, open]);

  const act = (label: string, onClick: () => void, title?: string) => readOnly ? null : (
    <button className="ct-act" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }}>{label}</button>
  );
  const nodeNo = (id: string) => model.nodeOf(id)?.no ?? "";
  /** 「見る」：基本契約・個別契約はいま有効な文書、発注書はその文書。 */
  const viewOf = (nodeId: string) => {
    if (nodeId.startsWith("o")) {
      const o = (map.orders ?? []).find((x) => `o${x.id}` === nodeId);
      return o ? <DocViewButton id={o.id} documentNo={o.documentNo} imported={o.imported} storageUrl={o.storageUrl} /> : null;
    }
    const aid = Number(nodeId.slice(1));
    if (!/^[am]\d+$/.test(nodeId)) return null;
    const a = [...map.roots, ...map.roots.flatMap((r) => r.children), ...map.loose].find((x) => x.id === aid);
    const d = a?.currentDocument;
    return d ? <DocViewButton id={d.id} documentNo={d.documentNo} imported={d.imported} storageUrl={d.storageUrl} /> : null;
  };

  // ---- 実行（ポップアップで選んだあと） ----
  async function run(work: () => Promise<string>) {
    const msg = await work();
    setDialog(null);
    onChanged(msg);
  }
  const contractFromItem = (it: MapSearchItem) => (it.orderDocumentId ? `o${it.orderDocumentId}` : `a${it.id}`);
  async function moveContracts(items: MapSearchItem[], to: string) {
    const done: string[] = [];
    for (const it of items) {
      const from = contractFromItem(it);
      if (!model.nodeOf(from)) throw new ApiError(400, `${it.code ?? ""} はこの取引先の個別契約として出ていません`, "VALIDATION");
      const why = model.parentOf.get(from) === to ? "いまここにあります" : model.canPutContract(from, to);
      if (why) throw new ApiError(400, `${it.code ?? ""}：${why}`, "VALIDATION");
      done.push(await model.move(from, to));
    }
    return done.join("／");
  }
  async function assignConds(ids: number[], agreementId: number | null, toNo: string) {
    const r = await api.post<{ moved: number }>("/agreement-map/conditions/assign", { conditionIds: ids, agreementId });
    return agreementId === null ? `条件明細 ${r.moved} 本を契約から外しました` : `条件明細 ${r.moved} 本を ${toNo} に載せました`;
  }
  async function putAllocations(paymentId: number, lines: Array<{ conditionId: number; eventId: number | null; amount: number }>) {
    await api.put(`/payments/${paymentId}/allocations`, { lines });
  }
  const addLine = (lines: MapPayment["allocations"], conditionId: number, amount: number) => {
    const same = lines.find((l) => l.conditionId === conditionId && l.eventId === null);
    return same ? lines.map((l) => (l === same ? { ...l, amount: l.amount + amount } : l)) : [...lines, { conditionId, eventId: null, amount }];
  };

  const condRow = (c: MapCondition) => {
    const docs = settlementsOf(c), pays = paymentsOf(c);
    const loose = model.condHolder(c) === "loose";
    return (
      <>
        <td className={`ct-cond ${CAT_OF_COND[c.category]}`}>
          <div className="ct-line">
            <button className="linky code" onClick={() => onOpen?.("condition", c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
            {c.category === "unset" && <span className="tag">種類未設定</span>}
            {loose && <span className="tag warn">持ち主なし</span>}
            <span className="ct-acts">
              {loose
                ? act("契約に載せる", () => setDialog({ kind: "cond-move", cond: c, holderNo: null }))
                : act("解除", () => setDialog({ kind: "cond-move", cond: c, holderNo: nodeNo(model.condHolder(c)) }), "この個別契約から外す・ほかの契約へ付け替える")}
            </span>
          </div>
          <div>{c.name || "（無題の条件）"}</div>
          {c.workTitle && !c.name.includes(c.workTitle) && <div className="faint">{c.workTitle}</div>}
        </td>
        <td className="num">{condTerms(c) || "—"}</td>
        <td>
          {docs.map((s) => (
            <div key={s.id} className="ct-chip">
              <span className="tag">{/royalty|statement/.test(s.templateKey) ? "計算書" : s.label.replace(/（.*$/, "")}</span>
              <button className="linky code" onClick={() => onOpen?.("document", s.id)}>{s.documentNo ?? "（下書き）"}</button>
              <DocViewButton id={s.id} documentNo={s.documentNo} />
              {s.linkedConditionIds.includes(c.id)
                ? act("解除", () => setDialog({ kind: "doc-move", cond: c, doc: s }), "この文書から外す・ほかの文書へ付け替える")
                : <span className="faint" title="実績（納品・売上）でこの文書に結びついています。外すときは実績から">実績で結びつき</span>}
            </div>
          ))}
          {act("＋ 追加", () => setDialog({ kind: "doc-add", cond: c }), "支払文書（検収書・計算書など）を探してつなぐ")}
        </td>
        <td>
          {pays.map((p) => (
            <div key={p.id} className="ct-chip">
              <span className="code">{p.paymentNo ?? `#${p.id}`}</span>
              <span className="num">{money(allocated(p, c), p.currency)}</span>
              <span className={`tag ${p.status === "paid" ? "ok" : p.status === "approved" ? "" : "warn"}`}>{PAY_STATUS[p.status] ?? p.status}</span>
              {act("解除", () => setDialog({ kind: "pay-move", cond: c, pay: p, amount: allocated(p, c) }), "この支払の割り当てから外す・ほかの支払へ付け替える")}
            </div>
          ))}
          {act("＋ 追加", () => setDialog({ kind: "pay-add", cond: c }), "支払を探して、この条件に割り当てる")}
        </td>
      </>
    );
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="faint">種別</span>
        <div className="chips" role="group" aria-label="種別で絞る">
          {([["all", "すべて"], ["lic", "ライセンス"], ["svc", "業務委託"], ["unset", "種類未設定"]] as const).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={catFilter === k} onClick={() => setCatFilter(k)}>{l}</button>
          ))}
        </div>
        <span className="faint">絞り込み</span>
        <div className="chips" role="group" aria-label="絞り込み">
          {([["all", "すべて"], ["loose", "持ち主なし・ずれ"], ["unsettled", "支払文書のない条件"], ["unpaid", "未払いの条件"]] as const).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={show === k} onClick={() => setShow(k)}>{l}</button>
          ))}
        </div>
        {!readOnly && <span className="faint" style={{ marginLeft: "auto" }}>「＋ 追加」「解除」を押すと、探して選ぶ窓が開きます</span>}
      </div>

      <div className="ct-scroll">
        <table className="ct-table">
          <thead>
            <tr><th>基本契約</th><th>個別契約</th><th>条件明細</th><th className="num">料率・額</th><th>支払文書</th><th>支払</th></tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const rows = g.contracts.reduce((t, k) => t + Math.max(k.conds.length, 1) + (k.hidden || open.has(k.id) ? 1 : 0), 0);
              const masterCell = (span: number) => (
                <td className={`ct-master ${g.master?.cat ?? "none"}`} rowSpan={span}>
                  {g.master ? (
                    <>
                      <span className={`tag cf-tag ${g.master.cat}`}>{CAT_LABEL[g.master.cat] || "種別なし"}</span>
                      <div className="ct-line">
                        <button className="linky code" onClick={() => onOpen?.("agreement", Number(g.master!.id.slice(1)))}>{g.master.no}</button>
                        {viewOf(g.master.id)}
                      </div>
                      <div>{g.master.title}</div>
                      <div className="faint">{g.master.meta}</div>
                    </>
                  ) : g.key === "none"
                    ? <div className="faint">単体契約・発注書の約款で取引</div>
                    : <div className="faint">（{g.sec}の基本契約なし）</div>}
                  {(g.master || g.key === "none") && act("＋ 個別契約を追加", () => setDialog({ kind: "contract-add", to: g.master?.id ?? "none", toNo: g.master?.no ?? "基本契約なし" }),
                    g.master ? "個別契約（条件書・発注書・単体契約）を探してこの基本契約の下に入れる" : "個別契約を基本契約から外して、ここ（基本契約なし）に置く")}
                </td>
              );
              return (
                <Fragment key={g.key}>
                  {g.sec && <tr className="ct-sec"><td colSpan={6}>{g.sec}</td></tr>}
                  {!g.contracts.length && <tr>{masterCell(1)}<td colSpan={5} className="faint">（個別契約なし）</td></tr>}
                  {g.contracts.map((k, ki) => {
                    const node = model.nodeOf(k.id)!;
                    const span = Math.max(k.conds.length, 1) + (k.hidden || open.has(k.id) ? 1 : 0);
                    const underMaster = (model.parentOf.get(k.id) ?? "").startsWith("m");
                    const contractCell = (
                      <td className={`ct-contract ${node.cls}`} rowSpan={span}>
                        <div className="ct-line">
                          {node.tag && <span className={`tag cf-tag ${node.tag.cls}`}>{node.tag.text}</span>}
                          {node.open
                            ? <button className="linky code" onClick={node.open}>{node.no}</button>
                            : <span className="code">{node.no}</span>}
                          {viewOf(k.id)}
                          {node.badge && <span className={`tag ${node.badge.cls}`}>{node.badge.text}</span>}
                        </div>
                        <div>{node.title}</div>
                        {node.meta && <div className="faint">{node.meta}</div>}
                        {node.warn && <div className="amap-issue">{node.warn}</div>}
                        {k.id !== "loose" && (
                          <div className="ct-acts">
                            {act("＋ 条件を追加", () => setDialog({ kind: "cond-add", to: k.id, toNo: node.no ?? "" }), "条件明細を探してこの個別契約に載せる")}
                            {act(underMaster ? "解除" : "基本契約に入れる", () => setDialog({ kind: "contract-move", from: k.id, fromNo: node.no ?? "", underMaster }),
                              underMaster ? "この基本契約から外す・ほかの基本契約へ付け替える" : "基本契約を探して、その下に入れる")}
                          </div>
                        )}
                      </td>
                    );
                    const first = ki === 0;
                    const rowsOut: ReactNode[] = [];
                    if (!k.conds.length) {
                      rowsOut.push(<tr key={`${k.id}-0`}>{first && masterCell(rows)}{contractCell}<td colSpan={4} className="faint">（条件なし）</td></tr>);
                    }
                    k.conds.forEach((c, ci) => {
                      rowsOut.push(<tr key={`${k.id}-${c.id}`}>{first && ci === 0 && masterCell(rows)}{ci === 0 && contractCell}{condRow(c)}</tr>);
                    });
                    if (k.hidden || open.has(k.id)) {
                      rowsOut.push(
                        <tr key={`${k.id}-fold`}><td colSpan={4} className="ct-fold">
                          <button className="linky" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(k.id)) n.delete(k.id); else n.add(k.id); return n; })}>
                            {k.hidden ? `… ほか ${k.hidden} 本を開く` : "畳む"}
                          </button>
                        </td></tr>);
                    }
                    return <Fragment key={k.id}>{rowsOut}</Fragment>;
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialog && (() => {
        const close = () => setDialog(null);
        const partyId = map.party.id;
        switch (dialog.kind) {
          case "contract-add":
            return <PickDialog title={`${dialog.toNo} に個別契約を追加`} type="contract" partyId={partyId} multi onClose={close}
              intro={dialog.to === "none" ? "選んだ個別契約を基本契約から外し、基本契約なし（単体契約・発注書の約款）にします。" : "選んだ個別契約（条件書・発注書・単体契約）を、この基本契約の下に入れます。"}
              exclude={(it) => {
                const from = contractFromItem(it);
                if (!model.nodeOf(from)) return "この取引先の個別契約として出ていません";
                return model.parentOf.get(from) === dialog.to ? "いまここにあります" : model.canPutContract(from, dialog.to);
              }}
              confirmLabel="追加する" onConfirm={(items) => run(() => moveContracts(items, dialog.to))} />;
          case "contract-move":
            return <PickDialog title={`${dialog.fromNo} の基本契約を付け替え`} type="master" partyId={partyId} onClose={close}
              intro={dialog.underMaster ? "付け替え先の基本契約を選ぶか、「基本契約なしにする」を押します。" : "入れる先の基本契約を選びます。"}
              exclude={(it) => (model.parentOf.get(dialog.from) === `m${it.id}` ? "いまここにあります" : model.canPutContract(dialog.from, `m${it.id}`))}
              confirmLabel="付け替える" onConfirm={(items) => run(() => moveContracts([{ ...pseudoItem(dialog.from) }], `m${items[0]!.id}`))}
              secondary={dialog.underMaster ? { label: "基本契約なしにする", run: () => run(() => model.move(dialog.from, "none")) } : undefined} />;
          case "cond-add":
            return <PickDialog title={`${dialog.toNo} に条件明細を追加`} type="condition" partyId={partyId} multi onClose={close}
              intro="作品・取引先・条件名・条件番号で探して、この個別契約に載せます（ほかの契約に載っていれば付け替えになります）。"
              exclude={(it) => (model.condHolder(model.conds.find((c) => c.id === it.id) ?? ({} as MapCondition)) === dialog.to ? "いま載っています" : model.canPutCondition(`c${it.id}`, dialog.to))}
              confirmLabel="載せる" onConfirm={(items) => run(() => assignConds(items.map((x) => x.id), model.agreementIdOf(dialog.to), dialog.toNo))} />;
          case "cond-move":
            return <PickDialog title={`${dialog.cond.conditionNo ?? "条件"} の契約を${dialog.holderNo ? "付け替え" : "決める"}`} type="contract" partyId={partyId} onClose={close}
              intro={dialog.holderNo ? `いまは ${dialog.holderNo} に載っています。付け替え先の個別契約を選ぶか、「外すだけ」を押します。` : "載せる個別契約（条件書・発注書・単体契約）を選びます。"}
              exclude={(it) => {
                const to = contractFromItem(it);
                if (!model.nodeOf(to)) return "この取引先の個別契約として出ていません";
                if (it.kind === "解除合意") return "解除合意には載せられません";
                return model.condHolder(dialog.cond) === to ? "いま載っています" : model.canPutCondition(`c${dialog.cond.id}`, to);
              }}
              confirmLabel="付け替える" onConfirm={(items) => run(() => assignConds([dialog.cond.id], items[0]!.id, items[0]!.code ?? ""))}
              secondary={dialog.holderNo ? { label: "外すだけ（どの契約にも載せない）", run: () => run(() => assignConds([dialog.cond.id], null, "")) } : undefined} />;
          case "doc-add":
            return <PickDialog title={`${dialog.cond.conditionNo ?? "条件"} に支払文書を追加`} type="settlement" partyId={partyId} multi onClose={close}
              intro="検収書・納品書・役務提供完了通知書・利用許諾料計算書を、番号・作品・取引先・件名で探してつなぎます。"
              exclude={(it) => (settlementsOf(dialog.cond).some((s) => s.id === it.id) ? "つながっています" : null)}
              confirmLabel="つなぐ" onConfirm={(items) => run(async () => {
                for (const it of items) await api.post(`/links/condition/${dialog.cond.id}/documents`, { targetId: it.id });
                return `${dialog.cond.conditionNo} に ${items.map((x) => x.code).join("・")} をつなぎました`;
              })} />;
          case "doc-move":
            return <PickDialog title={`${dialog.cond.conditionNo ?? "条件"} を ${dialog.doc.documentNo ?? "文書"} から外す`} type="settlement" partyId={partyId} onClose={close}
              intro="付け替え先の支払文書を選ぶか、「外すだけ」を押します。文書の中身（金額・PDF）は変わりません。必要なら文書を訂正版で出し直してください。"
              exclude={(it) => (settlementsOf(dialog.cond).some((s) => s.id === it.id) ? "つながっています" : null)}
              confirmLabel="付け替える" onConfirm={(items) => run(async () => {
                await api.post(`/links/condition/${dialog.cond.id}/documents`, { targetId: items[0]!.id });
                await api.del(`/links/condition/${dialog.cond.id}/documents/${dialog.doc.id}`);
                return `${dialog.cond.conditionNo} を ${dialog.doc.documentNo} から ${items[0]!.code} へ付け替えました`;
              })}
              secondary={{ label: "外すだけ", run: () => run(async () => {
                await api.del(`/links/condition/${dialog.cond.id}/documents/${dialog.doc.id}`);
                return `${dialog.cond.conditionNo} を ${dialog.doc.documentNo} から外しました`;
              }) }} />;
          case "pay-add":
            return <PickDialog title={`${dialog.cond.conditionNo ?? "条件"} に支払を追加`} type="payment" partyId={partyId} onClose={close}
              intro="支払番号・取引先・作品・金額で探して、この条件に割り当てます。割り当てる額は、まだ割り当てていない額までです。"
              amount={{ label: "割り当てる額", initial: (it) => Math.max(0, it.unallocated ?? 0) }}
              exclude={(it) => ((it.unallocated ?? 0) <= 0 ? "割り当てられる残りがありません" : null)}
              confirmLabel="割り当てる" onConfirm={(items, amount) => run(async () => {
                const it = items[0]!;
                if (!amount || amount <= 0) throw new ApiError(400, "割り当てる額を入れてください", "VALIDATION");
                await putAllocations(it.id, addLine(it.allocations ?? [], dialog.cond.id, amount));
                return `${dialog.cond.conditionNo} に ${it.code} から ${money(amount, it.currency ?? "JPY")} を割り当てました`;
              })} />;
          case "pay-move":
            return <PickDialog title={`${dialog.cond.conditionNo ?? "条件"} を ${dialog.pay.paymentNo ?? "支払"} から外す`} type="payment" partyId={partyId} onClose={close}
              intro={`いまの割り当て ${money(dialog.amount, dialog.pay.currency)}。付け替え先の支払を選ぶか、「外すだけ」を押します。`}
              amount={{ label: "付け替える額", initial: (it) => Math.min(dialog.amount, Math.max(0, it.unallocated ?? 0)) }}
              exclude={(it) => (it.id === dialog.pay.id ? "いまの支払です" : (it.unallocated ?? 0) <= 0 ? "割り当てられる残りがありません" : null)}
              confirmLabel="付け替える" onConfirm={(items, amount) => run(async () => {
                const it = items[0]!;
                if (!amount || amount <= 0) throw new ApiError(400, "付け替える額を入れてください", "VALIDATION");
                await putAllocations(it.id, addLine(it.allocations ?? [], dialog.cond.id, amount));
                await putAllocations(dialog.pay.id, dialog.pay.allocations.filter((a) => a.conditionId !== dialog.cond.id));
                return `${dialog.cond.conditionNo} の割り当てを ${dialog.pay.paymentNo} から ${it.code} へ付け替えました`;
              })}
              secondary={{ label: "外すだけ", run: () => run(async () => {
                await putAllocations(dialog.pay.id, dialog.pay.allocations.filter((a) => a.conditionId !== dialog.cond.id));
                return `${dialog.cond.conditionNo} を ${dialog.pay.paymentNo} の割り当てから外しました`;
              }) }} />;
        }
      })()}
    </div>
  );

  /** 個別契約のノード id から、moveContracts に渡す形を作る。 */
  function pseudoItem(id: string): MapSearchItem {
    const n = Number(id.slice(1));
    return { id: id.startsWith("o") ? model.agreementIdOf(id) ?? 0 : n, orderDocumentId: id.startsWith("o") ? n : null,
             code: nodeNo(id), label: "", kind: "", category: null, party: null, work: null, note: null, amount: null, currency: null, blocked: null };
  }
}

/**
 * 探して選ぶポップアップ。作品・取引先・条件名・番号・件名で引く（全取引先から。この取引先が先）。
 * 選べないもの（取引先が違う・いまここにある など）は理由を出して選べなくする。
 */
function PickDialog(
  { title, intro, type, partyId, multi, exclude, confirmLabel, onConfirm, secondary, amount, onClose }: {
    title: string; intro?: ReactNode; type: MapSearchType; partyId: number; multi?: boolean;
    exclude?: (item: MapSearchItem) => string | null;
    confirmLabel: string;
    onConfirm: (items: MapSearchItem[], amount: number | null) => Promise<void>;
    secondary?: { label: string; run: () => Promise<void> };
    amount?: { label: string; initial: (item: MapSearchItem) => number };
    onClose: () => void;
  }
) {
  const [q, setQ] = useState("");
  const query = useDebounced(q, 250);
  const [items, setItems] = useState<MapSearchItem[] | null>(null);
  const [picked, setPicked] = useState<MapSearchItem[]>([]);
  const [amt, setAmt] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ type, partyId: String(partyId) });
    if (query.trim()) qs.set("q", query.trim());
    api.get<{ items: MapSearchItem[] }>(`/agreement-map/search?${qs}`)
      .then((r) => { if (alive) setItems(r.items); })
      .catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [type, partyId, query]);

  const reasonOf = (it: MapSearchItem) => it.blocked ?? exclude?.(it) ?? null;
  const toggle = (it: MapSearchItem) => {
    if (reasonOf(it)) return;
    setPicked((p) => {
      if (!multi) {
        if (amount) setAmt(String(amount.initial(it)));
        return p.some((x) => x.id === it.id) ? [] : [it];
      }
      return p.some((x) => x.id === it.id) ? p.filter((x) => x.id !== it.id) : [...p, it];
    });
  };
  async function go(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  const placeholder = type === "condition" ? "作品・取引先・条件名・条件番号・契約番号"
    : type === "payment" ? "支払番号・取引先・作品・金額"
      : type === "settlement" ? "文書番号・作品・取引先・件名・条件"
        : "契約番号・件名・取引先・作品";

  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        {intro && <div className="faint">{intro}</div>}
        <input className="inline-input" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
               placeholder={placeholder} aria-label="探す" style={{ width: "100%" }} />
        <div className="ct-pick">
          {!items && !error && <div className="faint" style={{ padding: 8 }}>読み込み中…</div>}
          {items && !items.length && <div className="faint" style={{ padding: 8 }}>見つかりません。</div>}
          {items?.map((it) => {
            const why = reasonOf(it);
            const on = picked.some((x) => x.id === it.id);
            return (
              <label key={`${it.id}-${it.orderDocumentId ?? ""}`} className={`ct-pick-row${why ? " off" : ""}${on ? " on" : ""}`} title={why ?? undefined}>
                <input type={multi ? "checkbox" : "radio"} name="pick" checked={on} disabled={Boolean(why)} onChange={() => toggle(it)} />
                <span className="ct-pick-main">
                  <span className="ct-line">
                    <span className={`tag${it.category === "license" ? " cf-tag lic" : it.category === "service" ? " cf-tag svc" : it.category === "hybrid" ? " cf-tag hyb" : ""}`}>{it.kind}</span>
                    <span className="code">{it.code ?? "—"}</span>
                    <span>{it.label}</span>
                    {it.amount !== null && <span className="num" style={{ marginLeft: "auto" }}>{money(it.amount, it.currency ?? "JPY")}</span>}
                  </span>
                  <span className="faint">{[it.party, it.work, it.note,
                    it.unallocated !== undefined ? `未割り当て ${money(it.unallocated, it.currency ?? "JPY")}` : null].filter(Boolean).join("・")}</span>
                  {why && <span className="amap-issue">{why}</span>}
                </span>
              </label>
            );
          })}
        </div>
        {amount && picked.length === 1 && (
          <label className="row" style={{ gap: 6, alignItems: "center" }}>
            <span>{amount.label}</span>
            <input className="inline-input" type="number" min={1} value={amt} onChange={(e) => setAmt(e.target.value)} style={{ width: 160 }} />
            <span className="faint">（{picked[0]!.code} の未割り当て {money(picked[0]!.unallocated ?? 0, picked[0]!.currency ?? "JPY")}）</span>
          </label>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {secondary && <button className="btn" disabled={busy} onClick={() => void go(secondary.run)} style={{ marginRight: "auto" }}>{secondary.label}</button>}
          <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
          <button className="btn primary" disabled={busy || !picked.length}
                  onClick={() => void go(() => onConfirm(picked, amount ? Number(amt) : null))}>
            {busy ? "実行中…" : `${confirmLabel}${multi && picked.length > 1 ? `（${picked.length}）` : ""}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
