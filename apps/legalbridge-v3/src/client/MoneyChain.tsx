import { chainIndexOf, moneyChain, type ChainTab } from "../server/matters/money-chain.js";
import type { MatterKind } from "../server/core/model.js";

/**
 * お金の流れの道しるべ（案件の中身のタブの下）。
 *
 * 条件明細・実績・文書・支払は別のタブなので、1つずつ見ていると順番が
 * 分からなくなる。とくに実績と支払の間に文書（検収書・計算書）が挟まるのが
 * 見えず、実績から直接支払を立てようとして手が止まっていた。
 *
 * いつも同じ順番を出し、いまいる場所に印を付け、そこで何をするかを1行で言う。
 * 案件に戻れば流れを思い出せるように、どのタブにいても出したままにする。
 */
export function MoneyChain(
  { kind, tab, onGo }: {
    kind: MatterKind;
    /** いま開いているタブ。流れの外（操作の記録・整理）でも出す。 */
    tab: string;
    onGo: (tab: ChainTab) => void;
  }
) {
  const steps = moneyChain(kind);
  if (!steps.length) return null;
  const here = chainIndexOf(steps, tab);
  const current = here >= 0 ? steps[here] : null;

  return (
    <div className="chain">
      <span className="chain-label">お金の流れ</span>
      {steps.map((step, i) => (
        <span key={step.tab} className="chain-item">
          {i > 0 && <span className="chain-arrow" aria-hidden="true">›</span>}
          <button type="button" className="chain-step" aria-current={i === here ? "step" : undefined}
                  title={step.hint} onClick={() => onGo(step.tab)}>
            {step.label}
          </button>
        </span>
      ))}
      {/* いまいる段でやることだけを出す。4段ぶん並べると誰も読まない。 */}
      <span className="chain-hint">
        {current ? current.hint : "この流れで 条件明細 → 実績 → 文書 → 支払 と進みます"}
      </span>
    </div>
  );
}
