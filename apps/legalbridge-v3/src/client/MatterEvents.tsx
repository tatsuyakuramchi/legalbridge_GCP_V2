import { useEffect, useState } from "react";
import type { MatterDetail } from "../server/core/model.js";
import { ConditionEvents } from "./ConditionEvents.js";
import { CONDITION_KIND_LABEL } from "./labels.js";

/**
 * 案件の画面から実績を立てる。
 *
 * 実績は条件に付く（どの取り決めの実績か）。これまでは条件の画面まで移らないと
 * 記録できず、案件を見ながら「納品された」「売れた」を書く手が無かった。
 * ここは案件に繋がっている条件から1本選んで、条件の画面と同じ記録の欄を出す。
 * 同じ部品を使うので、実績から検収書・計算書を作る動線もそのまま効く。
 */
export function MatterEvents(
  { detail, conditionId, onPick, onCompose, onOpenDocument, onChanged }: {
    detail: MatterDetail;
    /** 条件明細タブの「実績」から渡された条件。無ければ先頭の生きている条件。 */
    conditionId: number | null;
    onPick: (conditionId: number) => void;
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
    onOpenDocument?: (documentId: number) => void;
    onChanged: () => void;
  }
) {
  const live = detail.conditions.filter((c) => c.status !== "void" && c.status !== "superseded");
  const [reloadKey, setReloadKey] = useState(0);
  // 既定は委託料・許諾料の条件。実費・手数料に実績を付けることは少ない。
  const primary = live.find((c) => c.kind !== "expense" && c.kind !== "fee") ?? live[0] ?? null;
  const chosen = live.find((c) => c.id === conditionId) ?? primary;

  useEffect(() => {
    if (chosen && chosen.id !== conditionId) onPick(chosen.id);
  }, [chosen?.id]);

  if (!live.length) {
    return (
      <div className="faint">
        実績を付ける条件がありません。先に条件明細タブで条件を作るか繋いでください。
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <label className="faint" htmlFor="matter-event-condition">実績を付ける条件</label>
        <select id="matter-event-condition" value={chosen?.id ?? ""}
                onChange={(e) => onPick(Number(e.target.value))}>
          {live.map((c) => (
            <option key={c.id} value={c.id}>
              {c.conditionNo ?? `#${c.id}`} ／ {CONDITION_KIND_LABEL[c.kind] ?? c.kind} ／ {c.name}
              {c.counterparty ? ` ／ ${c.counterparty.name}` : ""}
            </option>
          ))}
        </select>
      </div>
      <p className="faint" style={{ margin: 0 }}>
        実績はこの条件に付きます。定額の条件なら納品・検収を、料率の条件なら製造・販売・再許諾の受領を記録し、
        そこから検収書・計算書を作れます。
      </p>
      {chosen && (
        <ConditionEvents key={chosen.id}
          conditionId={chosen.id} currency={chosen.currency}
          editable={chosen.status === "active" || chosen.status === "draft"}
          matterId={detail.id} reloadKey={reloadKey}
          pricingModel={chosen.pricingModel} ratePpm={chosen.ratePpm}
          conditionUnitAmount={chosen.unitAmount} conditionQuantity={chosen.quantity}
          direction={chosen.direction}
          workTitle={chosen.work?.title ?? null} workId={chosen.work?.id ?? null}
          onCompose={onCompose} onOpenDocument={onOpenDocument}
          onChanged={() => { setReloadKey((v) => v + 1); onChanged(); }} />
      )}
    </div>
  );
}
