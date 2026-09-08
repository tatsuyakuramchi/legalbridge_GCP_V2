import { useEffect, useState } from "react";
import type { MatterDetail, MatterKind } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { CONDITION_KIND_LABEL, MATTER_KIND_LABEL, StatusTag } from "./labels.js";

/**
 * 案件に条件と文書を繋ぐ操作。
 *
 * これまで案件の条件タブ・文書タブは読むだけで、繋ぐ手段が画面にもサーバにも
 * 無かった（読む処理は3箇所あった）。そのため案件を開いても中身が空のままで、
 * 「案件を進める」という操作が成立していなかった。
 *
 * 案件は所有せず参照する。繋いでも条件は書き換わらないし、外しても消えない。
 */

interface CandidateCondition {
  id: number; conditionNo: string | null; name: string;
  direction: string; kind: string; counterparty: { name: string } | null;
}
interface CandidateDocument {
  id: number; documentNo: string | null; templateLabel: string | null;
  status: string; counterparty: string | null;
}

export function MatterConditions(
  { detail, onChanged, onOpenCondition }:
  { detail: MatterDetail; onChanged: () => void; onOpenCondition: (id: number) => void }
) {
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [candidates, setCandidates] = useState<CandidateCondition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = ALLOWED_KINDS[detail.kind] ?? [];
  const linked = new Set(detail.conditions.map((c) => c.id));

  useEffect(() => {
    if (!picking) return;
    const q = search.trim();
    api.get<{ conditions: CandidateCondition[] }>(`/conditions${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCandidates(r.conditions.filter((c) => allowed.includes(c.kind)).slice(0, 30)))
      .catch(() => setCandidates([]));
  }, [picking, search]);

  async function attach(conditionId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/conditions`, { conditionId });
      setPicking(false); setKeyword(""); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(conditionId: number, label: string) {
    if (!confirm(`${label} の紐づけを外します。条件そのものは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/matters/${detail.id}/conditions/${conditionId}`);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (!allowed.length) {
    return (
      <div className="note">
        {MATTER_KIND_LABEL[detail.kind]} の案件は条件を持ちません。秘密保持契約・通知書・
        法務相談など、金銭条件も権利の移動も伴わない案件がこれにあたります。
        条件が要るなら、案件の種別を変えてください。
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="faint">
          {MATTER_KIND_LABEL[detail.kind]} の案件に繋げるのは
          <b>{allowed.map((k) => CONDITION_KIND_LABEL[k] ?? k).join("・")}</b> の条件です
        </span>
        {!picking && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                  onClick={() => setPicking(true)}>条件を繋ぐ</button>
        )}
      </div>

      {picking && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="条件名・条件番号・相手先" label="繋ぐ条件を探す" />
            <button className="btn btn-sm" onClick={() => { setPicking(false); setKeyword(""); }}>やめる</button>
          </div>
          <div className="picker">
            {candidates.map((c) => (
              <button key={c.id} className="btn btn-sm" style={{ textAlign: "left" }}
                      disabled={busy || linked.has(c.id)}
                      onClick={() => void attach(c.id)}>
                <span className="code">{c.conditionNo ?? `#${c.id}`}</span>
                {" "}{CONDITION_KIND_LABEL[c.kind] ?? c.kind} / {c.name}
                {c.counterparty ? `（${c.counterparty.name}）` : ""}
                {linked.has(c.id) ? "　繋がっています" : ""}
              </button>
            ))}
            {!candidates.length && (
              <span className="faint">
                繋げる条件がありません。{search.trim() ? "別の言葉で探すか、" : ""}
                条件の画面で先に作ってください
              </span>
            )}
          </div>
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {detail.conditions.length ? (
        <table>
          <thead><tr><th>条件番号</th><th>種類</th><th>向き</th><th>内容</th><th></th></tr></thead>
          <tbody>
            {detail.conditions.map((c) => (
              <tr key={c.id}>
                <td className="code">
                  <button className="btn btn-sm" onClick={() => onOpenCondition(c.id)}>
                    {c.conditionNo ?? `#${c.id}`}
                  </button>
                </td>
                <td><span className="tag">{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span></td>
                <td><span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span></td>
                <td>{c.name}</td>
                <td>
                  <button className="btn btn-sm" disabled={busy}
                    onClick={() => void detach(c.id, c.conditionNo ?? `#${c.id}`)}>外す</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">
          まだ条件が繋がっていません。「条件を繋ぐ」から選ぶか、条件の画面で作ってください。
        </div>
      )}
    </div>
  );
}

export function MatterDocuments(
  { detail, onChanged }: { detail: MatterDetail; onChanged: () => void }
) {
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [candidates, setCandidates] = useState<CandidateDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = new Set(detail.documents.map((d) => d.id));

  useEffect(() => {
    if (!picking) return;
    const q = search.trim();
    api.get<{ documents: CandidateDocument[] }>(`/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCandidates(r.documents.slice(0, 30))).catch(() => setCandidates([]));
  }, [picking, search]);

  async function attach(documentId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/documents`, { documentId });
      setPicking(false); setKeyword(""); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(documentId: number, label: string) {
    if (!confirm(`${label} をこの案件から外します。文書そのものは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/matters/${detail.id}/documents/${documentId}`);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="faint">この案件で出した文書。発行は文書の画面から行います</span>
        {!picking && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                  onClick={() => setPicking(true)}>文書を繋ぐ</button>
        )}
      </div>

      {picking && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="文書番号・相手先" label="繋ぐ文書を探す" />
            <button className="btn btn-sm" onClick={() => { setPicking(false); setKeyword(""); }}>やめる</button>
          </div>
          <div className="picker">
            {candidates.map((d) => (
              <button key={d.id} className="btn btn-sm" style={{ textAlign: "left" }}
                      disabled={busy || linked.has(d.id)} onClick={() => void attach(d.id)}>
                <span className="code">{d.documentNo ?? "（下書き）"}</span>
                {" "}{d.templateLabel ?? "—"}{d.counterparty ? `（${d.counterparty}）` : ""}
                {linked.has(d.id) ? "　繋がっています" : ""}
              </button>
            ))}
            {!candidates.length && <span className="faint">繋げる文書がありません</span>}
          </div>
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {detail.documents.length ? (
        <table>
          <thead><tr><th>文書番号</th><th>種別</th><th>状態</th><th></th></tr></thead>
          <tbody>
            {detail.documents.map((d) => (
              <tr key={d.id}>
                <td className="code">{d.documentNo ?? "（下書き）"}</td>
                <td>{d.templateLabel ?? "—"}</td>
                <td><StatusTag kind="document" value={d.status} /></td>
                <td>
                  <button className="btn btn-sm" disabled={busy}
                    onClick={() => void detach(d.id, d.documentNo ?? `#${d.id}`)}>外す</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">この案件の文書はまだありません。</div>
      )}
    </div>
  );
}

/** 取引モデルごとに繋げる条件の種類。サーバの CONDITION_KINDS_BY_MATTER と対。 */
const ALLOWED_KINDS: Record<MatterKind, string[]> = {
  work: ["license", "product"],
  outsourcing: ["service", "expense", "fee"],
  single: []
};
