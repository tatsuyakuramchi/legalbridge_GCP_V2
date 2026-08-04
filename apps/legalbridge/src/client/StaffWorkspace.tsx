import { useEffect, useState } from "react";
import { useToast } from "./Toast";
import { EmptyState } from "./EmptyState";

type Staff = {
  id: number; slackUserId: string; staffName: string; email: string | null;
  phone: string | null; department: string | null; departmentCode: string | null;
};

export function StaffWorkspace({ canEdit = false }: { canEdit?: boolean }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Staff[]>([]);
  const [selected, setSelected] = useState<Staff | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError(""); setSelected(null); setCreating(false); setEditing(false); setImporting(false);
      fetch(`/api/v2/staff?${new URLSearchParams({ q: query })}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => setItems(data.items ?? []))
        .catch((cause) => { if (cause?.name !== "AbortError") setError("担当者を取得できませんでした。"); })
        .finally(() => setLoading(false));
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, reload]);

  function refresh() { setReload((v) => v + 1); }

  return <section className="page">
    <div className="page-title"><div><p>STAFF MASTER</p><h1>担当者</h1>
      <small>Slack連携する担当者マスタを管理します</small></div>
      {canEdit && <div className="matter-detail-actions">
        <button onClick={() => { setImporting(true); setCreating(false); setSelected(null); setEditing(false); }}>CSV取込</button>
        <button className="primary" onClick={() => { setCreating(true); setImporting(false); setSelected(null); setEditing(false); }}>＋ 新規担当者</button>
      </div>}
    </div>
    <div className="matter-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="氏名・部署・メールで検索" />
      <span>{loading ? "検索中…" : `${items.length}件`}</span>
    </div>
    {error && <div className="async-error">{error}<button onClick={refresh}>再試行</button></div>}
    <div className="matter-layout">
      <div className="matter-list">
        {items.map((s) => <button key={s.id} className={selected?.id === s.id ? "selected" : ""}
          onClick={() => { setCreating(false); setEditing(false); setSelected(s); }}>
          <div><span>{s.departmentCode || s.slackUserId}</span><strong>{s.staffName}</strong><small>{s.department || "部署未設定"}</small></div>
        </button>)}
        {!loading && !items.length && <EmptyState icon="⚇" title="担当者がありません" compact
          description={canEdit ? "「＋ 新規担当者」から登録できます。" : undefined} />}
      </div>
      {importing
        ? <StaffImport onCancel={() => setImporting(false)} onDone={refresh} />
        : creating
        ? <StaffForm onCancel={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />
        : editing && selected
          ? <StaffForm staffId={selected.id} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />
          : <StaffDetail staff={selected} canEdit={canEdit} onEdit={() => setEditing(true)} />}
    </div>
  </section>;
}

function StaffDetail({ staff, canEdit, onEdit }: { staff: Staff | null; canEdit: boolean; onEdit: () => void }) {
  if (!staff) return <aside className="panel matter-detail empty-detail">
    <EmptyState icon="◧" title="担当者を選択してください" compact />
  </aside>;
  return <aside className="panel matter-detail">
    <div className="matter-detail-head"><div><span className="detail-kicker">STAFF</span><h2>{staff.staffName}</h2></div>
      {canEdit && <button onClick={onEdit}>編集</button>}</div>
    <dl className="condition-detail-grid">
      <div><dt>Slack ユーザーID</dt><dd>{staff.slackUserId}</dd></div>
      <div><dt>部署</dt><dd>{staff.department || "—"}</dd></div>
      <div><dt>部署コード</dt><dd>{staff.departmentCode || "—"}</dd></div>
      <div><dt>メール</dt><dd>{staff.email || "—"}</dd></div>
      <div><dt>電話</dt><dd>{staff.phone || "—"}</dd></div>
    </dl>
  </aside>;
}

type StaffValues = { slackUserId: string; staffName: string; email: string; phone: string; department: string; departmentCode: string };
const emptyStaff: StaffValues = { slackUserId: "", staffName: "", email: "", phone: "", department: "", departmentCode: "" };

function StaffForm({ staffId, onCancel, onSaved }: { staffId?: number; onCancel: () => void; onSaved: () => void }) {
  const isEdit = staffId !== undefined;
  const [values, setValues] = useState<StaffValues>(emptyStaff);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    fetch(`/api/v2/staff/${staffId}`)
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        const s = data.staff;
        setValues({
          slackUserId: s.slackUserId ?? "", staffName: s.staffName ?? "", email: s.email ?? "",
          phone: s.phone ?? "", department: s.department ?? "", departmentCode: s.departmentCode ?? ""
        });
      })
      .catch(() => setError("担当者の情報を取得できませんでした。"))
      .finally(() => setLoading(false));
  }, [staffId, isEdit]);
  function set<K extends keyof StaffValues>(key: K, value: string) { setValues((prev) => ({ ...prev, [key]: value })); }
  async function submit() {
    if (!values.slackUserId.trim()) { setError("Slack ユーザーIDは必須です。"); return; }
    if (!values.staffName.trim()) { setError("氏名は必須です。"); return; }
    setSaving(true); setError("");
    const body = {
      slackUserId: values.slackUserId.trim(), staffName: values.staffName.trim(),
      email: values.email, phone: values.phone, department: values.department, departmentCode: values.departmentCode
    };
    try {
      const response = await fetch(isEdit ? `/api/v2/staff/${staffId}` : "/api/v2/staff", {
        method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        setError(detail.error ?? "保存に失敗しました。"); setSaving(false); return;
      }
      toast.push(isEdit ? "担当者を更新しました" : "担当者を登録しました", "success");
      onSaved();
    } catch { setError("通信に失敗しました。"); setSaving(false); }
  }
  if (loading) return <aside className="panel matter-detail"><div className="empty-inline">読み込み中…</div></aside>;
  return <aside className="panel matter-detail matter-editor">
    <span className="detail-kicker">{isEdit ? "EDIT STAFF" : "NEW STAFF"}</span><h2>{isEdit ? "担当者を編集" : "新規担当者"}</h2>
    {error && <div className="async-error">{error}</div>}
    <label>氏名 *<input value={values.staffName} onChange={(e) => set("staffName", e.target.value)} /></label>
    <label>Slack ユーザーID *<input value={values.slackUserId} onChange={(e) => set("slackUserId", e.target.value)} placeholder="U01234567" /></label>
    <div className="matter-form-grid">
      <label>部署<input value={values.department} onChange={(e) => set("department", e.target.value)} /></label>
      <label>部署コード<input value={values.departmentCode} onChange={(e) => set("departmentCode", e.target.value)} /></label>
      <label>メール<input value={values.email} onChange={(e) => set("email", e.target.value)} /></label>
      <label>電話<input value={values.phone} onChange={(e) => set("phone", e.target.value)} /></label>
    </div>
    <div className="matter-form-actions">
      <button className="primary" disabled={saving} onClick={submit}>{saving ? "保存中…" : isEdit ? "保存" : "登録"}</button>
      <button disabled={saving} onClick={onCancel}>キャンセル</button>
    </div>
  </aside>;
}

const STAFF_HEADER_MAP: Record<string, string> = {
  "氏名": "staffName", staff_name: "staffName", staffname: "staffName", name: "staffName", "担当者": "staffName",
  "slackユーザーid": "slackUserId", slack_user_id: "slackUserId", slackuserid: "slackUserId", "slackid": "slackUserId", "slack": "slackUserId",
  "部署": "department", department: "department",
  "部署コード": "departmentCode", department_code: "departmentCode",
  "メール": "email", email: "email",
  "電話": "phone", phone: "phone"
};

function parseStaffCsv(text: string): { rows: Record<string, string>[]; unmapped: string[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return { rows: [], unmapped: [] };
  const rawHeaders = lines[0].split(",").map((h) => h.trim());
  const fields = rawHeaders.map((h) => STAFF_HEADER_MAP[h] ?? STAFF_HEADER_MAP[h.toLowerCase()] ?? "");
  const unmapped = rawHeaders.filter((_, i) => !fields[i]);
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    fields.forEach((field, i) => { if (field) row[field] = (cells[i] ?? "").trim(); });
    return row;
  });
  return { rows, unmapped };
}

function StaffImport({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ insertedCount: number; failedCount: number; failed: Array<{ index: number; error: string }> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const parsed = parseStaffCsv(text);
  const valid = parsed.rows.filter((r) => (r.staffName ?? "").trim() && (r.slackUserId ?? "").trim());

  async function submit() {
    if (!valid.length) { setError("取込む担当者がありません（氏名とSlack ユーザーIDの列が必要です）。"); return; }
    setSaving(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/v2/staff/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: valid })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 422 && response.status !== 201) {
        setError(data.error ?? "取込に失敗しました。"); setSaving(false); return;
      }
      setResult(data);
      toast.push(`${data.insertedCount}件を登録しました${data.failedCount ? `（${data.failedCount}件失敗）` : ""}`,
        data.failedCount ? "info" : "success");
      if (data.insertedCount) onDone();
    } catch {
      setError("通信に失敗しました。");
    } finally { setSaving(false); }
  }

  return <aside className="panel matter-detail matter-editor">
    <span className="detail-kicker">IMPORT STAFF</span><h2>担当者CSV取込</h2>
    <p className="hub-note">1行目にヘッダ（氏名 / Slackユーザーid / 部署 / メール 等）、2行目以降にデータを貼り付けてください。氏名とSlack ユーザーIDは必須。</p>
    {error && <div className="async-error">{error}</div>}
    <textarea rows={8} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }}
      placeholder={"氏名,Slackユーザーid,部署\n田中太郎,U01234567,法務部"} />
    {parsed.rows.length > 0 && <p className="import-preview-note">
      解析 {parsed.rows.length}行 / 登録対象 {valid.length}行
      {parsed.unmapped.length > 0 && `・未対応列: ${parsed.unmapped.join(", ")}`}
    </p>}
    {valid.length > 0 && <div className="condition-table-wrap"><table className="condition-table">
      <thead><tr><th>氏名</th><th>Slack ID</th><th>部署</th></tr></thead>
      <tbody>{valid.slice(0, 20).map((r, i) => <tr key={i}>
        <td><b>{r.staffName}</b></td><td>{r.slackUserId}</td><td>{r.department || "—"}</td>
      </tr>)}</tbody></table>{valid.length > 20 && <p className="import-preview-note">ほか {valid.length - 20}行…</p>}</div>}
    {result && <div className="import-result">
      <strong>{result.insertedCount}件 登録完了</strong>{result.failedCount > 0 && <span>・{result.failedCount}件 失敗</span>}
      {result.failed.slice(0, 10).map((f) => <small key={f.index}>行{f.index + 2}: {f.error}</small>)}
    </div>}
    <div className="matter-form-actions">
      <button className="primary" disabled={saving || !valid.length} onClick={submit}>{saving ? "取込中…" : `${valid.length}件を登録`}</button>
      <button disabled={saving} onClick={onCancel}>閉じる</button>
    </div>
  </aside>;
}
