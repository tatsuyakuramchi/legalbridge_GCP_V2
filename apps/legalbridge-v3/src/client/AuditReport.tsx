import { useEffect, useState } from "react";
import { CsvBar } from "./CsvBar.js";
import { api, ApiError, money } from "./api.js";

type PayKind = "outsourcing" | "license" | "other" | "unallocated";
type Verdict = "ok" | "over_limit" | "unset";

interface Report {
  period: { since: string; until: string };
  summary: {
    requests: number; matters: number; outsourcingMatters: number;
    purchaseOrders: number; documents: number;
    payments: number; individualPayments: number;
    outsourcingPayments: number; outsourcingOk: number; outsourcingOverLimit: number; outsourcingUnset: number;
    outsourcingMaxDays: number | null;
    licenseOverLimit: number; overduePayments: number;
    openHighIssues: number; unattributedMatters: number;
  };
  departments: Array<{ month: string; department: string; matters: number; outsourcing: number; purchaseOrders: number }>;
  intake: Array<{ month: string; department: string; requests: number; accepted: number }>;
  dueVerdicts: Array<{ partyKind: string; payKind: PayKind; verdict: Verdict; count: number; amount: number; maxDays: number | null }>;
  dueExceptions: Array<{
    paymentNo: string | null; party: string; partyKind: string; payKind: PayKind; amount: number;
    basisReceivedOn: string | null; dueOn: string | null; days: number | null; status: string;
  }>;
  outsourcingWithoutPo: Array<{ paymentNo: string | null; party: string; amount: number; createdOn: string | null; conditions: string }>;
  unattributedMatters: Array<{ matterNo: string | null; title: string; kind: string; owner: string | null; counterparties: string; createdOn: string | null }>;
  quality: Array<{ ruleCode: string; severity: string; open: number; resolved: number; ignored: number; lastDetected: string | null }>;
  jobs: Array<{ action: string; runs: number; days: number; lastRun: string | null }>;
}

const PAY_KIND: Record<PayKind, string> = {
  outsourcing: "業務委託", license: "印税・許諾料", other: "その他（経費・手数料）", unallocated: "割当なし"
};
const VERDICT: Record<Verdict, { text: string; tone: string }> = {
  ok: { text: "適合", tone: "ok" },
  over_limit: { text: "期日超過", tone: "out" },
  unset: { text: "期日未設定", tone: "out" }
};
const MATTER_KIND: Record<string, string> = { outsourcing: "業務委託", work: "作品", single: "単発" };
const JOB_LABEL: Record<string, string> = {
  "job.daily": "日次点検",
  "job.delivery_alert": "納期アラート",
  "job.backlog_pull": "Backlog 取込",
  "job.flow_notice": "工程の通知",
  "job.intake_progress_notice": "依頼の進み具合の通知",
  "job.mail_intake": "メールの取込"
};

const iso = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
const jstMinutes = (t: string | null) =>
  t ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(t)) : "—";
const slash = (d: string) => d.replaceAll("-", "/");

/**
 * 監査レポートの1文。内部監査の報告欄（Excel の1セル）にそのまま貼れる形。
 * 数字だけを差し替える。評価の言葉は付けない（判断は報告する人がする）。
 */
export function summarySentence(r: Report): string {
  const s = r.summary;
  const parts = [
    `${slash(r.period.since)}～${slash(r.period.until)}に依頼${s.requests}件、案件${s.matters}件（うち業務委託${s.outsourcingMatters}件）、`
      + `発注書${s.purchaseOrders}通、文書${s.documents}通をシステムで処理した。`,
    s.outsourcingPayments > 0
      ? `業務委託の支払${s.outsourcingPayments}件のうち、受領日から60日以内に期日を定めたものは${s.outsourcingOk}件`
        + (s.outsourcingOverLimit || s.outsourcingUnset
          ? `、期日超過${s.outsourcingOverLimit}件、期日未設定${s.outsourcingUnset}件。`
          : `（全件）。`)
      : "期間内に業務委託の支払は無い。",
    `期日経過の未払は${s.overduePayments}件。`
  ];
  if (r.outsourcingWithoutPo.length) parts.push(`発注書に紐付かない業務委託の支払が${r.outsourcingWithoutPo.length}件あり、確認中。`);
  if (s.unattributedMatters) parts.push(`依頼者未入力の案件が${s.unattributedMatters}件ある。`);
  return parts.join("");
}

