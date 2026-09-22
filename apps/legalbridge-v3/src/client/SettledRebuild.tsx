import { useState } from "react";
import { api, ApiError, saveCsv } from "./api.js";
import { CsvBar } from "./CsvBar.js";
import { TeardownPanel } from "./TeardownPanel.js";
import { SettledImport, DiffPanel } from "./SettledImport.js";
import type { SettledDiff } from "../server/documents/settled-diff.js";
import type { TeardownPlan, TeardownResult } from "../server/documents/teardown-types.js";

/**
 * 決済済みを作り直す。
 *
 * 金額の違う紙が既に出ていて、正しい金額で出し直したい、というとき。
 * やることは1本道で、順番を間違えると取り返せない。
 *
 *   ① 書き出す → ② 直す → ③ 確かめる → ④ 旧分を畳む → ⑤ 入れ直す
 *
 * これまでは ① と ② が案件の文書タブ、⑤ が文書の画面にあり、
 * 画面をまたぐたびに案件と CSV を選び直していた。④ を先にやると
 * 書き出すものが無くなる（紙も実績も消えた条件からは金額しか出ない）のに、
 * 並びからはそれが読めなかった。
 *
 * だから1画面に閉じて、**ファイルは③で一度だけ選び、④と⑤で使い回す**。
 * 道筋は左に出したままにして、いまどこにいるかを常に見せる。
 */

const STEPS = [
  { no: "①", label: "書き出す" },
  { no: "②", label: "直す" },
  { no: "③", label: "確かめる" },
  { no: "④", label: "旧分を畳む" },
  { no: "⑤", label: "入れ直す" }
] as const;

type Mode = "as_is" | "first_edition";

