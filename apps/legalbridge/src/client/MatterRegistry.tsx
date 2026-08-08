import { useEffect, useState } from "react";
import type { DocumentFormSchema } from "../types";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { MatterSlackPanel } from "./MatterSlackPanel";

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
const MATTER_STATUSES = ["open", "in_progress", "closed", "archived"] as const;
const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
const taskStatusLabels: Record<string, string> = { open: "未着手", in_progress: "進行中", done: "完了", cancelled: "中止" };
const stageLabels: Record<string, string> = {
  intake: "受付", triage: "仕分け", drafting: "ドラフト", internal_review: "社内審査",
  counterparty_review: "相手方確認", signing: "締結", performance: "履行",
  inspection: "検収", invoicing_payment: "請求・支払", completion_check: "完了確認",
  completed: "完了", cancelled: "中止"
};
const LIFECYCLE_STAGES = Object.keys(stageLabels);

type FilterKey = "all" | "active" | "blocked" | "overdue" | "done" | "archived";
function isActive(matter: { status: string }) {
  return matter.status === "open" || matter.status === "in_progress";
}
function matterTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
function isOverdue(dueDate: string | null, today: string) {
  return Boolean(dueDate && dueDate.slice(0, 10) < today);
}
function matchesFilter(matter: Matter, filter: FilterKey, today: string) {
  switch (filter) {
    case "active": return isActive(matter);
    case "blocked": return isActive(matter) && Boolean(matter.blockedReason);
    case "overdue": return isActive(matter) && isOverdue(matter.targetDueDate, today);
    case "done": return matter.status === "closed";
    case "archived": return matter.status === "archived";
    // 「すべて」は保管(archived)を除外し、通常運用の案件だけを表示する。
    default: return matter.status !== "archived";
  }
}

