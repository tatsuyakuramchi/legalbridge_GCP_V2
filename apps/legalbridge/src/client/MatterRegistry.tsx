import { useEffect, useState } from "react";
import type { DocumentFormSchema } from "../types";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";
import { CartButton } from "./MergeCart";
import { MatterSlackPanel } from "./MatterSlackPanel";

type Matter = {
  id: number; matterCode: string | null; title: string; status: string; counterparty: string;
  primaryIssueKey: string | null; lifecycleStage: string | null; ownerName: string | null;
  targetDueDate: string | null; blockedReason: string | null; issueCount: number;
  documentCount: number; openTaskCount: number; nextTaskTitle: string | null;
  nextTaskDueAt: string | null; updatedAt: string;
};
type Detail = {
  matter: Matter & { remarks: string | null; driveFolderUrl: string | null; ownerStaffId?: number | null };
  issues: Array<{ issueKey: string; relation: string; summary: string | null; note: string | null }>;
  tasks: Array<{ id: number; title: string; status: string; assigneeName: string | null; assigneeStaffId?: number | null; dueAt: string | null; isPrimary: boolean; blockedReason: string | null }>;
  documents: Array<{ id: number; documentNumber: string | null; templateType: string; issueKey: string; createdAt: string; driveLink: string }>;
};
const statusLabels: Record<string, string> = { open: "未着手", in_progress: "進行中", closed: "完了", archived: "保管" };

// 担当者セレクト（担当者マスタから取得・監査で「表示のみで設定不可」だった穴の解消）。
function StaffSelect({ label, value, onChange }: {
  label: string; value: string; onChange: (value: string) => void;
}) {
  const [options, setOptions] = useState<Array<{ id: string; name: string; department: string | null }>>([]);
  useEffect(() => {
    fetch("/api/v2/master-data/search?type=staff&q=")
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setOptions((d.items ?? []).map((item: { id: string; label: string; values?: { department?: string | null } }) => ({
        id: String(item.id), name: item.label,
        department: item.values?.department ?? null
      }))))
      .catch(() => setOptions([]));
  }, []);
  return <label>{label}<select value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">未設定</option>
    {options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.department ? `（${o.department}）` : ""}</option>)}
  </select></label>;
}
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

export function MatterRegistry({ templates, selectedId, canEdit = false, canDelete = false, canUploadAttachments = false, onCreateDocument, onOpenDocument }:
  { templates: DocumentFormSchema[]; selectedId?: number; canEdit?: boolean; canDelete?: boolean;
    canUploadAttachments?: boolean; onCreateDocument?: (issueKey: string | null) => void;
    onOpenDocument?: (documentId: number) => void }) {
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
        : <MatterDetail detail={detail} labels={labels} canEdit={canEdit} canDelete={canDelete}
            canUploadAttachments={canUploadAttachments}
            onCreateDocument={onCreateDocument}
            onChanged={() => refreshAll(detail?.matter.id)}
            onDeleted={() => { setDetail(null); setReload((v) => v + 1); }}  onOpenDocument={onOpenDocument} />}
    </div>
  </section>;
}

