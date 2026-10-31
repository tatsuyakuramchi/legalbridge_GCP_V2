import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 作品 › 権利とお金の流れ（docs/navigation.md §5）。
 *
 *   作者（IN 条件・当社が払う） ─ 当社の作品（原作 → この作品 → 派生作品） ─ 取引先（OUT 条件・当社が受け取る）
 *
 * 取引先ごとに「この入金でどの作者に払いが出るか」を、台帳・入金のパネルと同じ決まりで出す（server/works/rights-flow.ts）。
 * 払いの出ない作者・作者のいない許諾先・重複した条件は上の帯で知らせる。
 */

interface FlowWork { id: number; title: string }
interface FlowIn {
  id: number; conditionNo: string | null; name: string; partyId: number; partyName: string;
  workId: number | null; workTitle: string | null; usageType: string | null; usageLabel: string; pricingModel: string;
  ratePct: number | null; unitAmount: number | null; timing: "periodic" | "event";
  targetPartyId: number | null; targetPartyName: string | null;
}
interface FlowOut {
  id: number; conditionNo: string | null; name: string; partyId: number; partyName: string;
  workId: number | null; workTitle: string | null; usageType: string | null; usageLabel: string;
  languages: string[]; regions: string[]; agreementNo: string | null; covers: number[];
}
interface FlowMoney { outId: number; received: number; byAuthor: Record<number, number>; open: number }
interface FlowWarning { kind: "uncovered" | "missing_author" | "duplicate"; message: string; conditionIds: number[] }
interface RightsFlow {
  work: FlowWork; ancestors: FlowWork[]; descendants: FlowWork[];
  ins: FlowIn[]; outs: FlowOut[]; money: FlowMoney[]; warnings: FlowWarning[];
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const rateOf = (c: FlowIn) => c.pricingModel === "unit_rate" && c.unitAmount !== null ? `単価 ${yen(c.unitAmount)}` : c.ratePct !== null ? `${c.ratePct}%` : "—";

export function WorkRightsFlow({ workId, onOpenCondition, onOpenWork, onOpenCheck }: {
  workId: number;
  onOpenCondition?: (id: number) => void;
  onOpenWork?: (id: number) => void;
  /** 監査 › 条件の点検 へ。 */
  onOpenCheck?: () => void;
}) {
  const [flow, setFlow] = useState<RightsFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFlow(null); setError(null);
    api.get<RightsFlow>(`/works/${workId}/rights-flow`).then(setFlow).catch((e: ApiError) => setError(e.message));
  }, [workId]);
  if (error) return <div className="alert">{error}</div>;
  if (!flow) return <div className="panel"><div className="panel-bd faint">読み込み中…</div></div>;

  const cond = (id: number, text: string) => onOpenCondition
    ? <button className="linky code" onClick={() => onOpenCondition(id)}>{text}</button> : <span className="code">{text}</span>;
  const workLink = (w: FlowWork, strong = false) => onOpenWork && w.id !== flow.work.id
    ? <button className="linky" onClick={() => onOpenWork(w.id)}>{w.title}</button>
    : strong ? <b>{w.title}</b> : <span>{w.title}</span>;
  const authors = [...new Map(flow.ins.map((c) => [c.partyId, c.partyName])).entries()];
  const coverText = (o: FlowOut) => {
    const list = flow.ins.filter((c) => o.covers.includes(c.id));
    return list.length ? `→ ${list.map((c) => `${c.partyName} ${rateOf(c)}`).join("・")} に払いが出る` : "→ 払いの出る作者がいません";
  };

  return (
    <div className="stack">
      {flow.warnings.length > 0 && (
        <div className="note warn stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}>
            <b>確かめてほしいこと {flow.warnings.length} 件</b>
            {onOpenCheck && <button className="linky" style={{ marginLeft: "auto" }} onClick={onOpenCheck}>条件の点検で直す</button>}
          </div>
          {flow.warnings.map((w, i) => <span key={i}>・{w.message}</span>)}
        </div>
      )}

      <div className="panel">
        <div className="panel-hd">
          <h2>権利の流れ</h2>
          <span className="faint">作者から取った権利（IN）→ 当社の作品 → 取引先へ出した権利（OUT）。お金は逆向きに流れます</span>
        </div>
        <div className="panel-bd" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
          <div className="stack" style={{ gap: 8 }}>
            <span className="faint">作者（IN 条件）・当社が払う</span>
            {authors.length ? authors.map(([partyId, name]) => (
              <div key={partyId} className="panel" style={{ margin: 0 }}>
                <div className="panel-bd stack" style={{ gap: 4 }}>
                  <b>{name}</b>
                  {flow.ins.filter((c) => c.partyId === partyId).map((c) => (
                    <div key={c.id} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      {cond(c.id, c.conditionNo ?? `#${c.id}`)}
                      <span>{c.usageLabel} {rateOf(c)}</span>
                      <span className={`tag ${c.timing === "event" ? "warn" : "accent"}`}>{c.timing === "event" ? "イベント式" : "時限式"}</span>
                      {c.targetPartyName && <span className="tag">許諾先専用：{c.targetPartyName}</span>}
                      {c.workId !== flow.work.id && c.workTitle && <span className="faint">（{c.workTitle} に付いた条件）</span>}
                    </div>
                  ))}
                </div>
              </div>
            )) : <span className="faint">許諾料の IN 条件はありません</span>}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <span className="faint">当社の作品（系譜）</span>
            {[...flow.ancestors].reverse().map((w) => (
              <div key={w.id} className="panel" style={{ margin: 0 }}><div className="panel-bd"><span className="faint">元の作品 </span>{workLink(w)}</div></div>
            ))}
            <div className="panel" style={{ margin: 0, borderWidth: 2 }}><div className="panel-bd">{workLink(flow.work, true)}<div className="faint">いま見ている作品</div></div></div>
            {flow.descendants.length > 0 && (
              <div className="panel" style={{ margin: 0 }}>
                <div className="panel-bd stack" style={{ gap: 4 }}>
                  <span className="faint">派生作品（言語版など）</span>
                  {flow.descendants.map((w) => <div key={w.id}>{workLink(w)}</div>)}
                </div>
              </div>
            )}
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <span className="faint">取引先（OUT 条件）・当社が受け取る</span>
            {flow.outs.length ? flow.outs.map((o) => (
              <div key={o.id} className="panel" style={{ margin: 0 }}>
                <div className="panel-bd stack" style={{ gap: 4 }}>
                  <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
                    <b>{o.partyName}</b><span className="faint">{o.workTitle ?? ""}・{o.usageLabel}</span>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {cond(o.id, o.conditionNo ?? `#${o.id}`)}
                    {[...o.languages, ...o.regions].length > 0 && <span>{[o.languages.join("・"), o.regions.join("・")].filter(Boolean).join("／")}</span>}
                    {o.agreementNo && <span className="code faint">{o.agreementNo}</span>}
                  </div>
                  <span className={o.covers.length ? "" : "warn"}>{coverText(o)}</span>
                </div>
              </div>
            )) : <span className="faint">再許諾・他社販売の OUT 条件はありません</span>}
          </div>
        </div>
      </div>

      {flow.outs.length > 0 && (
        <div className="panel">
          <div className="panel-hd">
            <h2>お金の流れ（直近 12 か月）</h2>
            <span className="faint">許諾先ごとの入金と、そこから作者へ払う許諾料（報告を起こした分）</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>取引先</th><th className="num">入金</th>
                  {authors.map(([id, name]) => <th key={id} className="num">{name}</th>)}
                  <th>未処理</th>
                </tr>
              </thead>
              <tbody>
                {flow.outs.map((o) => {
                  const m = flow.money.find((x) => x.outId === o.id);
                  return (
                    <tr key={o.id}>
                      <td>{o.partyName}<div className="faint">{o.workTitle ?? ""}・{o.usageLabel}</div></td>
                      <td className="num">{yen(m?.received ?? 0)}</td>
                      {authors.map(([id]) => {
                        const covered = flow.ins.some((c) => c.partyId === id && o.covers.includes(c.id));
                        return <td key={id} className="num">{covered ? yen(m?.byAuthor[id] ?? 0) : <span className="faint">条件なし</span>}</td>;
                      })}
                      <td>{m?.open ? <span className="tag warn">作者の報告・計算書 {m.open} 件</span> : <span className="tag ok">済</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
