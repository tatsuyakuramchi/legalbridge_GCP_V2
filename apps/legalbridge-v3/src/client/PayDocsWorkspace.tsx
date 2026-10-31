import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect, searchParties, type SearchOption } from "./SearchSelect.js";
import { EventEntryForm } from "./EventEntryForm.js";
import { RoyaltyLedger, type DocBack } from "./RoyaltyLedger.js";
import { EbookSalesImport } from "./EbookSalesImport.js";
import { RoyaltyReceipts } from "./RoyaltyReceipts.js";
import type { PayDocRow, PayDocTile, NextAction } from "../server/paydocs/rows.js";
import type { PayDocsList } from "../server/paydocs/service.js";
import { ProcessRail, type Station } from "./ProcessRail.js";

/**
 * 支払文書（A-074）。計算書・検収書・役務提供完了通知書を、回ごとに
 *   起点（製造・納品／締め・報告・入金）→ 文書 → 送付 → 受領 → 支払
 * まで 1 本の表で見る。判定はサーバの 1 か所（paydocs/rows.ts）。案件・条件明細・作品に
 * 埋め込むときは scope で絞るだけ（同じ表・同じ判定）。
 *
 * 文書を作るのは作業テーブル（この回の実績を渡す）。ここで記録するのは
 * 送付済み（システムの外で送ったもの）・受領・支払を立てる・製造予定・過去分。
 */

export interface PayDocsHandoff {
  conditionId: number; conditionName: string; roundLabel: string; scheduleId: number | null; eventId: number | null;
}

export type PayDocsPane = "list" | "receipts" | "author" | "imports" | "plans" | "past";
type Pane = PayDocsPane;

/** 作家の報告と計算書を開く先。支払文書の行・作品・デイリータスクから来る。 */
export interface AuthorTarget { partyId: number; partyName?: string | null; workId?: number | null;
                                focus?: { conditionId: number; closeOn: string | null } | null }

/**
 * 作家の台帳（報告を入れる・計算書を作る）で扱う回か。料率・単価で計算する取得（IN）の許諾料。
 * それ以外（検収書・役務提供完了通知書・OUT の許諾料）は作業テーブルで作る。
 */
export const isLedgerRow = (r: PayDocRow) =>
  (r.condition.kind === "license" || r.condition.kind === "product") && r.condition.direction === "in"
  && (r.condition.pricingModel === "revenue_rate" || r.condition.pricingModel === "unit_rate") && !!r.party;

const TILES: Array<{ key: PayDocTile; label: string; sub: string; tone?: "warn" | "bad" }> = [
  { key: "wait", label: "発生・報告待ち", sub: "製造予定・報告・入金" },
  { key: "make", label: "作れる", sub: "実績がそろった回" },
  { key: "draft", label: "下書き", sub: "決定前" },
  { key: "unsent", label: "未送付", sub: "決定済み・送っていない", tone: "warn" },
  { key: "await", label: "受領待ち", sub: "署名返送・確認期限", tone: "warn" },
  { key: "overdue", label: "期限超過", sub: "報告・受領・支払", tone: "bad" },
  { key: "nopay", label: "支払未設定", sub: "送付済み・支払なし" }
];
const KINDS: Array<[string, string]> = [
  ["", "種類：すべて"], ["royalty_statement", "計算書"], ["inspection_certificate", "検収書"],
  ["service_completion_notice", "役務提供完了通知書"]
];
const SENT_VIA: Array<[string, string]> = [
  ["post", "郵送"], ["hand", "手渡し"], ["email_other", "別のメール"], ["cloudsign_ui", "CloudSign の画面から"], ["other", "その他"]
];
const RECEIVED_VIA: Array<[string, string]> = [
  ["signed_copy", "署名済みの控え"], ["reply", "メールの返信"], ["verbal", "口頭・電話"], ["other", "その他"]
];
const VIA_LABEL: Record<string, string> = {
  gmail: "メール", cloudsign: "CloudSign", post: "郵送", hand: "手渡し", email_other: "別のメール",
  cloudsign_ui: "CloudSign の画面", past: "過去分", other: "その他", signed_copy: "署名済みの控え", reply: "メールの返信",
  verbal: "口頭・電話", confirmed: "相手の確認", deemed: "みなし確認"
};
const NEXT_LABEL: Record<NextAction, string> = {
  record_event: "実績を入れる", remind_report: "報告を督促", compose: "作る（作業テーブルへ）", finish_draft: "下書きを仕上げる",
  send: "送る・送付済みにする", remind_receipt: "受領を督促", record_receipt: "受領を記録", pay: "支払を立てる", none: "—"
};

/** 次にすることの札。許諾料の報告・計算書は作家の台帳へ移る。 */
const nextLabel = (r: PayDocRow) => isLedgerRow(r) && r.next === "compose" ? "計算書を作る（作家の台帳へ）"
  : isLedgerRow(r) && r.next === "record_event" ? (r.trigger === "active" ? "製造を入れる（作家の台帳へ）" : "報告を入れる（作家の台帳へ）")
  : NEXT_LABEL[r.next];

const md = (iso: string | null | undefined) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "");
const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "acc" | "none"; children: React.ReactNode }) {
  const style: Record<string, React.CSSProperties> = {
    ok: { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "transparent" },
    warn: { background: "var(--warn-soft)", color: "var(--warn)", borderColor: "transparent" },
    bad: { background: "var(--out-soft)", color: "var(--out)", borderColor: "transparent", fontWeight: 700 },
    acc: { background: "var(--accent-soft)", color: "var(--accent)", borderColor: "transparent" },
    none: { color: "var(--faint)" }
  };
  return <span className="tag" style={style[tone]}>{children}</span>;
}