function MatterDetail({ detail, labels, canEdit, canDelete = false, canUploadAttachments = false, onChanged, onDeleted, onCreateDocument, onOpenDocument }:
  { detail: Detail | null; labels: Map<string, string>; canEdit: boolean; canDelete?: boolean; canUploadAttachments?: boolean;
    onChanged: () => void; onDeleted?: () => void; onCreateDocument?: (issueKey: string | null) => void; onOpenDocument?: (documentId: number) => void }) {
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
        {canEdit && <CartButton kind="matter"
          item={{ key: String(matter.id), label: matter.title, note: matter.matterCode ?? `#${matter.id}` }}
          label="統合カートに入れる" />}
      </div>
    </div>
    <div className="matter-summary"><span>{matter.matterCode ?? `#${matter.id}`}</span>
      <span className={`matter-status ${matter.status}`}>{statusLabels[matter.status] ?? matter.status}</span>
      <span>{stageLabels[matter.lifecycleStage ?? ""] ?? "工程未設定"}</span>
      <span>{matter.counterparty || "相手方未設定"}</span><span>{matter.ownerName ?? "担当者未設定"}</span>
      {matter.targetDueDate && <span>期限 {matter.targetDueDate}</span>}</div>
    {canEdit && <InlineMatterControls matter={matter} onChanged={onChanged} />}
    {matter.blockedReason && <p className="matter-blocked">停滞理由：{matter.blockedReason}</p>}
    <MatterDriveFolder matterId={matter.id} canEdit={canEdit} onRegistered={onChanged} />
    <DetailSection title={`関連課題 ${detail.issues.length}`}>
      <MatterIssueLinks matterId={matter.id} issues={detail.issues} canEdit={canEdit} onChanged={onChanged} />
    </DetailSection>
    <DetailSection title={`次アクション・タスク ${detail.tasks.length}`}
      action={canEdit && !addingTask ? <button onClick={() => setAddingTask(true)}>＋ タスク追加</button> : undefined}>
      {addingTask && <TaskForm matterId={matter.id} onCancel={() => setAddingTask(false)}
        onSaved={() => { setAddingTask(false); onChanged(); }} />}
      {detail.tasks.map((task) => <TaskRow key={task.id} matterId={matter.id} task={task}
        canEdit={canEdit} canDelete={canDelete} onChanged={onChanged} />)}
    </DetailSection>
    <DetailSection title={`関連文書 ${detail.documents.length}`}>
      <MatterDocumentLinks matterId={matter.id} documents={detail.documents} labels={labels} canEdit={canEdit} onChanged={onChanged} onOpenDocument={onOpenDocument} />
      {canUploadAttachments && <MatterAttachmentUpload matterId={matter.id} onUploaded={onChanged} />}
    </DetailSection>
    <DetailSection title="送信履歴"><MatterSends matterId={matter.id} documents={detail.documents} canEdit={canEdit} /></DetailSection>
    {matter.remarks && <DetailSection title="備考"><p>{matter.remarks}</p></DetailSection>}
    {canEdit && <MatterSlackPanel matterId={matter.id} />}
    {canDelete && <MatterDangerZone matterId={matter.id} title={matter.title} onDeleted={onDeleted} />}
  </aside>;
}

const MATTER_DELETE_TOKEN = "COMMIT_MATTER_DELETE";
type DeleteImpact = { key: string; label: string; count: number | null; effect: "cascade" | "unlink" };

// 案件削除（破壊的・Phase 8-6）。プレビュー（連鎖削除・解除件数）→合言葉→削除。
function MatterDangerZone({ matterId, title, onDeleted }:
  { matterId: number; title: string; onDeleted?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [impacts, setImpacts] = useState<DeleteImpact[] | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setOpen(false); setImpacts(null); setToken(""); }, [matterId]);

  async function loadPreview() {
    setBusy(true);
    try {
      const res = await fetch(`/api/v2/matters/${matterId}/delete-preview`);
      if (!res.ok) throw new Error("プレビューを取得できませんでした");
      const data = await res.json();
      setImpacts(data.preview.impacts); setOpen(true);
    } catch { toast.push("プレビューを取得できませんでした", "error"); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      const request = fetch(`/api/v2/matters/${matterId}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: token })
      }).then(async (res) => { if (!res.ok) throw new Error("削除に失敗しました"); });
      await toast.run(request, "案件を削除しました");
      onDeleted?.();
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }

  return <DetailSection title="危険操作">
    {!open
      ? <button className="link-remove" disabled={busy} onClick={loadPreview}>この案件を削除…</button>
      : <div className="matter-danger">
          <p>「{title}」を削除します。次の紐付きに影響します（取り消せません）。</p>
          <table className="vm-refs">
            <thead><tr><th>紐付き</th><th>影響</th><th>件数</th></tr></thead>
            <tbody>{(impacts ?? []).map((i) => <tr key={i.key}>
              <td>{i.label}</td>
              <td className="muted">{i.effect === "cascade" ? "連鎖削除" : "解除（保持）"}</td>
              <td>{i.count == null ? "不明（表示権限なし）" : i.count}</td>
            </tr>)}</tbody>
          </table>
          <label>確認のため <code>{MATTER_DELETE_TOKEN}</code> と入力
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={MATTER_DELETE_TOKEN} />
          </label>
          <div className="task-actions">
            <button disabled={busy} onClick={() => { setOpen(false); setToken(""); }}>キャンセル</button>
            <button className="link-remove" disabled={busy || token !== MATTER_DELETE_TOKEN} onClick={remove}>案件を削除</button>
          </div>
        </div>}
  </DetailSection>;
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

type DriveFile = { id: string; name: string; link: string; isFolder: boolean };

function MatterDriveFolder({ matterId, canEdit, onRegistered }:
  { matterId: number; canEdit: boolean; onRegistered?: () => void }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [folder, setFolder] = useState<{ id: string; url: string | null } | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [registering, setRegistering] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  async function register(file: DriveFile) {
    setRegistering(file.id);
    try {
      const request = fetch(`/api/v2/matters/${matterId}/documents/from-drive`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ link: file.link, name: file.name })
      }).then(async (r) => { if (!r.ok) throw new Error("登録に失敗しました"); return r.json(); });
      const body = await toast.run(request, "案件文書として登録しました");
      if (body?.created === false) toast.push("この文書は既に登録済みです");
      onRegistered?.();
    } catch { /* toast shown */ }
    finally { setRegistering(null); }
  }
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v2/matters/${matterId}/drive-files`).then(async (r) => {
      if (cancelled || !r.ok) return;
      const body = await r.json();
      setEnabled(Boolean(body.enabled));
      setFolder(body.folder ?? null);
      setFiles(Array.isArray(body.files) ? body.files : []);
    });
    return () => { cancelled = true; };
  }, [matterId, reload]);
  async function create() {
    setBusy(true);
    try {
      await toast.run(fetch(`/api/v2/matters/${matterId}/drive-folder`, { method: "POST" })
        .then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), "案件フォルダを作成しました");
      setReload((v) => v + 1);
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  if (!enabled) return null;
  return <div className="matter-drive">
    <div className="matter-drive-head">
      {folder?.url
        ? <a className="drive-link" href={folder.url} target="_blank" rel="noreferrer">案件フォルダを開く</a>
        : <span className="muted-note">案件フォルダ未作成</span>}
      {canEdit && !folder && <button className="primary" disabled={busy} onClick={create}>フォルダ作成</button>}
    </div>
    {folder && files.length > 0 && <ul className="matter-drive-files">
      {files.map((f) => <li key={f.id}>
        <a href={f.link} target="_blank" rel="noreferrer">{f.isFolder ? "📁 " : "📄 "}{f.name}</a>
        {canEdit && !f.isFolder && <button className="link-inline" disabled={registering === f.id}
          onClick={() => register(f)}>案件文書に登録</button>}
      </li>)}
    </ul>}
  </div>;
}

