import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag } from "./labels.js";
import type { ConditionSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import type { EntityKind } from "./Relations.js";
import { DocumentDetail, type DocumentRow } from "./DocumentDetail.js";

interface TemplateRow {
  id: number; templateKey: string; label: string; category: string | null; numberPrefix: string | null;
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

/** 一覧の中の紐づけ。件数ではなく番号を出して、そのまま辿れるようにする。 */
function Refs(
  { doc, onOpen }: { doc: DocumentRow; onOpen?: (kind: EntityKind, id: number) => void }
) {
  const shown = doc.conditions.slice(0, 2);
  const rest = doc.conditions.length - shown.length;
  return (
    <span className="reflist" onClick={(e) => e.stopPropagation()}>
      {shown.length
        ? shown.map((c) => (
            <button key={c.id} className="linky"
                    onClick={() => onOpen?.("condition", c.id)}>
              {c.conditionNo ?? `#${c.id}`}
            </button>
          ))
        : <span className="none">条件明細なし</span>}
      {rest > 0 && <span className="none">ほか {rest} 件</span>}
      {doc.matterId
        ? <button className="linky" onClick={() => onOpen?.("matter", doc.matterId!)}>
            {doc.matterNo ?? `#${doc.matterId}`}
          </button>
        : <span className="none">案件なし</span>}
    </span>
  );
}

export function DocumentsWorkspace(
  { start, openDocumentId, onOpen }: {
    start?: { conditionId: number; eventIds: number[] };
    /** 他の画面から「編集」で来たときの文書。下書きならそのままフォームに載せる。 */
    openDocumentId?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
  } = {}
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
  /**
   * ひな形が要求する項目の一覧と候補。**必ず手入力を空にして取る。**
   *
   * 手入力を送ると、埋まった項目は missing から消える。それを入力欄の元に
   * すると、打ち終わった欄が画面から消える。残数は画面の値で数えれば足りる。
   */
  const [spec, setSpec] = useState<PreviewResponse | null>(null);
  /** プレビューの本文。入力欄とは別に持つ。打つたびに作り直しても打鍵を邪魔しない。 */
  const [rendered, setRendered] = useState<{ html: string; templateLabel: string } | null>(null);
  /** 直している下書き。作り直した文書はここに載せて、直してから発行する。 */
  const [draft, setDraft] = useState<{ id: number; no: string | null } | null>(null);
  /** 一覧で選んでいる文書。右にその文書の詳細を出す。 */
  const [selected, setSelected] = useState<number | null>(null);
  /** 旧版を開いている文書。既定は畳む（いまの版だけを読めるようにする）。 */
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set());
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
  const form = useRef<HTMLDivElement>(null);

  useEffect(() => { void reload(); }, [search]);

  /**
   * 他の画面から文書を指定して来たとき。下書きは直せるのでフォームへ、
   * 発行済みは記録なので「つながり」を開く（直すなら作り直しになる）。
   */
  useEffect(() => {
    if (!openDocumentId) return;
    void openForEdit(openDocumentId);
  }, [openDocumentId]);

  async function openForEdit(id: number) {
    setError(null);
    try {
      const d = await api.get<{ id: number; documentNo: string | null; status: string;
                               imported: boolean }>(`/documents/${id}`);
      if (d.status === "draft" && !d.imported) { await openDraft(d.id); return; }
      setSelected(d.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }
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

  /**
   * 版の連鎖。参照は新→旧（supersedes_id）の一方向しか無いので、
   * 一覧の中で辿って組み立てる。
   */
  const byId = useMemo(
    () => new Map(documents.map((d) => [d.id, d])), [documents]);

  /**
   * いまの版だけ。退いた版（訂正版に差し替えられたもの）だけを下に畳む。
   *
   * 「後継がいるか」で畳むと、訂正版の下書きを作った瞬間に、まだ有効な発行済み
   * 文書が一覧から消える。退くのは訂正版を発行したときなので、状態で判断する。
   */
  const heads = useMemo(
    () => documents.filter((d) => d.status !== "superseded"), [documents]);

  /** その版が差し替えた、退いた古い版たち（新しい順）。 */
  const ancestorsOf = (d: DocumentRow): DocumentRow[] => {
    const out: DocumentRow[] = [];
    let id = d.supersedesId;
    while (id !== null && byId.has(id) && out.length < 30) {
      const prev = byId.get(id)!;
      // まだ退いていない版はそれ自体が現行。畳まず、独立した行として見せる。
      if (prev.status !== "superseded") break;
      out.push(prev);
      id = prev.supersedesId;
    }
    return out;
  };

  /** 初版から現行までの並び。履歴に出す。 */
  const chainOf = (d: DocumentRow): DocumentRow[] => {
    const newer: DocumentRow[] = [];
    let id = d.supersededById;
    while (id !== null && byId.has(id) && newer.length < 30) {
      const next = byId.get(id)!;
      newer.push(next);
      id = next.supersededById;
    }
    return [...ancestorsOf(d).reverse(), d, ...newer];
  };

  const current = selected === null ? null : byId.get(selected) ?? null;

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
    // 下書きを開いたときは、その下書きの手入力が正。既定で上書きしない。
    if (draft) return;
    setManual({}); setPickedFields(new Set());
    api.get<{ defaults: Record<string, string> }>(`/document-defaults/${templateKey}`)
      .then((r) => setManual(r.defaults ?? {}))
      .catch(() => undefined);
  }, [templateKey]);

  // ひな形か条件を変えたら、何が要るかを取り直す。押してから足りないと
  // 言われるのでは遅い。
  //
  // **手入力では取り直さない。** 取り直すと入力欄が作り直されて、日本語の
  // 変換中に確定させられる（一文字打つたびに勝手に確定する）。項目の一覧は
  // ひな形と条件と実績だけで決まるので、打っている間は動かさなくてよい。
  useEffect(() => {
    if (!templateKey) { setSpec(null); setRendered(null); return; }
    let live = true;
    api.post<PreviewResponse>("/documents/preview",
      { templateKey, conditionIds: picked, eventIds: pickedEvents, manualInputs: {} })
      .then((r) => { if (live) setSpec(r); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [templateKey, picked.join(","), pickedEvents.join(",")]);

  // 本文は打った値で作り直す。iframe の中身が変わるだけで、入力欄には触らない。
  useEffect(() => {
    if (!templateKey) return;
    let live = true;
    api.post<PreviewResponse>("/documents/preview",
      { templateKey, conditionIds: picked, eventIds: pickedEvents,
        manualInputs: JSON.parse(manualJson) })
      .then((r) => { if (live) setRendered({ html: r.html, templateLabel: r.templateLabel }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [templateKey, picked.join(","), pickedEvents.join(","), manualJson]);

  async function runPreview() {
    setError(null); setIssued(null); setBusy(true);
    try {
      const r = await api.post<PreviewResponse>("/documents/preview", body);
      setRendered({ html: r.html, templateLabel: r.templateLabel });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // 下書きを作ってから発行する。採番は発行時にだけ進む。
  async function issue() {
    setError(null); setBusy(true);
    try {
      let documentNo: string;
      if (draft) {
        // 開いている下書きを直してから発行する。発行は下書きに保存された
        // 手入力しか見ないので、先に書き戻す。
        await api.patch(`/documents/${draft.id}/draft`,
          { manualInputs: manual, conditionIds: picked });
        const r = await api.post<{ documentNo: string }>(
          `/documents/${draft.id}/issue`, { eventIds: pickedEvents });
        documentNo = r.documentNo;
      } else {
        // 下書き→発行→実績への紐づけをサーバ側で1本にしてある。
        // 途中で落ちたときは下書きごと捨てられる。
        const result = await api.post<{ document: { documentNo: string } }>(
          "/documents/compose", body);
        documentNo = result.document.documentNo;
      }
      setIssued(documentNo);
      // 手で打った項目だけ覚える。日付と金額は毎回変わるので覚えない
      // （前回の日付が入ったまま気づかず発行してしまう）。
      const keep: Record<string, string> = {};
      for (const m of spec?.missing ?? []) {
        const kind = kindFor(m.name, m.label);
        const value = String(manual[m.name] ?? "").trim();
        if (value && !pickedFields.has(m.name) && kind !== "date" && kind !== "amount") {
          keep[m.name] = value;
        }
      }
      if (Object.keys(keep).length) {
        await api.put(`/document-defaults/${templateKey}`, { values: keep }).catch(() => undefined);
      }
      // 項目の一覧は消さない。消すと、続けてもう1枚作るときに空の画面が残る。
      // 日付と金額だけ落として、手で打った文字は次にも使う。
      setManual(keep); setPickedFields(new Set());
      setDraft(null); setPickedEvents([]);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 一覧で選んだ下書きをそのまま発行する。フォームに載せ直す手間を省くため。
   *
   * 訂正版ならこの1回で前の版が退き、実績もこちらへ移る。以前は
   * 「新版を発行」「旧版を無効化」の2手が要り、間の一瞬だけ両方が有効に見えていた。
   *
   * すでにフォームに載せている下書きなら、画面で直した内容を先に書き戻したいので
   * いつもの発行を通す。
   */
  async function issueDraft(id: number) {
    if (draft?.id === id) { await issue(); return; }
    setError(null); setIssued(null); setBusy(true);
    try {
      // 実績はサーバが持っているものを使う。画面で選び直していない下書きを
      // 空の実績で発行すると、前の版が結んでいた実績が宙に浮く。
      const d = await api.get<{ eventIds: number[] }>(`/documents/${id}`);
      const r = await api.post<{ documentNo: string }>(
        `/documents/${id}/issue`, { eventIds: d.eventIds ?? [] });
      setIssued(r.documentNo);
      await reload();
      setSelected(id);
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

  /**
   * 訂正版を作る。条件・実績・手入力を引き継いだ下書きができるだけで、
   * ここでは前の版はまだ有効なまま。入れ替わるのは訂正版を発行した瞬間。
   * 下書きのまま捨てても、前の版が生きているので穴が開かない。
   */
  async function reissue(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} の訂正版を作ります。訂正の理由を書いてください。\n` +
      "条件も実績も引き継いだ下書きができます。" +
      "発行した瞬間にこの版と入れ替わるので、先に無効にする必要はありません。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${id}/reissue`, { reason });
      await reload();
      // 作っただけでは直せない。そのまま上のフォームに載せる。
      await openDraft(r.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 下書きを上のフォームに載せる。ひな形・条件・手入力をそのまま引き継ぐ。
   * 作り直した下書きを直して発行するには、ここを通る。
   */
  async function openDraft(id: number) {
    setError(null); setIssued(null); setBusy(true);
    try {
      const d = await api.get<{
        id: number; documentNo: string | null; templateKey: string | null;
        manualInputs: Record<string, unknown>;
        conditions: Array<{ id: number }>;
        eventIds: number[];
      }>(`/documents/${id}`);
      if (!d.templateKey) {
        throw new ApiError(400, "ひな形を持たない文書は直せません");
      }
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.manualInputs ?? {})) {
        if (v !== null && v !== undefined) values[k] = String(v);
      }
      // draft を先に立てる。ひな形を変えたときの既定読み込みに上書きさせない。
      setDraft({ id: d.id, no: d.documentNo });
      setTemplateKey(d.templateKey);
      setPicked(d.conditions.map((c) => c.id));
      // 実績も戻す。訂正版の下書きなら、前の版が結んでいた実績が返ってくる。
      // ここを空にすると、直して発行するたびに実績を選び直す羽目になる。
      setPickedEvents(d.eventIds ?? []);
      setManual(values);
      setPickedFields(new Set());
      form.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** 下書きから降りる。作りかけの下書きは残るので、あとで開き直せる。 */
  function closeDraft() {
    setDraft(null); setManual({}); setPickedFields(new Set()); setPickedEvents([]);
    // ひな形は変わらないので既定の読み込みは走らない。ここで戻しておかないと、
    // 下書きを閉じたあとだけ前回の値が出ない画面になる。
    if (templateKey) {
      api.get<{ defaults: Record<string, string> }>(`/document-defaults/${templateKey}`)
        .then((r) => setManual(r.defaults ?? {}))
        .catch(() => undefined);
    }
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

  // 未入力は画面の入力値で数える。項目の一覧は手入力を空にして取っているので、
  // spec.missing はひな形が要求する項目の一覧であって、残数ではない。
  const remaining = (spec?.missing ?? [])
    .filter((m) => !String(manual[m.name] ?? "").trim()).length;
  const ready = Boolean(templateKey) && spec !== null && remaining === 0;

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
          <div className="panel" ref={form}>
            <div className="panel-hd">
              <h2>{draft ? "下書きを直して発行する" : "作成"}</h2>
              {draft && (
                <span className="row" style={{ marginLeft: "auto" }}>
                  <span className="faint">下書き #{draft.id}</span>
                  <button className="btn btn-sm" onClick={closeDraft} disabled={busy}>
                    やめる
                  </button>
                </span>
              )}
            </div>
            <div className="panel-bd stack">
              {draft && (
                <div className="note">
                  下書きを直しています。ひな形は元の版のまま変えられません。
                  直して発行すると、この下書きが発行済みになります。
                </div>
              )}
              <label className="field">
                <span>テンプレート</span>
                {/* 下書きはひな形の版を持っている。ここで変えても発行はその版で走るので、
                    選ばせない。ひな形を変えたいなら作り直しではなく新規で作る。 */}
                <select value={templateKey} disabled={Boolean(draft)}
                        onChange={(e) => setTemplateKey(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.templateKey} value={t.templateKey}>{t.label}</option>
                  ))}
                </select>
              </label>

              <div className="stack" style={{ gap: 6 }}>
                <div className="row">
                  <span className="faint">
                    この文書に載せる条件明細（契約の中の行）を選ぶ
                  </span>
                  <span className="faint" style={{ marginLeft: "auto" }}>
                    {picked.length ? `${picked.length} 件を選択中` : "選ばなくても作れます"}
                  </span>
                </div>
                <input value={condSearch} placeholder="条件番号・名称・相手先・契約で絞る"
                       onChange={(e) => setCondSearch(e.target.value)} />
                <div className="picker">
                  {conditions
                    .filter((c) => {
                      const q = condSearch.trim().toLowerCase();
                      if (!q) return picked.includes(c.id) || conditions.indexOf(c) < 20;
                      return [c.conditionNo, c.name, c.counterparty?.name,
                              c.agreement?.title, c.agreement?.agreementNo]
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
                      {/* どの契約の明細かが分かると、選び間違いが減る。 */}
                      <span className="faint" style={{ marginLeft: "auto" }}>
                        {c.agreement ? c.agreement.title : "契約なし"}
                      </span>
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

              {spec && spec.missing.length > 0 && (
                <div className="stack">
                  <div className="row">
                    <span className="faint">このひな形が要求する項目</span>
                    <span className="faint" style={{ marginLeft: "auto" }}>
                      残り {remaining} 件
                    </span>
                  </div>
                  <div className="form-grid">
                  {spec.missing.map((m) => {
                    const want = kindFor(m.name, m.label);
                    const fits = spec.candidates.filter((c) => !want || c.kind === want);
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
                        {/* 候補が無いときこそ探したい。「探して入れる」は候補の数に
                            関わらず出す。ここを候補の有無で隠していたせいで、
                            検収者氏名のように候補が出ない欄は手打ちしかできなかった。 */}
                        {(!inline || fits.length > 0) && (
                          <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                            {!inline && (<>
                              {fits.length > 0 && (
                              <button type="button" className="btn btn-sm"
                                      onClick={() => setOpened((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(m.name)) next.delete(m.name);
                                        else next.add(m.name);
                                        return next;
                                      })}>
                                候補 {open ? "▴" : "▾"}
                              </button>
                              )}
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
                  {draft ? "直して発行する" : "発行する"}
                </button>
                {!ready && spec && (
                  <span className="faint">未入力 {remaining} 件</span>
                )}
                {spec && spec.derived.length > 0 && (
                  <span className="faint">
                    {spec.derived.length}項目を条件から自動解決
                  </span>
                )}
              </div>
            </div>
          </div>

          {rendered && (
            <div className="panel">
              <div className="panel-hd"><h2>プレビュー</h2><span className="faint">{rendered.templateLabel}</span></div>
              <iframe className="preview" title="文書プレビュー" srcDoc={rendered.html} />
            </div>
          )}
        </div>

        <div className="split">
          <div className="panel">
            <div className="panel-hd">
              <h2>文書</h2>
              <span className="faint">いまの版だけを並べています</span>
              <ListSearch value={keyword} onChange={setKeyword}
                placeholder="文書番号・相手先" label="文書を絞り込む" />
            </div>
            <ListCount shown={documents.length} keyword={search} onClear={() => setKeyword("")} />
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th>文書番号</th><th>種別</th><th>条件明細 ／ 案件</th><th>状態</th>
                </tr></thead>
                <tbody>
                  {heads.map((d) => {
                    const older = ancestorsOf(d);
                    const open = unfolded.has(d.id);
                    return (
                      <Fragment key={d.id}>
                        <tr className={d.id === selected ? "sel" : ""} tabIndex={0}
                            aria-selected={d.id === selected}
                            onClick={() => setSelected(d.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault(); setSelected(d.id);
                              }
                            }}>
                          <td className="code">
                            {d.documentNo ?? "（未発行）"}
                            {/* 訂正版の下書きは、どの版を直しているのかが分からないと
                                「（未発行）」の行が2つ並ぶだけになる。 */}
                            {d.supersedesId !== null && (
                              <div className="faint">
                                {byId.get(d.supersedesId)?.documentNo ?? `#${d.supersedesId}`} の訂正版
                              </div>
                            )}
                          </td>
                          <td>
                            {d.templateLabel ?? "—"}
                            <div className="faint">{d.counterparty ?? "相手先なし"}</div>
                          </td>
                          <td><Refs doc={d} onOpen={onOpen} /></td>
                          <td>
                            <StatusTag kind="document" value={d.status} />
                            {/* まだ有効な版に訂正版の下書きが付いている状態。
                                これを出さないと、似た行が2つある理由が読めない。 */}
                            {d.status === "issued" && d.supersededById !== null && (
                              <div className="faint">訂正版の下書きあり</div>
                            )}
                          </td>
                        </tr>
                        {older.length > 0 && (
                          <tr>
                            <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
                              <button className="fold" onClick={(e) => {
                                e.stopPropagation();
                                setUnfolded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                                  return next;
                                });
                              }}>
                                <span className="caret">{open ? "▾" : "▸"}</span>
                                この文書の旧版 {older.length} 件
                              </button>
                            </td>
                          </tr>
                        )}
                        {open && older.map((o) => (
                          <tr key={o.id} className={`older${o.id === selected ? " sel" : ""}`}
                              tabIndex={0} onClick={() => setSelected(o.id)}>
                            <td className="code faint">{o.documentNo ?? "（未発行）"}</td>
                            <td className="faint">{o.templateLabel ?? "—"}</td>
                            <td className="faint">同上</td>
                            <td><StatusTag kind="document" value={o.status} /></td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                  {!documents.length && (
                    <tr><td colSpan={4} className="faint">
                      {search.trim() ? `「${search}」に一致する文書はありません` : "文書がありません"}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-bd" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="row" style={{ gap: 16, fontSize: 11.5, color: "var(--muted)" }}>
                <span><b>下書き</b> まだ発行していない。中身を直せる</span>
                <span><b>発行済み</b> 出した記録。中身は直せない</span>
                <span><b>訂正版あり</b> 新しい版に差し替わった</span>
              </div>
            </div>
          </div>

          {current && (
            <DocumentDetail
              doc={current} versions={chainOf(current)} integrations={integrations} busy={busy}
              onOpen={onOpen} onChanged={() => void reload()}
              onEditDraft={(id) => void openDraft(id)}
              onIssueDraft={(id) => void issueDraft(id)}
              onReissue={(id, no) => void reissue(id, no)}
              onVoid={(id, no) => void voidDocument(id, no)}
              onStore={(id) => void store(id)}
              onSend={(id) => void send(id)}
              onSelect={setSelected} />
          )}
        </div>

      </div>
    </section>
  );
}
