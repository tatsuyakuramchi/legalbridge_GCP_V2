import { useState } from "react";
import { SearchableLedgerSelect } from "./SearchableLedgerSelect";
import { FeatureLockedNote } from "./FeatureLockedNote";

// 取引先マージ（名寄せ・Phase 4）。存続先(target)へ統合元(source)を寄せる。
// プレビュー（再指定される参照件数）→ 合言葉入力 → 実行。旧はis_active=falseで残る。
// canMerge=false（capability未付与）ではプレビューまで（実行ボタン非表示）。

const TOKEN = "COMMIT_VENDOR_MERGE";
type VendorRef = { id: number; vendorName: string | null; vendorCode: string | null; isActive: boolean | null };
type RefCount = { table: string; column: string; label: string; count: number | null };
type Preview = { target: VendorRef; source: VendorRef; references: RefCount[]; totalReferences: number };

export function VendorMerge({ canMerge = false, initialSource = "" }: { canMerge?: boolean; initialSource?: string }) {
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
    if (targetId === sourceId) { setError("同一の取引先はマージできません"); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/v2/vendor-merge/preview?targetId=${targetId}&sourceId=${sourceId}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? (res.status === 403 ? "権限がありません" : res.status === 404 ? "取引先が見つかりません" : "取得に失敗しました"));
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
      const res = await fetch("/api/v2/vendor-merge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: Number(targetId), sourceId: Number(sourceId), confirmation: token })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "マージに失敗しました"); return; }
      setResult(`統合完了：${data.totalRepointed}件の参照を存続先へ再指定し、統合元を無効化しました。`);
      setPreview(null); setToken("");
    } catch { setError("通信に失敗しました"); }
    finally { setMerging(false); }
  }

  const vendorLabel = (v: VendorRef) => `${v.vendorCode ? v.vendorCode + " " : ""}${v.vendorName ?? `取引先#${v.id}`}`;

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <p>VENDOR MERGE</p>
          <h1>取引先の名寄せ</h1>
          <small>重複した取引先を1つに統合します。参照を存続先へ再指定し、統合元は無効化（削除せず保持）します。</small>
        </div>
      </div>

      <div className="vm-inputs">
        <SearchableLedgerSelect type="vendors" value={targetId}
          label="存続先（残す）" placeholder="名前・コードで検索"
          onChange={(value) => setTargetId(value)} />
        <SearchableLedgerSelect type="vendors" value={sourceId}
          label="統合元（寄せる・無効化される）" placeholder="名前・コードで検索"
          onChange={(value) => setSourceId(value)} />
        <button className="primary" onClick={runPreview} disabled={loading}>{loading ? "確認中…" : "プレビュー"}</button>
      </div>

      {error && <div className="async-error"><span>{error}</span></div>}
      {result && <div className="vm-result">{result}</div>}

      {preview && <>
        <div className="vm-vendors">
          <article><span>存続先</span><strong>{vendorLabel(preview.target)}</strong>{preview.target.isActive === false && <em>（無効）</em>}</article>
          <article className="warn"><span>統合元（無効化される）</span><strong>{vendorLabel(preview.source)}</strong></article>
        </div>
        <table className="vm-refs">
          <thead><tr><th>参照</th><th>テーブル.列</th><th>再指定件数</th></tr></thead>
          <tbody>{preview.references.map((r) => <tr key={`${r.table}.${r.column}`}>
            <td>{r.label}</td><td className="muted">{r.table}.{r.column}</td>
            <td>{r.count == null ? "権限未付与" : r.count}</td>
          </tr>)}</tbody>
          <tfoot><tr><td colSpan={2}><b>合計</b></td><td><b>{preview.totalReferences}</b></td></tr></tfoot>
        </table>

        {canMerge ? (
          <div className="vm-confirm">
            <p>実行すると <b>{vendorLabel(preview.source)}</b> の参照 {preview.totalReferences} 件を <b>{vendorLabel(preview.target)}</b> へ再指定し、統合元を無効化します。取り消すには参照を手動で戻す必要があります。</p>
            <label>確認のため <code>{TOKEN}</code> と入力
              <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={TOKEN} />
            </label>
            <button className="primary" onClick={runMerge} disabled={merging || token !== TOKEN}>{merging ? "統合中…" : "名寄せを実行"}</button>
          </div>
        ) : (
          <FeatureLockedNote>名寄せの実行は現在ご利用いただけません（プレビューのみ表示）。管理者が設定で有効化できます。</FeatureLockedNote>
        )}
      </>}
    </section>
  );
}
