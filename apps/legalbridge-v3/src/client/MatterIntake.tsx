import { useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * 案件の「受付」に繋がっている依頼。工程バーの「受付」を押すとここへ来る。
 * 依頼の中身は Backlog の原票の写しで、読むだけ（docs/v3-request-inbox.md）。
 */

interface Linked {
  id: number; requestNo: string | null; source: string; state: string; title: string;
  requesterName: string | null; backlogIssueKey: string | null; backlogStatus: string | null;
  hasUnseenUpdate: boolean; duplicateOfNo: string | null; handledAt: string | null; createdAt: string;
}

const SOURCE: Record<string, string> = { slack: "Slack", backlog: "Backlog", email: "メール", manual: "手動" };

export function MatterIntake({ matterId, reloadKey }: { matterId: number; reloadKey?: number }) {
  const [items, setItems] = useState<Linked[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api.get<{ items: Linked[] }>(`/matters/${matterId}/intake`).then((r) => setItems(r.items))
      .catch(() => setItems([]));   // 受付箱の表が無い環境では出さない
  }, [matterId, reloadKey, version]);

  if (!items || !items.length) return null;
  return (
    <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
      <b>受付した依頼 {items.length}</b>
      <table>
        <thead><tr><th>依頼</th><th>件名</th><th>経路</th><th>Backlog</th><th>受付</th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="code">{r.requestNo ?? `#${r.id}`}</div>
                {r.state === "duplicate" && <span className="tag ghost">{r.duplicateOfNo ?? ""} の重複</span>}
              </td>
              <td>{r.title}<div className="faint">{r.requesterName ?? ""}</div></td>
              <td className="faint">{SOURCE[r.source] ?? r.source}</td>
              <td>
                <span className="code">{r.backlogIssueKey ?? "—"}</span>
                {r.backlogStatus && <span className="faint">　{r.backlogStatus}</span>}
                {r.hasUnseenUpdate && (
                  <div>
                    <span className="tag warn">更新あり</span>{" "}
                    <button className="linky" onClick={() =>
                      api.post(`/intake/${r.id}/seen`, {}).then(() => setVersion((v) => v + 1)).catch(() => undefined)}>
                      確認した
                    </button>
                  </div>
                )}
              </td>
              <td className="faint code">{(r.handledAt ?? r.createdAt).slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
