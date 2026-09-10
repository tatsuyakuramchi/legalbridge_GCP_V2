import { useEffect, useState } from "react";
import type { MatterDetail, MatterKind, MatterSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import { SearchSelect, searchParties, staffOptions } from "./SearchSelect.js";
import { CreateForm, int, text } from "./CreateForm.js";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { DOCUMENT_STYLE_HINT, DOCUMENT_STYLE_LABEL, MATTER_KIND_HINT,
         MATTER_KIND_LABEL as KIND_LABEL, StatusTag } from "./labels.js";
import { MatterFlow } from "./MatterFlow.js";
import { MatterTimeline } from "./MatterTimeline.js";
import { MatterDrive } from "./MatterDrive.js";
import { MatterConditions, MatterDocuments } from "./MatterLinks.js";
import { Relations, type EntityKind } from "./Relations.js";



type Tab = "conditions" | "documents" | "payments" | "communications";

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
  { onOpenCondition, initialId, onOpen, onOpenDocument, onCompose }: {
    onOpenCondition: (id: number) => void;
    initialId?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
    /** 文書の画面へ移って、その文書を開く。 */
    onOpenDocument?: (documentId: number) => void;
    /** 文書の画面へ移って、この案件の条件を選んだ状態で作成に入る。 */
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null) => void;
  }
) {
  const [rows, setRows] = useState<MatterSummary[]>([]);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<MatterDetail | null>(null);
  // タブが持っていない紐づけだけ。ここに条件や文書を出すと3か所目になる。
  const externalLinks = (detail?.links ?? []).filter((l) => !OWNED_BY_TABS.has(l.targetType));
  const [kind, setKind] = useState<MatterKind | "all">("all");
  const [tab, setTab] = useState<Tab>("conditions");
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
  // 繋ぎ直したら、進み具合と一覧を引き直す。
  const [linkVersion, setLinkVersion] = useState(0);
  // Drive の案件フォルダが使えるか。親フォルダが未設定なら作る導線を出さない。
  const [driveEnabled, setDriveEnabled] = useState(false);
  useEffect(() => {
    api.get<{ drive: { matterFolders: boolean } }>("/integrations")
      .then((r) => setDriveEnabled(r.drive.matterFolders)).catch(() => undefined);
  }, []);
  const relink = () => { setLinkVersion((v) => v + 1); reloadDetail(); };

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
  const query = useDebounced(keyword);

  function reloadMatters(select?: number) {
    const params = new URLSearchParams();
    if (kind !== "all") params.set("kind", kind);
    if (query.trim()) params.set("q", query.trim());
    api.get<{ matters: MatterSummary[] }>(`/matters${params.toString() ? `?${params}` : ""}`)
      .then((r) => { setRows(r.matters); if (select) setSelected(select); else if (!selected && r.matters[0]) setSelected(r.matters[0].id); })
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
    setTab("conditions");
    setBacklog(null); setIssueKey(""); setStyleEdit(false);
    api.get<MatterDetail>(`/matters/${selected}`).then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [selected]);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>案件</h1>
        <p>すべての作業の入口。取引モデルが扱うものを決め、進め方が文書の作り方を決める。条件・文書・支払・連絡はその下にぶら下がる。</p>
      </header>

      <div className="row" style={{ marginBottom: 10 }}>
        {creating === null && (
          <>
            <button className="btn primary btn-sm" onClick={() => setCreating("matter")}>案件を登録</button>
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

      <div className="filters">
        {(["all", "work", "outsourcing", "single"] as const).map((value) => (
          <button key={value} className="chip" aria-pressed={kind === value} onClick={() => setKind(value)}>
            {value === "all" ? "すべて" : KIND_LABEL[value]}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="split">
        <div className="panel">
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
                    <td><StatusTag kind="matter" value={row.status} /></td>
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

        <div className="stack">
          {detail && (
            <>
              <div className="panel">
                <div className="panel-hd">
                  <h2 className="code">{detail.matterNo ?? `#${detail.id}`}</h2>
                  <span className="tag accent">{KIND_LABEL[detail.kind]}</span>
                  <StatusTag kind="matter" value={detail.status} />
                </div>
                <div className="panel-bd stack">
                  <div className="title">{detail.title}</div>
                  <MatterFlow matterId={detail.id} reloadKey={linkVersion}
                          onGo={(t) => setTab(t)} />
                  <dl className="dl">
                    <dt>取引モデル</dt>
                    <dd>{KIND_LABEL[detail.kind]}
                      <div className="faint">{MATTER_KIND_HINT[detail.kind]}</div></dd>
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
                  <div className="tabs">
                    {([["conditions", `条件明細 ${detail.conditions.length}`],
                       ["documents", `文書 ${detail.documents.length}`],
                       ["payments", `支払 ${detail.payments.length}`],
                       ["communications", `操作の記録 ${detail.communications.length}`]] as const).map(([key, label]) => (
                      <button key={key} aria-selected={tab === key} onClick={() => setTab(key as Tab)}>{label}</button>
                    ))}
                  </div>

                  {tab === "conditions" && (
                    <MatterConditions detail={detail} onChanged={relink}
                      onOpenCondition={onOpenCondition} />
                  )}

                  {tab === "documents" && (
                    <MatterDocuments detail={detail} onChanged={relink}
                      onOpenDocument={onOpenDocument} onCompose={onCompose} />
                  )}

                  {tab === "payments" && (
                    <table>
                      <thead><tr><th>支払番号</th><th>向き</th><th className="num">金額</th><th>期日</th><th>状態</th></tr></thead>
                      <tbody>
                        {detail.payments.map((p) => (
                          <tr key={p.id}>
                            <td className="code">{p.paymentNo ?? `#${p.id}`}</td>
                            <td>{p.direction === "in" ? "入金" : "支払"}</td>
                            <td className="num">{money(p.amount, p.currency)}</td>
                            <td className="code">{p.dueOn ?? "—"}</td><td><StatusTag kind="payment" value={p.status} /></td>
                          </tr>
                        ))}
                        {!detail.payments.length && <tr><td colSpan={5} className="faint">支払はありません</td></tr>}
                      </tbody>
                    </table>
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
