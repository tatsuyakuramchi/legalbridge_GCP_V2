import { useEffect, useState } from "react";
import type { TeardownPlan, TeardownResult } from "../server/documents/teardown-service.js";
import type { MatterDetail, MatterKind } from "../server/core/model.js";
import { api, ApiError, saveCsv } from "./api.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { ConditionCreateForm } from "./ConditionCreateForm.js";
import { SendMany } from "./SendMany.js";
import { CloudSignManual } from "./CloudSignManual.js";
import { WorkChooser, type WorkOption } from "./WorkChooser.js";
import { DocumentImport } from "./DocumentImport.js";
import { CONDITION_KIND_LABEL, MATTER_KIND_LABEL, SettlementTag, StatusTag } from "./labels.js";
import { ConditionLabel } from "./ConditionLabel.js";
import { ServiceSetForm } from "./ServiceSetForm.js";
import { money } from "./api.js";

/**
 * 案件に条件と文書を繋ぐ操作。
 *
 * これまで案件の条件タブ・文書タブは読むだけで、繋ぐ手段が画面にもサーバにも
 * 無かった（読む処理は3箇所あった）。そのため案件を開いても中身が空のままで、
 * 「案件を進める」という操作が成立していなかった。
 *
 * 案件は所有せず参照する。繋いでも条件は書き換わらないし、外しても消えない。
 */

interface CandidateCondition {
  id: number; conditionNo: string | null; name: string;
  direction: string; kind: string; counterparty: { name: string } | null;
  // 見出しは型で変わる（ライセンスは作品と取引モデル、業務委託は件名と金額）。
  work: { title: string } | null;
  currency: string; pricingModel: string;
  flatAmount: number | null; unitAmount: number | null; ratePpm: number | null;
}
interface CandidateDocument {
  id: number; documentNo: string | null; templateLabel: string | null;
  status: string; counterparty: string | null;
}

