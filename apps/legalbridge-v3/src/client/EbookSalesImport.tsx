import { useEffect, useMemo, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { useDebounced } from "./ListTools.js";

/**
 * 電子書籍売上の取込（A-069。docs/royalty-shares.md §5）。
 *
 * 事業部の月次 Excel をそのまま入れる。読む → 突合（作品・条件・登録済み）→ 登録 の
 * 3 段で、登録の前に必ず突合の表を見せる。作品が分からない行（CID が未登録）は
 * その場で作品を当てる。当てた結果は覚えるので、翌月からは自動で当たる。
 */

interface Row { sheet: string; line: number; month: string; title: string; cid: string | null; [k: string]: unknown }
type Status = "ok" | "duplicate" | "no_royalty" | "no_condition" | "unresolved" | "zero";
interface Group {
  key: string; cid: string | null; title: string; authors: string | null; month: string;
  listPrice: number; downloads: number; gross: number; stores: string[]; lines: number;
  status: Status; message: string | null;
  work: { id: number; title: string; workCode: string | null; via: "cid" | "title" } | null;
  condition: { id: number; conditionNo: string | null; ratePpm: number | null; counterparty: string | null; shares: string[] } | null;
  royalty: number | null; royaltyInFile: number | null;
  candidates: Array<{ id: number; title: string; workCode: string | null }>;
}
interface Preview { groups: Group[]; counts: Record<Status, number>; months: string[] }
interface ReadResult { rows: Row[]; sheets: Array<{ name: string; rows: number; note: string | null }> }

const STATUS: Record<Status, { label: string; tag: string }> = {
  ok: { label: "登録できる", tag: "ok" },
  duplicate: { label: "登録済み", tag: "" },
  no_royalty: { label: "印税なし", tag: "" },
  no_condition: { label: "条件なし", tag: "warn" },
  unresolved: { label: "作品が未決定", tag: "out" },
  zero: { label: "0", tag: "" }
};

export function EbookSalesImport() {
  const readOnly = useReadOnly();
  const [file, setFile] = useState<File | null>(null);
  const [read, setRead] = useState<ReadResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");
  const [month, setMonth] = useState<string>("all");
  const [result, setResult] = useState<{ written: number; results: Array<{ key: string; status: string; message: string | null }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(f: File) {
    setBusy("読んでいます"); setError(null); setResult(null); setPreview(null);
    try {
      const r = await api.postRaw<ReadResult>(
        `/imports/ebook-sales/parse?filename=${encodeURIComponent(f.name)}`, f,
        f.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      setRead(r);
      await refresh(r.rows);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function refresh(rows: Row[]) {
    setBusy("突き合わせています");
    try { setPreview(await api.post<Preview>("/imports/ebook-sales/preview", { rows })); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function commit() {
    if (!read) return;
    setBusy("登録しています"); setError(null);
    try {
      const keys = (preview?.groups ?? []).filter((g) => g.status === "ok" && (month === "all" || g.month === month)).map((g) => g.key);
      const r = await api.post<{ written: number; results: Array<{ key: string; status: string; message: string | null }>; preview: Preview }>(
        "/imports/ebook-sales/commit", { rows: read.rows, onlyKeys: keys });
      setResult({ written: r.written, results: r.results });
      setPreview(r.preview);
      await refresh(read.rows);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const shown = useMemo(() => (preview?.groups ?? [])
    .filter((g) => filter === "all" || g.status === filter)
    .filter((g) => month === "all" || g.month === month), [preview, filter, month]);
  const okTotal = (preview?.groups ?? []).filter((g) => g.status === "ok" && (month === "all" || g.month === month));
  const sum = (xs: Group[], f: (g: Group) => number | null) => xs.reduce((a, g) => a + (f(g) ?? 0), 0);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>電子書籍売上の取込</h2>
        <span className="faint">事業部の月次 Excel（販売月・タイトル・CID・販売価格・DL数）をそのまま。作品の電子出版の条件に実績が立ちます</span>
      </div>
      <div className="panel-bd stack">
        <div className="row">
          <input type="file" accept=".xlsx,.csv" disabled={Boolean(busy)}
                 onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f) void load(f); }} />
          {file && <span className="faint">{file.name}</span>}
          {busy && <span className="faint">{busy}…</span>}
        </div>
        {error && <div className="alert">{error}</div>}
        {read && (
          <div className="faint">
            読んだシート：{read.sheets.map((s) => `${s.name}（${s.rows} 行${s.note ? `・${s.note}` : ""}）`).join("、")}
          </div>
        )}
        {preview && (
          <>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {(["all", "ok", "unresolved", "no_condition", "no_royalty", "duplicate", "zero"] as const).map((s) => (
                <button key={s} className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>
                  {s === "all" ? `すべて ${preview.groups.length}` : `${STATUS[s].label} ${preview.counts[s]}`}
                </button>
              ))}
              <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ marginLeft: "auto" }}>
                <option value="all">全部の月</option>
                {preview.months.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>販売月</th><th>タイトル</th><th>CID</th><th>作品 → 条件</th><th className="num">価格</th>
                      <th className="num">DL</th><th className="num">報告売上</th><th className="num">印税（見込み）</th>
                      <th className="num" title="事業部の Excel が出していた印税">Excel</th><th>判定</th></tr>
                </thead>
                <tbody>
                  {shown.map((g) => (
                    <tr key={g.key}>
                      <td className="code">{g.month}</td>
                      <td>{g.title}<div className="faint" style={{ fontSize: "0.85em" }}>{g.authors ?? ""}</div></td>
                      <td className="code faint">{g.cid ?? "—"}</td>
                      <td>
                        {g.work ? <>{g.work.title}{g.work.via === "title" && <span className="faint">（題名で当てた）</span>}</> : <span className="faint">—</span>}
                        {g.condition && (
                          <div className="faint" style={{ fontSize: "0.85em" }}>
                            {g.condition.conditionNo ?? `#${g.condition.id}`} · {g.condition.counterparty ?? ""} · {g.condition.ratePpm === null ? "" : `${g.condition.ratePpm / 10000}%`}
                            {g.condition.shares.length > 0 && <> · 取り分 {g.condition.shares.join("・")}</>}
                          </div>
                        )}
                        {g.status === "unresolved" && !readOnly && g.cid && read && (
                          <WorkPicker cid={g.cid} title={g.title} candidates={g.candidates}
                                      onMapped={() => void refresh(read.rows)} onError={setError} />
                        )}
                      </td>
                      <td className="num">{money(g.listPrice)}</td>
                      <td className="num">{g.downloads}</td>
                      <td className="num">{money(g.gross)}</td>
                      <td className="num">{g.royalty === null ? "—" : money(g.royalty)}</td>
                      <td className={`num faint${g.royalty !== null && g.royaltyInFile !== null && g.royalty !== g.royaltyInFile ? " bad" : ""}`}>
                        {g.royaltyInFile === null ? "—" : money(g.royaltyInFile)}
                      </td>
                      <td>
                        <span className={`tag ${STATUS[g.status].tag}`}>{STATUS[g.status].label}</span>
                        {g.message && <div className="faint" style={{ fontSize: "0.85em" }}>{g.message}</div>}
                      </td>
                    </tr>
                  ))}
                  {!shown.length && <tr><td colSpan={10} className="faint">該当なし</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button className="btn primary" disabled={readOnly || Boolean(busy) || !okTotal.length} onClick={() => void commit()}>
                {okTotal.length} 件を実績として登録する（報告売上 {money(sum(okTotal, (g) => g.gross))}・印税見込み {money(sum(okTotal, (g) => g.royalty))}）
              </button>
              <span className="faint">
                登録済み・印税なし・作品未決定の行は入りません。印税の額は計算書を出すときに条件の料率で計算し直します（取り分もそこで割ります）
              </span>
            </div>
          </>
        )}
        {result && (
          <div className="note ok">
            {result.written} 件を登録しました。
            {result.results.filter((r) => r.status === "error").length > 0 && (
              <ul>{result.results.filter((r) => r.status === "error").map((r) => <li key={r.key}>{r.key}：{r.message}</li>)}</ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** CID の作品を決める。候補（同名）があればそれ、無ければ作品を探す。 */
function WorkPicker(
  { cid, title, candidates, onMapped, onError }: {
    cid: string; title: string; candidates: Array<{ id: number; title: string; workCode: string | null }>;
    onMapped: () => void; onError: (m: string) => void;
  }
) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [works, setWorks] = useState<Array<{ id: number; title: string; workCode: string | null }>>(candidates);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const q = search.trim();
    if (!q) { setWorks(candidates); return; }
    api.get<{ works: Array<{ id: number; title: string; workCode: string | null }> }>(`/works?q=${encodeURIComponent(q)}`)
      .then((r) => setWorks(r.works.slice(0, 20))).catch(() => setWorks([]));
  }, [open, search]);

  async function map(workId: number) {
    setBusy(true);
    try { await api.put("/imports/ebook-sales/codes", { cid, workId, title }); setOpen(false); onMapped(); }
    catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!open) return <button className="btn btn-sm" onClick={() => { setOpen(true); setKeyword(""); }}>作品を当てる</button>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input value={keyword} placeholder="作品名で探す" onChange={(e) => setKeyword(e.target.value)} autoFocus />
      <div className="picker">
        {works.map((w) => (
          <button key={w.id} className="btn btn-sm" disabled={busy} style={{ textAlign: "left" }} onClick={() => void map(w.id)}>
            {w.title}{w.workCode ? <span className="faint code"> {w.workCode}</span> : null}
          </button>
        ))}
        {!works.length && <span className="faint">見つかりません</span>}
      </div>
      <button className="btn btn-sm" onClick={() => setOpen(false)}>やめる</button>
    </div>
  );
}
