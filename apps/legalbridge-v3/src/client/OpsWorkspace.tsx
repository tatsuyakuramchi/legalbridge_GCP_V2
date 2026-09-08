import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { CsvImport } from "./CsvImport.js";
import { AccountingExport } from "./AccountingExport.js";

interface Issue {
  id: number; ruleCode: string; targetType: string; targetId: number;
  severity: string; status: string; detectedAt: string; detail: Record<string, unknown>;
}
interface AuditEvent {
  id: number; occurredAt: string; actor: string; action: string;
  targetType: string; targetId: number | null; detail: Record<string, unknown>;
}
interface Setting { key: string; value: unknown; updatedAt: string | null }
interface Integrations {
  drive: { documents: boolean; matterFolders: boolean };
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
  allowlist: string[];
  inbound: { mail: boolean };
}
interface Deadline { source: string; refId: number; refNo: string | null; title: string; dueOn: string; status: string; overdue: boolean }

const RULE_LABEL: Record<string, string> = {
  MAIL_SENDER_UNRESOLVED: "メールの差出人が取引先に当たらない",
  INTAKE_PARTY_UNRESOLVED: "Slack の依頼の相手先が取引先に当たらない",
  BACKLOG_CLOSED_MATTER_OPEN: "Backlog の課題は完了だが案件が開いたまま",
  BACKLOG_OPEN_MATTER_CLOSED: "案件は閉じたが Backlog の課題が動いている",
  PAYMENT_UNALLOCATED: "条件に割り当てられていない支払",
  PAYMENT_DUE_OVER_LIMIT: "支払期日が受領日+60日を超えている",
  CONDITION_NO_WORK: "作品に紐づかない条件",
  MIGRATION_CONDITION_NO_PARTY: "相手先が未特定の条件（受け皿に紐付け済み）",
  MIGRATION_AGREEMENT_NO_PARTY: "主取引先が未特定の契約（受け皿に紐付け済み）",
  MIGRATION_PAYMENT_NO_PARTY: "相手先が未特定の支払（受け皿に紐付け済み）",
  PAYMENT_EMPTY_STUB: "中身の無い支払。移行元で削除するのが正しい",
  AGREEMENT_TERM_INVERTED: "契約期間が逆転している（矛盾する側を落として取り込み）",
  CONDITION_TERM_INVERTED: "条件期間が逆転している（矛盾する側を落として取り込み）",
  CONDITION_PRICING_RECLASSIFIED: "価格方式の宣言と実データが食い違う",
  WORK_SOURCE_IP_MERGED: "原作IPを同コードの作品へ統合",
  WORK_PART_NO_RENUMBERED: "パート番号が重複・欠落していたため振り直し",
  WORK_PART_ORPHAN_IN_USE: "移行元から消えたが条件から参照されているパート",
  SCHEDULE_ORPHAN_IN_USE: "移行元から消えたが実績から参照されている予定",
  DOCUMENT_NO_SOURCE: "テンプレートも保管先も無い発行済み文書"
};
const SOURCE_LABEL: Record<string, string> = {
  matter: "案件", agreement: "契約満了", payment: "支払", schedule: "予定", task: "タスク"
};

