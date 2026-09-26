import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useReadOnly } from "./read-only.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { RptEngine, TXN_TYPES, txnLabel, type Judgement } from "../server/rpt/engine.js";

/**
 * 関連当事者（A-054）。V1 の gas/related_party.html の置き換え。
 *
 *   取引判定   … A ⇄ B の取引を、会社法の利益相反（356条）と会計基準の関連当事者（第11号）で判定
 *   会社・役員 … 判定に使う台帳（取締役会の有無・株主構成・役員と役職）
 *   役会議案   … 判定を取締役会の議案として起票し（稟議の B- 番号）、状態を付ける
 *   判定根拠   … 条文・基準の要旨
 *
 * 判定はサーバで行う（起票のときもサーバで判定し直すので、画面と台帳がずれない）。
 */

interface Entity {
  partyId: number; name: string; partyCode: string | null; hasBoard: boolean;
  shareholders: Array<{ holderKind: "party" | "officer"; holderId: number; holderName: string; pct: number }>;
}
interface Officer {
  id: number; officerKey: string; name: string; staffId: number | null; voided: boolean;
  roles: Array<{ partyId: number; partyName: string; title: string }>;
}
interface MastersResp {
  entities: Entity[]; officers: Officer[]; titles: string[];
  thresholds: { company: number | null; person: number | null };
}
interface Agenda {
  ringiId: number; ringiNo: string; title: string; meetingOn: string | null; txnType: string;
  partyA: string; partyB: string; amountExTax: number | null; isConflict: boolean; isRelatedParty: boolean;
  relatedCategory: string | null; excludedOfficers: string[]; status: "pending" | "approved" | "rejected" | "deferred";
  note: string | null;
}
type Tab = "judge" | "master" | "agenda" | "basis";
const STATUS_JP = { pending: "未上程", approved: "承認", rejected: "否決", deferred: "継続審議" } as const;
const yen = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Number(n).toLocaleString("ja-JP")} 円`);
const digits = (s: string) => s.replace(/[^0-9]/g, "");

export function RptWorkspace() {
  const readOnly = useReadOnly();
  const [role, setRole] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("judge");
  const [m, setM] = useState<MastersResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canWrite = !readOnly && (role === "admin" || role === "legal");

  const load = () => api.get<MastersResp>("/rpt/masters").then(setM).catch((e: ApiError) => setError(e.message));
  useEffect(() => {
    api.get<{ user?: { role: string } }>("/me").then((r) => setRole(r.user?.role ?? null)).catch(() => setRole(null));
    void load();
  }, []);

  const tabs: Array<[Tab, string, boolean]> = [
    ["judge", "取引判定", true], ["master", "会社・役員", true], ["agenda", "役会議案", canWrite], ["basis", "判定根拠", true]
  ];

  return (
    <div className="workspace">
      <header className="workspace-head">
        <h1>関連当事者</h1>
        <p>
          取引 A ⇄ B を、会社法の利益相反・競業（356条）と、会計基準の関連当事者（第11号）の2つで判定します。
          判定は登録した会社・株主構成・役員から行うので、台帳の登録漏れがあると判定も漏れます。
          判定は社内整理の補助です。最終判断は条文・最新の適用指針・個別事情に基づき行ってください。
        </p>
      </header>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}
      <div className="tabs">
        {tabs.filter(([, , show]) => show).map(([t, label]) => (
          <button key={t} aria-selected={tab === t} onClick={() => { setTab(t); setNotice(null); setError(null); }}>{label}</button>
        ))}
      </div>
      {!m ? <div className="faint">読み込んでいます…</div> : (
        <>
          {tab === "judge" && <JudgeTab m={m} canWrite={canWrite} onError={setError}
                                        onFiled={(msg) => { setNotice(msg); setTab("agenda"); }} />}
          {tab === "master" && <MasterTab m={m} canWrite={canWrite} onError={setError}
                                          onChanged={(msg) => { setNotice(msg); setError(null); void load(); }} />}
          {tab === "agenda" && canWrite && <AgendaTab onError={setError} />}
          {tab === "basis" && <BasisTab />}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 取引判定

function JudgeTab({ m, canWrite, onError, onFiled }: {
  m: MastersResp; canWrite: boolean; onError: (e: string) => void; onFiled: (msg: string) => void;
}) {
  const [a, setA] = useState(""); const [b, setB] = useState("");
  const [txn, setTxn] = useState("service");
  const [amount, setAmount] = useState("");
  const [competing, setCompeting] = useState(false);
  const [thc, setThc] = useState(m.thresholds.company === null ? "" : String(m.thresholds.company));
  const [thp, setThp] = useState(m.thresholds.person === null ? "" : String(m.thresholds.person));
  const [result, setResult] = useState<Judgement | null>(null);
  const [meetingOn, setMeetingOn] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const body = () => ({
    a, b, txn, amount: amount ? Number(amount) : null, competing,
    thresholds: { company: thc ? Number(thc) : null, person: thp ? Number(thp) : null }
  });
  async function run() {
    setBusy(true);
    try { setResult(await api.post<Judgement>("/rpt/judge", body())); }
    catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function file() {
    setBusy(true);
    try {
      const r = await api.post<{ ringiNo: string; title: string }>("/rpt/agenda", { ...body(), meetingOn: meetingOn || null, note: note || null });
      onFiled(`${r.ringiNo}「${r.title}」を役会議案として起票しました`);
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function saveThresholds() {
    try {
      await api.put("/rpt/thresholds", { company: thc ? Number(thc) : null, person: thp ? Number(thp) : null });
      onFiled("重要性の基準額を保存しました");
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
  }

  const options = [
    ...m.entities.map((e) => ({ value: `company:${e.partyId}`, label: `【法人】${e.name}` })),
    ...m.officers.map((o) => ({ value: `person:${o.id}`, label: `【役員】${o.name}` }))
  ];
  const partySelect = (value: string, set: (v: string) => void) => (
    <select value={value} onChange={(e) => { set(e.target.value); setResult(null); }}>
      <option value="">選んでください</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-hd"><h2>取引の入力</h2></div>
        <div className="panel-bd stack">
          {!m.entities.length && <div className="note">判定に使う会社がまだありません。「会社・役員」で登録してください。</div>}
          <label className="field"><span>取引当事者 A</span>{partySelect(a, setA)}</label>
          <label className="field"><span>取引当事者 B</span>{partySelect(b, setB)}</label>
          <label className="field">
            <span>取引種別</span>
            <select value={txn} onChange={(e) => { setTxn(e.target.value); setResult(null); }}>
              {TXN_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>取引金額（年間・税抜の目安）</span>
            <input inputMode="numeric" value={amount} placeholder="3000000" onChange={(e) => { setAmount(digits(e.target.value)); setResult(null); }} />
            <span className="faint">{amount ? yen(Number(amount)) : "金額未入力（重要性の判定は保留）"}</span>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={competing} onChange={(e) => { setCompeting(e.target.checked); setResult(null); }} />
            <span>会社の事業の部類に属する取引（競業性あり）</span>
          </label>
          <details>
            <summary className="faint">重要性の基準額（適用指針の目安・要確認）</summary>
            <div className="form-grid">
              <label className="field"><span>法人との取引（円）</span>
                <input inputMode="numeric" value={thc} placeholder="未設定" onChange={(e) => setThc(digits(e.target.value))} /></label>
              <label className="field"><span>役員等個人との取引（円）</span>
                <input inputMode="numeric" value={thp} onChange={(e) => setThp(digits(e.target.value))} /></label>
            </div>
            <div className="faint">役員等個人は「1事業年度1,000万円超」が目安。法人取引は割合基準のため金額換算して設定してください。</div>
            {canWrite && <button className="btn btn-sm" onClick={() => void saveThresholds()}>この基準額を既定にする</button>}
          </details>
          <div className="row">
            <button className="btn primary" disabled={!a || !b || busy} onClick={() => void run()}>判定する</button>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="panel">
          <div className="panel-hd"><h2>判定書</h2></div>
          <div className="panel-bd">
            {result ? <Verdict j={result} /> : <div className="faint">当事者と取引種別を入れて「判定する」を押すと、判定が出ます。</div>}
          </div>
        </div>
        {result && canWrite && (
          <div className="panel">
            <div className="panel-hd"><h2>役会議案として起票</h2><span className="faint">稟議の B- 番号が振られます</span></div>
            <div className="panel-bd stack">
              <div className="form-grid">
                <label className="field"><span>取締役会の日</span><input type="date" value={meetingOn} onChange={(e) => setMeetingOn(e.target.value)} /></label>
                <label className="field wide"><span>メモ</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
              </div>
              <div className="row"><button className="btn primary" disabled={busy} onClick={() => void file()}>この判定を起票する</button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 判定書。V1 の renderVerdict と同じ構成。 */
export function Verdict({ j }: { j: Judgement }) {
  const c = j.conflict, d = j.disclosure, o = j.ownership;
  const t = new Set(c.findings.map((f) => f.type));
  const human = [
    t.has("双方代表") && "双方代表の兼任", t.has("直接取引（相手方を代表）") && "片面代表の兼任",
    (t.has("利益相反（無代表兼任）") || t.has("利益相反（保守）")) && "兼任", t.has("直接取引") && "取締役本人が当事者",
    t.has("間接取引（支配）") && "取締役が相手方を支配", t.has("間接取引") && "債務保証・担保", t.has("競業取引") && "競業"
  ].filter(Boolean) as string[];
  const kaishaho = TXN_TYPES.find((x) => x.id === j.txn);
  return (
    <div className="stack">
      <div>
        <div><b>{j.aLabel}</b> ⇄ <b>{j.bLabel}</b></div>
        <div className="faint">{txnLabel(j.txn)}{j.amount !== null ? `／${yen(j.amount)}` : ""}</div>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className={`tag ${c.hit ? "danger" : "ok"}`}>{c.hit ? "利益相反取引 該当" : "利益相反 非該当"}</span>
        <span className={`tag ${d.related ? "warn" : "ok"}`}>{d.related ? "関連当事者 該当" : "関連当事者 非該当"}</span>
        {o?.relation === "parent-sub" && <span className={`tag ${o.wholly ? "danger" : "warn"}`}>{o.wholly ? "完全親子会社間" : "親子会社間"}</span>}
        {o?.relation === "sibling" && <span className="tag warn">兄弟会社間</span>}
      </div>
      {o && (
        <div className="note">
          {o.relation === "parent-sub"
            ? `資本関係：${o.parent} が ${o.child} の議決権 ${o.pct}% を保有${o.wholly ? "（完全子会社）" : ""}`
            : `資本関係：両社とも ${o.parent} の支配下にある兄弟会社${o.wholly ? "（いずれも完全子会社）" : ""}`}
        </div>
      )}

      <h3>判定プロセス</h3>
      <ol className="stack" style={{ margin: 0, paddingLeft: 18 }}>
        <li>当事者：{j.aLabel} ⇄ {j.bLabel}。人的：{human.length ? human.join("・") : "役員兼任・支配なし（台帳上）"}</li>
        <li>取引内容：{txnLabel(j.txn)}〔会社法：{kaishaho?.kaishaho ?? "個別判断"}／会計：{kaishaho?.disclose ?? ""}〕。
          {d.related ? `重要性：${d.materiality}` : "重要性：関連当事者非該当のため判定不要"}</li>
        <li>結論：承認（会社法）{c.hit ? "あり" : "なし"} ／ 開示（会計）{d.related ? "あり" : "なし"}</li>
      </ol>

      <h3>１．会社法上の利益相反取引</h3>
      {!c.hit ? (
        <>
          <p>取締役の兼任・自己取引・間接取引の関係は検出されませんでした（<b>利益相反取引としての承認決議は不要</b>）。</p>
          {o && (
            <div className="note">
              <b>ただし通常の決議は別途要否を確認：</b>本取引が会社法362条4項の重要事項（重要な財産の処分・譲受け／多額の借財 等）に当たる場合は、
              通常の取締役会決議が別途必要です。親会社から両社に派遣された共通取締役（兼任）の登録漏れがないかも確認してください。
            </div>
          )}
        </>
      ) : Object.entries(c.byCompany).map(([cid, g]) => {
        const mm = j.method[cid];
        return (
          <div key={cid} className="panel">
            <div className="panel-hd"><h2>{g.companyName}</h2></div>
            <div className="panel-bd stack">
              {g.items.map((it, i) => (
                <div key={i}><span className="tag danger">{it.type}</span> <span className="faint">{it.basis}</span><div>{it.detail}</div></div>
              ))}
              <ul style={{ margin: 0 }}>
                <li>事前承認：{mm?.board ? "取締役会の承認（会社法365条1項・356条）" : "株主総会の承認（会社法356条）"}。重要な事実を開示。</li>
                {mm?.board && <li>事後報告：取引後遅滞なく取締役会へ報告（365条2項）。</li>}
                <li>特別利害関係取締役を議決から除斥（369条2項）{mm?.excluded.length ? `：${mm.excluded.join("、")}` : ""}。</li>
                {mm?.board && <li>除斥後に議決に加われる取締役：{mm.baseCount} 名／登録 {mm.total} 名。</li>}
                {g.items.some((it) => it.self) && <li>自己のための直接取引：無過失責任・責任軽減不可（428条）。</li>}
                <li>会社に損害が生じた場合、関与取締役の任務懈怠が推定（423条3項）。</li>
              </ul>
              {mm?.deadlock && (
                <div className="alert">
                  <b>役会不成立 → 株主総会へ：</b>除斥の結果、議決に加われる取締役がいないため取締役会で決議できません。株主総会の承認に上げてください。
                  株主総会では特別利害関係株主も議決できますが、著しく不当な決議は取消事由（831条1項3号）になり得ます。
                </div>
              )}
            </div>
          </div>
        );
      })}
      {o?.relation === "parent-sub" && o.wholly && (
        <div className="note">
          <b>完全親子会社間取引の整理：</b>保護すべき少数株主が存在しないため実質的利益相反性は限定的。完全子会社では唯一株主たる親会社の同意が
          株主全員の同意に当たり、356条承認は不要／瑕疵治癒との整理がある。ただし取締役会設置会社の承認・報告手続自体の要否は別途検討（包括承認等の運用）。
        </div>
      )}

      <h3>２．関連当事者の開示（会計基準）</h3>
      {!d.related ? (
        <p>両当事者は関連当事者の範囲（基準5項）に該当しません。資本関係・役員兼任の登録漏れを確認してください。</p>
      ) : (
        <>
          <div><span className="tag warn">{d.rel!.category}</span> <span className="faint">{d.rel!.ref}</span><div>{d.rel!.note}</div></div>
          <table>
            <tbody>
              <tr><th>重要性の判定</th><td><b>{d.materiality}</b></td></tr>
              <tr><th>取引金額</th><td>{d.amount ? yen(d.amount) : "未入力"}</td></tr>
              <tr><th>適用した基準額</th><td>{d.threshold ? yen(d.threshold) : "未設定"}</td></tr>
            </tbody>
          </table>
          <ul style={{ margin: 0 }}>
            <li>個別財務諸表上の開示対象。重要な取引は内容・金額・取引条件の決定方針を注記（基準10項）。</li>
            <li>連結子会社との取引は連結上相殺消去され、連結注記では対象外。</li>
            <li>重要性は自社の損益・総資産に対する割合基準で最終確認。</li>
          </ul>
        </>
      )}
      <p className="faint">本判定は社内整理の補助です。最終判断は条文・最新の適用指針・個別事情に基づき行ってください。</p>
    </div>
  );
}

// ------------------------------------------------------------------ 会社・役員

function MasterTab({ m, canWrite, onError, onChanged }: {
  m: MastersResp; canWrite: boolean; onError: (e: string) => void; onChanged: (msg: string) => void;
}) {
  const [pick, setPick] = useState(""); const [pickName, setPickName] = useState("");
  const [newName, setNewName] = useState("");
  const [board, setBoard] = useState(true);
  const engine = new RptEngine({
    companies: m.entities.map((e) => ({ id: String(e.partyId), name: e.name, board: e.hasBoard,
      shareholders: e.shareholders.map((s) => ({ holderKind: s.holderKind === "officer" ? "person" as const : "company" as const,
                                                  holderId: String(s.holderId), pct: s.pct })) })),
    directors: []
  });
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); onChanged(msg); } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
  };

  async function addEntity() {
    let partyId = pick ? Number(pick) : null;
    let name = pickName;
    if (!partyId && newName.trim()) {
      // 取引先に無いグループ会社などは、取引先として作ってから印を付ける。
      const p = await api.post<{ id: number; name: string }>("/parties", { name: newName.trim(), kind: "corporate" });
      partyId = p.id; name = p.name;
    }
    if (!partyId) return;
    await api.put(`/rpt/entities/${partyId}`, { hasBoard: board });
    setPick(""); setPickName(""); setNewName("");
    return name;
  }

  return (
    <div className="split">
      <div className="panel">
        <div className="panel-hd"><h2>判定に使う会社</h2><span className="faint">{m.entities.length} 社</span></div>
        <div className="panel-bd stack">
          {canWrite && (
            <div className="stack">
              <label className="field"><span>取引先から選ぶ</span>
                <SearchSelect value={pick} search={searchParties} placeholder="取引先名で探す"
                              onChange={(v, o) => { setPick(v); setPickName(o?.label ?? ""); }} />
              </label>
              <label className="field"><span>取引先に無ければ名前を入れて作る</span>
                <input value={newName} disabled={Boolean(pick)} placeholder="株式会社○○" onChange={(e) => setNewName(e.target.value)} />
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={board} onChange={(e) => setBoard(e.target.checked)} /><span>取締役会設置会社</span>
              </label>
              <div><button className="btn btn-sm" disabled={!pick && !newName.trim()}
                           onClick={() => void call(addEntity, `${pickName || newName} を判定に使う会社にしました`)}>会社を足す</button></div>
            </div>
          )}
          {m.entities.map((e) => (
            <EntityCard key={e.partyId} e={e} m={m} canWrite={canWrite} label={engine.classifyOwnership(
              { id: String(e.partyId), name: e.name, board: e.hasBoard,
                shareholders: e.shareholders.map((s) => ({ holderKind: s.holderKind === "officer" ? "person" : "company",
                                                           holderId: String(s.holderId), pct: s.pct })) }).label}
                        call={call} />
          ))}
          {!m.entities.length && <div className="faint">まだありません。</div>}
        </div>
      </div>
      <OfficersPanel m={m} canWrite={canWrite} call={call} />
    </div>
  );
}

function EntityCard({ e, m, canWrite, label, call }: {
  e: Entity; m: MastersResp; canWrite: boolean; label: string;
  call: (fn: () => Promise<unknown>, msg: string) => Promise<void>;
}) {
  const [rows, setRows] = useState(e.shareholders.map((s) => ({ holder: `${s.holderKind}:${s.holderId}`, pct: String(s.pct) })));
  const total = rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
  const holders = [
    ...m.entities.filter((x) => x.partyId !== e.partyId).map((x) => ({ value: `party:${x.partyId}`, label: `【法人】${x.name}` })),
    ...m.officers.map((o) => ({ value: `officer:${o.id}`, label: `【個人】${o.name}` }))
  ];
  const save = () => call(() => api.put(`/rpt/entities/${e.partyId}/shareholdings`, {
    shareholders: rows.filter((r) => r.holder && r.pct).map((r) => {
      const [kind, id] = r.holder.split(":");
      return { holderKind: kind, holderId: Number(id), pct: Number(r.pct) };
    })
  }), `${e.name} の株主構成を保存しました`);

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{e.name}</h2>
        <span className="tag">{label}</span>
        <span className="faint">{e.hasBoard ? "取締役会設置" : "取締役会なし"}</span>
      </div>
      <div className="panel-bd stack">
        {canWrite && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => void call(() => api.put(`/rpt/entities/${e.partyId}`, { hasBoard: !e.hasBoard }),
              `${e.name} を${e.hasBoard ? "取締役会なし" : "取締役会設置"}にしました`)}>
              {e.hasBoard ? "取締役会なしにする" : "取締役会設置にする"}</button>
            <button className="btn btn-sm" onClick={() => {
              if (confirm(`${e.name} を判定に使う会社から外しますか？（取引先そのものは消えません）`)) {
                void call(() => api.post(`/rpt/entities/${e.partyId}/void`), `${e.name} を外しました`);
              }
            }}>外す</button>
          </div>
        )}
        <details>
          <summary className="faint">株主構成（{e.shareholders.length} 件・計 {e.shareholders.reduce((s, x) => s + x.pct, 0)}%）</summary>
          <table>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <select value={r.holder} disabled={!canWrite}
                            onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, holder: ev.target.value } : x)))}>
                      <option value="">株主を選ぶ</option>
                      {holders.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                    </select>
                  </td>
                  <td><input inputMode="decimal" value={r.pct} disabled={!canWrite} style={{ width: 80 }}
                             onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, pct: ev.target.value } : x)))} /> %</td>
                  {canWrite && <td><button className="btn btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>外す</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {total > 100 && <div className="alert">合計が {total}% で 100% を超えています。</div>}
          {canWrite && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setRows([...rows, { holder: "", pct: "" }])}>株主を足す</button>
              <button className="btn btn-sm primary" disabled={total > 100} onClick={() => void save()}>株主構成を保存</button>
            </div>
          )}
          <div className="faint">100% 子会社は、親会社を 100% で登録します。</div>
        </details>
      </div>
    </div>
  );
}

function OfficersPanel({ m, canWrite, call }: {
  m: MastersResp; canWrite: boolean; call: (fn: () => Promise<unknown>, msg: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ id?: number; name: string; roles: Array<{ partyId: number; title: string }> } | null>(null);
  const has = (partyId: number, title: string) => editing?.roles.some((r) => r.partyId === partyId && r.title === title) ?? false;
  const toggle = (partyId: number, title: string) => editing && setEditing({
    ...editing,
    roles: has(partyId, title) ? editing.roles.filter((r) => !(r.partyId === partyId && r.title === title))
      : [...editing.roles, { partyId, title }]
  });

  return (
    <div className="panel">
      <div className="panel-hd"><h2>役員</h2><span className="faint">{m.officers.length} 人</span></div>
      <div className="panel-bd stack">
        {canWrite && !editing && <div><button className="btn btn-sm" onClick={() => setEditing({ name: "", roles: [] })}>役員を足す</button></div>}
        {editing && (
          <div className="panel">
            <div className="panel-bd stack">
              <label className="field"><span>氏名</span>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="山田 太郎" /></label>
              <div className="faint">就任（会社 × 役職）を押して選びます。</div>
              {m.entities.map((e) => (
                <div key={e.partyId}>
                  <div>{e.name}</div>
                  <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                    {m.titles.map((t) => (
                      <button key={t} className={`btn btn-sm${has(e.partyId, t) ? " primary" : ""}`} onClick={() => toggle(e.partyId, t)}>{t}</button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary btn-sm" disabled={!editing.name.trim()}
                        onClick={() => void call(() => api.post("/rpt/officers", editing), `${editing.name} を保存しました`).then(() => setEditing(null))}>保存</button>
                <button className="btn btn-sm" onClick={() => setEditing(null)}>やめる</button>
              </div>
            </div>
          </div>
        )}
        <table>
          <tbody>
            {m.officers.map((o) => (
              <tr key={o.id}>
                <td><b>{o.name}</b><div className="faint">{o.roles.map((r) => `${r.partyName}・${r.title}`).join("　") || "役職なし"}</div></td>
                {canWrite && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm" onClick={() => setEditing({ id: o.id, name: o.name,
                      roles: o.roles.map((r) => ({ partyId: r.partyId, title: r.title })) })}>直す</button>{" "}
                    <button className="btn btn-sm" onClick={() => {
                      if (confirm(`${o.name} を外しますか？（議案の記録は残ります）`)) void call(() => api.post(`/rpt/officers/${o.id}/void`), `${o.name} を外しました`);
                    }}>外す</button>
                  </td>
                )}
              </tr>
            ))}
            {!m.officers.length && <tr><td className="faint">役員はまだいません。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 役会議案

function AgendaTab({ onError }: { onError: (e: string) => void }) {
  const [items, setItems] = useState<Agenda[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [judgement, setJudgement] = useState<Judgement | null>(null);
  const load = () => api.get<{ agenda: Agenda[] }>("/rpt/agenda").then((r) => setItems(r.agenda)).catch((e: ApiError) => onError(e.message));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    setJudgement(null);
    if (open === null) return;
    api.get<{ judgement: Judgement | null }>(`/rpt/agenda/${open}/judgement`).then((r) => setJudgement(r.judgement))
      .catch((e: ApiError) => onError(e.message));
  }, [open]);

  async function setStatus(a: Agenda, status: Agenda["status"]) {
    try { await api.patch(`/rpt/agenda/${a.ringiId}`, { status }); await load(); }
    catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
  }

  return (
    <div className="stack">
      {(items ?? []).map((a) => (
        <div key={a.ringiId} className="panel">
          <div className="panel-hd">
            <h2 className="code">{a.ringiNo}</h2>
            <span className="faint">{a.meetingOn ?? "取締役会の日 未定"}</span>
            {a.isConflict && <span className="tag danger">利益相反</span>}
            {a.isRelatedParty && <span className="tag warn">関連当事者</span>}
          </div>
          <div className="panel-bd stack">
            <div><b>{a.title}</b></div>
            <div className="faint">{txnLabel(a.txnType)}{a.amountExTax !== null ? `・${yen(a.amountExTax)}` : ""}{a.relatedCategory ? `・区分：${a.relatedCategory}` : ""}</div>
            {a.excludedOfficers.length > 0 && <div>議決除斥：{a.excludedOfficers.join("、")}（369条2項）</div>}
            {a.note && <div className="faint">{a.note}</div>}
            <div className="row" style={{ gap: 4 }}>
              {(Object.keys(STATUS_JP) as Agenda["status"][]).map((s) => (
                <button key={s} className={`btn btn-sm${a.status === s ? " primary" : ""}`} onClick={() => void setStatus(a, s)}>{STATUS_JP[s]}</button>
              ))}
              <button className="btn btn-sm" onClick={() => setOpen(open === a.ringiId ? null : a.ringiId)}>
                {open === a.ringiId ? "判定書を閉じる" : "起票時の判定書"}</button>
            </div>
            {open === a.ringiId && (judgement ? <Verdict j={judgement} /> : <div className="faint">判定書はありません（V1 から移した議案など）。</div>)}
          </div>
        </div>
      ))}
      {items && !items.length && <div className="faint">議案はまだありません。取引判定から起票できます。</div>}
      {!items && <div className="faint">読み込んでいます…</div>}
    </div>
  );
}

// ------------------------------------------------------------------ 判定根拠

const LAW: Array<[string, Array<[string, string]>]> = [
  ["会社法（利益相反・競業）", [
    ["356条1項1号 — 競業取引", "取締役が自己又は第三者のために会社の事業の部類に属する取引をするとき、重要事実を開示し承認を受ける。"],
    ["356条1項2号 — 直接取引", "取締役が自己又は第三者のために会社と取引をするとき。兼任取締役による会社間取引も第三者のための取引として該当しうる。"],
    ["356条1項3号 — 間接取引", "会社が取締役の債務を保証する等、会社と取締役の利益が相反する取引。担保提供等を含む。"],
    ["365条 — 取締役会設置会社", "1項：承認機関は取締役会。2項：取引をした取締役は遅滞なく重要事実を取締役会へ報告。"],
    ["369条2項 — 特別利害関係人の除斥", "当該取締役は議決に加わることができない。定足数・賛否の算定から除外。"],
    ["完全親子会社間と株主全員の同意", "完全子会社では少数株主が存在せず、唯一株主たる親会社の同意が株主全員の同意に当たり356条承認は不要／瑕疵治癒との整理がある。取締役会の手続自体の要否は別途検討。"],
    ["423条3項 — 任務懈怠の推定", "利益相反取引で会社に損害が生じた場合、関与・承認した取締役の任務懈怠が推定される。"],
    ["428条 — 自己のための直接取引", "無過失でも責任を負い、責任の一部免除規定は適用されない。"]
  ]],
  ["関連当事者の開示（企業会計基準第11号／適用指針第13号）", [
    ["関連当事者の範囲（基準5項）", "(1)親会社／(2)子会社／(3)同一の親会社をもつ会社／(4)関連会社及びその子会社／(5)主要株主（議決権10%以上）及びその近親者／(6)役員及びその近親者／(7)(5)(6)が議決権の過半数を所有する会社等／(8)重要な子会社の役員等。"],
    ["議決権比率による区分", "過半数＝子会社、20%以上＝関連会社、10%以上＝主要株主、100%＝完全子会社で連結相殺。登録した株主構成（%）から自動判定。"],
    ["開示対象（基準10項）", "関連当事者との重要な取引について、内容・金額・取引条件の決定方針等を注記。"],
    ["重要性の判断（適用指針）", "役員等個人は1事業年度1,000万円超が目安。法人は損益・貸借対照表項目の割合基準。本ツールは金額換算した基準額で簡易判定。"],
    ["連結と個別", "連結では連結子会社との取引は相殺消去され注記対象外。個別開示と区別。"]
  ]]
];

function BasisTab() {
  return (
    <div className="stack">
      {LAW.map(([h, items]) => (
        <div key={h} className="panel">
          <div className="panel-hd"><h2>{h}</h2></div>
          <div className="panel-bd">
            <dl>{items.map(([t, d]) => <div key={t}><dt><b>{t}</b></dt><dd>{d}</dd></div>)}</dl>
          </div>
        </div>
      ))}
      <p className="faint">条文・基準の要旨です。最新の改正状況は原典で確認してください。</p>
    </div>
  );
}