function SourceCell({ r }: { r: PayDocRow }) {
  const tone = r.source.state === "ok" ? "ok" : r.source.state === "late" ? "bad" : r.source.state === "waiting" ? "warn" : "none";
  return (
    <>
      <div className="faint">{r.trigger === "active" ? "イベント式" : "時限式"}</div>
      <Pill tone={tone}>{r.source.state === "late" ? `${r.source.label}（期限超過）` : r.source.label}</Pill>
      {r.source.detail && <div className="faint">{r.source.detail}</div>}
    </>
  );
}
function DocCell({ r, onOpenDocument }: { r: PayDocRow; onOpenDocument: (id: number) => void }) {
  const s = r.doc.state;
  return (
    <>
      {s === "wait" ? <Pill tone="none">実績待ち</Pill>
        : s === "make" ? <Pill tone="acc">{r.doc.partial ? "作れる（一部）" : "作れる"}</Pill>
        : s === "draft" ? <Pill tone="warn">下書き</Pill> : <Pill tone="ok">決定</Pill>}
      {r.doc.documents.map((d) => (
        <div key={d.id}><button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button></div>
      ))}
    </>
  );
}
function SendCell({ r }: { r: PayDocRow }) {
  const s = r.send.state;
  if (s === "none") return <Pill tone="none">—</Pill>;
  if (s === "na") return <Pill tone="none">受け取った文書</Pill>;
  if (s === "unsent") return <Pill tone="warn">未送付</Pill>;
  if (s === "past") return <Pill tone="none">過去分</Pill>;
  return (
    <>
      <Pill tone={s === "partial" ? "warn" : "ok"}>{s === "partial" ? "一部送付" : VIA_LABEL[r.send.via ?? ""] ?? "送付済"}</Pill>
      <div className="faint">{md(r.send.on)}</div>
    </>
  );
}
function ReceiptCell({ r }: { r: PayDocRow }) {
  const s = r.receipt.state;
  if (s === "none") return <Pill tone="none">—</Pill>;
  if (s === "na") return <Pill tone="none">不要</Pill>;
  if (s === "received") return <><Pill tone="ok">受領</Pill><div className="faint">{VIA_LABEL[r.receipt.via ?? ""] ?? ""} {md(r.receipt.on)}</div></>;
  const sc = r.doc.documents.some((d) => d.receipt.rule === "deemed");
  return (
    <>
      <Pill tone={s === "late" ? "bad" : "warn"}>{s === "late" ? "期限超過" : sc ? "確認期限" : "署名返送待ち"}</Pill>
      <div className="faint">期限 {md(r.receipt.dueOn)}</div>
    </>
  );
}
function PayCell({ r }: { r: PayDocRow }) {
  const s = r.payment.state;
  const out = r.condition.direction === "out";
  if (s === "none") return <Pill tone="none">—</Pill>;
  if (s === "nopay") return <Pill tone="none">支払なし</Pill>;
  if (s === "unset") return <Pill tone="none">未設定</Pill>;
  if (s === "paid") return <><Pill tone="ok">{out ? "入金済" : "済"}</Pill><div className="faint">{md(r.payment.paidOn)}</div></>;
  return <Pill tone={r.payment.dueOn && r.payment.dueOn < today() ? "bad" : "acc"}>予定 {md(r.payment.dueOn)}</Pill>;
}

export function PayDocsWorkspace(
  { scope, onOpenCondition, onOpenDocument, onOpenDraft, onIssueRound, onComposeEvents, onOpenClosing,
    author, onOpenAuthor, onLedgerCompose, onOpenRequest, initialTile, initialPane }: {
    /** 開いたときに押しておく札（ホームの盤面から）。 */
    initialTile?: PayDocTile | null;
    /** 開いたときのタブ（旧 回の一覧の URL から来たときは「入金と作者への支払」）。 */
    initialPane?: PayDocsPane | null;
    /** 予定どおりにまとめて締める（旧 支払文書処理の一括）。 */
    onOpenClosing?: () => void;
    /** 開いておく作家（支払文書の外から「作家の報告と計算書」へ来たとき）。 */
    author?: (AuthorTarget & { nonce: number }) | null;
    /** 作家の報告と計算書を開く。埋め込み（作品のタブ）からは支払文書の画面へ移る。 */
    onOpenAuthor?: (a: AuthorTarget) => void;
    /** 作家の台帳から計算書を作る：文書の画面へ（戻り先はこの作家）。 */
    onLedgerCompose?: (conditionIds: number[], eventIds: number[], templateKey: string | null, back: DocBack,
                       revise?: { supersedesIds: number[]; reason: string } | null) => void;
    onOpenRequest?: (requestId: number) => void;
    /** 作品・相手先・案件・条件に絞って埋め込むとき。 */
    scope?: { workId?: number; partyId?: number; matterId?: number; conditionId?: number };
    onOpenCondition: (id: number) => void;
    onOpenDocument: (id: number) => void;
    /** 下書きを文書の画面で直す。 */
    onOpenDraft: (id: number) => void;
    /** 予定の回の決済文書を作る：作業テーブルへ。 */
    onIssueRound: (h: PayDocsHandoff) => void;
    /** 予定の外の実績（製造 1 回など）から作る：作業テーブルへ実績を渡す。 */
    onComposeEvents: (conditionIds: number[], eventIds: number[], templateKey: string | null) => void;
  }
) {
  const embedded = !!scope;
  const [pane, setPane] = useState<Pane>(author ? "author" : initialPane ?? "list");
  /** 作家の台帳から「送付・受領・支払」へ戻ったとき、一覧をその作家で絞る。 */
  const [listParty, setListParty] = useState<number | null>(null);
  const [who, setWho] = useState<(AuthorTarget & { nonce: number }) | null>(author ?? null);
  useEffect(() => { if (author) { setWho(author); setPane("author"); } }, [author?.nonce]);
  /** 行から作家を開く。この画面の中ならタブを移る。埋め込みなら外へ頼む。 */
  const openAuthor = (a: AuthorTarget) => {
    if (embedded) { onOpenAuthor?.(a); return; }
    setWho({ ...a, nonce: Date.now() }); setPane("author");
  };
  return (
    <section className={embedded ? "stack" : "workspace"}>
      {!embedded && (
        <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
          <h1 style={{ margin: 0 }}>支払文書</h1>
          <span className="faint">計算書・検収書・役務提供完了通知書を、回ごとに 作る → 送る → 受領 → 支払 まで見ます</span>
          {onOpenClosing && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onOpenClosing}>予定どおりにまとめて締める（一括）</button>}
        </div>
      )}
      {!embedded && (
        <div className="tabs" role="tablist" aria-label="支払文書の見出し">
          <button role="tab" aria-selected={pane === "list"} onClick={() => setPane("list")}>一覧</button>
          {/* 取引先からの入金（OUT）ごとに、払うべき作者（IN）の報告と計算書（docs/royalty-ledger.md §10）。 */}
          <button role="tab" aria-selected={pane === "receipts"} onClick={() => setPane("receipts")}>入金と作者への支払</button>
          <button role="tab" aria-selected={pane === "author"} onClick={() => setPane("author")}>作家の報告と計算書</button>
          <button role="tab" aria-selected={pane === "imports"} onClick={() => setPane("imports")}>売上の取込（電子書籍・年次締め）</button>
          <button role="tab" aria-selected={pane === "plans"} onClick={() => setPane("plans")}>製造予定</button>
          <button role="tab" aria-selected={pane === "past"} onClick={() => setPane("past")}>過去分の整理</button>
        </div>
      )}
      {pane === "list" && (
        <PayDocsTable key={`l${listParty ?? 0}`} initialPartyId={listParty} initialTile={initialTile} scope={scope} onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
                     onOpenDraft={onOpenDraft} onIssueRound={onIssueRound} onComposeEvents={onComposeEvents}
                     onOpenAuthor={openAuthor} />
      )}
      {pane === "author" && (
        <AuthorPane who={who} onPick={(a) => setWho({ ...a, nonce: Date.now() })} onOpenDocument={onOpenDocument}
                    onOpenRequest={onOpenRequest} onLedgerCompose={onLedgerCompose}
                    onOpenList={(partyId) => { setPane("list"); setListParty(partyId); }} />
      )}
      {pane === "receipts" && <RoyaltyReceipts onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument} />}
      {pane === "imports" && <EbookSalesImport />}
      {pane === "plans" && <PlansPane />}
      {pane === "past" && <PastPane />}
    </section>
  );
}