export function OpsWorkspace() {
  const [tab, setTab] = useState<"quality" | "deadlines" | "exports" | "imports" | "audit" | "integrations" | "settings">("quality");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void reload(); }, []);
  async function reload() {
    try {
      const [i, e, d, g] = await Promise.all([
        api.get<{ issues: Issue[] }>("/quality-issues"),
        api.get<{ events: AuditEvent[] }>("/audit-events"),
        api.get<{ deadlines: Deadline[] }>("/deadlines"),
        api.get<Integrations>("/integrations")
      ]);
      setIssues(i.issues); setEvents(e.events); setDeadlines(d.deadlines); setIntegrations(g);
      // 設定は管理者だけ。権限が無ければタブごと出さない。
      try { setSettings((await api.get<{ settings: Setting[] }>("/settings")).settings); }
      catch { setSettings(null); }
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  async function resolve(id: number, mode: "resolved" | "ignored") {
    setError(null);
    try { await api.post(`/quality-issues/${id}/resolve`, { mode }); await reload(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>運用</h1>
        <p>整合の点検・期限・監査記録・設定。監査記録は追記専用の1本にまとめてあるので、送付も無効化も同じ形で残る。</p>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="tabs">
        <button aria-selected={tab === "quality"} onClick={() => setTab("quality")}>データ品質 {issues.length}</button>
        <button aria-selected={tab === "deadlines"} onClick={() => setTab("deadlines")}>期限 {deadlines.length}</button>
        <button aria-selected={tab === "exports"} onClick={() => setTab("exports")}>出力</button>
        <button aria-selected={tab === "imports"} onClick={() => setTab("imports")}>取込</button>
        <button aria-selected={tab === "audit"} onClick={() => setTab("audit")}>監査記録</button>
        <button aria-selected={tab === "integrations"} onClick={() => setTab("integrations")}>外部連携</button>
        {settings && <button aria-selected={tab === "settings"} onClick={() => setTab("settings")}>設定</button>}
      </div>

      {tab === "quality" && (
        <div className="panel">
          <div className="panel-hd"><h2>未解決の不整合</h2><span className="faint">重大度順</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>ルール</th><th>対象</th><th>内容</th><th>重大度</th><th></th></tr></thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.id}>
                    <td className="code">{i.ruleCode}</td>
                    <td className="code">{i.targetType} {i.targetId}</td>
                    <td>{RULE_LABEL[i.ruleCode] ?? "—"}
                        {i.detail.overBy ? <div className="faint">超過 {String(i.detail.overBy)}日</div> : null}</td>
                    <td><span className={`tag ${i.severity === "high" ? "out" : ""}`}>{i.severity}</span></td>
                    <td className="row">
                      <button className="btn btn-sm" onClick={() => resolve(i.id, "resolved")}>解決</button>
                      <button className="btn btn-sm" onClick={() => resolve(i.id, "ignored")}>対象外</button>
                    </td>
                  </tr>
                ))}
                {!issues.length && <tr><td colSpan={5} className="faint">未解決の不整合はありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "deadlines" && (
        <div className="panel">
          <div className="panel-hd"><h2>期限</h2><span className="faint">案件・契約満了・支払・予定を1本に</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>期日</th><th>種別</th><th>参照</th><th>内容</th><th>状態</th></tr></thead>
              <tbody>
                {deadlines.map((d) => (
                  <tr key={`${d.source}-${d.refId}`}>
                    <td className="code">{d.dueOn}
                        {d.dueOn < today && <span className="tag out" style={{ marginLeft: 5 }}>超過</span>}</td>
                    <td>{SOURCE_LABEL[d.source] ?? d.source}</td>
                    <td className="code">{d.refNo ?? `#${d.refId}`}</td>
                    <td>{d.title}</td><td><span className="tag">{d.status}</span></td>
                  </tr>
                ))}
                {!deadlines.length && <tr><td colSpan={5} className="faint">期限がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "exports" && (
        <div className="stack">
        <AccountingExport />
        <div className="panel">
          <div className="panel-hd">
            <h2>一覧の出力</h2>
            <span className="faint">全件・CSV（Excel で開ける）</span>
          </div>
          <div className="panel-bd">
            <p className="faint">
              画面の一覧には表示上限があるが、ここからは全件出る。経理提出や V1 との
              突き合わせに使う。金額は主単位の数値で出すので、そのまま合計できる。
            </p>
            <div className="chips">
              {[["conditions", "条件"], ["balances", "条件の消化と残高"], ["payments", "支払"],
                ["statements", "計算書"], ["documents", "文書"], ["parties", "取引先"]].map(([key, label]) => (
                <a key={key} className="btn btn-sm" href={`/api/v3/exports/${key}.csv`}>{label}</a>
              ))}
            </div>
          </div>
        </div>
        </div>
      )}

      {tab === "imports" && <CsvImport />}

      {tab === "audit" && (
        <div className="panel">
          <div className="panel-hd"><h2>監査記録</h2><span className="faint">追記専用</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>日時</th><th>操作</th><th>対象</th><th>実行者</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="code">{e.occurredAt.slice(0, 16).replace("T", " ")}</td>
                    <td className="code">{e.action}</td>
                    <td className="code faint">{e.targetType}{e.targetId ? ` ${e.targetId}` : ""}</td>
                    <td>{e.actor}</td>
                  </tr>
                ))}
                {!events.length && <tr><td colSpan={4} className="faint">記録がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "integrations" && integrations && (
        <div className="stack">
          <div className="panel">
            <div className="panel-hd"><h2>送信の段階</h2><span className="faint">設定し忘れは送らない（off が既定）</span></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>連携</th><th>段階</th><th>接続情報</th><th>意味</th></tr></thead>
                <tbody>
                  {integrations.channels.map((c) => (
                    <tr key={c.channel}>
                      <td className="code">{c.channel}</td>
                      <td><span className={`tag ${c.mode === "live" ? "ok" : c.mode === "dry_run" ? "warn" : ""}`}>
                        {c.mode}</span></td>
                      <td>{c.configured ? "設定済み" : <span className="faint">未設定</span>}</td>
                      <td className="faint">
                        {c.mode === "live" ? "実際に送信します"
                          : c.mode === "dry_run" ? "送らず、何が送られるかだけ返します"
                          : "送信しません。画面にも導線を出しません"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel-bd" style={{ paddingTop: 10 }}>
              <dl className="dl">
                <dt>宛先の許可リスト</dt>
                <dd>{integrations.allowlist.length
                  ? <span className="chips">{integrations.allowlist.map((a) => <span key={a} className="tag">{a}</span>)}</span>
                  : "制限なし"}</dd>
                <dt>Drive 保存</dt>
                <dd>{integrations.drive.documents ? "有効" : "未設定"}
                  {" ／ 案件フォルダ "}{integrations.drive.matterFolders ? "有効" : "未設定"}</dd>
                <dt>メールの取り込み</dt>
                <dd>{integrations.inbound.mail
                  ? "有効（ラベルの付いたメールから案件が立ちます）"
                  : <span className="faint">未設定（GMAIL_INTAKE_LABEL が空）</span>}</dd>
              </dl>
              <div className="faint" style={{ marginTop: 9 }}>
                送信を止めた事実も監査記録に残ります（<span className="code">*.blocked</span>）。
                「なぜ送られていないのか」を後から追えるようにするためです。
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "settings" && settings && (
        <div className="panel">
          <div className="panel-hd"><h2>設定</h2><span className="faint">管理者のみ</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>キー</th><th>値</th><th>更新</th></tr></thead>
              <tbody>
                {settings.map((s) => (
                  <tr key={s.key}>
                    <td className="code">{s.key}</td>
                    <td className="code faint">{JSON.stringify(s.value)}</td>
                    <td className="code">{s.updatedAt?.slice(0, 10) ?? "—"}</td>
                  </tr>
                ))}
                {!settings.length && <tr><td colSpan={3} className="faint">設定がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** ホーム。数字はすべて条件を起点に導出する。 */
export function HomeWorkspace({ onGo }: { onGo: (view: "matters" | "money" | "ops") => void }) {
  const [summary, setSummary] = useState<{
    openMatters: number; dueSoon: number; agRemaining: number;
    qualityHigh: number; inConditions: number; outConditions: number;
  } | null>(null);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);

  useEffect(() => {
    api.get<NonNullable<typeof summary>>("/summary").then(setSummary).catch(() => setSummary(null));
    api.get<{ deadlines: Deadline[] }>("/deadlines?days=14").then((r) => setDeadlines(r.deadlines)).catch(() => setDeadlines([]));
  }, []);

  const overdueCount = deadlines.filter((d) => d.overdue).length;

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>今日の状況</h1>
        <p>条件を起点に、期限・消化・整合の三つだけを見る。画面ごとの集計差は生じない。</p>
      </header>

      {summary && (
        <div className="tiles">
          <button className="tile" onClick={() => onGo("matters")}>
            <span className="lab">対応中の案件</span><span className="val">{summary.openMatters}</span>
            <span className="sub">IN {summary.inConditions} ／ OUT {summary.outConditions} 条件</span>
          </button>
          <button className="tile" onClick={() => onGo("ops")}>
            <span className="lab">7日以内の期限</span><span className="val">{summary.dueSoon}</span>
            <span className="sub">案件・契約満了・支払・予定</span>
          </button>
          <button className="tile" onClick={() => onGo("money")}>
            <span className="lab">未消化 AG 残</span><span className="val">{money(summary.agRemaining)}</span>
            <span className="sub">MGは下限なので残高を持たない</span>
          </button>
          <button className={`tile${summary.qualityHigh ? " alert" : ""}`} onClick={() => onGo("ops")}>
            <span className="lab">重大な不整合</span><span className="val">{summary.qualityHigh}</span>
            <span className="sub">未解決のもの</span>
          </button>
        </div>
      )}

      <div className="panel">
        <div className="panel-hd"><h2>次にやること</h2>
          <span className="faint">
            期日順・期限切れは全部{overdueCount > 0 && <strong className="danger">（超過 {overdueCount} 件）</strong>}
          </span></div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>期日</th><th>種別</th><th>参照</th><th>内容</th></tr></thead>
            <tbody>
              {deadlines.slice(0, 12).map((d) => (
                <tr key={`${d.source}-${d.refId}`} className={d.overdue ? "overdue" : undefined}>
                  <td className="code">{d.dueOn}{d.overdue && <span className="danger"> 超過</span>}</td>
                  <td>{SOURCE_LABEL[d.source] ?? d.source}</td>
                  <td className="code">{d.refNo ?? `#${d.refId}`}</td>
                  <td>{d.title}</td>
                </tr>
              ))}
              {!deadlines.length && <tr><td colSpan={4} className="faint">期限はありません</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
