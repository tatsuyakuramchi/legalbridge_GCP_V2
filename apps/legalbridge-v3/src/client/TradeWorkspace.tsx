import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties, staffOptions } from "./SearchSelect.js";
import { searchWorks } from "./MatterAxis.js";
import { LicenseSetForm } from "./LicenseSetForm.js";
import { PubConditionSetForm } from "./PubConditionSetForm.js";
import { OutConditionForm } from "./OutConditionForm.js";
import { ServiceLinesForm } from "./ServiceLinesForm.js";
import { StatusTag } from "./labels.js";
import type { MatterDetail } from "../server/core/model.js";
import { DocumentSet } from "./DocumentSet.js";
import { SendMany } from "./SendMany.js";

/**
 * 取引を進める画面（docs/v3-request-inbox.md §11）。
 *
 * 7 パターン（ボードゲーム IN／OUT・出版 IN／OUT・業務委託・支払 検収書／計算書）の
 * うち、文書を作って送るまでの 5 つをここで進める。支払文書は時間差があるので
 * 支払文書処理・作品の台帳で扱う。
 *
 * 進行の器は案件（matter）。最初の段階で基礎情報（取引先・作品・事業部担当者・
 * 法務担当）を入れると案件が立ち、以後の条件・文書はその案件に繋がる。文書の
 * 当社担当者・メールの宛先・CloudSign の署名者は案件から解決する。
 */

export type TradePattern = "game_in" | "game_out" | "pub_in" | "pub_out" | "service";
export interface TradeCtx { pattern: TradePattern; matterId: number | null }

const PATTERNS: Array<{ value: TradePattern; group: string; label: string; detail: string }> = [
  { value: "game_in", group: "ボードゲーム", label: "IN：権利を取得", detail: "権利元 → 当社。許諾セット → 個別利用許諾条件書" },
  { value: "game_out", group: "ボードゲーム", label: "OUT：権利を許諾", detail: "当社 → 許諾先。OUT 条件 → 条件書・契約書" },
  { value: "pub_in", group: "出版", label: "IN：権利を取得", detail: "著者・権利元 → 当社。出版セット（紙・電子・翻訳）" },
  { value: "pub_out", group: "出版", label: "OUT：権利を許諾", detail: "当社 → 出版社。出版等利用許諾条件書" },
  { value: "service", group: "業務委託", label: "発注", detail: "基本契約 → 明細 → 権利の扱い → 発注書" }
];
const isLicense = (p: TradePattern) => p !== "service";
const isOut = (p: TradePattern) => p === "game_out" || p === "pub_out";
const patternLabel = (p: TradePattern) => { const x = PATTERNS.find((q) => q.value === p); return x ? `${x.group} ${x.label}` : p; };

/** 段階 3 で作る文書。ひな形は本番 DB のもの（template_key）。 */
const DOCS: Record<TradePattern, Array<{ key: string; label: string; conditions: "license_in" | "license_out" | "service" | "none" }>> = {
  // V4（2026-10 ローンチ。CloudSign 体裁）を先に、V3 を後に並べて選ばせる。
  // ボタンは有効なひな形だけ出す（V3 を止めれば V4 だけになる）。V3 で作った文書は
  // どちらでも一覧に出る（一覧はここに並ぶ鍵すべてで拾う）。
  game_in: [{ key: "individual_license_terms_v4", label: "個別利用許諾条件書V4", conditions: "license_in" },
            { key: "individual_license_terms_v3", label: "個別利用許諾条件書V3", conditions: "license_in" }],
  pub_in: [{ key: "pub_master_individual", label: "出版許諾契約書（個人）", conditions: "license_in" },
           { key: "pub_master_corporate", label: "出版許諾契約書（法人）", conditions: "license_in" }],
  game_out: [{ key: "pub_license_terms_v3", label: "利用許諾条件書（一覧形式）", conditions: "license_out" },
             { key: "pub_license_terms_v3_annex", label: "利用許諾条件書（別紙形式。作品が多いとき）", conditions: "license_out" }],
  pub_out: [{ key: "pub_license_terms_v3", label: "出版等利用許諾条件書（一覧形式）", conditions: "license_out" },
            { key: "pub_license_terms_v3_annex", label: "出版等利用許諾条件書（別紙形式）", conditions: "license_out" }],
  service: [{ key: "purchase_order", label: "発注書", conditions: "service" }]
};
/** まとめて作るに対応する取引（出版 IN は出版許諾契約書そのものが基本契約を兼ねるので対象外）。 */
const SET_PATTERNS = new Set<TradePattern>(["game_in", "game_out", "pub_out", "service"]);
const MASTER: Record<TradePattern, { key: string; label: string }> = {
  game_in: { key: "license_master", label: "利用許諾基本契約書" }, pub_in: { key: "license_master", label: "利用許諾基本契約書" },
  game_out: { key: "license_master", label: "利用許諾基本契約書" }, pub_out: { key: "license_master", label: "利用許諾基本契約書" },
  service: { key: "service_master", label: "業務委託基本契約書" }
};

