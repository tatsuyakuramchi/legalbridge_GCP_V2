import { useState } from "react";

// 案件マージ（名寄せ・Phase 8-5）。存続先(target)へ統合元(source)を寄せる。
// プレビュー（移送される紐付き件数）→ 合言葉入力 → 実行。統合元は status='archived' で残る（削除しない）。
// canMerge=false（capability未付与）ではプレビューまで（実行ボタン非表示）。

const TOKEN = "COMMIT_MATTER_MERGE";
type MatterRef = { id: number; matterCode: string | null; title: string; status: string; driveFolderId: string | null };
type MergeCount = { key: string; label: string; count: number | null };
type Preview = { target: MatterRef; source: MatterRef; counts: MergeCount[]; totalMovable: number };

export function MatterMerge({ canMerge = false, initialSource = "" }: { canMerge?: boolean; initialSource?: string }) {
  const [targetId, setTargetId] = useState("");
  const [sourceId, setSourceId] = useState(initialSource);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<string>("");
  const [merging, setMerging] = useState(false);

  async function runPreview() {
    setError(""); setPreview(null); setResult("");
    if (!/^\d+$/.test(targetId) || !/^\d+$/.test(sourceId)) { setError("存続先・統合元のIDを入力してください"); return; }
    if (targetId === sourceId) { setError("同一の案件はマージできません"); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/v2/matter-merge/preview?targetId=${targetId}&sourceId=${sourceId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? (res.status === 403 ? "権限がありません" : res.status === 404 ? "案件が見つかりません" : "取得に失敗しました"));
        return;
      }
      const data = await res.json();
      setPreview(data.preview);
    } catch { setError("通信に失敗しました"); }
    finally { setLoading(false); }
  }

  async function runMerge() {
    if (!preview) return;
    setMerging(true); setError(""); setResult("");
    try {
      const res = await fetch("/api/v2/matter-merge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: Number(targetId), sourceId: Number(sourceId), confirmation: token })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "マージに失敗しました"); return; }
      const folderNote = data.folderAction === "adopted" ? "（Driveフォルダを引継ぎ）" : "";
      setResult(`統合完了：${data.totalMoved}件の紐付きを存続先へ移送し、統合元をアーカイブしました${folderNote}。`);
      setPreview(null); setToken("");
    } catch { setError("通信に失敗しました"); }
    finally { setMerging(false); }
  }

  const matterLabel = (m: MatterRef) => `${m.matterCode ? m.matterCode + " " : ""}${m.title || `案件#${m.id}`}`;

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>MATTER MERGE</p>
          <h1>案件の名寄せ</h1>
          <small>重複した案件を1つに統合します。課題・タスク・文書・送信履歴を存続先へ移送し、統合元はアーカイブ（削除せず保持）します。</small>
        </div>
      </div>

      <div className="vm-inputs">
        <label>存続先ID（残す）<input value={targetId} onChange={(e) => setTargetId(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="target" /></label>
        <label>統合元ID（寄せる）<input value={sourceId} onChange={(e) => setSourceId(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" placeholder="source" /></label>
        <button className="primary" onClick={runPreview} disabled={loading}>{loading ? "確認中…" : "プレビュー"}</button>
      </div>

      {error && <div className="async-error"><span>{error}</span></div>}
      {result && <div className="vm-result">{result}</div>}

      {preview && <>
        <div className="vm-vendors">
          <article><span>存続先</span><strong>{matterLabel(preview.target)}</strong>{preview.target.status === "archived" && <em>（アーカイブ済）</em>}</article>
          <article className="warn"><span>統合元（アーカイブされる）</span><strong>{matterLabel(preview.source)}</strong></article>
        </div>
        <table className="vm-refs">
          <thead><tr><th>紐付き</th><th>移送件数</th></tr></thead>
          <tbody>{preview.counts.map((c) => <tr key={c.key}>
            <td>{c.label}</td>
            <td>{c.count == null ? "権限未付与" : c.count}</td>
          </tr>)}</tbody>
          <tfoot><tr><td><b>合計</b></td><td><b>{preview.totalMovable}</b></td></tr></tfoot>
        </table>

        {canMerge ? (
          <div className="vm-confirm">
            <p>実行すると <b>{matterLabel(preview.source)}</b> の紐付き {preview.totalMovable} 件を <b>{matterLabel(preview.target)}</b> へ移送し、統合元をアーカイブします。取り消すには紐付きを手動で戻す必要があります。</p>
            <label>確認のため <code>{TOKEN}</code> と入力
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={TOKEN} />
            </label>
            <button className="primary" onClick={runMerge} disabled={merging || token !== TOKEN}>{merging ? "統合中…" : "名寄せを実行"}</button>
          </div>
        ) : (
          <small className="hint">名寄せの実行権限（capability `matter-merge` / grant 025・026・028）が未付与のため、プレビューのみ表示しています。</small>
        )}
      </>}
    </section>
  );
}