export function MatterConditions(
  { detail, onChanged, onOpenCondition, onCompose, onRecordEvent }: {
    detail: MatterDetail; onChanged: () => void; onOpenCondition: (id: number) => void;
    /** 文書の画面へ移って、この業務の条件を選び、ひな形を決めた状態で作成に入る。 */
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
    /** 実績タブへ移って、この条件の実績を記録する。 */
    onRecordEvent?: (conditionId: number) => void;
  }
) {
  const [making, setMaking] = useState<false | "one" | "service">(false);
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [candidates, setCandidates] = useState<CandidateCondition[]>([]);
  /** 繋ぐ前に選んである条件。1本ずつしか繋げず、10本あれば10回押していた。 */
  const [checked, setChecked] = useState<number[]>([]);
  /** 候補を何行まで描くか。170本の条件を持つ案件があるので、押して伸ばせるようにする。 */
  const [shownLimit, setShownLimit] = useState(40);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<number | null>(null);
  const [work, setWork] = useState<WorkOption | null>(null);
  /** 支払済み・完了扱いの条件を開いて見せるか。既定は畳む（業務の束ごと）。 */
  const [showSettled, setShowSettled] = useState<Set<string>>(new Set());

  const allowed = ALLOWED_KINDS[detail.kind] ?? [];
  const linked = new Set(detail.conditions.map((c) => c.id));
  /** まだ繋いでいない候補。「全部選ぶ」はここを指す。 */
  const attachable = candidates.filter((c) => !linked.has(c.id));
  /**
   * 描く候補。選んだものは必ず出し、次にまだ繋いでいないものを出す。
   * 繋ぎ済みを先に並べると、170本の案件では「繋げるもの」に辿り着けない。
   */
  const shownCandidates = (() => {
    const chosen = candidates.filter((c) => checked.includes(c.id));
    const rest = [
      ...attachable.filter((c) => !checked.includes(c.id)),
      ...candidates.filter((c) => linked.has(c.id) && !checked.includes(c.id))
    ];
    return [...chosen, ...rest.slice(0, Math.max(0, shownLimit - chosen.length))];
  })();
  const hiddenCandidates = candidates.length - shownCandidates.length;

  // ライセンスは作品が軸。作品ひとつに、取引モデルの違う条件（自社製造・自社販売、
  // 再許諾…）が何本も並ぶ。だから作品を先に決め、条件はそこから1本ずつ作る。
  const licensing = detail.kind === "work";
  // 業務委託は案件が業務の単位。契約×相手先が違えば別の業務として束ねて見せる。
  const outsourcing = detail.kind === "outsourcing";
  const bundles = outsourcing ? serviceBundles(detail.conditions) : [];
  // 2本目以降は、1本目が知っていることを引き継ぐ。作品・相手先・契約・通貨を
  // 毎回入れ直させると、同じ作品の条件が別々の契約にぶら下がって食い違う。
  const last = detail.conditions[detail.conditions.length - 1] ?? null;

  useEffect(() => {
    if (work) return;
    const first = detail.conditions.map((c) => c.work).find(Boolean);
    if (first) setWork({ id: first.id, title: first.title, workCode: first.workCode });
  }, [detail.conditions]);

  useEffect(() => {
    if (!picking) return;
    const q = search.trim();
    // 既定の 200 件では台帳の新しい順に切られて、繋ぎたい条件が候補に出てこない。
    api.get<{ conditions: CandidateCondition[] }>(`/conditions?limit=500${q ? `&q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCandidates(r.conditions.filter((c) => allowed.includes(c.kind))))
      .catch(() => setCandidates([]));
  }, [picking, search]);

  /** 作った直後の条件を1本繋ぐ。 */
  async function attach(conditionId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/conditions`, { conditionIds: [conditionId] });
      setPicking(false); setKeyword(""); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /**
   * 選んだ条件をまとめて繋ぐ。取引モデルに合わない条件は、その行だけ断られて
   * 残りは繋がる。断られた理由は画面に出す（黙って落ちると気づけない）。
   */
  async function attachChecked() {
    if (!checked.length) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ attached: number;
        results: Array<{ conditionId: number; attached: boolean; reason?: string }> }>(
        `/matters/${detail.id}/conditions`, { conditionIds: checked });
      const refused = r.results.filter((x) => !x.attached && x.reason && !x.reason.includes("すでに"));
      if (refused.length) {
        setError(`${r.attached} 件を繋ぎました。繋げなかったもの: ` +
          refused.map((x) => {
            const c = candidates.find((y) => y.id === x.conditionId);
            return `${c?.conditionNo ?? `#${x.conditionId}`}（${x.reason}）`;
          }).join("、"));
      } else {
        setPicking(false); setKeyword("");
      }
      setChecked([]);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(conditionId: number, label: string) {
    if (!confirm(`${label} の紐づけを外します。条件そのものは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/matters/${detail.id}/conditions/${conditionId}`);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  // 作った条件はそのまま案件に繋ぐ。作って終わりだと、結局あとで繋ぐ手が要る。
  if (!allowed.length) {
    return (
      <div className="note">
        {MATTER_KIND_LABEL[detail.kind]}モデルの案件は条件を持ちません。
        条件が要るなら、取引モデルを変えてください。
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="faint">
          {MATTER_KIND_LABEL[detail.kind]}モデルの案件に繋げるのは
          <b>{allowed.map((k) => CONDITION_KIND_LABEL[k] ?? k).join("・")}</b> の条件です
        </span>
        {!picking && !making && (
          <span className="row" style={{ marginLeft: "auto" }}>
            {/* 案件を見ながら新しい条件を作れるようにする。以前は「条件の画面で
                作ってください」と案内していて、作ってから案件へ戻って繋ぎ直す
                往復が要った。 */}
            {outsourcing && (
              <button className="btn btn-sm primary"
                      title="委託料に実費・手数料を組にして1回で登録する。発注書はこの組を1枚に載せる"
                      onClick={() => { setMade(null); setMaking("service"); }}>
                業務セットを登録（委託料＋実費＋手数料）
              </button>
            )}
            <button className={`btn btn-sm${outsourcing ? "" : " primary"}`} disabled={licensing && !work}
                    onClick={() => { setMade(null); setMaking("one"); }}>
              {licensing ? "この作品で条件を1本作る" : outsourcing ? "条件を1本だけ作る" : "新しい条件を作る"}
            </button>
            <button className="btn btn-sm"
                    onClick={() => setPicking(true)}>すでにある条件を繋ぐ</button>
          </span>
        )}
      </div>

      {/* 作品を決める段。ライセンスの工程1「権利の上限確認」はここが済む
          ことで済になる。作品が決まらないまま条件を作ると、作品から辿れず、
          許諾できる上限も計算できない条件ができる。 */}
      {licensing && !making && (
        <div className="stack" style={{ gap: 6 }}>
          <WorkChooser value={work} onChange={(w) => { setWork(w); setMade(null); }} disabled={busy} />
          <span className="faint">
            {work
              ? `「${work.title}」の条件をここから1本ずつ作ります。取引モデル（自社製造・自社販売／再許諾…）ごとに1本です`
              : "先に作品を決めてください。作品が決まらないと、許諾できる上限が計算できません"}
          </span>
        </div>
      )}

      {/* 作ったあとの行き先。続けて次の1本を作るのが普通なので、その場に置く。 */}
      {made !== null && !making && (
        <div className="done-note">
          条件を作って、この案件に繋ぎました。
          <span className="row">
            <button className="btn btn-sm primary" onClick={() => { setMade(null); setMaking("one"); }}>
              続けてもう1本作る
            </button>
            <button className="btn btn-sm" onClick={() => onOpenCondition(made)}>作った条件を開く</button>
            <button className="btn btn-sm" onClick={() => setMade(null)}>閉じる</button>
          </span>
        </div>
      )}

      {making === "service" && (
        <ServiceSetForm
          counterpartyName={detail.counterparty?.name ?? last?.counterparty?.name ?? null}
          preset={{
            matterId: String(detail.id),
            ...(detail.counterparty
              ? { counterpartyId: String(detail.counterparty.id) }
              : last?.counterparty ? { counterpartyId: String(last.counterparty.id) } : {}),
            ...(last?.agreement ? { agreementId: String(last.agreement.id) } : {})
          }}
          onDone={(created) => {
            setMaking(false);
            setMade(created.conditions[0]?.id ?? null);
            // サーバが案件に繋いでいる（matterId 付き）。読み直すだけでよい。
            onChanged();
          }}
          onCancel={() => setMaking(false)} />
      )}

      {making === "one" && (
        <ConditionCreateForm
          title={work
            ? `「${work.title}」の条件を1本作る`
            : `${detail.matterNo ?? "この案件"} に新しい条件を作る`}
          // 案件と、すでに作った条件が知っていることは入れておく。人が入れるのは
          // その条件だけの中身（取引モデルの名前と金額）になる。
          preset={{
            kind: (last?.kind as string | undefined) ?? allowed[0],
            ...(detail.counterparty
              ? { counterpartyId: String(detail.counterparty.id) }
              : last?.counterparty ? { counterpartyId: String(last.counterparty.id) } : {}),
            // 業務委託は必ず自社が払う側。ライセンスは取得も許諾もあるので、
            // 1本目に合わせる（同じ作品の許諾が IN と OUT に散らばらない）。
            ...(detail.kind === "outsourcing" ? { direction: "in" }
              : last ? { direction: last.direction } : {}),
            ...(work ? { workId: String(work.id) } : {}),
            ...(last?.agreement ? { agreementId: String(last.agreement.id) } : {}),
            ...(last ? { currency: last.currency } : {})
          }}
          onDone={(created) => { setMaking(false); setMade(created.id); void attach(created.id); }}
          onCancel={() => setMaking(false)} />
      )}

      {picking && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="条件名・条件番号・相手先" label="繋ぐ条件を探す" />
            <button className="btn btn-sm"
                    onClick={() => { setPicking(false); setKeyword(""); setChecked([]); }}>やめる</button>
          </div>
          <div className="picker">
            {shownCandidates.map((c) => (
              <label key={c.id} className="pick">
                <input type="checkbox" disabled={busy || linked.has(c.id)}
                       checked={linked.has(c.id) || checked.includes(c.id)}
                       onChange={(e) => setChecked((prev) => e.target.checked
                         ? [...prev, c.id] : prev.filter((id) => id !== c.id))} />
                <ConditionLabel c={c} showKind />
                {linked.has(c.id) && <span className="faint">繋がっています</span>}
              </label>
            ))}
            {!candidates.length && (
              <span className="faint">
                繋げる条件がありません。{search.trim() ? "別の言葉で探すか、" : ""}
                条件の画面で先に作ってください
              </span>
            )}
          </div>
          {attachable.length > 0 && (
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <button className="btn btn-sm primary" disabled={busy || !checked.length}
                      onClick={() => void attachChecked()}>
                {busy ? "繋いでいます…" : `選んだ ${checked.length} 件を繋ぐ`}
              </button>
              <button className="btn btn-sm" disabled={busy}
                      onClick={() => setChecked(attachable.map((c) => c.id))}>
                候補 {attachable.length} 件を全部選ぶ
              </button>
              {hiddenCandidates > 0 && (
                <button className="btn btn-sm" disabled={busy}
                        onClick={() => setShownLimit((n) => n + 100)}>もっと出す（+100）</button>
              )}
              {checked.length > 0 && (
                <button className="btn btn-sm" disabled={busy} onClick={() => setChecked([])}>選び直す</button>
              )}
              <span className="faint">
                候補 {candidates.length} 件（繋げる {attachable.length} 件）
                {hiddenCandidates > 0 && `／うち ${hiddenCandidates} 件は未表示`}
              </span>
            </div>
          )}
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {/* 業務委託は業務の束で見せる。委託料と、それに付く実費・手数料が1枚の
          発注書に載る単位。契約や相手先が違えば別の束。 */}
      {outsourcing && bundles.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          {bundles.map((b) => {
            const ids = b.conditions.map((c) => c.id);
            // 委託料・手数料は税抜、実費は税込の立替。足すと意味の無い数になるので
            // 合計は出さず、くくりを分けて並べる。
            const exTax = b.conditions.filter((c) => c.kind !== "expense").reduce((sum, c) => sum + (c.flatAmount ?? 0), 0);
            const incTax = b.conditions.filter((c) => c.kind === "expense").reduce((sum, c) => sum + (c.flatAmount ?? 0), 0);
            const amounts = [
              exTax > 0 ? `${b.conditions.some((c) => c.kind === "fee") ? "委託料・手数料" : "委託料"} ${money(exTax, b.currency)}（税抜）` : "",
              incTax > 0 ? `経費 ${money(incTax, b.currency)}（税込）` : ""
            ].filter(Boolean).join("＋");
            const settled = b.conditions.filter((c) => c.settlement?.done);
            const fixed = b.conditions.filter((c) => c.settlement?.targetAmount);
            const allDone = fixed.length > 0 && fixed.every((c) => c.settlement?.done);
            const opened = showSettled.has(b.key);
            const shown = opened ? b.conditions : b.conditions.filter((c) => !c.settlement?.done);
            return (
              <div key={b.key} className="note" style={{ borderStyle: "solid", ...(allDone ? { opacity: 0.85 } : {}) }}>
                <div className="row" style={{ alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <b>業務 {b.no}：{b.title}</b>
                  {allDone && <span className="tag ok">支払済み</span>}
                  <span className="faint">
                    {b.counterparty ?? "相手先なし"} ／ {b.agreement ?? "基本契約なし"}
                    {b.conditions.length > 1 && ` ／ ${b.conditions.length} 本`}
                    {b.conditions.length > 1 && amounts && ` ／ ${amounts}`}
                    {fixed.length > 0 && !allDone && ` ／ 支払済み ${settled.length}／${fixed.length} 本`}
                  </span>
                  {onCompose && (
                    <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                      <button className="btn btn-sm primary" disabled={busy}
                              title="この業務の条件をすべて載せた発注書の下書きへ。経費・その他費用の欄に打った行は、決定のときに条件になってこの業務に繋がる"
                              onClick={() => onCompose(ids, [], detail.id, "purchase_order")}>
                        この業務で発注書を作る
                      </button>
                      <button className="btn btn-sm" disabled={busy}
                              onClick={() => onCompose(ids, [], detail.id, "inspection_certificate")}>
                        検収書を作る
                      </button>
                    </span>
                  )}
                </div>
                <table style={{ marginTop: 6 }}>
                  <thead><tr><th>条件番号</th><th>内容</th><th className="num">金額</th><th></th></tr></thead>
                  <tbody>
                    {shown.map((c) => (
                      <tr key={c.id}>
                        <td className="code" style={{ whiteSpace: "nowrap" }}>
                          <button className="btn btn-sm" onClick={() => onOpenCondition(c.id)}>
                            {c.conditionNo ?? `#${c.id}`}
                          </button>
                        </td>
                        <td style={{ width: "100%" }}>
                          <span className="tag" style={{ marginRight: 6 }}>{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span>
                          {c.name}{c.status !== "active" && <> <StatusTag kind="condition" value={c.status} /></>}
                          {/* 進捗は列を増やさず名前の下に。列が増えると狭い案件の枠で
                              右端のボタンが切れる。 */}
                          {c.settlement && c.settlement.state !== "open" && (
                            <div style={{ marginTop: 3 }}><SettlementTag settlement={c.settlement} /></div>
                          )}
                        </td>
                        <td className="num" style={{ whiteSpace: "nowrap" }}>
                          {c.pricingModel === "unit_rate" && c.unitAmount != null
                            ? `${money(c.unitAmount, c.currency)} × ${c.quantity ?? "—"}`
                            : c.flatAmount != null ? money(c.flatAmount, c.currency) : "—"}
                          {c.kind === "expense" && <span className="faint">（税込）</span>}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {onRecordEvent && c.status === "active" && (
                            <button className="btn btn-sm" disabled={busy} title="実績タブへ移って、この条件の実績を記録する"
                              onClick={() => onRecordEvent(c.id)}>実績</button>
                          )}{" "}
                          <button className="btn btn-sm" disabled={busy}
                            onClick={() => void detach(c.id, c.conditionNo ?? `#${c.id}`)}>外す</button>
                        </td>
                      </tr>
                    ))}
                    {settled.length > 0 && (
                      <tr><td colSpan={4} className="faint">
                        <button type="button" className="linky"
                                onClick={() => setShowSettled((s) => {
                                  const n = new Set(s); if (n.has(b.key)) n.delete(b.key); else n.add(b.key); return n;
                                })}>
                          {opened ? `完了した ${settled.length} 本を畳む` : `完了した ${settled.length} 本を表示`}
                        </button>
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      {detail.conditions.length && !(outsourcing && bundles.length) ? (
        <table>
          <thead><tr><th>条件番号</th><th>種類</th><th>向き</th><th>内容</th><th></th></tr></thead>
          <tbody>
            {detail.conditions.map((c) => (
              <tr key={c.id}>
                <td className="code">
                  <button className="btn btn-sm" onClick={() => onOpenCondition(c.id)}>
                    {c.conditionNo ?? `#${c.id}`}
                  </button>
                </td>
                <td><span className="tag">{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span></td>
                <td><span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span></td>
                <td>
                  <span className="row" style={{ gap: 7 }}><ConditionLabel c={c} omitCode /></span>
                  {c.settlement && c.settlement.state !== "open" && (
                    <div style={{ marginTop: 3 }}><SettlementTag settlement={c.settlement} /></div>
                  )}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {onRecordEvent && c.status === "active" && (
                    <button className="btn btn-sm" disabled={busy} title="実績タブへ移って、この条件の実績を記録する"
                      onClick={() => onRecordEvent(c.id)}>実績</button>
                  )}{" "}
                  <button className="btn btn-sm" disabled={busy}
                    onClick={() => void detach(c.id, c.conditionNo ?? `#${c.id}`)}>外す</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : !detail.conditions.length ? (
        <div className="faint">
          まだ条件が繋がっていません。
          {outsourcing ? "「業務セットを登録」で委託料・実費・手数料を組で作るか、" : "「条件を繋ぐ」から選ぶか、"}
          条件の画面で作ってください。
        </div>
      ) : null}
    </div>
  );
}

/** 業務の束。契約×相手先で1つ。委託料が先頭、実費・手数料が後ろ。 */
interface ServiceBundle {
  key: string; no: number; title: string;
  counterparty: string | null; agreement: string | null; currency: string;
  conditions: MatterDetail["conditions"];
}

const BUNDLE_ORDER: Record<string, number> = { service: 0, product: 0, license: 0, expense: 1, fee: 2 };

/**
 * 案件の条件を業務の束に分ける。委託料の条件が業務の顔で、同じ契約・同じ相手先の
 * 実費・手数料はその下に付く。委託料の無い束（実費だけ繋いだ等）もそのまま出す。
 */
export function serviceBundles(conditions: MatterDetail["conditions"]): ServiceBundle[] {
  const map = new Map<string, ServiceBundle>();
  for (const c of conditions) {
    const key = `${c.agreement?.id ?? "-"}:${c.counterparty?.id ?? "-"}`;
    let b = map.get(key);
    if (!b) {
      b = { key, no: map.size + 1, title: "", counterparty: c.counterparty?.name ?? null,
            agreement: c.agreement ? (c.agreement.title || c.agreement.agreementNo || null) : null,
            currency: c.currency, conditions: [] };
      map.set(key, b);
    }
    b.conditions.push(c);
  }
  for (const b of map.values()) {
    b.conditions.sort((x, y) => (BUNDLE_ORDER[x.kind] ?? 9) - (BUNDLE_ORDER[y.kind] ?? 9) || x.id - y.id);
    const heads = b.conditions.filter((c) => (BUNDLE_ORDER[c.kind] ?? 9) === 0);
    const head = heads[0] ?? b.conditions[0];
    // 同じ契約・相手先に委託料が何本もあれば、まとめて1枚の発注書に載る。
    b.title = heads.length > 1 ? `${head.name} ほか ${heads.length - 1} 件` : head.name;
  }
  return [...map.values()];
}

export function MatterDocuments(
  { detail, onChanged, onOpenDocument, onCompose, onBulkOrders, channels, isAdmin }: {
    detail: MatterDetail;
    onChanged: () => void;
    /** 文書の画面へ移って、その文書を開く。 */
    onOpenDocument?: (documentId: number) => void;
    /** 文書の画面へ移って、この案件の条件を選んだ状態で作成に入る。 */
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null) => void;
    /** 発注書の一括作成（CSV）へ、この案件を決めた状態で移る。 */
    onBulkOrders?: (matterId: number) => void;
    /** 送信のできる口。メールと CloudSign の on/off を出し分ける。 */
    channels?: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
    isAdmin?: boolean;
  }
) {
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [candidates, setCandidates] = useState<CandidateDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = new Set(detail.documents.map((d) => d.id));
  /**
   * 一括修正に出す文書。決定済みの発注書だけが選べる。
   * ここで選ばせないと、直したい文書が分かっているのに、案件まるごと出して
   * 要らない行を Excel で消す作業になる。
   */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  /** 畳む前の下見と、畳んだ結果。 */
  const [teardown, setTeardown] = useState<TeardownPlan | null>(null);
  const [tornDown, setTornDown] = useState<TeardownResult | null>(null);

  /** 決済済みの書き出し。人に決めてもらうことは CSV に出せないので画面に出す。 */
  const [settledNotes, setSettledNotes] = useState<
    { rows: number; notes: Array<{ conditionNo: string | null;
                                   conditionName: string; note: string }> } | null>(null);
  const [showAllNotes, setShowAllNotes] = useState(false);
  const [exported, setExported] =
    useState<{ rows: number; documents: number;
               skipped: Array<{ documentNo: string | null; reason: string }> } | null>(null);
  const fixable = (d: MatterDetail["documents"][number]) =>
    d.status === "issued"
    && (d.templateKey === "purchase_order" || d.templateKey === "intl_purchase_order");
  /** 下書きはひな形を問わずまとめて決定できる。実績は下書きが控えている。 */
  const decidable = (d: MatterDetail["documents"][number]) => d.status === "draft";
  const selectable = (d: MatterDetail["documents"][number]) =>
    fixable(d) || decidable(d) || d.status === "issued";
  const pickedIds = detail.documents.filter((d) => fixable(d) && picked.has(d.id)).map((d) => d.id);
  /** 送れるのは決定済みの文書。ひな形は問わない（発注書と検収書を1通で送る）。 */
  const sendable = (d: MatterDetail["documents"][number]) => d.status === "issued";
  const pickedSendable = detail.documents.filter((d) => sendable(d) && picked.has(d.id));
  const pickedDrafts = detail.documents.filter((d) => decidable(d) && picked.has(d.id)).map((d) => d.id);
  /** 送信の画面を開いているか。決定済みの文書を選んでから開く。 */
  const [sending, setSending] = useState(false);
  /** CloudSign の状態を手で記録する文書。予備系では連携が無いので、ここから記録する。 */
  const [csDoc, setCsDoc] = useState<MatterDetail["documents"][number] | null>(null);
  const [csNotice, setCsNotice] = useState<string | null>(null);
  /** まとめて決定の結果。落ちたものは理由を出す。 */
  const [issued, setIssued] =
    useState<Array<{ documentId: number; documentNo: string | null; ok: boolean; reason?: string }> | null>(null);

  /**
   * 選んだ下書きをまとめて決定する。
   * 決定は相手に出すものが確定する操作なので、何枚に何が起きるかを先に出す。
   */
  async function decidePicked() {
    if (!window.confirm(
      `下書き ${pickedDrafts.length} 件をまとめて決定します。`
      + "決定すると番号が振られ、中身は直せなくなります。"
      + "\n訂正版が含まれていれば、その瞬間に元の版が退きます。")) return;
    setBusy(true); setError(null); setIssued(null);
    try {
      const r = await api.post<{ results: NonNullable<typeof issued> }>(
        "/documents/issue-many", { documentIds: pickedDrafts });
      setIssued(r.results);
      setPicked(new Set());
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /**
   * 決済済みの取引をまるごと書き出す。発注書・検収書・支払を1行にまとめた形で、
   * 「紙は出してあるが金額が一部違う」ときに、表計算で金額だけ直して入れ直す。
   *
   * 案件まるごと出す。決済済みは発注書1枚では完結しない（検収書と支払が
   * 付いてくる）ので、文書を名指しで選ぶ形にはしない。
   */
  async function exportSettled() {
    setBusy(true); setError(null); setSettledNotes(null);
    try {
      const made = await api.get<{
        matter: { matterNo: string | null }; rows: unknown[];
        notes: Array<{ conditionNo: string | null; conditionName: string; note: string }>;
        csv: string;
      }>(`/matters/${detail.id}/settled-export`);
      if (!made.rows.length) setError("書き出せる条件明細がありませんでした");
      else saveCsv(made.csv, `settled_${made.matter.matterNo ?? detail.id}.csv`);
      setSettledNotes({ rows: made.rows.length, notes: made.notes });
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function planTeardown() {
    setBusy(true); setError(null); setTornDown(null);
    try {
      setTeardown(await api.post<TeardownPlan>(
        `/matters/${detail.id}/teardown/preview`, { reason: "" }));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function runTeardown(reason: string, voidConditions: boolean) {
    setBusy(true); setError(null);
    try {
      setTornDown(await api.post<TeardownResult>(
        `/matters/${detail.id}/teardown`, { reason, voidConditions }));
      setTeardown(null);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function exportPicked() {
    setBusy(true); setError(null); setExported(null);
    try {
      const r = await api.post<{ csv: string; rows: number; documents: number;
                                 skipped: Array<{ documentNo: string | null; reason: string }> }>(
        "/documents/batches/export", { documentIds: pickedIds });
      if (!r.rows) setError("出せる明細がありませんでした");
      else saveCsv(r.csv, `orders-${detail.matterNo ?? detail.id}.csv`);
      setExported(r);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!picking) return;
    const q = search.trim();
    api.get<{ documents: CandidateDocument[] }>(`/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCandidates(r.documents.slice(0, 30))).catch(() => setCandidates([]));
  }, [picking, search]);

  async function attach(documentId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/documents`, { documentId });
      setPicking(false); setKeyword(""); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(documentId: number, label: string) {
    if (!confirm(`${label} をこの案件から外します。文書そのものは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/matters/${detail.id}/documents/${documentId}`);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="faint">この案件の文書</span>
        {/*
          作る導線をここに置く。以前は「発行は文書の画面から行います」と書いて
          あるだけで、文書の画面へ行ってから条件を選び直す必要があった。
          この案件の条件を選んだ状態で作成に入る。
        */}
        {onCompose && !picking && (
          detail.conditions.length ? (
            <span className="row" style={{ marginLeft: "auto" }}>
              <span className="faint">検収書は条件をまたいで実績を選べます（委託料と実費を1枚に）</span>
              <button className="btn btn-sm primary"
                      onClick={() => onCompose(detail.conditions.map((c) => c.id), [], detail.id)}>
                この案件で文書を作る
              </button>
            </span>
          ) : (
            <span className="faint" style={{ marginLeft: "auto" }}>
              条件明細を繋ぐと、ここから文書を作れます
            </span>
          )
        )}
        {!picking && (
          <button className="btn btn-sm"
                  onClick={() => setPicking(true)}>すでにある文書を繋ぐ</button>
        )}
      </div>

      {/*
        一括作成の入口。これまで文書の画面の中にしか無く、案件からは辿れなかった。
        条件明細がまだ1件も無い案件でこそ要る（束が条件明細ごと作る）ので、
        「この案件で文書を作る」と違って条件の有無では隠さない。
      */}
      {onBulkOrders && !picking && (
        <div className="row">
          <button className="btn btn-sm" onClick={() => onBulkOrders(detail.id)}>
            発注書をまとめて作る（CSV）
          </button>
          <span className="faint">
            発注先が何社もある業務委託向け。取引先と作品の組ごとに1枚ずつ下書きを起こし、
            条件明細もその場で作ります
          </span>
        </div>
      )}

      {/* 他社文書レビュー型の案件は、相手方から届いた文書を入れないと先へ進めない。 */}
      <DocumentImport matterId={detail.id} onDone={onChanged} />

      {picking && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="文書番号・相手先" label="繋ぐ文書を探す" />
            <button className="btn btn-sm" onClick={() => { setPicking(false); setKeyword(""); }}>やめる</button>
          </div>
          <div className="picker">
            {candidates.map((d) => (
              <button key={d.id} className="btn btn-sm" style={{ textAlign: "left" }}
                      disabled={busy || linked.has(d.id)} onClick={() => void attach(d.id)}>
                <span className="code">{d.documentNo ?? "（下書き）"}</span>
                {" "}{d.templateLabel ?? "—"}{d.counterparty ? `（${d.counterparty}）` : ""}
                {linked.has(d.id) ? "　繋がっています" : ""}
              </button>
            ))}
            {!candidates.length && <span className="faint">繋げる文書がありません</span>}
          </div>
        </div>
      )}

      {/*
        決済済みの取引をまるごと書き出す。上の一括作成が「これから出す紙」なら、
        こちらは「もう終わった取引の作り直し」。発注書だけでは完結しない
        （検収書と支払が付いてくる）ので、案件まるごと出す。
        文書を1枚も選んでいなくても要るので、選択の帯には入れない。
      */}
      {!picking && (
        <div className="row">
          <button className="btn btn-sm" disabled={busy}
                  onClick={() => void exportSettled()}>
            ① 決済済みを CSV に出す（作り直し用）
          </button>
          {/*
            畳むのは書き出したあと。先に畳むと、書き出すものが無くなる
            （紙も実績も消えた条件からは、条件の金額しか出てこない）。
            順番を番号で見せる。
          */}
          <button className="btn btn-sm" disabled={busy}
                  onClick={() => void planTeardown()}>
            ② 旧分を畳む（無効にする）
          </button>
          <span className="faint">
            ① で出した CSV の金額を直し、② で古い紙と支払を畳んでから、
            文書の画面の「検収済みをまとめて入れる（CSV）」で上げ直します
          </span>
        </div>
      )}

      {teardown && (
        <TeardownPanel plan={teardown} busy={busy}
          onCancel={() => setTeardown(null)}
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
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {settledNotes && (
        <div className={settledNotes.notes.length ? "note warn" : "note ok"}>
          明細 {settledNotes.rows} 行を出しました。金額を直したら、文書の画面の
          「検収済みをまとめて入れる（CSV）」から上げ直してください。
          {settledNotes.notes.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <b>人に決めてもらうこと（{settledNotes.notes.length}）</b>
              <ul style={{ margin: "4px 0 0" }}>
                {(showAllNotes ? settledNotes.notes : settledNotes.notes.slice(0, 8))
                  .map((n, i) => <li key={i}>{n.conditionNo ?? n.conditionName}：{n.note}</li>)}
              </ul>
              {settledNotes.notes.length > 8 && (
                <button className="btn btn-sm" style={{ marginTop: 4 }}
                  onClick={() => setShowAllNotes(!showAllNotes)}>
                  {showAllNotes ? "畳む" : `ほか ${settledNotes.notes.length - 8} 件を出す`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {exported && (
        <div className={exported.skipped.length ? "note warn" : "note ok"}>
          発注書 {exported.documents} 枚・明細 {exported.rows} 行を出しました。
          直すところを書き換え、<b>修正理由</b>を入れてから
          「発注書をまとめて作る（CSV）」で上げ直してください。
          {exported.skipped.length > 0 && (
            <div style={{ marginTop: 4 }}>
              出せなかったもの {exported.skipped.length} 件：
              {exported.skipped.map((x) => `${x.documentNo ?? "（番号なし）"}（${x.reason}）`).join("／")}
            </div>
          )}
        </div>
      )}

      {issued && (
        <div className={issued.every((r) => r.ok) ? "note ok" : "note warn"}>
          決定 {issued.filter((r) => r.ok).length} 件
          {issued.filter((r) => r.ok).map((r) => ` ${r.documentNo}`).join("、")}
          {issued.some((r) => !r.ok) && (
            <div style={{ marginTop: 4 }}>
              決定できなかったもの {issued.filter((r) => !r.ok).length} 件：
              {issued.filter((r) => !r.ok).map((r) => `#${r.documentId}（${r.reason}）`).join("／")}
            </div>
          )}
        </div>
      )}

      {/* 左の四角で選んで、まとめて決定するか、一括修正の CSV に出す。
          決定は束の中だけまとめてできたので、束をまたぐと1枚ずつ押すしかなかった。
          書き出しも、直したい文書が分かっているのに案件まるごと出して、
          要らない行を Excel で消す作業になっていた。 */}
      {detail.documents.some(selectable) && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn btn-sm primary" disabled={busy || !pickedDrafts.length}
                  onClick={() => void decidePicked()}>
            選んだ {pickedDrafts.length} 件をまとめて決定
          </button>
          <button className="btn btn-sm" disabled={busy || !pickedIds.length}
                  onClick={() => void exportPicked()}>
            選んだ {pickedIds.length} 件を CSV に出す（一括修正用）
          </button>
          {/* 同じ取引先へ何枚かを1通・1封筒で送る。1枚ずつ送ると、相手の
              受信箱が同じ件名で埋まってどれが何の組か読めなくなる。 */}
          {channels && (
            <button className="btn btn-sm" disabled={busy || !pickedSendable.length}
                    onClick={() => setSending(true)}>
              選んだ {pickedSendable.length} 件を送る
            </button>
          )}
          {detail.documents.some(decidable) && (
            <button className="linky" disabled={busy}
                    onClick={() => setPicked(new Set(detail.documents.filter(decidable).map((d) => d.id)))}>
              下書きをすべて選ぶ
            </button>
          )}
          {detail.documents.some(fixable) && (
            <button className="linky" disabled={busy}
                    onClick={() => setPicked(new Set(detail.documents.filter(fixable).map((d) => d.id)))}>
              決定済みの発注書をすべて選ぶ
            </button>
          )}
          {picked.size > 0 && (
            <button className="linky" onClick={() => setPicked(new Set())}>選択を外す</button>
          )}
          <span className="faint">
            左の四角で選びます。決定は下書きに、CSV は決定済みの発注書に効きます
          </span>
        </div>
      )}

      {csNotice && <div className="note ok">{csNotice}</div>}
      {csDoc && (
        <div className="note" style={{ borderStyle: "solid" }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <b>CloudSign の状態を記録：{csDoc.documentNo ?? `#${csDoc.id}`}</b>
            <span className="faint">{csDoc.templateLabel ?? ""}{csDoc.counterparty ? ` ／ ${csDoc.counterparty}` : ""}</span>
          </div>
          <CloudSignManual documentId={csDoc.id} documentNo={csDoc.documentNo}
            initial={csDoc.sentVia === "cloudsign" ? "executed" : "sent"}
            hasAgreement={csDoc.agreementStatus !== null}
            onDone={(m) => { setCsNotice(m); setCsDoc(null); onChanged(); }}
            onClose={() => setCsDoc(null)} />
        </div>
      )}

      {sending && channels && (
        <SendMany
          documents={pickedSendable.map((d) => ({ id: d.id, documentNo: d.documentNo,
                                                  counterparty: d.counterparty }))}
          channels={channels} isAdmin={Boolean(isAdmin)}
          onDone={() => { setPicked(new Set()); onChanged(); }}
          onClose={() => setSending(false)} />
      )}

      {detail.documents.length ? (
        // 幅が足りないときは、ページごと横に伸ばさず表の中で横に送る。
        <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th></th><th>文書番号</th><th>種別 ／ 取引先</th><th>状態</th><th></th></tr></thead>
          <tbody>
            {detail.documents.map((d) => (
              <tr key={d.id}>
                <td>
                  {/* 選べるのは、決定できる下書きと、送れる・直せる決定済みの文書。
                      退いた版には四角を出さない。 */}
                  {selectable(d) && (
                    <input type="checkbox" checked={picked.has(d.id)}
                           aria-label={`${d.documentNo ?? `#${d.id}`} を選ぶ`}
                           onChange={(e) => setPicked((prev) => {
                             const next = new Set(prev);
                             if (e.target.checked) next.add(d.id); else next.delete(d.id);
                             return next;
                           })} />
                  )}
                </td>
                {/* 案件の右欄は幅が狭い（500px 前後）。番号・状態・ボタンは折り返すと
                    読めなくなるので固定。可変なのは種別だけにして、取引先はその下に
                    小さく置く（文書の一覧と同じ組み方）。列を6つ並べて種別を
                    折り返さないでいると、ひな形の名前が長くなったときに表が枠から
                    はみ出し、取引先が1文字ずつに潰れる。 */}
                <td className="code" style={{ whiteSpace: "nowrap" }}>
                  {d.documentNo ?? "（下書き）"}
                </td>
                <td style={{ minWidth: "8em" }}>
                  {d.templateLabel ?? "—"}
                  <div className="faint">{d.counterparty ?? "相手先なし"}</div>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <StatusTag kind="document" value={d.status} />
                  {/* 送った口と締結。段が見えないと、CloudSign をどこまで進めたか案件から分からない。 */}
                  {d.status === "issued" && (d.agreementStatus === "executed"
                    ? <div><span className="tag ok" title={d.sentAt ? `送信 ${d.sentAt.slice(0, 10)}` : undefined}>締結済み</span></div>
                    : d.agreementStatus === "terminated"
                      ? <div><span className="tag out">辞退・取下げ</span></div>
                      : d.sentVia === "cloudsign"
                        ? <div><span className="tag accent" title={d.sentAt ? `送信 ${d.sentAt.slice(0, 10)}` : undefined}>CloudSign 送信済</span></div>
                        : d.sentVia === "gmail"
                          ? <div><span className="tag" title={d.sentAt ? `送信 ${d.sentAt.slice(0, 10)}` : undefined}>メール送付済</span></div>
                          : null)}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <span className="row" style={{ flexWrap: "nowrap", gap: 4 }}>
                    {/* 一覧から中身へ行けないと、文書番号を控えて文書の画面で
                        探し直すことになる。 */}
                    {onOpenDocument && (
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => onOpenDocument(d.id)}>
                        {d.status === "draft" ? "編集" : "開く"}
                      </button>
                    )}
                    {d.status === "issued" && d.agreementStatus !== "executed" && (
                      <button className="btn btn-sm" disabled={busy}
                        title="CloudSign の画面から直接送った・結果が届いたときに、状態を手で記録する"
                        aria-pressed={csDoc?.id === d.id}
                        onClick={() => { setCsNotice(null); setCsDoc(csDoc?.id === d.id ? null : d); }}>署名</button>
                    )}
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => void detach(d.id, d.documentNo ?? `#${d.id}`)}>外す</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <div className="faint">この案件の文書はまだありません。</div>
      )}
    </div>
  );
}

/** 取引モデルごとに繋げる条件の種類。サーバの CONDITION_KINDS_BY_MATTER と対。 */
const ALLOWED_KINDS: Record<MatterKind, string[]> = {
  work: ["license", "product"],
  outsourcing: ["service", "expense", "fee"],
  // 文書作成でも金銭の条件を持つ文書はある（自社のひな形から出す覚書など）。
  // サーバ側の CONDITION_KINDS_BY_MATTER と同じ並びにしておくこと。
  single: ["license", "product", "service", "expense", "fee"]
};

/**
 * 畳む前の下見。
 *
 * 押すと紙が無効になって番号は戻らない。何が無効になるかを全部出し、
 * 理由を書かせてから初めて押せるようにする。
 */
function TeardownPanel({ plan, busy, onRun, onCancel }: {
  plan: TeardownPlan; busy: boolean;
  onRun: (reason: string, voidConditions: boolean) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [voidConditions, setVoidConditions] = useState(false);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>旧分を畳みます</h2>
        <span className="faint">{plan.matter.matterNo} {plan.matter.title}</span>
      </div>
      <div className="panel-bd stack">
        <div className="row" style={{ gap: 22 }}>
          <div><div className="faint">支払を取り消す</div>
            <div className="num">{plan.summary.payments}</div></div>
          <div><div className="faint">文書を無効にする</div>
            <div className="num">{plan.summary.documents}</div></div>
          <div><div className="faint">実績を取り消す</div>
            <div className="num">{plan.summary.events}</div></div>
          <div><div className="faint">畳む額（税抜）</div>
            <div className="num">{money(plan.summary.amount)}</div></div>
          {plan.summary.blocked > 0 && (
            <div><div className="faint">触らない</div>
              <div className="num" style={{ color: "var(--out)" }}>{plan.summary.blocked}</div></div>
          )}
        </div>

        {plan.warnings.map((w, i) => (
          <div key={i} className={/新しい条件番号|番号も戻りません/.test(w) ? "alert" : "note"}>{w}</div>
        ))}

        {plan.documents.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead><tr><th>文書</th><th>種別</th><th>順</th></tr></thead>
              <tbody>
                {[...plan.documents]
                  .sort((a, b) => Number(b.settlement) - Number(a.settlement) || a.id - b.id)
                  .map((d) => (
                    <tr key={d.id}>
                      <td className="code">{d.documentNo ?? `#${d.id}`}</td>
                      <td>{d.templateLabel ?? "—"}</td>
                      <td className="faint">
                        {/* 決済文書が先。無効にすると実績が解放され、実績を取り消せる。 */}
                        {d.settlement ? "先（実績を解放する）" : "あと"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {plan.payments.filter((p) => p.blocked).length > 0 && (
          <div className="note warn">
            触らない支払：
            {plan.payments.filter((p) => p.blocked)
              .map((p) => `${p.paymentNo ?? `#${p.id}`}（${p.blocked}）`).join("／")}
          </div>
        )}

        <label className="field">
          <span className="flabel">畳む理由（必須。監査に残ります）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="例：発注金額の誤りのため、正しい金額で作り直す" />
        </label>

        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={voidConditions}
            onChange={(e) => setVoidConditions(e.target.checked)} />
          <span>条件明細も無効にする（入れ直しは新しい条件番号になります）</span>
        </label>

        <div className="row">
          <button className="btn" onClick={onCancel}>やめる</button>
          <button className="btn danger" disabled={busy || !reason.trim()}
            onClick={() => onRun(reason.trim(), voidConditions)}>
            {busy ? "畳んでいます…" : "畳む"}
          </button>
        </div>
      </div>
    </div>
  );
}
