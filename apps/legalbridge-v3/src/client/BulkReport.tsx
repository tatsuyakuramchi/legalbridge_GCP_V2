import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import type { LedgerCondition } from "../server/royalty/ledger-service.js";
import { parseReportPaste, pickOut, readYen } from "../server/royalty/report-paste.js";
import { loadStageNote, saveStageNote, STAGE_NOTE_PLACEHOLDER } from "./stage-notes.js";

/**
 * 依頼文から報告をまとめて入れる（製造 1 回ぶん）。
 *
 * 依頼文を貼る → 版・言語 × 入金企業 × 前金・後金 の表になる → 許諾先・言語を当てる
 * （外れたら選び直す）→ 記録。前金・後金はそれぞれ 1 件の報告（入金区分つき）。
 * すべて同じ製造日（時限式なら同じ回）に入るので、回 1 つ・計算書 1 枚（多明細）になる。
 */

interface Out {
  id: number; name: string; partyName: string | null; partyId: number | null;
  usageType: string | null; languages: string[]; regions: string[];
}
interface Row {
  key: string; no: number; language: string; company: string;
  outId: string; lang: string; advance: string; balance: string; include: boolean;
  /** 保存済の入金区分（やり直しで二重に入れない）。 */
  saved: string[]; error: string | null;
}

export interface BulkTarget { condition: LedgerCondition; scheduleId: number | null }

const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;
const amountOf = (s: string) => readYen(s) ?? 0;

