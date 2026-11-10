import { useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { DirectionTag } from "./labels.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { AgreementKind } from "../server/agreements/service.js";
import type { MapAgreement, MapCondition, MapOrder, PartyMap } from "../server/agreements/party-map.js";

/**
 * 契約整理のマッピング（取引先 ⇔ 基本契約 の画面の中心）。
 *
 *   1. 基本契約 ⇔ 個別契約：列＝基本契約（右端に「基本契約なし」）、カード＝個別契約・単体契約・発注書。
 *      カードを列へドラッグするか、選んで列の「ここへ」を押すと、その基本契約の下に入る。
 *   2. 条件明細 ⇔ 個別契約：行＝条件明細、列＝個別契約・単体契約・発注書。マスを押すとその契約に載る
 *      （条件明細を持つのは個別契約か単体契約。基本契約は条件明細を持たない）。
 *
 * 動かし方はこれまでの部品と同じ（サーバの口も同じ）：
 *   単体契約 → 基本契約の下：個別契約にする（demote）
 *   個別契約 → 別の基本契約：親を付け替える／基本契約なし：単体契約に戻す（promote）
 *   発注書   → 基本契約の下：基本契約の下に入れる／基本契約なし：器を単体契約にする
 */

const NONE = "none" as const;
type ColumnKey = number | typeof NONE;

const KIND_SHORT: Record<AgreementKind, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "個別契約", termination: "解除合意", document: "文書だけ"
};

interface Card {
  key: string;
  column: ColumnKey;
  tag: string;
  no: string | null;
  title: string;
  direction: "in" | "out" | null;
  conditionCount: number;
  warn: string | null;
  open: () => void;
  /** 列へ動かせないときの理由。 */
  blocked: (to: ColumnKey) => string | null;
  move: (to: ColumnKey) => Promise<string>;
}

const label = (a: { agreementNo: string | null; id: number }) => a.agreementNo ?? `#${a.id}`;

