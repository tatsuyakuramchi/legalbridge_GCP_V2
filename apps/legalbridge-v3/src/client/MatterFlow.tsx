import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 案件の進み具合。
 *
 * これまでは段階を並べただけで、どこまで進んだかは示していなかった。
 * 段階はデータベースに持たず、その案件に何が揃っているかから導く。
 * 「済」の根拠を一緒に出すので、印が合っているかを画面で確かめられる。
 */

type FlowTab = "conditions" | "events" | "documents" | "payments" | "communications";
type FlowBlock = "work" | "production" | "license" | "service" | "other" | "continue";
const BLOCK_LABEL: Record<FlowBlock, string> = {
  work: "作品", production: "制作委託", license: "許諾", service: "業務委託", other: "進め方", continue: "継続"
};
interface FlowStep {
  no: number; name: string; done: boolean; detail: string;
  /** その作業をする場所（案件の中身のタブ）。 */
  tab?: FlowTab;
  /** そこで押す操作の呼び名。 */
  action?: string;
  /** どのブロックか。作品案件は 作品 → 制作委託 → 許諾 → 継続。 */
  block?: FlowBlock;
  /** 「次にやること」に数えない（継続は状態であって作業ではない）。 */
  optional?: boolean;
}
const TAB_LABEL: Record<FlowTab, string> = {
  conditions: "条件明細", events: "実績", documents: "文書",
  payments: "支払", communications: "操作の記録"
};
interface Flow { steps: FlowStep[]; current: FlowStep | null }

export function MatterFlow(
  { matterId, reloadKey, onGo, onRegisterAgreement }:
  { matterId: number; reloadKey: number;
    /** 段階を押したときに移る先。案件の中身のタブを開く。 */
    onGo?: (tab: FlowTab) => void;
    /** 「基本契約の確認」が未済のとき、その場で契約の登録へ移る口（相手先入り）。 */
    onRegisterAgreement?: () => void }
) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.get<Flow>(`/matters/${matterId}/flow`)
      .then(setFlow).catch((e: ApiError) => setError(e.message));
  }, [matterId, reloadKey]);

  if (error) return <div className="alert">{error}</div>;
  if (!flow) return null;

  // ブロックの見出し。段階の並びの上に「作品 ／ 制作委託 ／ 許諾 ／ 継続」を出す。
  const blocks: Array<{ block: FlowBlock | null; steps: FlowStep[] }> = [];
  for (const step of flow.steps) {
    const last = blocks[blocks.length - 1];
    if (last && last.block === (step.block ?? null)) last.steps.push(step);
    else blocks.push({ block: step.block ?? null, steps: [step] });
  }
  const showBlocks = blocks.length > 1;

  const renderStep = (step: FlowStep) => {
    const current = flow.current?.no === step.no;
    const style = step.done
      ? { background: "var(--ok-soft)", borderColor: "var(--ok)" }
      : step.optional ? { background: "var(--warn-soft)" } : undefined;
    const inner = (<>
      <span className="st">{step.done ? "済" : current ? "いま" : step.optional ? "状態" : step.no}</span>
      <span className="nm">{step.name}</span>
    </>);
    // 次にやることが分かっても、どこで手を動かすかが分からなければ止まる。
    // 段階を押したらその作業をするタブへ移る。
    return step.tab && onGo
      ? <button key={step.no} type="button"
                className={`pipe-step${current ? " flag" : ""}`}
                title={`${step.detail}（押すと${TAB_LABEL[step.tab]}へ）`}
                style={style}
                onClick={() => onGo(step.tab!)}>{inner}</button>
      : <div key={step.no} className={`pipe-step${current ? " flag" : ""}`}
             title={step.detail} style={style}>{inner}</div>;
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {/* ブロックごとに 1 行。作品案件は 作品 → 制作委託 → 許諾 → 継続 と縦に並ぶので、
          12 段階あっても横にはみ出さない。 */}
      {showBlocks
        ? blocks.map((b, i) => (
            <div key={i} className="row" style={{ gap: 8, alignItems: "stretch" }}>
              <div className="faint" style={{ flex: "0 0 64px", fontSize: 11, fontWeight: 700,
                                              display: "flex", alignItems: "center" }}>
                {b.block ? BLOCK_LABEL[b.block] : ""}
              </div>
              <div className="pipe" style={{ flex: 1 }}>{b.steps.map(renderStep)}</div>
            </div>
          ))
        : <div className="pipe">{flow.steps.map(renderStep)}</div>}

      <div className="trace">
        {flow.steps.map((step) => (
          <div key={step.no} className="trace-line">
            <span style={{ color: step.done ? "var(--ok)" : step.optional ? "var(--warn)" : "var(--faint)", marginRight: 6 }}>
              {step.done ? "✓" : step.optional ? "…" : "—"}
            </span>
            {showBlocks && step.block && <span className="tag ghost" style={{ marginRight: 6 }}>{BLOCK_LABEL[step.block]}</span>}
            <b>{step.name}</b>
            <span className="faint" style={{ marginLeft: 8 }}>{step.detail}</span>
          </div>
        ))}
        {/* 「次にやること」は読むだけでなく押せるようにする。名前が分かっても
            どのタブかを探し直すのでは、結局そこで止まる。 */}
        {flow.current
          ? <div className="trace-line" style={{ marginTop: 6 }}>
              次にやること：<b>{flow.current.name}</b>
              {/* 契約は案件の中のタブでは登録できない。契約の画面へ、相手先を入れた状態で移る。 */}
              {flow.current.action === "契約を登録する" && onRegisterAgreement ? (
                <button type="button" className="btn btn-sm primary" style={{ marginLeft: 8 }}
                        title="契約の画面へ移ります（相手先が入った状態）"
                        onClick={onRegisterAgreement}>契約を登録する</button>
              ) : flow.current.tab && onGo && (
                <button type="button" className="btn btn-sm primary" style={{ marginLeft: 8 }}
                        title={`${TAB_LABEL[flow.current.tab]}タブへ移ります`}
                        onClick={() => onGo(flow.current!.tab!)}>
                  {/* 押した先で何をするかを書く。段階の名前をもう一度出すと
                      「支払　支払タブを開く」のように重なって読みにくい。 */}
                  {flow.current.action ?? `${TAB_LABEL[flow.current.tab]}タブを開く`}
                </button>
              )}
            </div>
          : flow.steps.some((s) => s.optional && !s.done)
            ? <div className="trace-line" style={{ marginTop: 4, color: "var(--warn)" }}>
                工程は全部済。付帯する契約が終わるまで案件は開いたまま（回は支払文書処理で回す）
              </div>
            : <div className="trace-line" style={{ marginTop: 4, color: "var(--ok)" }}>
                すべて揃っています。案件を完了にできます
              </div>}
      </div>
    </div>
  );
}
