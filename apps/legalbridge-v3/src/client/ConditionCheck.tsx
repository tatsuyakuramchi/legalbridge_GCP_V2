import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";

/**
 * 監査 › 条件の点検（docs/navigation.md §6。server/conditions/check-service.ts）。
 *
 * 入金の突き合わせ・計算書・回号を狂わせる条件を 4 つの札で洗い出す。決済の型はここで決められる。
 * 重複・根拠の文書・許諾先の作者は、条件明細を開いて直す（まとめると実績・計算書の付け替えが要るので、
 * ここでは黙って消さない）。
 */

interface CheckCondition {
  id: number; conditionNo: string | null; name: string;
  partyId: number | null; partyName: string | null; workId: number | null; workTitle: string | null;
  usageType: string | null; usageLabel: string; ratePct: number | null;
  settlementMode: string | null; timing: "periodic" | "event"; agreementNo: string | null;
  events: number; documents: number;
}
interface ConditionCheckData {
  duplicates: Array<{ key: string; conditions: CheckCondition[] }>;
  noMode: CheckCondition[]; noBasis: CheckCondition[]; uncovered: CheckCondition[];
  editionsNoOut?: Array<{ id: number; workId: number; workTitle: string; publisherName: string | null; isbn: string | null; publishedOn: string | null }>;
}
type Card = "duplicates" | "noMode" | "noBasis" | "uncovered" | "editionsNoOut" | "workDups" | "sources";

/** 作品の重複・原作の整理（server/works/structure-check.ts）。 */
interface WorkCheck {
  id: number; code: string | null; title: string; kind: string; legacy: boolean; sourceTitle: string | null;
  inConditions: number; outConditions: number; otherConditions: number; documents: number; editions: number;
  parentIds: number[]; childIds: number[];
}
interface WorkStructure {
  duplicates: Array<{ key: string; works: WorkCheck[]; keepId: number; linked: boolean }>;
  sources: Array<{ work: WorkCheck; children: Array<{ id: number; code: string | null; title: string; sourceTitle: string | null }> }>;
}
const WORK_KIND: Record<string, string> = { own: "作品", source_ip: "原作", derivative: "派生作品" };
const CARDS: Array<{ key: Card; label: string; sub: string }> = [
  { key: "duplicates", label: "重複", sub: "同じ作者 × 作品 × 利用形態に 2 本以上" },
  { key: "noMode", label: "決済の型が空", sub: "時限式／イベント式が推測のまま" },
  { key: "noBasis", label: "根拠の文書なし", sub: "契約にも決定済みの文書にも繋がっていない" },
  { key: "uncovered", label: "作者に届かない許諾", sub: "OUT 条件に効く作者の条件が無い" },
  { key: "editionsNoOut", label: "版元・販売元の条件なし", sub: "再許諾・他社販売の刊行物・製品に相手との条件（OUT）が無い" },
  { key: "workDups", label: "作品の重複", sub: "同じ名前の作品が 2 つ以上（表記ゆれを含む）" },
  { key: "sources", label: "原作の整理", sub: "原作は作品の原作名に。作品が 1 つの原作は畳む" }
];

