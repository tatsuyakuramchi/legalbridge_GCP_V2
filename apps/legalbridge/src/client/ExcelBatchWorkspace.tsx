import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { exportExcel, type ExportColumn } from "./export-util";

// Excel 一括出力（Phase 10-5）。検収書・利用許諾料計算書を「種別×担当者×支払期日」で束ねて表示し、
// グループ単位で Excel（client 生成・依存ゼロ）を出力。任意で「発行済み」にして保留から外す。

type BatchItem = { documentNumber: string; inspectionDate: string; title: string; counterparty: string };
type BatchGroup = {
  key: string;
  category: "inspection_certificate" | "royalty_statement";
  inspectorEmail: string;
  inspectorName: string;
  paymentDate: string;
  count: number;
  documentNumbers: string[];
  items: BatchItem[];
};

const CATEGORY_LABEL: Record<BatchGroup["category"], string> = {
  inspection_certificate: "検収書",
  royalty_statement: "利用許諾料計算書"
};

const itemColumns: ExportColumn<BatchItem>[] = [
  { header: "文書番号", value: (r) => r.documentNumber },
  { header: "検収日/発行日", value: (r) => r.inspectionDate },
  { header: "件名", value: (r) => r.title },
  { header: "取引先", value: (r) => r.counterparty }
];

export function ExcelBatchWorkspace({ canMark = false }: { canMark?: boolean }) {
  const [groups, setGroups] = useState<BatchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busyKey, setBusyKey] = useState("");
  const toast = useToast();

  useEffect(() => {
    setLoading(true); setError("");
    fetch("/api/v2/documents/excel-batches")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setGroups(d.groups ?? []))
      .catch(() => setError("集計を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, [reload]);

  function downloadGroup(g: BatchGroup) {
    const date = g.paymentDate || "no-date";
    const name = `${CATEGORY_LABEL[g.category]}_${g.inspectorName}_${date}`.replace(/[^\w.\-一-龥ぁ-んァ-ン]/g, "_");
    exportExcel(name, CATEGORY_LABEL[g.category], itemColumns, g.items);
  }

  async function markGroup(g: BatchGroup) {
    setBusyKey(g.key);
    try {
      const response = await fetch("/api/v2/documents/excel-batches/mark", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentNumbers: g.documentNumbers, batchKey: g.key })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "発行済み記録に失敗しました。", "error"); return; }
      toast.push(`${data.recorded}件を発行済みにしました。`, "success");
      setReload((v) => v + 1);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusyKey(""); }
  }

  return <section className="page">
    <div className="page-title">
      <div><p>EXCEL BATCH</p><h1>Excel一括出力</h1>
        <small>未出力の検収書・利用許諾料計算書を担当者×支払期日でまとめてExcel化します</small></div>
      <button onClick={() => setReload((v) => v + 1)}>再読込</button>
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((v) => v + 1)}>再試行</button></div>}
    {loading && <p className="hub-note">集計中…</p>}
    {!loading && !groups.length && <EmptyState icon="▤" title="未出力の対象がありません"
      description="確定済みの検収書・利用許諾料計算書がすべて出力済みか、対象がありません。" />}
    <div className="batch-groups">
      {groups.map((g) => <div key={g.key} className="panel batch-group">
        <div className="batch-group-head">
          <div>
            <span className="registry-state complete">{CATEGORY_LABEL[g.category]}</span>
            <strong> {g.inspectorName}</strong>
            <span className="muted"> ｜支払期日 {g.paymentDate || "未設定"} ｜{g.count}件</span>
          </div>
          <div className="batch-group-actions">
            <button className="primary" onClick={() => downloadGroup(g)}>Excel出力（{g.count}件）</button>
            {canMark && <button disabled={busyKey === g.key} onClick={() => void markGroup(g)}>
              {busyKey === g.key ? "記録中…" : "発行済みにする"}
            </button>}
          </div>
        </div>
        <div className="condition-table-wrap"><table className="condition-table">
          <thead><tr><th>文書番号</th><th>検収日/発行日</th><th>件名</th><th>取引先</th></tr></thead>
          <tbody>{g.items.slice(0, 50).map((it) => <tr key={it.documentNumber}>
            <td><b>{it.documentNumber}</b></td><td>{it.inspectionDate || "—"}</td>
            <td>{it.title || "—"}</td><td>{it.counterparty || "—"}</td>
          </tr>)}</tbody>
        </table>{g.items.length > 50 && <p className="import-preview-note">ほか {g.items.length - 50}件…</p>}</div>
      </div>)}
    </div>
  </section>;
}