export function BulkReport({ targets, defaultDate, eventStyle, lockDate = false, onDone, onCancel, onError }: {
  /** 報告を付ける IN 条件（再許諾・自社製造・他社販売）。時限式ならその回の締め。 */
  targets: BulkTarget[];
  defaultDate: string;
  eventStyle: boolean;
  /** 日付を変えさせない（既にある回に足すとき。日付を変えると別の回になる）。 */
  lockDate?: boolean;
  onDone: (message: string, on: string) => void; onCancel: () => void; onError: (m: string) => void;
}) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [ratePct, setRatePct] = useState<number | null>(null);
  const [outs, setOuts] = useState<Out[]>([]);
  const [on, setOn] = useState(defaultDate);
  const [taxIncluded, setTaxIncluded] = useState(false);
  /** 前金・後金の説明。報告の備考に入り、計算書の備考に出る。前に書いた文を初期値にする。 */
  const [advanceNote, setAdvanceNote] = useState(() => loadStageNote("advance"));
  const [balanceNote, setBalanceNote] = useState(() => loadStageNote("balance"));
  const [busy, setBusy] = useState(false);
  const usable = targets.filter((t) => t.condition.usageType === "sublicense" || t.condition.usageType === "oem");

  // 許諾先の候補。IN 条件の利用形態ごとに引いてまとめる。
  useEffect(() => {
    let live = true;
    Promise.all(usable.map((t) => api.get<{ conditions: Out[] }>(
      `/conditions/${t.condition.id}/out-candidates?usage=${t.condition.usageType}`)
      .then((r) => r.conditions.map((o) => ({ ...o, usageType: o.usageType ?? t.condition.usageType })))))
      .then((lists) => { if (live) setOuts([...new Map(lists.flat().map((o) => [o.id, o])).values()]); })
      .catch((e: ApiError) => onError(e.message));
    return () => { live = false; };
  }, [usable.map((t) => t.condition.id).join(",")]);

  /** 許諾先に付ける IN 条件：利用形態が同じで、許諾先専用ならその許諾先のもの（専用を優先）。 */
  const inFor = (o: Out | undefined) => {
    if (!o) return null;
    const same = usable.filter((t) => t.condition.usageType === o.usageType);
    return same.find((t) => t.condition.targetPartyId && t.condition.targetPartyId === o.partyId)
      ?? same.find((t) => !t.condition.targetPartyId) ?? null;
  };

  function read() {
    const parsed = parseReportPaste(text);
    setRatePct(parsed.ratePct);
    setRows(parsed.rows.map((r, i) => {
      const hit = pickOut({ company: r.company, language: r.language }, outs);
      return {
        key: `${i}-${r.no}`, no: r.no, language: r.language, company: r.company,
        outId: hit ? String(hit.out.id) : "", lang: hit?.language ?? "",
        advance: r.advance !== null ? String(r.advance) : r.total !== null ? String(r.total) : "",
        balance: r.balance !== null ? String(r.balance) : "",
        include: true, saved: [], error: null
      };
    }));
  }
  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => r.key === key ? { ...r, ...patch } : r));

  const picked = rows.filter((r) => r.include);
  const total = picked.reduce((a, r) => a + amountOf(r.advance) + amountOf(r.balance), 0);
  const rateMismatch = useMemo(() => {
    if (ratePct === null) return [];
    return usable.filter((t) => t.condition.pricingModel === "revenue_rate"
      && t.condition.ratePpm !== null && Math.abs(t.condition.ratePpm / 10000 - ratePct) > 1e-9)
      .map((t) => `${t.condition.usageLabel} ${t.condition.ratePpm! / 10000}%`);
  }, [ratePct, usable]);
  const problems = picked.filter((r) => {
    const o = outs.find((x) => String(x.id) === r.outId);
    return !o || !inFor(o) || (o.languages.length > 0 && !o.languages.includes("全言語") && !r.lang);
  });

  async function save() {
    setBusy(true);
    let made = 0; let failed = 0;
    const next = [...rows];
    for (const [i, r] of next.entries()) {
      if (!r.include) continue;
      const o = outs.find((x) => String(x.id) === r.outId);
      const t = inFor(o);
      if (!o || !t) { next[i] = { ...r, error: "許諾先を選んでください" }; failed++; continue; }
      const stages: Array<["advance" | "balance", number]> = [["advance", amountOf(r.advance)], ["balance", amountOf(r.balance)]];
      let err: string | null = null; const saved = [...r.saved];
      for (const [stage, amount] of stages) {
        if (!(amount > 0) || saved.includes(stage)) continue;
        try {
          await api.post(`/conditions/${t.condition.id}/events`, {
            eventType: o.usageType === "sublicense" ? "sublicense_receipt" : "sales",
            occurredOn: on, scheduleId: t.scheduleId,
            grossAmount: amount, amount: 0, taxIncluded,
            usageType: o.usageType, outConditionId: o.id, paymentStage: stage,
            languages: r.lang ? [r.lang] : [],
            // 依頼文は言語ごと。地域までは分かれていないので許諾地域すべて（その言語の行をまとめて覆う）。
            regions: o.regions.filter((x) => x !== "全世界"),
            note: (stage === "advance" ? advanceNote : balanceNote).trim() || null
          });
          saved.push(stage); made++;
        } catch (e) { err = e instanceof ApiError ? e.message : String(e); failed++; }
      }
      next[i] = { ...r, saved, error: err };
    }
    setRows(next); setBusy(false);
    saveStageNote("advance", advanceNote); saveStageNote("balance", balanceNote);
    if (!failed) onDone(`${made} 件の報告を入れました（${eventStyle ? `${on} 製造の回` : "この回"}）。この回の計算書で 1 枚にまとめて出せます`, on);
    else onError(`${made} 件入れました。${failed} 件は入れられませんでした（赤い行）。直してもう一度「記録」を押すと、残りだけ入れます`);
  }

  return (
    <div className="note stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <b>依頼文からまとめて入れる</b>
        <span className="faint">版・言語 × 入金企業 × 前金・後金。すべて同じ回に入り、計算書は 1 枚（多明細）になる</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onCancel}>やめる</button>
      </div>
      {!usable.length && <div className="alert">この回には再許諾・自社製造・他社販売の条件がありません。</div>}
      <textarea rows={rows.length ? 3 : 10} value={text} placeholder={"依頼文をそのまま貼る\n1\n版・言語：英語版\n入金企業：Asmodee\n前金：¥3,739,365\n後金：¥3,564,512\n2\n…"}
                onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm primary" disabled={!text.trim() || !outs.length} onClick={read}>
          {outs.length ? "読み取る" : "許諾先を読み込んでいます…"}
        </button>
        <label className="row" style={{ gap: 4 }}><span className="faint">{eventStyle ? "製造日" : "発生日"}</span>
          {lockDate ? <b>{on}（この回）</b> : <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />}</label>
        <span className="row" style={{ gap: 4 }}>
          <span className="faint">金額は</span>
          <span className="chips" role="group" aria-label="税込・税抜">
            <button type="button" className="chip" aria-pressed={!taxIncluded} onClick={() => setTaxIncluded(false)}>税抜</button>
            <button type="button" className="chip" aria-pressed={taxIncluded} onClick={() => setTaxIncluded(true)}>税込（1.1 で割り戻す）</button>
          </span>
        </span>
      </div>
      <div className="form-grid">
        <label className="field"><span>前金の説明（計算書の備考に出る）</span>
          <input value={advanceNote} placeholder={STAGE_NOTE_PLACEHOLDER.advance} onChange={(e) => setAdvanceNote(e.target.value)} /></label>
        <label className="field"><span>後金の説明（計算書の備考に出る）</span>
          <input value={balanceNote} placeholder={STAGE_NOTE_PLACEHOLDER.balance} onChange={(e) => setBalanceNote(e.target.value)} /></label>
      </div>
      {ratePct !== null && rateMismatch.length > 0 && (
        <div className="note warn">依頼文の料率は {ratePct}% ですが、条件は {rateMismatch.join("・")} です。計算は条件の料率で行います。違うなら条件を直してください。</div>
      )}
      {rows.length > 0 && (
        <>
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th></th><th>依頼文</th><th>許諾先</th><th>言語</th>
                <th className="num">前金</th><th className="num">後金</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const o = outs.find((x) => String(x.id) === r.outId);
                  const t = inFor(o);
                  return (
                    <tr key={r.key} className={r.error ? "overdue" : ""}>
                      <td style={{ whiteSpace: "nowrap" }}><input type="checkbox" checked={r.include} onChange={(e) => set(r.key, { include: e.target.checked })} /> {r.no}</td>
                      <td style={{ maxWidth: 150 }}>
                        <div>{r.language || <span className="danger">言語なし</span>}</div><div className="faint">{r.company || "入金企業なし"}</div>
                        {r.saved.length > 0 && <span className="tag ok">入力済 {r.saved.map((x) => x === "advance" ? "前金" : "後金").join("・")}</span>}
                        {r.error && <div className="danger">{r.error}</div>}
                      </td>
                      <td>
                        <select value={r.outId} style={{ width: 220 }} title={o ? `${o.partyName ?? ""}｜${o.name}` : ""}
                                onChange={(e) => { const no = outs.find((x) => String(x.id) === e.target.value);
                                  set(r.key, { outId: e.target.value, lang: no ? (pickOut({ company: no.partyName ?? no.name, language: r.language }, [no])?.language ?? "") : "" }); }}>
                          <option value="">（選んでください）</option>
                          {outs.map((x) => <option key={x.id} value={x.id}>{x.partyName ?? x.name}{x.languages.length ? `（${x.languages.join("・")}）` : ""}</option>)}
                        </select>
                        {o && !t && <div className="danger">この許諾先の利用形態に合う IN 条件がありません</div>}
                        {o && t && <div className="faint">{t.condition.usageLabel}</div>}
                      </td>
                      <td>
                        {o && o.languages.length > 0 && !o.languages.includes("全言語")
                          ? <select value={r.lang} style={{ width: 120 }} onChange={(e) => set(r.key, { lang: e.target.value })}>
                              <option value="">（選んでください）</option>
                              {o.languages.map((l) => <option key={l} value={l}>{l}</option>)}
                            </select>
                          : <input value={r.lang} style={{ width: 110 }} placeholder={r.language} onChange={(e) => set(r.key, { lang: e.target.value })} />}
                      </td>
                      <td className="num"><input value={r.advance} style={{ width: 100, textAlign: "right" }} disabled={r.saved.includes("advance")}
                                                 onChange={(e) => set(r.key, { advance: e.target.value })} /></td>
                      <td className="num"><input value={r.balance} style={{ width: 100, textAlign: "right" }} disabled={r.saved.includes("balance")}
                                                 onChange={(e) => set(r.key, { balance: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span>{picked.length} 行・受領額 計 <b>{yen(total)}</b>{taxIncluded ? "（税込）" : ""}</span>
            {problems.length > 0 && <span className="danger">許諾先・言語が決まっていない行が {problems.length} 行あります</span>}
            <button className="btn btn-sm primary" style={{ marginLeft: "auto" }} disabled={busy || !picked.length || problems.length > 0}
                    onClick={() => void save()}>{busy ? "記録しています…" : `${picked.length} 行を記録`}</button>
          </div>
        </>
      )}
    </div>
  );
}