export function ConditionCheck({ onOpenCondition, onOpenWork }: { onOpenCondition: (id: number) => void; onOpenWork?: (id: number) => void }) {
  const readOnly = useReadOnly();
  const [data, setData] = useState<ConditionCheckData | null>(null);
  const [card, setCard] = useState<Card>("duplicates");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [pick, setPick] = useState<Record<number, "periodic" | "event">>({});
  /** 重複のまとまりごとに、残す条件。 */
  const [keep, setKeep] = useState<Record<string, number>>({});
  const [works, setWorks] = useState<WorkStructure | null>(null);
  const [workKeep, setWorkKeep] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<ConditionCheckData>("/conditions-check").then(setData).catch((e: ApiError) => setError(e.message));
    api.get<WorkStructure>("/works-check").then(setWorks).catch((e: ApiError) => setError(e.message));
  }, [version]);
  const count = (k: Card) => k === "workDups" ? works?.duplicates.length ?? 0
    : k === "sources" ? works?.sources.length ?? 0
    : !data ? 0 : k === "duplicates" ? data.duplicates.length : (data[k] ?? []).length;
  /** 作品の重複をまとめる：残す側以外を残す側へ統合する（条件・刊行物・CID・系譜などを移す）。 */
  async function mergeWorks(g: WorkStructure["duplicates"][number]) {
    const keepId = workKeep[g.key] ?? g.keepId;
    const kept = g.works.find((w) => w.id === keepId)!;
    const drops = g.works.filter((w) => w.id !== keepId);
    if (!window.confirm(`${drops.map((w) => w.code ?? `#${w.id}`).join("・")} を ${kept.code ?? `#${keepId}`}「${kept.title}」にまとめます。条件・刊行物・CID・系譜は残す側へ移り、まとめた側は終了になります。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      for (const w of drops) await api.post(`/works/${w.id}/merge`, { intoId: keepId });
      setNotice(`${kept.code ?? `#${keepId}`}「${kept.title}」に ${drops.length} 件をまとめました`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); setVersion((v) => v + 1); } finally { setBusy(false); }
  }
  async function foldSource(s: WorkStructure["sources"][number]) {
    const child = s.children[0];
    if (!window.confirm(`原作「${s.work.title}」を作品「${child.title}」に畳みます。作品の原作名が「${child.sourceTitle || s.work.title}」になり、原作の条件・刊行物は作品へ移ります。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/works/${s.work.id}/fold-source`, {});
      setNotice(`原作「${s.work.title}」を作品「${child.title}」に畳みました`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  async function copySource(s: WorkStructure["sources"][number]) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ updated: number }>(`/works/${s.work.id}/copy-source-title`, {});
      setNotice(`原作名「${s.work.title}」を作品 ${r.updated} 件に写しました（原作名が空の作品だけ）`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  const workLink = (w: { id: number; title: string; code: string | null }) => onOpenWork
    ? <button className="linky" onClick={() => onOpenWork(w.id)}>{w.title}</button> : <span>{w.title}</span>;
  const open = (c: CheckCondition) => (
    <button className="linky code" onClick={() => onOpenCondition(c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
  );
  async function decide(c: CheckCondition) {
    const timing = pick[c.id] ?? c.timing;
    setError(null);
    try {
      await api.put("/royalty-ledger/timing", { conditionId: c.id, timing });
      setNotice(`${c.conditionNo ?? `#${c.id}`} を${timing === "event" ? "イベント式（製造のたび）" : "時限式（締めごと）"}に決めました`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); }
  }
  async function merge(group: { key: string; conditions: CheckCondition[] }) {
    // 既定で残すのは、報告・決定した文書の多い方（付け替えが少なくて済む）。
    const keepId = keep[group.key] ?? [...group.conditions].sort((a, b) => (b.documents + b.events) - (a.documents + a.events))[0].id;
    const kept = group.conditions.find((c) => c.id === keepId)!;
    const drops = group.conditions.filter((c) => c.id !== keepId);
    if (!window.confirm(`${drops.map((c) => c.conditionNo ?? `#${c.id}`).join("・")} の報告を ${kept.conditionNo ?? `#${keepId}`} に移し、無効にします。よろしいですか？`)) return;
    setError(null);
    try {
      const r = await api.post<{ movedEvents: number }>("/conditions-check/merge", { keepId, dropIds: drops.map((c) => c.id) });
      setNotice(`${kept.conditionNo ?? `#${keepId}`} にまとめました（報告 ${r.movedEvents} 件を移しました）`);
      setVersion((v) => v + 1);
    } catch (e) { setError((e as ApiError).message); }
  }
  const head = (c: CheckCondition) => (
    <>
      <td>{open(c)}<div className="faint">{c.name}</div></td>
      <td>{c.partyName ?? "—"}</td>
      <td>{c.workTitle ?? "—"}</td>
      <td>{c.usageLabel}{c.ratePct !== null ? ` ${c.ratePct}%` : ""}</td>
    </>
  );

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>条件の点検</h1>
        <p>入金の突き合わせ・計算書・回号を狂わせる条件を洗い出します。条件番号を押すと条件明細が開きます。</p>
      </header>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 12 }}>
        {CARDS.map((c) => (
          <button key={c.key} className={`btn${card === c.key ? " primary" : ""}`} aria-pressed={card === c.key}
                  style={{ textAlign: "left", display: "block", whiteSpace: "normal" }} onClick={() => setCard(c.key)}>
            <span style={{ display: "block" }}>{c.label}</span>
            <b style={{ fontSize: 22 }}>{(c.key === "workDups" || c.key === "sources" ? works : data) ? count(c.key) : "…"}</b>
            <span style={{ display: "block", fontWeight: 400, opacity: 0.85, fontSize: 12 }}>{c.sub}</span>
          </button>
        ))}
      </div>

      {data && card === "duplicates" && (data.duplicates.length ? data.duplicates.map((g) => (
        <div key={g.key} className="panel">
          <div className="panel-hd">
            <h2>{g.conditions[0].partyName} × {g.conditions[0].workTitle} × {g.conditions[0].usageLabel}</h2>
            <span className="faint">生きている条件が {g.conditions.length} 本。入金・報告がどちらに付くか決まりません。残す方を選んでまとめてください（ほかの条件の報告を移して無効にします。決定した文書・支払・計算書のある条件は寄せられません）</span>
            {!readOnly && <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => void merge(g)}>選んだ条件にまとめる</button>}
          </div>
          <div className="tablewrap"><table>
            <thead><tr><th>残す</th><th>条件</th><th>作者</th><th>作品</th><th>利用形態・料率</th><th>決済の型</th><th>根拠</th><th className="num">報告</th><th className="num">決定した文書</th></tr></thead>
            <tbody>{g.conditions.map((c) => (
              <tr key={c.id}>
                <td><input type="radio" name={`keep-${g.key}`} aria-label={`${c.conditionNo ?? c.id} を残す`}
                           checked={(keep[g.key] ?? [...g.conditions].sort((a, b) => (b.documents + b.events) - (a.documents + a.events))[0].id) === c.id}
                           onChange={() => setKeep((k) => ({ ...k, [g.key]: c.id }))} /></td>
                {head(c)}
                <td>{c.settlementMode ? (c.timing === "event" ? "イベント式" : "時限式") : <span className="tag warn">空</span>}</td>
                <td>{c.agreementNo ? <span className="code">{c.agreementNo}</span> : <span className="tag warn">なし</span>}</td>
                <td className="num">{c.events}</td><td className="num">{c.documents}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )) : <div className="panel"><div className="panel-bd faint">重複した条件はありません</div></div>)}

      {data && card === "noMode" && (
        <div className="panel">
          <div className="panel-hd"><h2>決済の型が空</h2><span className="faint">型を決めると、回の立ち方と回号の数え方が固まります</span></div>
          {data.noMode.length ? <div className="tablewrap"><table>
            <thead><tr><th>条件</th><th>作者</th><th>作品</th><th>利用形態・料率</th><th>いまの推測</th><th>決める</th></tr></thead>
            <tbody>{data.noMode.map((c) => (
              <tr key={c.id}>{head(c)}
                <td className="faint">{c.timing === "event" ? "イベント式（製造のたび）" : "時限式（締めごと）"}</td>
                <td>
                  <select aria-label={`${c.conditionNo ?? c.id} の決済の型`} value={pick[c.id] ?? c.timing}
                          onChange={(e) => setPick((p) => ({ ...p, [c.id]: e.target.value as "periodic" | "event" }))}>
                    <option value="periodic">時限式（締めごと）</option>
                    <option value="event">イベント式（製造のたび）</option>
                  </select>
                  <button className="btn btn-sm" style={{ marginLeft: 6 }} disabled={readOnly} onClick={() => void decide(c)}>決める</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div> : <div className="panel-bd faint">型の空いた条件はありません</div>}
        </div>
      )}

      {data && card === "noBasis" && (
        <div className="panel">
          <div className="panel-hd"><h2>根拠の文書なし</h2><span className="faint">条件明細の「契約の紐づけ」で契約に載せるか、条件書を決定して繋いでください</span></div>
          {data.noBasis.length ? <div className="tablewrap"><table>
            <thead><tr><th>条件</th><th>作者</th><th>作品</th><th>利用形態・料率</th><th className="num">報告</th></tr></thead>
            <tbody>{data.noBasis.map((c) => <tr key={c.id}>{head(c)}<td className="num">{c.events}</td></tr>)}</tbody>
          </table></div> : <div className="panel-bd faint">根拠の無い条件はありません</div>}
        </div>
      )}

      {data && card === "uncovered" && (
        <div className="panel">
          <div className="panel-hd"><h2>作者に届かない許諾</h2><span className="faint">入金しても作者に払いが出ません。作者の条件（IN）の作品・利用形態を確かめるか、作者の条件を足してください</span></div>
          {data.uncovered.length ? <div className="tablewrap"><table>
            <thead><tr><th>許諾（OUT）</th><th>許諾先</th><th>作品</th><th>利用形態</th><th>契約</th></tr></thead>
            <tbody>{data.uncovered.map((c) => (
              <tr key={c.id}>{head(c)}<td>{c.agreementNo ? <span className="code">{c.agreementNo}</span> : "—"}</td></tr>
            ))}</tbody>
          </table></div> : <div className="panel-bd faint">作者に届かない許諾はありません</div>}
        </div>
      )}
      {data && card === "editionsNoOut" && (
        <div className="panel">
          <div className="panel-hd"><h2>版元・販売元の条件なし</h2><span className="faint">再許諾・他社販売の刊行物・製品なのに相手との条件（OUT）がありません。入金の突き合わせと作者への払いに繋がりません。作品の「刊行物・製品」で条件を選ぶか、料率の取り決めが無いなら関係を「グループ会社」に直してください</span></div>
          {(data.editionsNoOut ?? []).length ? <div className="tablewrap"><table>
            <thead><tr><th>作品</th><th>版元・販売元</th><th>ISBN／JAN</th><th>刊行日・発売日</th></tr></thead>
            <tbody>{(data.editionsNoOut ?? []).map((e) => (
              <tr key={e.id}>
                <td>{onOpenWork ? <button className="linky" onClick={() => onOpenWork(e.workId)}>{e.workTitle}</button> : e.workTitle}</td>
                <td>{e.publisherName ?? "—"}</td><td className="code">{e.isbn ?? "—"}</td><td>{e.publishedOn ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div> : <div className="panel-bd faint">相手との条件の無い刊行物・製品はありません</div>}
        </div>
      )}
      {works && card === "workDups" && (works.duplicates.length ? works.duplicates.map((g) => {
        const keepId = workKeep[g.key] ?? g.keepId;
        return (
          <div key={g.key} className="panel">
            <div className="panel-hd">
              <h2>{g.works[0].title}</h2>
              <span className="faint">{g.linked
                ? "原作と作品として系譜で繋がっています。「原作の整理」で原作を作品に畳んでください"
                : `同じ名前の作品が ${g.works.length} 件。残す側を選んでまとめてください（条件・刊行物・CID・系譜を移し、ほかは終了にします）`}</span>
              {!readOnly && !g.linked && (
                <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void mergeWorks(g)}>選んだ作品にまとめる</button>
              )}
            </div>
            <div className="tablewrap"><table>
              <thead><tr><th>残す</th><th>作品</th><th>種別</th><th className="num">作者の条件</th><th className="num">取引先の条件</th>
                <th className="num">ほかの条件</th><th className="num">決定した文書</th><th className="num">刊行物</th><th>原作名</th></tr></thead>
              <tbody>{g.works.map((w) => (
                <tr key={w.id}>
                  <td><input type="radio" name={`wkeep-${g.key}`} aria-label={`${w.code ?? w.id} を残す`} disabled={g.linked}
                             checked={keepId === w.id} onChange={() => setWorkKeep((k) => ({ ...k, [g.key]: w.id }))} /></td>
                  <td>{workLink(w)}<div className="faint code">{w.code ?? `#${w.id}`}{w.legacy ? "・移行" : ""}</div></td>
                  <td>{WORK_KIND[w.kind] ?? w.kind}</td>
                  <td className="num">{w.inConditions}</td><td className="num">{w.outConditions}</td><td className="num">{w.otherConditions}</td>
                  <td className="num">{w.documents}</td><td className="num">{w.editions}</td>
                  <td>{w.sourceTitle ?? <span className="faint">—</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        );
      }) : <div className="panel"><div className="panel-bd faint">同じ名前の作品はありません</div></div>)}

      {works && card === "sources" && (
        <div className="panel">
          <div className="panel-hd"><h2>原作の整理</h2>
            <span className="faint">原作名は作品の項目（原作名）で持ちます。利用許諾計算書の原著作物名は作品の原作名、明細は作品名です。
              作品が 1 つの原作は作品に畳み（原作名に入れて、原作の条件・刊行物を作品へ）、2 つ以上の原作は原作名を各作品に写します（原作の条件はどの作品の分にも効くので、原作は残します）</span>
          </div>
          {works.sources.length ? <div className="tablewrap"><table>
            <thead><tr><th>原作</th><th className="num">作者の条件</th><th className="num">決定した文書</th><th>作品</th><th /></tr></thead>
            <tbody>{works.sources.map((s) => (
              <tr key={s.work.id}>
                <td>{workLink(s.work)}<div className="faint code">{s.work.code ?? `#${s.work.id}`}</div></td>
                <td className="num">{s.work.inConditions}</td><td className="num">{s.work.documents}</td>
                <td>{s.children.length ? s.children.map((c) => (
                  <div key={c.id}>{workLink(c)}{c.sourceTitle ? <span className="faint">（原作名 {c.sourceTitle}）</span> : null}</div>
                )) : <span className="tag warn">作品なし</span>}</td>
                <td style={{ whiteSpace: "nowrap" }}>{!readOnly && (s.children.length === 1
                  ? <button className="btn btn-sm" disabled={busy} onClick={() => void foldSource(s)}>作品に畳む</button>
                  : s.children.length > 1
                    ? <button className="btn btn-sm" disabled={busy || s.children.every((c) => c.sourceTitle)} onClick={() => void copySource(s)}>原作名を作品に写す</button>
                    : <span className="faint">作品を繋ぐか、種別を作品に直す</span>)}</td>
              </tr>
            ))}</tbody>
          </table></div> : <div className="panel-bd faint">原作（種別 原作）の作品はありません</div>}
        </div>
      )}
    </section>
  );
}