function PayDocsTable(
  { scope, onOpenCondition, onOpenDocument, onOpenDraft, onIssueRound, onComposeEvents, onOpenAuthor, initialPartyId, initialTile }:
    Parameters<typeof PayDocsWorkspace>[0] & { onOpenAuthor: (a: AuthorTarget) => void; initialPartyId?: number | null }
) {
  const readOnly = useReadOnly();
  const embedded = !!scope;
  const [view, setView] = useState<"todo" | "all" | "past">(embedded ? "all" : "todo");
  const [tile, setTile] = useState<PayDocTile | null>(initialTile ?? null);
  const [kind, setKind] = useState("");
  const [trigger, setTrigger] = useState<"" | "active" | "passive">("");
  const [month, setMonth] = useState("");
  const [q, setQ] = useState("");
  const [partyId, setPartyId] = useState<number | null>(initialPartyId ?? null);
  const [partyLabel, setPartyLabel] = useState<string | null>(null);
  const [data, setData] = useState<PayDocsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [bulk, setBulk] = useState<"sent" | "received" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ view });
    if (tile) p.set("tile", tile);
    if (kind) p.set("templateKey", kind);
    if (trigger) p.set("trigger", trigger);
    if (month) p.set("month", month);
    if (q.trim()) p.set("q", q.trim());
    const party = scope?.partyId ?? partyId;
    if (party) p.set("partyId", String(party));
    if (scope?.workId) p.set("workId", String(scope.workId));
    if (scope?.matterId) p.set("matterId", String(scope.matterId));
    if (scope?.conditionId) p.set("conditionId", String(scope.conditionId));
    try { setData(await api.get<PayDocsList>(`/paydocs?${p}`)); setError(null); }
    catch (e) { setError(errText(e)); }
  }, [view, tile, kind, trigger, month, q, partyId, scope?.partyId, scope?.workId, scope?.matterId, scope?.conditionId]);
  useEffect(() => { void load(); }, [load]);

  const rows = data?.rows ?? [];
  const open = rows.find((r) => r.key === openKey) ?? null;
  const chosen = rows.filter((r) => selected.has(r.key));
  const chosenDocs = chosen.flatMap((r) => r.doc.documents.filter((d) => !d.inbound).map((d) => d.id));
  const months = useMemo(() => {
    const out: string[] = [];
    const now = new Date(Date.now() + 9 * 3_600_000);
    for (let i = -6; i <= 3; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      out.push(d.toISOString().slice(0, 7));
    }
    return out.reverse();
  }, []);

  const done = async (msg: string) => { setNotice(msg); setSelected(new Set()); setBulk(null); await load(); };
  async function run(fn: () => Promise<string>) {
    if (readOnly) return;
    setBusy(true); setError(null); setNotice(null);
    try { await done(await fn()); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  /** 次にすること（1 行）。作る・下書きは画面を移る。 */
  function act(r: PayDocRow, action: NextAction) {
    // 許諾料（IN・料率/単価）の報告と計算書は作家の台帳で（作家でまとめる・取引モデル・報告の行）。
    if (isLedgerRow(r) && (action === "compose" || action === "record_event")) {
      onOpenAuthor({ partyId: r.party!.id, partyName: r.party!.name, workId: null,
                     focus: { conditionId: r.condition.id, closeOn: r.closeOn } });
      return;
    }
    if (action === "compose") {
      if (r.scheduleId) {
        onIssueRound({ conditionId: r.condition.id, conditionName: r.condition.name, roundLabel: r.label,
                       scheduleId: r.scheduleId, eventId: r.eventIds[0] ?? null });
      } else onComposeEvents([r.condition.id], r.eventIds, r.templateKey);
      return;
    }
    if (action === "finish_draft" && r.doc.draftId) { onOpenDraft(r.doc.draftId); return; }
    setOpenKey(r.key);
  }

  async function bulkCompose() {
    // 予定の回はまとめて作業テーブルへ渡せないので、1 回目を渡す（残りは戻ってから続ける）。
    const first = chosen.find((r) => r.next === "compose");
    if (first) act(first, "compose");
  }
  async function bulkPay() {
    await run(async () => {
      let n = 0;
      for (const r of chosen.filter((x) => x.next === "pay")) {
        for (const d of r.doc.documents) { await api.post(`/documents/${d.id}/payment`, {}); n++; }
      }
      return `${n} 件の支払を立てました`;
    });
  }

  return (
    <>
      {!embedded && data && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "stretch" }}>
          {TILES.map((t) => (
            <button key={t.key} type="button" className="panel" aria-pressed={tile === t.key}
                    style={{ flex: "1 1 130px", textAlign: "left", padding: "8px 12px", cursor: "pointer",
                             borderColor: tile === t.key ? "var(--accent)" : undefined,
                             background: tile === t.key ? "var(--accent-soft)" : undefined }}
                    onClick={() => { setTile(tile === t.key ? null : t.key); if (tile !== t.key) setView("all"); setSelected(new Set()); }}>
              <div className="faint">{t.label}</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 700, textAlign: "left",
                                            color: t.tone === "bad" ? "var(--out)" : t.tone === "warn" ? "var(--warn)" : undefined }}>
                {data.tiles[t.key]}
              </div>
              <div className="faint">{t.sub}</div>
            </button>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="panel-bd row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="chips" role="group" aria-label="種類">
            {KINDS.map(([v, l]) => <button key={v} type="button" className="chip" aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>)}
          </span>
          <span className="chips" role="group" aria-label="起点">
            {([["", "起点：すべて"], ["active", "イベント式（製造・納品）"], ["passive", "時限式（締め・報告・入金）"]] as const).map(([v, l]) => (
              <button key={v} type="button" className="chip" aria-pressed={trigger === v} onClick={() => setTrigger(v)}>{l}</button>
            ))}
          </span>
          <span className="chips" role="group" aria-label="表示">
            {([["todo", "要対応"], ["all", "全部の回"], ["past", "過去分"]] as const).map(([v, l]) => (
              <button key={v} type="button" className="chip" aria-pressed={view === v && !tile}
                      onClick={() => { setView(v); setTile(null); }}>{l}</button>
            ))}
          </span>
          <select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="締め月">
            <option value="">締め月：すべて</option>
            {months.map((m) => <option key={m} value={m}>{Number(m.slice(0, 4))}年{Number(m.slice(5))}月</option>)}
          </select>
          {!scope?.partyId && (
            <div style={{ minWidth: 200 }}>
              <SearchSelect value={partyId ? String(partyId) : ""} valueLabel={partyLabel} search={searchParties}
                            placeholder="取引先で絞る" emptyLabel="取引先：すべて"
                            onChange={(v, o) => { setPartyId(v ? Number(v) : null); setPartyLabel(o?.label ?? null); }} />
            </div>
          )}
          <input type="search" value={q} placeholder="条件名・作品・番号で探す" style={{ minWidth: 200, marginLeft: "auto" }}
                 onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      {selected.size > 0 && (
        <div className="panel" style={{ background: "var(--accent-soft)" }}>
          <div className="panel-bd row" style={{ gap: 8 }}>
            <b>{selected.size} 回を選択</b>
            <button className="btn btn-sm primary" disabled={readOnly || busy || !chosen.some((r) => r.next === "compose")}
                    onClick={() => void bulkCompose()}>作る（作業テーブルへ）</button>
            <button className="btn btn-sm" disabled={readOnly || busy || !chosenDocs.length} onClick={() => setBulk("sent")}>送付済みにする…</button>
            <button className="btn btn-sm" disabled={readOnly || busy || !chosenDocs.length} onClick={() => setBulk("received")}>受領を記録…</button>
            <button className="btn btn-sm" disabled={readOnly || busy || !chosen.some((r) => r.next === "pay")} onClick={() => void bulkPay()}>支払を立てる</button>
            <button className="linky" onClick={() => setSelected(new Set())}>選択を外す</button>
          </div>
          {bulk && (
            <div className="panel-bd" style={{ borderTop: "1px solid var(--line)" }}>
              <RecordForm kind={bulk} count={chosenDocs.length} busy={busy} onCancel={() => setBulk(null)}
                          onSubmit={(b) => void run(async () => {
                            const r = await api.post<{ count: number }>(bulk === "sent" ? "/paydocs/sent" : "/paydocs/received",
                                                                        { documentIds: chosenDocs, ...b });
                            return `${r.count} 枚を${bulk === "sent" ? "送付済み" : "受領済み"}にしました`;
                          })} />
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: open ? "minmax(0,1fr) minmax(280px,360px)" : "minmax(0,1fr)", gap: 12, alignItems: "start" }}>
        <div className="panel" style={{ minWidth: 0 }}>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" aria-label="すべて選ぶ" checked={rows.length > 0 && rows.every((r) => selected.has(r.key))}
                           onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())} />
                  </th>
                  <th>回（条件・期間）</th><th>取引先</th><th>起点・実績</th><th className="num">金額</th>
                  <th>文書</th><th>送付</th><th>受領</th><th>支払</th><th>次にすること</th>
                </tr>
              </thead>
              <tbody>
                {!rows.length && (
                  <tr><td colSpan={10} className="faint" style={{ padding: 16 }}>
                    {data ? (view === "todo" && !tile ? "要対応の回はありません。" : "この条件の回はありません。") : "読み込み中…"}
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.key} tabIndex={0} className={openKey === r.key ? "sel" : undefined}
                      onClick={(e) => { if ((e.target as HTMLElement).closest("button,input,a")) return; setOpenKey(r.key); }}
                      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setOpenKey(r.key); }}>
                    <td><input type="checkbox" checked={selected.has(r.key)} aria-label={`${r.condition.name} ${r.label} を選ぶ`}
                               onChange={() => setSelected((x) => { const n = new Set(x); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })} /></td>
                    <td>
                      <div style={{ fontWeight: 700 }}>{r.condition.name}</div>
                      <div className="faint">{r.roundNo ? <b style={{ marginRight: 4 }}>第{r.roundNo}回</b> : null}{r.label}{r.closeOn && r.closeOn !== r.periodFrom ? `（締め ${r.closeOn}）` : ""}</div>
                      <span className="tag" style={{ marginTop: 2 }}>{r.documentLabel}</span>
                    </td>
                    <td>{r.party?.name ?? "—"}{r.work && <div className="faint">{r.work.title}</div>}</td>
                    <td><SourceCell r={r} /></td>
                    <td className="num">{r.amount === null ? "—" : money(r.amount, "JPY")}</td>
                    <td><DocCell r={r} onOpenDocument={onOpenDocument} /></td>
                    <td><SendCell r={r} /></td>
                    <td><ReceiptCell r={r} /></td>
                    <td><PayCell r={r} /></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.next === "none" ? <span className="faint">—</span>
                        : <button className={`btn btn-sm${r.next === "compose" ? " primary" : ""}`} disabled={readOnly && r.next !== "remind_report" && r.next !== "remind_receipt"}
                                  onClick={() => act(r, r.next)}>{nextLabel(r)}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && data.total > rows.length && <div className="panel-bd faint">ほか {data.total - rows.length} 回（絞り込んでください）</div>}
        </div>

        {open && (
          <RowDetail key={open.key} r={open} busy={busy} readOnly={readOnly} onOpenAuthor={onOpenAuthor}
                     onClose={() => setOpenKey(null)} onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
                     onAct={(a) => act(open, a)} onRun={(fn) => void run(fn)} onReload={() => void load()} />
        )}
      </div>

      {!embedded && (
        <div className="row" style={{ gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 300px" }}>
            <b>起点</b>
            <div className="faint">イベント式＝製造・印刷・納品など自社の記録で回が立つ（製造予定を入れておくと記録漏れが見える）。時限式＝締めのあと報告・入金を待つ（締めから報告期限〔既定 30 日〕を過ぎたら督促）。</div>
          </div>
          <div style={{ flex: "1 1 300px" }}>
            <b>受領</b>
            <div className="faint">署名欄のある検収書・通知書は署名返送を、役務提供完了通知書は確認期限（送付から 10 営業日、過ぎたら確認とみなす）を追います。計算書は追いません（受領を記録すれば出ます）。</div>
          </div>
          <div style={{ flex: "1 1 300px" }}>
            <b>済の決め方</b>
            <div className="faint">文書は、回の実績が全部、決定した文書に載って「決定」。下書きは決定に数えません。送付は、システムからの送信・CloudSign・手で記録した送付（郵送など）・過去分のどれか。</div>
          </div>
        </div>
      )}
    </>
  );
}

function RecordForm({ kind, count, busy, onSubmit, onCancel }: {
  kind: "sent" | "received"; count: number; busy: boolean;
  onSubmit: (b: { via: string; on: string; memo: string | null }) => void; onCancel: () => void;
}) {
  const opts = kind === "sent" ? SENT_VIA : RECEIVED_VIA;
  const [via, setVia] = useState(opts[0][0]);
  const [on, setOn] = useState(today());
  const [memo, setMemo] = useState("");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <b>{kind === "sent" ? "送付済みにする（システムの外で送ったもの）" : "受領を記録"}　<span className="faint">{count} 枚</span></b>
      <div className="row" style={{ gap: 8 }}>
        <label className="row" style={{ gap: 4 }}>{kind === "sent" ? "送り方" : "受け取り方"}
          <select value={via} onChange={(e) => setVia(e.target.value)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="row" style={{ gap: 4 }}>{kind === "sent" ? "送付日" : "受領日"}
          <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
        </label>
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={kind === "sent" ? "宛先・追跡番号など" : "控えの保管場所など"}
               style={{ flex: "1 1 160px" }} />
      </div>
      <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
        <button className="btn btn-sm" onClick={onCancel}>やめる</button>
        <button className="btn btn-sm primary" disabled={busy || !count} onClick={() => onSubmit({ via, on, memo: memo.trim() || null })}>
          {kind === "sent" ? "送付済みにする" : "受領を記録"}
        </button>
      </div>
    </div>
  );
}

function RowDetail({ r, busy, readOnly, onClose, onOpenCondition, onOpenDocument, onAct, onRun, onReload, onOpenAuthor }: {
  r: PayDocRow; busy: boolean; readOnly: boolean; onClose: () => void; onOpenAuthor: (a: AuthorTarget) => void;
  onOpenCondition: (id: number) => void; onOpenDocument: (id: number) => void;
  onAct: (a: NextAction) => void; onRun: (fn: () => Promise<string>) => void; onReload: () => void;
}) {
  const [form, setForm] = useState<"sent" | "received" | "event" | null>(
    r.next === "send" ? "sent" : r.next === "record_receipt" || r.next === "remind_receipt" ? "received" : null);
  const [copied, setCopied] = useState(false);
  const docs = r.doc.documents.filter((d) => !d.inbound);
  const steps: Array<{ state: "done" | "now" | "todo"; title: string; detail: string }> = [
    { state: r.source.state === "ok" ? "done" : r.source.state === "before" || r.source.state === "skipped" ? "todo" : "now",
      title: r.trigger === "active" ? "発生（自社の記録）" : "締め・報告／入金（相手から）",
      detail: `${r.source.label}${r.source.detail ? `・${r.source.detail}` : ""}` },
    { state: r.doc.state === "done" ? "done" : r.doc.state === "wait" ? "todo" : "now", title: r.documentLabel,
      detail: r.doc.state === "done" ? `${r.doc.documents.map((d) => d.documentNo).join("、")} を決定`
        : r.doc.state === "draft" ? "下書きあり。確かめて決定" : r.doc.state === "make" ? (r.doc.partial ? "一部の実績がまだ文書に載っていない" : "作れます（作業テーブルで確認して決定）") : "実績のあとで作れます" },
    { state: ["sent", "past", "na"].includes(r.send.state) ? "done" : r.doc.state === "done" ? "now" : "todo", title: "送付",
      detail: r.send.state === "na" ? "相手から受け取った文書（送付は追わない）" : r.send.state === "past" ? "過去分（一括で送付済み）"
        : r.send.on ? `${VIA_LABEL[r.send.via ?? ""] ?? ""} ${r.send.on}${r.send.state === "partial" ? "（一部）" : ""}` : "まだ送っていません" },
    { state: r.receipt.state === "received" || r.receipt.state === "na" ? "done" : r.receipt.state === "none" ? "todo" : "now", title: "受領",
      detail: r.receipt.state === "na" ? "この種類は受領を追いません" : r.receipt.state === "received" ? `${VIA_LABEL[r.receipt.via ?? ""] ?? ""} ${r.receipt.on ?? ""}`
        : r.receipt.state === "none" ? "送付のあとで" : `期限 ${r.receipt.dueOn ?? ""}${r.receipt.state === "late" ? "（超過）" : ""}${docs.some((d) => d.receipt.rule === "deemed") ? "。過ぎて異議がなければ確認とみなす" : ""}` },
    { state: r.payment.state === "paid" || r.payment.state === "nopay" ? "done" : r.payment.state === "planned" ? "now" : r.doc.state === "done" ? "now" : "todo",
      title: r.condition.direction === "out" ? "入金" : "支払",
      detail: r.payment.state === "paid" ? `済 ${r.payment.paidOn ?? ""}` : r.payment.state === "planned" ? `${r.payment.paymentNo ?? ""} 予定 ${r.payment.dueOn ?? ""}`
        : r.payment.state === "nopay" ? "支払なし（0 円）" : "未設定" }
  ];
  const [source, docStep, sendStep, receiptStep, payStep] = steps as [typeof steps[number], typeof steps[number], typeof steps[number], typeof steps[number], typeof steps[number]];
  const canEvent = !isLedgerRow(r) && (r.source.state === "waiting" || r.source.state === "late" || r.source.state === "plan" || r.doc.state === "make");
  const railStations: Station[] = [
    { no: 1, state: source.state, detail: `${source.title}：${source.detail}`,
      onGo: canEvent && !readOnly ? () => setForm("event") : undefined, open: form === "event" },
    { no: 2, state: docStep.state, detail: docStep.detail,
      onGo: r.doc.draftId ? () => onOpenDocument(r.doc.draftId!) : docs[0] ? () => onOpenDocument(docs[0]!.id) : undefined },
    { no: 3, state: r.doc.state === "draft" ? "now" : r.doc.state === "done" ? "skipped" : "todo", skippable: true,
      detail: r.doc.state === "draft" ? "下書きを確かめて決定する" : r.doc.state === "done" ? "決定済み（試算は計算書の中で）" : "文書ができてから",
      onGo: r.doc.draftId ? () => onOpenDocument(r.doc.draftId!) : undefined },
    { no: 4, state: sendStep.state, detail: sendStep.detail, open: form === "sent",
      onGo: docs.length > 0 && r.send.state !== "past" && !readOnly ? () => setForm("sent") : undefined },
    { no: 5, state: payStep.state === "done" && receiptStep.state === "done" ? "done" : (payStep.state === "now" || receiptStep.state === "now") ? "now" : "todo",
      open: form === "received",
      tags: [
        { key: "receipt", label: `受領：${receiptStep.detail}`, state: receiptStep.state, open: form === "received",
          onGo: docs.length > 0 && !readOnly ? () => setForm("received") : undefined },
        { key: "pay", label: `${payStep.title}：${payStep.detail}`, state: payStep.state }
      ] }
  ];

  const reminder = r.next === "remind_report"
    ? `${r.party?.name ?? ""} ご担当者様\n\n${r.condition.name}（${r.label}）のご報告につきまして、締め日 ${r.closeOn ?? ""} から報告期限 ${r.source.reportDueOn ?? ""} を過ぎております。\nお手数ですが、売上・実績のご報告をお送りいただけますでしょうか。`
    : r.next === "remind_receipt"
      ? `${r.party?.name ?? ""} ご担当者様\n\n${docs.map((d) => d.documentNo).join("、")}（${r.documentLabel}）につきまして、ご署名のうえご返送をお願いしておりました（期限 ${r.receipt.dueOn ?? ""}）。\nお手数ですが、ご確認のほどお願いいたします。`
      : null;

  return (
    <aside className="panel" style={{ position: "sticky", top: 12 }} aria-label="回の詳細">
      <div className="panel-hd">
        <h2 style={{ flex: 1 }}>{r.condition.name}<div className="faint" style={{ fontWeight: 400 }}>{r.label}・{r.party?.name ?? ""}</div></h2>
        <button className="linky" onClick={onClose} aria-label="閉じる">×</button>
      </div>
      <div className="panel-bd stack" style={{ gap: 10 }}>
        {/* 工程ナビ（本線 5 駅）。起点＝① 登録、文書＝② 作る、③ 確かめる＝下書きを確かめて決定、送付＝④、受領・支払＝⑤ 記録。 */}
        <ProcessRail compact stations={railStations} />

        <div className="row" style={{ gap: 6 }}>
          {r.next !== "none" && !["send", "record_receipt", "remind_receipt", "remind_report", "record_event"].includes(r.next) && (
            <button className="btn btn-sm primary" disabled={readOnly || busy} onClick={() => onAct(r.next)}>{nextLabel(r)}</button>
          )}
          {isLedgerRow(r) && (
            <button className="btn btn-sm" onClick={() => onOpenAuthor({ partyId: r.party!.id, partyName: r.party!.name, workId: null,
                                                                         focus: { conditionId: r.condition.id, closeOn: r.closeOn } })}>
              報告・計算書（作家の台帳）
            </button>
          )}
          {!isLedgerRow(r) && (r.source.state === "waiting" || r.source.state === "late" || r.source.state === "plan" || r.doc.state === "make") && (
            <button className="btn btn-sm" disabled={readOnly} onClick={() => setForm("event")}>
              {r.trigger === "active" ? "実績を入れる（製造・納品）" : "報告・実績を入れる"}
            </button>
          )}
          {docs.length > 0 && r.send.state !== "past" && (
            <button className="btn btn-sm" disabled={readOnly} onClick={() => setForm("sent")}>送付済みにする…</button>
          )}
          {docs.length > 0 && (
            <button className="btn btn-sm" disabled={readOnly} onClick={() => setForm("received")}>受領を記録…</button>
          )}
          {r.next === "pay" && (
            <button className="btn btn-sm" disabled={readOnly || busy} onClick={() => onRun(async () => {
              for (const d of r.doc.documents) await api.post(`/documents/${d.id}/payment`, {});
              return `${r.condition.name} ${r.label}：支払を立てました`;
            })}>支払を立てる</button>
          )}
          {r.scheduleId && (r.source.state === "waiting" || r.source.state === "late") && (
            <button className="linky" disabled={readOnly || busy} onClick={() => onRun(async () => {
              await api.post("/royalty-ledger/skips", { conditionId: r.condition.id, scheduleId: r.scheduleId, reason: "支払文書から：今期は無し" });
              return `${r.condition.name} ${r.label}：今期は無しにしました`;
            })}>今期は無し</button>
          )}
          {r.planId && (
            <button className="linky" disabled={readOnly || busy} onClick={() => onRun(async () => {
              await api.post(`/paydocs/plans/${r.planId}/drop`, {});
              return `${r.label}：製造予定を取りやめにしました`;
            })}>製造予定を取りやめる</button>
          )}
          <button className="linky" onClick={() => onOpenCondition(r.condition.id)}>条件明細を開く</button>
        </div>

        {reminder && (
          <div className="note" style={{ whiteSpace: "pre-wrap" }}>
            <b>督促の文面</b>
            <div style={{ marginTop: 4 }}>{reminder}</div>
            <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => {
              navigator.clipboard?.writeText(reminder).then(() => setCopied(true)).catch(() => setCopied(false));
            }}>{copied ? "コピーしました" : "文面をコピー"}</button>
          </div>
        )}

        {form === "event" && (
          <EventEntryForm conditionId={r.condition.id} scheduleId={r.scheduleId} matterId={null}
                          title={`${r.condition.name}　${r.label}`}
                          onDone={() => { setForm(null); onReload(); }} onCancel={() => setForm(null)} />
        )}
        {(form === "sent" || form === "received") && docs.length > 0 && (
          <RecordForm kind={form} count={docs.length} busy={busy} onCancel={() => setForm(null)}
                      onSubmit={(b) => onRun(async () => {
                        const res = await api.post<{ count: number }>(form === "sent" ? "/paydocs/sent" : "/paydocs/received",
                                                                      { documentIds: docs.map((d) => d.id), ...b });
                        return `${r.condition.name} ${r.label}：${res.count} 枚を${form === "sent" ? "送付済み" : "受領済み"}にしました`;
                      })} />
        )}
        {docs.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            {docs.map((d) => (
              <div key={d.id} className="row" style={{ gap: 6 }}>
                <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo}</button>
                {d.sentOn && !d.past && (
                  <button className="linky faint" disabled={readOnly || busy} onClick={() => onRun(async () => {
                    await api.post("/paydocs/sent/clear", { documentId: d.id, reason: "支払文書から取り消し" });
                    return `${d.documentNo}：送付の記録を取り消しました`;
                  })}>送付を取り消す</button>
                )}
                {d.receipt.state === "received" && d.receipt.via !== "deemed" && (
                  <button className="linky faint" disabled={readOnly || busy} onClick={() => onRun(async () => {
                    await api.post("/paydocs/received/clear", { documentId: d.id, reason: "支払文書から取り消し" });
                    return `${d.documentNo}：受領の記録を取り消しました`;
                  })}>受領を取り消す</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 製造予定
// ---------------------------------------------------------------------------

interface PlanCandidate {
  conditionId: number; conditionName: string; partyName: string | null; work: { id: number; title: string };
  documentId: number; documentNo: string | null; orderedOn: string | null; orderName: string | null;
  quantity: number | null; plannedOn: string | null;
}

const searchConditions = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ conditions: Array<{ id: number; conditionNo: string | null; name: string; kind: string;
                                               counterparty: { name: string } | null; work: { title: string } | null }> }>(
    `/conditions?q=${encodeURIComponent(q)}&kind=license`);
  return r.conditions.map((c) => ({ value: String(c.id), label: `${c.conditionNo ?? ""} ${c.name}`.trim(),
                                    hint: [c.counterparty?.name, c.work?.title].filter(Boolean).join("・") || null }));
};

function PlansPane() {
  const readOnly = useReadOnly();
  const [candidates, setCandidates] = useState<PlanCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conditionId, setConditionId] = useState("");
  const [conditionLabel, setConditionLabel] = useState<string | null>(null);
  const [plannedOn, setPlannedOn] = useState("");
  const [quantity, setQuantity] = useState("");
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try { setCandidates((await api.get<{ candidates: PlanCandidate[] }>("/paydocs/plan-candidates")).candidates); setError(null); }
    catch (e) { setError(errText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add(body: Record<string, unknown>, msg: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await api.post("/paydocs/plans", body); setNotice(msg); await load(); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="faint">刷ごと・製造のたびに払う条件は、製造の実績が入るまで回が立ちません。予定を入れておくと「発生・報告待ち」に出て、記録漏れが見えます。製造の実績が予定日の前後（30 日前〜60 日後）に入ると、予定は消えます。</div>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}
      <div className="panel">
        <div className="panel-hd"><h2>手で入れる（重版・増刷を決めたとき）</h2></div>
        <div className="panel-bd row" style={{ gap: 8 }}>
          <div style={{ minWidth: 280, flex: "2 1 280px" }}>
            <SearchSelect value={conditionId} valueLabel={conditionLabel} search={searchConditions} placeholder="条件明細（刷部数印税など）"
                          onChange={(v, o) => { setConditionId(v); setConditionLabel(o?.label ?? null); }} />
          </div>
          <label className="row" style={{ gap: 4 }}>製造予定日<input type="date" value={plannedOn} onChange={(e) => setPlannedOn(e.target.value)} /></label>
          <label className="row" style={{ gap: 4 }}>部数<input type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} style={{ width: 90 }} /></label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名前（2刷 など）" style={{ width: 140 }} />
          <button className="btn btn-sm primary" disabled={readOnly || busy || !conditionId || !plannedOn}
                  onClick={() => void add({ conditionId: Number(conditionId), plannedOn, quantity: quantity ? Number(quantity) : null,
                                            label: label.trim() || null }, "製造予定を入れました")}>予定を入れる</button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-hd"><h2>発注書からの候補</h2><span className="faint">印刷・製造の発注書（決定済み）がある作品で、刷ごとの許諾料の条件に予定も製造の実績も無いもの</span></div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>条件明細（作家）</th><th>作品</th><th>発注書</th><th className="num">部数</th><th>予定日</th><th></th></tr></thead>
            <tbody>
              {candidates && !candidates.length && <tr><td colSpan={6} className="faint" style={{ padding: 12 }}>候補はありません。</td></tr>}
              {!candidates && <tr><td colSpan={6} className="faint" style={{ padding: 12 }}>読み込み中…</td></tr>}
              {candidates?.map((c) => (
                <tr key={`${c.conditionId}-${c.documentId}`}>
                  <td>{c.conditionName}<div className="faint">{c.partyName ?? ""}</div></td>
                  <td>{c.work.title}</td>
                  <td><span className="code">{c.documentNo}</span><div className="faint">{c.orderName} {c.orderedOn ?? ""}</div></td>
                  <td className="num">{c.quantity?.toLocaleString("ja-JP") ?? "—"}</td>
                  <td>{c.plannedOn ?? "—"}</td>
                  <td><button className="btn btn-sm" disabled={readOnly || busy}
                              onClick={() => void add({ conditionId: c.conditionId, plannedOn: c.plannedOn, quantity: c.quantity,
                                                        sourceDocumentId: c.documentId, label: c.orderName },
                                                      `${c.conditionName}：${c.documentNo} から製造予定を入れました`)}>予定にする</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 過去分の整理
// ---------------------------------------------------------------------------

interface PastPreview {
  cutoff: string; legacy: number; imported: number; batch: number; other: number; total: number; inbound: number;
  sample: Array<{ id: number; documentNo: string | null; issuedOn: string | null; label: string | null; counterparty: string | null;
                  legacy: boolean; imported: boolean }>;
}

function PastPane() {
  const readOnly = useReadOnly();
  const [cutoff, setCutoff] = useState("");
  const [receipt, setReceipt] = useState(true);
  const [data, setData] = useState<PastPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<PastPreview>(`/paydocs/past${cutoff ? `?cutoff=${cutoff}` : ""}`);
      setData(d); if (!cutoff) setCutoff(d.cutoff); setError(null);
    } catch (e) { setError(errText(e)); }
  }, [cutoff]);
  useEffect(() => { void load(); }, [load]);

  async function apply() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.post<{ count: number; cutoff: string }>("/paydocs/past", { cutoff, receipt });
      setNotice(`${r.count} 枚を過去分（送付済み${receipt ? "・受領済み" : ""}）にしました`);
      setConfirm(false); await load();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="faint">V3 で作った文書より前のもの（V1 から移した文書・取り込んだ文書・遡って登録した文書）は、送った記録がシステムに無いので「未送付」に見えます。一度だけ、まとめて「過去分（送付済み）」にします。あとから個別に「送付を取り消す」ができ、記録は操作の記録に残ります。</div>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}
      {data && (
        <div className="row" style={{ gap: 8, alignItems: "stretch" }}>
          {([["V1 から移した文書", data.legacy], ["取り込んだ文書", data.imported], ["遡って登録した文書（一括）", data.batch],
             ["境目より前のその他", data.other]] as Array<[string, number]>).map(([l, n]) => (
            <div key={l} className="panel" style={{ flex: "1 1 160px", padding: "8px 12px" }}>
              <div className="faint">{l}</div><div className="num" style={{ fontSize: 20, fontWeight: 700, textAlign: "left" }}>{n}</div>
            </div>
          ))}
        </div>
      )}
      <div className="panel">
        <div className="panel-bd stack" style={{ gap: 8 }}>
          <label className="row" style={{ gap: 6 }}>境目（この日より前に決定した文書）
            <input type="date" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
            <span className="faint">既定は V3 で最初に作った文書の決定日。V1 から移した文書は日付によらず対象</span>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} />
            受領も済みにする（過去分）
          </label>
          <div className="faint">送付日・受領日は各文書の決定日にします。相手から受け取った文書（{data?.inbound ?? 0} 枚）は対象外です。</div>
          {!confirm ? (
            <div><button className="btn primary" disabled={readOnly || busy || !data?.total} onClick={() => setConfirm(true)}>{data?.total ?? 0} 枚を過去分にする…</button></div>
          ) : (
            <div className="alert row" style={{ gap: 8 }}>
              <span>{data?.total ?? 0} 枚を過去分（送付済み{receipt ? "・受領済み" : ""}）にします。よろしいですか。</span>
              <button className="btn btn-sm danger" disabled={busy} onClick={() => void apply()}>過去分にする</button>
              <button className="btn btn-sm" onClick={() => setConfirm(false)}>やめる</button>
            </div>
          )}
        </div>
      </div>
      {data && data.sample.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>対象の例（新しい順に {data.sample.length} 枚）</h2></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>文書番号</th><th>種別</th><th>相手先</th><th>決定日</th><th>出どころ</th></tr></thead>
              <tbody>
                {data.sample.map((d) => (
                  <tr key={d.id}><td className="code">{d.documentNo}</td><td>{d.label ?? "—"}</td><td>{d.counterparty ?? "—"}</td>
                    <td>{d.issuedOn ?? "—"}</td><td>{d.legacy ? "V1 から移行" : d.imported ? "取込" : "V3（境目より前）"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 作家の報告と計算書（以前の 作品 › 利用許諾計算）
// ---------------------------------------------------------------------------

function AuthorPane({ who, onPick, onOpenDocument, onOpenRequest, onLedgerCompose, onOpenList }: {
  who: (AuthorTarget & { nonce: number }) | null;
  onPick: (a: AuthorTarget) => void;
  onOpenDocument: (id: number) => void;
  onOpenRequest?: (requestId: number) => void;
  onLedgerCompose?: (conditionIds: number[], eventIds: number[], templateKey: string | null, back: DocBack,
                     revise?: { supersedesIds: number[]; reason: string } | null) => void;
  onOpenList: (partyId: number) => void;
}) {
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        <span className="faint">作家（支払先）</span>
        <div style={{ minWidth: 260 }}>
          <SearchSelect value={who ? String(who.partyId) : ""} valueLabel={who?.partyName ?? null} search={searchParties}
                        placeholder="作家を選ぶ（名前・コード）"
                        onChange={(v, o) => { if (v) onPick({ partyId: Number(v), partyName: o?.label ?? null, workId: null }); }} />
        </div>
        <span className="faint">報告は相手から 1 通で複数の作品が来て、計算書は作家ごとにまとめるので、作家で開きます。一覧の許諾料の行の「報告を入れる」「計算書を作る」からも来られます。</span>
      </div>
      {!who && <div className="panel"><div className="panel-bd faint">作家を選ぶと、報告待ちの回・報告の表・計算書の試算が出ます。</div></div>}
      {who && (
        <RoyaltyLedger key={`${who.partyId}-${who.nonce}`} partyId={who.partyId} workId={who.workId ?? null} focus={who.focus ?? null}
                       onOpenDocument={(id) => onOpenDocument(id)} onOpenRequest={onOpenRequest}
                       onCompose={onLedgerCompose} onOpenPayDocs={() => onOpenList(who.partyId)} />
      )}
    </div>
  );
}
