import { useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { DirectionTag } from "./labels.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { MapCondition, PartyMap } from "../server/agreements/party-map.js";

/**
 * 条件明細 ⇔ 個別契約 の表（取引先 ⇔ 基本契約 のマッピングの下）。
 * 行＝条件明細、列＝個別契約・単体契約・発注書。マスを押すとその契約に載る。まとめて載せ替えるときに使う
 * （1 本ずつはマッピング（ContractFlow.tsx）でドラッグ）。
 */

const label = (a: { agreementNo: string | null; id: number }) => a.agreementNo ?? `#${a.id}`;

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
