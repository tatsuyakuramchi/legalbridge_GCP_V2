import { useEffect, useState } from "react";
import type { DocumentFormSchema } from "../types";

type Matter = {
  id: number; matterCode: string | null; title: string; status: string; counterparty: string;
  primaryIssueKey: string | null; lifecycleStage: string | null; ownerName: string | null;
  targetDueDate: string | null; blockedReason: string | null; issueCount: number;
  documentCount: number; openTaskCount: number; nextTaskTitle: string | null;
  nextTaskDueAt: string | null; updatedAt: string;
};
type Detail = {
  matter: Matter & { remarks: string | null; driveFolderUrl: string | null };
  issues: Array<{ issueKey: string; relation: string; summary: string | null; note: string | null }>;
  tasks: Array<{ id: number; title: string; status: string; assigneeName: string | null; dueAt: string | null; isPrimary: boolean; blockedReason: string | null }>;
  documents: Array<{ id: number; documentNumber: string | null; templateType: string; issueKey: string; createdAt: string; driveLink: string }>;
};
const statusLabels: Record<string, string> = { open: "未着手", in_progress: "進行中", closed: "完了", archived: "保管" };
const stageLabels: Record<string, string> = {
  intake: "受付", triage: "仕分け", drafting: "ドラフト", internal_review: "社内審査",
  counterparty_review: "相手方確認", signing: "締結", performance: "履行",
  inspection: "検収", invoicing_payment: "請求・支払", completion_check: "完了確認",
  completed: "完了", cancelled: "中止"
};

export function MatterRegistry({ templates, selectedId }: { templates: DocumentFormSchema[]; selectedId?: number }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [matters, setMatters] = useState<Matter[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const labels = new Map(templates.map((item) => [item.templateKey, item.label]));

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query, limit: "200" });
      if (status) params.set("status", status);
      setLoading(true);
      setError("");
      fetch(`/api/v2/matters?${params}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setMatters(data.matters ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("案件一覧を取得できませんでした。"); }).finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, status, reload]);

  async function selectMatter(id: number) {
    const response = await fetch(`/api/v2/matters/${id}`);
    if (response.ok) setDetail(await response.json());
    else setError("案件詳細を取得できませんでした。");
  }
  useEffect(() => { if (selectedId) void selectMatter(selectedId); }, [selectedId]);

  return <section className="page matter-page">
    <div className="page-title"><div><p>MATTER MANAGEMENT</p><h1>案件一覧</h1>
      <small>案件・課題・タスク・関連文書を一つの画面で確認します</small></div></div>
    <div className="matter-toolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="案件番号、案件名、相手方、Backlogキーで検索" />
      <select value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">すべての状態</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select><span>{loading ? "検索中…" : `${matters.length}件`}</span>
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    <div className="matter-layout">
      <div className="matter-list">{matters.map((matter) =>
        <button key={matter.id} className={detail?.matter.id === matter.id ? "selected" : ""} onClick={() => selectMatter(matter.id)}>
          <div><span>{matter.matterCode ?? `#${matter.id}`}</span><strong>{matter.title}</strong><small>{matter.counterparty || "相手方未設定"}</small></div>
          <div className="matter-card-meta"><span className={`matter-status ${matter.status}`}>{statusLabels[matter.status] ?? matter.status}</span>
            <small>{stageLabels[matter.lifecycleStage ?? ""] ?? "工程未設定"}</small>
            <small>文書 {matter.documentCount}・タスク {matter.openTaskCount}</small></div>
          {matter.nextTaskTitle && <p><b>次：</b>{matter.nextTaskTitle}{matter.targetDueDate && `（${matter.targetDueDate}）`}</p>}
          {matter.blockedReason && <em>停滞理由：{matter.blockedReason}</em>}
        </button>)}
        {!loading && !matters.length && <div className="empty-state">該当する案件がありません。</div>}
      </div>
      <MatterDetail detail={detail} labels={labels} />
    </div>
  </section>;
}

function MatterDetail({ detail, labels }: { detail: Detail | null; labels: Map<string, string> }) {
  if (!detail) return <aside className="panel matter-detail empty-detail">一覧から案件を選択してください。</aside>;
  const { matter } = detail;
  return <aside className="panel matter-detail">
    <span className="detail-kicker">MATTER DETAIL</span><h2>{matter.title}</h2>
    <div className="matter-summary"><span>{matter.matterCode ?? `#${matter.id}`}</span><span>{matter.counterparty || "相手方未設定"}</span><span>{matter.ownerName ?? "担当者未設定"}</span></div>
    {matter.driveFolderUrl && <a className="drive-link" href={matter.driveFolderUrl} target="_blank" rel="noreferrer">案件フォルダを開く</a>}
    <DetailSection title={`関連課題 ${detail.issues.length}`}>
      {detail.issues.map((issue) => <article key={issue.issueKey}><b>{issue.issueKey}</b><span>{issue.summary ?? issue.relation}</span><small>{issue.note}</small></article>)}
    </DetailSection>
    <DetailSection title={`次アクション・タスク ${detail.tasks.length}`}>
      {detail.tasks.map((task) => <article key={task.id} className={task.isPrimary ? "primary-task" : ""}><b>{task.title}</b><span>{task.assigneeName ?? "担当未設定"}・{task.status}</span><small>{task.dueAt ? formatDate(task.dueAt) : "期限未設定"}{task.blockedReason && `・${task.blockedReason}`}</small></article>)}
    </DetailSection>
    <DetailSection title={`関連文書 ${detail.documents.length}`}>
      {detail.documents.map((document) => <article key={document.id}><b>{document.documentNumber ?? "未発番"}</b><span>{labels.get(document.templateType) ?? document.templateType}</span><small>{document.issueKey}・{formatDate(document.createdAt)}</small>{document.driveLink && <a href={document.driveLink} target="_blank" rel="noreferrer">開く</a>}</article>)}
    </DetailSection>
    {matter.remarks && <DetailSection title="備考"><p>{matter.remarks}</p></DetailSection>}
  </aside>;
}
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="matter-detail-section"><h3>{title}</h3><div>{children}</div></section>;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
