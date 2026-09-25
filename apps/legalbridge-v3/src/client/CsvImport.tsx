import { useEffect, useState } from "react";
import { CsvBar } from "./CsvBar.js";
import { useReadOnly } from "./read-only.js";
import { api, ApiError } from "./api.js";

interface Spec {
  kind: string; label: string;
  required: string[]; optional: string[]; sample: string;
  updatable?: boolean; updateColumns?: string[]; updateSample?: string; updateHint?: string;
}
type Mode = "create" | "update";
interface RowOutcome {
  line: number; status: "ok" | "duplicate" | "skip" | "error";
  label: string; message?: string; id?: number; code?: string | null;
}
interface Report {
  kind: string; mode: Mode; dryRun: boolean; total: number;
  ok: number; duplicate: number; skipped: number; error: number; rows: RowOutcome[];
}

const STATUS_LABEL: Record<Mode, Record<RowOutcome["status"], string>> = {
  create: { ok: "登録できる", duplicate: "重複", skip: "変更なし", error: "エラー" },
  update: { ok: "更新できる", duplicate: "重複", skip: "変更なし", error: "エラー" }
};

/**
 * CSV の一括取込。
 *
 * 試算を通さないと登録できない。500行を書いてから結果を見るのでは、
 * マスタを壊したあとにしか気づけない。
 */
export function CsvImport({ initialKind }: { initialKind?: string } = {}) {
  const readOnly = useReadOnly();
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [kind, setKind] = useState<string>(initialKind ?? "parties");
  /**
   * 新しく作るのか、既に登録してあるものに当てるのか。
   * 備考や著作権表示だけをまとめて入れたい用が「新規登録」では通らなかった。
   */
  const [mode, setMode] = useState<Mode>("create");
  const [csv, setCsv] = useState("");
  /** 選んだファイルの名前。選んだかどうかが読めないと、貼り付けと見分けがつかない。 */
  const [picked, setPicked] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ specs: Spec[] }>("/imports").then((r) => setSpecs(r.specs)).catch(() => setSpecs([]));
  }, []);

  const spec = specs.find((s) => s.kind === kind);
  const updating = mode === "update";
  const sample = (updating && spec?.updateSample) || spec?.sample || "";
  // 試算が済んで、入れられる行があるときだけ本番に進める。
  const canApply = report !== null && report.dryRun && report.ok > 0;

  async function run(dryRun: boolean) {
    setBusy(true); setError(null);
    try {
      setReport(await api.post<Report>("/imports", { kind, csv, dryRun, mode }));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setReport(null); }
    finally { setBusy(false); }
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
              setKind(e.target.value); setReport(null);
              // 更新できない種類に移ったら新規登録に戻す。
              if (!specs.find((s) => s.kind === e.target.value)?.updatable) setMode("create");
            }}>
              {specs.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
            </select>
          </label>
          {spec?.updatable && (
            <label className="field">
              <span>取り込み方</span>
              <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); setReport(null); }}>
                <option value="create">新しく登録する</option>
                <option value="update">登録済みに当てる（備考だけ、などの一括更新）</option>
              </select>
            </label>
          )}
        </div>

        {/* 出す・入れるを分けて出す。見本は「雛形（空）」の段に置く。 */}
        <CsvBar style={{ margin: "10px 0" }}
          onPick={(text, name) => { setCsv(text); setPicked(name); setReport(null); }}
          picked={picked}
          onClearPick={() => { setCsv(""); setPicked(null); setReport(null); }}
          templates={spec
            ? [{ label: `${spec.label}の見本`,
                 href: `data:text/csv;charset=utf-8,${encodeURIComponent("\ufeff" + sample)}`,
                 download: `${spec.kind}${updating ? "-update" : ""}.csv` }]
            : undefined}
          note="UTF-8 か Shift_JIS。下の欄に貼り付けても同じです" />

        {spec && (
          <p className="faint">
            {updating ? (
              <>
                {spec.updateHint}。書き換えられる列: {(spec.updateColumns ?? []).join("、")}。
                <b>空欄の列は触りません</b>（空にして消すことはできません）
              </>
            ) : (
              <>
                必須の見出し: <b>{spec.required.join("、")}</b>
                {spec.optional.length > 0 && <>／任意: {spec.optional.join("、")}</>}
              </>
            )}
            <button className="btn btn-sm" style={{ marginLeft: 8 }}
                    onClick={() => { setCsv(sample); setReport(null); }}>
              見本を入れる
            </button>
          </p>
        )}

        <label className="field wide">
          <span>中身（貼り付けても良い）</span>
          <textarea rows={8} value={csv} spellCheck={false}
                    onChange={(e) => { setCsv(e.target.value); setReport(null); }}
                    placeholder={sample} />
        </label>

        <div className="row" style={{ marginTop: 12, gap: 10, alignItems: "center" }}>
          <button className="btn" onClick={() => run(true)} disabled={busy || !csv.trim()}>
            {busy ? "確認中…" : "試算する"}
          </button>
          <button className="btn primary" onClick={() => run(false)} disabled={busy || readOnly || !canApply}
                  title={readOnly ? "いまは読み取り専用です。試算までで、登録は本番で" : undefined}>
            {updating ? "更新する" : "登録する"}{report?.dryRun ? `（${report.ok} 件）` : ""}
          </button>
          {readOnly && <span className="faint">いまは読み取り専用です。試算まで</span>}
          {!canApply && csv.trim() && (
            <span className="faint">まず試算してください。結果を見ないと登録できません</span>
          )}
        </div>

        {error && <div className="alert">{error}</div>}

        {report && (
          <div style={{ marginTop: 14 }}>
            <div className="row" style={{ gap: 14 }}>
              <b>{report.dryRun ? "試算の結果" : report.mode === "update" ? "更新しました" : "登録しました"}</b>
              <span>{report.total} 行</span>
              <span className="good">
                {STATUS_LABEL[report.mode].ok} {report.ok}
              </span>
              {report.duplicate > 0 && <span>重複 {report.duplicate}</span>}
              {report.skipped > 0 && <span>変更なし {report.skipped}</span>}
              {report.error > 0 && <span className="danger">エラー {report.error}</span>}
            </div>

            {report.rows.some((r) => r.status !== "ok" || r.message) && (
              <div className="tablewrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr><th>行</th><th>状態</th><th>対象</th><th>内容</th></tr>
                  </thead>
                  <tbody>
                    {report.rows.filter((r) => r.status !== "ok" || r.message).map((r) => (
                      <tr key={r.line} className={r.status === "error" ? "overdue" : undefined}>
                        <td className="num">{r.line}</td>
                        <td>{STATUS_LABEL[report.mode][r.status]}</td>
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
                エラーの行は{report.mode === "update" ? "更新されない" : "登録されない"}。直してから
                取り込み直すか、そのまま進めて残りだけ入れることもできる。
              </p>
            )}
            {!report.dryRun && (
              <p className="faint">
                {report.mode === "update"
                  ? "エラーの行は更新していない。「変更なし」は当てる列が空だった行。上の一覧で確認すること。"
                  : "重複とエラーの行は登録していない。上の一覧で確認すること。"}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
