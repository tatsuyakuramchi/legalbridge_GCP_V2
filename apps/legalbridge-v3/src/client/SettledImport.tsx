import { useEffect, useState } from "react";
import { api, ApiError, money, saveCsv } from "./api.js";
import { SearchSelect, type SearchOption } from "./SearchSelect.js";
import type { SettledDiff } from "../server/documents/settled-diff.js";

/**
 * 決済済みの一括取込（遡及）。
 *
 * 検収まで終わっていて支払だけが残っている過去の取引を、CSV から一度に
 * 台帳へ入れる。1束（同じ取引先・作品・条件名）から
 *
 *   条件 → 予定明細 → 発注書（決定）→ 実績 → 検収書（決定）→ 支払
 *
 * まで作る。発注書の一括作成（BulkOrders）と違って、ここは**押した瞬間に
 * 番号が振られる**。下書きで止めて確かめる余地が無いので、
 *
 *   1. 試算を必ず先に見せる（何も作らない）
 *   2. 使うことになる番号を、流す前に出す
 *   3. 確認は「取り消せない」と書いたうえで取る
 *
 * の3つを画面の側で受け持つ。
 */

interface Candidate { id: number; name: string; partyCode: string | null }
interface WorkCandidate { id: number; title: string; workCode: string | null }

interface Row {
  line: number;
  item: Record<string, unknown>;
  quantity: number;
  inspectedQuantity: number;
  orderedAmount: number;
  inspectedAmount: number;
  deliveredOn: string | null;
  issues: string[];
}

interface Group {
  key: string;
  partyCode: string | null; partyName: string | null;
  workCode: string | null; workTitle: string | null; conditionName: string | null;
  resolution: "resolved" | "ambiguous" | "missing";
  party: Candidate | null; candidates: Candidate[];
  workResolution: "none" | "resolved" | "ambiguous" | "missing";
  work: WorkCandidate | null; workCandidates: WorkCandidate[];
  condition: {
    mode: "existing" | "new"; id: number | null; conditionNo: string | null;
    agreement: { id: number; agreementNo: string | null; title: string | null } | null;
    agreementNote: string | null; schedules: number;
  };
  orderedOn: string | null; inspectedOn: string | null;
  dueOn: string | null; paymentState: "planned" | "paid" | "none"; paidOn: string | null;
  specialTerms: string | null; specialTermsNote: string | null;
  rows: Row[];
  orderedTotal: number; inspectedTotal: number;
  issues: string[];
  action: "create" | "choose" | "skip";
}

interface NumberPeek {
  templateKey: string; prefix: string; year: number;
  from: string; to: string; count: number;
}

interface Preview {
  groups: Group[];
  numbers: NumberPeek[];
  summary: {
    rows: number; groups: number; creatable: number; skipped: number; choose: number;
    events: number; payments: number; paymentTotal: number;
  };
}

interface ResultEntry {
  key: string; partyName: string | null;
  status: "created" | "skipped" | "failed";
  reason?: string; stage?: string;
  conditionNo?: string | null;
  orderDocumentId?: number; orderDocumentNo?: string | null;
  inspectionDocumentId?: number; inspectionDocumentNo?: string | null;
  eventIds?: number[];
  paymentNo?: string | null; paymentState?: "planned" | "paid" | "none";
}

interface Batch {
  id: number; matterId: number | null; sourceFilename: string | null;
  rowCount: number; createdBy: string | null; createdAt: string;
  result: ResultEntry[];
}

interface BatchHead {
  id: number; sourceFilename: string | null; createdAt: string;
  created: number; skipped: number; failed: number;
}

const searchMatters = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ matters: Array<{ id: number; matterNo: string | null; title: string; status: string }> }>(
    `/matters?q=${encodeURIComponent(q)}`);
  return r.matters.map((m) => ({
    value: String(m.id), label: `${m.matterNo ?? `#${m.id}`} ${m.title}`, hint: m.status
  }));
};