type Send = { id: number; documentId: number; channel: string; recipient: string | null; status: string; subject: string | null; sentBy: string | null; sentAt: string };
const SEND_CHANNELS = ["email", "slack", "drive", "manual"];

function MatterSends({ matterId, documents, canEdit }:
  { matterId: number; documents: Detail["documents"]; canEdit: boolean }) {
  const toast = useToast();
  const [sends, setSends] = useState<Send[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [documentId, setDocumentId] = useState("");
  const [channel, setChannel] = useState("email");
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v2/matters/${matterId}/sends`).then(async (r) => {
      if (cancelled || !r.ok) return;
      const body = await r.json();
      setEnabled(Boolean(body.enabled));
      setSends(Array.isArray(body.sends) ? body.sends : []);
    });
    return () => { cancelled = true; };
  }, [matterId, reload]);
  async function record() {
    setBusy(true);
    try {
      await toast.run(fetch(`/api/v2/matters/${matterId}/sends`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: Number(documentId), channel, recipient: recipient || null, subject: subject || null })
      }).then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), "送信を記録しました");
      setDocumentId(""); setRecipient(""); setReload((v) => v + 1);
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  return <>
    {!enabled && <small className="muted-note">送信履歴は未設定です。</small>}
    {sends.map((s) => <article key={s.id}>
      <b>{s.channel}</b>
      <span>{s.subject ?? s.recipient ?? `文書#${s.documentId}`}</span>
      <small>{s.status}・{formatDate(s.sentAt)}{s.sentBy ? `・${s.sentBy}` : ""}</small>
    </article>)}
    {enabled && !sends.length && <small className="muted-note">送信履歴はありません。</small>}
    {canEdit && enabled && <div className="issue-link-form">
      <select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
        <option value="">文書を選択</option>
        {documents.map((d) => <option key={d.id} value={d.id}>{d.documentNumber ?? `#${d.id}`}</option>)}
      </select>
      <select value={channel} onChange={(e) => setChannel(e.target.value)}>
        {SEND_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <input value={recipient} placeholder="宛先（任意）" onChange={(e) => setRecipient(e.target.value)} />
      <input value={subject} placeholder="件名（任意）" onChange={(e) => setSubject(e.target.value)} />
      <button className="primary" disabled={busy || !documentId} onClick={record}>記録</button>
    </div>}
  </>;
}

