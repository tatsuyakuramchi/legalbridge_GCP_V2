import { useEffect, useRef, useState } from "react";
import { api, ApiError, money } from "./api.js";

/**
 * 条件の実績（明細の数値）。
 *
 * 記録できるのが計算書の作成だけで、製造数も検収も納品も画面から入れられず、
 * 間違って入った数値を直す手段も無かった。
 *
 * 消さずに取り消す。実績は「何がいくつあったか」の記録なので、消すと
 * あとから突き合わせられない。取り消しは理由を必ず添える。
 */

interface EventRow {
  id: number; eventType: string; occurredOn: string | null; period: string | null;
  quantity: number | null; sampleQuantity: number | null;
  grossAmount: number | null; deductions: number; amount: number;
  status: string; note: string | null;
  documentId: number | null; documentNo: string | null;
  createdAt: string; createdBy: string;
}
interface TypeOption { value: string; label: string }
interface TemplateOption { templateKey: string; label: string; category: string | null }
interface StatementPreview {
  fee: { gross_ex_tax: number; mg_topup_this_time: number; ag_offset_this_time: number;
         actual_ex_tax: number; tax_amount: number; formula_breakdown: string };
  payment: { withholdingEnabled: boolean; withholdingTax: number; netTransfer: number };
  period: string; occurredOn: string | null;
  reported: { salesInput?: number | null; quantity?: number | null };
  events: Array<{ eventId: number; eventType: string; occurredOn: string | null; basis: number; share: number }>;
  appliedVersion: { conditionNo: string | null; switched: boolean } | null;
}
interface PreviewResponse {
  templateLabel: string;
  /** 条件と実績から決まらない項目。人が入れないと発行できない。 */
  missing: Array<{ name: string; label: string }>;
  derived: string[];
}

