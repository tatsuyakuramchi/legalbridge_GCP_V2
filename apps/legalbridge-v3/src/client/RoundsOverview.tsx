import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { RoyaltyReceipts } from "./RoyaltyReceipts.js";

/**
 * 回と文書（docs/royalty-ledger.md §9）。
 *
 *   作品タブ「回と文書」… その作品の許諾料の条件（IN）ごとに、回（時限式の締め・イベント式の製造）を
 *     回号の順に並べ、各回の状態・計算書（番号・作家×作品の第 N 回・決定日・送付）・支払と、
 *     条件の根拠の契約書・条件書、報告の来た許諾先（OUT 条件）を 1 枚で見せる。
 *   横断の「回の一覧」… 作品・作家をまたいで回を日付順に並べる。期間・出し方・開いている回で絞る。
 *
 * 見るだけ。報告を入れる・計算書を作るのは台帳（支払文書 › 作家 × 作品）で。
 */

interface Doc { id: number; documentNo: string | null; status: string; issuedOn: string | null; sent: boolean; net: number; seq: number | null }
interface Payment { id: number; paymentNo: string | null; status: string; amount: number; dueOn: string | null; paidOn: string | null }
interface Cell {
  roundKey: string; kind: "period" | "event"; roundNo: number | null; label: string | null;
  periodFrom: string | null; closeOn: string | null; payOn: string | null;
  state: string; roundState: string; reports: number; documents: Doc[]; payments: Payment[];
}
interface Contract { kind: "master" | "agreement" | "terms"; no: string | null; title: string; status: string; documentId?: number | null }
interface Out { id: number; name: string; agreementNo: string | null; reports: number }
interface Row {
  conditionId: number; conditionNo: string | null; name: string; partyId: number; partyName: string;
  workId: number | null; workTitle: string | null; usageType: string | null; usageLabel: string;
  timing: "periodic" | "event"; settlementMode: string | null;
  ratePpm: number | null; unitAmount: number | null; pricingModel: string; targetPartyName: string | null;
  contracts: Contract[]; outs: Out[]; cells: Cell[];
}
interface CrossRound {
  key: string; kind: "period" | "event"; partyId: number; partyName: string;
  works: Array<{ id: number; title: string }>;
  conditions: Array<{ id: number; conditionNo: string | null; name: string; usageLabel: string; roundNo: number | null; label: string | null }>;
  closeOn: string | null; payOn: string | null; state: string; reports: number; documents: Doc[]; payments: Payment[];
}

const PART_STATE: Record<string, { label: string; tag: string }> = {
  before: { label: "締め前", tag: "" },
  waiting: { label: "報告待ち", tag: "warn" },
  reported: { label: "計算書待ち", tag: "accent" },
  skipped: { label: "報告なし", tag: "" },
  issued: { label: "計算書済", tag: "ok" }
};
const ROUND_STATE: Record<string, { label: string; tag: string }> = {
  before: { label: "締め前", tag: "" },
  input: { label: "報告を入力中", tag: "warn" },
  ready: { label: "計算書を作れる", tag: "accent" },
  issued: { label: "計算書を決定", tag: "ok" },
  sent: { label: "送付済", tag: "ok" },
  scheduled: { label: "支払予定", tag: "ok" },
  paid: { label: "支払済", tag: "ok" },
  nopay: { label: "支払なし", tag: "" },
  skipped: { label: "報告なし", tag: "" }
};
const PAY_STATE: Record<string, string> = { planned: "予定", scheduled: "予定", approved: "承認済", paid: "支払済", canceled: "取消" };
const KIND = {
  period: { label: "時限式", hint: "締め（予定明細）ごとにやってくる回", tag: "accent" },
  event: { label: "イベント式", hint: "当社が印刷・製造したときに立つ回", tag: "warn" }
} as const;
const CONTRACT_KIND: Record<Contract["kind"], string> = { master: "基本契約", agreement: "契約", terms: "条件書" };

const md = (d: string | null | undefined) => d ? d.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1/$2/$3") : "—";
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const pct = (ppm: number | null) => ppm === null ? null : `${Number((ppm / 10000).toFixed(2))}%`;
const roundNoText = (n: number | null) => n ? `第${n}回` : "予定の外";

