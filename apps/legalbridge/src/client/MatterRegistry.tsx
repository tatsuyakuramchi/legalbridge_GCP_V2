import { useEffect, useState } from "react";
import type { DocumentFormSchema } from "../types";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";

type Matter = {
  id: number; matterCode: string | null; title: string; status: string; counterparty: string;
  primaryIssueKey: string | null; lifecycleStage: string | null; ownerName: string | null;
  targetDueDate: string | null; blockedReason: string | null; issueCount: number;
  documentCount: number; openTaskCount: number; nextTaskTitle: string | null;
  nextTaskDueAt: string | null; updatedAt: string;
  ownerStaffId?: number | null;
};
type Detail = {
  matter: Matter & { remarks: string | null; driveFolderUrl: string | null };
  issues: Array<{
    issueKey: string; relation: string; summary: string | null; note: string | null;
    requestId: number | null; requestType: string | null; requestCounterparty: string | null;
  }>;
  tasks: Array<{ id: number; title: string; status: string; assigneeName: string | null; dueAt: string | null; isPrimary: boolean; blockedReason: string | null }>;
  documents: Array<{ id: number; documentNumber: string | null; templateType: string; issueKey: string; createdAt: string; driveLink: string }>;
  contracts?: Array<{ id: number; documentNumber: string | null; title: string; contractType: string | null; status: string | null; expirationDate: string | null }>;
  works?: Array<{ id: number; workCode: string | null; title: string }>;
  vendors?: Array<{ id: number; vendorCode: string | null; name: string }>;
  deadlines?: Array<{ id: string; kind: "matter" | "task" | "document" | "contract"; title: string; dueDate: string; status: string }>;
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

type FilterKey = "all" | "active" | "blocked" | "overdue" | "done";
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
    case "done": return matter.status === "closed" || matter.status === "archived";
    default: return true;
  }
}

export function MatterRegistry({ templates, selectedId, canEdit = false, onCreateDocument, onOpenDocument, onOpenWork }:
  { templates: DocumentFormSchema[]; selectedId?: number; canEdit?: boolean;
    onCreateDocument?: (issueKey: string | null) => void;
    onOpenDocument?: (id: number) => void; onOpenWork?: (id: number) => void }) {
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
        .then((data) => {
          const rows = data.matters ?? [];
          setMatters(rows);
          if (!detail && !creating && rows[0]) void selectMatter(rows[0].id);
        })
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
    all: matters.length,
    active: matters.filter(isActive).length,
    blocked: matters.filter((m) => isActive(m) && Boolean(m.blockedReason)).length,
    overdue: matters.filter((m) => isActive(m) && isOverdue(m.targetDueDate, today)).length,
    done: matters.filter((m) => m.status === "closed" || m.status === "archived").length
  };
  const chips: Array<{ key: FilterKey; label: string; count: number; tone?: "warning" | "danger" }> = [
    { key: "all", label: "すべて", count: counts.all },
    { key: "active", label: "対応中", count: counts.active },
    { key: "blocked", label: "停滞", count: counts.blocked, tone: "warning" },
    { key: "overdue", label: "期限超過", count: counts.overdue, tone: "danger" },
    { key: "done", label: "完了", count: counts.done }
  ];
  const visible = matters.filter((m) => matchesFilter(m, filter, today));

  return <section className="page matter-page">
    <div className="page-title"><div><p>MATTER WORKSPACE</p><h1>案件</h1>
      <small>依頼から作品・契約・文書・期限・次アクションまでを案件単位で管理します</small></div>
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
            onOpenDocument={onOpenDocument}
            onOpenWork={onOpenWork}
            onChanged={() => refreshAll(detail?.matter.id)} />}
    </div>
  </section>;
}

