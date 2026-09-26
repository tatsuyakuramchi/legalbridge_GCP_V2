import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { DetailBack, isWideLayout } from "./DetailBack.js";

/**
 * 稟議（R-00001）と取締役会決議（B-00001）。V1 の稟議マスタの置き換え（A-053）。
 *
 * 稟議番号は社内の稟議で決まった番号をそのまま入れる。文書・契約・条件・案件・作品は
 * 番号を入れて繋ぐ（何の番号かはこちらで見分ける）。/法務検索 で稟議番号を引くと、
 * ここで繋いだものが出る。消さない（取り下げは状態を「取り下げ」に）。
 */

type Status = "open" | "approved" | "rejected" | "closed" | "cancelled";
const STATUS_LABEL: Record<Status, string> = {
  open: "起案中", approved: "承認", rejected: "否決", closed: "完了", cancelled: "取り下げ"
};
const TARGET_LABEL: Record<string, string> = {
  document: "文書", agreement: "契約", condition: "条件", matter: "案件", work: "作品"
};
export type RingiOpenTarget = "document" | "agreement" | "condition" | "matter" | "work";

interface Ringi {
  id: number; ringiNo: string; decisionType: "ringi" | "board_resolution"; title: string;
  category: string | null; ownerName: string | null; ownerDepartment: string | null;
  approvedOn: string | null; backlogIssueKey: string | null; status: Status;
  totalBudget: number | null; remarks: string | null; linkCount: number;
}
interface Link { targetType: RingiOpenTarget; targetId: number; code: string | null; title: string; context: string | null }
type Detail = Ringi & { links: Link[] };

interface Draft {
  ringiNo: string; title: string; category: string; ownerName: string; ownerDepartment: string;
  approvedOn: string; backlogIssueKey: string; status: Status; totalBudget: string; remarks: string;
}
const EMPTY: Draft = {
  ringiNo: "", title: "", category: "", ownerName: "", ownerDepartment: "", approvedOn: "",
  backlogIssueKey: "", status: "open", totalBudget: "", remarks: ""
};
const toDraft = (r: Ringi): Draft => ({
  ringiNo: r.ringiNo, title: r.title, category: r.category ?? "", ownerName: r.ownerName ?? "",
  ownerDepartment: r.ownerDepartment ?? "", approvedOn: r.approvedOn ?? "", backlogIssueKey: r.backlogIssueKey ?? "",
  status: r.status, totalBudget: r.totalBudget === null ? "" : String(r.totalBudget), remarks: r.remarks ?? ""
});
const toBody = (d: Draft) => ({
  ringiNo: d.ringiNo, title: d.title, category: d.category || null, ownerName: d.ownerName || null,
  ownerDepartment: d.ownerDepartment || null, approvedOn: d.approvedOn || null,
  backlogIssueKey: d.backlogIssueKey || null, status: d.status,
  totalBudget: d.totalBudget.trim() ? Number(d.totalBudget.replace(/,/g, "")) : null, remarks: d.remarks || null
});

