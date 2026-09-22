import { useEffect, useMemo, useState } from "react";
import type { MatterDetail, MatterKind, MatterSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import { SearchSelect, searchParties, staffOptions } from "./SearchSelect.js";
import { CreateForm, int, text } from "./CreateForm.js";
import { DetailBack, isWideLayout } from "./DetailBack.js";
import { MoneyChain } from "./MoneyChain.js";
import { MatterGrid } from "./MatterGrid.js";
import { MatterPartyFilter } from "./MatterPartyFilter.js";
import { filterByParty, partiesOf } from "../server/matters/party-view.js";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { DOCUMENT_STYLE_HINT, DOCUMENT_STYLE_LABEL, MATTER_KIND_HINT,
         MATTER_KIND_LABEL as KIND_LABEL, StatusTag } from "./labels.js";
import { MatterFlow } from "./MatterFlow.js";
import { MatterTimeline } from "./MatterTimeline.js";
import { MatterDrive } from "./MatterDrive.js";
import { MatterConditions, MatterDocuments } from "./MatterLinks.js";
import { DuplicateConditions } from "./DuplicateConditions.js";
import { MatterStatement } from "./MatterStatement.js";
import { MatterEvents } from "./MatterEvents.js";
import { MatterPayments } from "./MatterPayments.js";
import { MatterGraph } from "./MatterGraph.js";
import { Relations, type EntityKind } from "./Relations.js";



type Tab = "grid" | "conditions" | "events" | "documents" | "payments" | "communications" | "graph";

/** 統合の下見。サーバの MatterMergePreview と対。 */
interface MergePreview {
  from: { id: number; matterNo: string | null; title: string };
  into: { id: number; matterNo: string | null; title: string };
  moves: { conditions: number; documents: number; tasks: number; communications: number; links: number; batches: number };
  blockers: string[];
  warnings: string[];
}

interface BacklogResult {
  issueKey: string | null; url: string | null; created: boolean; reason?: string;
  preview?: { subject: string | null; bodyPreview: string };
}

const LINK_LABEL: Record<string, string> = {
  backlog_issue: "Backlog", email_thread: "メール", slack_thread: "Slack",
  document: "文書", agreement: "合意", condition: "条件", payment: "支払"
};

/**
 * 上のタブが持っている紐づけ。
 *
 * 条件明細も文書も matter_links に行が入るので、そのまま表に出すと
 * 「この案件の中身」と同じものが `condition / 5` のような生の形でもう一度並ぶ。
 * 実際、条件と文書は3か所（タブ・この表・つながり）に出ていた。
 * ここに出すのは、専用の置き場が無いもの（Backlog・Slack・メール）だけにする。
 */
const OWNED_BY_TABS = new Set(["condition", "document", "payment"]);

/** 紐づけに写してある状態。Backlog なら課題の状態、メールなら最後の件名。 */
function linkState(snapshot: Record<string, unknown>): string {
  const s = snapshot ?? {};
  if (s.statusName) return `${s.statusName}${s.closed ? "（完了）" : ""}`;
  if (s.lastSubject) return String(s.lastSubject);
  if (s.firstSubject) return String(s.firstSubject);
  return "";
}

const backlogIssue = (detail: MatterDetail): string | null =>
  detail.links.find((l) => l.targetType === "backlog_issue")?.targetRef ?? null;

export function MattersWorkspace(
  { onOpenCondition, initialId, onOpen, onOpenDocument, onCompose, onBulkOrders, onFixDrift, onRegisterAgreement }: {
    onOpenCondition: (id: number) => void;
    initialId?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
    /** 文書の画面へ移って、その文書を開く。 */
    onOpenDocument?: (documentId: number) => void;
    /** 文書の画面へ移って、この案件の条件を選んだ状態で作成に入る。 */
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
    /** 発注書の一括作成（CSV）へ、この案件を決めた状態で移る。 */
    onBulkOrders?: (matterId: number) => void;
    /** 「金額の直し」をこの案件で絞って開く。 */
    onFixDrift?: (matterId: number) => void;
    /** 契約の画面へ、この案件の相手先を入れた状態で登録を開く。 */
    onRegisterAgreement?: (partyId: number, partyName: string | null) => void;
  }
) {
  const [rows, setRows] = useState<MatterSummary[]>([]);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<MatterDetail | null>(null);
  // タブが持っていない紐づけだけ。ここに条件や文書を出すと3か所目になる。
  const externalLinks = (detail?.links ?? []).filter((l) => !OWNED_BY_TABS.has(l.targetType));
  const [kind, setKind] = useState<MatterKind | "all">("all");
  const [tab, setTab] = useState<Tab>("conditions");
  /** 実績タブで開いている条件。条件明細タブの「実績」から来たときはその条件。 */
  const [eventCondition, setEventCondition] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"matter" | "task" | null>(null);
  const [staff, setStaff] = useState<
    Array<{ id: number; name: string; department: string | null; status: string }>>([]);
  const [backlog, setBacklog] = useState<BacklogResult | null>(null);
  const [backlogBusy, setBacklogBusy] = useState(false);
  const [issueKey, setIssueKey] = useState("");
  const [keyword, setKeyword] = useState("");
  // 進め方は後から決まることが多いので、詳細からその場で直せるようにする。
  const [styleEdit, setStyleEdit] = useState(false);
  // 取引モデルは案件が扱うものを決める。作るときに間違えることが多いので直せるようにする。
  const [kindEdit, setKindEdit] = useState(false);
  /** 別の案件への統合。統合先を選ぶ → 何が動くかを見る → 実行。 */
  const [merging, setMerging] = useState(false);
  const [mergeInto, setMergeInto] = useState<{ id: number; label: string } | null>(null);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);

  useEffect(() => {
    if (!merging || !detail || !mergeInto) { setMergePreview(null); return; }
    api.get<MergePreview>(`/matters/merge/preview?fromId=${detail.id}&intoId=${mergeInto.id}`)
      .then(setMergePreview).catch((e: ApiError) => { setMergePreview(null); setError(e.message); });
  }, [merging, mergeInto?.id, detail?.id]);

  async function mergeMatter() {
    if (!detail || !mergeInto || !mergePreview) return;
    const warn = mergePreview.warnings.length ? `\n注意：${mergePreview.warnings.join("／")}` : "";
    if (!confirm(`${detail.matterNo ?? `#${detail.id}`} を ${mergeInto.label} に統合します。`
      + "条件・文書・タスク・やり取り・外部リンクは統合先へ移り、この案件は一覧から消えます（取り消せます）。" + warn)) return;
    setMergeBusy(true); setError(null);
    try {
      await api.post("/matters/merge", { fromId: detail.id, intoId: mergeInto.id,
                                         acknowledge: mergePreview.warnings.length > 0 });
      setMerging(false); setMergeInto(null);
      reloadMatters(mergeInto.id);
      setSelected(mergeInto.id);
    } catch (e) { setError((e as ApiError).message); }
    finally { setMergeBusy(false); }
  }

  async function unmergeMatter() {
    if (!detail?.mergedIntoId) return;
    if (!confirm(`${detail.matterNo ?? `#${detail.id}`} の統合を取り消します。統合のときに移した中身を戻します。`)) return;
    setMergeBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/unmerge`, {});
      reloadMatters(detail.id); reloadDetail();
    } catch (e) { setError((e as ApiError).message); }
    finally { setMergeBusy(false); }
  }
  // 繋ぎ直したら、進み具合と一覧を引き直す。
  const [linkVersion, setLinkVersion] = useState(0);
  // Drive の案件フォルダが使えるか。親フォルダが未設定なら作る導線を出さない。
  const [driveEnabled, setDriveEnabled] = useState(false);
  /** 送信の口。文書を選んで送るときに、メールと CloudSign の on/off を出し分ける。 */
  const [channels, setChannels] =
    useState<Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  /**
   * 取引先で絞る（1案件に20社以上のことがある）。選んでいる間は、条件明細・
   * 実績・文書・支払の4タブが揃ってその社のぶんだけになる。
   */
  const [party, setParty] = useState<number | null>(null);
  useEffect(() => {
    api.get<{ drive: { matterFolders: boolean };
              channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }> }>(
      "/integrations")
      .then((r) => { setDriveEnabled(r.drive.matterFolders); setChannels(r.channels ?? []); })
      .catch(() => undefined);
    api.get<{ user?: { role: string } }>("/me")
      .then((r) => setIsAdmin(r.user?.role === "admin")).catch(() => undefined);
  }, []);
  const relink = () => { setLinkVersion((v) => v + 1); reloadDetail(); };

  /**
   * 取引先の一覧と、絞り込んだあとの案件の中身。
   *
   * 絞り込みは見せ方だけなので、読み直さずここで写しを作る。案件そのもの
   * （工程・取引モデル・相手先）は元の detail のまま出す。
   */
  const parties = useMemo(() => (detail ? partiesOf(detail) : []), [detail]);
  const shown = useMemo(() => (detail ? filterByParty(detail, party) : null), [detail, party]);
  // 別の案件へ移ったら絞り込みは解く（前の案件の社が残ると空の画面になる）。
  useEffect(() => { setParty(null); }, [selected]);

  // 進め方を変えると次にやることが変わるので、進み具合も引き直す。
  // 担当者を決めるときにしか要らないので、開いたときに取りに行く。
  const [ownerEdit, setOwnerEdit] = useState(false);
  useEffect(() => {
    if (!ownerEdit || staff.length) return;
    api.get<{ staff: typeof staff }>("/staff")
      .then((r) => setStaff(r.staff)).catch(() => undefined);
  }, [ownerEdit]);

  function saveOwner(value: string) {
    if (!selected) return;
    api.patch(`/matters/${selected}/owner`, { ownerStaffId: value ? Number(value) : null })
      .then(() => { setOwnerEdit(false); relink(); })
      .catch((e: ApiError) => setError(e.message));
  }

  function saveStyle(value: string) {
    if (!selected) return;
    api.patch(`/matters/${selected}/document-style`, { documentStyle: value || null })
      .then(() => { setStyleEdit(false); relink(); })
      .catch((e: ApiError) => setError(e.message));
  }

  /**
   * 取引モデルを変える。扱える条件の種類が変わるので、いま繋がっている条件が
   * 使えなくなる組み合わせはサーバが断る（条件番号を添えて返る）。
   */
  function saveKind(value: string) {
    if (!selected || !value) return;
    setError(null);
    api.patch(`/matters/${selected}/kind`, { kind: value })
      .then(() => { setKindEdit(false); relink(); })
      .catch((e: ApiError) => setError(e.message));
  }
  const query = useDebounced(keyword);

  function reloadMatters(select?: number) {
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (query.trim()) params.set("q", query.trim());
    api.get<{ matters: MatterSummary[] }>(`/matters${params.toString() ? `?${params}` : ""}`)
      .then((r) => { setRows(r.matters); if (select) setSelected(select); else if (!selected && isWideLayout() && r.matters[0]) setSelected(r.matters[0].id); })
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { reloadMatters(); }, [kind, query]);

  // 選択肢。登録フォームでしか使わないので、開くまで取りに行かない。
  useEffect(() => {
    if (creating === null || staff.length) return;
    api.get<{ staff: typeof staff }>("/staff")
      .then((st) => setStaff(st.staff)).catch(() => undefined);
  }, [creating]);

  function reloadDetail() {
    if (!selected) return;
    api.get<MatterDetail>(`/matters/${selected}`).then(setDetail).catch((e: ApiError) => setError(e.message));
  }

  useEffect(() => {
    if (!selected) return;
    setTab("conditions"); setEventCondition(null);
    setBacklog(null); setIssueKey(""); setStyleEdit(false);
    api.get<MatterDetail>(`/matters/${selected}`).then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [selected]);

  // 工程表は8列あるので、開いている間は一覧を畳んで幅を全部渡す（fullwidth）。
  return (
    <section className={`workspace${selected ? " picked" : ""}${selected && tab === "grid" ? " fullwidth" : ""}`}>
      <header className="workspace-head">
        <h1>案件</h1>
        <p>すべての作業の入口。取引モデルが扱うものを決め、進め方が文書の作り方を決める。条件・文書・支払・連絡はその下にぶら下がる。</p>
      </header>

      <div className="row" style={{ marginBottom: 10 }}>
        {creating === null && (
          <>
            <button className="btn primary btn-sm md-list-only" onClick={() => setCreating("matter")}>案件を登録</button>
            {selected && <button className="btn btn-sm" onClick={() => setCreating("task")}>タスクを追加</button>}
          </>
        )}
      </div>

      {creating === "matter" && (
        <CreateForm
          title="案件の登録"
          path="/matters"
          initial={{ kind: "single" }}
          fields={[
            { name: "title", label: "案件名", required: true },
            { name: "kind", label: "取引モデル", type: "select", required: true,
              options: (["work", "outsourcing", "single"] as const).map((k) => ({
                value: k, label: KIND_LABEL[k]
              })),
              hint: "何を扱うか。使える条件の種類・必要な文書・検査をこれが決める。後から変えると影響が大きい" },
            { name: "documentStyle", label: "進め方", type: "select",
              options: (["counterparty_review", "own_draft", "own_template"] as const).map((k) => ({
                value: k, label: DOCUMENT_STYLE_LABEL[k]
              })),
              hint: "どうやって文書を作るか。分からなければ空のままでよい（後から詳細で入れられる）" },
            { name: "counterpartyId", label: "相手先", type: "search",
              search: searchParties, placeholder: "取引先名・コードで探す" },
            { name: "ownerStaffId", label: "担当者", type: "search",
              options: staffOptions(staff), placeholder: "氏名・部署で探す" },
            { name: "dueOn", label: "期日", type: "date" },
            { name: "requesterEmail", label: "依頼者メール" },
            { name: "remarks", label: "備考", type: "textarea" }
          ]}
          toPayload={(v) => ({
            title: text(v.title), kind: v.kind, documentStyle: text(v.documentStyle),
            counterpartyId: int(v.counterpartyId), ownerStaffId: int(v.ownerStaffId),
            dueOn: text(v.dueOn), requesterEmail: text(v.requesterEmail), remarks: text(v.remarks)
          })}
          onDone={(r) => { setCreating(null); reloadMatters(r.id); }}
          onCancel={() => setCreating(null)}
        />
      )}

      {creating === "task" && selected && (
        <CreateForm
          title="タスクの追加"
          path={`/matters/${selected}/tasks`}
          fields={[
            { name: "title", label: "やること", required: true },
            { name: "assigneeStaffId", label: "担当者", type: "search",
              options: staffOptions(staff), placeholder: "氏名・部署で探す" },
            { name: "dueAt", label: "期日", type: "date",
              hint: "期日を入れると期限一覧に出る。過ぎたものは全部表示される" },
            { name: "description", label: "内容", type: "textarea" }
          ]}
          toPayload={(v) => ({
            title: text(v.title), assigneeStaffId: int(v.assigneeStaffId),
            dueAt: v.dueAt ? new Date(`${v.dueAt}T09:00:00+09:00`).toISOString() : undefined,
            description: text(v.description)
          })}
          onDone={() => { setCreating(null); reloadDetail(); }}
          onCancel={() => setCreating(null)}
        />
      )}

      <div className="filters md-list-only">
        {(["all", "work", "outsourcing", "single"] as const).map((value) => (
          <button key={value} className="chip" aria-pressed={kind === value} onClick={() => setKind(value)}>
            {value === "all" ? "すべて" : KIND_LABEL[value]}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="split">
        <div className="panel md-list">
          <div className="panel-hd">
            <h2>一覧</h2>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="件名・案件番号・相手先" label="案件を絞り込む" />
          </div>
          <ListCount shown={rows.length} keyword={query} onClear={() => setKeyword("")} />
          <div className="tablewrap">
            <table>
              <thead><tr><th>案件番号</th><th>取引モデル</th><th>件名 / 相手先</th><th>状態</th><th>期日</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === selected ? "sel" : ""}
                      tabIndex={0} aria-selected={row.id === selected}
                      onClick={() => setSelected(row.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(row.id); } }}>
                    <td className="code">{row.matterNo ?? `#${row.id}`}</td>
                    <td><span className="tag accent">{KIND_LABEL[row.kind]}</span></td>
                    <td>{row.title}<div className="faint">{row.counterparty?.name ?? "—"}</div></td>
                    <td>
                      <StatusTag kind="matter" value={row.status} />
                      {/* 定額の条件が全部払い切れた案件。支払が終わったかを一覧で見分ける。 */}
                      {row.settled?.fixed > 0 && (
                        row.settled.done >= row.settled.fixed
                          ? <div style={{ marginTop: 3 }}><span className="tag ok">支払済み</span></div>
                          : <div className="faint" style={{ marginTop: 3 }}>支払 {row.settled.done}／{row.settled.fixed} 本</div>
                      )}
                    </td>
                    <td className="code">{row.dueOn ?? "—"}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={5} className="faint">
                    {query.trim() ? `「${query}」に一致する案件はありません` : "案件がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <ListLimit shown={rows.length} />
        </div>

        <div className="stack md-detail">
          <DetailBack label="案件" count={rows.length} onBack={() => setSelected(undefined)} />
          {/* shown は detail から作る写しなので、detail があるときだけ出る。 */}
          {detail && shown && (
            <>
              <div className="panel">
                <div className="panel-hd">
                  <h2 className="code">{detail.matterNo ?? `#${detail.id}`}</h2>
                  <span className="tag accent">{KIND_LABEL[detail.kind]}</span>
                  <StatusTag kind="matter" value={detail.status} />
                  {detail.mergedIntoId && <span className="tag warn">統合済み</span>}
                  {!detail.mergedIntoId && !merging && (
                    <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                            title="同じ仕事の案件が2つできたとき、片方にまとめる。中身は統合先へ移り、取り消せる"
                            onClick={() => { setMerging(true); setMergeInto(null); }}>
                      別の案件に統合する
                    </button>
                  )}
                </div>
                <div className="panel-bd stack">
                  {/* 統合済みの案件。中身は統合先にあるので、そちらへ誘導する。 */}
                  {detail.mergedIntoId && (
                    <div className="note warn">
                      この案件は <span className="code">{detail.mergedIntoNo ?? `#${detail.mergedIntoId}`}</span> に統合されています。
                      条件・文書・タスクは統合先にあります。
                      <span className="row" style={{ marginTop: 6, gap: 6 }}>
                        <button className="btn btn-sm primary" onClick={() => setSelected(detail.mergedIntoId!)}>統合先を開く</button>
                        <button className="btn btn-sm" disabled={mergeBusy} onClick={() => void unmergeMatter()}>統合を取り消す</button>
                      </span>
                    </div>
                  )}
                  {merging && (
                    <div className="note stack" style={{ gap: 8 }}>
                      <div className="row" style={{ alignItems: "center" }}>
                        <b>別の案件に統合する</b>
                        <span className="faint">この案件の中身を統合先へ移し、この案件は統合済みになります</span>
                        <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                                onClick={() => { setMerging(false); setMergeInto(null); }}>やめる</button>
                      </div>
                      <SearchSelect value={mergeInto ? String(mergeInto.id) : ""} autoFocus
                        placeholder="統合先の案件を 件名・案件番号・相手先 で探す"
                        search={async (q) => {
                          const r = await api.get<{ matters: MatterSummary[] }>(`/matters?q=${encodeURIComponent(q)}`);
                          return r.matters.filter((m) => m.id !== detail.id).map((m) => ({
                            value: String(m.id), label: `${m.matterNo ?? `#${m.id}`} ${m.title}`,
                            hint: [KIND_LABEL[m.kind], m.counterparty?.name].filter(Boolean).join("／")
                          }));
                        }}
                        onChange={(v, opt) => setMergeInto(v ? { id: Number(v), label: opt?.label ?? v } : null)} />
                      {mergePreview && (
                        <div className="stack" style={{ gap: 4 }}>
                          <div>
                            <b>{mergePreview.from.matterNo ?? `#${mergePreview.from.id}`}</b> → <b>{mergePreview.into.matterNo ?? `#${mergePreview.into.id}`}</b>
                            （{mergePreview.into.title}）
                          </div>
                          <div className="faint">
                            移るもの：条件 {mergePreview.moves.conditions}／文書 {mergePreview.moves.documents}／
                            タスク {mergePreview.moves.tasks}／やり取り {mergePreview.moves.communications}／
                            外部リンク {mergePreview.moves.links}
                          </div>
                          {mergePreview.blockers.map((b) => <div key={b} className="alert">{b}</div>)}
                          {mergePreview.warnings.map((w) => <div key={w} className="note warn">{w}</div>)}
                          <div className="row">
                            <button className="btn btn-sm primary" disabled={mergeBusy || mergePreview.blockers.length > 0}
                                    onClick={() => void mergeMatter()}>
                              {mergePreview.warnings.length ? "確認のうえ統合する" : "統合する"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="title">{detail.title}</div>
                  <MatterFlow matterId={detail.id} reloadKey={linkVersion}
                          onGo={(t) => setTab(t)}
                          onRegisterAgreement={onRegisterAgreement && detail.counterparty
                            ? () => onRegisterAgreement(detail.counterparty!.id, detail.counterparty!.name ?? null)
                            : undefined} />
                  <dl className="dl">
                    <dt>取引モデル</dt>
                    <dd>
                      {kindEdit ? (
                        <div className="row">
                          <select defaultValue={detail.kind}
                                  onChange={(e) => saveKind(e.target.value)}>
                            {(["work", "outsourcing", "single"] as const).map((k) => (
                              <option key={k} value={k}>{KIND_LABEL[k]}</option>
                            ))}
                          </select>
                          <button className="btn btn-sm" onClick={() => setKindEdit(false)}>やめる</button>
                        </div>
                      ) : (
                        <div className="row">
                          <span>{KIND_LABEL[detail.kind]}</span>
                          <button className="btn btn-sm" onClick={() => setKindEdit(true)}>変更</button>
                        </div>
                      )}
                      <div className="faint">{MATTER_KIND_HINT[detail.kind]}</div>
                      {kindEdit && (
                        <div className="faint">
                          変えると扱える条件の種類と工程が変わります。
                          いま繋がっている条件が使えなくなる組み合わせは断られます
                        </div>
                      )}
                    </dd>
                    <dt>進め方</dt>
                    <dd>
                      {styleEdit ? (
                        <div className="row">
                          <select
                            defaultValue={detail.documentStyle ?? ""}
                            onChange={(e) => saveStyle(e.target.value)}
                          >
                            <option value="">未設定</option>
                            {(["counterparty_review", "own_draft", "own_template"] as const).map((k) => (
                              <option key={k} value={k}>{DOCUMENT_STYLE_LABEL[k]}</option>
                            ))}
                          </select>
                          <button className="btn btn-sm" onClick={() => setStyleEdit(false)}>やめる</button>
                        </div>
                      ) : (
                        <div className="row">
                          <span>{detail.documentStyle
                            ? DOCUMENT_STYLE_LABEL[detail.documentStyle] : "未設定"}</span>
                          <button className="btn btn-sm" onClick={() => setStyleEdit(true)}>変更</button>
                        </div>
                      )}
                      <div className="faint">{detail.documentStyle
                        ? DOCUMENT_STYLE_HINT[detail.documentStyle]
                        : "決めると、次にやることが「相手方の文書を確認」なのか「自社ドラフトを決定」なのかが出る"}</div>
                    </dd>
                    <dt>相手先</dt><dd>{detail.counterparty?.name ?? "—"}</dd>
                    <dt>担当</dt>
                    <dd>
                      {ownerEdit ? (
                        <div className="row">
                          {/* 名前で探して決める。退職者は書類に出す担当にできないので出さない。 */}
                          <SearchSelect value="" autoFocus emptyLabel="未設定にする"
                                        options={staffOptions(staff)} placeholder="氏名・部署で探す"
                                        onChange={(v) => saveOwner(v)} />
                          <button className="btn btn-sm"
                                  onClick={() => setOwnerEdit(false)}>やめる</button>
                        </div>
                      ) : (
                        <div className="row">
                          <span>{detail.ownerName ?? "未設定"}</span>
                          <button className="btn btn-sm"
                                  onClick={() => setOwnerEdit(true)}>変更</button>
                        </div>
                      )}
                      {/* 検収書の【ご連絡先】はここから部署・氏名・メールを差す。
                          空だと連絡先が丸ごと空の書類になる。 */}
                      {!detail.ownerName && (
                        <div className="faint">
                          未設定です。この案件から出す検収書の【ご連絡先】が空欄になります
                        </div>
                      )}
                    </dd>
                    {detail.blockedReason && (<><dt>停滞理由</dt><dd>{detail.blockedReason}</dd></>)}
                    <dt>Drive</dt>
                    <dd>
                      <MatterDrive matterId={detail.id} folderUrl={detail.driveFolderUrl}
                                   enabled={driveEnabled} onChanged={reloadDetail} />
                    </dd>
                  </dl>
                </div>
              </div>

              <div className="panel">
                <div className="panel-hd"><h2>この案件の中身</h2></div>
                <div className="panel-bd">
                  {/* 取引先で絞る。選ぶと下の4タブが揃ってその社のぶんだけになる。
                      タブの数字も絞ったあとの数に変わる（数と中身が食い違わない）。 */}
                  <MatterPartyFilter parties={parties} value={party} onChange={setParty} />

                  <div className="tabs">
                    {([["grid", "工程表"],
                       ["conditions", `条件明細 ${shown.conditions.length}`],
                       ["events", "実績"],
                       ["documents", `文書 ${shown.documents.length}`],
                       ["payments", `支払 ${shown.payments.length}`],
                       ["communications", `操作の記録 ${detail.communications.length}`],
                       ["graph", "整理"]] as const).map(([key, label]) => (
                      <button key={key} aria-selected={tab === key} onClick={() => setTab(key as Tab)}>{label}</button>
                    ))}
                  </div>

                  {/* どのタブにいても出したままにする。案件に戻れば順番を思い出せるように。 */}
                  <MoneyChain kind={detail.kind} tab={tab} onGo={(next) => setTab(next as Tab)} />

                  {tab === "grid" && (
                    <MatterGrid matterId={detail.id} partyId={party} reloadKey={linkVersion}
                      onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
                      onCompose={(conditionIds, eventIds, mid, templateKey) =>
                        onCompose?.(conditionIds, eventIds, mid ?? detail.id, templateKey)}
                      onRecordEvent={(id) => { setEventCondition(id); setTab("events"); }}
                      onOpenPayments={() => setTab("payments")}
                      onFixDrift={onFixDrift && (() => onFixDrift(detail.id))} />
                  )}

                  {tab === "conditions" && (
                    <div className="stack">
                      <MatterConditions detail={shown} onChanged={relink}
                        onOpenCondition={onOpenCondition} onCompose={onCompose}
                        onRecordEvent={(id) => { setEventCondition(id); setTab("events"); }} />
                      {/* 取引モデルが何本あっても計算書は1枚。条件ごとに1枚ずつ
                          出す口しか無く、束ねる手段が画面にもサーバにも無かった。 */}
                      <MatterStatement detail={shown}
                        onChanged={relink} onOpenDocument={onOpenDocument} />
                    </div>
                  )}

                  {tab === "events" && (
                    <MatterEvents detail={shown} conditionId={eventCondition} onPick={setEventCondition}
                      onCompose={onCompose} onOpenDocument={onOpenDocument} onChanged={relink} />
                  )}

                  {tab === "documents" && (
                    <MatterDocuments detail={shown} onChanged={relink}
                      onOpenDocument={onOpenDocument} onCompose={onCompose}
                      onBulkOrders={onBulkOrders} channels={channels} isAdmin={isAdmin} />
                  )}

                  {tab === "payments" && (
                    <MatterPayments detail={shown} onChanged={relink} onOpenDocument={onOpenDocument}
                                    isAdmin={isAdmin} />
                  )}

                  {tab === "graph" && (
                    <div className="panel" style={{ marginBottom: 14 }}>
                      <div className="panel-hd">
                        <h2>同じ内容で重複している条件明細</h2>
                        <span className="faint">見つけるだけで、残すものは決めません</span>
                      </div>
                      <div className="panel-bd">
                        <DuplicateConditions matterId={detail.id} onChanged={relink}
                          onOpenCondition={onOpenCondition} />
                      </div>
                    </div>
                  )}

                  {tab === "graph" && (
                    <MatterGraph matterId={detail.id} reloadKey={linkVersion} onChanged={relink}
                      onOpenDocument={onOpenDocument} onOpenCondition={onOpenCondition} />
                  )}

                  {tab === "communications" && (
                    <table>
                      <thead><tr><th>日時</th><th>操作</th><th>実行者</th></tr></thead>
                      <tbody>
                        {detail.communications.map((c, index) => (
                          <tr key={`${c.occurredAt}-${index}`}>
                            <td className="code">{c.occurredAt.slice(0, 16).replace("T", " ")}</td>
                            <td className="code">{c.action}</td><td>{c.actor}</td>
                          </tr>
                        ))}
                        {!detail.communications.length && <tr><td colSpan={3} className="faint">記録はありません</td></tr>}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <MatterTimeline matterId={detail.id} documents={detail.documents} reloadKey={linkVersion} />

              <div className="panel">
                <div className="panel-hd">
                  <h2>外部システム</h2>
                  <span className="faint">Backlog・Slack・メール。案件の外にある記録</span>
                </div>
                {/* 空のときは表を出さない。見出しだけの表の下に「課題を立てる」が
                    並ぶと、何の表なのか読めない。 */}
                {externalLinks.length > 0 && (
                  <div className="panel-bd">
                    <table>
                      <thead><tr><th>種別</th><th>参照</th><th>関係</th><th>状態</th></tr></thead>
                      <tbody>
                        {externalLinks.map((l) => (
                          <tr key={`${l.targetType}-${l.targetRef}`}>
                            <td>{LINK_LABEL[l.targetType] ?? l.targetType}</td>
                            <td className="code">{l.targetRef}</td>
                            <td>{l.relation}</td>
                            <td className="faint">{linkState(l.snapshot)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="panel-bd" style={externalLinks.length
                        ? { borderTop: "1px solid var(--line)" } : undefined}>
                  {backlogIssue(detail) ? (
                    <div className="row">
                      <span className="faint">
                        Backlog：<span className="code">{backlogIssue(detail)}</span> と繋がっています。
                        課題の状態が変わるとこの表に写ります（案件の状態は自動では動きません）。
                      </span>
                      <button className="btn btn-sm" disabled={backlogBusy} onClick={async () => {
                        if (!confirm(`${backlogIssue(detail)} との紐づけを外します。課題そのものは消えません。`)) return;
                        setBacklogBusy(true); setError(null);
                        try {
                          await api.del(`/matters/${detail.id}/backlog/${backlogIssue(detail)}`);
                          setBacklog(null); reloadDetail();
                        } catch (e) { setError((e as ApiError).message); }
                        finally { setBacklogBusy(false); }
                      }}>紐づけを外す</button>
                    </div>
                  ) : (
                    <div className="stack" style={{ gap: 9 }}>
                      <div className="row">
                        <button className="btn primary" disabled={backlogBusy} onClick={async () => {
                          setBacklogBusy(true); setError(null);
                          try {
                            setBacklog(await api.post<BacklogResult>(`/matters/${detail.id}/backlog`, {}));
                            reloadDetail();
                          } catch (e) { setError((e as ApiError).message); }
                          finally { setBacklogBusy(false); }
                        }}>Backlog に課題を立てる</button>
                        <span className="faint">1案件に1課題。二度押しても増えません</span>
                      </div>
                      <div className="row">
                        <input className="inline-input" value={issueKey} placeholder="LEGAL-12"
                          onChange={(e) => setIssueKey(e.target.value)} />
                        <button className="btn" disabled={backlogBusy || !issueKey.trim()}
                          onClick={async () => {
                            setBacklogBusy(true); setError(null);
                            try {
                              setBacklog(await api.post<BacklogResult>(
                                `/matters/${detail.id}/backlog/link`, { issueKey: issueKey.trim() }));
                              setIssueKey(""); reloadDetail();
                            } catch (e) { setError((e as ApiError).message); }
                            finally { setBacklogBusy(false); }
                          }}>すでにある課題に繋ぐ</button>
                        <span className="faint">
                          Backlog で先に立てた課題はこちらから。繋がないと課題の更新が届きません
                        </span>
                      </div>
                    </div>
                  )}
                  {backlog && !backlog.created && !backlog.issueKey && (
                    <div className="note warn" style={{ marginTop: 9 }}>
                      課題は立ちませんでした：{backlog.reason ?? "理由不明"}
                      {backlog.preview && (
                        <pre className="pre" style={{ marginTop: 8 }}>
                          {backlog.preview.subject}{"\n\n"}{backlog.preview.bodyPreview}
                        </pre>
                      )}
                    </div>
                  )}
                  {backlog?.issueKey && (
                    <div className="note ok" style={{ marginTop: 9 }}>
                      <a href={backlog.url ?? "#"} target="_blank" rel="noreferrer">{backlog.issueKey}</a>
                      {backlog.created ? " を立てました。" : ` ${backlog.reason ?? "に繋ぎました。"}`}
                    </div>
                  )}
                </div>
              </div>

              {/*
                どちらの画面からも同じ関連を触れるようにするための共通部品。
                案件では条件明細と文書を外す：上のタブが同じものを、繋ぐ・外す付きで
                持っているので、ここに出すと3か所目になる（実際そうなっていた）。
              */}
              <Relations kind="matter" id={detail.id} reloadKey={linkVersion}
                exclude={["conditions", "documents"]}
                onOpen={onOpen} onChanged={relink} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
