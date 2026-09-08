import { useEffect, useMemo, useState } from "react";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag } from "./labels.js";
import type { ConditionSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";

interface TemplateRow {
  id: number; templateKey: string; label: string; category: string | null; numberPrefix: string | null;
}
interface DocumentRow {
  id: number; documentNo: string | null; status: string; templateLabel: string | null;
  title: string | null; counterparty: string | null; conditionCount: number;
  issuedAt: string | null; storageUrl: string | null;
  /** 外で作られた文書。本文もひな形も無いので、組み直しも作り直しもできない。 */
  imported: boolean;
}
interface Integrations {
  drive: { documents: boolean; matterFolders: boolean };
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}
interface PreviewResponse {
  html: string; templateLabel: string;
  missing: Array<{ name: string; label: string }>; derived: string[];
  values: Record<string, unknown>;
  /** 入力欄の横に出す候補。押すとその値が入る。 */
  candidates: Candidate[];
}
interface Candidate { label: string; value: string; source: string; kind: "date" | "amount" | "text" }
interface EventRow {
  id: number; eventType: string; occurredOn: string | null; period: string | null;
  amount: number; status: string;
}

/**
 * 入力欄の名前から、その欄に合う候補の種類を当てる。
 * 日付の欄に金額の候補を並べても選べない。当たらなければ全部出す。
 */
function kindFor(name: string, label: string): Candidate["kind"] | null {
  const s = `${name} ${label}`;
  if (/日|期日|年月日/.test(s) && !/氏名|名前/.test(label)) return "date";
  if (/額|金額|価格|料金|税/.test(s)) return "amount";
  if (/名|者|部署|内容|件名|住所|番号/.test(s)) return "text";
  return null;
}

export function DocumentsWorkspace(
  { start }: { start?: { conditionId: number; eventIds: number[] } } = {}
) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [conditions, setConditions] = useState<ConditionSummary[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  // 条件の画面から来たときは、その条件と実績を選んだ状態で開く。
  const [picked, setPicked] = useState<number[]>(start ? [start.conditionId] : []);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [stored, setStored] = useState<string | null>(null);
  // 呼び出した条件の実績。検収書はここの日付と金額を候補に出す。
  const [events, setEvents] = useState<EventRow[]>([]);
  const [pickedEvents, setPickedEvents] = useState<number[]>(start?.eventIds ?? []);
  const [condSearch, setCondSearch] = useState("");
  // 候補から選んだ欄。手で打った欄だけを「前回の値」として覚える。
  const [pickedFields, setPickedFields] = useState<Set<string>>(new Set());
  // 候補を開いている欄。文字の欄は候補が多いので、押したときだけ出す。
  const [opened, setOpened] = useState<Set<string>>(new Set());
  // 候補に無い人を名前で探して引く。別部署の検収者や、相手先の別の担当者。
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [quoteQ, setQuoteQ] = useState("");
  const [quoteHits, setQuoteHits] = useState<Candidate[]>([]);
  const quoteSearch = useDebounced(quoteQ, 300);

  useEffect(() => { void reload(); }, [search]);
  async function reload() {
    try {
      const [t, d, c, i] = await Promise.all([
        api.get<{ templates: TemplateRow[] }>("/document-templates"),
        api.get<{ documents: DocumentRow[] }>(
          `/documents${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`),
        api.get<{ conditions: ConditionSummary[] }>("/conditions"),
        api.get<Integrations>("/integrations")
      ]);
      setTemplates(t.templates);
      setDocuments(d.documents);
      setConditions(c.conditions);
      setIntegrations(i);
      if (!templateKey && t.templates[0]) setTemplateKey(t.templates[0].templateKey);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  // 条件を1件だけ選んでいるときは、その実績を呼び出せる。
  useEffect(() => {
    if (picked.length !== 1) { setEvents([]); setPickedEvents([]); return; }
    // 条件の画面から実績を指定して来たときは、その選択を消さない。
    api.get<{ events: EventRow[] }>(`/conditions/${picked[0]}/events`)
      .then((r) => setEvents(r.events.filter((e) => e.status === "active")))
      .catch(() => setEvents([]));
  }, [picked.join(",")]);

  const body = useMemo(() => ({
    templateKey, conditionIds: picked, eventIds: pickedEvents, manualInputs: manual
  }), [templateKey, picked, pickedEvents, manual]);

  // 打つたびに問い合わせない。少し待ってからプレビューを取り直す。
  const manualJson = useDebounced(JSON.stringify(manual), 600);

  useEffect(() => {
    if (!quoteFor || !quoteSearch.trim()) { setQuoteHits([]); return; }
    api.get<{ candidates: Candidate[] }>(
      `/quote-sources?q=${encodeURIComponent(quoteSearch.trim())}`)
      .then((r) => setQuoteHits(r.candidates)).catch(() => setQuoteHits([]));
  }, [quoteFor, quoteSearch]);

  // ひな形を変えたら、前回そのひな形で入れた値を読み込む。
  // 検収者部署・氏名のように毎回同じものを打ち直さずに済む。
  useEffect(() => {
    if (!templateKey) return;
    setManual({}); setPickedFields(new Set());
    api.get<{ defaults: Record<string, string> }>(`/document-defaults/${templateKey}`)
      .then((r) => setManual(r.defaults ?? {}))
      .catch(() => undefined);
  }, [templateKey]);

  // ひな形か条件を変えたら、何が要るかを取り直す。押してから足りないと
  // 言われるのでは遅い。
  useEffect(() => {
    if (!templateKey) { setPreview(null); return; }
    setPreview(null);
    api.post<PreviewResponse>("/documents/preview",
      { templateKey, conditionIds: picked, eventIds: pickedEvents,
        manualInputs: JSON.parse(manualJson) })
      .then(setPreview).catch(() => undefined);
  }, [templateKey, picked.join(","), pickedEvents.join(","), manualJson]);

  async function runPreview() {
    setError(null); setIssued(null); setBusy(true);
    try {
      setPreview(await api.post<PreviewResponse>("/documents/preview", body));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // 下書きを作ってから発行する。採番は発行時にだけ進む。
  async function issue() {
    setError(null); setBusy(true);
    try {
      // 下書き→発行→実績への紐づけをサーバ側で1本にしてある。
      // 途中で落ちたときは下書きごと捨てられる。
      const result = await api.post<{ document: { documentNo: string } }>(
        "/documents/compose", body);
      setIssued(result.document.documentNo);
      // 手で打った項目だけ覚える。日付と金額は毎回変わるので覚えない
      // （前回の日付が入ったまま気づかず発行してしまう）。
      const keep: Record<string, string> = {};
      for (const m of preview?.missing ?? []) {
        const kind = kindFor(m.name, m.label);
        const value = String(manual[m.name] ?? "").trim();
        if (value && !pickedFields.has(m.name) && kind !== "date" && kind !== "amount") {
          keep[m.name] = value;
        }
      }
      if (Object.keys(keep).length) {
        await api.put(`/document-defaults/${templateKey}`, { values: keep }).catch(() => undefined);
      }
      setPreview(null);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // メール送付。止まった場合は理由をそのまま出す（黙って送らないのが一番まずい）。
  async function send(id: number) {
    const recipient = window.prompt("送付先のメールアドレス");
    if (!recipient) return;
    setError(null); setStored(null);
    try {
      const result = await api.post<{ sent: boolean; duplicated?: boolean; gate: { reasons: string[] } }>(
        `/documents/${id}/send`,
        { recipient, body: "文書をお送りします。ご確認ください。", attachPdf: true });
      setStored(result.sent ? `${recipient} へ送付しました`
        : result.duplicated ? "同じ内容をすでに送付済みです"
        : `送付しませんでした：${result.gate.reasons.join("／")}`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  // Drive へ保存する。既存ファイルがあれば中身だけ差し替わり、リンクは変わらない。
  /**
   * 無効化。理由を必ず聞く。行は消えず、発行した記録は残る。
   * 外に出したファイルは取り消せないので、そこも伝える。
   */
  async function voidDocument(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} を無効にします。理由を書いてください。\n` +
      "記録は残ります。すでに送付・保存したファイルは取り消せません。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/documents/${id}/void`, { reason });
      setIssued(`${no ?? id} を無効にしました`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** 再発行。元を差し替え済みにして、条件を引き継いだ下書きを作る。 */
  async function reissue(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} を作り直します。理由を書いてください。\n` +
      "元の文書は差し替え済みとして残り、条件を引き継いだ下書きができます。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${id}/reissue`, { reason });
      setIssued(`下書き #${r.id} を作りました。内容を確かめてから発行してください`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function store(id: number) {
    setError(null); setStored(null); setBusy(true);
    try {
      const result = await api.post<{ storageUrl: string; mode: string }>(`/documents/${id}/store`);
      setStored(result.mode === "unchanged" ? "すでに保存済みです"
        : result.mode === "replaced" ? "Drive のファイルを差し替えました（リンクは変わりません）"
        : "Drive に保存しました");
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // 未入力は画面の入力値で数える。プレビューは空で取っているので、
  // preview.missing はひな形が要求する項目の一覧であって、残数ではない。
  const remaining = (preview?.missing ?? [])
    .filter((m) => !String(manual[m.name] ?? "").trim()).length;
  const ready = Boolean(templateKey) && preview !== null && remaining === 0;

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>文書</h1>
        <p>文書は条件の出力物。相手先も件名も条件と合意から解決するので、入力するのはそこから決まらないものだけ。</p>
      </header>

      {error && <div className="alert">{error}</div>}
      {issued && <div className="note ok">発行しました：<b className="code">{issued}</b></div>}
      {stored && <div className="note ok">{stored}</div>}
      {integrations && !integrations.drive.documents && (
        <div className="note">Drive 保存は未設定です（<span className="code">GOOGLE_DRIVE_FOLDER_ID</span>）。文書の作成と発行はそのまま使えます。</div>
      )}

      <div className="stack">
        <div className="stack">
          <div className="panel">
            <div className="panel-hd"><h2>作成</h2></div>
            <div className="panel-bd stack">
              <label className="field">
                <span>テンプレート</span>
                <select value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPreview(null); }}>
                  {templates.map((t) => (
                    <option key={t.templateKey} value={t.templateKey}>{t.label}</option>
                  ))}
                </select>
              </label>

              <div className="stack" style={{ gap: 6 }}>
                <div className="row">
                  <span className="faint">この文書がどの取引のものか（条件を呼び出す）</span>
                  <span className="faint" style={{ marginLeft: "auto" }}>
                    {picked.length ? `${picked.length} 件を選択中` : "選ばなくても作れます"}
                  </span>
                </div>
                <input value={condSearch} placeholder="条件番号・名称・相手先で絞る"
                       onChange={(e) => setCondSearch(e.target.value)} />
                <div className="picker">
                  {conditions
                    .filter((c) => {
                      const q = condSearch.trim().toLowerCase();
                      if (!q) return picked.includes(c.id) || conditions.indexOf(c) < 20;
                      return [c.conditionNo, c.name, c.counterparty?.name]
                        .some((v) => String(v ?? "").toLowerCase().includes(q));
                    })
                    .map((c) => (
                    <label key={c.id} className="pick">
                      <input type="checkbox" checked={picked.includes(c.id)}
                             onChange={(e) => {
                               setPicked((prev) => e.target.checked
                                 ? [...prev, c.id] : prev.filter((id) => id !== c.id));
                             }} />
                      <span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span>
                      <span className="code">{c.conditionNo ?? `#${c.id}`}</span>
                      <span>{c.name}</span>
                      <span className="faint">{c.counterparty?.name ?? ""}</span>
                    </label>
                  ))}
                </div>
              </div>

              {events.length > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="faint">
                    どの実績についてか（検収書・納品書はここの日付と金額を候補に出します）
                  </div>
                  <div className="picker">
                    {events.map((e) => (
                      <label key={e.id} className="pick">
                        <input type="checkbox" checked={pickedEvents.includes(e.id)}
                               onChange={(ev) => setPickedEvents((prev) => ev.target.checked
                                 ? [...prev, e.id] : prev.filter((id) => id !== e.id))} />
                        <span className="code">{e.occurredOn ?? "—"}</span>
                        <span>{e.period ?? ""}</span>
                        <span className="num">{money(e.amount)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {preview && preview.missing.length > 0 && (
                <div className="stack">
                  <div className="row">
                    <span className="faint">このひな形が要求する項目</span>
                    <span className="faint" style={{ marginLeft: "auto" }}>
                      残り {preview.missing.filter((m) => !String(manual[m.name] ?? "").trim()).length} 件
                    </span>
                  </div>
                  <div className="form-grid">
                  {preview.missing.map((m) => {
                    const want = kindFor(m.name, m.label);
                    const fits = preview.candidates.filter((c) => !want || c.kind === want);
                    // 日付と金額は数が少なく、どれも当てはまりうるのでその場に出す。
                    // 文字は候補が多く、当てはまらないものばかり並ぶので畳んでおく。
                    const inline = want === "date" || want === "amount";
                    const open = inline || opened.has(m.name);
                    const put = (value: string) => {
                      setManual((prev) => ({ ...prev, [m.name]: value }));
                      setPickedFields((prev) => new Set(prev).add(m.name));
                    };
                    return (
                      <label key={m.name} className="field">
                        <span>{m.label}</span>
                        <input value={manual[m.name] ?? ""}
                               onChange={(e) => {
                                 setManual((prev) => ({ ...prev, [m.name]: e.target.value }));
                                 setPickedFields((prev) => {
                                   const next = new Set(prev); next.delete(m.name); return next;
                                 });
                               }} />
                        {fits.length > 0 && (
                          <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                            {!inline && (<>
                              <button type="button" className="btn btn-sm"
                                      onClick={() => setOpened((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(m.name)) next.delete(m.name);
                                        else next.add(m.name);
                                        return next;
                                      })}>
                                候補 {open ? "▴" : "▾"}
                              </button>
                              <button type="button" className="btn btn-sm"
                                      onClick={() => {
                                        setQuoteFor(quoteFor === m.name ? null : m.name);
                                        setQuoteQ(""); setQuoteHits([]);
                                      }}>
                                探して入れる
                              </button>
                            </>)}
                            {quoteFor === m.name && (
                              <div className="stack" style={{ gap: 4, width: "100%", marginTop: 4 }}>
                                <input value={quoteQ} autoFocus
                                       placeholder="スタッフ・取引先・先方担当を名前で探す"
                                       onChange={(e) => setQuoteQ(e.target.value)} />
                                <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                                  {quoteHits.map((c) => (
                                    <button key={`${c.label}:${c.value}`} type="button"
                                            className="btn btn-sm" style={{ whiteSpace: "nowrap" }}
                                            title={c.source}
                                            onClick={() => { put(c.value); setQuoteFor(null); }}>
                                      {c.value}
                                      <span className="faint" style={{ marginLeft: 4 }}>{c.label}</span>
                                    </button>
                                  ))}
                                  {quoteSearch.trim() && !quoteHits.length && (
                                    <span className="faint">見つかりません</span>
                                  )}
                                </div>
                              </div>
                            )}
                            {open && fits.slice(0, 8).map((c) => (
                              <button key={`${c.label}:${c.value}`} type="button"
                                      className="btn btn-sm" style={{ whiteSpace: "nowrap" }}
                                      title={`${c.source}／${c.label}`} onClick={() => put(c.value)}>
                                {c.value}
                                <span className="faint" style={{ marginLeft: 4 }}>{c.label}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </label>
                    );
                  })}
                  </div>
                </div>
              )}

              <div className="row">
                <button className="btn" onClick={runPreview} disabled={busy || !templateKey}>
                  中身を見る
                </button>
                <button className="btn primary" onClick={issue} disabled={busy || !ready}>
                  発行する
                </button>
                {!ready && preview && (
                  <span className="faint">未入力 {remaining} 件</span>
                )}
                {preview && preview.derived.length > 0 && (
                  <span className="faint">
                    {preview.derived.length}項目を条件から自動解決
                  </span>
                )}
              </div>
            </div>
          </div>

          {preview && (
            <div className="panel">
              <div className="panel-hd"><h2>プレビュー</h2><span className="faint">{preview.templateLabel}</span></div>
              <iframe className="preview" title="文書プレビュー" srcDoc={preview.html} />
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>発行済み・下書き</h2>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="文書番号・相手先" label="文書を絞り込む" />
          </div>
          <ListCount shown={documents.length} keyword={search} onClear={() => setKeyword("")} />
          <div className="tablewrap">
            <table>
              <thead><tr><th>文書番号</th><th>種別</th><th>相手先</th><th className="num">条件</th><th>状態</th><th></th></tr></thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td className="code">{d.documentNo ?? "（下書き）"}</td>
                    <td>
                      {d.templateLabel ?? "—"}
                      {d.imported && <div className="faint">取込（外で作られた文書）</div>}
                    </td>
                    <td>{d.counterparty ?? "—"}</td>
                    <td className="num">{d.conditionCount}</td>
                    <td><StatusTag kind="document" value={d.status} /></td>
                    <td>
                      {d.status === "issued" && (
                        <span className="row">
                          {/* 取込文書は本文を持たない。実体は預けたファイルだけなので、
                              組み直しも作り直しもできない。押せるものだけ出す。 */}
                          {!d.imported && (<>
                            <a href={`/api/v3/documents/${d.id}/html`} target="_blank" rel="noreferrer">HTML</a>
                            <a href={`/api/v3/documents/${d.id}/pdf`}>PDF</a>
                          </>)}
                          {d.storageUrl
                            ? <a href={d.storageUrl} target="_blank" rel="noreferrer">
                                {d.imported ? "ファイル" : "Drive"}
                              </a>
                            : !d.imported && integrations?.drive.documents
                              ? <button className="btn btn-sm" disabled={busy}
                                        onClick={() => store(d.id)}>Driveに保存</button>
                              : null}
                          {integrations?.channels.some((c) => c.channel === "gmail" && c.mode !== "off") && (
                            <button className="btn btn-sm" disabled={busy}
                                    onClick={() => send(d.id)}>送付</button>
                          )}
                          {!d.imported && (
                            <button className="btn btn-sm" disabled={busy}
                                    onClick={() => reissue(d.id, d.documentNo)}>作り直す</button>
                          )}
                          <button className="btn btn-sm" disabled={busy}
                                  onClick={() => voidDocument(d.id, d.documentNo)}>無効にする</button>
                        </span>
                      )}
                      {d.status === "draft" && (
                        <button className="btn btn-sm" disabled={busy}
                                onClick={() => voidDocument(d.id, d.documentNo)}>破棄する</button>
                      )}
                      {d.status === "superseded" && (
                        <span className="faint">差し替え済み</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!documents.length && (
                  <tr><td colSpan={6} className="faint">
                    {search.trim() ? `「${search}」に一致する文書はありません` : "文書がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