export function AgreementMappingBoard(
  { map, onOpen, onChanged, onError }: {
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  const masters = useMemo(() => [...map.roots.filter((r) => r.kind === "master")]
    .sort((a, b) => Number(Boolean(a.terminatedOn)) - Number(Boolean(b.terminatedOn)) || a.id - b.id), [map]);
  const masterOf = (id: number) => masters.find((m) => m.id === id);
  const orders = map.orders ?? [];

  const cards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    const agreementCard = (a: MapAgreement, column: ColumnKey, warn: string | null): Card => ({
      key: `a${a.id}`, column, tag: KIND_SHORT[a.kind], no: a.agreementNo, title: a.title,
      direction: a.direction === "in" || a.direction === "out" ? a.direction : null,
      conditionCount: a.conditionCount, warn,
      open: () => onOpen?.("agreement", a.id),
      blocked: (to) => {
        if (to === column) return "いまここにあります";
        if (to === NONE) {
          if (a.kind === "termination") return "解除合意は基本契約の下にだけ置けます";
          if (a.kind === "standalone") return "いまここにあります";
          return null;
        }
        const m = masterOf(to);
        if (!m) return "基本契約が見つかりません";
        if (m.direction && a.direction && m.direction !== a.direction) return "基本契約と向き（IN／OUT）が違います";
        if (a.kind === "standalone" && m.terminatedOn) return "解除済みの基本契約の下には入れられません";
        return null;
      },
      move: async (to) => {
        if (to === NONE) {
          await api.post(`/agreement-map/agreements/${a.id}/promote`, {});
          return `${label(a)} を単体契約にしました`;
        }
        const m = masterOf(to)!;
        if (a.kind === "standalone") await api.post(`/agreement-map/agreements/${a.id}/demote`, { masterId: to });
        else await api.patch(`/agreement-map/agreements/${a.id}`, { parentId: to });
        return `${label(a)} を ${label(m)} の下にしました`;
      }
    });
    const orderCard = (o: MapOrder, column: ColumnKey): Card => ({
      key: `o${o.id}`, column, tag: o.imported ? "発注書（取込）" : "発注書", no: o.documentNo, title: o.title ?? "",
      direction: null, conditionCount: o.conditions.length,
      warn: o.conditions.length ? null : "条件明細が載っていません",
      open: () => onOpen?.("document", o.id),
      blocked: (to) => {
        if (to === column) return "いまここにあります";
        if (to === NONE) return o.agreementId ? null : "基本契約から外す器がありません（決定前・取込の発注書）";
        if (!o.conditions.length) return "先に条件明細を紐づけてください（下の条件明細のマッピングか「検索して紐づける」）";
        return masterOf(to) ? null : "基本契約が見つかりません";
      },
      move: async (to) => {
        if (to === NONE) {
          await api.patch(`/agreement-map/agreements/${o.agreementId}`, { kind: "standalone", parentId: null });
          return `${o.documentNo ?? `#${o.id}`} を基本契約なし（発注書の約款）にしました`;
        }
        await api.post(`/agreement-map/orders/${o.id}/master`, { agreementId: to });
        return `${o.documentNo ?? `#${o.id}`} を ${label(masterOf(to)!)} の下の発注書にしました`;
      }
    });
    for (const m of masters) {
      const root = map.roots.find((r) => r.id === m.id)!;
      for (const c of root.children) out.push(agreementCard(c, m.id, null));
      for (const o of orders.filter((x) => x.masterId === m.id)) out.push(orderCard(o, m.id));
    }
    for (const r of map.roots.filter((x) => x.kind === "standalone")) {
      out.push(agreementCard(r, NONE, null));
      // 単体契約の下の覚書なども、単体契約と一緒に「基本契約なし」に並べる。
      for (const c of r.children) out.push(agreementCard(c, NONE, `単体契約 ${label(r)} の下`));
    }
    for (const a of map.loose) out.push(agreementCard(a, NONE, "親が無い・親が基本契約でない（基本契約の列へ動かしてください）"));
    for (const o of orders.filter((x) => x.masterId === null)) out.push(orderCard(o, NONE));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, masters]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState<ColumnKey | null>(null);
  const toggle = (key: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  async function moveTo(keys: string[], to: ColumnKey) {
    const moving = cards.filter((c) => keys.includes(c.key));
    const ok = moving.filter((c) => !c.blocked(to));
    const skipped = moving.filter((c) => c.blocked(to) && c.column !== to);
    if (!ok.length) {
      if (skipped.length) onError(`${skipped[0]!.no ?? "カード"}：${skipped[0]!.blocked(to)}`);
      return;
    }
    setBusy(true);
    const done: string[] = [];
    try {
      for (const c of ok) done.push(await c.move(to));
      setSelected(new Set());
      onChanged(done.join("／") + (skipped.length ? `（${skipped.length} 件は動かせませんでした：${skipped.map((c) => `${c.no ?? "?"} ${c.blocked(to)}`).join("・")}）` : ""));
    } catch (e) {
      onError(`${done.length ? done.join("／") + "。そのあと " : ""}${(e as ApiError).message}`);
      if (done.length) onChanged(done.join("／"));
    } finally { setBusy(false); }
  }

  const columns: Array<{ key: ColumnKey; head: ReactNode }> = [
    ...masters.map((m) => ({
      key: m.id as ColumnKey,
      head: (
        <>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <span className="tag">基本契約</span>
            <DirectionTag direction={m.direction} />
            {m.terminatedOn && <span className="tag warn">解除 {m.terminatedOn}</span>}
          </div>
          <button className="linky code" onClick={() => onOpen?.("agreement", m.id)}>{label(m)}</button>
          <div className="amb-title">{m.title}</div>
          {m.executedOn && <div className="faint">締結 {m.executedOn}</div>}
          {m.conditionCount > 0 && <div className="amap-issue">基本契約に直付けの条件 {m.conditionCount}（下の条件明細で個別契約へ）</div>}
        </>
      )
    })),
    {
      key: NONE,
      head: (
        <>
          <span className="tag ghost">基本契約なし</span>
          <div className="amb-title">単体契約・発注書の約款で取引</div>
        </>
      )
    }
  ];

  const selectedCards = cards.filter((c) => selected.has(c.key));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="faint">
          カードを基本契約の列へドラッグするか、カードを選んで列の「ここへ」を押します。右端は基本契約なし（単体契約・発注書の約款）。
        </span>
        {selected.size > 0 && (
          <>
            <span className="tag accent">{selected.size} 件選択中</span>
            <button className="btn btn-sm" onClick={() => setSelected(new Set())}>選択を外す</button>
          </>
        )}
        {busy && <span className="faint">動かしています…</span>}
      </div>
      <div className="amb-board" role="list" aria-label="基本契約ごとの個別契約">
        {columns.map((col) => {
          const here = cards.filter((c) => c.column === col.key);
          const can = selectedCards.filter((c) => !c.blocked(col.key));
          return (
            <div key={String(col.key)} role="listitem"
                 className={`amb-col${col.key === NONE ? " amb-none" : ""}${over === col.key ? " amb-over" : ""}`}
                 onDragOver={(e) => { if (!readOnly && !busy) { e.preventDefault(); setOver(col.key); } }}
                 onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                 onDrop={(e) => {
                   e.preventDefault(); setOver(null);
                   const key = e.dataTransfer.getData("text/plain");
                   if (!key || readOnly || busy) return;
                   void moveTo(selected.has(key) ? [...selected] : [key], col.key);
                 }}>
              <div className="amb-head">
                {col.head}
                {selected.size > 0 && !readOnly && (
                  <button className="btn btn-sm primary" disabled={busy || !can.length}
                          title={can.length ? undefined : "選んだカードはここへは動かせません"}
                          onClick={() => void moveTo(can.map((c) => c.key), col.key)}>
                    ここへ{can.length ? `（${can.length}）` : ""}
                  </button>
                )}
              </div>
              <div className="amb-cards">
                {here.map((c) => (
                  <div key={c.key} className={`amb-card${selected.has(c.key) ? " amb-selected" : ""}${c.warn ? " amb-warn" : ""}`}
                       draggable={!readOnly && !busy}
                       onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.key); e.dataTransfer.effectAllowed = "move"; }}>
                    <label className="row" style={{ gap: 4, alignItems: "center" }}>
                      {!readOnly && <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} aria-label={`${c.no ?? ""} を選ぶ`} />}
                      <span className="tag ghost">{c.tag}</span>
                      {c.direction && <DirectionTag direction={c.direction} />}
                    </label>
                    <button className="linky code" onClick={c.open}>{c.no ?? "（番号なし）"}</button>
                    {c.title && <div className="amb-title">{c.title}</div>}
                    <div className="faint">条件 {c.conditionCount}</div>
                    {c.warn && <div className="amap-issue">{c.warn}</div>}
                  </div>
                ))}
                {!here.length && <div className="faint amb-empty">（なし）</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 条件明細を載せられる契約（個別契約・単体契約・発注書の器）。 */
interface Target {
  id: number; no: string; tag: string; parentNo: string | null;
  direction: "in" | "out" | null; open: () => void;
}

type Show = "loose" | "all";

export function ConditionMapping(
  { map, onOpen, onChanged, onError }: {
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  const conditions = map.conditions ?? [];
  const masterIds = useMemo(() => new Set(map.roots.filter((r) => r.kind === "master").map((r) => r.id)), [map]);
  const targets = useMemo<Target[]>(() => {
    const out: Target[] = [];
    const dir = (d: unknown) => (d === "in" || d === "out" ? d : null);
    const masters = map.roots.filter((r) => r.kind === "master");
    for (const m of masters) {
      for (const c of m.children.filter((x) => x.kind === "supplement")) {
        out.push({ id: c.id, no: label(c), tag: "個別契約", parentNo: label(m), direction: dir(c.direction), open: () => onOpen?.("agreement", c.id) });
      }
      for (const o of (map.orders ?? []).filter((x) => x.masterId === m.id && x.agreementId)) {
        out.push({ id: o.agreementId!, no: o.documentNo ?? `#${o.id}`, tag: "発注書", parentNo: label(m), direction: null, open: () => onOpen?.("document", o.id) });
      }
    }
    for (const r of map.roots.filter((x) => x.kind === "standalone")) {
      out.push({ id: r.id, no: label(r), tag: "単体契約", parentNo: null, direction: dir(r.direction), open: () => onOpen?.("agreement", r.id) });
    }
    for (const a of map.loose.filter((x) => x.kind === "supplement")) {
      out.push({ id: a.id, no: label(a), tag: "個別契約（親なし）", parentNo: null, direction: dir(a.direction), open: () => onOpen?.("agreement", a.id) });
    }
    for (const o of (map.orders ?? []).filter((x) => x.masterId === null && x.agreementId)) {
      out.push({ id: o.agreementId!, no: o.documentNo ?? `#${o.id}`, tag: "発注書", parentNo: null, direction: null, open: () => onOpen?.("document", o.id) });
    }
    // 発注書の器の向きは、載っている条件の向きから。
    for (const t of out) {
      if (t.direction) continue;
      const c = conditions.find((x) => x.agreementId === t.id);
      if (c) t.direction = c.direction;
    }
    return out.filter((t, i) => out.findIndex((x) => x.id === t.id) === i);
  }, [map, conditions, onOpen]);
  const targetOf = (id: number | null) => (id === null ? null : targets.find((t) => t.id === id) ?? null);
  /** 持ち主の決まっていない条件：契約なし・基本契約に直付け・マッピングの外の契約に載っている。 */
  const isLoose = (c: MapCondition) => c.agreementId === null || masterIds.has(c.agreementId) || !targetOf(c.agreementId);
  const looseCount = conditions.filter(isLoose).length;

  const [show, setShow] = useState<Show>(looseCount > 0 ? "loose" : "all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const rows = conditions.filter((c) => (show === "all" || isLoose(c)) && (!q.trim() || [
    c.conditionNo, c.name, c.workTitle, ...c.documents.map((d) => d.documentNo), targetOf(c.agreementId)?.no
  ].some((s) => String(s ?? "").toLowerCase().includes(q.trim().toLowerCase()))));
  const holderText = (c: MapCondition) => {
    if (c.agreementId === null) return { text: "契約なし", warn: true };
    if (masterIds.has(c.agreementId)) {
      const m = map.roots.find((r) => r.id === c.agreementId);
      return { text: `基本契約 ${m ? label(m) : `#${c.agreementId}`} に直付け`, warn: true };
    }
    const t = targetOf(c.agreementId);
    return t ? { text: t.no, warn: false } : { text: `ほかの契約 #${c.agreementId}`, warn: true };
  };

  async function assign(ids: number[], agreementId: number | null) {
    const list = conditions.filter((c) => ids.includes(c.id));
    const bad = agreementId === null ? [] : list.filter((c) => {
      const t = targetOf(agreementId);
      return t?.direction && t.direction !== c.direction;
    });
    const ok = list.filter((c) => !bad.includes(c) && c.agreementId !== agreementId);
    if (!ok.length) {
      if (bad.length) onError(`${bad[0]!.conditionNo ?? "条件"} は向き（IN／OUT）が違うので載せられません`);
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ moved: number; agreementNo: string | null }>("/agreement-map/conditions/assign",
        { conditionIds: ok.map((c) => c.id), agreementId });
      setSelected(new Set());
      onChanged(agreementId === null
        ? `条件明細 ${r.moved} 本を契約から外しました`
        : `条件明細 ${r.moved} 本を ${targetOf(agreementId)?.no ?? r.agreementNo ?? "契約"} に載せました`
          + (bad.length ? `（向きの違う ${bad.length} 本は動かしていません）` : ""));
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (!conditions.length) return null;
  const allShown = rows.length > 0 && rows.every((c) => selected.has(c.id));

  return (
    <div className="panel">
      <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>条件明細 ⇔ 個別契約</h2>
        {looseCount > 0 && <span className="tag warn">持ち主の決まっていない条件 {looseCount}</span>}
        <span className="faint">マスを押すと、その条件明細がその契約に載ります。行を選んで列の見出しを押すとまとめて載ります</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div className="chips" role="group" aria-label="出す条件明細">
            <button className="chip" aria-pressed={show === "loose"} onClick={() => setShow("loose")}>持ち主の決まっていないもの（{looseCount}）</button>
            <button className="chip" aria-pressed={show === "all"} onClick={() => setShow("all")}>すべて（{conditions.length}）</button>
          </div>
          <input className="inline-input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="条件番号・名前・作品・文書番号" aria-label="条件明細を絞る" style={{ minWidth: 220 }} />
          {selected.size > 0 && <span className="tag accent">{selected.size} 本選択中</span>}
          {selected.size > 0 && <button className="btn btn-sm" onClick={() => setSelected(new Set())}>選択を外す</button>}
          {busy && <span className="faint">載せています…</span>}
        </div>
        {!targets.length && (
          <div className="note warn">条件明細を載せられる個別契約・単体契約・発注書がありません。先に上で契約を立てるか、発注書を紐づけてください。</div>
        )}
        {rows.length === 0
          ? <div className="faint">当てはまる条件明細はありません。</div>
          : (
            <div className="rm-scroll amb-matrix-scroll">
              <table className="rm-table amb-matrix">
                <thead>
                  <tr>
                    <th className="rm-corner">
                      <label className="row" style={{ gap: 4 }}>
                        {!readOnly && <input type="checkbox" checked={allShown} aria-label="出ている条件をぜんぶ選ぶ"
                               onChange={() => setSelected(allShown ? new Set() : new Set(rows.map((c) => c.id)))} />}
                        条件明細 ＼ 契約
                      </label>
                    </th>
                    <th>いま</th>
                    {targets.map((t) => (
                      <th key={t.id} title={t.parentNo ? `${t.parentNo} の下` : "基本契約なし"}>
                        <div className="amb-th">
                          <span className="faint">{t.tag}</span>
                          <button className="linky code" onClick={t.open}>{t.no}</button>
                          {t.parentNo && <span className="faint">↑ {t.parentNo}</span>}
                          {selected.size > 0 && !readOnly && (
                            <button className="btn btn-sm primary" disabled={busy} onClick={() => void assign([...selected], t.id)}>ここへ</button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th>
                      <div className="amb-th">
                        <span className="faint">外す</span>
                        {selected.size > 0 && !readOnly && (
                          <button className="btn btn-sm" disabled={busy} onClick={() => void assign([...selected], null)}>契約なしに</button>
                        )}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const h = holderText(c);
                    return (
                      <tr key={c.id}>
                        <th className="amb-cond">
                          <label className="row" style={{ gap: 4, alignItems: "flex-start" }}>
                            {!readOnly && <input type="checkbox" checked={selected.has(c.id)} aria-label={`${c.conditionNo ?? ""} を選ぶ`}
                                   onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />}
                            <span>
                              <button className="linky code" onClick={() => onOpen?.("condition", c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
                              {" "}<DirectionTag direction={c.direction} />
                              <div className="amb-title">{c.name || "（無題の条件）"}</div>
                              {c.documents.length > 0 && (
                                <div className="faint">文書：{c.documents.map((d) => `${d.documentNo ?? `#${d.id}`}${d.status === "draft" ? "（下書き）" : ""}`).join("・")}</div>
                              )}
                            </span>
                          </label>
                        </th>
                        <td className={h.warn ? "amb-now warn" : "amb-now"}>{h.text}</td>
                        {targets.map((t) => {
                          const on = c.agreementId === t.id;
                          const wrong = Boolean(t.direction && t.direction !== c.direction);
                          return (
                            <td key={t.id} className={on ? "amb-on" : undefined}>
                              <button className="amb-dot" disabled={readOnly || busy || wrong || on}
                                      aria-pressed={on}
                                      title={on ? `${t.no} に載っています` : wrong ? "向き（IN／OUT）が違います" : `${t.no} に載せる`}
                                      onClick={() => void assign([c.id], t.id)}>{on ? "●" : wrong ? "—" : "○"}</button>
                            </td>
                          );
                        })}
                        <td>
                          <button className="amb-dot" disabled={readOnly || busy || c.agreementId === null}
                                  title="契約から外す" onClick={() => void assign([c.id], null)}>{c.agreementId === null ? "●" : "×"}</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        <small className="faint">
          条件明細を持つのは個別契約（ライセンスなら条件書、業務委託なら発注書）か単体契約です。基本契約は条件明細を持たず、個別契約を持ちます。
          発注書の列は、決定して器のある発注書だけです（決定前・取込の発注書は「検索して紐づける」で）。
        </small>
      </div>
    </div>
  );
}