/** ブラウザで文字コードを判定して読む。UTF-8 で化けたら Shift_JIS で読み直す。 */
export async function readCsv(file: File): Promise<string> {
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
const TEMPLATE_LABEL: Record<string, string> = {
  purchase_order: "発注書", inspection_certificate: "検収書"
};

export function SettledImport(
  { initialMatterId, onOpenDocument, onClose, onCreated }: {
    initialMatterId?: number | null;
    onOpenDocument: (id: number) => void;
    onClose: () => void;
    onCreated: (batchId: number) => void;
  }
) {
  const [matterId, setMatterId] = useState(initialMatterId ? String(initialMatterId) : "");
  /** 現物の書き出し。人に決めてもらうことは CSV に出せないので画面に出す。 */
  const [exporting, setExporting] = useState(false);
  const [notes, setNotes] = useState<Array<{ conditionNo: string | null;
                                             conditionName: string; note: string }>>([]);
  const [allNotes, setAllNotes] = useState(false);
  /** いまの現物との差。上げ直す前に「どこを直したか」を出す。 */
  const [diff, setDiff] = useState<SettledDiff | null>(null);
  const [allSame, setAllSame] = useState(false);

  async function exportMatter() {
    if (!matterId) return;
    setExporting(true); setError(null); setNotes([]); setAllNotes(false);
    try {
      const made = await api.get<{
        matter: { matterNo: string | null };
        rows: unknown[];
        notes: Array<{ conditionNo: string | null; conditionName: string; note: string }>;
        csv: string;
      }>(`/matters/${matterId}/settled-export`);
      saveCsv(made.csv, `settled_${made.matter.matterNo ?? matterId}.csv`);
      setNotes(made.notes);
    } catch (e) { setError((e as ApiError).message); }
    finally { setExporting(false); }
  }
  const [matterLabel, setMatterLabel] = useState<string | null>(null);
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [workChoices, setWorkChoices] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [recent, setRecent] = useState<BatchHead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = matterId ? `?matterId=${matterId}` : "";
    api.get<{ batches: BatchHead[] }>(`/documents/batches/settled${q}`)
      .then((r) => setRecent(r.batches)).catch(() => undefined);
  }, [batch?.id, matterId]);

  useEffect(() => {
    if (!initialMatterId) return;
    api.get<{ matterNo: string | null; title: string }>(`/matters/${initialMatterId}`)
      .then((m) => setMatterLabel(`${m.matterNo ?? `#${initialMatterId}`} ${m.title}`))
      .catch(() => setMatterLabel(`#${initialMatterId}`));
  }, [initialMatterId]);

  // CSV と案件と候補の選択が揃うたびに試算し直す。何も作らない。
  // 差分は試算と別に引く。試算は「何ができるか」、差分は「もとと何が違うか」。
  useEffect(() => {
    if (!csv || !matterId) { setDiff(null); return; }
    let live = true;
    api.post<SettledDiff>("/documents/batches/settled/diff",
      { matterId: Number(matterId), csv: csv.text })
      .then((d) => { if (live) { setDiff(d); setAllSame(false); } })
      // 差分が引けなくても取り込みは止めない（現物が無い案件もある）。
      .catch(() => { if (live) setDiff(null); });
    return () => { live = false; };
  }, [csv, matterId]);

  useEffect(() => {
    if (!csv || !matterId) { setPreview(null); return; }
    let live = true;
    setError(null);
    api.post<Preview>("/documents/batches/settled/preview",
      { matterId: Number(matterId), csv: csv.text, choices, workChoices })
      .then((r) => { if (live) setPreview(r); })
      .catch((e: ApiError) => { if (live) { setPreview(null); setError(e.message); } });
    return () => { live = false; };
  }, [csv, matterId, JSON.stringify(choices), JSON.stringify(workChoices)]);

  async function run() {
    if (!csv || !matterId || !preview) return;
    const numbers = preview.numbers
      .map((n) => `${TEMPLATE_LABEL[n.templateKey] ?? n.templateKey} ${n.from}${n.count > 1 ? `〜${n.to}` : ""}`)
      .join("\n");
    // 取り消せない操作なので、何が起きるかを数で出してから確認を取る。
    if (!window.confirm(
      `${preview.summary.creatable} 件ぶんを台帳に入れます。\n\n`
      + `・条件と予定明細\n`
      + `・発注書と検収書（決定済み・番号が振られます）\n`
      + `・実績 ${preview.summary.events} 件\n`
      + (preview.summary.payments
        ? `・支払 ${preview.summary.payments} 件（合計 ${preview.summary.paymentTotal.toLocaleString()} 円）\n\n`
        : `・支払は立てません\n\n`)
      + `使う番号（見込み）:\n${numbers}\n\n`
      + `決定した文書は取り消せません。間違えたときは無効化するしかありません。進めますか。`)) return;
    setBusy(true); setError(null);
    try {
      const b = await api.post<Batch>("/documents/batches/settled",
        { matterId: Number(matterId), csv: csv.text, filename: csv.name, choices, workChoices });
      setBatch(b); setPreview(null); setCsv(null);
      onCreated(b.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function open(id: number) {
    setError(null);
    try { setBatch(await api.get<Batch>(`/documents/batches/settled/${id}`)); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>検収済みをまとめて入れる（CSV）</h2>
        <span className="faint">条件・発注書・実績・検収書・支払を一度に</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>

      <div className="panel-bd stack">
        <div className="note">
          もう検収まで終わっていて、支払だけが残っている取引を入れるための口です。
          <b>発注書と検収書は決定済みで作られ、番号が振られます。</b>
          これから出す発注書を作るなら「発注書をまとめて作る」のほうを使ってください。
        </div>

        {error && <div className="alert">{error}</div>}

        {!batch && (
          <>
            <div className="row" style={{ gap: 16, alignItems: "flex-end" }}>
              <label className="field">
                <span>案件</span>
                {initialMatterId && matterId === String(initialMatterId) ? (
                  <span className="row" style={{ gap: 8 }}>
                    <b>{matterLabel ?? `#${initialMatterId}`}</b>
                    <button className="btn btn-sm" onClick={() => setMatterId("")}>選び直す</button>
                  </span>
                ) : (
                  <SearchSelect value={matterId} onChange={setMatterId} search={searchMatters}
                                placeholder="案件番号か件名で探す" />
                )}
              </label>
              {/* 発注書の一括作成と同じく、ブラウザにそのまま取らせる。 */}
              <a className="btn btn-sm" href="/api/v3/documents/batches/settled/template.csv">
                雛形をダウンロード
              </a>
              {/*
                いま台帳にあるものを、この取り込みと同じ形で書き出す。
                「紙は出してあるが金額が一部違う。作り直したい」ときに、
                26列を手で打ち直さずに済む。読むだけで何も作らない。
              */}
              <button className="btn btn-sm" disabled={!matterId || exporting}
                onClick={() => exportMatter()}>
                {exporting ? "書き出しています…" : "この案件の現物を書き出す"}
              </button>
            </div>

            {notes.length > 0 && (
              <div className="note">
                <strong>書き出しで人に決めてもらうこと（{notes.length}）</strong>
                <ul>
                  {(allNotes ? notes : notes.slice(0, 12)).map((n, i) => (
                    <li key={i}>{n.conditionNo ?? n.conditionName}：{n.note}</li>
                  ))}
                </ul>
                {/* 案件が大きいと数十件出る。全部並べると下が読めない。 */}
                {notes.length > 12 && (
                  <button className="btn btn-sm" onClick={() => setAllNotes(!allNotes)}>
                    {allNotes ? "畳む" : `ほか ${notes.length - 12} 件を出す`}
                  </button>
                )}
              </div>
            )}

            <label className="field">
              <span>CSV</span>
              <input type="file" accept=".csv,text/csv"
                     onChange={(e) => {
                       const file = e.target.files?.[0];
                       if (!file) { setCsv(null); return; }
                       void readCsv(file).then((text) => setCsv({ name: file.name, text }));
                     }} />
              {csv && <span className="faint">{csv.name}</span>}
            </label>

            {diff && <DiffPanel diff={diff} all={allSame} onAll={setAllSame} />}

            {preview && (
              <>
                <div className="row" style={{ gap: 22 }}>
                  <div><div className="faint">行</div><div className="num">{preview.summary.rows}</div></div>
                  <div><div className="faint">束</div><div className="num">{preview.summary.groups}</div></div>
                  <div><div className="faint">作る</div>
                    <div className="num" style={{ color: "var(--ok)" }}>{preview.summary.creatable}</div></div>
                  <div><div className="faint">選ぶ</div><div className="num">{preview.summary.choose}</div></div>
                  <div><div className="faint">飛ばす</div>
                    <div className="num" style={{ color: "var(--out)" }}>{preview.summary.skipped}</div></div>
                  <div><div className="faint">実績</div><div className="num">{preview.summary.events}</div></div>
                  <div><div className="faint">支払の合計</div>
                    <div className="num">{money(preview.summary.paymentTotal, "JPY")}</div></div>
                </div>

                {preview.numbers.length > 0 && (
                  <div className="note warn">
                    <b>使う番号（見込み）</b>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                      {preview.numbers.map((n) => (
                        <li key={`${n.templateKey}-${n.year}`}>
                          {TEMPLATE_LABEL[n.templateKey] ?? n.templateKey}
                          <span className="code">{n.from}</span>
                          {n.count > 1 && <>　〜　<span className="code">{n.to}</span></>}
                          　（{n.count} 枚）
                        </li>
                      ))}
                    </ul>
                    <div className="faint" style={{ marginTop: 4 }}>
                      いま流したらこうなる、という見込みです。この間に誰かが1枚出せばずれます。
                    </div>
                  </div>
                )}

                <div className="stack">
                  {preview.groups.map((g) => (
                    <div key={g.key} className="panel">
                      <div className="panel-hd">
                        <span className={`tag ${TONE[g.action]}`}>{ACTION_LABEL[g.action]}</span>
                        <b>{g.party?.name ?? g.partyName ?? "（取引先なし）"}</b>
                        {g.work && <span className="faint">{g.work.title}</span>}
                        {g.conditionName && <span className="faint">条件名 {g.conditionName}</span>}
                        <span className="faint" style={{ marginLeft: "auto" }}>
                          {g.rows.length} 行／発注 {money(g.orderedTotal, "JPY")}
                          {g.inspectedTotal !== g.orderedTotal
                            && <>　→　検収 <b>{money(g.inspectedTotal, "JPY")}</b></>}
                        </span>
                      </div>
                      <div className="panel-bd stack">
                        <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
                          <span className="faint">{RES_LABEL[g.resolution]}</span>
                          <span className="faint">{WORK_LABEL[g.workResolution]}</span>
                          <span className="faint">
                            条件 {g.condition.mode === "existing"
                              ? `既存 ${g.condition.conditionNo ?? ""}`
                              : `新しく作る（予定 ${g.condition.schedules} 回）`}
                          </span>
                          {g.condition.agreementNote && <span className="faint">{g.condition.agreementNote}</span>}
                        </div>

                        <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
                          <span>発注日 <b>{g.orderedOn ?? "—"}</b></span>
                          <span>検収日 <b>{g.inspectedOn ?? "—"}</b></span>
                          {g.paymentState !== "none"
                            && <span>支払期日 <b>{g.dueOn ?? "（支払条件から出す）"}</b></span>}
                          <span>支払 <b>{
                            g.paymentState === "paid" ? `支払済み（${g.paidOn ?? "—"}）`
                              : g.paymentState === "none" ? "立てない（検収書まで）"
                              : "未払"
                          }</b></span>
                        </div>

                        {g.specialTerms && (
                          <div className="faint" style={{ whiteSpace: "pre-wrap" }}>
                            特約：{g.specialTerms}
                          </div>
                        )}

                        {g.resolution === "ambiguous" && (
                          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                            <span className="faint">取引先を選ぶ：</span>
                            {g.candidates.map((c) => (
                              <button key={c.id} className="btn btn-sm"
                                      aria-pressed={choices[g.key] === c.id}
                                      onClick={() => setChoices({ ...choices, [g.key]: c.id })}>
                                {c.name}{c.partyCode ? `（${c.partyCode}）` : ""}
                              </button>
                            ))}
                          </div>
                        )}
                        {g.workResolution === "ambiguous" && (
                          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                            <span className="faint">作品を選ぶ：</span>
                            {g.workCandidates.map((w) => (
                              <button key={w.id} className="btn btn-sm"
                                      aria-pressed={workChoices[g.key] === w.id}
                                      onClick={() => setWorkChoices({ ...workChoices, [g.key]: w.id })}>
                                {w.title}{w.workCode ? `（${w.workCode}）` : ""}
                              </button>
                            ))}
                          </div>
                        )}

                        <div className="tablewrap">
                          <table>
                            <thead><tr>
                              <th>行</th><th>品目</th><th>納品日</th>
                              <th className="num">数量</th><th className="num">検収数量</th>
                              <th className="num">発注額</th><th className="num">検収額</th>
                            </tr></thead>
                            <tbody>
                              {g.rows.map((r) => (
                                <tr key={r.line} className={r.issues.length ? "warn" : ""}>
                                  <td>{r.line}</td>
                                  <td>{String(r.item.item_name ?? "")}</td>
                                  <td>{r.deliveredOn ?? "—"}</td>
                                  <td className="num">{r.quantity}</td>
                                  <td className="num">
                                    {r.inspectedQuantity === r.quantity
                                      ? r.inspectedQuantity
                                      : <b>{r.inspectedQuantity}</b>}
                                  </td>
                                  <td className="num">{money(r.orderedAmount, "JPY")}</td>
                                  <td className="num">
                                    {r.inspectedAmount === r.orderedAmount
                                      ? money(r.inspectedAmount, "JPY")
                                      : <b>{money(r.inspectedAmount, "JPY")}</b>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {g.issues.length > 0 && (
                          <ul className="note warn" style={{ margin: 0, paddingLeft: 20 }}>
                            {g.issues.map((m, i) => <li key={i}>{m}</li>)}
                          </ul>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="row">
                  <button className="btn primary" disabled={busy || !preview.summary.creatable}
                          onClick={() => void run()}>
                    {busy ? "取り込み中…" : `${preview.summary.creatable} 件を台帳に入れる`}
                  </button>
                  <span className="faint">
                    {preview.summary.creatable
                      ? "押すと番号が振られます。決定した文書は取り消せません"
                      : "作れる束がありません。上の不備を直して CSV を上げ直してください"}
                  </span>
                </div>
              </>
            )}
          </>
        )}

        {batch && (
          <>
            <div className="panel-hd">
              <h3>取り込みの結果</h3>
              <span className="faint">{batch.sourceFilename ?? "—"}／{batch.rowCount} 行</span>
              <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                      onClick={() => setBatch(null)}>もう1件入れる</button>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th>取引先</th><th>条件</th><th>発注書</th><th>検収書</th>
                  <th className="num">実績</th><th>支払</th><th>結果</th>
                </tr></thead>
                <tbody>
                  {batch.result.map((r) => (
                    <tr key={r.key} className={r.status === "created" ? "" : "warn"}>
                      <td>{r.partyName ?? "—"}</td>
                      <td className="code">{r.conditionNo ?? "—"}</td>
                      <td>
                        {r.orderDocumentId
                          ? <button className="btn btn-sm" onClick={() => onOpenDocument(r.orderDocumentId!)}>
                              {r.orderDocumentNo}
                            </button>
                          : "—"}
                      </td>
                      <td>
                        {r.inspectionDocumentId
                          ? <button className="btn btn-sm" onClick={() => onOpenDocument(r.inspectionDocumentId!)}>
                              {r.inspectionDocumentNo}
                            </button>
                          : "—"}
                      </td>
                      <td className="num">{r.eventIds?.length ?? 0}</td>
                      <td>
                        {r.paymentState === "none" ? <span className="faint">立てていない</span>
                          : r.paymentNo ?? "—"}
                        {r.paymentState === "paid" && <span className="tag ok" style={{ marginLeft: 6 }}>支払済み</span>}
                      </td>
                      <td>
                        {r.status === "created" ? <span className="tag ok">入れた</span> : (
                          <>
                            <span className={`tag ${r.status === "failed" ? "out" : "warn"}`}>
                              {r.status === "failed" ? `失敗（${r.stage ?? "—"}）` : "飛ばした"}
                            </span>
                            <div className="faint">{r.reason}</div>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {batch.result.some((r) => r.status === "failed") && (
              <div className="note warn">
                途中で落ちた束があります。<b>どこまで進んだかは「失敗（…）」の括弧</b>に出ています。
                発注書まで進んでいれば、その紙は番号つきで台帳に残っています。
                残骸の片付けは「整理」から行ってください。
              </div>
            )}
          </>
        )}

        {recent.length > 0 && !preview && (
          <div className="stack">
            <div className="faint">最近の取り込み</div>
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th>ファイル</th><th>取り込んだ日</th>
                  <th className="num">入れた</th><th className="num">飛ばした</th><th className="num">失敗</th><th></th>
                </tr></thead>
                <tbody>
                  {recent.map((b) => (
                    <tr key={b.id}>
                      <td>{b.sourceFilename ?? "—"}</td>
                      <td>{b.createdAt.slice(0, 10)}</td>
                      <td className="num">{b.created}</td>
                      <td className="num">{b.skipped}</td>
                      <td className="num">{b.failed}</td>
                      <td><button className="btn btn-sm" onClick={() => void open(b.id)}>開く</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * いまの現物と、上げ直す CSV の差。
 *
 * 押すと番号を振って紙を作ってしまうので、その前に「どこを直したか」を出す。
 * 直した覚えのない列が動いていたら、そこで気づける。合計の増減をいちばん
 * 大きく出す。金額を直すために上げ直しているので、そこが本題になる。
 */
function DiffPanel({ diff, all, onAll }: {
  diff: SettledDiff; all: boolean; onAll: (v: boolean) => void;
}) {
  const { summary } = diff;
  const moved = diff.rows.filter((r) => r.kind !== "same");
  const shown = all ? diff.rows : moved;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>いまの現物との差</h2>
        <span className="faint">
          直す {summary.changed}／足す {summary.added}／消える {summary.removed}／
          そのまま {summary.same}
        </span>
      </div>
      <div className="panel-bd stack">
        <div className="row" style={{ gap: 22 }}>
          <div><div className="faint">いまの合計（税抜）</div>
            <div className="num">{money(summary.beforeTotal)}</div></div>
          <div><div className="faint">上げ直したあと</div>
            <div className="num">{money(summary.afterTotal)}</div></div>
          <div><div className="faint">増減</div>
            <div className="num" style={{
              color: summary.delta === 0 ? undefined
                : summary.delta < 0 ? "var(--out)" : "var(--ok)"
            }}>
              {summary.delta > 0 ? "+" : ""}{money(summary.delta)}
            </div></div>
        </div>

        {diff.ambiguous.length > 0 && (
          <div className="note warn">
            同じ条件に同じ品目名が2行あります（{diff.ambiguous.join("／")}）。
            どちらと比べるか決められないので、この差分には出ません。
            品目名を分けるか、上げ直したあとに目で確かめてください。
          </div>
        )}

        {!moved.length ? (
          <p className="faint">いまの現物と同じです。上げ直しても中身は変わりません。</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th></th><th>取引先／条件</th><th>品目</th><th>変わるところ</th>
                <th className="num">いま</th><th className="num">あと</th>
              </tr></thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.key} className={row.kind === "same" ? "older" : ""}>
                    <td><span className={`tag ${KIND_TONE[row.kind]}`}>{KIND_LABEL[row.kind]}</span></td>
                    <td>
                      <div>{row.partyName || "—"}</div>
                      <div className="faint">{row.conditionName}</div>
                    </td>
                    <td>{row.itemName}</td>
                    <td>
                      {row.fields.length === 0
                        ? <span className="faint">—</span>
                        : row.fields.map((f) => (
                          <div key={f.key}>
                            <span className="faint">{f.label}</span>{" "}
                            <span className="code">{f.before || "（空）"}</span>
                            {" → "}
                            <b className="code">{f.after || "（空）"}</b>
                          </div>
                        ))}
                    </td>
                    <td className="num">{row.beforeAmount === null ? "—" : money(row.beforeAmount)}</td>
                    <td className="num">{row.afterAmount === null ? "—" : money(row.afterAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {summary.same > 0 && (
          <button className="btn btn-sm" onClick={() => onAll(!all)}>
            {all ? "変わる行だけ出す" : `そのままの ${summary.same} 行も出す`}
          </button>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  changed: "直す", added: "足す", removed: "消える", same: "そのまま"
};
const KIND_TONE: Record<string, string> = {
  changed: "warn", added: "ok", removed: "out", same: "ghost"
};