interface Staff { id: number; name: string; email: string | null; department?: string | null; status?: string }
interface Agreement { id: number; agreementNo: string | null; title: string; status: string; kind: string; domain: string | null;
                      executedOn: string | null; counterparty: { id: number; name: string } }

type Compose = (conditionIds: number[], eventIds?: number[], matterId?: number | null, templateKey?: string | null) => void;

export function TradeWorkspace(
  { ctx, onCtx, onCompose, onOpenDocument, onOpenMatter, onRegisterAgreement }: {
    ctx: TradeCtx | null;
    onCtx: (ctx: TradeCtx | null) => void;
    onCompose: Compose;
    onOpenDocument: (id: number) => void;
    onOpenMatter: (id: number) => void;
    onRegisterAgreement: (partyId: number, partyName: string | null) => void;
  }
) {
  if (!ctx) {
    return (
      <section className="stack">
        <div>
          <h1>取引を進める</h1>
          <p className="faint">取引の種類を選ぶと、基礎情報 → 基本契約 → 条件 → 文書 → 送信 の順に 1 枚で進めます。支払文書（検収書・計算書）は時間差があるので、支払文書処理と作品の台帳で扱います。</p>
        </div>
        <div className="ledger-parties">
          {PATTERNS.map((p) => (
            <button key={p.value} className="ledger-party" onClick={() => onCtx({ pattern: p.value, matterId: null })}>
              <span className="faint" style={{ fontSize: 11, letterSpacing: ".06em" }}>{p.group}</span>
              <b>{p.label}</b>
              <span className="faint" style={{ fontSize: 12 }}>{p.detail}</span>
            </button>
          ))}
          <button className="ledger-party" onClick={() => undefined} disabled>
            <span className="faint" style={{ fontSize: 11, letterSpacing: ".06em" }}>支払</span>
            <b>検収書・利用許諾計算書</b>
            <span className="faint" style={{ fontSize: 12 }}>支払文書処理の画面と作品の台帳で（時期が来たら）</span>
          </button>
        </div>
      </section>
    );
  }
  return <TradeFlow key={`${ctx.pattern}-${ctx.matterId ?? 0}`} ctx={ctx} onCtx={onCtx} onCompose={onCompose}
                    onOpenDocument={onOpenDocument} onOpenMatter={onOpenMatter} onRegisterAgreement={onRegisterAgreement} />;
}