export function SettledRebuild(
  { matterId, matterLabel, onOpenDocument, onChanged, onClose }: {
    matterId: number;
    matterLabel: string;
    onOpenDocument?: (documentId: number) => void;
    /** 畳んだ・入れ直したあとに案件を引き直す。 */
    onChanged: () => void;
    onClose: () => void;
  }
) {
  const [step, setStep] = useState(0);
  /** いちばん先まで行った手。戻るのは自由、飛ばして先へは行かせない。 */
  const [far, setFar] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** ① 書き出し。 */
  const [mode, setMode] = useState<Mode>("first_edition");
  const [exported, setExported] = useState<
    { rows: number; notes: Array<{ conditionNo: string | null;
                                   conditionName: string; note: string }> } | null>(null);
  const [allNotes, setAllNotes] = useState(false);

  /** ③ 直した CSV。ここで一度だけ選び、④⑤でも同じものを使う。 */
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [diff, setDiff] = useState<SettledDiff | null>(null);
  const [allSame, setAllSame] = useState(false);

  /** ④ 畳む。 */
  const [plan, setPlan] = useState<TeardownPlan | null>(null);
  const [tornDown, setTornDown] = useState<TeardownResult | null>(null);

  const go = (n: number) => { setStep(n); setFar((f) => Math.max(f, n)); setError(null); };

  async function exportSettled() {
    setBusy(true); setError(null); setExported(null); setAllNotes(false);
    try {
      const made = await api.get<{
        matter: { matterNo: string | null };
        rows: unknown[];
        notes: Array<{ conditionNo: string | null; conditionName: string; note: string }>;
        csv: string;
      }>(`/matters/${matterId}/settled-export?mode=${mode}`);
      if (!made.rows.length) { setError("書き出せる条件明細がありませんでした"); return; }
      saveCsv(made.csv, `settled_${made.matter.matterNo ?? matterId}.csv`);
      setExported({ rows: made.rows.length, notes: made.notes });
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /** ③ 選んだ中身を、いまの台帳と突き合わせる。何も作らない。 */
  async function pick(text: string, name: string) {
    setCsv({ name, text }); setDiff(null); setAllSame(false); setError(null);
    try {
      setDiff(await api.post<SettledDiff>("/documents/batches/settled/diff",
        { matterId, csv: text }));
    // 差分が引けなくても止めない（現物の無い案件もある）。
    } catch { setDiff(null); }
  }

  /** ④ 下見。「旧分」の列で、どの条件をどこまで畳むかが決まる。 */
  async function planTeardown() {
    setBusy(true); setError(null);
    try {
      setPlan(await api.post<TeardownPlan>(
        `/matters/${matterId}/teardown/preview`, { reason: "", csv: csv?.text ?? null }));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function runTeardown(reason: string, voidConditions: boolean) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<TeardownResult>(
        `/matters/${matterId}/teardown`,
        // CSV で来たときは、そちらが条件も畳むかまで持っている。
        csv ? { reason, csv: csv.text } : { reason, voidConditions });
      setTornDown(r); setPlan(null); onChanged();
      if (!r.failed) go(4);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const done = [
    exported !== null,
    far > 1,
    csv !== null,
    tornDown !== null,
    false
  ];

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>決済済みを作り直す</h2>
        <span className="faint">{matterLabel}</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>

      <div className="steps">
        <div className="steps-rail">
          {STEPS.map((s, i) => {
            const canGo = i <= far;
            return (
              <button key={s.no} type="button" data-can-go={canGo && i !== step ? "1" : "0"}
                className={`step-item ${i === step ? "now" : done[i] ? "done" : ""}`}
                onClick={() => canGo && go(i)}>
                <span className="no">{s.no}</span>
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>

        <div className="step-body stack">
          {error && <div className="alert">{error}</div>}

          {step === 0 && (
            <>
              <div className="step-note">
                いま台帳にあるものを、取り込みと同じ形の CSV で出します。読むだけで、台帳は動きません。
              </div>
              <CsvBar title="① 書き出す" busy={busy}
                exports={[{ value: "settled", label: "この案件の決済済み", run: () => exportSettled() }]}
                extra={
                  // 何を作り直すのかで中身が変わる。検収まで終わっている取引を
                  // いま文書化するなら、当初からの変更ではないので初版。
                  <select value={mode} disabled={busy}
                          onChange={(e) => setMode(e.target.value as Mode)}>
                    <option value="first_edition">初版として（検収済みをいま文書化する）</option>
                    <option value="as_is">現物どおり（当初の発注と検収の差も写す）</option>
                  </select>
                }
                note={mode === "first_edition"
                  ? "「版」の列に 初版 が入ります。発注書と検収書が同じ数量を言うので、紙に変更履歴は出ません"
                  : "当初から減っていた行だけ「版」が 変更履歴付 になり、変更理由が要ります"} />

              {exported && (
                <div className={exported.notes.length ? "note warn" : "note ok"}>
                  明細 {exported.rows} 行を出しました。
                  {exported.notes.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <b>人に決めてもらうこと（{exported.notes.length}）</b>
                      <ul style={{ margin: "4px 0 0" }}>
                        {(allNotes ? exported.notes : exported.notes.slice(0, 8))
                          .map((n, i) => <li key={i}>{n.conditionNo ?? n.conditionName}：{n.note}</li>)}
                      </ul>
                      {/* 案件が大きいと数十件出る。全部並べると下が読めない。 */}
                      {exported.notes.length > 8 && (
                        <button className="btn btn-sm" style={{ marginTop: 4 }}
                          onClick={() => setAllNotes(!allNotes)}>
                          {allNotes ? "畳む" : `ほか ${exported.notes.length - 8} 件を出す`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="row">
                <button className="btn" disabled={!exported} onClick={() => go(1)}>次へ（② 直す）</button>
                {/* 前に出した CSV を持っている人を、もう一度書き出させない。 */}
                <button className="linky" onClick={() => go(2)}>もう書き出してある（③ へ）</button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="step-note">表計算で開いて直します。ここでは何も起きません。</div>
              <ul className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18 }}>
                <li><b>金額</b>は 単価 と 数量 で直します（合計の列はありません）。</li>
                <li><b>版</b>：初版＝いま文書にするだけ／変更履歴付＝当初から変わった（変更理由が要ります）。</li>
                <li><b>旧分</b>：残す／畳む／無効。④ でこの列のとおりに畳みます。
                    <span className="faint">　無効＝条件明細も無効にする（入れ直しは新しい条件番号になります）</span></li>
                <li><b>条件番号</b>は消さないでください。これが同じ条件に当てる目印です。</li>
              </ul>
              <div className="row">
                <button className="btn" onClick={() => go(2)}>直した（③ 確かめる）</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="step-note">
                直した CSV をここで一度だけ選びます。④ と ⑤ でも同じものを使うので、選び直しは要りません。
              </div>
              <CsvBar title="③ 確かめる" onPick={(text, name) => void pick(text, name)}
                picked={csv?.name ?? null} onClearPick={() => { setCsv(null); setDiff(null); }}
                uploadLabel="直した CSV を選ぶ"
                note="選んだだけでは台帳は動きません。いまの中身との違いを出します" />

              {diff && <DiffPanel diff={diff} all={allSame} onAll={setAllSame} />}

              <div className="row">
                <button className="btn" disabled={!csv} onClick={() => go(3)}>
                  次へ（④ 旧分を畳む）
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="step-note">
                古い紙・実績・支払を畳みます。ここから先は台帳が動きます。
                畳むのは書き出したあとでないといけません（先に畳むと、書き出すものが無くなります）。
              </div>

              {csv
                ? <div className="filecard">
                    <span className="dir in"><span className="arrow">↑</span></span>
                    <span className="name">{csv.name}</span>
                    <span className="faint">「旧分」の列のとおりに畳みます</span>
                  </div>
                : <div className="note warn">
                    CSV がありません。案件まるごと畳むことになります。
                    <button className="linky" onClick={() => go(2)}>③ で選ぶ</button>
                  </div>}

              {!plan && !tornDown && (
                <div className="row">
                  <button className="btn" disabled={busy} onClick={() => void planTeardown()}>
                    {busy ? "調べています…" : "何が畳まれるか見る"}
                  </button>
                  {/* 畳むものが無い（新規に入れるだけ）案件もある。 */}
                  <button className="linky" onClick={() => go(4)}>畳まずに ⑤ へ</button>
                </div>
              )}

              {plan && (
                <TeardownPanel plan={plan} busy={busy}
                  onCancel={() => setPlan(null)}
                  onRun={(reason, voidConditions) => void runTeardown(reason, voidConditions)} />
              )}

              {tornDown && (
                <div className={tornDown.failed ? "note warn" : "note ok"}>
                  畳みました：済 {tornDown.ok}／止まった {tornDown.failed}
                  {tornDown.skipped ? `／触らなかった ${tornDown.skipped}` : ""}
                  {tornDown.outcomes.filter((o) => !o.ok).length > 0 && (
                    <ul style={{ margin: "4px 0 0" }}>
                      {tornDown.outcomes.filter((o) => !o.ok).map((o) => (
                        <li key={`${o.step}-${o.id}`}>{o.label}：{o.error}</li>
                      ))}
                    </ul>
                  )}
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn" onClick={() => go(4)}>次へ（⑤ 入れ直す）</button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 4 && (
            csv
              ? <>
                  <div className="step-note">
                    ③ で選んだ CSV をそのまま入れます。試算を見てから流してください。
                    <b>発注書と検収書は決定済みで作られ、番号が振られます。</b>
                  </div>
                  <SettledImport compact initialMatterId={matterId} initialCsv={csv}
                    onOpenDocument={(id) => onOpenDocument?.(id)}
                    onClose={onClose}
                    onCreated={() => onChanged()} />
                </>
              : <div className="note warn">
                  入れる CSV がありません。
                  <button className="linky" onClick={() => go(2)}>③ で選ぶ</button>
                </div>
          )}
        </div>
      </div>
    </div>
  );
}