export function AuditReport() {
  const today = iso(new Date());
  const [since, setSince] = useState(iso(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
  const [until, setUntil] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const query = () => `since=${since}&until=${until}`;

  async function load() {
    setBusy(true); setError(null); setCopied(false);
    try { setReport(await api.get<Report>(`/monitoring/audit-report?${query()}`)); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setCopied(false); }
  }

  const s = report?.summary;
  const sentence = report ? summarySentence(report) : "";

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>監査レポート</h2>
          <span className="faint">取適法（業務委託の支払期日）の遵守状況と、システムの使われ方</span>
        </div>
        <div className="panel-bd stack">
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="faint">期間</span>
            <input className="inline-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
            <span className="faint">〜</span>
            <input className="inline-input" type="date" value={until} max={today} onChange={(e) => setUntil(e.target.value)} />
            <button className="btn primary" disabled={busy} onClick={() => void load()}>
              {busy ? "集計中…" : "集計する"}
            </button>
            <span className="faint">日本時間の日付。両端を含む</span>
          </div>
          {error && <div className="alert">{error}</div>}
          <CsvBar exports={[
            ["summary", "要約"], ["departments", "依頼部署別の案件"], ["intake", "依頼部署別の依頼"],
            ["dueVerdicts", "支払期日の判定"], ["dueExceptions", "期日超過・未設定の支払"],
            ["outsourcingWithoutPo", "発注書の無い業務委託の支払"], ["unattributedMatters", "依頼者未入力の案件"],
            ["quality", "データ品質"], ["jobs", "定期ジョブ"]
          ].map(([key, label]) => ({
            value: key!, label: label!,
            href: `/api/v3/monitoring/audit-report/${key}.csv?${query()}`
          }))} />
        </div>
      </div>

      {report && s && (
        <>
          <div className="tiles">
            <div className="tile" style={{ cursor: "default" }}>
              <span className="lab">依頼・案件</span>
              <span className="val">{s.requests} ／ {s.matters}</span>
              <span className="sub">案件のうち業務委託 {s.outsourcingMatters}</span>
            </div>
            <div className="tile" style={{ cursor: "default" }}>
              <span className="lab">発注書・文書の発行</span>
              <span className="val">{s.purchaseOrders} ／ {s.documents}</span>
              <span className="sub">発行・改版した日で数える</span>
            </div>
            <div className={`tile${s.outsourcingOverLimit || s.outsourcingUnset ? " alert" : ""}`} style={{ cursor: "default" }}>
              <span className="lab">業務委託の支払 60日以内</span>
              <span className="val">{s.outsourcingOk} ／ {s.outsourcingPayments}</span>
              <span className="sub">
                超過 {s.outsourcingOverLimit}・未設定 {s.outsourcingUnset}
                {s.outsourcingMaxDays !== null && `・最長 ${s.outsourcingMaxDays}日`}
              </span>
            </div>
            <div className={`tile${s.overduePayments ? " alert" : ""}`} style={{ cursor: "default" }}>
              <span className="lab">期日経過の未払</span>
              <span className="val">{s.overduePayments}</span>
              <span className="sub">支払済みになっていない期日切れ</span>
            </div>
            <div className={`tile${report.outsourcingWithoutPo.length ? " alert" : ""}`} style={{ cursor: "default" }}>
              <span className="lab">発注書の無い業務委託の支払</span>
              <span className="val">{report.outsourcingWithoutPo.length}</span>
              <span className="sub">書面で条件を明示したか確かめる</span>
            </div>
            <div className={`tile${s.unattributedMatters ? " alert" : ""}`} style={{ cursor: "default" }}>
              <span className="lab">依頼者未入力の案件</span>
              <span className="val">{s.unattributedMatters}</span>
              <span className="sub">依頼部署を数えられない</span>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><h2>報告用の1文</h2><span className="faint">Excel の1セルに貼る</span></div>
            <div className="panel-bd stack">
              <div className="note" style={{ whiteSpace: "pre-wrap" }}>{sentence}</div>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <button className="btn" onClick={() => void copy(sentence)}>コピー</button>
                {copied && <span className="faint">コピーしました</span>}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><h2>支払期日の判定</h2><span className="faint">自社が支払う側・0円の移行控えは除く</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>種類</th><th>区分</th><th>判定</th><th className="num">件数</th><th className="num">税抜</th><th className="num">最長日数</th></tr></thead>
                <tbody>
                  {report.dueVerdicts.map((v, i) => (
                    <tr key={i}>
                      <td>{PAY_KIND[v.payKind]}</td>
                      <td>{v.partyKind === "individual" ? "個人" : "法人"}</td>
                      <td><span className={`tag ${v.payKind === "outsourcing" ? VERDICT[v.verdict].tone : ""}`}>{VERDICT[v.verdict].text}</span></td>
                      <td className="num">{v.count}</td>
                      <td className="num">{money(v.amount)}</td>
                      <td className="num">{v.maxDays ?? "—"}</td>
                    </tr>
                  ))}
                  {!report.dueVerdicts.length && <tr><td colSpan={6} className="faint">期間内の支払がありません</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="panel-bd">
              <div className="faint">
                60日の検査が報告の対象になるのは業務委託の行。印税・許諾料の「受領日」は利用期間の末日で、
                給付の受領ではないため参考として出す（色を付けない）。
              </div>
            </div>
          </div>

          {report.dueExceptions.length > 0 && (
            <div className="panel">
              <div className="panel-hd"><h2>期日超過・期日未設定の支払</h2><span className="faint">業務委託を先に</span></div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>支払番号</th><th>相手先</th><th>区分</th><th>種類</th><th className="num">税抜</th><th>受領日</th><th>期日</th><th className="num">日数</th></tr></thead>
                  <tbody>
                    {report.dueExceptions.map((p, i) => (
                      <tr key={i}>
                        <td className="code">{p.paymentNo ?? "—"}</td>
                        <td>{p.party}</td>
                        <td>{p.partyKind === "individual" ? "個人" : "法人"}</td>
                        <td>{PAY_KIND[p.payKind]}</td>
                        <td className="num">{money(p.amount)}</td>
                        <td className="code">{p.basisReceivedOn ?? "—"}</td>
                        <td className="code">{p.dueOn ?? "—"}</td>
                        <td className="num">{p.days ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-hd"><h2>発注書の無い業務委託の支払</h2><span className="faint">取引条件を書面で明示したかを確かめる</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>支払番号</th><th>相手先</th><th className="num">税抜</th><th>登録日</th><th>条件</th></tr></thead>
                <tbody>
                  {report.outsourcingWithoutPo.map((p, i) => (
                    <tr key={i}>
                      <td className="code">{p.paymentNo ?? "—"}</td>
                      <td>{p.party}</td>
                      <td className="num">{money(p.amount)}</td>
                      <td className="code">{p.createdOn ?? "—"}</td>
                      <td className="code faint">{p.conditions || "—"}</td>
                    </tr>
                  ))}
                  {!report.outsourcingWithoutPo.length && <tr><td colSpan={5} className="faint">ありません</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><h2>依頼部署別の案件</h2><span className="faint">依頼者の部署で数える（担当の部署へは落とさない）</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>月</th><th>依頼部署</th><th className="num">案件</th><th className="num">うち業務委託</th><th className="num">発注書</th></tr></thead>
                <tbody>
                  {report.departments.map((d, i) => (
                    <tr key={i}>
                      <td className="code">{d.month}</td><td>{d.department}</td>
                      <td className="num">{d.matters}</td><td className="num">{d.outsourcing}</td><td className="num">{d.purchaseOrders}</td>
                    </tr>
                  ))}
                  {!report.departments.length && <tr><td colSpan={5} className="faint">期間内の案件がありません</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {report.unattributedMatters.length > 0 && (
            <div className="panel">
              <div className="panel-hd"><h2>依頼者未入力の案件</h2><span className="faint">案件の画面で依頼者を入れると部署別に数えられる</span></div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>案件番号</th><th>案件名</th><th>種別</th><th>取引先</th><th>担当</th><th>作成日</th></tr></thead>
                  <tbody>
                    {report.unattributedMatters.map((m, i) => (
                      <tr key={i}>
                        <td className="code">{m.matterNo ?? "—"}</td><td>{m.title}</td>
                        <td>{MATTER_KIND[m.kind] ?? m.kind}</td>
                        <td className="faint">{m.counterparties || "（未登録）"}</td>
                        <td>{m.owner ?? "—"}</td><td className="code">{m.createdOn ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-hd"><h2>依頼部署別の依頼</h2><span className="faint">受付箱に入った依頼（案件にしなかったものも含む）</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>月</th><th>依頼部署</th><th className="num">依頼</th><th className="num">受付済</th></tr></thead>
                <tbody>
                  {report.intake.map((d, i) => (
                    <tr key={i}><td className="code">{d.month}</td><td>{d.department}</td>
                      <td className="num">{d.requests}</td><td className="num">{d.accepted}</td></tr>
                  ))}
                  {!report.intake.length && <tr><td colSpan={4} className="faint">期間内の依頼がありません</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><h2>定期ジョブ</h2><span className="faint">期間内に動いた回数。一覧に無いジョブは期間内に動いていない</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>ジョブ</th><th className="num">回数</th><th className="num">動いた日数</th><th>最終実行</th></tr></thead>
                <tbody>
                  {report.jobs.map((j) => (
                    <tr key={j.action}>
                      <td>{JOB_LABEL[j.action] ?? j.action}</td>
                      <td className="num">{j.runs}</td><td className="num">{j.days}</td>
                      <td className="code">{jstMinutes(j.lastRun)}</td>
                    </tr>
                  ))}
                  {!report.jobs.length && <tr><td colSpan={4} className="faint">期間内に動いた記録がありません（ローカルで業務している期間は動かない）</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><h2>データ品質</h2><span className="faint">いま開いているもの（期間で区切らない）</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>ルール</th><th>重大度</th><th className="num">未解決</th><th className="num">解決</th><th className="num">対象外</th></tr></thead>
                <tbody>
                  {report.quality.map((q) => (
                    <tr key={`${q.ruleCode}:${q.severity}`}>
                      <td className="code">{q.ruleCode}</td>
                      <td><span className={`tag ${q.severity === "high" && q.open ? "out" : ""}`}>{q.severity}</span></td>
                      <td className="num">{q.open}</td><td className="num">{q.resolved}</td><td className="num">{q.ignored}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
