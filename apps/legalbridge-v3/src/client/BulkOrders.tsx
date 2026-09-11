import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { SearchSelect, type SearchOption } from "./SearchSelect.js";

/**
 * 発注書の一括作成。
 *
 *   1. ひな形と案件を決め、CSV を選ぶ（雛形はここから取れる）
 *   2. 突き合わせ：同じ取引先・同じ作品の行を1束（1枚）にまとめ、当たり具合を見せる。何も作らない
 *   3. 下書きを N 件作る：束ごとに 条件明細 → 案件 → 下書き
 *   4. 束の画面：まとめて決定、まとめて送る（取引先へ、担当者を cc）
 *
 * 1束 = 発注書1枚 = 条件明細1件。取引先だけで束ねていたので、作品が何本かある
 * 案件では同じ取引先の行が作品をまたいで1枚に混ざっていた。
 *
 * 取引先や作品が当たらない束は飛ばして残りを作る。飛ばした束は結果に残る。
 * 扱うのは定額の業務委託だけ。
 */

interface Candidate { id: number; name: string; partyCode: string | null }
interface WorkCandidate { id: number; title: string; workCode: string | null }
interface Row { line: number; item: Record<string, unknown>; amount: number; issues: string[] }
interface Group {
  key: string; partyCode: string | null; partyName: string | null;
  resolution: "resolved" | "ambiguous" | "missing";
  party: Candidate | null; candidates: Candidate[];
  workCode: string | null; workTitle: string | null;
  workResolution: "none" | "resolved" | "ambiguous" | "missing";
  work: WorkCandidate | null; workCandidates: WorkCandidate[];
  condition: { mode: "existing" | "new"; id: number | null; conditionNo: string | null };
  rows: Row[]; total: number; issues: string[]; action: "create" | "choose" | "skip";
}
interface Preview { groups: Group[]; summary: { rows: number; groups: number; creatable: number; skipped: number; choose: number } }
interface ResultEntry { key: string; partyName: string | null; status: "created" | "skipped" | "failed";
  conditionNo?: string | null; documentId?: number; reason?: string }
interface Doc { id: number; documentNo: string | null; status: string; phase: string; counterparty: string | null;
  templateLabel: string | null; conditions: Array<{ id: number; conditionNo: string | null }> }
interface Batch { id: number; templateKey: string; matterId: number | null; matterNo: string | null; matterTitle: string | null;
  sourceFilename: string | null; rowCount: number; createdBy: string | null; createdAt: string;
  result: ResultEntry[]; documents: Doc[] }
interface BatchHead { id: number; matterNo: string | null; matterTitle: string | null; sourceFilename: string | null;
  createdAt: string; created: number; skipped: number; failed: number }

