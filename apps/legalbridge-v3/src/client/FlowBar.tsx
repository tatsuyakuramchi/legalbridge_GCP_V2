/**
 * 契約 → 条件明細 → 文書 → 送信 と順に進めている途中であることを、画面の上に出す帯。
 *
 * 文書は「文書」の画面で作る。取引・契約・条件明細の画面から「文書を作る」で移ると、
 * 左のメニューの「文書」を押したときと同じ画面が開き、どこから来て次に何をするのかが
 * 画面から消えていた（一覧が出て、作る前の流れに戻る道も無い）。
 * 流れの途中なら、いまどの段階か・済んだ段階・戻る先をここに出す。
 */
export interface DocFlow {
  /** どの流れの途中か（「取引を進める」「契約 K-001」など）。 */
  title: string;
  /** 段階の名前。左から順に進む。最後の段階は「送る」。 */
  steps: string[];
  /** 文書の画面に来た時点の段階（0 始まり）。 */
  step: number;
  /** 流れの元の画面へ戻る。 */
  back: { label: string; go: () => void };
  /** 文書を決定したとき。元の画面の進み具合を先へ進める（戻ったときに続きから）。 */
  onIssued?: (documentId: number) => void;
}

/**
 * 条件の向きと種類から、次に作る文書のひな形を推す。
 * 委託料・実費・手数料（IN）は発注書、許諾（IN）は個別利用許諾条件書、許諾（OUT）は利用許諾条件書。
 * 推せなければ null（文書の画面の既定のひな形になる）。止めたひな形なら文書の画面が既定に戻す。
 */
export const templateKeyFor = (direction: string | null | undefined, kind: string | null | undefined): string | null => {
  if (direction === "in" && (kind === "service" || kind === "expense" || kind === "fee")) return "purchase_order";
  if (kind === "license") return direction === "out" ? "pub_license_terms_v3" : "individual_license_terms_v4";
  return null;
};

/** 文書がどこまで進んだか。帯の「いま」と案内文を決める。 */
export type FlowPhase = "compose" | "issued" | "sent";

/**
 * 決定したあとに「いま」になる段階。次の段階が最後（送る）ならそこへ進む。
 * そうでなければ（取引の「基本契約書を作る」など、送るまでにまだ段階がある）いまの段階に留まる。
 */
export const flowStepAfterIssue = (flow: DocFlow) =>
  flow.step + 1 === flow.steps.length - 1 ? flow.steps.length - 1 : Math.min(flow.step, flow.steps.length - 1);

export function FlowBar({ flow, phase, onBack }: {
  flow: DocFlow;
  phase: FlowPhase;
  /** 戻る前に確かめたいことがあれば（保存していない変更）。無ければ flow.back.go。 */
  onBack?: () => void;
}) {
  const last = flow.steps.length - 1;
  const current = phase === "compose" ? Math.min(flow.step, last) : flowStepAfterIssue(flow);
  const finished = phase === "sent" && current === last;
  const guide = phase === "sent"
    ? `送りました。「${flow.back.label}に戻る」で元の画面の続きへ`
    : phase === "issued"
      ? `決定しました。下の「送る」から送れます。あとでまとめて送るなら、そのまま「${flow.back.label}に戻る」`
      : current >= last
        ? `残りは${flow.steps[last]}だけです。下の「送る」から進めます`
        : `${flow.steps[current]}の段階です。決定すると、この画面のまま送れます`;
  return (
    <div className="flow-bar" role="navigation" aria-label={`${flow.title} の進み具合`}>
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 12.5 }}>{flow.title}</b>
        <div className="pipe" style={{ flex: "1 1 320px" }}>
          {flow.steps.map((name, i) => {
            const done = finished || i < current;
            const now = !finished && i === current;
            return (
              <div key={name} className={`pipe-step${now ? " flag" : ""}`}
                   style={done ? { background: "var(--ok-soft)", borderColor: "var(--ok)" } : undefined}
                   aria-current={now ? "step" : undefined}>
                <span className="st">{done ? "済" : now ? "いま" : i + 1}</span>
                <span className="nm">{name}</span>
              </div>
            );
          })}
        </div>
        <button className={`btn btn-sm${phase === "compose" ? "" : " primary"}`} onClick={onBack ?? flow.back.go}>
          ← {flow.back.label}に戻る
        </button>
      </div>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>{guide}</div>
    </div>
  );
}
