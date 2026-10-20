import { useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * 一括修正の残り（許諾期間の空・通知先の空・分かれた計算書）。タブの札に出す。
 * 3 つの道具の試算をそのまま数えるので、画面の中の表と同じ数になる。
 */
export function FixesBadge({ reloadKey }: { reloadKey?: number }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<{ targets: Array<{ skip: string | null }> }>("/conditions/term-default").then((r) => r.targets.filter((t) => !t.skip).length).catch(() => 0),
      api.get<{ targets: Array<{ skip: string | null }> }>("/notice-fill").then((r) => r.targets.filter((t) => !t.skip).length).catch(() => 0),
      api.get<{ groups: Array<{ status: string }> }>("/royalty-ledger/statements/merge").then((r) => r.groups.filter((g) => g.status === "ready").length).catch(() => 0)
    ]).then((xs) => { if (alive) setCount(xs.reduce((a, b) => a + b, 0)); });
    return () => { alive = false; };
  }, [reloadKey]);
  if (!count) return null;
  return <span className="tag warn" style={{ marginLeft: 4 }}>{count}</span>;
}