const searchMatters = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ matters: Array<{ id: number; matterNo: string | null; title: string; status: string }> }>(
    `/matters?q=${encodeURIComponent(q)}`);
  return r.matters.map((m) => ({ value: String(m.id), label: `${m.matterNo ?? `#${m.id}`} ${m.title}`, hint: m.status }));
};

/** ブラウザで文字コードを判定して読む。UTF-8 で化けたら Shift_JIS で読み直す。 */
async function readCsv(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("shift_jis").decode(buf); } catch { return utf8; }
}

const TONE = { create: "ok", choose: "warn", skip: "out" } as const;
const ACTION_LABEL = { create: "作る", choose: "選ぶ", skip: "飛ばす" } as const;
const RES_LABEL = { resolved: "取引先 1件に決定", ambiguous: "候補が複数", missing: "取引先が未登録" } as const;
const WORK_LABEL = { none: "作品なし", resolved: "作品 1件に決定",
                     ambiguous: "作品の候補が複数", missing: "作品が未登録" } as const;

export function BulkOrders(
  { templates, initialMatterId, onOpenDocument, onClose, onCreated }: {
    templates: Array<{ templateKey: string; label: string }>;
    /**
     * 案件の画面から来たときの案件。決まった状態で開く。
     * ここが空だと、案件から来た人にもう一度同じ案件を選ばせることになる。
     */
    initialMatterId?: number | null;
    onOpenDocument: (id: number) => void;
    onClose: () => void;
    /** 束ができた・決定した・送った。一覧を引き直してもらう。 */
    onCreated: (batchId: number) => void;
  }
) {
  const orderTemplates = templates.filter((t) => t.templateKey === "purchase_order" || t.templateKey === "intl_purchase_order");
  const [templateKey, setTemplateKey] = useState(orderTemplates[0]?.templateKey ?? "purchase_order");
  const [matterId, setMatterId] = useState(initialMatterId ? String(initialMatterId) : "");
  /** 案件から来たときは、その案件の名前を出して固定する。押せば選び直せる。 */
  const [matterLabel, setMatterLabel] = useState<string | null>(null);
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});
  /** 作品の候補が複数の束で、どれを選んだか（束の鍵 → 作品ID）。 */
  const [workChoices, setWorkChoices] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [recent, setRecent] = useState<BatchHead[]>([]);
  const [issueResult, setIssueResult] = useState<Array<{ documentId: number; partyName: string | null; ok: boolean; documentNo?: string; reason?: string }> | null>(null);
  const [sendResult, setSendResult] = useState<Array<{ documentId: number; documentNo: string | null; partyName: string | null; sent: boolean; reason?: string; to?: string[] }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ batches: BatchHead[] }>("/documents/batches").then((r) => setRecent(r.batches)).catch(() => undefined);
  }, [batch?.id]);

  // 案件から来たときは番号と件名を出す。ID だけだと、合っているか確かめられない。
  useEffect(() => {
    if (!initialMatterId) return;
    api.get<{ matterNo: string | null; title: string }>(`/matters/${initialMatterId}`)
      .then((m) => setMatterLabel(`${m.matterNo ?? `#${initialMatterId}`} ${m.title}`))
      .catch(() => setMatterLabel(`#${initialMatterId}`));
  }, [initialMatterId]);

  // 案件・ひな形・CSV・候補の選択が揃うたびに突き合わせ直す。何も作らない。
  useEffect(() => {
    if (!csv || !matterId) { setPreview(null); return; }
    let live = true;
    setError(null);
    api.post<Preview>("/documents/batches/preview",
      { templateKey, matterId: Number(matterId), csv: csv.text, choices, workChoices })
      .then((r) => { if (live) setPreview(r); })
      .catch((e: ApiError) => { if (live) { setPreview(null); setError(e.message); } });
    return () => { live = false; };
  }, [csv, matterId, templateKey, JSON.stringify(choices), JSON.stringify(workChoices)]);

  async function create() {
    if (!csv || !matterId) return;
    setBusy(true); setError(null);
    try {
      const b = await api.post<Batch>("/documents/batches",
        { templateKey, matterId: Number(matterId), csv: csv.text, filename: csv.name,
          choices, workChoices });
      setBatch(b); setPreview(null); setCsv(null); setIssueResult(null); setSendResult(null);
      onCreated(b.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function open(id: number) {
    setError(null);
    try { setBatch(await api.get<Batch>(`/documents/batches/${id}`)); setIssueResult(null); setSendResult(null); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  async function issueAll() {
    if (!batch) return;
    if (!window.confirm("必須が揃っている下書きをまとめて決定します。決定すると番号が振られ、中身は直せなくなります。")) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ results: NonNullable<typeof issueResult>; batch: Batch }>(`/documents/batches/${batch.id}/issue`);
      setIssueResult(r.results); setBatch(r.batch); onCreated(batch.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function sendAll() {
    if (!batch) return;
    if (!window.confirm("決定済みの発注書を、取引先の連絡先へ担当者を cc に入れてまとめて送ります。")) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ results: NonNullable<typeof sendResult>; batch: Batch }>(`/documents/batches/${batch.id}/send`, {});
      setSendResult(r.results); setBatch(r.batch); onCreated(batch.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const ready = preview?.groups.filter((g) => g.action === "create") ?? [];

  return (
    <div className="stack">
      {/* 1. 入口 */}
      {!batch && (
      <div className="panel">
        <div className="panel-hd">
          <h2>発注書をまとめて作る</h2>
          <span className="faint">
            CSV から、1つの案件の発注先すべてに発注書の下書きを起こす。取引先と作品の組ごとに1枚。定額の業務委託だけ
          </span>
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>やめる</button>
        </div>
        <div className="panel-bd stack">
          {error && <div className="alert">{error}</div>}
          <div className="frow"><div className="flabel"><span>ひな形</span></div>
            <div className="fbody">
              <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                {orderTemplates.map((t) => <option key={t.templateKey} value={t.templateKey}>{t.label}</option>)}
              </select>
            </div></div>
          <div className="frow"><div className="flabel"><span>案件</span></div>
            <div className="fbody">
              {/* 案件から来たときは決まっている。選び直したい人のために外せる。 */}
              {matterLabel && String(initialMatterId) === matterId ? (
                <div className="row">
                  <span className="src auto">案件から</span>
                  <b>{matterLabel}</b>
                  <button className="linky" onClick={() => { setMatterLabel(null); setMatterId(""); }}>
                    別の案件にする
                  </button>
                </div>
              ) : (
                <SearchSelect value={matterId} search={searchMatters} placeholder="案件番号・件名で探す"
                              onChange={(v) => setMatterId(v)} />
              )}
              <div className="faint" style={{ marginTop: 3 }}>この束の条件明細と発注書は、すべてこの案件に載ります</div>
            </div></div>
          <div className="frow"><div className="flabel"><span>CSV</span></div>
            <div className="fbody">
              <div className="row">
                <a className="btn" href="/api/v3/documents/batches/template.csv">雛形をダウンロード</a>
                <label className="btn primary" style={{ cursor: "pointer" }}>
                  ファイルを選ぶ
                  <input type="file" accept=".csv,text/csv" style={{ display: "none" }}
                         onChange={async (e) => {
                           const f = e.target.files?.[0]; if (!f) return;
                           setChoices({}); setWorkChoices({});
                           setCsv({ name: f.name, text: await readCsv(f) });
                         }} />
                </label>
                {csv && <span className="code">{csv.name}</span>}
                <span className="faint">
                  UTF-8 か Shift_JIS。1行 = 1品目。同じ取引先・同じ作品の行が1枚にまとまる
                </span>
              </div>
              {/* 突き合わせは案件が決まってから走る。先に CSV を選ぶと、選んだのに
                  何も出ないまま止まって、読み込みに失敗したように見えていた。 */}
              {csv && !matterId && (
                <div className="note" style={{ marginTop: 6 }}>
                  案件がまだ決まっていません。上で案件を選ぶと、この CSV の突き合わせが出ます
                </div>
              )}
            </div></div>
          {recent.length > 0 && (
            <div className="faint">
              これまでの束：
              {recent.slice(0, 6).map((b) => (
                <button key={b.id} className="linky" style={{ marginLeft: 8 }} onClick={() => void open(b.id)}>
                  一括 #{b.id}（{b.matterNo ?? "案件なし"}・{b.created} 件）
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      )}

      {/* 2. 突き合わせ */}
      {!batch && preview && (
      <div className="panel">
        <div className="panel-hd">
          <h2>突き合わせの結果</h2>
          <span className="faint">{csv?.name}　{preview.summary.rows} 行 → {preview.summary.groups} 束</span>
          <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
            <span className="tag ok">作れる {preview.summary.creatable}</span>
            {preview.summary.choose > 0 && <span className="tag warn">選ぶ {preview.summary.choose}</span>}
            {preview.summary.skipped > 0 && <span className="tag out">飛ばす {preview.summary.skipped}</span>}
          </span>
        </div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>#</th><th>取引先・作品 ／ 品目</th><th className="num">数量</th><th className="num">単価</th><th className="num">金額</th><th>納期</th><th>帰属先</th><th>条件明細</th><th>扱い</th></tr></thead>
            <tbody>
              {preview.groups.map((g) => (
                <GroupRows key={g.key} g={g} chosen={choices[g.key]} chosenWork={workChoices[g.key]}
                           onChoose={(id) => setChoices((c) => ({ ...c, [g.key]: id }))}
                           onChooseWork={(id) => setWorkChoices((c) => ({ ...c, [g.key]: id }))} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-bd stack">
          <div className="note">
            1束 = 発注書1枚 = 条件明細1件。同じ取引先でも作品が違えば別の束になります。
            条件明細：その取引先・その作品にこの案件の定額・委託料の条件があれば「既存」に当てる。無ければ「新規」で1件作る（金額は行の合計、終了は納期の最遅、作品は当てた作品）。
            取引先も作品もここでは作りません。未登録の束は飛ばし、登録してから残りだけ再アップロードしてください。
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy || !ready.length} onClick={() => void create()}>
              {busy ? "作っています…" : `下書きを ${ready.length} 件作る`}
            </button>
            {preview.summary.choose > 0 && <span className="faint">候補が決まっていない束は「飛ばす」に落ちます</span>}
          </div>
        </div>
      </div>
      )}

      {/* 3・4. 束 */}
      {batch && (
      <div className="panel">
        <div className="panel-hd">
          <h2>一括 #{batch.id}</h2>
          <span className="tag accent">{templates.find((t) => t.templateKey === batch.templateKey)?.label ?? batch.templateKey}</span>
          <span className="faint">
            {batch.matterNo ?? "案件なし"} {batch.matterTitle ?? ""}　{batch.sourceFilename ?? ""}　{batch.createdAt.slice(0, 10)} {batch.createdBy ?? ""}
          </span>
          <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
            <button className="btn btn-sm" onClick={() => { setBatch(null); setIssueResult(null); setSendResult(null); }}>別の束を作る</button>
            <button className="btn btn-sm" onClick={onClose}>閉じる</button>
          </span>
        </div>
        {error && <div className="panel-bd"><div className="alert">{error}</div></div>}
        <div className="tablewrap">
          <table>
            <thead><tr><th>取引先</th><th>条件明細</th><th>文書</th><th>状態</th><th>結果</th><th></th></tr></thead>
            <tbody>
              {batch.result.map((r) => {
                const doc = batch.documents.find((d) => d.id === r.documentId);
                return (
                  <tr key={r.key} className={r.status !== "created" ? "older" : ""}>
                    <td>{r.partyName ?? "（取引先なし）"}</td>
                    <td className="code">{r.conditionNo ?? "—"}</td>
                    <td className="code">{doc ? (doc.documentNo ?? `#${doc.id}`) : "—"}</td>
                    <td>{doc ? <span className={`tag ${doc.phase === "draft" ? "warn" : doc.phase === "sent" ? "ok" : "accent"}`}>
                      {doc.phase === "draft" ? "下書き" : doc.phase === "decided" ? "決定済み" : doc.phase === "sent" ? "送信済み" : doc.phase}
                    </span> : <span className={`tag ${r.status === "failed" ? "out" : ""}`}>{r.status === "failed" ? "失敗" : "飛ばした"}</span>}</td>
                    <td className="faint">
                      {r.reason ?? ""}
                      {doc && issueResult?.find((x) => x.documentId === doc.id)?.reason}
                      {doc && sendResult?.find((x) => x.documentId === doc.id)?.reason}
                      {doc && sendResult?.find((x) => x.documentId === doc.id)?.sent && `送付：${sendResult.find((x) => x.documentId === doc.id)?.to?.join(", ")}`}
                    </td>
                    <td>{doc && <button className="btn btn-sm" onClick={() => onOpenDocument(doc.id)}>開く</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="panel-bd stack">
          <div className="row">
            <button className="btn primary" disabled={busy || !batch.documents.some((d) => d.status === "draft")}
                    onClick={() => void issueAll()}>
              下書き {batch.documents.filter((d) => d.status === "draft").length} 件をまとめて決定
            </button>
            <button className="btn" disabled={busy || !batch.documents.some((d) => d.phase === "decided")}
                    onClick={() => void sendAll()}>
              決定済み {batch.documents.filter((d) => d.phase === "decided").length} 件をまとめて送る（取引先へ、担当者を cc）
            </button>
            <span className="faint">1枚ずつ採番され、1社ずつ案件のやり取りに残ります。失敗した束は理由が右の列に出ます</span>
          </div>
          {issueResult && (
            <div className={issueResult.every((r) => r.ok) ? "note ok" : "note warn"}>
              決定 {issueResult.filter((r) => r.ok).length} 件
              {issueResult.filter((r) => r.ok).map((r) => ` ${r.documentNo}`).join("、")}
              {issueResult.some((r) => !r.ok) && `。決定できなかったもの ${issueResult.filter((r) => !r.ok).length} 件（理由は表に）`}
            </div>
          )}
          {sendResult && (
            <div className={sendResult.every((r) => r.sent) ? "note ok" : "note warn"}>
              送付 {sendResult.filter((r) => r.sent).length} 件
              {sendResult.some((r) => !r.sent) && `。送れなかったもの ${sendResult.filter((r) => !r.sent).length} 件（理由は表に）`}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function GroupRows(
  { g, chosen, chosenWork, onChoose, onChooseWork }: {
    g: Group; chosen?: number; chosenWork?: number;
    onChoose: (id: number) => void; onChooseWork: (id: number) => void;
  }
) {
  const tone = TONE[g.action];
  // 作品は書いていないことがある（作品に紐づかない委託）。それは誤りではない。
  const workTone = g.workResolution === "resolved" ? "ok"
    : g.workResolution === "none" ? "" : g.workResolution === "ambiguous" ? "warn" : "out";
  return (
    <>
      <tr className={g.action === "skip" ? "older" : ""}>
        <td colSpan={2}>
          <span className={`tag ${g.resolution === "resolved" ? "ok" : g.resolution === "ambiguous" ? "warn" : "out"}`}>{RES_LABEL[g.resolution]}</span>
          {" "}<b>{g.party?.name ?? g.partyName ?? "（取引先なし）"}</b>
          {(g.party?.partyCode ?? g.partyCode) && <span className="code faint">　{g.party?.partyCode ?? g.partyCode}</span>}
          {g.resolution === "ambiguous" && (
            <div className="row" style={{ marginTop: 4, flexWrap: "wrap" }}>
              {g.candidates.map((c) => (
                <button key={c.id} type="button" className="chip" aria-pressed={chosen === c.id} onClick={() => onChoose(c.id)}>
                  {c.partyCode ?? "—"} {c.name}
                </button>
              ))}
            </div>
          )}
          {/* どの作品の束かを、取引先と同じ行に出す。ここが分からないと
              「同じ取引先の束が2つある」だけの表になる。 */}
          <div className="row" style={{ marginTop: 3, gap: 6 }}>
            <span className={`tag ${workTone}`}>{WORK_LABEL[g.workResolution]}</span>
            <span>
              {g.work?.title ?? g.workTitle ?? (g.workResolution === "none" ? "—" : "")}
              {(g.work?.workCode ?? g.workCode) && (
                <span className="code faint">　{g.work?.workCode ?? g.workCode}</span>
              )}
            </span>
          </div>
          {g.workResolution === "ambiguous" && (
            <div className="row" style={{ marginTop: 4, flexWrap: "wrap" }}>
              {g.workCandidates.map((w) => (
                <button key={w.id} type="button" className="chip" aria-pressed={chosenWork === w.id}
                        onClick={() => onChooseWork(w.id)}>
                  {w.workCode ?? "—"} {w.title}
                </button>
              ))}
            </div>
          )}
          {g.issues.length > 0 && <div className="faint" style={{ marginTop: 3 }}>{g.issues.join("／")}</div>}
        </td>
        <td colSpan={2} className="faint">{g.rows.length} 品目 → {g.action === "skip" ? "飛ばす" : "発注書 1 枚"}</td>
        <td className="num">{money(g.total)}</td>
        <td></td><td></td>
        <td>
          {g.condition.mode === "existing"
            ? <><span className="src auto">既存</span> <span className="code faint">{g.condition.conditionNo}</span></>
            : g.party ? <><span className="src auto">新規</span> <span className="faint">条件を作る</span></> : <span className="faint">—</span>}
        </td>
        <td><span className={`tag ${tone}`}>{ACTION_LABEL[g.action]}</span></td>
      </tr>
      {g.rows.map((r) => (
        <tr key={r.line} className={g.action === "skip" ? "older" : ""}>
          <td className="faint">{r.line}</td>
          <td>{String(r.item.item_name ?? "")}{r.item.spec ? <div className="faint">{String(r.item.spec)}</div> : null}
            {r.issues.length > 0 && <div className="bad">{r.issues.join("／")}</div>}</td>
          <td className="num">{String(r.item.quantity ?? "")}</td>
          <td className="num">{money(r.item.unit_price as number | null)}</td>
          <td className="num">{money(r.amount)}</td>
          <td className="code">{String(r.item.delivery_date ?? "—")}</td>
          <td>{String(r.item.deliverable_ownership ?? "—")}</td>
          <td></td><td></td>
        </tr>
      ))}
    </>
  );
}