export function ConditionEvents(
  { conditionId, currency, editable, matterId, pricingModel, reloadKey, onCompose, onChanged }:
  { conditionId: number; currency: string; editable: boolean;
    matterId?: number | null; reloadKey?: number;
    /** 計算方式。料率・単価×数量なら実績の束から計算書を出せる。 */
    pricingModel?: string;
    /** 文書の画面へ、この条件と実績を選んだ状態で移る。 */
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null) => void;
    onChanged: () => void }
) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  // 実績から文書（検収書など）を作るときの状態。行を選んでテンプレートを決める。
  const [issuing, setIssuing] = useState<EventRow | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  // ひな形が要求する項目のうち、条件と実績から決まらないもの。
  // これを先に見せないと、発行を押してから8項目足りないと言われる。
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});
  // 実績と同じ理由。フォームは表の上に開くので、下の行から押すと画面の外に出る。
  const issueForm = useRef<HTMLDivElement>(null);
  /**
   * 選んだ実績。複数選んで1枚の書類にする。
   * 料率の条件なら計算書（根拠を合算して1回計算、明細は実績ごとに按分）、
   * 定額なら検収書・納品書（実績が明細の行になる）。
   */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const royalty = pricingModel === "revenue_rate" || pricingModel === "unit_rate";
  // 計算書のフォーム。選んだ実績を束にして出す。
  const [stmtOpen, setStmtOpen] = useState(false);
  const [stmtTemplate, setStmtTemplate] = useState("");
  const [stmtPeriod, setStmtPeriod] = useState("");
  const [stmtPreview, setStmtPreview] = useState<StatementPreview | null>(null);
  const [stmtBusy, setStmtBusy] = useState(false);
  const [stmtDone, setStmtDone] = useState<string | null>(null);

  const pickedIds = [...picked].filter((id) => rows.some((r) => r.id === id && r.status === "active" && !r.documentId));

  // 束を変えたら試算し直す。保存しない。
  useEffect(() => {
    if (!stmtOpen || !pickedIds.length) { setStmtPreview(null); return; }
    let live = true;
    api.post<StatementPreview>(`/conditions/${conditionId}/royalty-preview`,
      { eventIds: pickedIds, period: stmtPeriod.trim() || null })
      .then((r) => { if (live) { setStmtPreview(r); setError(null); } })
      .catch((e: ApiError) => { if (live) { setStmtPreview(null); setError(e.message); } });
    return () => { live = false; };
  }, [stmtOpen, pickedIds.join(","), stmtPeriod]);

  async function issueStatement() {
    if (!stmtTemplate || !pickedIds.length) return;
    setStmtBusy(true); setError(null);
    try {
      const r = await api.post<{ document: { documentNo: string } }>(
        `/conditions/${conditionId}/statement-documents`,
        { templateKey: stmtTemplate, eventIds: pickedIds, period: stmtPeriod.trim() || null,
          matterId: matterId ?? null });
      setStmtDone(r.document.documentNo);
      setStmtOpen(false); setPicked(new Set()); setStmtPreview(null);
      load(); onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setStmtBusy(false); }
  }

  function load() {
    api.get<{ events: EventRow[]; types: TypeOption[] }>(`/conditions/${conditionId}/events`)
      .then((r) => { setRows(r.events); setTypes(r.types); })
      .catch((e: ApiError) => setError(e.message));
  }
  // 引き直しでは結果を消さない。消すと、発行した文書番号が出た直後に
  // 引き直しが走って消え、発行できたのかどうか分からなくなる。
  useEffect(() => { load(); setError(null); }, [conditionId, reloadKey]);
  useEffect(() => {
    setAdding(false); setIssuing(null); setIssued(null);
    setPreview(null); setManual({});
  }, [conditionId]);

  // テンプレートは文書を作るときにしか要らないので、開くまで取りに行かない。
  useEffect(() => {
    if ((!issuing && !stmtOpen) || templates.length) return;
    api.get<{ templates: TemplateOption[] }>("/document-templates")
      .then((r) => {
        setTemplates(r.templates); setTemplateKey(r.templates[0]?.templateKey ?? "");
        setStmtTemplate(r.templates.find((t) => t.templateKey === "royalty_statement")?.templateKey
          ?? r.templates[0]?.templateKey ?? "");
      })
      .catch((e: ApiError) => setError(e.message));
  }, [issuing, stmtOpen]);

  useEffect(() => {
    if (issuing) issueForm.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [issuing]);

  // ひな形を選んだ時点で、何が足りないかを出す。押してから言われるのでは遅い。
  useEffect(() => {
    if (!issuing || !templateKey) { setPreview(null); return; }
    setPreview(null); setManual({});
    api.post<PreviewResponse>("/documents/preview", {
      templateKey, conditionIds: [conditionId], manualInputs: {}
    }).then(setPreview).catch((e: ApiError) => setError(e.message));
  }, [issuing, templateKey, conditionId]);

  /**
   * 実績から文書を作る。下書き→発行→実績への紐付けをサーバ側で1本にしてある。
   * 紐付けが済んで初めて「この検収書は第N回の分」が読めるようになる。
   */
  const remaining = (preview?.missing ?? [])
    .filter((m) => !String(manual[m.name] ?? "").trim()).length;
  // プレビューが返るまでは押させない。押してから8項目足りないと言われるより、
  // 先に何が要るかを見せる。
  const filled = preview !== null && remaining === 0;

  async function issueDocument() {
    if (!issuing || !templateKey) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ document: { documentNo: string } }>(
        `/conditions/${conditionId}/event-documents`,
        { templateKey, eventIds: [issuing.id], matterId: matterId ?? null,
          manualInputs: manual });
      setIssued(r.document.documentNo);
      setIssuing(null); setPreview(null); setManual({});
      load(); onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const label = (value: string) => types.find((t) => t.value === value)?.label ?? value;
  const set = (k: string, value: string) => setV({ ...v, [k]: value });
  // 入力欄は「足す」を押すまで空。未定義のまま .trim() を呼ぶと画面ごと落ちる。
  const f = (k: string) => v[k] ?? "";

  function start() {
    setV({ eventType: "sales", occurredOn: new Date().toISOString().slice(0, 10),
           period: "", quantity: "", grossAmount: "", deductions: "", amount: "", note: "" });
    setAdding(true); setError(null);
  }

  async function add() {
    setBusy(true); setError(null);
    try {
      const gross = f("grossAmount").trim();
      await api.post(`/conditions/${conditionId}/events`, {
        eventType: f("eventType"),
        occurredOn: f("occurredOn"),
        period: f("period").trim() || null,
        quantity: f("quantity").trim() ? Number(f("quantity")) : null,
        grossAmount: gross ? Math.round(Number(gross)) : null,
        deductions: f("deductions").trim() ? Math.round(Number(f("deductions"))) : 0,
        amount: Math.round(Number(f("amount") || 0)),
        note: f("note").trim() || null
      });
      setAdding(false); load(); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function voidEvent(row: EventRow) {
    const reason = prompt(`実績 #${row.id}（${money(row.amount, currency)}）を取り消します。理由を書いてください。`);
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/conditions/${conditionId}/events/${row.id}/void`, { reason: reason.trim() });
      load(); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  // 総額と控除を入れたら実額は決まる。入れ違いを起こさないよう先に見せる。
  const gross = Number(f("grossAmount") || 0);
  const deductions = Number(f("deductions") || 0);
  const derived = f("grossAmount").trim() ? gross - deductions : null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>実績</h2>
        <span className="faint">
          {rows.filter((r) => r.status === "active").length} 件
          {rows.some((r) => r.status === "void") &&
            `　（取消 ${rows.filter((r) => r.status === "void").length} 件を含む）`}
        </span>
        {editable && !adding && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={start}>実績を足す</button>
        )}
      </div>

      {adding && (
        <div className="panel-bd stack" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="form-grid">
            <label className="field">
              <span>種類</span>
              <select value={f("eventType")} onChange={(e) => set("eventType", e.target.value)}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>発生日</span>
              <input type="date" value={f("occurredOn")} onChange={(e) => set("occurredOn", e.target.value)} />
            </label>
            <label className="field">
              <span>対象期間</span>
              <input value={f("period")} placeholder="2026Q2 / 2026-06"
                     onChange={(e) => set("period", e.target.value)} />
            </label>
            <label className="field">
              <span>数量</span>
              <input inputMode="numeric" value={f("quantity")} onChange={(e) => set("quantity", e.target.value)} />
            </label>
            <label className="field">
              <span>{royalty ? "報告売上・受領額（円）" : "総額（任意）"}</span>
              <input inputMode="numeric" value={f("grossAmount")}
                     onChange={(e) => set("grossAmount", e.target.value)} />
              <small className="faint">
                {royalty
                  ? "料率の条件では、ここが計算書の根拠になる。外貨は当社着金時のレートで円に直した額を入れる。ロイヤリティの額は計算書で計算する"
                  : "控除前。入れたら実額と合っている必要があります"}
              </small>
            </label>
            <label className="field">
              <span>控除</span>
              <input inputMode="numeric" value={f("deductions")}
                     onChange={(e) => set("deductions", e.target.value)} />
            </label>
            <label className="field">
              <span>実額</span>
              <input inputMode="numeric" value={f("amount")} onChange={(e) => set("amount", e.target.value)} />
              {derived !== null && (
                <small className={String(derived) === f("amount").trim() ? "faint" : "danger"}>
                  総額 − 控除 = {money(derived, currency)}
                </small>
              )}
            </label>
            <label className="field wide">
              <span>備考</span>
              <input value={f("note")} onChange={(e) => set("note", e.target.value)} />
            </label>
          </div>
          {error && <div className="alert">{error}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || !f("amount").trim()}
                    onClick={() => void add()}>{busy ? "保存中…" : "記録する"}</button>
            <button className="btn" disabled={busy} onClick={() => setAdding(false)}>やめる</button>
          </div>
        </div>
      )}

      {!adding && error && <div className="panel-bd"><div className="alert">{error}</div></div>}

      {issued && (
        <div className="panel-bd">
          <div className="note ok">
            文書 <span className="code">{issued}</span> を決定し、実績に結び付けました。
            中身の確認と PDF は「文書」の画面から開けます。
          </div>
        </div>
      )}

      {issuing && (
        <div ref={issueForm} className="panel-bd stack"
             style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row">
            <b>{label(issuing.eventType)}の実績から文書を作る</b>
            <span className="faint">
              {issuing.occurredOn ?? "—"}　{money(issuing.amount, currency)}
            </span>
          </div>
          <label className="field">
            <span>ひな形</span>
            <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              {templates.map((t) => (
                <option key={t.templateKey} value={t.templateKey}>
                  {t.category ? `${t.category}／${t.label}` : t.label}
                </option>
              ))}
            </select>
            <span className="faint">検収なら検収書、納品なら納品書</span>
          </label>

          {preview && preview.missing.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="note warn">
                このひな形は、条件と実績から決まらない項目を {preview.missing.length} つ要求します。
                埋めないと決定できません。
              </div>
              <div className="form-grid">
                {preview.missing.map((m) => (
                  <label key={m.name} className="field">
                    <span>{m.label}</span>
                    <input value={manual[m.name] ?? ""}
                           onChange={(e) =>
                             setManual((prev) => ({ ...prev, [m.name]: e.target.value }))} />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="row">
            <button className="btn primary btn-sm" disabled={busy || !templateKey || !filled}
                    onClick={() => void issueDocument()}>作って決定する</button>
            <button className="btn btn-sm" onClick={() => { setIssuing(null); setPreview(null); }}>
              やめる
            </button>
            <span className="faint">
              {preview
                ? filled
                  ? `${preview.derived.length}項目を条件から自動で埋めます。決定すると番号が振られ、あとから中身は変えられません`
                  : `未入力 ${remaining} 件`
                : "ひな形の中身を確かめています…"}
            </span>
          </div>
        </div>
      )}

      {stmtDone && (
        <div className="panel-bd">
          <div className="note ok">
            計算書 <span className="code">{stmtDone}</span> を決定し、選んだ実績に結び付けました。
            金額は決定のときに計算し直しています。
          </div>
        </div>
      )}

      {/* 選んだ実績から書類を作る。料率なら計算書、定額なら検収書・納品書。 */}
      {editable && rows.some((r) => r.status === "active" && !r.documentId) && (
        <div className="panel-bd row" style={{ borderBottom: "1px solid var(--line)", gap: 8 }}>
          <span className="faint">
            {pickedIds.length ? `${pickedIds.length} 件を選択中` : "左の四角で実績を選ぶと、まとめて1枚の書類にできます"}
          </span>
          {royalty ? (
            <button className="btn btn-sm primary" disabled={!pickedIds.length || stmtOpen}
                    onClick={() => { setStmtOpen(true); setStmtDone(null); }}>
              選んだ {pickedIds.length} 件で計算書を作る
            </button>
          ) : (
            <button className="btn btn-sm primary" disabled={!pickedIds.length}
                    onClick={() => onCompose?.([conditionId], pickedIds, matterId ?? null)}>
              選んだ {pickedIds.length} 件で文書を作る
            </button>
          )}
          {pickedIds.length > 0 && (
            <button className="linky" onClick={() => setPicked(new Set())}>選択を外す</button>
          )}
        </div>
      )}

      {stmtOpen && (
        <div className="panel-bd stack" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row">
            <b>選んだ実績の束から計算書を作る</b>
            <span className="faint">根拠（報告売上・数量）を合算して1回だけ計算し、明細は実績1件が1行。額は根拠の比で按分</span>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>ひな形</span>
              <select value={stmtTemplate} onChange={(e) => setStmtTemplate(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.templateKey} value={t.templateKey}>
                    {t.category ? `${t.category}／${t.label}` : t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>対象期間</span>
              <input value={stmtPeriod} placeholder={stmtPreview?.period ?? "実績から導く"}
                     onChange={(e) => setStmtPeriod(e.target.value)} />
              <small className="faint">空なら実績の期間（揃っていなければ最古〜最新）</small>
            </label>
          </div>
          {stmtPreview && (
            <table>
              <tbody>
                {stmtPreview.events.map((e) => (
                  <tr key={e.eventId}>
                    <td className="code">{e.occurredOn ?? "—"}</td>
                    <td>{label(e.eventType)}</td>
                    <td className="num">{money(e.basis, currency)}</td>
                    <td className="faint">{Math.round(e.share * 1000) / 10}%</td>
                  </tr>
                ))}
                <tr><td><b>根拠の合計</b></td><td></td>
                    <td className="num"><b>{money(stmtPreview.reported.salesInput ?? stmtPreview.reported.quantity ?? 0, currency)}</b></td>
                    <td className="faint">期間 {stmtPreview.period}{stmtPreview.appliedVersion?.switched ? `／${stmtPreview.appliedVersion.conditionNo} の版で計算` : ""}</td></tr>
                <tr><td>グロス</td><td></td><td className="num">{money(stmtPreview.fee.gross_ex_tax, currency)}</td>
                    <td className="faint">{stmtPreview.fee.formula_breakdown}</td></tr>
                <tr><td>MG 上乗せ／AG 相殺</td><td></td>
                    <td className="num">{money(stmtPreview.fee.mg_topup_this_time, currency)}／−{money(stmtPreview.fee.ag_offset_this_time, currency)}</td>
                    <td className="faint">明細には割らず、合計にだけ効く</td></tr>
                <tr><td><b>税抜実額</b></td><td></td><td className="num"><b>{money(stmtPreview.fee.actual_ex_tax, currency)}</b></td>
                    <td className="faint">消費税 {money(stmtPreview.fee.tax_amount, currency)}
                      {stmtPreview.payment.withholdingEnabled ? `／源泉 ${money(stmtPreview.payment.withholdingTax, currency)}` : ""}</td></tr>
              </tbody>
            </table>
          )}
          <div className="row">
            <button className="btn primary btn-sm" disabled={stmtBusy || !stmtPreview || !stmtTemplate}
                    onClick={() => void issueStatement()}>
              {stmtBusy ? "決定しています…" : "計算書を決定する"}
            </button>
            <button className="btn btn-sm" onClick={() => { setStmtOpen(false); setStmtPreview(null); }}>やめる</button>
            <span className="faint">決定すると番号が振られ、選んだ実績はこの計算書に結ばれます</span>
          </div>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead><tr>
            <th></th><th>発生日</th><th>種類</th><th>期間</th><th className="num">数量</th>
            <th className="num">実額</th><th>出どころ</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const voided = row.status === "void";
              return (
                <tr key={row.id} style={voided ? { opacity: 0.6 } : undefined}>
                  <td>
                    {editable && !voided && !row.documentId && (
                      <input type="checkbox" checked={picked.has(row.id)} aria-label={`実績 ${row.occurredOn ?? row.id} を選ぶ`}
                             onChange={(e) => setPicked((prev) => {
                               const next = new Set(prev);
                               if (e.target.checked) next.add(row.id); else next.delete(row.id);
                               return next;
                             })} />
                    )}
                  </td>
                  <td className="code">{row.occurredOn ?? "—"}</td>
                  <td>{label(row.eventType)}
                    {voided && <span className="tag out" style={{ marginLeft: 5 }}>取消</span>}</td>
                  <td className="faint">{row.period ?? "—"}</td>
                  <td className="num">{row.quantity ?? "—"}</td>
                  <td className="num" style={voided ? { textDecoration: "line-through" } : undefined}>
                    {money(row.amount, currency)}
                    {row.deductions ? <div className="faint">控除 {money(row.deductions, currency)}</div> : null}
                  </td>
                  <td className="faint">
                    {row.documentNo
                      ? <>文書 <span className="code">{row.documentNo}</span></>
                      : row.createdBy}
                  </td>
                  <td>
                    {editable && !voided && !row.documentId && (
                      <button className="btn btn-sm" disabled={busy}
                              onClick={() => void voidEvent(row)}>取り消す</button>
                    )}
                    {editable && !voided && !row.documentId && (
                      <button className="btn btn-sm" style={{ marginLeft: 5, whiteSpace: "nowrap" }}
                              onClick={() => {
                                // 作成のフォームは「文書」画面に1本化してある。
                                // ここからはその画面へ、条件と実績を選んだ状態で移る。
                                if (onCompose) onCompose([conditionId], [row.id], matterId ?? null);
                                else { setIssuing(row); setIssued(null); }
                              }}>
                        文書を作る
                      </button>
                    )}
                    {row.documentId && !voided && (
                      <span className="faint" style={{ whiteSpace: "nowrap" }}>文書あり</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={8} className="faint">
                実績がありません。製造数・売上・検収などをここに記録します。
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.some((r) => r.note) && (
        <div className="panel-bd">
          {rows.filter((r) => r.note).map((r) => (
            <div key={r.id} className="faint">#{r.id}：{r.note}</div>
          ))}
        </div>
      )}
    </div>
  );
}
