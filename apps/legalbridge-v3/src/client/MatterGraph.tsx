import { useEffect, useState } from "react";
import type { GraphCondition, GraphDocument, GraphEvent, GraphIssue, MatterGraph as Graph }
  from "../server/matters/graph-service.js";
import { api, ApiError, money } from "./api.js";
import { CONDITION_KIND_LABEL, EVENT_TYPE_LABEL, StatusTag } from "./labels.js";

/**
 * 案件の「整理」タブ。繋がりの特例画面。
 *
 * 条件・実績・文書・支払はそれぞれの画面が自分から見える繋がりだけを出す。
 * 改訂（版が変わる）・下書き・無効・訂正版・実績の結びつけが絡むと、どこが
 * ねじれているかを 1 か所で見られず、直す順番も分からなかった。
 * ここは案件を軸に一式を並べ、機械的に見つかる不整合を上に名指しで出す。
 * 直すボタンは既存の API を呼ぶだけで、この画面だけの書き込みは無い。
 */
export function MatterGraph(
  { matterId, reloadKey, onChanged, onOpenDocument, onOpenCondition }: {
    matterId: number;
    reloadKey: number;
    onChanged: () => void;
    onOpenDocument?: (documentId: number) => void;
    onOpenCondition?: (conditionId: number) => void;
  }
) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.get<Graph>(`/matters/${matterId}/graph`)
      .then((g) => { if (alive) { setGraph(g); setError(null); } })
      .catch((e) => { if (alive) setError((e as ApiError).message); });
    return () => { alive = false; };
  }, [matterId, reloadKey, tick]);

  const refresh = () => { setTick((v) => v + 1); onChanged(); };

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); setNotice(`${label}：完了しました`); refresh(); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (!graph) return <div className="faint">{error ?? "読み込み中…"}</div>;

  const byId = new Map(graph.conditions.map((c) => [c.id, c]));
  const condNo = (id: number) => byId.get(id)?.conditionNo ?? `#${id}`;
  const current = (c: GraphCondition): GraphCondition => {
    let x = c; const seen = new Set<number>();
    while (x.supersededById && !seen.has(x.id)) { seen.add(x.id); const n = byId.get(x.supersededById); if (!n) break; x = n; }
    return x;
  };
  const docLabel = (d: GraphDocument) => d.documentNo ?? `下書き #${d.id}`;
  const docById = new Map(graph.documents.map((d) => [d.id, d]));

  // ---- 直す操作。どれも既存の API。 ----
  const unlinkEvent = (e: GraphEvent) => {
    if (!e.documentId) return;
    const d = docById.get(e.documentId);
    if (!confirm(`実績 #${e.id} を文書 ${d ? docLabel(d) : `#${e.documentId}`} から外します。実績は残り、別の文書に結び直せます。`)) return;
    void run(`実績 #${e.id} を外す`, () =>
      api.post(`/conditions/${e.conditionId}/events/unlink-document`, { eventIds: [e.id], documentId: e.documentId }));
  };
  const voidEvent = (e: GraphEvent) => {
    const reason = prompt(`実績 #${e.id} を取り消します。理由を書いてください。`);
    if (!reason?.trim()) return;
    void run(`実績 #${e.id} を取り消す`, () =>
      api.post(`/conditions/${e.conditionId}/events/${e.id}/void`, { reason: reason.trim() }));
  };
  const voidDocument = (d: GraphDocument) => {
    const reason = prompt(`${docLabel(d)} を無効にします。理由を書いてください。結びついている実績は自動で外れます。`);
    if (!reason?.trim()) return;
    void run(`${docLabel(d)} を無効にする`, () => api.post(`/documents/${d.id}/void`, { reason: reason.trim() }));
  };
  const detachDocument = (d: GraphDocument) => {
    if (!confirm(`${docLabel(d)} をこの案件から外します。文書自体は残ります。`)) return;
    void run(`${docLabel(d)} を案件から外す`, () => api.del(`/matters/${matterId}/documents/${d.id}`));
  };
  const rebaseDraft = (d: GraphDocument) => {
    const next = [...new Set(d.conditionIds.map((id) => { const c = byId.get(id); return c ? current(c).id : id; }))];
    const changed = d.conditionIds.filter((id, i) => next[i] !== id);
    if (!confirm(`${docLabel(d)} の条件を今の版に差し替えます（${changed.map(condNo).join("・")} → ${changed.map((id) => condNo(current(byId.get(id)!).id)).join("・")}）。本文は次のプレビューで作り直されます。`)) return;
    void run(`${docLabel(d)} の条件を今の版へ`, () => api.patch(`/documents/${d.id}/draft`, { conditionIds: next }));
  };
  const relinkCondition = (oldId: number, newId: number) => {
    if (!confirm(`案件の紐づけを ${condNo(oldId)} から ${condNo(newId)} に付け替えます。`)) return;
    void run(`${condNo(newId)} へ付け替える`, async () => {
      await api.post(`/matters/${matterId}/conditions`, { conditionId: newId });
      await api.del(`/matters/${matterId}/conditions/${oldId}`);
    });
  };
  const attachCondition = (id: number) => {
    const c = byId.get(id); const target = c ? current(c).id : id;
    if (!confirm(`${condNo(target)} をこの案件に繋ぎます。`)) return;
    void run(`${condNo(target)} を繋ぐ`, () => api.post(`/matters/${matterId}/conditions`, { conditionId: target }));
  };

  const fixButton = (issue: GraphIssue) => {
    switch (issue.code) {
      case "event_on_dead_document": {
        const e = graph.events.find((x) => x.id === issue.eventId);
        return e ? <button className="btn btn-sm" disabled={busy} onClick={() => unlinkEvent(e)}>実績を外す</button> : null;
      }
      case "document_has_old_version": {
        const d = docById.get(issue.documentId ?? -1);
        return d?.status === "draft"
          ? <button className="btn btn-sm" disabled={busy} onClick={() => rebaseDraft(d)}>下書きの条件を今の版へ</button>
          : null;
      }
      case "document_condition_not_in_matter":
        return issue.conditionId
          ? <button className="btn btn-sm" disabled={busy} onClick={() => attachCondition(issue.conditionId!)}>条件を案件に繋ぐ</button>
          : null;
      case "old_version_linked_to_matter":
        return issue.conditionId && issue.currentConditionId && issue.conditionId !== issue.currentConditionId
          ? <button className="btn btn-sm" disabled={busy}
                    onClick={() => relinkCondition(issue.conditionId!, issue.currentConditionId!)}>今の版へ付け替える</button>
          : null;
      case "drafts_share_events":
      case "inspection_without_order":
        return issue.documentId && onOpenDocument
          ? <button className="btn btn-sm" onClick={() => onOpenDocument(issue.documentId!)}>文書を開く</button>
          : null;
      default:
        return null;
    }
  };
  const INFO_ONLY = new Set<GraphIssue["code"]>(["event_on_old_version"]);
  const problems = graph.issues.filter((i) => !INFO_ONLY.has(i.code));
  const infos = graph.issues.filter((i) => INFO_ONLY.has(i.code));

  // 条件は系列ごとに、古い版から並べる。
  const seriesIds = [...new Set(graph.conditions.map((c) => c.series))];
  const eventsOf = (cid: number) => graph.events.filter((e) => e.conditionId === cid);
  const docsOf = (cid: number) => graph.documents.filter((d) => d.conditionIds.includes(cid));

  return (
    <div className="stack">
      {error && <div className="note warn">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      <section className="stack" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>
          不整合 {problems.length ? <span className="tag warn">{problems.length}</span> : <span className="tag ok">なし</span>}
        </h3>
        {!problems.length && <div className="faint">機械的に見つかるねじれはありません。</div>}
        {problems.map((issue, i) => (
          <div key={`${issue.code}-${i}`} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
            <span className="tag warn" style={{ whiteSpace: "nowrap" }}>{ISSUE_LABEL[issue.code]}</span>
            <span style={{ flex: 1 }}>{issue.message}</span>
            {fixButton(issue)}
          </div>
        ))}
        {infos.map((issue, i) => (
          <div key={`info-${i}`} className="faint">{issue.message}</div>
        ))}
      </section>

      <section className="stack" style={{ gap: 4 }}>
        <h3 style={{ margin: 0 }}>条件（改訂の全版） {graph.conditions.length}</h3>
        <div className="graph-list">
          {seriesIds.map((series) => graph.conditions.filter((c) => c.series === series).map((c, idx, arr) => {
            const cur = current(c);
            const evs = eventsOf(c.id).filter((e) => e.status === "active");
            const docs = docsOf(c.id);
            return (
              <div key={c.id} className={`graph-row${idx === 0 && arr.length > 1 ? " series-head" : ""}`}>
                <div>
                  <div className="row" style={{ gap: 6 }}>
                    {arr.length > 1 && <span className="faint code">{idx + 1}/{arr.length}</span>}
                    <span className="code">
                      {onOpenCondition
                        ? <a href="#" onClick={(ev) => { ev.preventDefault(); onOpenCondition(c.id); }}>{c.conditionNo ?? `#${c.id}`}</a>
                        : (c.conditionNo ?? `#${c.id}`)}
                    </span>
                    <span className="faint">{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span>
                    <span>{c.name}</span>
                    {c.flatAmount != null && <span className="faint code">{money(c.flatAmount, c.currency)}</span>}
                    <StatusTag kind="condition" value={c.status} />
                    {c.closedAt && <span className="tag ok">完了扱い</span>}
                    {c.linkedToMatter && (c.status === "superseded"
                      ? <span className="tag warn">旧版のまま案件に紐づき</span>
                      : <span className="tag ok">案件に紐づき</span>)}
                  </div>
                  <div className="sub">
                    実績 {evs.length ? evs.map((e) => `#${e.id}`).join(" ") : "なし"}
                    {" ／ "}文書 {docs.length ? docs.map((d) => docLabel(d)).join(" ") : "なし"}
                  </div>
                </div>
                <div className="acts">
                  {c.linkedToMatter && c.status === "superseded" && cur.id !== c.id && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => relinkCondition(c.id, cur.id)}>今の版へ付け替える</button>
                  )}
                  {!c.linkedToMatter && c.status !== "superseded" && c.status !== "void" && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => attachCondition(c.id)}>案件に繋ぐ</button>
                  )}
                </div>
              </div>
            );
          }))}
          {!graph.conditions.length && <div className="faint">条件がありません</div>}
        </div>
      </section>

      <section className="stack" style={{ gap: 4 }}>
        <h3 style={{ margin: 0 }}>文書 {graph.documents.length}</h3>
        <div className="graph-list">
          {graph.documents.map((d) => {
            const dead = d.status === "void" || d.status === "superseded";
            const oldVersions = d.conditionIds.filter((id) => byId.get(id)?.status === "superseded");
            const pendingEvents = d.status === "draft" ? d.draftEventIds : d.eventIds;
            return (
              <div key={d.id} className="graph-row" style={dead ? { opacity: 0.6 } : undefined}>
                <div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="code">
                      {onOpenDocument
                        ? <a href="#" onClick={(ev) => { ev.preventDefault(); onOpenDocument(d.id); }}>{docLabel(d)}</a>
                        : docLabel(d)}
                    </span>
                    <span>{d.templateLabel ?? d.templateKey ?? "—"}</span>
                    <StatusTag kind="document" value={d.status} />
                    {d.issuedAt && <span className="faint code">{d.issuedAt}</span>}
                    {d.supersedesId && <span className="faint">#{d.supersedesId} の訂正版</span>}
                    {d.matterId === matterId ? null
                      : d.matterId ? <span className="tag warn">別の案件 #{d.matterId}</span>
                      : <span className="tag warn">案件なし</span>}
                  </div>
                  <div className="sub">
                    条件 {d.conditionIds.length
                      ? d.conditionIds.map((id) => (
                          <span key={id} style={{ marginRight: 4 }}>
                            {condNo(id)}{byId.get(id)?.status === "superseded" && <span className="tag warn">旧版</span>}
                          </span>))
                      : "なし"}
                    {" ／ "}実績 {pendingEvents.length ? pendingEvents.map((id) => `#${id}`).join(" ") : "なし"}
                    {d.status === "draft" && pendingEvents.length > 0 && "（決定時に結ぶ）"}
                  </div>
                </div>
                <div className="acts">
                  {d.status === "draft" && oldVersions.length > 0 && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => rebaseDraft(d)}>条件を今の版へ</button>
                  )}
                  {!dead && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => voidDocument(d)}>無効にする</button>
                  )}
                  {d.matterId === matterId && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => detachDocument(d)}>案件から外す</button>
                  )}
                </div>
              </div>
            );
          })}
          {!graph.documents.length && <div className="faint">文書がありません</div>}
        </div>
      </section>

      <section className="stack" style={{ gap: 4 }}>
        <h3 style={{ margin: 0 }}>実績 {graph.events.length}</h3>
        <div className="graph-list">
          {graph.events.map((e) => {
            const c = byId.get(e.conditionId);
            const deadDoc = e.documentStatus === "void" || e.documentStatus === "superseded";
            return (
              <div key={e.id} className="graph-row" style={e.status !== "active" ? { opacity: 0.6 } : undefined}>
                <div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="code">#{e.id}</span>
                    <span>{EVENT_TYPE_LABEL[e.eventType] ?? e.eventType}</span>
                    <span className="faint code">{e.occurredOn ?? "—"}</span>
                    <span className="code">{money(e.amount, c?.currency ?? "JPY")}</span>
                    {e.status !== "active" && <span className="tag">無効</span>}
                    {e.followUp && <span className="faint">{FOLLOW_UP_LABEL[e.followUp] ?? e.followUp}</span>}
                  </div>
                  <div className="sub">
                    条件 {condNo(e.conditionId)}{c?.status === "superseded" && "（旧版）"}
                    {" ／ "}文書 {e.documentId
                      ? <>
                          {onOpenDocument
                            ? <a href="#" onClick={(ev) => { ev.preventDefault(); onOpenDocument(e.documentId!); }}>{e.documentNo ?? `#${e.documentId}`}</a>
                            : (e.documentNo ?? `#${e.documentId}`)}
                          {" "}<StatusTag kind="document" value={e.documentStatus} />
                        </>
                      : "結びつきなし"}
                  </div>
                </div>
                <div className="acts">
                  {e.status === "active" && e.documentId && (
                    <button className={deadDoc ? "btn btn-sm primary" : "btn btn-sm"} disabled={busy}
                            title={deadDoc ? "無効・差し替え済みの文書に結びついたまま。外すと作り直せます" : "文書から外して結び直せるようにする"}
                            onClick={() => unlinkEvent(e)}>外す</button>
                  )}
                  {e.status === "active" && !e.documentId && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => voidEvent(e)}>取り消す</button>
                  )}
                </div>
              </div>
            );
          })}
          {!graph.events.length && <div className="faint">実績がありません</div>}
        </div>
      </section>

      <section className="stack" style={{ gap: 4 }}>
        <h3 style={{ margin: 0 }}>支払 {graph.payments.length}</h3>
        <div className="graph-list">
          {graph.payments.map((p) => (
            <div key={p.id} className="graph-row">
              <div>
                <div className="row" style={{ gap: 6 }}>
                  <span className="code">{p.paymentNo ?? `#${p.id}`}</span>
                  <StatusTag kind="payment" value={p.status} />
                  <span className="code">{money(p.amount, p.currency)}</span>
                  <span className="faint code">期日 {p.dueOn ?? "—"}</span>
                </div>
                <div className="sub">
                  割当 {p.allocations.map((a, i) => (
                    <span key={i} style={{ marginRight: 8 }}>
                      {condNo(a.conditionId)}{a.eventId ? ` 実績#${a.eventId}` : ""} {money(a.amount, p.currency)}
                    </span>
                  ))}
                </div>
              </div>
              <div />
            </div>
          ))}
          {!graph.payments.length && <div className="faint">支払がありません</div>}
        </div>
      </section>

      <p className="faint" style={{ margin: 0 }}>
        この画面は既存の操作を集めただけで、ここだけの書き込みはありません。
        直した結果は条件明細・実績・文書・支払の各タブにそのまま反映されます。
      </p>
    </div>
  );
}

const ISSUE_LABEL: Record<GraphIssue["code"], string> = {
  event_on_dead_document: "実績が死んだ文書に",
  document_has_old_version: "文書に旧版",
  document_condition_not_in_matter: "条件が案件外",
  old_version_linked_to_matter: "旧版が紐づき",
  inspection_without_order: "発注書なし",
  drafts_share_events: "下書きの重複",
  event_on_old_version: "実績が旧版に"
};

const FOLLOW_UP_LABEL: Record<string, string> = {
  wait: "不足分を待つ", settle_short: "不足のまま終了", as_is: "そのまま"
};
