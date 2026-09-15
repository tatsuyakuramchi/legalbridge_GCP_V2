import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

interface Spec {
  kind: "parties" | "works"; label: string;
  required: string[]; optional: string[]; sample: string;
}
interface RowOutcome {
  line: number; status: "ok" | "duplicate" | "error";
  label: string; message?: string; id?: number; code?: string | null;
}
interface Report {
  kind: string; dryRun: boolean; total: number;
  ok: number; duplicate: number; error: number; rows: RowOutcome[];
}

const STATUS_LABEL: Record<RowOutcome["status"], string> = {
  ok: "登録できる", duplicate: "重複", error: "エラー"
};

/**
 * CSV の一括取込。
 *
 * 試算を通さないと登録できない。500行を書いてから結果を見るのでは、
 * マスタを壊したあとにしか気づけない。
 */
export function CsvImport() {
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [kind, setKind] = useState<"parties" | "works">("parties");
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ specs: Spec[] }>("/imports").then((r) => setSpecs(r.specs)).catch(() => setSpecs([]));
  }, []);

  const spec = specs.find((s) => s.kind === kind);
  // 試算が済んで、登録できる行があるときだけ本番に進める。
  const canApply = report !== null && report.dryRun && report.ok > 0;

  async function run(dryRun: boolean) {
    setBusy(true); setError(null);
    try {
      setReport(await api.post<Report>("/imports", { kind, csv, dryRun }));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setReport(null); }
    finally { setBusy(false); }
  }

  async function pickFile(file: File) {
    setCsv(await file.text());
    setReport(null);
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>CSV 取込</h2>
        <span className="faint">試算してから登録する</span>
      </div>
      <div className="panel-bd">
        <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label className="field">
            <span>種類</span>
            <select value={kind} onChange={(e) => {
              setKind(e.target.value as "parties" | "works"); setReport(null);
            }}>
              {specs.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>ファイル</span>
            <input type="file" accept=".csv,text/csv"
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); }} />
          </label>
        </div>

        {spec && (
          <p className="faint">
            必須の見出し: <b>{spec.required.join("、")}</b>
            {spec.optional.length > 0 && <>／任意: {spec.optional.join("、")}</>}
            <button className="btn btn-sm" style={{ marginLeft: 8 }}
                    onClick={() => { setCsv(spec.sample); setReport(null); }}>
              見本を入れる
            </button>
          </p>
        )}

        <label className="field wide">
          <span>中身（貼り付けても良い）</span>
          <textarea rows={8} value={csv} spellCheck={false}
                    onChange={(e) => { setCsv(e.target.value); setReport(null); }}
                    placeholder={spec?.sample} />
        </label>

        <div className="row" style={{ marginTop: 12, gap: 10, alignItems: "center" }}>
          <button className="btn" onClick={() => run(true)} disabled={busy || !csv.trim()}>
            {busy ? "確認中…" : "試算する"}
          </button>
          <button className="btn primary" onClick={() => run(false)} disabled={busy || !canApply}>
            登録する{report?.dryRun ? `（${report.ok} 件）` : ""}
          </button>
          {!canApply && csv.trim() && (
            <span className="faint">まず試算してください。結果を見ないと登録できません</span>
          )}
        </div>

        {error && <div className="alert">{error}</div>}

        {report && (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ gap: 14 }}>
              <b>{report.dryRun ? "試算の結果" : "登録しました"}</b>
              <span>{report.total} 行</span>
              <span className="good">登録できる {report.ok}</span>
              {report.duplicate > 0 && <span>重複 {report.duplicate}</span>}
              {report.error > 0 && <span className="danger">エラー {report.error}</span>}
            </div>

            {report.rows.some((r) => r.status !== "ok") && (
              <div className="tablewrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr><th>行</th><th>状態</th><th>対象</th><th>内容</th></tr>
                  </thead>
                  <tbody>
                    {report.rows.filter((r) => r.status !== "ok").map((r) => (
                      <tr key={r.line} className={r.status === "error" ? "overdue" : undefined}>
                        <td className="num">{r.line}</td>
                        <td>{STATUS_LABEL[r.status]}</td>
                        <td>{r.label || "—"}</td>
                        <td className="faint">{r.message ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.dryRun && report.error > 0 && (
              <p className="faint">
                エラーの行は登録されない。直してから取り込み直すか、そのまま登録して
                残りだけ入れることもできる。
              </p>
            )}
            {!report.dryRun && (
              <p className="faint">重複とエラーの行は登録していない。上の一覧で確認すること。</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
