import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import type { ConditionDetail } from "../server/core/model.js";
import { ListSearch, useDebounced } from "./ListTools.js";

/**
 * 共著の取り分（A-068。docs/royalty-shares.md）。
 *
 * 作品に対する許諾料率は条件明細 1 本（全体率）が持つ。当社から複数の権利者へ
 * 直接払う作品だけ、ここで「誰に何 %」を入れる。計算書は受取人ごとに 1 枚になり、
 * 全体額を四捨五入で割る（合計は全体を超えない）。
 *
 * 入れ方は 2 つ。契約書は「B 10%・C 5%」と料率で書くので、既定は料率で入れる
 * （全体率との比に直して保存する）。全体率が無い条件や、比で決めた契約は比率で。
 *
 * 代表 1 者が受け取って自分で分配する契約は、ここには何も入れない（相手先 1 者が
 * 100% を受け取る）。買い切りは定額の条件 1 本で持つので、ここは関係ない。
 */

type Row = { partyId: number; name: string; value: string; note: string };
type Mode = "rate" | "share";
/** 分配を誰がするか（A-070）。 */
type Distribution = "direct" | "representative";

const TOTAL = 1_000_000;
const num = (s: string) => Number(String(s).replace(/[^0-9.]/g, ""));
const fmt = (ppm: number) => String(Math.round(ppm / 100) / 100);           // 666667 → "66.67"
const fmtRate = (ppm: number, wholePpm: number) => String(Math.round(wholePpm * ppm / TOTAL / 100) / 100); // 料率 %

