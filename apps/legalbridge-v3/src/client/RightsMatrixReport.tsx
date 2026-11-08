import { useEffect, useMemo, useState } from "react";

/**
 * 許諾地域・許諾言語レポート（ひな形 rights_matrix_report。server/works/rights-matrix-report.ts）。
 *
 * 「地域×言語」の表（作品 1 点・作品をまたぐ一覧）の下に置き、いま画面に出ている絞り込みのまま
 * プレビュー（HTML）と PDF を出す。備考は表の下に刷る。読むだけで、文書の番号は振らない。
 *
 *   path  … "/works/12/rights-matrix/report" か "/works-rights-matrix/report"（/html・/pdf を足す）
 *   query … 画面の絞り込み（ended・party・region…）。変わるとプレビューを閉じる
 */
export function RightsMatrixReport({ path, query, hint }: { path: string; query: URLSearchParams; hint?: string }) {
  const [open, setOpen] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = query.toString();
  const qs = useMemo(() => {
    const q = new URLSearchParams(base);
    if (remarks.trim()) q.set("remarks", remarks.trim());
    return q.toString();
  }, [base, remarks]);
  // 絞り込みや備考が変わったら、古いプレビューは出さない。
  useEffect(() => { setPreview(null); }, [qs, path]);

  async function showPreview() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/v3${path}/html${qs ? `?${qs}` : ""}`);
      const text = await response.text();
      if (!response.ok) {
        let message = "プレビューを作れませんでした";
        try { message = JSON.parse(text).error ?? message; } catch { /* 本文が JSON でない */ }
        throw new Error(message);
      }
      setPreview(text);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="row no-print" style={{ gap: 8, alignItems: "center" }}>
        <button className="btn btn-sm" onClick={() => setOpen(true)} title="いまの表を A4 横のレポート（HTML・PDF）にする">
          レポート（印刷・PDF）
        </button>
        {hint && <span className="faint">{hint}</span>}
      </div>
    );
  }

  return (
    <div className="panel no-print">
      <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>レポート（印刷・PDF）</h2>
        <span className="faint">いま出ている絞り込みのまま、A4 横の「許諾地域・許諾言語レポート」にします</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => { setOpen(false); setPreview(null); }}>閉じる</button>
      </div>
      <div className="panel-bd stack" style={{ gap: 8 }}>
        <label className="field">
          <span>備考（表の下に出る）</span>
          <textarea rows={2} value={remarks} maxLength={2000} onChange={(e) => setRemarks(e.target.value)}
                    placeholder="例：2026年下期の更新候補を確認するために出力" />
        </label>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={showPreview} disabled={busy}>{busy ? "作成中…" : "プレビュー"}</button>
          <a className="btn primary" href={`/api/v3${path}/pdf${qs ? `?${qs}` : ""}`}>PDF をダウンロード</a>
          {hint && <span className="faint">{hint}</span>}
        </div>
        {error && <div className="alert">{error}</div>}
        {preview && (
          <iframe className="preview" title="許諾地域・許諾言語レポートのプレビュー" srcDoc={preview}
                  style={{ width: "100%", minHeight: 640, border: "1px solid #ddd", background: "#fff" }} />
        )}
      </div>
    </div>
  );
}
