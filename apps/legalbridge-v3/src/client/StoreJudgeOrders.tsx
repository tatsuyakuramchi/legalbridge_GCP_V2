import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { OwnerStaffPicker } from "./OwnerStaffPicker.js";
import { exTaxOf } from "../server/store-events/plan.js";

/**
 * 店舗イベント審判業務の発注書（ひな形：発注書）。
 *
 *   1. 店舗を選ぶ → 2. その店舗の担当取引先を選ぶ → 3. その月の開催日を並べる
 *   → 下書き（条件明細・予定明細・案件つき）。決定・送るはいつもの文書の画面で。
 *
 * 1 取引先 × 1 か月 ＝ 発注書 1 枚。同じイベント（名前・店舗・単価が同じ）の日は 1 行（数量＝日数）、
 * 違えば行を分ける。交通費は開催日ごとに経費欄へ。基本契約は人によって有る・無い（人ごとの設定、
 * この 1 枚だけの指定もできる）。
 *
 * 店舗と担当取引先は下の「店舗と担当取引先」で持つ。
 */

interface Judge {
  partyId: number; name: string; partyCode: string | null; kind: string; invoiceNo: string | null;
  withholding: boolean; email: string | null; defaultFeeIncTax: number | null; defaultTravelIncTax: number | null;
  agreementMode: "auto" | "fixed" | "none"; agreementId: number | null; agreementNo: string | null;
}
interface Store { id: number; name: string; shortName: string; active: boolean; sortOrder: number; judges: Judge[] }
interface AgreementRef { id: number; agreementNo: string | null; title: string; status: string }
interface Line { key: string; eventName: string; store: { name: string; shortName: string }; dates: string[];
  quantity: number; unitPrice: number; amount: number; itemName: string; spec: string; termStart: string; termEnd: string }
interface Preview {
  party: { id: number; name: string; kind: string } | null;
  plan: { month: string | null; subject: string; lines: Line[]; expenses: Array<{ date: string; amount: number }>;
          subtotal: number; travelTotal: number; payOn: string | null; issues: string[] };
  matter: { id: number; matterNo: string | null; title: string } | null;
  agreement: AgreementRef | null; agreementNote: string; agreementCandidates: AgreementRef[];
  issues: string[];
}
interface Row { key: number; date: string; startTime: string; eventName: string; storeId: number;
  feeIncTax: string; travelOn: boolean; travel: string }