type DocHit = { id: number; documentNumber: string | null; templateType: string; issueKey: string };

function MatterDocumentLinks({ matterId, documents, labels, canEdit, onChanged, onOpenDocument }:
  { matterId: number; documents: Detail["documents"]; labels: Map<string, string>; canEdit: boolean; onChanged: () => void; onOpenDocument?: (documentId: number) => void }) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkedIds = new Set(documents.map((d) => d.id));
  // 文書検索（番号・課題キー・キーワード）で候補を出し、生ID入力を廃止（Q4）。
  useEffect(() => {
    if (!canEdit) return;
    const term = query.trim();
    if (!term) { setHits([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      fetch(`/api/v2/documents?q=${encodeURIComponent(term)}&limit=8`, { signal: controller.signal })
        .then((r) => r.ok ? r.json() : Promise.reject())
        .then((d) => setHits(Array.isArray(d.documents) ? d.documents : []))
        .catch(() => { /* aborted or failed */ })
        .finally(() => setSearching(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, canEdit]);
  async function run(request: Promise<Response>, ok: string) {
    setBusy(true);
    try {
      await toast.run(request.then(async (r) => { if (!r.ok) throw new Error("失敗しました"); }), ok);
      onChanged();
    } catch { /* toast shown */ }
    finally { setBusy(false); }
  }
  function link(documentId: number) {
    return run(fetch(`/api/v2/matters/${matterId}/documents`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId })
    }), "文書を紐付けました").then(() => setQuery(""));
  }
  return <>
    {documents.map((document) => <article key={document.id}>
      <b>{onOpenDocument
        ? <button type="button" className="link-button" title="文書詳細を開く（メール・CloudSign送信へ）"
            onClick={() => onOpenDocument(document.id)}>{document.documentNumber ?? "未発番"}</button>
        : (document.documentNumber ?? "未発番")}</b>
      <span>{labels.get(document.templateType) ?? document.templateType}</span>
      <small>{document.issueKey}・{formatDate(document.createdAt)}</small>
      {document.driveLink && <a href={document.driveLink} target="_blank" rel="noreferrer">開く</a>}
      {canEdit && <button className="link-remove" disabled={busy}
        onClick={() => run(fetch(`/api/v2/matters/${matterId}/documents/${document.id}`, { method: "DELETE" }), "文書の紐付けを解除しました")}>解除</button>}
    </article>)}
    {!documents.length && <small className="muted-note">紐付いた文書はありません。</small>}
    {canEdit && <div className="doc-link-picker">
      <input value={query} placeholder="文書を検索して紐付け（番号・課題キー・キーワード）"
        onChange={(e) => setQuery(e.target.value)} />
      {query.trim() && <ul className="doc-link-results">
        {searching && <li className="muted-note">検索中…</li>}
        {!searching && hits.filter((h) => !linkedIds.has(h.id)).length === 0 &&
          <li className="muted-note">該当する文書がありません。</li>}
        {hits.filter((h) => !linkedIds.has(h.id)).map((h) => <li key={h.id}>
          <button className="doc-link-hit" disabled={busy} onClick={() => link(h.id)}>
            <b>{h.documentNumber ?? "未発番"}</b>
            <span>{labels.get(h.templateType) ?? h.templateType}</span>
            <small>{h.issueKey}</small>
          </button>
        </li>)}
      </ul>}
    </div>}
  </>;
}

// 資料アップロード（Phase 16-4）。生ファイル（Word/PDF 等）を Drive へ格納し、
// documents 行（ATT 採番）として案件に紐付ける。登録後は上の関連文書一覧に載る。
const ATTACHMENT_KIND_OPTIONS = [
  { value: "counterparty_draft", label: "相手方ドラフト（レビュー対象）" },
  { value: "own_draft", label: "自社ドラフト" },
  { value: "reference", label: "参考資料" }
] as const;
const ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;

function MatterAttachmentUpload({ matterId, onUploaded }:
  { matterId: number; onUploaded: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<string>("reference");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>("");

  async function uploadFiles(list: FileList | null) {
    if (!list || !list.length || busy) return;
    setBusy(true);
    let uploaded = 0;
    try {
      for (const file of Array.from(list)) {
        if (file.size > ATTACHMENT_MAX_BYTES) {
          toast.push(`${file.name} は 30MB を超えています`);
          continue;
        }
        setProgress(`${file.name} をアップロード中…`);
        const form = new FormData();
        form.append("docKind", kind);
        // multipart ヘッダの filename は非 ASCII で化ける環境があるため通常フィールドで併送。
        form.append("originalName", file.name);
        form.append("file", file);
        const response = await fetch(`/api/v2/matters/${matterId}/attachments`, {
          method: "POST", body: form
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          toast.push(`${file.name}: ${body.error ?? `HTTP ${response.status}`}`);
          continue;
        }
        const body = await response.json() as { document?: { documentNumber?: string } };
        uploaded += 1;
        toast.push(`格納しました（${body.document?.documentNumber ?? ""}）`);
      }
    } finally {
      setBusy(false);
      setProgress("");
      if (uploaded > 0) onUploaded();
    }
  }

  return <div className="attachment-upload">
    <div className="attachment-upload-row">
      <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy} aria-label="資料の種別">
        {ATTACHMENT_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <label className={`attachment-upload-button${busy ? " busy" : ""}`}>
        {busy ? (progress || "アップロード中…") : "＋ 資料をアップロード"}
        <input type="file" multiple disabled={busy} style={{ display: "none" }}
          onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ""; }} />
      </label>
    </div>
    <small className="muted-note">Word/PDF 等の生ファイルを Drive に格納し、この案件の文書（ATT 番号）として登録します。複数可・1ファイル 30MB まで。</small>
  </div>;
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
  ownerStaffId: string;
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
    ownerStaffId: matter?.ownerStaffId != null ? String(matter.ownerStaffId) : ""
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
      remarks: values.remarks,
      ownerStaffId: values.ownerStaffId ? Number(values.ownerStaffId) : null
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
    <label>案件名 *<input maxLength={500} value={values.title} onChange={(e) => set("title", e.target.value)} placeholder="案件名" /></label>
    <div className="matter-form-grid">
      <label>状態<select value={values.status} onChange={(e) => set("status", e.target.value)}>
        {MATTER_STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>
      <label>工程<select value={values.lifecycleStage} onChange={(e) => set("lifecycleStage", e.target.value)}>
        <option value="">未設定</option>{LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{stageLabels[s]}</option>)}</select></label>
      <label>相手方<input maxLength={1000} value={values.counterparty} onChange={(e) => set("counterparty", e.target.value)} /></label>
      <label>代表課題キー<input maxLength={50} value={values.primaryIssueKey} onChange={(e) => set("primaryIssueKey", e.target.value)} placeholder="LEGAL-123" /></label>
      <label>目標期限<input type="date" value={values.targetDueDate ?? ""} onChange={(e) => set("targetDueDate", e.target.value)} /></label>
      <StaffSelect label="担当者" value={values.ownerStaffId} onChange={(v) => set("ownerStaffId", v)} />
    </div>
    {mode === "edit" && <label>停滞理由<input value={values.blockedReason} onChange={(e) => set("blockedReason", e.target.value)} /></label>}
    <label>備考<textarea rows={3} value={values.remarks} onChange={(e) => set("remarks", e.target.value)} /></label>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : "保存"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}

function TaskRow({ matterId, task, canEdit, canDelete = false, onChanged }: {
  matterId: number;
  task: Detail["tasks"][number];
  canEdit: boolean;
  canDelete?: boolean;
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
  async function removeTask() {
    setBusy(true);
    try {
      const request = fetch(`/api/v2/matters/${matterId}/tasks/${task.id}`, { method: "DELETE" })
        .then(async (response) => { if (!response.ok) throw new Error("削除に失敗しました"); });
      await toast.run(request, "タスクを削除しました");
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
      {canDelete && !task.isPrimary && <button className="link-remove" disabled={busy} onClick={removeTask}>削除</button>}
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
  const [assigneeStaffId, setAssigneeStaffId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit() {
    if (!title.trim()) { setError("タスク名は必須です。"); return; }
    setSaving(true); setError("");
    const body = {
      title: title.trim(), status: taskStatus, isPrimary,
      blockedReason,
      assigneeStaffId: assigneeStaffId ? Number(assigneeStaffId) : null,
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
      <StaffSelect label="担当" value={assigneeStaffId} onChange={setAssigneeStaffId} />
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