function TradeFlow(
  { ctx, onCtx, onCompose, onOpenDocument, onOpenMatter, onRegisterAgreement }: {
    ctx: TradeCtx; onCtx: (ctx: TradeCtx | null) => void; onCompose: Compose;
    onOpenDocument: (id: number) => void; onOpenMatter: (id: number) => void;
    onRegisterAgreement: (partyId: number, partyName: string | null) => void;
  }
) {
  const p = ctx.pattern;
  const [detail, setDetail] = useState<MatterDetail | null>(null);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [agreementId, setAgreementId] = useState<string>("");
  const [noAgreement, setNoAgreement] = useState(false);
  const [stage, setStage] = useState<number>(ctx.matterId ? 1 : 0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /**
   * 有効なひな形の鍵。作るボタンはここにある鍵だけ出す（止めたひな形で作ろうとすると
   * 「テンプレートが見つかりません」で落ちる）。読めなかったら null のまま＝全部出す。
   */
  const [activeKeys, setActiveKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    api.get<{ templates: Array<{ templateKey: string }> }>("/document-templates")
      .then((r) => setActiveKeys(new Set(r.templates.map((t) => t.templateKey))))
      .catch(() => undefined);
  }, []);
  const creatable = DOCS[p].filter((d) => !activeKeys || activeKeys.has(d.key));
  /** 文書をまとめて作る（基本契約書＋条件書・追加／基本契約書＋発注書・追加）。 */
  const [setOpen, setSetOpen] = useState(false);
  /** 送信・締結：決定した文書をまとめて送る（① メール 1 通 → ② CloudSign 1 封筒）。 */
  const [sendingAll, setSendingAll] = useState<null | "mail" | "cloudsign">(null);
  const [channels, setChannels] = useState<Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    api.get<{ channels?: typeof channels }>("/integrations").then((r) => setChannels(r.channels ?? [])).catch(() => undefined);
    api.get<{ user?: { role: string } }>("/me").then((r) => setIsAdmin(r.user?.role === "admin")).catch(() => undefined);
  }, []);

  async function load(id: number) {
    try {
      const d = await api.get<MatterDetail>(`/matters/${id}`);
      setDetail(d);
      if (d.counterparty) {
        const a = await api.get<{ agreements: Agreement[] }>(`/agreements?partyId=${d.counterparty.id}`);
        setAgreements(a.agreements);
        if (!agreementId) {
          const live = d.agreements.find((x) => x.live) ?? d.agreements[0];
          if (live) setAgreementId(String(live.id));
        }
      }
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }
  useEffect(() => { if (ctx.matterId) void load(ctx.matterId); }, [ctx.matterId]);

  const conditions = detail?.conditions ?? [];
  const mine = useMemo(() => conditions.filter((c) => {
    if (p === "service") return c.direction === "in" && (c.kind === "service" || c.kind === "expense" || c.kind === "fee");
    if (isOut(p)) return c.direction === "out" && c.kind === "license";
    return c.direction === "in" && c.kind === "license";
  }), [conditions, p]);
  const docs = detail?.documents ?? [];
  const docKeys = new Set(DOCS[p].map((d) => d.key));
  const myDocs = docs.filter((d) => d.templateKey && docKeys.has(d.templateKey));
  const masterDocs = docs.filter((d) => d.templateKey === MASTER[p].key);
  const issued = myDocs.filter((d) => d.status === "issued");
  const sent = issued.filter((d) => d.sentAt);

  const stages = [
    { no: 0, name: "基礎情報", done: Boolean(detail), st: detail ? `${detail.matterNo ?? `#${detail.id}`}` : "取引先・作品・担当者" },
    { no: 1, name: "基本契約", done: Boolean(agreementId) || noAgreement || masterDocs.some((d) => d.status === "issued"),
      st: agreementId ? (agreements.find((a) => String(a.id) === agreementId)?.agreementNo ?? "選択済") : noAgreement ? "なし（単独）" : "未選択" },
    { no: 2, name: p === "service" ? "明細（条件明細）" : "許諾条件", done: mine.length > 0, st: mine.length ? `${mine.length} 本` : "未登録" },
    { no: 3, name: p === "service" ? "発注書" : "条件書・契約書", done: issued.length > 0,
      st: issued.length ? `決定 ${issued.length}` : myDocs.length ? `下書き ${myDocs.length}` : "未作成" },
    { no: 4, name: p === "service" ? "送信" : "送信・締結", done: sent.length > 0, st: sent.length ? `送付 ${sent.length}` : "—" }
  ];
  const after = p === "service" ? "以後：納品・検収・支払は 支払文書処理 の画面で（行ごと）"
    : isOut(p) ? "以後：計算書（受け取る側）は 作品の台帳 で（締めごと）" : "以後：計算書は 作品の台帳 で（締めごと）";

  const party = detail?.counterparty ?? null;
  const preset = {
    ...(detail ? { matterId: String(detail.id) } : {}),
    ...(party ? { counterpartyId: String(party.id) } : {}),
    ...(detail?.work ? { workId: String(detail.work.id) } : {}),
    ...(agreementId ? { agreementId } : {})
  };
  const conditionIdsFor = (which: "license_in" | "license_out" | "service" | "none") =>
    which === "none" ? [] : mine.map((c) => c.id);

  return (
    <section className="stack">
      <div className="row" style={{ alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{patternLabel(p)}</h1>
        {detail && <>
          <span className="faint">取引先 <b>{party?.name ?? "—"}</b></span>
          {detail.work && <span className="faint">作品 <b>{detail.work.title}</b></span>}
          <span className="faint">担当 <b>{detail.ownerName ?? "—"}</b></span>
          <button className="linky" onClick={() => onOpenMatter(detail.id)}>案件 {detail.matterNo ?? `#${detail.id}`} を開く</button>
        </>}
        <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
          {detail && (
            <select value={p} onChange={(e) => onCtx({ pattern: e.target.value as TradePattern, matterId: detail.id })} aria-label="取引の種類">
              {PATTERNS.map((x) => <option key={x.value} value={x.value}>{x.group} {x.label}</option>)}
            </select>
          )}
          <button className="btn btn-sm" onClick={() => onCtx(null)}>別の取引を選ぶ</button>
        </span>
      </div>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "230px minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <nav className="panel" style={{ position: "sticky", top: 12 }}>
          <div className="panel-bd stack" style={{ gap: 2 }}>
            {stages.map((s) => (
              <button key={s.no} aria-current={stage === s.no ? "step" : undefined}
                      style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 8, textAlign: "left", padding: "8px 6px",
                               background: stage === s.no ? "var(--accent-soft)" : "transparent", border: 0, borderRadius: 6,
                               cursor: "pointer", font: "inherit", color: "inherit" }}
                      onClick={() => setStage(s.no)} disabled={!detail && s.no > 0}>
                <span className="tag" style={{ padding: "0 5px", background: s.done ? "var(--ok-soft)" : undefined, color: s.done ? "var(--ok)" : undefined }}>
                  {s.done ? "✓" : s.no + 1}
                </span>
                <span><b style={{ fontSize: 13 }}>{s.name}</b><br /><span className="faint" style={{ fontSize: 11.5 }}>{s.st}</span></span>
              </button>
            ))}
            <div className="faint" style={{ padding: "8px 6px", fontSize: 11.5, borderTop: "1px solid var(--line)", marginTop: 4 }}>→ {after}</div>
          </div>
        </nav>

        <div className="stack">
          {stage === 0 && (
            <BasicsStage pattern={p} detail={detail}
              onCreated={(id) => { onCtx({ pattern: p, matterId: id }); setStage(1); setNotice("案件を立てました。文書の担当者・メールの宛先はこの案件から入ります"); }}
              onError={setError} />
          )}

          {stage === 1 && detail && (
            <div className="panel">
              <div className="panel-hd"><h2>基本契約</h2><span className="faint">{party?.name} との契約</span></div>
              <div className="panel-bd stack">
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {agreements.map((a) => (
                    <button key={a.id} className="chip" aria-pressed={agreementId === String(a.id)}
                            onClick={() => { setAgreementId(String(a.id)); setNoAgreement(false); }}>
                      {a.agreementNo ?? `#${a.id}`} {a.title}（{a.status === "executed" ? `締結 ${a.executedOn ?? ""}` : a.status}）
                    </button>
                  ))}
                  <button className="chip" aria-pressed={noAgreement} onClick={() => { setNoAgreement(true); setAgreementId(""); }}>
                    基本契約なし{p === "service" ? "（発注書単独。基本契約なしの条項が入る）" : "（条件書を単独契約として出す）"}
                  </button>
                  {!agreements.length && <span className="faint">この取引先の契約はまだありません</span>}
                </div>
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button className="btn" onClick={() => onCompose([], [], detail.id, MASTER[p].key)}>
                    {MASTER[p].label}を作って送る
                  </button>
                  <button className="btn" onClick={() => party && onRegisterAgreement(party.id, party.name)}>外で結んだ契約を登録する</button>
                  <span className="faint">作る場合は相手先・期間を契約の記録と取引先から引きます。決定したら文書の「送る」へ</span>
                </div>
                {masterDocs.length > 0 && (
                  <div className="stack" style={{ gap: 4 }}>
                    <b>この案件の基本契約書</b>
                    {masterDocs.map((d) => (
                      <div key={d.id} className="row" style={{ gap: 8 }}>
                        <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                        <StatusTag kind="document" value={d.status === "issued" ? (d.sentAt ? "sent" : "decided") : "draft"} />
                        {d.agreementStatus && <span className="tag">{d.agreementStatus}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="row"><button className="btn primary" onClick={() => setStage(2)}>次へ：{stages[2].name}</button></div>
              </div>
            </div>
          )}

          {stage === 2 && detail && (
            <div className="stack">
              {mine.length > 0 && (
                <div className="panel">
                  <div className="panel-hd"><h2>{stages[2].name}</h2><span className="tag">{mine.length} 本</span></div>
                  <div className="panel-bd stack" style={{ gap: 4 }}>
                    {mine.map((c) => (
                      <div key={c.id} className="row" style={{ gap: 8 }}>
                        <span className="code">{c.conditionNo ?? `#${c.id}`}</span>
                        <span>{c.name}</span>
                        {c.usageType && <span className="tag">{c.usageType}</span>}
                        <span className="faint">{c.pricingModel === "revenue_rate" && c.ratePpm != null ? `${c.ratePpm / 10000}%`
                          : c.flatAmount != null ? `¥${c.flatAmount.toLocaleString("ja-JP")}` : c.unitAmount != null ? `単価 ¥${c.unitAmount.toLocaleString("ja-JP")}` : ""}</span>
                      </div>
                    ))}
                    <div className="row">
                      <button className="btn btn-sm" onClick={() => setAdding(true)}>条件を足す</button>
                      <button className="btn primary btn-sm" onClick={() => setStage(3)}>次へ：{stages[3].name}</button>
                    </div>
                  </div>
                </div>
              )}
              {(adding || mine.length === 0) && (
                <ConditionStage pattern={p} preset={preset} partyName={party?.name ?? null} workTitle={detail.work?.title ?? null}
                  matterId={detail.id} title={detail.title}
                  onDone={async () => { setAdding(false); await load(detail.id); setNotice("条件を登録しました"); if (mine.length === 0) setStage(3); }}
                  onCancel={() => setAdding(false)} onError={setError} />
              )}
            </div>
          )}

          {stage === 3 && detail && setOpen && party && SET_PATTERNS.has(p) && (
            <DocumentSet domain={p === "service" ? "service" : "license"} matterId={detail.id} partyId={party.id} partyName={party.name}
              masterKey={MASTER[p].key} masterLabel={MASTER[p].label}
              termsOptions={p === "service" ? [{ key: "purchase_order", label: "発注書" }, { key: "intl_purchase_order", label: "発注書（海外）" }]
                : creatable.length ? creatable : DOCS[p]}
              conditions={mine.map((c) => ({ id: c.id, conditionNo: c.conditionNo, name: c.name, work: c.work ? { id: c.work.id, title: c.work.title } : null }))}
              agreements={agreements} channels={channels} isAdmin={isAdmin}
              onIssued={() => void load(detail.id)} onOpenDocument={onOpenDocument} onClose={() => setSetOpen(false)} />
          )}
          {stage === 3 && detail && !setOpen && (
            <div className="panel">
              <div className="panel-hd"><h2>{stages[3].name}</h2><span className="faint">条件 {mine.length} 本から作る</span></div>
              <div className="panel-bd stack">
                {!mine.length && <div className="note warn">先に{stages[2].name}を登録してください（文書は条件から作ります）</div>}
                {SET_PATTERNS.has(p) && party && (
                  <div className="note" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button className="btn primary" disabled={!mine.length} onClick={() => setSetOpen(true)}>
                      {MASTER[p].label}と{p === "service" ? "発注書" : "条件書"}をまとめて作る
                    </button>
                    <span className="faint">1 つのフォームで、基本契約・{p === "service" ? "発注書・追加の発注書" : "条件書・追加の条件書"}をスイッチで選んで作り、まとめて送ります</span>
                  </div>
                )}
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {creatable.map((d) => (
                    <button key={d.key} className="btn primary" disabled={!mine.length}
                            onClick={() => onCompose(conditionIdsFor(d.conditions), [], detail.id, d.key)}>
                      {d.label}を作る
                    </button>
                  ))}
                </div>
                <span className="faint">文書の画面が開きます。当社担当者・基本契約・条件からの自動入力はその場で確かめられ、決定すると番号が付きます。</span>
                {myDocs.length > 0 && (
                  <div className="stack" style={{ gap: 4 }}>
                    <b>この案件の{stages[3].name}</b>
                    {myDocs.map((d) => (
                      <div key={d.id} className="row" style={{ gap: 8 }}>
                        <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                        <span>{d.templateLabel}</span>
                        <StatusTag kind="document" value={d.status === "issued" ? (d.sentAt ? "sent" : "decided") : d.status === "draft" ? "draft" : d.status} />
                      </div>
                    ))}
                  </div>
                )}
                <div className="row"><button className="btn" disabled={!issued.length} onClick={() => setStage(4)}>次へ：{stages[4].name}</button></div>
              </div>
            </div>
          )}

          {stage === 4 && detail && (
            <div className="panel">
              <div className="panel-hd"><h2>{stages[4].name}</h2></div>
              <div className="panel-bd stack">
                {!issued.length && <div className="note warn">決定した文書がまだありません</div>}
                {(() => {
                  // 基本契約書も含めて、この案件で決定した文書をまとめて送る。
                  const all = [...masterDocs, ...myDocs].filter((d) => d.status === "issued");
                  if (all.length < 2) return null;
                  return (
                    <div className="note stack" style={{ gap: 6 }}>
                      <b>まとめて送る（{all.length} 枚：{all.map((d) => d.documentNo ?? `#${d.id}`).join("・")}）</b>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <button className="btn primary" onClick={() => setSendingAll("mail")}>① 内容確認のメールを 1 通で送る</button>
                        <button className="btn" disabled={!isAdmin} onClick={() => setSendingAll("cloudsign")}>② CloudSign を 1 封筒で作る（締結）</button>
                      </div>
                      <span className="faint">① 当社担当者・事業部の担当者と取引先に内容確認（PDF を全部添付）→ 確認が取れたら ② 全部を 1 つの封筒で署名依頼</span>
                      {sendingAll && (
                        <SendMany key={sendingAll} documents={all.map((d) => ({ id: d.id, documentNo: d.documentNo, counterparty: d.counterparty }))}
                                  channels={channels} isAdmin={isAdmin} initialWay={sendingAll} prefillSigners={sendingAll === "cloudsign"} prefillMail={sendingAll === "mail"}
                                  onDone={() => void load(detail.id)} onClose={() => setSendingAll(null)} />
                      )}
                    </div>
                  );
                })()}
                {issued.map((d) => (
                  <div key={d.id} className="row" style={{ gap: 8 }}>
                    <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                    <span>{d.templateLabel}</span>
                    {d.sentAt ? <span className="tag ok">送付 {d.sentAt.slice(0, 10)}（{d.sentVia === "cloudsign" ? "CloudSign" : "メール"}）</span>
                      : <button className="btn btn-sm primary" onClick={() => onOpenDocument(d.id)}>開いて送る</button>}
                  </div>
                ))}
                <span className="faint">文書の「送る」で、内容確認メール → CloudSign（署名者・CC は取引先の署名者と案件の担当者から入る）→ 締結 と進みます。</span>
                <div className="note ok">
                  {p === "service"
                    ? "ここでこの発注の進行は完了です。納品の報告が入ると支払文書処理の画面にその行（条件明細）が並び、そこで検収書を作って支払を立てます。"
                    : isOut(p)
                      ? "ここでこの取引の進行は完了です。相手からの売上報告と計算書の照合は、作品の画面の台帳（受け取る側）で締めごとに行います。"
                      : "ここでこの取引の進行は完了です。許諾料の計算書は締めが来てから、作品の画面の台帳で作ります。"}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** 段階 0：基礎情報。案件を立てる。 */
function BasicsStage(
  { pattern, detail, onCreated, onError }: {
    pattern: TradePattern; detail: MatterDetail | null;
    onCreated: (matterId: number) => void; onError: (m: string) => void;
  }
) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [partyId, setPartyId] = useState("");
  const [partyName, setPartyName] = useState<string | null>(null);
  const [workId, setWorkId] = useState("");
  const [workName, setWorkName] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [requester, setRequester] = useState("");
  const [owner, setOwner] = useState("");
  const [line, setLine] = useState(pattern.startsWith("pub") ? "publishing" : "boardgame");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ staff: Staff[] }>("/staff").then((r) => setStaff(r.staff.filter((s) => (s.status ?? "active") === "active"))).catch(() => undefined);
  }, []);
  const license = isLicense(pattern);
  const autoTitle = () => {
    const base = pattern === "service" ? `${partyName ?? ""} 業務委託` : `${workName ?? ""} ${isOut(pattern) ? "許諾" : "権利取得"}（${partyName ?? ""}）`;
    return base.trim();
  };
  const ready = Boolean(partyId) && (!license || Boolean(workId));

  if (detail) {
    return (
      <div className="panel"><div className="panel-hd"><h2>基礎情報</h2><span className="tag ok">案件 {detail.matterNo ?? `#${detail.id}`}</span></div>
        <div className="panel-bd stack">
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <span>取引先 <b>{detail.counterparty?.name ?? "—"}</b></span>
            {detail.work && <span>作品 <b>{detail.work.title}</b></span>}
            <span>法務担当 <b>{detail.ownerName ?? "—"}</b></span>
          </div>
          <span className="faint">事業部担当者（依頼者のメール）と法務担当は案件の画面で直せます。文書の当社担当者・メールの宛先・CloudSign の確認者はここから入ります。</span>
        </div></div>
    );
  }
  return (
    <div className="panel">
      <div className="panel-hd"><h2>基礎情報</h2><span className="faint">ここで入れた相手先・担当者が、以後の文書とメールに入ります</span></div>
      <div className="panel-bd stack">
        <div className="form-grid">
          <label className="field"><span>{pattern === "service" ? "受託者（相手先）" : isOut(pattern) ? "許諾先（相手先）" : "権利元（相手先）"}</span>
            <SearchSelect value={partyId} search={searchParties} placeholder="取引先名・コードで探す"
                          onChange={(v, o) => { setPartyId(v); setPartyName(o?.label ?? null); }} /></label>
          <label className="field"><span>作品{license ? "" : "（任意）"}</span>
            <SearchSelect value={workId} search={searchWorks} emptyLabel={license ? undefined : "（なし）"} placeholder="作品名・コードで探す"
                          onChange={(v, o) => { setWorkId(v); setWorkName(o?.label ?? null); }} />
            {license && <small className="faint">{isOut(pattern) ? "許諾する作品。OUT 条件はこの作品の IN 条件の範囲内で入れます" : "取得する作品（原作）。無ければ作品の画面で先に登録します"}</small>}</label>
          <label className="field"><span>{pattern === "service" ? "業務名（件名）" : "件名"}</span>
            <input value={title} placeholder={autoTitle() || "空なら自動で付く"} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field"><span>事業区分</span>
            <select value={line} onChange={(e) => setLine(e.target.value)}>
              <option value="boardgame">ボードゲーム事業</option><option value="publishing">出版事業</option>
              <option value="store">店舗事業</option><option value="planning">企画事業</option><option value="admin">管理事業部</option>
            </select></label>
          <label className="field"><span>事業部担当者（依頼者）のメール</span>
            <input list="trade-requester" value={requester} placeholder="例：seisaku-a@example.co.jp" onChange={(e) => setRequester(e.target.value)} />
            <datalist id="trade-requester">{staff.filter((s) => s.email).map((s) => <option key={s.id} value={s.email ?? ""}>{s.name}</option>)}</datalist>
            <small className="faint">担当者への確認メールの宛先、CloudSign の確認者（CC）になる</small></label>
          <label className="field"><span>法務担当</span>
            <SearchSelect value={owner} options={staffOptions(staff)} emptyLabel="あとで決める" valueLabel="あとで決める" placeholder="氏名・部署で探す"
                          onChange={(v) => setOwner(v)} />
            <small className="faint">文書の【ご連絡先】・検収者、メールの cc、CloudSign の CC になる</small></label>
        </div>
        <div className="row">
          <button className="btn primary" disabled={!ready || busy} onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<{ id: number }>("/matters", {
                kind: pattern === "service" ? "outsourcing" : "work",
                title: title.trim() || autoTitle() || null,
                workId: workId ? Number(workId) : null, counterpartyId: Number(partyId),
                ownerStaffId: owner ? Number(owner) : null,
                requesterEmail: requester.trim() || null,
                businessLine: line,
                businessName: pattern === "service" ? (title.trim() || autoTitle() || null) : null,
                remarks: `取引を進める画面（${patternLabel(pattern)}）から`
              });
              onCreated(r.id);
            } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
            finally { setBusy(false); }
          }}>{busy ? "作っています…" : "案件を立てて次へ：基本契約"}</button>
          <span className="faint">案件が器になります。既にある案件で進めるなら、案件の画面の「取引を進める」から開いてください</span>
        </div>
      </div>
    </div>
  );
}

/** 段階 2：パターンごとの条件の登録フォーム。 */
function ConditionStage(
  { pattern, preset, partyName, workTitle, matterId, title, onDone, onCancel, onError }: {
    pattern: TradePattern; preset: Record<string, string>; partyName: string | null; workTitle: string | null;
    matterId: number; title: string | null; onDone: () => void | Promise<void>; onCancel: () => void; onError: (m: string) => void;
  }
) {
  if (pattern === "service") {
    return <ServiceLinesForm preset={preset} counterpartyName={partyName} initialTitle={title}
                             onDone={() => void onDone()} onCancel={onCancel} />;
  }
  if (pattern === "game_in") {
    return <LicenseSetForm preset={preset} presetLabels={{ counterpartyId: partyName, workId: workTitle }}
                           onDone={() => void onDone()} onCancel={onCancel} />;
  }
  if (pattern === "pub_in") {
    return <PubConditionSetForm preset={preset} onDone={() => void onDone()} onCancel={onCancel} />;
  }
  // OUT：OUT 条件フォームは案件を知らないので、作ったら案件に繋ぐ。
  return (
    <OutConditionForm
      preset={{ counterpartyId: preset.counterpartyId, workId: preset.workId, agreementId: preset.agreementId,
                usageType: pattern === "pub_out" ? "sublicense" : "sublicense" }}
      presetLabels={{ counterpartyId: partyName, workId: workTitle }}
      onDone={async (made) => {
        try { await api.post(`/matters/${matterId}/conditions`, { conditionId: made.id }); }
        catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
        await onDone();
      }}
      onCancel={onCancel} />
  );
}
