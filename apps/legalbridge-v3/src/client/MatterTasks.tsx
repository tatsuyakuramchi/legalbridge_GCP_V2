import { useState } from "react";
import type { MatterDetail } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { StatusTag } from "./labels.js";
import { StatusPicker } from "./DailyTasksWorkspace.js";

/**
 * 案件の「作業」タブ（A-064）。案件の中の作業を並べ、状態を変える。
 * 状態はデイリータスクと同じ 未着手・作業中・待ち・完了 の 4 つ。案件の状態（対応中など）は
 * 全体の見出しで、作業はその中の一つひとつの手順。
 */
export function MatterTasks(
  { detail, canWrite, onChanged, onAdd }: {
    detail: MatterDetail; canWrite: boolean; onChanged: () => void; onAdd?: () => void;
  }
) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const open = detail.tasks.filter((t) => t.status !== "done");
  const late = open.filter((t) => t.dueAt && t.dueAt.slice(0, 10) < today);

  const setStatus = async (id: number, status: string) => {
    setBusy(id); setError(null);
    try { await api.patch(`/tasks/${id}`, { status }); setEditing(null); onChanged(); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 12 }}>
        <span className="faint">
          案件の状態は全体の見出し、作業は一つひとつの手順です。すべての作業が完了したら、案件の状態を「完了」にしてください。
        </span>
        <span className="faint" style={{ marginLeft: "auto" }}>残り <b>{open.length}</b></span>
        <span className="faint">期限切れ <b className={late.length ? "danger" : ""}>{late.length}</b></span>
        {canWrite && onAdd && <button className="btn btn-sm" onClick={onAdd}>作業を追加</button>}
      </div>
      {error && <div className="alert">{error}</div>}
      <table>
        <thead><tr><th>作業</th><th>担当</th><th>期日</th><th>状態</th><th></th></tr></thead>
        <tbody>
          {detail.tasks.map((t) => {
            const overdue = t.status !== "done" && t.dueAt && t.dueAt.slice(0, 10) < today;
            return (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td className="faint">{t.assigneeName ?? "未定"}</td>
                <td className={overdue ? "danger" : "faint"}>{t.dueAt ? t.dueAt.slice(0, 10) : "—"}</td>
                <td>
                  {editing === t.id
                    ? <StatusPicker value={t.status} disabled={busy === t.id} onPick={(s) => setStatus(t.id, s)} />
                    : <StatusTag kind="task" value={t.status} />}
                </td>
                <td style={{ textAlign: "right" }}>
                  {canWrite && (
                    <button className="btn btn-sm" disabled={busy === t.id}
                            onClick={() => setEditing(editing === t.id ? null : t.id)}>
                      {editing === t.id ? "閉じる" : "状態を変える"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {!detail.tasks.length && (
            <tr><td colSpan={5} className="faint">作業はまだありません。「作業を追加」で手順を並べると、期限一覧と日次の点検に出ます。</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