function Docs({ docs, onOpen }: { docs: Doc[]; onOpen?: (id: number) => void }) {
  if (!docs.length) return <span className="faint">—</span>;
  return (
    <span className="stack" style={{ gap: 2 }}>
      {docs.map((d) => (
        <span key={d.id} className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          {onOpen ? <button className="linky code" onClick={() => onOpen(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                  : <span className="code">{d.documentNo ?? `#${d.id}`}</span>}
          {d.seq ? <span className="tag">計算書 第{d.seq}回</span> : null}
          <span className="faint">{md(d.issuedOn)}</span>
          {d.sent ? <span className="tag ok">送付済</span> : <span className="tag">未送付</span>}
        </span>
      ))}
    </span>
  );
}

function Payments({ list }: { list: Payment[] }) {
  const live = list.filter((p) => p.status !== "canceled");
  if (!live.length) return <span className="faint">—</span>;
  return (
    <span className="stack" style={{ gap: 2 }}>
      {live.map((p) => (
        <span key={p.id}>
          <span className="code">{p.paymentNo ?? `#${p.id}`}</span> {yen(p.amount)}{" "}
          <span className={`tag${p.status === "paid" ? " ok" : ""}`}>{PAY_STATE[p.status] ?? p.status}</span>{" "}
          <span className="faint">{p.status === "paid" ? md(p.paidOn) : md(p.dueOn)}</span>
        </span>
      ))}
    </span>
  );
}

type KindFilter = "all" | "period" | "event";

function KindChips({ value, onChange, counts }: { value: KindFilter; onChange: (v: KindFilter) => void; counts?: Record<KindFilter, number> }) {
  return (
    <span className="chips">
      {(["all", "period", "event"] as KindFilter[]).map((k) => (
        <button key={k} className="chip" aria-pressed={value === k} onClick={() => onChange(k)}
                title={k === "all" ? undefined : KIND[k].hint}>
          {k === "all" ? "すべて" : KIND[k].label}{counts ? ` ${counts[k]}` : ""}
        </button>
      ))}
    </span>
  );
}

/** 作品タブ「回と文書」。 */
export function WorkRounds({ workId, onOpenCondition, onOpenDocument }: {
  workId: number;
  onOpenCondition?: (id: number) => void;
  onOpenDocument?: (id: number) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>("all");
  const [openOnly, setOpenOnly] = useState(false);
  useEffect(() => {
    setRows(null); setError(null);
    api.get<{ rows: Row[] }>(`/works/${workId}/round-overview`)
      .then((r) => setRows(r.rows)).catch((e: ApiError) => setError(e.message));
  }, [workId]);
  const closed = new Set(["paid", "nopay", "skipped"]);
  const shown = useMemo(() => (rows ?? [])
    .filter((r) => kind === "all" || (kind === "event" ? r.timing === "event" : r.timing === "periodic"))
    .map((r) => ({ ...r, cells: openOnly ? r.cells.filter((c) => !closed.has(c.roundState)) : r.cells })), [rows, kind, openOnly]);
  if (error) return <div className="alert">{error}</div>;
  if (!rows) return <div className="panel"><div className="panel-bd faint">読み込み中…</div></div>;
  if (!rows.length) {
    return <div className="panel"><div className="panel-bd faint">この作品に許諾料（料率・単価）の IN 条件はありません。</div></div>;
  }
  const counts: Record<KindFilter, number> = {
    all: rows.length, period: rows.filter((r) => r.timing === "periodic").length, event: rows.filter((r) => r.timing === "event").length
  };
  const parties = [...new Set(shown.map((r) => r.partyName))];
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>回と文書</h2>
          <span className="faint">条件ごとの回号（第 N 回）・状態・計算書・支払・根拠の契約書</span>
        </div>
        <div className="panel-bd row" style={{ gap: 12, flexWrap: "wrap" }}>
          <KindChips value={kind} onChange={setKind} counts={counts} />
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />開いている回だけ
          </label>
          <span className="faint row" style={{ gap: 12, flexWrap: "wrap" }}>
            <span><span className={`tag ${KIND.period.tag}`}>時限式</span> {KIND.period.hint}</span>
            <span><span className={`tag ${KIND.event.tag}`}>イベント式</span> {KIND.event.hint}</span>
          </span>
        </div>
      </div>
      {parties.map((party) => (
        <div key={party} className="stack">
          <h3 style={{ margin: "4px 0" }}>{party}</h3>
          {shown.filter((r) => r.partyName === party).map((r) => (
            <div key={r.conditionId} className="panel">
              <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
                {onOpenCondition
                  ? <button className="linky code" onClick={() => onOpenCondition(r.conditionId)}>{r.conditionNo ?? `#${r.conditionId}`}</button>
                  : <span className="code">{r.conditionNo ?? `#${r.conditionId}`}</span>}
                <b>{r.name}</b>
                <span className={`tag ${KIND[r.timing === "event" ? "event" : "period"].tag}`}>
                  {KIND[r.timing === "event" ? "event" : "period"].label}
                </span>
                <span className="tag">{r.usageLabel}</span>
                {r.pricingModel === "unit_rate" && r.unitAmount !== null
                  ? <span className="faint">単価 {yen(r.unitAmount)}</span>
                  : pct(r.ratePpm) ? <span className="faint">料率 {pct(r.ratePpm)}</span> : null}
                <span className="faint">{r.targetPartyName ? `許諾先専用：${r.targetPartyName}` : r.usageType === "sublicense" || r.usageType === "oem" ? "一律（全許諾先）" : ""}</span>
              </div>
              <div className="panel-bd stack" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="faint">根拠</span>
                  {r.contracts.length ? r.contracts.map((c, i) => (
                    <span key={i} className="row" style={{ gap: 4 }}>
                      <span className="tag">{CONTRACT_KIND[c.kind]}</span>
                      {c.documentId && onOpenDocument
                        ? <button className="linky code" onClick={() => onOpenDocument(c.documentId!)}>{c.no ?? "番号なし"}</button>
                        : <span className="code">{c.no ?? "番号なし"}</span>}
                      <span className="faint">{c.title}{c.status !== "issued" && c.kind === "terms" ? `（${c.status === "draft" ? "下書き" : c.status}）` : ""}</span>
                    </span>
                  )) : <span className="tag warn">契約書・条件書が繋がっていません</span>}
                </div>
                {r.outs.length > 0 && (
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className="faint">許諾先</span>
                    {r.outs.map((o) => (
                      <span key={o.id} className="row" style={{ gap: 4 }}>
                        {onOpenCondition ? <button className="linky" onClick={() => onOpenCondition(o.id)}>{o.name}</button> : <span>{o.name}</span>}
                        {o.agreementNo && <span className="code faint">{o.agreementNo}</span>}
                        <span className="faint">報告 {o.reports} 件</span>
                      </span>
                    ))}
                  </div>
                )}
                {r.cells.length ? (
                  <table className="table">
                    <thead>
                      <tr><th>回号</th><th>{r.timing === "event" ? "製造日" : "対象期間・締め"}</th><th>支払日</th><th>報告</th><th>状態</th><th>計算書</th><th>支払</th></tr>
                    </thead>
                    <tbody>
                      {r.cells.map((c) => {
                        const st = PART_STATE[c.state] ?? { label: c.state, tag: "" };
                        const rs = ROUND_STATE[c.roundState];
                        return (
                          <tr key={`${c.roundKey}:${c.closeOn}`}>
                            <td><b>{roundNoText(c.roundNo)}</b></td>
                            <td>
                              {c.kind === "event" ? md(c.closeOn) : <>{c.label ?? ""} <span className="faint">締め {md(c.closeOn)}</span></>}
                            </td>
                            <td>{md(c.payOn)}</td>
                            <td>{c.reports ? `${c.reports} 件` : <span className="faint">—</span>}</td>
                            <td>
                              <span className={`tag ${st.tag}`}>{st.label}</span>
                              {c.state === "issued" && rs && rs.label !== "計算書を決定" ? <> <span className={`tag ${rs.tag}`}>{rs.label}</span></> : null}
                            </td>
                            <td><Docs docs={c.documents} onOpen={onOpenDocument} /></td>
                            <td><Payments list={c.payments} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : <span className="faint">{r.timing === "event" ? "まだ製造の報告がありません（製造・印刷すると回が立ちます）" : "回がありません（締めを作ると回が立ちます）"}</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (months: number) => { const d = new Date(); d.setMonth(d.getMonth() + months); return iso(d); };

/** 横断の「回の一覧」。作品・作家をまたいで、回を日付の新しい順に。 */
export function RoyaltyRounds({ onOpenCondition, onOpenDocument, onOpenWork }: {
  onOpenCondition?: (id: number) => void;
  onOpenDocument?: (id: number) => void;
  onOpenWork?: (id: number) => void;
}) {
  const [from, setFrom] = useState(shift(-12));
  const [to, setTo] = useState(shift(3));
  const [kind, setKind] = useState<KindFilter>("all");
  const [openOnly, setOpenOnly] = useState(false);
  const [rounds, setRounds] = useState<CrossRound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRounds(null); setError(null);
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (kind !== "all") q.set("kind", kind);
    if (openOnly) q.set("openOnly", "1");
    api.get<{ rounds: CrossRound[] }>(`/royalty-rounds?${q.toString()}`)
      .then((r) => setRounds(r.rounds)).catch((e: ApiError) => setError(e.message));
  }, [from, to, kind, openOnly]);
  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>回の一覧</h2>
          <span className="faint">時限式（締め）とイベント式（印刷・製造）の回と、その回で出した計算書・支払</span>
        </div>
        <div className="panel-bd row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 4 }}>締め・製造日・支払日
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />〜
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <KindChips value={kind} onChange={setKind} />
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />開いている回だけ
          </label>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!rounds && !error && <div className="panel"><div className="panel-bd faint">読み込み中…</div></div>}
      {rounds && (
        <div className="panel">
          <div className="panel-bd">
            {rounds.length ? (
              <table className="table">
                <thead>
                  <tr><th>締め・製造日</th><th>出し方</th><th>作家</th><th>作品</th><th>条件と回号</th><th>状態</th><th>計算書</th><th>支払</th></tr>
                </thead>
                <tbody>
                  {rounds.map((r) => {
                    const st = ROUND_STATE[r.state] ?? { label: r.state, tag: "" };
                    return (
                      <tr key={r.key}>
                        <td>{md(r.closeOn)}<div className="faint">支払 {md(r.payOn)}</div></td>
                        <td><span className={`tag ${KIND[r.kind].tag}`}>{KIND[r.kind].label}</span></td>
                        <td>{r.partyName}</td>
                        <td>{r.works.map((w) => onOpenWork
                          ? <div key={w.id}><button className="linky" onClick={() => onOpenWork(w.id)}>{w.title}</button></div>
                          : <div key={w.id}>{w.title}</div>)}</td>
                        <td>{r.conditions.map((c) => (
                          <div key={`${c.id}:${c.roundNo}`}>
                            {onOpenCondition ? <button className="linky code" onClick={() => onOpenCondition(c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
                                             : <span className="code">{c.conditionNo ?? `#${c.id}`}</span>}{" "}
                            <span className="faint">{c.usageLabel}</span> <b>{roundNoText(c.roundNo)}</b>
                            {c.label && r.kind === "period" ? <span className="faint">（{c.label}）</span> : null}
                          </div>
                        ))}</td>
                        <td><span className={`tag ${st.tag}`}>{st.label}</span>{r.reports ? <div className="faint">報告 {r.reports} 件</div> : null}</td>
                        <td><Docs docs={r.documents} onOpen={onOpenDocument} /></td>
                        <td><Payments list={r.payments} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <span className="faint">この範囲に回はありません</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 作業 › 回の一覧。回（締め・製造）と、入金と作者への支払（docs/royalty-ledger.md §10）の 2 枚。 */
export function RoundsWorkspace(props: {
  onOpenCondition?: (id: number) => void;
  onOpenDocument?: (id: number) => void;
  onOpenWork?: (id: number) => void;
}) {
  const [tab, setTab] = useState<"rounds" | "receipts">("rounds");
  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="回の一覧">
        <button role="tab" aria-selected={tab === "rounds"} onClick={() => setTab("rounds")}>回</button>
        <button role="tab" aria-selected={tab === "receipts"} onClick={() => setTab("receipts")}>入金と作者への支払</button>
      </div>
      {tab === "rounds"
        ? <RoyaltyRounds {...props} />
        : <RoyaltyReceipts onOpenCondition={props.onOpenCondition} onOpenDocument={props.onOpenDocument} />}
    </div>
  );
}
