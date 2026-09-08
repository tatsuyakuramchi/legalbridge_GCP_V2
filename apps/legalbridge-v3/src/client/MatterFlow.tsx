import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 案件の進み具合。
 *
 * これまでは段階を並べただけで、どこまで進んだかは示していなかった。
 * 段階はデータベースに持たず、その案件に何が揃っているかから導く。
 * 「済」の根拠を一緒に出すので、印が合っているかを画面で確かめられる。
 */

interface FlowStep { no: number; name: string; done: boolean; detail: string }
interface Flow { steps: FlowStep[]; current: FlowStep | null }

export function MatterFlow({ matterId, reloadKey }: { matterId: number; reloadKey: number }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.get<Flow>(`/matters/${matterId}/flow`)
      .then(setFlow).catch((e: ApiError) => setError(e.message));
  }, [matterId, reloadKey]);

  if (error) return <div className="alert">{error}</div>;
  if (!flow) return null;

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="pipe">
        {flow.steps.map((step) => {
          const current = flow.current?.no === step.no;
          return (
            <div key={step.no}
                 className={`pipe-step${current ? " flag" : ""}`}
                 title={step.detail}
                 style={step.done ? { background: "var(--ok-soft)", borderColor: "var(--ok)" } : undefined}>
              <span className="st">
                {step.done ? "済" : current ? "いま" : step.no}
              </span>
              <span className="nm">{step.name}</span>
            </div>
          );
        })}
      </div>

      <div className="trace">
        {flow.steps.map((step) => (
          <div key={step.no} className="trace-line">
            <span style={{ color: step.done ? "var(--ok)" : "var(--faint)", marginRight: 6 }}>
              {step.done ? "✓" : "—"}
            </span>
            <b>{step.name}</b>
            <span className="faint" style={{ marginLeft: 8 }}>{step.detail}</span>
          </div>
        ))}
        {flow.current
          ? <div className="trace-line" style={{ marginTop: 4 }}>
              次にやること：<b>{flow.current.name}</b>
            </div>
          : <div className="trace-line" style={{ marginTop: 4, color: "var(--ok)" }}>
              すべて揃っています。案件を完了にできます
            </div>}
      </div>
    </div>
  );
}