function MatterDetail({ detail, labels, canEdit, onChanged, onCreateDocument, onOpenDocument, onOpenWork }:
  { detail: Detail | null; labels: Map<string, string>; canEdit: boolean; onChanged: () => void;
    onCreateDocument?: (issueKey: string | null) => void;
    onOpenDocument?: (id: number) => void; onOpenWork?: (id: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [tab, setTab] = useState<"overview" | "tasks" | "documents" | "requests">("overview");
  useEffect(() => { setEditing(false); setAddingTask(false); setTab("overview"); }, [detail?.matter.id]);
  if (!detail) return <section className="panel matter-detail empty-detail">
    <EmptyState icon="◧" title="案件を選択してください" description="左の一覧から案件を選ぶと、課題・タスク・関連文書が表示されます。" compact />
  </section>;
  const { matter } = detail;
  if (editing) {
    return <MatterForm mode="edit" matter={matter} onCancel={() => setEditing(false)}
      onSaved={() => { setEditing(false); onChanged(); }} />;
  }
  const contracts = detail.contracts ?? [];
  const works = detail.works ?? [];
  const vendors = detail.vendors ?? [];
  const deadlines = detail.deadlines ?? [];
  const nextTask = detail.tasks.find((task) => task.isPrimary && task.status !== "done" && task.status !== "cancelled")
    ?? detail.tasks.find((task) => task.status === "open" || task.status === "in_progress");
  return <section className="panel matter-detail matter-workspace-detail">
    <div className="matter-detail-head">
      <div><span className="detail-kicker">{matter.matterCode ?? `MATTER #${matter.id}`}</span><h2>{matter.title}</h2>
        <p>{matter.counterparty || "相手方未設定"} ・ {matter.ownerName ?? "担当者未設定"}</p></div>
      <div className="matter-detail-actions">
        {onCreateDocument && <button className="primary" onClick={() => onCreateDocument(matter.primaryIssueKey)}>文書を作成</button>}
        {canEdit && <button onClick={() => setEditing(true)}>編集</button>}
      </div>
    </div>
    <div className="matter-progress">
      <div><span>現在の工程</span><strong>{stageLabels[matter.lifecycleStage ?? ""] ?? "工程未設定"}</strong></div>
      <div><span>状態</span><strong className={`matter-status ${matter.status}`}>{statusLabels[matter.status] ?? matter.status}</strong></div>
      <div><span>期限</span><strong>{matter.targetDueDate || "未設定"}</strong></div>
      <div><span>次アクション</span><strong>{nextTask?.title || "未設定"}</strong></div>
    </div>
    {canEdit && <InlineMatterControls matter={matter} onChanged={onChanged} />}
    {matter.blockedReason && <p className="matter-blocked">停滞理由：{matter.blockedReason}</p>}
    {matter.driveFolderUrl && <a className="drive-link" href={matter.driveFolderUrl} target="_blank" rel="noreferrer">案件フォルダを開く</a>}
    <nav className="matter-workspace-tabs">
      <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>全体像</button>
      <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>タスク {detail.tasks.length}</button>
      <button className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}>契約・文書 {contracts.length + detail.documents.length}</button>
      <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>依頼 {detail.issues.length}</button>
    </nav>

    {tab === "overview" && <div className="matter-workspace-body">
      {nextTask && <section className="matter-next-action"><span>NEXT ACTION</span><strong>{nextTask.title}</strong>
        <small>{nextTask.assigneeName ?? "担当未設定"} ・ {nextTask.dueAt ? formatDate(nextTask.dueAt) : "期限未設定"}</small></section>}
      <div className="matter-relation-grid">
        <RelationCard title="依頼・Backlog" count={detail.issues.length} empty="依頼未紐付け">
          {detail.issues.slice(0, 4).map((issue) => <div key={issue.issueKey}><b>{issue.issueKey}</b><span>{issue.summary ?? issue.relation}</span></div>)}
        </RelationCard>
        <RelationCard title="取引先" count={vendors.length || (matter.counterparty ? 1 : 0)} empty="取引先未設定">
          {vendors.length ? vendors.map((vendor) => <div key={vendor.id}><b>{vendor.name}</b><span>{vendor.vendorCode || "コード未設定"}</span></div>)
            : matter.counterparty && <div><b>{matter.counterparty}</b><span>案件登録値</span></div>}
        </RelationCard>
        <RelationCard title="作品・権利" count={works.length} empty="作品未紐付け">
          {works.map((work) => <button key={work.id} onClick={() => onOpenWork?.(work.id)}><b>{work.title}</b><span>{work.workCode || `#${work.id}`}</span></button>)}
        </RelationCard>
        <RelationCard title="契約" count={contracts.length} empty="契約未紐付け">
          {contracts.map((contract) => <div key={contract.id}><b>{contract.title}</b><span>{contract.documentNumber || contract.contractType || `#${contract.id}`}</span></div>)}
        </RelationCard>
      </div>
      <section className="matter-deadlines"><h3>期限・更新管理</h3>
        {deadlines.length ? deadlines.slice(0, 8).map((deadline) => <div key={deadline.id}><strong>{deadline.dueDate}</strong><span>{deadline.title}</span><small>{deadlineKindLabel(deadline.kind)}</small></div>)
          : <p>期限は登録されていません。</p>}
      </section>
      {matter.remarks && <section className="matter-remarks"><h3>案件メモ</h3><p>{matter.remarks}</p></section>}
    </div>}

    {tab === "tasks" && <div className="matter-workspace-body"><DetailSection title={`次アクション・タスク ${detail.tasks.length}`}
      action={canEdit && !addingTask ? <button onClick={() => setAddingTask(true)}>＋ タスク追加</button> : undefined}>
      {addingTask && <TaskForm matterId={matter.id} onCancel={() => setAddingTask(false)} onSaved={() => { setAddingTask(false); onChanged(); }} />}
      {detail.tasks.map((task) => <TaskRow key={task.id} matterId={matter.id} task={task} canEdit={canEdit} onChanged={onChanged} />)}
      {!detail.tasks.length && <p>タスクは登録されていません。</p>}
    </DetailSection></div>}

    {tab === "documents" && <div className="matter-workspace-body">
      <DetailSection title={`契約 ${contracts.length}`}>{contracts.map((contract) => <article key={contract.id}><b>{contract.documentNumber || `#${contract.id}`}</b><span>{contract.title}</span><small>{[contract.contractType, contract.status, contract.expirationDate && `終了 ${contract.expirationDate}`].filter(Boolean).join(" ・ ")}</small></article>)}</DetailSection>
      <DetailSection title={`関連文書 ${detail.documents.length}`}>{detail.documents.map((document) => <article key={document.id} className="interactive-row" onClick={() => onOpenDocument?.(document.id)}><b>{document.documentNumber ?? "未発番"}</b><span>{labels.get(document.templateType) ?? document.templateType}</span><small>{document.issueKey}・{formatDate(document.createdAt)}</small>{document.driveLink && <a href={document.driveLink} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>Drive</a>}</article>)}</DetailSection>
    </div>}

    {tab === "requests" && <div className="matter-workspace-body"><DetailSection title={`依頼・関連課題 ${detail.issues.length}`}>{detail.issues.map((issue) => <article key={issue.issueKey}><b>{issue.issueKey}{issue.requestId ? " ・ 法務依頼" : ""}</b><span>{issue.summary ?? issue.relation}</span><small>{[issue.requestType, issue.requestCounterparty, issue.note].filter(Boolean).join(" ・ ")}</small></article>)}</DetailSection></div>}
  </section>;
}

function RelationCard({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return <section className="matter-relation-card"><header><h3>{title}</h3><span>{count}件</span></header><div>{count ? children : <p>{empty}</p>}</div></section>;
}

function deadlineKindLabel(kind: NonNullable<Detail["deadlines"]>[number]["kind"]) {
  if (kind === "matter") return "案件期限";
  if (kind === "task") return "タスク";
  if (kind === "document") return "文書";
  return "契約終了";
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
  primaryIssueKey: string; targetDueDate: string; blockedReason: string; remarks: string; ownerStaffId: string;
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
    blockedReason: matter?.blockedReason ?? "", remarks: matter?.remarks ?? "",
    ownerStaffId: matter?.ownerStaffId ? String(matter.ownerStaffId) : ""
  });
  const [vendors, setVendors] = useState<Array<{ id: string; label: string }>>([]);
  const [staff, setStaff] = useState<Array<{ id: string; label: string }>>([]);
  const [requests, setRequests] = useState<Array<{ issueKey: string; summary: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/v2/master-data/search?type=vendor&q=&limit=50", { signal: controller.signal }).then((response) => response.ok ? response.json() : { items: [] }),
      fetch("/api/v2/master-data/search?type=staff&q=&limit=50", { signal: controller.signal }).then((response) => response.ok ? response.json() : { items: [] }),
      fetch("/api/v2/requests?limit=200", { signal: controller.signal }).then((response) => response.ok ? response.json() : { requests: [] })
    ]).then(([vendorResult, staffResult, requestResult]) => {
      setVendors(vendorResult.items ?? []); setStaff(staffResult.items ?? []); setRequests(requestResult.requests ?? []);
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);
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
      ownerStaffId: values.ownerStaffId ? Number(values.ownerStaffId) : null,
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
      <label>相手方（DBから選択）<input list={`matter-vendors-${mode}`} value={values.counterparty} onChange={(e) => set("counterparty", e.target.value)} /><datalist id={`matter-vendors-${mode}`}>{vendors.map((vendor) => <option key={vendor.id} value={vendor.label} />)}</datalist></label>
      <label>担当者<select value={values.ownerStaffId} onChange={(e) => set("ownerStaffId", e.target.value)}><option value="">未設定</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.label}</option>)}</select></label>
      <label>代表依頼（Backlog）<input list={`matter-requests-${mode}`} value={values.primaryIssueKey} onChange={(e) => set("primaryIssueKey", e.target.value)} placeholder="LEGAL-123" /><datalist id={`matter-requests-${mode}`}>{requests.map((request) => <option key={request.issueKey} value={request.issueKey}>{request.summary}</option>)}</datalist></label>
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
