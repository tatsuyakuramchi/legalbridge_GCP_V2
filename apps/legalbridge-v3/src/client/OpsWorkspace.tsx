import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";

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
}
interface Deadline { source: string; refId: number; refNo: string | null; title: string; dueOn: string; status: string }

const RULE_LABEL: Record<string, string> = {
  PAYMENT_UNALLOCATED: "条件に割り当てられていない支払",
  PAYMENT_DUE_OVER_LIMIT: "支払期日が受領日+60日を超えている",
  CONDITION_NO_WORK: "作品に紐づかない条件",
  MIGRATION_CONDITION_NO_PARTY: "相手先が解決できず移行できなかった条件",
  MIGRATION_AGREEMENT_NO_PARTY: "主取引先が解決できず移行できなかった契約",
  DOCUMENT_NO_SOURCE: "テンプレートも保管先も無い発行済み文書"
};
const SOURCE_LABEL: Record<string, string> = {
  matter: "案件", agreement: "契約満了", payment: "支払", schedule: "予定"
};

export function OpsWorkspace() {
  const [tab, setTab] = useState<"quality" | "deadlines" | "audit" | "integrations" | "settings">("quality");
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
        <div className="panel-hd"><h2>次にやること</h2><span className="faint">期日順・14日先まで</span></div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>期日</th><th>種別</th><th>参照</th><th>内容</th></tr></thead>
            <tbody>
              {deadlines.slice(0, 12).map((d) => (
                <tr key={`${d.source}-${d.refId}`}>
                  <td className="code">{d.dueOn}</td>
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