export function MatterRegistry({ templates, selectedId, canEdit = false, onCreateDocument }:
  { templates: DocumentFormSchema[]; selectedId?: number; canEdit?: boolean;
    onCreateDocument?: (issueKey: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [matters, setMatters] = useState<Matter[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const labels = new Map(templates.map((item) => [item.templateKey, item.label]));

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      // Fetch by keyword only; status/alert buckets are derived client-side so
      // the filter chips can show live counts.
      const params = new URLSearchParams({ q: query, limit: "200" });
      setLoading(true);
      setError("");
      fetch(`/api/v2/matters?${params}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setMatters(data.matters ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("案件一覧を取得できませんでした。"); }).finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, reload]);

  async function selectMatter(id: number) {
    const response = await fetch(`/api/v2/matters/${id}`);
    if (response.ok) setDetail(await response.json());
    else setError("案件詳細を取得できませんでした。");
  }
  useEffect(() => { if (selectedId) void selectMatter(selectedId); }, [selectedId]);

  function refreshAll(selected?: number) {
    setReload((value) => value + 1);
    if (selected) void selectMatter(selected);
  }

  const today = matterTodayKey();
  const counts = {
    all: matters.filter((m) => m.status !== "archived").length,
    active: matters.filter(isActive).length,
    blocked: matters.filter((m) => isActive(m) && Boolean(m.blockedReason)).length,
    overdue: matters.filter((m) => isActive(m) && isOverdue(m.targetDueDate, today)).length,
    done: matters.filter((m) => m.status === "closed").length,
    archived: matters.filter((m) => m.status === "archived").length
  };
  const chips: Array<{ key: FilterKey; label: string; count: number; tone?: "warning" | "danger" }> = [
    { key: "all", label: "すべて", count: counts.all },
    { key: "active", label: "対応中", count: counts.active },
    { key: "blocked", label: "停滞", count: counts.blocked, tone: "warning" },
    { key: "overdue", label: "期限超過", count: counts.overdue, tone: "danger" },
    { key: "done", label: "完了", count: counts.done },
    { key: "archived", label: "保管", count: counts.archived }
  ];
  const visible = matters.filter((m) => matchesFilter(m, filter, today));

  return <section className="page matter-page">
    <div className="page-title"><div><p>MATTER MANAGEMENT</p><h1>案件一覧</h1>
      <small>案件・課題・タスク・関連文書を一つの画面で確認します</small></div>
      {canEdit && <button className="primary" onClick={() => { setCreating(true); setDetail(null); }}>＋ 新規案件</button>}
    </div>
    <div className="matter-toolbar">
      <input value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder="案件番号、案件名、相手方、Backlogキーで検索" />
      <span>{loading ? "検索中…" : `${visible.length}件`}</span>
    </div>
    <div className="matter-chips">
      {chips.map((chip) => (
        <button key={chip.key}
          className={`matter-chip ${chip.tone ?? ""} ${filter === chip.key ? "active" : ""}`}
          onClick={() => setFilter(chip.key)}>
          {chip.label}<em>{chip.count}</em>
        </button>
      ))}
    </div>
    {error && <div className="async-error">{error}<button onClick={() => setReload((value) => value + 1)}>再試行</button></div>}
    <div className="matter-layout">
      <div className="matter-list">{visible.map((matter) => {
        const overdue = isActive(matter) && isOverdue(matter.targetDueDate, today);
        return <button key={matter.id} className={detail?.matter.id === matter.id ? "selected" : ""} onClick={() => { setCreating(false); selectMatter(matter.id); }}>
          <div><span>{matter.matterCode ?? `#${matter.id}`}</span><strong>{matter.title}</strong><small>{matter.counterparty || "相手方未設定"}</small></div>
          <div className="matter-card-meta"><span className={`matter-status ${matter.status}`}>{statusLabels[matter.status] ?? matter.status}</span>
            <small>{stageLabels[matter.lifecycleStage ?? ""] ?? "工程未設定"}</small>
            <small>文書 {matter.documentCount}・タスク {matter.openTaskCount}</small>
            {overdue && <small className="matter-overdue-tag">期限超過</small>}</div>
          {matter.nextTaskTitle && <p><b>次：</b>{matter.nextTaskTitle}{matter.targetDueDate && <span className={overdue ? "overdue" : ""}>（{matter.targetDueDate}）</span>}</p>}
          {matter.blockedReason && <em>停滞理由：{matter.blockedReason}</em>}
        </button>;
      })}
        {!loading && !visible.length && (matters.length
          ? <EmptyState icon="⛃" title="この絞り込みに該当する案件はありません" description="別のチップやキーワードをお試しください。" compact />
          : <EmptyState icon="⛃" title="案件がありません"
              description={canEdit ? "最初の案件を作成しましょう。" : "該当する案件がありません。"}
              actionLabel={canEdit ? "＋ 新規案件" : undefined}
              onAction={canEdit ? () => { setCreating(true); setDetail(null); } : undefined} />)}
      </div>
      {creating
        ? <MatterForm mode="create" onCancel={() => setCreating(false)}
            onSaved={(id) => { setCreating(false); refreshAll(id); }} />
        : <MatterDetail detail={detail} labels={labels} canEdit={canEdit}
            onCreateDocument={onCreateDocument}
            onChanged={() => refreshAll(detail?.matter.id)} />}
    </div>
  </section>;
}

function MatterDetail({ detail, labels, canEdit, onChanged, onCreateDocument }:
  { detail: Detail | null; labels: Map<string, string>; canEdit: boolean; onChanged: () => void;
    onCreateDocument?: (issueKey: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  useEffect(() => { setEditing(false); setAddingTask(false); }, [detail?.matter.id]);
  if (!detail) return <aside className="panel matter-detail empty-detail">
    <EmptyState icon="◧" title="案件を選択してください" description="左の一覧から案件を選ぶと、課題・タスク・関連文書が表示されます。" compact />
  </aside>;
  const { matter } = detail;
  if (editing) {
    return <MatterForm mode="edit" matter={matter} onCancel={() => setEditing(false)}
      onSaved={() => { setEditing(false); onChanged(); }} />;
  }
  return <aside className="panel matter-detail">
    <div className="matter-detail-head">
      <div><span className="detail-kicker">MATTER DETAIL</span><h2>{matter.title}</h2></div>
      <div className="matter-detail-actions">
        {onCreateDocument && <button className="primary" onClick={() => onCreateDocument(matter.primaryIssueKey)}>文書を作成</button>}
        {canEdit && <button onClick={() => setEditing(true)}>編集</button>}
      </div>
    </div>
    <div className="matter-summary"><span>{matter.matterCode ?? `#${matter.id}`}</span>
      <span className={`matter-status ${matter.status}`}>{statusLabels[matter.status] ?? matter.status}</span>
      <span>{stageLabels[matter.lifecycleStage ?? ""] ?? "工程未設定"}</span>
      <span>{matter.counterparty || "相手方未設定"}</span><span>{matter.ownerName ?? "担当者未設定"}</span>
      {matter.targetDueDate && <span>期限 {matter.targetDueDate}</span>}</div>
    {canEdit && <InlineMatterControls matter={matter} onChanged={onChanged} />}
    {matter.blockedReason && <p className="matter-blocked">停滞理由：{matter.blockedReason}</p>}
    {matter.driveFolderUrl && <a className="drive-link" href={matter.driveFolderUrl} target="_blank" rel="noreferrer">案件フォルダを開く</a>}
    <DetailSection title={`関連課題 ${detail.issues.length}`}>
      <MatterIssueLinks matterId={matter.id} issues={detail.issues} canEdit={canEdit} onChanged={onChanged} />
    </DetailSection>
    <DetailSection title={`次アクション・タスク ${detail.tasks.length}`}
      action={canEdit && !addingTask ? <button onClick={() => setAddingTask(true)}>＋ タスク追加</button> : undefined}>
      {addingTask && <TaskForm matterId={matter.id} onCancel={() => setAddingTask(false)}
        onSaved={() => { setAddingTask(false); onChanged(); }} />}
      {detail.tasks.map((task) => <TaskRow key={task.id} matterId={matter.id} task={task}
        canEdit={canEdit} onChanged={onChanged} />)}
    </DetailSection>
    <DetailSection title={`関連文書 ${detail.documents.length}`}>
      <MatterDocumentLinks matterId={matter.id} documents={detail.documents} labels={labels} canEdit={canEdit} onChanged={onChanged} />
    </DetailSection>
    {matter.remarks && <DetailSection title="備考"><p>{matter.remarks}</p></DetailSection>}
    {canEdit && <MatterSlackPanel matterId={matter.id} />}
  </aside>;
}

const ISSUE_RELATIONS: Array<{ value: string; label: string }> = [
  { value: "primary", label: "主" }, { value: "duplicate", label: "重複" },
  { value: "partial", label: "部分" }, { value: "related", label: "関連" }
];

function MatterIssueLinks({ matterId, issues, canEdit, onChanged }:
  { matterId: number; issues: Detail["issues"]; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [relation, setRelation] = useState("related");
  const [busy, setBusy] = useState(false);
  async function run(request: Promise<Response>, ok: string) {
    setBusy(true);
    try {
      await toast.run(request.then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), ok);
      onChanged();
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  return <>
    {issues.map((issue) => <article key={issue.issueKey}>
      <b>{issue.issueKey}</b>
      <span>{issue.summary ?? (ISSUE_RELATIONS.find((r) => r.value === issue.relation)?.label ?? issue.relation)}</span>
      <small>{issue.note}</small>
      {canEdit && <button className="link-remove" disabled={busy}
        onClick={() => run(fetch(`/api/v2/matters/${matterId}/issues/${encodeURIComponent(issue.issueKey)}`, { method: "DELETE" }), "紐付けを解除しました")}>解除</button>}
    </article>)}
    {!issues.length && <small className="muted-note">紐付いた課題はありません。</small>}
    {canEdit && <div className="issue-link-form">
      <input value={key} placeholder="課題キー（例 LB-123）" onChange={(e) => setKey(e.target.value)} />
      <select value={relation} onChange={(e) => setRelation(e.target.value)}>
        {ISSUE_RELATIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <button className="primary" disabled={busy || !key.trim()}
        onClick={() => run(fetch(`/api/v2/matters/${matterId}/issues`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backlogIssueKey: key.trim(), relation })
        }), "課題を紐付けました").then(() => setKey(""))}>紐付け</button>
    </div>}
  </>;
}

function MatterDocumentLinks({ matterId, documents, labels, canEdit, onChanged }:
  { matterId: number; documents: Detail["documents"]; labels: Map<string, string>; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [docId, setDocId] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(request: Promise<Response>, ok: string) {
    setBusy(true);
    try {
      await toast.run(request.then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), ok);
      onChanged();
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  return <>
    {documents.map((document) => <article key={document.id}>
      <b>{document.documentNumber ?? "未発番"}</b>
      <span>{labels.get(document.templateType) ?? document.templateType}</span>
      <small>{document.issueKey}・{formatDate(document.createdAt)}</small>
      {document.driveLink && <a href={document.driveLink} target="_blank" rel="noreferrer">開く</a>}
      {canEdit && <button className="link-remove" disabled={busy}
        onClick={() => run(fetch(`/api/v2/matters/${matterId}/documents/${document.id}`, { method: "DELETE" }), "文書の紐付けを解除しました")}>解除</button>}
    </article>)}
    {!documents.length && <small className="muted-note">紐付いた文書はありません。</small>}
    {canEdit && <div className="issue-link-form">
      <input value={docId} placeholder="文書ID" inputMode="numeric" onChange={(e) => setDocId(e.target.value.replace(/[^0-9]/g, ""))} />
      <button className="primary" disabled={busy || !docId}
        onClick={() => run(fetch(`/api/v2/matters/${matterId}/documents`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId: Number(docId) })
        }), "文書を紐付けました").then(() => setDocId(""))}>紐付け</button>
    </div>}
  </>;
}

function InlineMatterControls({ matter, onChanged }:
  { matter: Detail["matter"]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function patch(body: Record<string, unknown>, okLabel: string) {
    setBusy(true);
    try {
      const request = fetch(`/api/v2/matters/${matter.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(async (response) => { if (!response.ok) throw new Error("保存に失敗しました"); });
      await toast.run(request, okLabel);
      onChanged();
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  return <div className="matter-inline-controls">
    <label>状態
      <select value={matter.status} disabled={busy}
        onChange={(e) => patch({ status: e.target.value }, "状態を更新しました")}>
        {MATTER_STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
      </select>
    </label>
    <label>工程
      <select value={matter.lifecycleStage ?? ""} disabled={busy}
        onChange={(e) => patch({ lifecycleStage: e.target.value || null }, "工程を更新しました")}>
        <option value="">未設定</option>
        {LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{stageLabels[s]}</option>)}
      </select>
    </label>
  </div>;
}

type MatterFormValues = {
  title: string; status: string; lifecycleStage: string; counterparty: string;
  primaryIssueKey: string; targetDueDate: string; blockedReason: string; remarks: string;
};
function MatterForm({ mode, matter, onCancel, onSaved }: {
  mode: "create" | "edit";
  matter?: Detail["matter"];
  onCancel: () => void;
  onSaved: (id: number) => void;
}) {
  const [values, setValues] = useState<MatterFormValues>({
    title: matter?.title ?? "", status: matter?.status ?? "open",
    lifecycleStage: matter?.lifecycleStage ?? "", counterparty: matter?.counterparty ?? "",
    primaryIssueKey: matter?.primaryIssueKey ?? "", targetDueDate: matter?.targetDueDate ?? "",
    blockedReason: matter?.blockedReason ?? "", remarks: matter?.remarks ?? ""
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  function set<K extends keyof MatterFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }
  async function submit() {
    if (!values.title.trim()) { setError("案件名は必須です。"); return; }
    setSaving(true); setError("");
    const body = {
      title: values.title.trim(),
      status: values.status,
      lifecycleStage: values.lifecycleStage || null,
      counterparty: values.counterparty,
      primaryIssueKey: values.primaryIssueKey,
      targetDueDate: values.targetDueDate || null,
      blockedReason: values.blockedReason,
      remarks: values.remarks
    };
    const url = mode === "create" ? "/api/v2/matters" : `/api/v2/matters/${matter!.id}`;
    const method = mode === "create" ? "POST" : "PATCH";
    try {
      const response = await fetch(url, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error ?? "保存に失敗しました。"); setSaving(false); return;
      }
      const saved = await response.json();
      toast.push(mode === "create" ? "案件を作成しました" : "案件を更新しました", "success");
      onSaved(Number(saved.id));
    } catch {
      setError("通信に失敗しました。"); setSaving(false);
    }
  }
  return <aside className="panel matter-detail matter-editor">
    <span className="detail-kicker">{mode === "create" ? "NEW MATTER" : "EDIT MATTER"}</span>
    <h2>{mode === "create" ? "新規案件" : values.title || "案件を編集"}</h2>
    {error && <div className="async-error">{error}</div>}
    <label>案件名 *<input value={values.title} onChange={(e) => set("title", e.target.value)} placeholder="案件名" /></label>
    <div className="matter-form-grid">
      <label>状態<select value={values.status} onChange={(e) => set("status", e.target.value)}>
        {MATTER_STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>
      <label>工程<select value={values.lifecycleStage} onChange={(e) => set("lifecycleStage", e.target.value)}>
        <option value="">未設定</option>{LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{stageLabels[s]}</option>)}</select></label>
      <label>相手方<input value={values.counterparty} onChange={(e) => set("counterparty", e.target.value)} /></label>
      <label>代表課題キー<input value={values.primaryIssueKey} onChange={(e) => set("primaryIssueKey", e.target.value)} placeholder="LEGAL-123" /></label>
      <label>目標期限<input type="date" value={values.targetDueDate ?? ""} onChange={(e) => set("targetDueDate", e.target.value)} /></label>
    </div>
    <label>停滞理由<input value={values.blockedReason} onChange={(e) => set("blockedReason", e.target.value)} /></label>
    <label>備考<textarea rows={3} value={values.remarks} onChange={(e) => set("remarks", e.target.value)} /></label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}

function TaskRow({ matterId, task, canEdit, onChanged }: {
  matterId: number;
  task: Detail["tasks"][number];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function patch(body: Record<string, unknown>, okLabel: string) {
    setBusy(true);
    try {
      const request = fetch(`/api/v2/matters/${matterId}/tasks/${task.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then(async (response) => { if (!response.ok) throw new Error("保存に失敗しました"); });
      await toast.run(request, okLabel);
      onChanged();
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  return <article className={task.isPrimary ? "primary-task" : ""}>
    <b>{task.title}</b>
    <span>{task.assigneeName ?? "担当未設定"}・{taskStatusLabels[task.status] ?? task.status}{task.isPrimary ? "・次アクション" : ""}</span>
    <small>{task.dueAt ? formatDate(task.dueAt) : "期限未設定"}{task.blockedReason && `・${task.blockedReason}`}</small>
    {canEdit && <div className="task-actions">
      <select value={task.status} disabled={busy} onChange={(e) => patch({ status: e.target.value }, "タスク状態を更新しました")}>
        {TASK_STATUSES.map((s) => <option key={s} value={s}>{taskStatusLabels[s]}</option>)}
      </select>
      {!task.isPrimary && <button disabled={busy} onClick={() => patch({ isPrimary: true }, "次アクションに設定しました")}>次アクションに設定</button>}
    </div>}
  </article>;
}

function TaskForm({ matterId, onCancel, onSaved }: {
  matterId: number; onCancel: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [taskStatus, setTaskStatus] = useState("open");
  const [dueAt, setDueAt] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [blockedReason, setBlockedReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit() {
    if (!title.trim()) { setError("タスク名は必須です。"); return; }
    setSaving(true); setError("");
    const body = {
      title: title.trim(), status: taskStatus, isPrimary,
      blockedReason,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null
    };
    try {
      const response = await fetch(`/api/v2/matters/${matterId}/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error ?? "保存に失敗しました。"); setSaving(false); return;
      }
      toast.push("タスクを追加しました", "success");
      onSaved();
    } catch {
      setError("通信に失敗しました。"); setSaving(false);
    }
  }
  return <div className="task-form">
    {error && <div className="async-error">{error}</div>}
    <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タスク名（例：ドラフト送付）" />
    <div className="matter-form-grid">
      <label>状態<select value={taskStatus} onChange={(e) => setTaskStatus(e.target.value)}>
        {TASK_STATUSES.map((s) => <option key={s} value={s}>{taskStatusLabels[s]}</option>)}</select></label>
      <label>期限<input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} /></label>
    </div>
    <label>停滞理由<input value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} /></label>
    <label className="task-primary-toggle"><input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />この案件の次アクションにする</label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : "タスクを追加"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </div>;
}

function DetailSection({ title, children, action }:
  { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <section className="matter-detail-section">
    <h3>{title}{action}</h3><div>{children}</div>
  </section>;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
