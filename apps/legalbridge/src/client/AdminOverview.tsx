import { useEffect, useState } from "react";
type State = {
  health: any; runtime: any; overview: any; compatibility: any; diagnostics: any; slackPreview: any; slackCandidates: any;
  integrations: Array<{ name: string; mode: string; ok?: boolean; message?: string }>;
};
const countLabels: Record<string, string> = {
  matters: "案件", documents: "文書", templates: "文書テンプレート", partials: "共通条項",
  vendors: "取引先", staff: "担当者", works: "作品・原作", conditions: "金銭条件"
};
export function AdminOverview() {
  const [state, setState] = useState<State>({ health: null, runtime: null, overview: null, compatibility: null, diagnostics: null, slackPreview: null, slackCandidates: null, integrations: [] });
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    const fetchJson = (url: string) => fetch(url).then((response) => response.ok ? response.json() : Promise.reject());
    const [health, runtime, overview, compatibility, diagnostics, slackPreview, slackCandidates, integrationResult] = await Promise.all([
      fetchJson("/health").catch(() => null), fetchJson("/api/v2/runtime").catch(() => null),
      fetchJson("/api/v2/admin/overview").catch(() => null),
      fetchJson("/api/v2/document-templates/compatibility-report").catch(() => null),
      fetchJson("/api/v2/admin/diagnostics").catch(() => null),
      fetchJson("/api/v2/admin/slack-ux-preview").catch(() => null),
      fetchJson("/api/v2/admin/slack-notification-candidates").catch(() => null),
      fetchJson("/api/v2/integrations/status").catch(() => ({ integrations: [] }))
    ]);
    setState({ health, runtime, overview, compatibility, diagnostics, slackPreview, slackCandidates, integrations: integrationResult.integrations ?? [] });
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  const healthy = state.health?.ok && state.health?.database?.reachable;
  return <section className="page admin-page">
    <div className="page-title"><div><p>SYSTEM OVERVIEW</p><h1>管理・運用監視</h1>
      <small>設定変更は行わず、稼働状態とデータ統合状況を確認します</small></div>
      <button className="primary" onClick={() => void load()} disabled={loading}>{loading ? "確認中…" : "再読込"}</button></div>
    <div className="admin-status-grid">
      <StatusCard label="アプリケーション" value={healthy ? "正常" : "要確認"} ok={healthy} detail={state.health?.service ?? "取得できません"} />
      <StatusCard label="Cloud SQL" value={state.health?.database?.reachable ? "接続済み" : "未接続"} ok={state.health?.database?.reachable}
        detail={state.health?.database?.currentDatabase ?? "取得できません"} />
      <StatusCard label="DBアクセス" value={state.health?.database?.readOnly ? "読取専用" : "要確認"} ok={state.health?.database?.readOnly}
        detail={state.runtime?.accessMode ?? "取得できません"} />
      <StatusCard label="Template互換性" value={state.compatibility ? `${state.compatibility.summary.ok}/${state.compatibility.summary.total} 正常` : "取得不可"}
        ok={state.compatibility?.summary?.error === 0 && state.compatibility?.summary?.warning === 0}
        detail={`警告 ${state.compatibility?.summary?.warning ?? "—"}・エラー ${state.compatibility?.summary?.error ?? "—"}`} />
    </div>
    <section className="panel admin-section">
      <div className="panel-head">
        <h2>運用診断</h2>
        <span>最終確認 {formatDate(state.diagnostics?.generatedAt)}</span>
      </div>
      <div className="diagnostic-summary">
        <strong className={`diagnostic-overall ${state.diagnostics?.status ?? "warning"}`}>
          {diagnosticOverallLabel(state.diagnostics?.status)}
        </strong>
        <small>Secret・接続文字列・認証情報は表示しません。</small>
      </div>
      <div className="diagnostic-grid">
        {Object.entries(state.diagnostics?.checks ?? {}).map(([key, value]) => {
          const check = value as { status?: string };
          return <article key={key} className={`diagnostic-check ${check.status ?? "warning"}`}>
            <span>{diagnosticLabels[key] ?? key}</span>
            <strong>{diagnosticStatusLabel(check.status)}</strong>
            <small>{diagnosticDetail(key, value)}</small>
          </article>;
        })}
        {!state.diagnostics && <p>診断情報を取得できません。</p>}
      </div>
    </section>
    <section className="panel admin-section slack-candidate-section">
      <div className="panel-head">
        <h2>実案件のSlack通知候補</h2>
        <span>同期済み案件から判定・外部送信なし</span>
      </div>
      <div className="slack-candidate-summary">
        <span>判定対象 <strong>{state.slackCandidates?.summary?.matters ?? "—"}</strong></span>
        <span>状態通知候補 <strong>{state.slackCandidates?.summary?.candidates ?? "—"}</strong></span>
        <span>新規送信可 <strong>{state.slackCandidates?.summary?.ready ?? "—"}</strong></span>
        <span>履歴確認待ち <strong>{state.slackCandidates?.summary?.historyUnavailable ?? "—"}</strong></span>
        <span>重複抑止 <strong>{state.slackCandidates?.summary?.duplicates ?? "—"}</strong></span>
        <span>通知不要 <strong>{state.slackCandidates?.summary?.quiet ?? "—"}</strong></span>
        <span>ドライラン確認可 <strong>{state.slackCandidates?.summary?.dryRunReviewable ?? "—"}</strong></span>
        <span>ドライラン停止 <strong>{state.slackCandidates?.summary?.dryRunBlocked ?? "—"}</strong></span>
        <span>実送信可能 <strong>{state.slackCandidates?.summary?.dispatchAllowed ?? "—"}</strong></span>
      </div>
      <div className="slack-candidate-list">
        {(state.slackCandidates?.candidates ?? []).slice(0, 30).map((item: any) => {
          const dryRun = (state.slackCandidates?.dryRun?.queue ?? []).find(
            (entry: any) => entry.fingerprint === item.fingerprint
          );
          const dispatch = (state.slackCandidates?.dispatch?.queue ?? []).find(
            (entry: any) => entry.fingerprint === item.fingerprint
          );
          return <article key={item.matterId}>
          <div>
            <span className={item.eligibility === "quiet" ? "candidate-quiet" : "candidate-notify"}>
              {item.eligibilityLabel}
            </span>
            <strong>{item.issueKey}・{item.title}</strong>
            <small>{item.notification.statusLabel}・判定根拠：{item.triggerDetail}</small>
          </div>
          <div>
            <b>{item.notification.headline}</b>
            <small>次の行動：{item.notification.nextAction}</small>
            <small>ドライラン：{dryRun?.readinessLabel ?? "未判定"}・依頼者 {dryRun?.target?.recipientEmailMasked ?? "特定不能"}</small>
            <small>Slack宛先：{dryRun?.target?.userId ?? "未解決"}（DM）</small>
            {dryRun?.blockingReasons?.map((reason: string) => <small key={reason}>ドライラン停止：{reason}</small>)}
            <small>実送信ゲート：{dispatch?.statusLabel ?? "未判定"}</small>
            {dispatch?.blockerLabels?.map((reason: string) => <small key={reason}>送信停止：{reason}</small>)}
          </div>
        </article>;
        })}
        {state.slackCandidates && !state.slackCandidates.candidates?.length && <p>判定対象の案件がありません。</p>}
        {!state.slackCandidates && <p>通知候補を取得できません。</p>}
      </div>
      <p className="admin-note">通知指紋による重複判定に加え、依頼者とSlackユーザーの対応・履歴・HTTPSリンクをドライランで確認します。表示中の内容はSlackへ送信せず、通知履歴にも記録しません。管理者承認と送信アダプターも未接続です。</p>
    </section>
    <section className="panel admin-section slack-ux-preview">
      <div className="panel-head">
        <h2>Slack UXプレビュー</h2>
        <span>外部送信なし・管理画面内の比較表示</span>
      </div>
      <div className="slack-principles">
        {(state.slackPreview?.principles ?? []).map((item: string) => <span key={item}>{item}</span>)}
      </div>
      <div className="slack-preview-grid">
        {(state.slackPreview?.notifications ?? []).map((item: any) => <article key={item.requesterStatus}>
          <div className="slack-preview-head">
            <span>{item.statusLabel}</span>
            <small>{item.shouldNotify ? "通知する" : "原則通知しない"}</small>
          </div>
          <strong>{item.headline}</strong>
          <p>{item.body}</p>
          <em>次の行動：{item.nextAction}</em>
          <div className="slack-preview-actions">
            {item.actions.map((action: any) => <button key={action.id} className={action.style}>{action.label}</button>)}
          </div>
          <small>{item.delivery.newRootMessage ? "受付メッセージを作成" : "既存案件スレッドへ集約"}</small>
        </article>)}
        {!state.slackPreview && <p>Slack UXプレビューを取得できません。</p>}
      </div>
    </section>
    <section className="panel admin-section"><div className="panel-head"><h2>データ件数</h2><span>既存DB・参照のみ</span></div>
      <div className="admin-counts">{Object.entries(state.overview?.counts ?? {}).map(([key, value]) =>
        <article key={key}><span>{countLabels[key] ?? key}</span><strong>{String(value)}</strong></article>)}</div>
    </section>
    <div className="admin-columns">
      <section className="panel admin-section"><div className="panel-head"><h2>連携状態</h2></div>
        <div className="integration-list">{state.integrations.map((item) => <article key={item.name}>
          <span className={item.ok ? "health-dot ok" : "health-dot"} /><div><b>{item.name}</b><small>{item.mode}・{item.message ?? (item.ok ? "正常" : "要確認")}</small></div></article>)}
          {!state.integrations.length && <p>連携情報を取得できません。</p>}</div>
      </section>
      <section className="panel admin-section"><div className="panel-head"><h2>最終更新</h2></div>
        <dl className="activity-list"><dt>最新文書作成</dt><dd>{formatDate(state.overview?.activity?.latestDocumentAt)}</dd>
          <dt>最新案件更新</dt><dd>{formatDate(state.overview?.activity?.latestMatterAt)}</dd></dl>
        <p className="admin-note">この画面には、保存・更新・削除・外部送信機能はありません。</p>
      </section>
    </div>
  </section>;
}
function StatusCard({ label, value, detail, ok }: { label: string; value: string; detail: string; ok?: boolean }) {
  return <article className={`admin-status ${ok ? "ok" : "warning"}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}
function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}


const diagnosticLabels: Record<string, string> = {
  database: "Cloud SQL・DBモード",
  templates: "全テンプレート回帰",
  pdfRuntime: "PDF実行環境",
  integrations: "外部連携",
  writeSafety: "書込み安全境界"
};

function diagnosticOverallLabel(status?: string) {
  if (status === "ok") return "全項目正常";
  if (status === "error") return "要対応";
  return "要確認";
}

function diagnosticStatusLabel(status?: string) {
  if (status === "ok") return "正常";
  if (status === "disabled") return "無効";
  if (status === "error") return "エラー";
  return "要確認";
}

function diagnosticDetail(key: string, value: unknown) {
  const item = value as Record<string, any>;
  if (key === "database") {
    return item.reachable
      ? `${item.currentDatabase ?? "DB"}・${item.actualMode ?? "unknown"}`
      : "DBへ接続できません";
  }
  if (key === "templates") {
    return `合格 ${item.passed ?? 0}/${item.total ?? 0}・警告 ${item.warnings ?? 0}・失敗 ${item.failed ?? 0}`;
  }
  if (key === "pdfRuntime") {
    return item.enabled
      ? item.executableAvailable ? "Chromium実行可能" : "Chromiumを実行できません"
      : "PDF capability無効";
  }
  if (key === "integrations") {
    return item.externalWritesDisabled ? "local・外部書込み停止" : "live設定を確認してください";
  }
  if (key === "writeSafety") {
    return `scope: ${(item.scopes ?? []).join(", ") || "なし"}・Drive ${item.driveEnabled ? "有効" : "無効"}`;
  }
  return "—";
}
