import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { useReadOnly } from "./read-only.js";
import type { CloseBundle, CloseOverrides, ClosePreview, CloseResult } from "./closing-types.js";

/**
 * まとめて締める。試算 → 実行 → 結果。
 *
 * 押す前に何が起きるかを全部出す。枚数・使うことになる番号・合計・支払期日の
 * 根拠まで。押したあとに「思っていたのと違う」が起きないようにする。
 */
export function ClosingRun({ scheduleIds, onRan, onResult, onDone, onCancel, onOpenDocument }: {
  scheduleIds: number[];
  /** 結果から決済文書を開いて送る（③ 送る）。 */
  onOpenDocument?: (id: number) => void;
  /** 締め終わった直後。下に出したままの表を引き直す合図。 */
  onRan?: () => void;
  /** 結果そのもの（通しで進める画面が「送る」の段で文書を並べるのに使う）。 */
  onResult?: (result: CloseResult) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const readOnly = useReadOnly();
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // まとめ方。最初は条件ごとで引き、同じ相手先に条件が2つ以上あれば相手先ごとに切り替える。
  const [bundle, setBundle] = useState<CloseBundle | null>(null);
  // 締める前に直した額。入れた欄を離れたときに試算へ反映する。
  const [overrides, setOverrides] = useState<CloseOverrides>({});
  const [applied, setApplied] = useState<CloseOverrides>({});
  const body = () => ({ scheduleIds, bundle: bundle ?? "condition", overrides: applied });

  // 開いた時点で引く。ここでもう一度「まとめて締める」を出すと、押した人には
  // 同じ帯が2枚並んで見えて、1回目が効かなかったように読める。
  useEffect(() => {
    // 締め終わったあとは引き直さない。結果を出したときに親が表を引き直して
    // 選択を空にするので、ここで追いかけると「選んでください」で結果が消える。
    if (result || !scheduleIds.length) return;
    setBusy(true); setError(null);
    api.post<ClosePreview>("/closing/preview", body())
      .then((p) => {
        setPreview(p);
        if (bundle === null) setBundle(sharesParty(p) ? "party" : "condition");
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setBusy(false));
  }, [scheduleIds.join(","), result, bundle, JSON.stringify(applied)]);

  const run = () => {
    setBusy(true); setError(null);
    api.post<CloseResult>("/closing/run", body())
      // 結果を出したあと、下の表も引き直す。「締めました」の下に締める前の
      // 行が残っていると、効かなかったように読める。
      .then((r) => { setResult(r); onResult?.(r); onRan?.(); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setBusy(false));
  };

  if (result) return <RunResult result={result} onDone={onDone} onOpenDocument={onOpenDocument} />;

  if (!preview) {
    return (
      <div className="bulkbar">
        {error
          ? <><span className="danger">{error}</span>
              <button className="btn btn-sm" onClick={onCancel}>戻る</button></>
          : <span>{scheduleIds.length} 行を調べています…</span>}
      </div>
    );
  }

  const p = preview;
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>これから起きること</h2>
        <span className="faint">押すまで何も作りません</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {readOnly && <div className="note">いまは読み取り専用です。締めることはできません。</div>}

        <div className="tiles">
          <Tile label="対象" value={`${p.summary.rows} 行`} sub={`${p.summary.parties} 取引先`} />
          <Tile label="実績を記録する" value={`${p.summary.events} 件`}
            sub={p.targets.some((t) => t.overridden)
              ? `うち ${p.targets.filter((t) => t.overridden).length} 件は直した額`
              : "予定どおりの額"} />
          <Tile label="決済文書を出す" value={`${p.summary.documents} 枚`}
            sub={p.numbers.map((n) => `${n.label} ${n.from}${n.count > 1 ? `〜${n.to}` : ""}`).join(" / ") || "—"} />
          <Tile label="支払を立てる" value={`${p.summary.payments} 件`} sub="立てるまで。支払済みにはしません" />
          <Tile label="合計（税抜）" value={money(p.summary.total)} sub="" />
        </div>

        {sharesParty(p) && (
          <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong>決済文書のまとめ方</strong>
            <div className="seg">
              <button className={`btn btn-sm${p.bundle === "party" ? " primary" : ""}`}
                onClick={() => setBundle("party")} disabled={busy}>相手先ごとに 1 枚</button>
              <button className={`btn btn-sm${p.bundle === "condition" ? " primary" : ""}`}
                onClick={() => setBundle("condition")} disabled={busy}>条件ごとに 1 枚</button>
            </div>
            <span className="faint">
              {p.bundle === "party"
                ? "同じ相手先の条件を 1 枚の検収書と 1 件の支払にまとめます（文書の種類・通貨が違うものは分けます）"
                : "条件ごとに検収書と支払を分けます"}
            </span>
          </div>
        )}

        <AmountFixes preview={p} overrides={overrides} busy={busy}
          onChange={setOverrides} onApply={(next) => setApplied(next)} />

        {p.summary.dueByLimit > 0 && (
          <div className="alert">
            {p.summary.dueByLimit} 件は支払期日の根拠が「上限60日」です。条件に支払条件が入っていません
            （{p.targets.filter((t) => t.dueSource === "limit")
                  .map((t) => t.conditionName).slice(0, 5).join("／")}）。
          </div>
        )}

        {p.documents.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>{p.bundle === "party" ? "相手先／条件" : "条件"}</th><th>決済文書</th><th>決定日</th>
                <th className="num">回</th><th className="num">金額</th>
              </tr></thead>
              <tbody>
                {p.documents.map((d) => (
                  <tr key={d.scheduleIds.join(",")}>
                    <td>
                      {p.bundle === "party" && d.party && <div><strong>{d.party.name}</strong></div>}
                      {p.bundle === "party"
                        ? <div className="faint">{d.conditionNames.join("／")}</div>
                        : d.conditionName}
                    </td>
                    <td>{d.documentLabel}</td>
                    <td className="code">{d.issuedOn ?? "—"}</td>
                    <td className="num">{d.scheduleIds.length}</td>
                    <td className="num">{money(d.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {p.skipped.length > 0 && (
          <div className="note">
            <strong>対象から外すもの（{p.skipped.length}）</strong>
            <ul>
              {p.skipped.map((s) => (
                <li key={s.scheduleId}>
                  {s.conditionName} {s.seq ? `第${s.seq}回` : ""} — {s.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="faint">
          決済文書の決定日はその回の締め日（1 枚に数回を載せるときはいちばん遅い締め日）。
          支払は立てるまでで、支払済みにはしません。
          料率の回は、売上報告が入っていないものを対象から外します（計算できないため）。
        </p>

        <div className="row">
          <button className="btn" onClick={() => { setPreview(null); onCancel(); }}>やめる</button>
          <button className="btn accent" onClick={run}
            disabled={busy || readOnly || !p.summary.rows || dirty(overrides, applied)}
            title={dirty(overrides, applied) ? "直した額を試算に反映してから締めてください" : undefined}>
            {busy ? "締めています…" : `${p.summary.rows} 行を締める`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 結果。1件でも止まったら終わり、にはしない。できたものはでき、
 * 落ちたものは理由とどこまで進んだかを出す。
 */
function RunResult({ result, onDone, onOpenDocument }: {
  result: CloseResult; onDone: () => void; onOpenDocument?: (id: number) => void;
}) {
  // できた文書（同じ文書に数回が載るので1枚ずつにする）。次は ③ 送る。
  const docs = [...new Map(result.outcomes
    .filter((o) => o.documentId !== null)
    .map((o) => [o.documentId!, o.documentNo ?? `#${o.documentId}`])).entries()];
  const REACHED: Record<string, string> = {
    event: "実績まで", document: "決済文書まで", payment: "支払まで"
  };
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>締めました</h2>
        <span className="faint">済 {result.ok}／止まった {result.failed}</span>
      </div>
      <div className="panel-bd stack">
        <div className="tablewrap">
          <table>
            <thead><tr>
              <th>条件</th><th>回</th><th>決済文書</th><th>支払</th><th>結果</th>
            </tr></thead>
            <tbody>
              {result.outcomes.map((o) => (
                <tr key={o.scheduleId} className={o.ok ? "" : "overdue"}>
                  <td>{o.conditionName}</td>
                  <td>{o.seq ? `第${o.seq}回` : "—"}</td>
                  <td className="code">{o.documentNo ?? "—"}</td>
                  <td className="code">{o.paymentNo ?? "—"}</td>
                  <td>
                    {o.ok
                      ? <span className="tag ok">済</span>
                      : <>
                          <span className="tag out">{REACHED[o.reached] ?? "止まった"}</span>
                          <div className="faint">{o.error}</div>
                        </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {onOpenDocument && docs.length > 0 && (
          <div className="bulkbar">
            <strong>次は ③ 送る</strong>
            <span className="faint">文書を開いて、メールまたは CloudSign で送ります。</span>
            {docs.map(([id, no]) => (
              <button key={id} className="btn btn-sm primary" onClick={() => onOpenDocument(id)}>{no} を開いて送る</button>
            ))}
          </div>
        )}
        {result.failed > 0 && (
          <p className="faint">
            止まった回は、できたところまで残してあります。理由を直してもう一度選べば、
            続きから進みます（できている手はやり直しません）。
          </p>
        )}
        <div className="row"><button className="btn accent" onClick={onDone}>表に戻る</button></div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile" style={{ cursor: "default" }}>
      <span className="lab">{label}</span>
      <span className="val">{value}</span>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/** 同じ相手先に条件が2つ以上ある（相手先ごとにまとめる意味がある）。 */
function sharesParty(p: ClosePreview): boolean {
  const byParty = new Map<number, Set<number>>();
  for (const t of p.targets) {
    if (!t.party) continue;
    const set = byParty.get(t.party.id) ?? new Set<number>();
    set.add(t.conditionId);
    byParty.set(t.party.id, set);
  }
  return [...byParty.values()].some((set) => set.size > 1);
}

const dirty = (a: CloseOverrides, b: CloseOverrides) => JSON.stringify(clean(a)) !== JSON.stringify(clean(b));

/** 空の欄は渡さない（予定どおりで記録する）。 */
function clean(o: CloseOverrides): CloseOverrides {
  const out: CloseOverrides = {};
  for (const key of Object.keys(o).sort()) {
    const v = o[Number(key)]!;
    if (v.amount || v.note) out[Number(key)] = { amount: v.amount ?? null, note: v.note ?? null };
  }
  return out;
}

/**
 * 実績の額を締める前に直す。条件の画面を開かずに、ここで予定と違う額を入れられる。
 * 予定と違う額には理由が要る（検収書の変更履歴に出る）。
 * 予定額の無い回も、額を入れれば締められる。
 */
function AmountFixes({ preview, overrides, busy, onChange, onApply }: {
  preview: ClosePreview; overrides: CloseOverrides; busy: boolean;
  onChange: (next: CloseOverrides) => void; onApply: (next: CloseOverrides) => void;
}) {
  const [open, setOpen] = useState(false);
  const recording = preview.targets.filter((t) => t.willRecordEvent);
  const noPlan = preview.skipped.filter((s) => s.reason === "no_planned_amount");
  if (!recording.length && !noPlan.length) return null;

  const set = (id: number, patch: { amount?: number | null; note?: string | null }) =>
    onChange({ ...overrides, [id]: { ...overrides[id], ...patch } });
  const changed = Object.keys(clean(overrides)).length;
  const needsReason = recording.some((t) => {
    const o = overrides[t.scheduleId];
    return o?.amount && t.plannedAmount && o.amount !== t.plannedAmount && !o.note?.trim();
  });

  if (!open) {
    return (
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <button className="btn btn-sm" onClick={() => setOpen(true)}>
          実績の額を直す{changed ? `（${changed} 件直しています）` : ""}
        </button>
        <span className="faint">
          {noPlan.length
            ? `予定額の無い回が ${noPlan.length} 件あります。額を入れれば一緒に締められます`
            : "予定どおりでない回は、ここで額と理由を入れてから締められます"}
        </span>
      </div>
    );
  }

  const rows = [
    ...recording.map((t) => ({ id: t.scheduleId, name: t.conditionName, seq: t.seq, label: t.label,
                               planned: t.plannedAmount })),
    ...noPlan.map((s) => ({ id: s.scheduleId, name: s.conditionName, seq: s.seq, label: null, planned: null }))
  ];
  return (
    <div className="note stack">
      <strong>実績の額を直す</strong>
      <span className="faint">空のままなら予定どおりの額で記録します。予定と違う額には理由を入れてください（検収書の変更履歴に出ます）。</span>
      <div className="tablewrap">
        <table>
          <thead><tr>
            <th>条件</th><th>回</th><th className="num">予定</th><th>記録する額</th><th>理由</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const o = overrides[r.id] ?? {};
              const differs = !!o.amount && !!r.planned && o.amount !== r.planned;
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{r.seq ? `第${r.seq}回` : "—"}{r.label ? <div className="faint">{r.label}</div> : null}</td>
                  <td className="num">{r.planned ? money(r.planned) : "—"}</td>
                  <td>
                    <input type="number" min={1} style={{ width: 120 }}
                      placeholder={r.planned ? String(r.planned) : "額"}
                      value={o.amount ?? ""}
                      onChange={(e) => set(r.id, { amount: e.target.value ? Number(e.target.value) : null })} />
                  </td>
                  <td>
                    <input style={{ width: "100%", minWidth: 160 }}
                      className={differs && !o.note?.trim() ? "invalid" : undefined}
                      placeholder={differs ? "例：稼働が少なかったため減額" : "（任意）"}
                      value={o.note ?? ""}
                      onChange={(e) => set(r.id, { note: e.target.value || null })} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {needsReason && <span className="danger">予定と違う額にした回は理由を入れてください</span>}
      <div className="row">
        <button className="btn btn-sm" onClick={() => { onChange({}); onApply({}); setOpen(false); }}
          disabled={busy}>予定どおりに戻す</button>
        <button className="btn btn-sm accent" onClick={() => onApply(clean(overrides))}
          disabled={busy || needsReason}>試算に反映</button>
      </div>
    </div>
  );
}