/** 行の入力 → 百万分率。料率で入れたときは全体率との比。合計が 100% になるように端数は最後の行に寄せる。 */
function toPpm(rows: Row[], mode: Mode, wholePpm: number | null): number[] {
  const raw = rows.map((r) => {
    const v = num(r.value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (mode === "share") return Math.round(v * 10000);
    return wholePpm ? Math.round((v * 10000 / wholePpm) * TOTAL) : 0;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  // 料率の比は割り切れない（10/15）。合計が 100% から数 ppm ずれるだけなら最後の行で合わせる。
  if (mode === "rate" && raw.length && sum > 0 && Math.abs(sum - TOTAL) <= raw.length * 2) {
    raw[raw.length - 1] += TOTAL - sum;
  }
  return raw;
}

export function ConditionShares(
  { detail, onDone, canWrite }: { detail: ConditionDetail; onDone: () => void; canWrite: boolean }
) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Mode>(detail.ratePpm ? "rate" : "share");
  const [distribution, setDistribution] = useState<Distribution>(detail.distribution ?? "direct");
  /** 同じ作品の他の料率条件（紙・電子）にも同じ按分を入れる。紙と電子で按分は同じ契約がふつう。 */
  const [applyToWork, setApplyToWork] = useState(true);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [parties, setParties] = useState<Array<{ id: number; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applicable = detail.direction === "in" && detail.kind === "license" && detail.pricingModel === "revenue_rate";
  const shares = detail.shares ?? [];
  const whole = detail.ratePpm ?? null;

  useEffect(() => {
    if (!editing) return;
    const q = search.trim();
    api.get<{ parties: Array<{ id: number; name: string }> }>(`/parties${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setParties(r.parties.slice(0, 20))).catch(() => setParties([]));
  }, [editing, search]);

  const valueOf = (ppm: number, m: Mode) => (m === "share" || !whole ? fmt(ppm) : fmtRate(ppm, whole));

  function start() {
    const m: Mode = whole ? "rate" : "share";
    setMode(m);
    setDistribution(detail.distribution ?? "direct");
    setRows(shares.length
      ? shares.map((s) => ({ partyId: s.partyId, name: s.partyName, value: valueOf(s.sharePpm, m), note: s.note ?? "" }))
      // 空から始めるときは相手先を 1 行目に置く（たいてい代表＝相手先が 1 人目）。
      : detail.counterparty ? [{ partyId: detail.counterparty.id, name: detail.counterparty.name, value: "", note: "" }] : []);
    setEditing(true); setError(null); setKeyword("");
  }

  /** 入れ方を切り替える。打った値は同じ取り分のまま、もう片方の表し方に直す。 */
  function switchMode(next: Mode) {
    if (next === mode) return;
    const ppm = toPpm(rows, mode, whole);
    setRows(rows.map((r, i) => ({ ...r, value: ppm[i] > 0 ? valueOf(ppm[i], next) : "" })));
    setMode(next);
  }

  function add(p: { id: number; name: string }) {
    if (rows.some((r) => r.partyId === p.id)) return;
    setRows([...rows, { partyId: p.id, name: p.name, value: "", note: "" }]);
    setKeyword("");
  }

  const ppm = toPpm(rows, mode, whole);
  const total = ppm.reduce((a, b) => a + b, 0);
  const rateSum = rows.reduce((a, r) => a + (num(r.value) || 0), 0);
  const representativeIn = !detail.counterparty || rows.some((r) => r.partyId === detail.counterparty!.id);
  const ok = rows.length >= 2 && total === TOTAL && (distribution === "direct" || representativeIn);

  async function save(clear = false) {
    setBusy(true); setError(null);
    try {
      const r = await api.put<{ changed: Array<{ target: string; rows: number }> }>(`/conditions/${detail.id}/shares`, {
        shares: clear ? [] : rows.map((r, i) => ({ partyId: r.partyId, sharePpm: ppm[i], note: r.note.trim() || null })),
        distribution: clear ? null : distribution,
        applyToWork: Boolean(detail.work) && applyToWork
      });
      setApplied(r.changed.filter((c) => c.target.startsWith("condition_shares:")).map((c) => c.target.slice("condition_shares:".length)));
      setEditing(false); onDone();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (!applicable && !shares.length) return null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>取り分（共著）</h2>
        <span className="faint">
          {!shares.length
            ? "相手先 1 者が 100%"
            : detail.distribution === "representative"
            ? `代表（${detail.counterparty?.name ?? "相手先"}）が受け取って分配する。計算書と支払は相手先 1 件で、取り分は契約の記録`
            : "当社から受取人ごとに直接払う。計算書は受取人ごとに 1 枚"}
        </span>
        {canWrite && applicable && !editing && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={start}>
            {shares.length ? "直す" : "取り分を入れる"}
          </button>
        )}
      </div>
      {!editing && applied && (
        <div className="panel-bd">
          <div className="note ok">
            {applied.length ? `同じ作品の ${applied.join("・")} にも同じ按分を入れました` : "この作品の他の料率条件はありません（この条件だけ）"}
          </div>
        </div>
      )}
      {!editing && shares.length > 0 && (
        <div className="panel-bd">
          <table>
            <thead><tr><th>受取人</th><th className="num">料率（全体 {whole === null ? "—" : `${whole / 10000}%`} のうち）</th><th className="num">取り分</th><th>備考</th></tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.partyId}>
                  <td>{s.partyName}{s.partyKind === "individual" ? <span className="faint">（個人・源泉）</span> : ""}</td>
                  <td className="num">{whole === null ? "—" : `${fmtRate(s.sharePpm, whole)}%`}</td>
                  <td className="num faint">{fmt(s.sharePpm)}%</td>
                  <td className="faint">{s.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <div className="panel-bd stack">
          {error && <div className="alert">{error}</div>}
          <div className="row" style={{ gap: 6 }}>
            <span className="faint">分配するのは</span>
            <button className="chip" aria-pressed={distribution === "direct"} onClick={() => setDistribution("direct")}
                    title="当社が受取人ごとに直接払う。計算書は受取人ごとに 1 枚、支払も受取人ごと">
              当社（受取人ごとに計算書）
            </button>
            <button className="chip" aria-pressed={distribution === "representative"} onClick={() => setDistribution("representative")}
                    title="代表（条件の相手先）が全額を受け取って自分で分配する。計算書と支払は相手先 1 件。取り分は契約の記録として持つ">
              代表（{detail.counterparty?.name ?? "相手先"}）が分配
            </button>
            {distribution === "representative" && !representativeIn && (
              <span className="bad">代表（{detail.counterparty?.name}）を取り分の中に入れてください</span>
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <span className="faint">入れ方</span>
            <button className="chip" aria-pressed={mode === "rate"} disabled={!whole} onClick={() => switchMode("rate")}
                    title="契約書の書き方。B 10%・C 5% のように、全体の料率を分けた率で入れる">
              料率で（全体 {whole === null ? "—" : `${whole / 10000}%`} を分ける）
            </button>
            <button className="chip" aria-pressed={mode === "share"} onClick={() => switchMode("share")}
                    title="全体額を何対何で分けるか。75% / 25% のように">比率で（合計 100%）</button>
          </div>
          <table>
            <thead><tr><th>受取人</th><th className="num">{mode === "rate" ? "料率（%）" : "取り分（%）"}</th><th>備考</th><th></th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.partyId}>
                  <td>{r.name}</td>
                  <td className="num">
                    <input value={r.value} style={{ width: 80, textAlign: "right" }} placeholder={mode === "rate" ? "10" : "60"}
                           onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                    {mode === "rate" && ppm[i] > 0 && <small className="faint" style={{ marginLeft: 6 }}>取り分 {fmt(ppm[i])}%</small>}
                    {mode === "share" && whole !== null && ppm[i] > 0 && <small className="faint" style={{ marginLeft: 6 }}>料率 {fmtRate(ppm[i], whole)}%</small>}
                  </td>
                  <td>
                    <input value={r.note} placeholder="契約書の条項など"
                           onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} />
                  </td>
                  <td><button className="btn btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>外す</button></td>
                </tr>
              ))}
              <tr>
                <td className="faint">合計</td>
                <td className={`num ${ok ? "" : "bad"}`}>
                  {mode === "rate" ? `${Math.round(rateSum * 10000) / 10000}%` : `${total / 10000}%`}
                </td>
                <td colSpan={2} className="faint">
                  {ok ? "" : mode === "rate"
                    ? `全体の料率 ${whole === null ? "—" : `${whole / 10000}%`} と同じにしてください`
                    : "100% にしてください"}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword} placeholder="名称・カナ・別名" label="受取人を足す" />
          </div>
          {keyword.trim() && (
            <div className="picker">
              {parties.filter((p) => !rows.some((r) => r.partyId === p.id)).map((p) => (
                <button key={p.id} className="btn btn-sm" style={{ textAlign: "left" }} onClick={() => add(p)}>{p.name}</button>
              ))}
              {!parties.length && <span className="faint">見つかりません</span>}
            </div>
          )}
          {detail.work && (
            <label className="ledger-check">
              <input type="checkbox" checked={applyToWork} onChange={(e) => setApplyToWork(e.target.checked)} />
              この作品の他の料率条件（紙・電子）にも同じ按分を入れる（比率は同じ、料率はそれぞれの全体率で変わる。取り分を外すときも揃える）
            </label>
          )}
          <div className="row">
            <button className="btn primary btn-sm" disabled={busy || !ok} onClick={() => void save()}>保存</button>
            {shares.length > 0 && (
              <button className="btn btn-sm" disabled={busy} onClick={() => void save(true)}>取り分を外す（相手先 1 者に戻す）</button>
            )}
            <button className="btn btn-sm" onClick={() => setEditing(false)}>やめる</button>
          </div>
          <p className="faint" style={{ margin: 0 }}>
            {distribution === "representative"
              ? "代表が分配する契約では、計算書は相手先 1 枚・支払も 1 件のままです。取り分は契約の記録として持ち、紙や支払には使いません。"
              : "料率で入れても、保存するのは全体率との比（取り分）です。計算書は 売上 × 全体率 を出してから取り分で割ります。" +
                "四捨五入し、合計が全体を超えたぶんは繰り上げの大きい行から 1 円ずつ引きます。決定済みの計算書は変わりません。"}
          </p>
        </div>
      )}
    </div>
  );
}