interface ReviseSource {
  documentId: number; documentNo: string | null; partyId: number | null; partyName: string | null;
  days: Array<{ date: string; startTime: string; eventName: string; storeId: number; feeIncTax: number; travelIncTax: number | null }>;
  fromThisScreen: boolean; issues: string[];
}
interface Created { documentId: number; supersedesId?: number | null; matterId: number; matterCreated: boolean;
  conditions: Array<{ id: number; conditionNo: string | null; kind: string }> }

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const numOf = (v: string) => { const n = Number(String(v ?? "").replace(/[,，¥￥\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const jaDate = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日` : "—";
};
const MODE_LABEL = { auto: "自動（締結済みの基本契約が 1 本ならそれ）", none: "基本契約なし（標準約款）", fixed: "この契約に載せる" } as const;

export function StoreJudgeOrders({ onOpenDocument, reviseDocumentId = null }: {
  onOpenDocument: (id: number) => void;
  /** 訂正版を作る元の発注書（文書の「訂正版を作る（店舗イベント審判）」から）。 */
  reviseDocumentId?: number | null;
}) {
  const readOnly = useReadOnly();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [partyId, setPartyId] = useState<number | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [seq, setSeq] = useState(1);
  /** この 1 枚の基本契約。"" は人の設定どおり。 */
  const [agreementChoice, setAgreementChoice] = useState("");
  const [ownerStaffId, setOwnerStaffId] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMaster, setShowMaster] = useState(false);
  const [source, setSource] = useState<ReviseSource | null>(null);
  const [reason, setReason] = useState("");

  const reloadStores = () => api.get<{ stores: Store[] }>("/store-events/stores")
    .then((r) => { setStores(r.stores); setStoreId((cur) => cur ?? r.stores.find((s) => s.active)?.id ?? null); })
    .catch((e: ApiError) => setError(e.message));
  useEffect(() => { void reloadStores(); }, []);

  // 訂正版：元の発注書の取引先と、この画面で作ったものなら開催日を入れておく。手で作ったものは開催日を入れ直す。
  useEffect(() => {
    if (!reviseDocumentId) return;
    api.get<ReviseSource>(`/store-events/orders/source/${reviseDocumentId}`)
      .then(setSource).catch((e: ApiError) => setError(e.message));
  }, [reviseDocumentId]);
  useEffect(() => {
    if (!source?.partyId || !stores.length || partyId) return;
    const mine = stores.filter((st) => st.active && st.judges.some((j) => j.partyId === source.partyId));
    const first = source.days[0]?.storeId ?? mine[0]?.id ?? null;
    setPartyId(source.partyId);
    if (first) setStoreId(first);
    if (source.days.length) {
      setRows(source.days.map((d, i) => ({ key: i + 1, date: d.date, startTime: d.startTime, eventName: d.eventName, storeId: d.storeId,
        feeIncTax: String(d.feeIncTax || ""), travelOn: Number(d.travelIncTax ?? 0) > 0,
        travel: Number(d.travelIncTax ?? 0) > 0 ? String(d.travelIncTax) : "" })));
      setSeq(source.days.length + 1);
    } else if (first) {
      const j = stores.find((st) => st.id === first)?.judges.find((x) => x.partyId === source.partyId);
      const travel = j?.defaultTravelIncTax ?? 0;
      setRows([{ key: 1, date: "", startTime: "12:00", eventName: "", storeId: first,
        feeIncTax: j?.defaultFeeIncTax ? String(j.defaultFeeIncTax) : "", travelOn: travel > 0, travel: travel ? String(travel) : "" }]);
      setSeq(2);
    }
  }, [source, stores]);

  const activeStores = stores.filter((s) => s.active);
  const store = stores.find((s) => s.id === storeId) ?? null;
  const judge = store?.judges.find((j) => j.partyId === partyId) ?? null;
  /** この人が担当している店舗（行ごとに選べる。同じ月に違う店舗へ行くことがある）。 */
  const storesOfParty = useMemo(() => activeStores.filter((s) => s.judges.some((j) => j.partyId === partyId)),
    [stores, partyId]);
  const defaultsFor = (sid: number) => stores.find((s) => s.id === sid)?.judges.find((j) => j.partyId === partyId) ?? null;

  const blankRow = (key: number, sid: number, base?: Row): Row => {
    const d = defaultsFor(sid) ?? judge;
    const travel = d?.defaultTravelIncTax ?? 0;
    return base ? { ...base, key, date: "" } : {
      key, date: "", startTime: "12:00", eventName: "", storeId: sid,
      feeIncTax: d?.defaultFeeIncTax ? String(d.defaultFeeIncTax) : "", travelOn: travel > 0, travel: travel ? String(travel) : ""
    };
  };

  const pickJudge = (j: Judge) => {
    // 訂正版では取引先は変えない。同じ人を押し直して読み込んだ開催日を消さない。
    if (reviseDocumentId) return;
    setPartyId(j.partyId); setCreated(null); setAgreementChoice("");
    const travel = j.defaultTravelIncTax ?? 0;
    setRows([{ key: seq, date: "", startTime: "12:00", eventName: "", storeId: storeId!,
      feeIncTax: j.defaultFeeIncTax ? String(j.defaultFeeIncTax) : "", travelOn: travel > 0, travel: travel ? String(travel) : "" }]);
    setSeq(seq + 1);
  };
  const patch = (key: number, f: Partial<Row>) => { setCreated(null); setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...f } : r))); };
  const changeStore = (key: number, sid: number) => {
    const d = defaultsFor(sid);
    const travel = d?.defaultTravelIncTax ?? 0;
    patch(key, { storeId: sid, ...(d ? { feeIncTax: d.defaultFeeIncTax ? String(d.defaultFeeIncTax) : "",
      travelOn: travel > 0, travel: travel ? String(travel) : "" } : {}) });
  };

  const body = useMemo(() => partyId ? {
    partyId, ownerStaffId,
    revise: reviseDocumentId ? { documentId: reviseDocumentId, reason } : null,
    agreement: agreementChoice === "" ? null
      : agreementChoice === "none" ? { mode: "none" as const }
      : agreementChoice === "auto" ? { mode: "auto" as const }
      : { mode: "fixed" as const, agreementId: Number(agreementChoice) },
    days: rows.map((r) => ({ date: r.date, startTime: r.startTime, eventName: r.eventName, storeId: r.storeId,
      feeIncTax: numOf(r.feeIncTax), travelIncTax: r.travelOn ? numOf(r.travel) : null }))
  } : null, [partyId, ownerStaffId, agreementChoice, rows, reviseDocumentId, reason]);

  // 突き合わせ。打つたびに少し待って引き直す。何も作らない。
  useEffect(() => {
    if (!body) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.post<Preview>("/store-events/orders/preview", body)
        .then((r) => { if (live) { setPreview(r); setError(null); } })
        .catch((e: ApiError) => { if (live) setError(e.message); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [body]);

  const create = async () => {
    if (!body) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<Created>("/store-events/orders", body);
      setCreated(r);
      // 同じ人の次の月を続けて作りやすいよう、行は残す。
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  };

  const plan = preview?.plan;
  const settingLabel = judge ? (judge.agreementMode === "fixed" ? `この契約（${judge.agreementNo ?? `#${judge.agreementId}`}）`
    : judge.agreementMode === "none" ? "基本契約なし" : "自動") : "自動";

  return (
    <section className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2>店舗イベント審判業務の発注書</h2>
          <span className="faint">1 取引先 × 1 か月 ＝ 1 枚。同じイベントは 1 行（数量＝日数）、違うイベントは行を分ける</span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => setShowMaster((v) => !v)}>{showMaster ? "店舗の設定を閉じる" : "店舗と担当取引先の設定"}</button>
        </div>
        <div className="panel-bd stack">
          {error && <div className="note warn">{error}</div>}
          {reviseDocumentId && (
            <div className="note">
              <b>訂正版を作ります：{source?.documentNo ?? `#${reviseDocumentId}`}</b>（{source?.partyName ?? "…"} 様）
              <div className="faint">
                {source?.fromThisScreen ? "元の開催日を読み込みました。直して作ると訂正版の下書きになります。"
                  : "手で作った発注書なので開催日は読み込めません。この月の開催日を入れ直してください。"}
                {" "}訂正版を決定した時点で、元の条件明細は無効になり、新しい条件明細に置き換わります（下書きのうちは元のまま）。
              </div>
              {source?.issues.map((i) => <div key={i} className="note warn" style={{ marginTop: 6 }}>{i}</div>)}
              {source?.partyId && !stores.some((st) => st.judges.some((j) => j.partyId === source.partyId)) && stores.length > 0 && (
                <div className="note warn" style={{ marginTop: 6 }}>
                  {source.partyName} はどの店舗の担当にも登録されていません。「店舗と担当取引先の設定」で担当に足してください。
                </div>
              )}
              <label className="field" style={{ marginTop: 8 }}><span>訂正の理由</span>
                <input value={reason} placeholder="例：11/25 の開催を追加" onChange={(e) => { setReason(e.target.value); setCreated(null); }} /></label>
            </div>
          )}
          {!activeStores.length && (
            <div className="note">店舗がまだ登録されていません。「店舗と担当取引先の設定」から店舗と担当を足してください。</div>
          )}

          <div className="stack" style={{ gap: 6 }}>
            <b>1. 店舗を選ぶ</b>
            <div className="row">
              {activeStores.map((s) => (
                <button key={s.id} type="button" className="chip" aria-pressed={s.id === storeId}
                        onClick={() => { setStoreId(s.id); }}>
                  {s.name} <span className="faint">担当 {s.judges.length} 名</span>
                </button>
              ))}
            </div>
          </div>

          {store && (
            <div className="stack" style={{ gap: 6 }}>
              <b>2. 業務する取引先を選ぶ <span className="faint">（{store.name} の担当）</span></b>
              {!store.judges.length && <div className="note warn">この店舗にはまだ担当取引先がいません。「店舗と担当取引先の設定」で足してください。</div>}
              <div className="row">
                {store.judges.map((j) => (
                  <button key={j.partyId} type="button" className="chip" aria-pressed={j.partyId === partyId}
                          disabled={Boolean(reviseDocumentId) && j.partyId !== partyId}
                          title={reviseDocumentId ? "訂正版では取引先は変えられません" : undefined} onClick={() => pickJudge(j)}>
                    {j.name}
                    <span className="faint">
                      {" "}{j.defaultFeeIncTax ? `${yen(j.defaultFeeIncTax)}／日` : "既定額なし"}
                      ・交通費 {j.defaultTravelIncTax ? yen(j.defaultTravelIncTax) : "なし"}
                      ・基本契約 {j.agreementMode === "none" ? "なし" : j.agreementMode === "fixed" ? (j.agreementNo ?? "指定") : "自動"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {partyId && (
            <div className="stack" style={{ gap: 6 }}>
              <b>3. その月の開催日 <span className="faint">（{rows.length} 日）</span></b>
              <div className="tablewrap">
                <table className="compact">
                  <thead><tr><th>開催日</th><th>開始</th><th>イベント名</th><th>店舗</th>
                    <th className="num">委託料（税込）</th><th className="num">税抜</th><th>交通費（税込）</th><th /></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td><input type="date" className="inline-input" value={r.date} onChange={(e) => patch(r.key, { date: e.target.value })} /></td>
                        <td><input type="time" className="inline-input" style={{ width: 96 }} value={r.startTime}
                                   onChange={(e) => patch(r.key, { startTime: e.target.value })} /></td>
                        <td><input className="inline-input" style={{ width: 200 }} value={r.eventName} placeholder="例：氷星杯"
                                   onChange={(e) => patch(r.key, { eventName: e.target.value })} /></td>
                        <td>
                          <select className="inline-input" value={r.storeId} onChange={(e) => changeStore(r.key, Number(e.target.value))}>
                            {storesOfParty.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </td>
                        <td className="num"><input className="inline-input" style={{ width: 100, textAlign: "right" }} value={r.feeIncTax}
                                   onChange={(e) => patch(r.key, { feeIncTax: e.target.value })} /></td>
                        <td className="num">{numOf(r.feeIncTax) > 0 ? yen(exTaxOf(numOf(r.feeIncTax))) : "—"}</td>
                        <td>
                          <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                            <input type="checkbox" aria-label="交通費あり" checked={r.travelOn} onChange={() => patch(r.key, { travelOn: !r.travelOn })} />
                            <input className="inline-input" style={{ width: 80, textAlign: "right" }} value={r.travel} disabled={!r.travelOn}
                                   onChange={(e) => patch(r.key, { travel: e.target.value })} />
                          </span>
                        </td>
                        <td><button className="btn btn-sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>外す</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row">
                <button className="btn btn-sm" onClick={() => {
                  const last = rows[rows.length - 1];
                  setRows((rs) => [...rs, blankRow(seq, last?.storeId ?? storeId!, last)]); setSeq(seq + 1);
                }}>＋ 開催日を足す（上の行を写す）</button>
                <span className="faint">イベント名・店舗・単価が同じ日は 1 行にまとまります。どれかが違えば別の行。</span>
              </div>
            </div>
          )}

          {partyId && preview && (
            <div className="stack" style={{ gap: 6 }}>
              <b>4. 基本契約と案件</b>
              <label className="field"><span>基本契約</span>
                <select value={agreementChoice} onChange={(e) => setAgreementChoice(e.target.value)}>
                  <option value="">この人の設定どおり（{settingLabel}）</option>
                  <option value="auto">{MODE_LABEL.auto}</option>
                  <option value="none">{MODE_LABEL.none}</option>
                  {preview.agreementCandidates.map((a) => (
                    <option key={a.id} value={String(a.id)}>この契約：{a.agreementNo ?? `#${a.id}`} {a.title}{a.status !== "executed" ? `（${a.status}）` : ""}</option>
                  ))}
                </select>
              </label>
              <div className="faint" style={{ paddingLeft: 120 }}>
                {preview.agreement
                  ? <>載せる契約：<b>{preview.agreement.agreementNo ?? `#${preview.agreement.id}`} {preview.agreement.title}</b>（{preview.agreementNote}）</>
                  : preview.agreementNote || "—"}
              </div>
              <div className="field"><span>案件</span>
                <span>{preview.matter ? `${preview.matter.matterNo ?? `#${preview.matter.id}`} ${preview.matter.title}`
                  : "まだ無いので作ります（店舗事業｜取引先｜店舗イベント審判業務）"}</span>
              </div>
              {!preview.matter && (
                <div className="field"><span>案件の担当者</span>
                  <OwnerStaffPicker value={ownerStaffId} onChange={setOwnerStaffId} emptyLabel="選んでください" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {partyId && plan && (
        <div className="panel">
          <div className="panel-hd">
            <h2>プレビュー（発注書の明細）</h2>
            <span className="tag accent">{plan.subject}</span>
            <span className="faint">発注先 {preview?.party?.name} 様 ／ 役務提供期間 {plan.lines.length
              ? `${jaDate(plan.lines.map((l) => l.termStart).sort()[0])}${plan.lines.some((l) => l.termEnd !== plan.lines[0].termStart) ? `〜${jaDate(plan.lines.map((l) => l.termEnd).sort().at(-1) ?? null)}` : ""}`
              : "—"} ／ 支払期日 {jaDate(plan.payOn)}</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>No</th><th>品目名・仕様</th><th className="num">数量</th><th className="num">単価（税抜）</th><th className="num">金額（税抜）</th></tr></thead>
              <tbody>
                {plan.lines.map((l, i) => (
                  <tr key={l.key}>
                    <td>{i + 1}</td>
                    <td><b>{l.itemName}</b>
                      <div className="faint" style={{ whiteSpace: "pre-line" }}>契約種別：準委任 ／ 帰属先：発注者 ／ 支払方法：固定額{"\n"}{l.spec}</div></td>
                    <td className="num">{l.quantity}</td><td className="num">{yen(l.unitPrice)}</td><td className="num">{yen(l.amount)}</td>
                  </tr>
                ))}
                <tr><td colSpan={4} className="num"><b>確定額 小計（税抜）</b></td><td className="num"><b>{yen(plan.subtotal)}</b></td></tr>
              </tbody>
            </table>
          </div>
          {plan.expenses.length > 0 && (
            <div className="tablewrap">
              <table className="compact">
                <thead><tr><th>No</th><th>費目（経費・税込）</th><th>発生日</th><th className="num">金額（税込）</th></tr></thead>
                <tbody>
                  {plan.expenses.map((e, i) => (
                    <tr key={i}><td>{i + 1}</td><td>交通費</td><td>{jaDate(e.date)}</td><td className="num">{yen(e.amount)}</td></tr>
                  ))}
                  <tr><td colSpan={3} className="num"><b>経費合計（税込）</b></td><td className="num"><b>{yen(plan.travelTotal)}</b></td></tr>
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-bd stack">
            {preview!.issues.length > 0 && (
              <div className="note warn">{preview!.issues.map((i) => <div key={i}>{i}</div>)}</div>
            )}
            <div className="faint">
              作るもの：条件明細（委託料）{plan.lines.length} 本{plan.travelTotal > 0 ? "・条件明細（実費：交通費）1 本" : ""}・発注書の下書き 1 枚。
              役務完了報告はこの発注書の明細の並び（同じイベントは 1 行）でまとめて 1 枚。
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy || readOnly || preview!.issues.length > 0 || Boolean(created)}
                      title={readOnly ? "いまは読み取り専用です" : undefined} onClick={() => void create()}>
                {busy ? "作っています…" : reviseDocumentId ? "訂正版の下書きを作る" : "発注書の下書きを作る"}
              </button>
              {created && (
                <>
                  <span className="note ok" style={{ padding: "4px 10px" }}>
                    {created.supersedesId ? "訂正版の下書きができました" : "下書きができました"}（条件明細 {created.conditions.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}{created.matterCreated ? "・案件を新しく作成" : ""}）
                  </span>
                  <button className="btn" onClick={() => onOpenDocument(created.documentId)}>下書きを開く（決定・送る）</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showMaster && <StoreMaster stores={stores} onChanged={() => void reloadStores()} />}
    </section>
  );
}

/** 店舗マスタ：店舗・担当取引先・既定額、人ごとの基本契約の扱い。 */
function StoreMaster({ stores, onChanged }: { stores: Store[]; onChanged: () => void }) {
  const readOnly = useReadOnly();
  const [selected, setSelected] = useState<number | "new" | null>(stores[0]?.id ?? "new");
  const [error, setError] = useState<string | null>(null);
  const store = typeof selected === "number" ? stores.find((s) => s.id === selected) ?? null : null;
  const [form, setForm] = useState({ name: "", shortName: "", active: true, sortOrder: "0" });
  useEffect(() => {
    setForm(store ? { name: store.name, shortName: store.shortName, active: store.active, sortOrder: String(store.sortOrder) }
      : { name: "", shortName: "", active: true, sortOrder: "0" });
  }, [selected, store?.name, store?.shortName, store?.active]);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError((e as ApiError).message); }
  };
  const saveStore = () => run(async () => {
    const payload = { name: form.name, shortName: form.shortName, active: form.active, sortOrder: Number(form.sortOrder) || 0 };
    if (store) await api.put(`/store-events/stores/${store.id}`, payload);
    else { const r = await api.post<{ id: number }>("/store-events/stores", payload); setSelected(r.id); }
  });
  const [adding, setAdding] = useState<{ partyId: string; fee: string; travel: string }>({ partyId: "", fee: "", travel: "" });

  return (
    <div className="panel">
      <div className="panel-hd"><h2>店舗と担当取引先</h2>
        <span className="faint">作成画面では、ここで店舗の担当に載せた取引先だけが選べます。既定額は初期値で、毎回直せます</span></div>
      <div className="panel-bd stack">
        {error && <div className="note warn">{error}</div>}
        <div className="row">
          {stores.map((s) => (
            <button key={s.id} type="button" className="chip" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>
              {s.name}{!s.active ? "（休止）" : ""} <span className="faint">{s.judges.length} 名</span>
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={selected === "new"} onClick={() => setSelected("new")}>＋ 店舗を足す</button>
        </div>

        <div className="stack" style={{ gap: 6, maxWidth: 640 }}>
          <label className="field"><span>店舗名</span>
            <input value={form.name} placeholder="ホビーステーション大宮店（発注書の「場所」に出る）"
                   onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>略称</span>
            <input value={form.shortName} placeholder="HBST大宮（品目名「審判業務（日付‗略称）」に出る）"
                   onChange={(e) => setForm({ ...form, shortName: e.target.value })} /></label>
          <label className="field"><span>並び順</span>
            <input value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} /></label>
          <label className="field"><span>使う</span>
            <span className="row"><input type="checkbox" checked={form.active} onChange={() => setForm({ ...form, active: !form.active })} />
              <span className="faint">外すと作成画面に出ません（休止）</span></span></label>
          <div className="row">
            <button className="btn primary" disabled={readOnly} onClick={() => void saveStore()}>{store ? "店舗を保存" : "店舗を足す"}</button>
            {store && (
              <button className="btn danger" disabled={readOnly}
                      onClick={() => { if (confirm(`${store.name} を消します。担当の登録も消えます（作った発注書は残ります）`)) void run(async () => { await api.del(`/store-events/stores/${store.id}`); setSelected(null); }); }}>
                店舗を消す
              </button>
            )}
          </div>
        </div>

        {store && (
          <>
            <b>担当取引先（{store.name}）</b>
            <div className="tablewrap">
              <table className="compact">
                <thead><tr><th>取引先</th><th className="num">既定 委託料（税込）</th><th className="num">既定 交通費（税込）</th>
                  <th>基本契約（この人の設定・店舗共通）</th><th>登録番号 ／ 源泉</th><th /></tr></thead>
                <tbody>
                  {store.judges.map((j) => (
                    <JudgeRow key={j.partyId} storeId={store.id} judge={j} readOnly={readOnly} run={run} />
                  ))}
                  {!store.judges.length && <tr><td colSpan={6} className="faint">まだいません</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="row">
              <div style={{ minWidth: 260 }}>
                <SearchSelect value={adding.partyId} search={searchParties} placeholder="取引先を探す（名前・コード）"
                              onChange={(v) => setAdding({ ...adding, partyId: v })} />
              </div>
              <input className="inline-input" style={{ width: 110 }} placeholder="委託料（税込）" value={adding.fee}
                     onChange={(e) => setAdding({ ...adding, fee: e.target.value })} />
              <input className="inline-input" style={{ width: 110 }} placeholder="交通費（税込）" value={adding.travel}
                     onChange={(e) => setAdding({ ...adding, travel: e.target.value })} />
              <button className="btn" disabled={readOnly || !adding.partyId} onClick={() => void run(async () => {
                await api.put(`/store-events/stores/${store.id}/judges/${adding.partyId}`,
                  { defaultFeeIncTax: adding.fee ? numOf(adding.fee) : null, defaultTravelIncTax: adding.travel ? numOf(adding.travel) : null });
                setAdding({ partyId: "", fee: "", travel: "" });
              })}>担当に足す</button>
            </div>
            <div className="faint">住所・振込先・登録番号・メールは取引先マスタのものを使います。1 人が複数の店舗を担当しても構いません。</div>
          </>
        )}
      </div>
    </div>
  );
}

function JudgeRow({ storeId, judge, readOnly, run }: {
  storeId: number; judge: Judge; readOnly: boolean; run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [fee, setFee] = useState(judge.defaultFeeIncTax ? String(judge.defaultFeeIncTax) : "");
  const [travel, setTravel] = useState(judge.defaultTravelIncTax ? String(judge.defaultTravelIncTax) : "");
  const [candidates, setCandidates] = useState<AgreementRef[] | null>(null);
  const mode = judge.agreementMode === "fixed" ? String(judge.agreementId) : judge.agreementMode;
  const dirty = fee !== (judge.defaultFeeIncTax ? String(judge.defaultFeeIncTax) : "")
    || travel !== (judge.defaultTravelIncTax ? String(judge.defaultTravelIncTax) : "");
  const loadCandidates = () => {
    if (candidates) return;
    api.get<{ agreements: AgreementRef[] }>(`/store-events/judges/${judge.partyId}/agreements`)
      .then((r) => setCandidates(r.agreements)).catch(() => setCandidates([]));
  };
  const setMode = (v: string) => void run(() => api.put(`/store-events/judges/${judge.partyId}/settings`,
    v === "auto" || v === "none" ? { agreementMode: v } : { agreementMode: "fixed", agreementId: Number(v) }));
  return (
    <tr>
      <td><b>{judge.name}</b> <span className="faint">{judge.partyCode ?? ""}</span></td>
      <td className="num"><input className="inline-input" style={{ width: 100, textAlign: "right" }} value={fee} onChange={(e) => setFee(e.target.value)} /></td>
      <td className="num"><input className="inline-input" style={{ width: 90, textAlign: "right" }} value={travel} placeholder="なし" onChange={(e) => setTravel(e.target.value)} /></td>
      <td>
        <select className="inline-input" style={{ width: 260 }} value={mode} disabled={readOnly}
                onFocus={loadCandidates} onMouseDown={loadCandidates} onChange={(e) => setMode(e.target.value)}>
          <option value="auto">{MODE_LABEL.auto}</option>
          <option value="none">{MODE_LABEL.none}</option>
          {judge.agreementMode === "fixed" && !candidates?.some((a) => a.id === judge.agreementId) && (
            <option value={String(judge.agreementId)}>この契約：{judge.agreementNo ?? `#${judge.agreementId}`}</option>
          )}
          {(candidates ?? []).map((a) => (
            <option key={a.id} value={String(a.id)}>この契約：{a.agreementNo ?? `#${a.id}`} {a.title}{a.status !== "executed" ? `（${a.status}）` : ""}</option>
          ))}
        </select>
      </td>
      <td className="faint">{judge.invoiceNo ?? "登録番号なし"} ／ 源泉 {judge.withholding ? "対象" : "なし"}</td>
      <td>
        <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <button className="btn btn-sm" disabled={readOnly || !dirty} onClick={() => void run(() =>
            api.put(`/store-events/stores/${storeId}/judges/${judge.partyId}`,
              { defaultFeeIncTax: fee ? numOf(fee) : null, defaultTravelIncTax: travel ? numOf(travel) : null }))}>保存</button>
          <button className="btn btn-sm" disabled={readOnly} onClick={() => void run(() =>
            api.del(`/store-events/stores/${storeId}/judges/${judge.partyId}`))}>外す</button>
        </span>
      </td>
    </tr>
  );
}
