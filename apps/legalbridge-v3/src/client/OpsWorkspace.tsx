import { useEffect, useState } from "react";
import { StatusTag } from "./labels.js";
import { CsvBar } from "./CsvBar.js";
import { api, ApiError, money } from "./api.js";
import { CsvImport } from "./CsvImport.js";
import { MissingContracts } from "./MissingContracts.js";
import { UnsentBundles } from "./UnsentBundles.js";
import { Leftovers } from "./Leftovers.js";
import { IndividualPayDay } from "./IndividualPayDay.js";
import { TermDefault } from "./TermDefault.js";
import { NoticeFill } from "./NoticeFill.js";
import { StatementMerge } from "./StatementMerge.js";
import { FixesBadge } from "./FixesBadge.js";
import { HomeBoard, type HomeGo } from "./HomeBoard.js";
import { PeriodReissuePanel } from "./PeriodReissue.js";
import { AccountingExport } from "./AccountingExport.js";
import { CompanyProfileForm } from "./CompanyProfileForm.js";
import { DeliveryAlertForm } from "./DeliveryAlertForm.js";
import { MailTemplatesForm } from "./MailTemplatesForm.js";
import { DispatchAllowlistForm } from "./DispatchAllowlistForm.js";
import { TextSnippets } from "./TextSnippets.js";
import { StatementModels } from "./StatementModels.js";
import { AuditReport } from "./AuditReport.js";

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
  PARTY_BANK_INCOMPLETE: "振込先が欠けている取引先",
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
  DOCUMENT_NO_SOURCE: "テンプレートも保管先も無い発行済み文書",
  WORK_PART_MISFILED: "素材が別の作品の下にある（名前が別の作品を名乗っている）"
};
const SOURCE_LABEL: Record<string, string> = {
  matter: "案件", agreement: "契約満了", payment: "支払", schedule: "予定", task: "タスク"
};

export type OpsTab = "quality" | "deadlines" | "fixes" | "leftovers" | "exports" | "imports" | "contracts" | "sending" | "snippets" | "statement-models"
  | "audit-report" | "audit" | "integrations" | "settings";

/** 専用のフォームで編集する設定。下の一覧には生の JSON を出さない。 */
const FORM_KEYS = new Set(["company_profile", "delivery_alert", "mail_templates", "dispatch_allowlist"]);