export function RingiWorkspace(
  { initialId, onOpen }: { initialId?: number; onOpen?: (kind: RingiOpenTarget, id: number) => void }
) {
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | Status>("");
  const [items, setItems] = useState<Ringi[] | null>(null);
  const [selected, setSelected] = useState<number | "new" | undefined>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const canWrite = !readOnly && (role === "admin" || role === "legal");

  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (status) qs.set("status", status);
      api.get<{ ringi: Ringi[] }>(`/ringi?${qs}`).then((r) => setItems(r.ringi))
        .catch((e: ApiError) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [q, status, version]);

  useEffect(() => {
    setDetail(null);
    if (typeof selected !== "number") return;
    api.get<Detail>(`/ringi/${selected}`).then(setDetail).catch((e: ApiError) => setError(e.message));
  }, [selected, version]);

  useEffect(() => {
    if (selected === undefined && items?.length && isWideLayout()) setSelected(items[0].id);
  }, [items]);

  const done = (message: string, id?: number) => {
    setNotice(message); setError(null);
    if (id) setSelected(id);
    setVersion((v) => v + 1);
  };

  return (
    <div className={`workspace${selected !== undefined ? " picked" : ""}`}>
      <header className="workspace-head">
        <h1>稟議</h1>
        <p>
          稟議（R-）と取締役会決議（B-）の台帳です。文書・契約・条件・案件は番号を入れて繋ぎます。
          Slack の /法務検索 で稟議番号を引くと、ここで繋いだものが出ます。取締役会決議（B-）は
          関連当事者の議案を起票すると自動で振られます。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      <div className="row" style={{ gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="番号・件名・起案者・部署で探す"
               style={{ minWidth: 260 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value as "" | Status)}>
          <option value="">すべての状態</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        {canWrite && <button className="btn btn-sm" onClick={() => setSelected("new")}>＋ 稟議を登録</button>}
      </div>

      <div className="split">
        <div className="panel md-list">
          <div className="tablewrap">
            <table>
              <thead><tr><th>番号</th><th>件名</th><th>状態</th><th>繋がり</th></tr></thead>
              <tbody>
                {(items ?? []).map((r) => (
                  <tr key={r.id} aria-selected={selected === r.id} style={{ cursor: "pointer" }}
                      onClick={() => setSelected(r.id)}>
                    <td className="code">{r.ringiNo}</td>
                    <td>
                      <div>{r.title}</div>
                      <div className="faint">{[r.ownerDepartment, r.ownerName, r.category].filter(Boolean).join("・") || "—"}</div>
                    </td>
                    <td><span className="tag">{STATUS_LABEL[r.status]}</span></td>
                    <td className="faint">{r.linkCount} 件</td>
                  </tr>
                ))}
                {items && !items.length && <tr><td colSpan={4} className="faint">稟議はありません。</td></tr>}
                {!items && <tr><td colSpan={4} className="faint">読み込んでいます…</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {selected !== undefined && (
          <div className="stack md-detail">
            <DetailBack label="稟議" count={items?.length} onBack={() => setSelected(undefined)} />
            {selected === "new" ? (
              <RingiForm initial={EMPTY} creating canWrite={canWrite}
                         onSaved={(r) => done(`${r.ringiNo} を登録しました`, r.id)} onError={setError} />
            ) : !detail ? <div className="faint">読み込んでいます…</div> : (
              <>
                <RingiForm key={detail.id} initial={toDraft(detail)} id={detail.id} canWrite={canWrite}
                           onSaved={(r) => done(`${r.ringiNo} を直しました`)} onError={setError} />
                <Links detail={detail} canWrite={canWrite} onOpen={onOpen}
                       onChanged={(m) => done(m)} onError={setError} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RingiForm({ initial, id, creating, canWrite, onSaved, onError }: {
  initial: Draft; id?: number; creating?: boolean; canWrite: boolean;
  onSaved: (r: Ringi) => void; onError: (m: string) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const board = d.ringiNo.trim().toUpperCase().startsWith("B");

  async function save() {
    setBusy(true);
    try {
      const r = creating ? await api.post<Ringi>("/ringi", toBody(d)) : await api.patch<Ringi>(`/ringi/${id}`, toBody(d));
      onSaved(r);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const field = (label: string, key: keyof Draft, props: Record<string, unknown> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={d[key]} disabled={!canWrite} onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)} {...props} />
    </label>
  );

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{creating ? "稟議を登録" : d.ringiNo}</h2>
        {!creating && <span className="tag">{board ? "取締役会決議" : "稟議"}</span>}
      </div>
      <div className="panel-bd stack">
        <div className="form-grid">
          {field("稟議番号（R-00001・B-00001・5 桁の数字）", "ringiNo", { placeholder: "R-00012" })}
          <label className="field">
            <span>状態</span>
            <select value={d.status} disabled={!canWrite} onChange={(e) => set({ status: e.target.value as Status })}>
              {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="field wide">
            <span>件名</span>
            <input value={d.title} disabled={!canWrite} onChange={(e) => set({ title: e.target.value })} />
          </label>
          {field("区分", "category", { placeholder: "業務委託・ライセンス など" })}
          {field("承認日", "approvedOn", { type: "date" })}
          {field("起案部署", "ownerDepartment")}
          {field("起案者", "ownerName")}
          {field("予算額（円）", "totalBudget", { inputMode: "numeric" })}
          {field("Backlog の課題キー", "backlogIssueKey", { placeholder: "LEGAL-123" })}
          <label className="field wide">
            <span>備考</span>
            <textarea rows={2} value={d.remarks} disabled={!canWrite} onChange={(e) => set({ remarks: e.target.value })} />
          </label>
        </div>
        {canWrite && (
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>{creating ? "登録する" : "保存する"}</button>
            <span className="faint">消せません。やめた稟議は状態を「取り下げ」にします。</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Links({ detail, canWrite, onOpen, onChanged, onError }: {
  detail: Detail; canWrite: boolean; onOpen?: (kind: RingiOpenTarget, id: number) => void;
  onChanged: (m: string) => void; onError: (m: string) => void;
}) {
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!ref.trim()) return;
    setBusy(true);
    try {
      await api.post(`/ringi/${detail.id}/links`, { ref: ref.trim() });
      setRef("");
      onChanged(`${ref.trim()} を繋ぎました`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function remove(l: Link) {
    if (!confirm(`${l.code ?? l.title} との繋がりを外しますか？`)) return;
    try {
      await api.post(`/ringi/${detail.id}/links/remove`, { targetType: l.targetType, targetId: l.targetId });
      onChanged(`${l.code ?? l.title} を外しました`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="panel">
      <div className="panel-hd"><h2>繋がっている文書・契約</h2><span className="faint">{detail.links.length} 件</span></div>
      <div className="panel-bd stack">
        {canWrite && (
          <div className="row" style={{ gap: 8 }}>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ARC-PO-2026-1001・AGR-2025-0011・CL-2026-00031・MTR-2026-00217"
                   style={{ minWidth: 320 }} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
            <button className="btn btn-sm" disabled={busy || !ref.trim()} onClick={() => void add()}>繋ぐ</button>
          </div>
        )}
        <div className="tablewrap">
          <table>
            <thead><tr><th>種類</th><th>番号</th><th>名前</th><th>状態</th>{canWrite && <th />}</tr></thead>
            <tbody>
              {detail.links.map((l) => (
                <tr key={`${l.targetType}:${l.targetId}`}>
                  <td className="faint">{TARGET_LABEL[l.targetType]}</td>
                  <td className="code">
                    {onOpen ? <button className="linky" onClick={() => onOpen(l.targetType, l.targetId)}>{l.code ?? `#${l.targetId}`}</button>
                      : l.code ?? `#${l.targetId}`}
                  </td>
                  <td>{l.title}</td>
                  <td className="faint">{l.context ?? ""}</td>
                  {canWrite && <td><button className="btn btn-sm" onClick={() => void remove(l)}>外す</button></td>}
                </tr>
              ))}
              {!detail.links.length && <tr><td colSpan={canWrite ? 5 : 4} className="faint">まだ何も繋がっていません。</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