export function OpsWorkspace({ initialTab, onTabChange }: { initialTab?: OpsTab; onTabChange?: (tab: OpsTab) => void } = {}) {
  const [tab, setTabState] = useState<OpsTab>(initialTab ?? "quality");
  const setTab = (t: OpsTab) => { setTabState(t); onTabChange?.(t); };
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
        <button aria-selected={tab === "fixes"} onClick={() => setTab("fixes")}>一括修正<FixesBadge /></button>
        <button aria-selected={tab === "leftovers"} onClick={() => setTab("leftovers")}>片づけ</button>
        <button aria-selected={tab === "exports"} onClick={() => setTab("exports")}>出力</button>
        <button aria-selected={tab === "imports"} onClick={() => setTab("imports")}>取込</button>
        <button aria-selected={tab === "contracts"} onClick={() => setTab("contracts")}>契約なし</button>
        <button aria-selected={tab === "sending"} onClick={() => setTab("sending")}>送付</button>
        <button aria-selected={tab === "snippets"} onClick={() => setTab("snippets")}>定型文</button>
        <button aria-selected={tab === "statement-models"} onClick={() => setTab("statement-models")}>計算書の表示</button>
        <button aria-selected={tab === "audit-report"} onClick={() => setTab("audit-report")}>監査レポート</button>
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
                        {i.detail.overBy ? <div className="faint">超過 {String(i.detail.overBy)}日</div> : null}
                        {/* 何が足りないのかまで出す。ルール名だけでは直しに行けない。 */}
                        {Array.isArray(i.detail.missing) && (
                          <div className="faint">
                            {i.detail.partyName ? `${String(i.detail.partyName)}：` : ""}
                            {(i.detail.missing as unknown[]).map(String).join("・")} が空
                          </div>
                        )}</td>
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
                    <td>{d.title}</td><td><StatusTag kind="matter" value={d.status} /></td>
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
            {/* 6つ並べると、どれも同じ見た目のボタンになる。何を出すかは
                選ばせて、押すところは1つにする。 */}
            <CsvBar
              exports={[["conditions", "条件"], ["balances", "条件の消化と残高"], ["payments", "支払"],
                        ["statements", "計算書"], ["documents", "文書"], ["parties", "取引先"]]
                .map(([key, label]) => ({ value: key!, label: label!,
                                          href: `/api/v3/exports/${key}.csv` }))} />
          </div>
        </div>
        </div>
      )}

      {tab === "fixes" && (
        <>
          <div className="faint" style={{ marginBottom: 8 }}>
            出したものをまとめて直す道具。どれも <b>試算 → 直す（出し直す）</b> の順で、試算は何も書き換えません。
            上から順に進めると 条件 → 契約書 → 計算書 → 回 の向きで直ります。
          </div>
          <TermDefault />
          <NoticeFill />
          <StatementMerge />
          <div className="panel"><div className="panel-bd"><PeriodReissuePanel /></div></div>
          <IndividualPayDay />
        </>
      )}
      {tab === "leftovers" && <Leftovers />}

      {tab === "imports" && (<>
        {/* 電子書籍売上の取込・年次締めは支払文書の「取込」へ移した（実績の入口なので）。 */}
        <div className="note">電子書籍売上の取込と年次締めは「支払文書 › 取込（電子書籍売上・年次締め）」に移しました。</div>
        <CsvImport /></>)}
      {tab === "contracts" && <MissingContracts />}
      {tab === "sending" && <UnsentBundles />}

      {tab === "snippets" && <TextSnippets />}
      {tab === "statement-models" && <StatementModels />}

      {tab === "audit-report" && <AuditReport />}

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
        <div className="stack">
        <CompanyProfileForm
          value={settings.find((s) => s.key === "company_profile")?.value}
          onSaved={() => void reload()} />
        <DeliveryAlertForm
          value={settings.find((s) => s.key === "delivery_alert")?.value}
          onSaved={() => void reload()} />
        <MailTemplatesForm
          value={settings.find((s) => s.key === "mail_templates")?.value}
          onSaved={() => void reload()} />
        <DispatchAllowlistForm
          value={settings.find((s) => s.key === "dispatch_allowlist")?.value}
          envAllowlist={(integrations as { envAllowlist?: string[] } | null)?.envAllowlist}
          onSaved={() => void reload()} />
        <div className="panel">
          <div className="panel-hd">
            <h2>その他の設定</h2><span className="faint">管理者のみ</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>キー</th><th>値</th><th>更新</th></tr></thead>
              <tbody>
                {/* 自社情報・納期アラート・メールの文面は上のフォームで編集する。生のJSONを二重に出さない。 */}
                {settings.filter((s) => !FORM_KEYS.has(s.key)).map((s) => (
                  <tr key={s.key}>
                    <td className="code">{s.key}</td>
                    <td className="code faint">{JSON.stringify(s.value)}</td>
                    <td className="code">{s.updatedAt?.slice(0, 10) ?? "—"}</td>
                  </tr>
                ))}
                {settings.filter((s) => !FORM_KEYS.has(s.key)).length === 0 && (
                  <tr><td colSpan={3} className="faint">他に設定はありません</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        </div>
      )}
    </section>
  );
}

/** ホーム。数字はすべて条件を起点に導出する。 */
export function HomeWorkspace(
  { onGo, onGoTo, intakeCount = 0, dailyCount = 0 }: {
    onGo: (view: "matters" | "money" | "ops" | "drift" | "intake" | "daily" | "workbench", tab?: OpsTab) => void;
    /** 盤面（入口 3 つ・5 駅）からの行き先。view に加えて 運用のタブ・支払文書の札・整理する を渡す。 */
    onGoTo: (go: HomeGo) => void;
    /** 受付箱の未処理＋返信あり、デイリータスクの終わっていない作業（左の桁と同じ数）。 */
    intakeCount?: number; dailyCount?: number;
  }
) {
  const [summary, setSummary] = useState<{
    openMatters: number; dueSoon: number; agRemaining: number;
    qualityHigh: number; inConditions: number; outConditions: number;
  } | null>(null);
  /**
   * 金額・日付の取り残し。一覧と同じ組み立てをするので、他の数字と一緒に
   * 待たせず別に引く（札だけあとから埋まる）。
   */
  const [drift, setDrift] = useState<number | null>(null);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);

  useEffect(() => {
    api.get<NonNullable<typeof summary>>("/summary").then(setSummary).catch(() => setSummary(null));
    api.get<{ deadlines: Deadline[] }>("/deadlines?days=14").then((r) => setDeadlines(r.deadlines)).catch(() => setDeadlines([]));
    api.get<{ count: number }>("/drift/count").then((r) => setDrift(r.count)).catch(() => setDrift(null));
  }, []);

  const overdueCount = deadlines.filter((d) => d.overdue).length;

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>今日の状況</h1>
        <p>入口は 3 つ（案件から・取引先から・まとめて）、本線は 5 駅（登録 → 作る → 確かめる → 送る → 記録）。駅ごとに待っているものを押して進める。</p>
      </header>

      {/* 入口 3 つと、5 駅で待っているもの（docs/v3-tidy.md 工程ナビ）。 */}
      <HomeBoard onGo={onGoTo} />

      <details>
        <summary style={{ cursor: "pointer", fontSize: 12.5, color: "var(--muted)" }}>文書を作る入口と、状況の札</summary>
      <div className="stack" style={{ marginTop: 10 }}>
      <div className="note">
        文書を作るのはここから：<b>作業テーブル</b> で 要る文書を決める → 作る・登録する → まとめ の順に 1 枚で進めます。
        予定・実績・支払は <b>取引管理</b> で
        <button className="btn btn-sm primary" style={{ marginLeft: 10 }} onClick={() => onGo("workbench")}>
          作業テーブル
        </button>
        <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => onGo("matters")}>
          案件だけ登録する
        </button>
        <span className="faint" style={{ marginLeft: 8 }}>案件の中の工程表でも、次にやることを順に出します</span>
      </div>

      {summary && (
        <div className="tiles">
          {/* 入口の 2 つ。振り分けていない依頼と、軽微な作業の残り。 */}
          <button className={`tile${intakeCount ? " alert" : ""}`} onClick={() => onGo("intake")}>
            <span className="lab">受付箱</span><span className="val">{intakeCount}</span>
            <span className="sub">振り分けていない依頼・返信あり</span>
          </button>
          <button className="tile" onClick={() => onGo("daily")}>
            <span className="lab">デイリータスク</span><span className="val">{dailyCount}</span>
            <span className="sub">軽微な作業の残り</span>
          </button>
          <button className="tile" onClick={() => onGo("matters")}>
            <span className="lab">対応中の案件</span><span className="val">{summary.openMatters}</span>
            <span className="sub">IN {summary.inConditions} ／ OUT {summary.outConditions} 条件</span>
          </button>
          <button className="tile" onClick={() => onGo("ops", "deadlines")}>
            <span className="lab">7日以内の期限</span><span className="val">{summary.dueSoon}</span>
            <span className="sub">案件・契約満了・支払・予定</span>
          </button>
          <button className="tile" onClick={() => onGo("money")}>
            <span className="lab">未消化 AG 残</span><span className="val">{money(summary.agRemaining)}</span>
            <span className="sub">MGは下限なので残高を持たない</span>
          </button>
          <button className={`tile${summary.qualityHigh ? " alert" : ""}`} onClick={() => onGo("ops", "quality")}>
            <span className="lab">重大な不整合</span><span className="val">{summary.qualityHigh}</span>
            <span className="sub">未解決のもの</span>
          </button>
          {/* 決定済みの文書に焼き付いた金額・日付が、いまの条件と食い違っているもの。 */}
          <button className={`tile${drift ? " alert" : ""}`} onClick={() => onGo("drift")}>
            <span className="lab">金額の取り残し</span>
            <span className="val">{drift === null ? "…" : drift}</span>
            <span className="sub">条件を直したのに文書が古いまま</span>
          </button>
        </div>
      )}
      </div>
      </details>

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
