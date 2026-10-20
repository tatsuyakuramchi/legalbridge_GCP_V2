import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { useReadOnly } from "./read-only.js";
import { useDebounced } from "./ListTools.js";
import type { EntityKind } from "./Relations.js";
import { AgreementCreate } from "./AgreementsWorkspace.js";
import { ConditionEntryForm } from "./ConditionEntryForm.js";
import { WorkCreateForm } from "./WorkCreateForm.js";
import { WorkChooser, type WorkOption } from "./WorkChooser.js";
import { DocumentImport } from "./DocumentImport.js";
import { TidyWorkspace } from "./TidyWorkspace.js";
import type { LooseCondition, MapAgreement, MapNode, PartyMap, UnlinkedDocument } from "../server/agreements/party-map.js";
import type { DocumentSummary } from "../server/documents/repository.js";
import { DocMatter } from "./DocMatter.js";

/**
 * 整理する ― 取引先ごとに、上から順に台帳をそろえる（本線 ① 登録する の中の順番）。
 *
 *   1 取引先を探す
 *   2 契約の形を決める（基本契約＋個別契約 ／ 独立契約）。今あるものを選ぶか、文書から立てるか、新しく登録する
 *   3 その形に合わせて文書を探して登録する（基本契約書・条件書・発注書・外の文書）
 *   4 文書に合わせて条件を登録する（作品もここで登録）
 *
 * 木と 4 つの印（多重・未登録・欠け・空）は「点検」の切り替えに置く（TidyWorkspace）。
 * 書き込みは全部、今ある道具の API（契約の登録・文書から契約を立てる・繋ぐ・条件の登録）。
 */

type Structure = { kind: "master" | "standalone"; agreementId: number };
type Step = 1 | 2 | 3 | 4;

const KIND_LABEL: Record<string, string> = { master: "基本契約", standalone: "独立契約", supplement: "個別契約", termination: "解除合意", document: "文書" };
const STATUS_LABEL: Record<string, string> = { draft: "下書き", negotiating: "交渉中", executed: "締結済", expired: "満了", terminated: "解除", issued: "決定済", active: "有効" };
const st = (s: string | null | undefined) => (s ? STATUS_LABEL[s] ?? s : "");

interface AgreementLine { id: number; condition_no: string | null; name: string; kind: string; status: string; direction: string; work_title: string | null; term_start: string | null; term_end: string | null }

export function TidyFlow({ initialPartyId, onOpen, header, onPartyChange }: {
  initialPartyId?: number; onOpen?: (kind: EntityKind, id: number) => void; header?: ReactNode;
  onPartyChange?: (id: number | undefined) => void;
}) {
  const readOnly = useReadOnly();
  const [tab, setTab] = useState<"flow" | "check">("flow");
  const [partyId, setPartyIdState] = useState<number | undefined>(initialPartyId);
  const [partyName, setPartyName] = useState<string | null>(null);
  const setPartyId = (id: number | undefined, name: string | null = null) => { setPartyIdState(id); setPartyName(name); onPartyChange?.(id); };
  const [map, setMap] = useState<PartyMap | null>(null);
  const [step, setStep] = useState<Step>(initialPartyId ? 2 : 1);
  const [structure, setStructure] = useState<Structure | null>(null);
  const [shape, setShape] = useState<"master" | "standalone">("master");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    if (!partyId) { setMap(null); return; }
    api.get<PartyMap>(`/agreement-map/parties/${partyId}`)
      .then((m) => { setMap(m); setPartyName(m.party.name); setError(null); })
      .catch((e: ApiError) => { setMap(null); setError(e.message); });
  }, [partyId, version]);

  // 選んだ構造が消えていたら外す（点検で統合した・解除したとき）。
  useEffect(() => {
    if (!map || !structure) return;
    if (!map.roots.some((r) => r.id === structure.agreementId)) setStructure(null);
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(job: () => Promise<string>) {
    setBusy(true); setError(null);
    try { setNotice(await job()); bump(); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const root = map && structure ? map.roots.find((r) => r.id === structure.agreementId) ?? null : null;
  const done1 = Boolean(partyId && map);
  const done2 = Boolean(root);
  const steps: Array<{ no: Step; name: string; done: boolean; detail: string | null }> = [
    { no: 1, name: "取引先を探す", done: done1, detail: partyName },
    { no: 2, name: "契約の形を決める", done: done2, detail: root ? `${KIND_LABEL[root.kind]} ${root.agreementNo ?? ""}` : null },
    { no: 3, name: "文書を探して登録する", done: done2 && docsOf(root!, map!).length > 0, detail: root ? `${docsOf(root, map!).length} 件` : null },
    { no: 4, name: "条件・作品を登録する", done: false, detail: null }
  ];
  const canGo = (no: Step) => no === 1 || (no === 2 && done1) || (no >= 3 && done2);

  return (
    <section className="workspace">
      {header}
      <div className="workspace-head">
        <h1>整理する</h1>
        <p>取引先ごとに、取引先 → 契約の形 → 文書 → 条件・作品 の順に台帳をそろえる（本線 ① 登録する の中の順番）。木と 4 つの印は「点検」。</p>
      </div>
      <div className="tabs">
        <button aria-selected={tab === "flow"} onClick={() => setTab("flow")}>登録の流れ</button>
        <button aria-selected={tab === "check"} onClick={() => setTab("check")}>点検（木と 4 つの印）</button>
      </div>
      {tab === "check" && <TidyWorkspace initialPartyId={partyId} onOpen={onOpen} onPartyChange={(id) => setPartyId(id)} />}
      {tab === "flow" && (
        <>
          {error && <div className="alert">{error}</div>}
          {notice && <div className="note ok">{notice}</div>}
          <div className="steps">
            <div className="steps-rail">
              {steps.map((s) => (
                <button key={s.no} type="button" className={`step-item${s.done ? " done" : ""}${step === s.no ? " now" : ""}`}
                        data-can-go={canGo(s.no) ? "1" : "0"} disabled={!canGo(s.no)} onClick={() => setStep(s.no)}>
                  <span className="no">{s.done ? "✓" : s.no}</span>
                  <span><div>{s.name}</div>{s.detail && <div className="faint">{s.detail}</div>}</span>
                </button>
              ))}
            </div>
            <div className="step-body stack">
              {step === 1 && (
                <StepParty partyId={partyId} partyName={partyName} map={map} onPick={(id, name) => { setPartyId(id, name); setStructure(null); }}
                           onNext={() => setStep(2)} onOpen={onOpen} />
              )}
              {step === 2 && map && partyId && (
                <StepStructure map={map} partyId={partyId} partyName={partyName} shape={shape} onShape={setShape}
                               structure={structure} busy={busy || readOnly}
                               onPick={(s) => { setStructure(s); setStep(3); }}
                               onFromDocument={(d) => run(async () => {
                                 const r = await api.post<{ agreementId: number; agreementNo: string | null; kind: string }>(
                                   `/agreement-map/documents/${d.id}/agreement`, { as: shape });
                                 if (r.kind === shape) setStructure({ kind: shape, agreementId: r.agreementId });
                                 return `${d.documentNo ?? `#${d.id}`} から契約 ${r.agreementNo ?? ""} を立てました`;
                               })}
                               onCreated={(id, no) => { setStructure({ kind: shape, agreementId: id }); setNotice(`契約 ${no ?? ""} を登録しました`); bump(); setStep(3); }} />
              )}
              {step === 3 && map && partyId && root && (
                <StepDocuments map={map} partyId={partyId} root={root} busy={busy || readOnly} onOpen={onOpen}
                               onRegister={(d) => run(async () => {
                                 const r = await api.post<{ agreementNo: string | null; parentNo: string | null; kind: string }>(`/agreement-map/documents/${d.id}/agreement`);
                                 return `${d.documentNo ?? `#${d.id}`} から${KIND_LABEL[r.kind] ?? "契約"} ${r.agreementNo ?? ""} を立てました${r.parentNo ? `（${r.parentNo} の下）` : ""}`;
                               })}
                               onLink={(d) => run(async () => {
                                 await api.post(`/links/document/${d.id}/agreement`, { targetId: root.id });
                                 return `${d.documentNo ?? `#${d.id}`} を ${root.agreementNo ?? ""} に繋ぎました`;
                               })}
                               onImported={() => { setNotice("外の文書を登録しました"); bump(); }}
                               onNotice={(m) => { if (m.startsWith("⚠")) setError(m.slice(1).trim()); else setNotice(m); }}
                               onNext={() => setStep(4)} />
              )}
              {step === 4 && map && partyId && root && (
                <StepConditions map={map} partyId={partyId} partyName={partyName} root={root} busy={busy || readOnly} version={version} onOpen={onOpen}
                                onLink={(c, targetId) => run(async () => {
                                  await api.post(`/links/condition/${c.id}/agreement`, { targetId });
                                  return `${c.conditionNo ?? `#${c.id}`} を契約 #${targetId} に載せました`;
                                })}
                                onCreated={(ids) => { setNotice(`条件を ${ids.length} 本登録しました`); bump(); }} />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** 構造の下にある文書（個別契約＝条件書から立てた契約、発注書）。 */
function docsOf(root: MapNode, map: PartyMap): Array<{ key: string; label: string; no: string | null; status: string; agreementId: number | null; documentId: number | null }> {
  const kids = root.children.map((c) => ({ key: `a${c.id}`, label: `${KIND_LABEL[c.kind] ?? c.kind}　${c.title}`, no: c.agreementNo, status: c.status, agreementId: c.id, documentId: null }));
  const orders = (map.orders ?? []).filter((o) => o.masterId === root.id)
    .map((o) => ({ key: `o${o.id}`, label: `発注書　${o.title ?? ""}`, no: o.documentNo, status: o.status, agreementId: null, documentId: o.id }));
  return [...kids, ...orders];
}

// ---------------------------------------------------------------------

function StepParty({ partyId, partyName, map, onPick, onNext, onOpen }: {
  partyId?: number; partyName: string | null; map: PartyMap | null; onPick: (id: number, name: string | null) => void; onNext: () => void;
  onOpen?: (kind: EntityKind, id: number) => void;
}) {
  return (
    <div className="stack">
      <div className="step-note">名称・コード・カナ・別名で探す。統合元に当たっても統合先が開く。</div>
      <div style={{ maxWidth: 480 }}>
        <SearchSelect value={partyId ? String(partyId) : ""} search={searchParties} placeholder="取引先を探す" valueLabel={partyName}
                      onChange={(v, o) => { if (v) onPick(Number(v), o?.label ?? null); }} autoFocus />
      </div>
      {map && (
        <div className="panel">
          <div className="panel-hd"><h2>{map.party.name}</h2>
            {onOpen && <button className="linky" onClick={() => onOpen("party", map.party.id)}>取引先の画面</button>}
          </div>
          <div className="panel-bd">
            <div className="dl">
              <div><span className="faint">基本契約</span>　{map.roots.filter((r) => r.kind === "master").length} 本</div>
              <div><span className="faint">独立契約</span>　{map.roots.filter((r) => r.kind === "standalone").length} 本</div>
              <div><span className="faint">個別契約・発注書</span>　{map.roots.reduce((a, r) => a + r.children.length, 0) + (map.orders?.length ?? 0)} 件</div>
              <div><span className="faint">契約に繋がっていない文書</span>　{map.unlinked.length} 件</div>
              <div><span className="faint">契約に載っていない条件</span>　{map.looseConditions.length} 本</div>
              {map.issues.length > 0 && <div><span className="faint">ずれ</span>　{map.issues.length} 件（点検で直せます）</div>}
            </div>
            <div style={{ marginTop: 10 }}><button className="btn primary" onClick={onNext}>次へ：契約の形を決める →</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepStructure({ map, partyId, partyName, shape, onShape, structure, busy, onPick, onFromDocument, onCreated }: {
  map: PartyMap; partyId: number; partyName: string | null; shape: "master" | "standalone"; onShape: (s: "master" | "standalone") => void;
  structure: Structure | null; busy: boolean; onPick: (s: Structure) => void; onFromDocument: (d: UnlinkedDocument) => void;
  onCreated: (id: number, no: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);
  const roots = map.roots.filter((r) => r.kind === shape);
  const fromDocs = map.unlinked.filter((d) => (shape === "master" ? d.role === "master" : d.role === "terms"));
  return (
    <div className="stack">
      <div className="step-note">型 1：基本契約の下に個別契約（条件書・発注書）がぶら下がる。型 2：独立契約が条件を直接持つ。今あるものを選ぶか、文書から立てるか、新しく登録する。</div>
      <div className="chips">
        <button className="chip" aria-pressed={shape === "master"} onClick={() => onShape("master")}>型 1　基本契約 ＋ 個別契約</button>
        <button className="chip" aria-pressed={shape === "standalone"} onClick={() => onShape("standalone")}>型 2　独立契約</button>
      </div>
      <div className="panel">
        <div className="panel-hd"><h2>今ある{KIND_LABEL[shape]} {roots.length}</h2></div>
        <div className="panel-bd stack" style={{ gap: 6 }}>
          {!roots.length && <div className="faint">まだありません。下から立てるか登録してください。</div>}
          {roots.map((r) => (
            <div key={r.id} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="code">{r.agreementNo ?? `#${r.id}`}</span><b>{r.title}</b>
              <span className="faint">{st(r.status)}{r.executedOn ? `・締結 ${r.executedOn}` : ""}・条件 {r.conditionCount}・文書 {r.documentCount}{r.primary ? "・既定" : ""}</span>
              <button className={`btn btn-sm${structure?.agreementId === r.id ? " primary" : ""}`} onClick={() => onPick({ kind: shape, agreementId: r.id })}>
                {structure?.agreementId === r.id ? "選択中 → 文書へ" : "これにする"}
              </button>
            </div>
          ))}
        </div>
      </div>
      {fromDocs.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>{shape === "master" ? "基本契約書" : "条件書"}から立てる {fromDocs.length}</h2><span className="faint">契約に繋がっていない文書。番号・件名はそのまま</span></div>
          <div className="panel-bd stack" style={{ gap: 6 }}>
            {fromDocs.map((d) => (
              <div key={d.id} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="code">{d.documentNo ?? `#${d.id}`}</span><span>{d.title ?? d.label}</span>
                <span className="faint">{st(d.status)}{d.issuedOn ? `・${d.issuedOn}` : ""}{d.conditionCount ? `・条件 ${d.conditionCount}` : ""}</span>
                <button className="btn btn-sm" disabled={busy} onClick={() => onFromDocument(d)}>この文書から立てる</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-hd"><h2>新しく登録する</h2><span className="faint">紙の契約が手元にあり、文書としてはまだ入れていないとき</span>
          {!creating && <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setCreating(true)}>{KIND_LABEL[shape]}を登録する</button>}
        </div>
        {creating && (
          <div className="panel-bd">
            <AgreementCreate preset={{ partyId, partyName, kind: shape }} onCancel={() => setCreating(false)}
                             onDone={(id, no) => { setCreating(false); onCreated(id, no); }} />
          </div>
        )}
      </div>
    </div>
  );
}

function StepDocuments({ map, partyId, root, busy, onOpen, onRegister, onLink, onImported, onNext, onNotice }: {
  map: PartyMap; partyId: number; root: MapNode; busy: boolean; onOpen?: (kind: EntityKind, id: number) => void;
  onRegister: (d: UnlinkedDocument) => void; onLink: (d: { id: number; documentNo: string | null }) => void; onImported: () => void; onNext: () => void;
  onNotice: (msg: string) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const q = useDebounced(keyword);
  const [hits, setHits] = useState<DocumentSummary[]>([]);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    api.get<{ documents: DocumentSummary[] }>(`/documents?q=${encodeURIComponent(q.trim())}&partyId=${partyId}`)
      .then((r) => setHits(r.documents.filter((d) => d.status !== "void").slice(0, 20))).catch(() => setHits([]));
  }, [q, partyId]);
  const attached = docsOf(root, map);
  const isMaster = root.kind === "master";
  return (
    <div className="stack">
      <div className="step-note">
        {isMaster
          ? `基本契約 ${root.agreementNo ?? ""} の下に、条件書・発注書を置きます。条件書は「登録する」で個別契約になり、発注書は条件を持つ文書として並びます。`
          : `独立契約 ${root.agreementNo ?? ""} に、契約書・覚書を繋ぎます。`}
        　文書ごとに案件も繋げます（番号・件名で探して決める）。
      </div>
      <div className="panel">
        <div className="panel-hd"><h2>この{KIND_LABEL[root.kind]}の下にある文書 {attached.length}</h2>
          {onOpen && <button className="linky" onClick={() => onOpen("agreement", root.id)}>契約の画面</button>}
        </div>
        <div className="panel-bd stack" style={{ gap: 6 }}>
          {!attached.length && <div className="faint">まだありません。</div>}
          {attached.map((d) => (
            <div key={d.key} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="code">{d.no ?? ""}</span><span>{d.label}</span><span className="faint">{st(d.status)}</span>
              {onOpen && d.agreementId && <button className="linky" onClick={() => onOpen("agreement", d.agreementId!)}>開く</button>}
              {onOpen && d.documentId && <button className="linky" onClick={() => onOpen("document", d.documentId!)}>開く</button>}
              {d.documentId && <DocMatter documentId={d.documentId} busy={busy} onOpen={onOpen} onChanged={onNotice} />}
            </div>
          ))}
        </div>
      </div>
      {map.unlinked.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>契約に繋がっていない文書 {map.unlinked.length}</h2><span className="faint">取り込んだだけで台帳に載っていない紙</span></div>
          <div className="panel-bd stack" style={{ gap: 6 }}>
            {map.unlinked.map((d) => (
              <div key={d.id} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="code">{d.documentNo ?? `#${d.id}`}</span><span>{d.title ?? d.label}</span>
                <span className="faint">{d.label}・{st(d.status)}{d.conditionCount ? `・条件 ${d.conditionCount}` : ""}</span>
                {d.role === "terms" && isMaster && <button className="btn btn-sm primary" disabled={busy} onClick={() => onRegister(d)}>個別契約として登録する</button>}
                {d.role === "master" && <span className="faint">基本契約書は「契約の形」で立てます</span>}
                {d.role !== "master" && !(d.role === "terms" && isMaster) && <button className="btn btn-sm" disabled={busy} onClick={() => onLink(d)}>この契約に繋ぐ</button>}
                {onOpen && <button className="linky" onClick={() => onOpen("document", d.id)}>開く</button>}
                <DocMatter documentId={d.id} busy={busy} onOpen={onOpen} onChanged={onNotice} />
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-hd"><h2>探して繋ぐ</h2><span className="faint">番号・件名で。この取引先の文書だけ</span></div>
        <div className="panel-bd stack" style={{ gap: 6 }}>
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="文書番号・件名" style={{ maxWidth: 420 }} />
          {hits.map((d) => (
            <div key={d.id} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="code">{d.documentNo ?? `#${d.id}`}</span><span>{d.title ?? d.templateLabel ?? ""}</span><span className="faint">{d.phase}</span>
              <button className="btn btn-sm" disabled={busy} onClick={() => onLink(d)}>この契約に繋ぐ</button>
              <DocMatter documentId={d.id} busy={busy} onOpen={onOpen} onChanged={onNotice} />
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="panel-hd"><h2>外の文書を登録する</h2><span className="faint">相手方の文書・紙で交わした契約書にファイルを付けて、当社の番号を振る</span>
          {!importing && <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setImporting(true)}>登録する</button>}
        </div>
        {importing && (
          <div className="panel-bd">
            <DocumentImport agreementId={root.id} initialMode="import" onDone={() => { setImporting(false); onImported(); }} onOpenDocument={onOpen ? (id) => onOpen("document", id) : undefined} />
          </div>
        )}
      </div>
      <div><button className="btn primary" onClick={onNext}>次へ：条件・作品を登録する →</button></div>
    </div>
  );
}

function StepConditions({ map, partyId, partyName, root, busy, version, onOpen, onLink, onCreated }: {
  map: PartyMap; partyId: number; partyName: string | null; root: MapNode; busy: boolean; version: number;
  onOpen?: (kind: EntityKind, id: number) => void;
  onLink: (c: LooseCondition, targetId: number) => void; onCreated: (ids: number[]) => void;
}) {
  // 条件を持つ契約：独立契約そのもの、基本契約なら下の個別契約。
  const holders: MapAgreement[] = root.kind === "standalone" ? [root] : root.children.filter((c) => c.kind === "supplement");
  const [lines, setLines] = useState<Record<number, AgreementLine[]>>({});
  const [target, setTarget] = useState<number | "">(holders[0]?.id ?? "");
  const [adding, setAdding] = useState(false);
  const [work, setWork] = useState<WorkOption | null>(null);
  const [creatingWork, setCreatingWork] = useState(false);
  const [linkTarget, setLinkTarget] = useState<Record<number, string>>({});
  useEffect(() => {
    let alive = true;
    Promise.all(holders.map((h) => api.get<{ lines: AgreementLine[] }>(`/agreements/${h.id}`).then((r) => [h.id, r.lines ?? []] as const).catch(() => [h.id, []] as const)))
      .then((xs) => { if (alive) setLines(Object.fromEntries(xs)); });
    return () => { alive = false; };
  }, [version, root.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!holders.some((h) => h.id === target)) setTarget(holders[0]?.id ?? ""); }, [holders.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const targetAgreement = holders.find((h) => h.id === target) ?? null;
  const loose = map.looseConditions;
  return (
    <div className="stack">
      <div className="step-note">
        {root.kind === "master"
          ? "条件は個別契約（条件書・発注書）に載せます。基本契約は条件を持ちません。個別契約が無ければ、文書の段に戻って条件書を登録してください。"
          : "独立契約は条件を直接持ちます。"}
      </div>
      {holders.map((h) => (
        <div key={h.id} className="panel">
          <div className="panel-hd"><h2><span className="code">{h.agreementNo ?? `#${h.id}`}</span>　{h.title}</h2>
            <span className="faint">{KIND_LABEL[h.kind]}・条件 {(lines[h.id] ?? []).length} 本</span>
            {onOpen && <button className="linky" style={{ marginLeft: "auto" }} onClick={() => onOpen("agreement", h.id)}>契約の画面</button>}
          </div>
          <div className="panel-bd">
            {!(lines[h.id] ?? []).length && <div className="faint">条件がまだありません。</div>}
            {(lines[h.id] ?? []).length > 0 && (
              <table>
                <thead><tr><th>番号</th><th>名前</th><th>作品</th><th>期間</th><th>状態</th></tr></thead>
                <tbody>
                  {(lines[h.id] ?? []).map((c) => (
                    <tr key={c.id}>
                      <td className="code">{onOpen ? <button className="linky code" onClick={() => onOpen("condition", c.id)}>{c.condition_no ?? `#${c.id}`}</button> : c.condition_no}</td>
                      <td>{c.name}</td><td>{c.work_title ?? <span className="faint">作品なし</span>}</td>
                      <td className="faint">{c.term_start ?? ""}{c.term_end ? `〜${c.term_end}` : c.term_start ? "〜" : ""}</td>
                      <td>{st(c.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ))}
      {!holders.length && <div className="note warn">条件を載せる契約がありません。文書の段で条件書を登録するか、契約の形で独立契約を選んでください。</div>}

      {loose.length > 0 && holders.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>契約に載っていない条件 {loose.length}</h2><span className="faint">この取引先の条件で、どの契約にも載っていないもの</span></div>
          <div className="panel-bd stack" style={{ gap: 6 }}>
            {loose.map((c) => (
              <div key={c.id} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="code">{c.conditionNo ?? `#${c.id}`}</span><span>{c.name}</span>
                <span className="faint">{c.workTitle ?? "作品なし"}{c.termStart ? `・${c.termStart}〜` : ""}{c.masterNo ? `・基本契約 ${c.masterNo} に直接` : ""}</span>
                <select value={linkTarget[c.id] ?? String(holders[0]?.id ?? "")} onChange={(e) => setLinkTarget((m) => ({ ...m, [c.id]: e.target.value }))}>
                  {holders.map((h) => <option key={h.id} value={h.id}>{h.agreementNo ?? `#${h.id}`}　{h.title}</option>)}
                </select>
                <button className="btn btn-sm" disabled={busy} onClick={() => onLink(c, Number(linkTarget[c.id] ?? holders[0]!.id))}>載せる</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {holders.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>条件を登録する</h2><span className="faint">作品が無ければ先に作品を登録</span>
            {!adding && <button className="btn btn-sm primary" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setAdding(true)}>条件を登録する</button>}
          </div>
          {adding && (
            <div className="panel-bd stack">
              <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label className="field"><span>載せる契約</span>
                  <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                    {holders.map((h) => <option key={h.id} value={h.id}>{h.agreementNo ?? `#${h.id}`}　{h.title}</option>)}
                  </select>
                </label>
                <label className="field" style={{ minWidth: 280 }}><span>作品</span>
                  <WorkChooser value={work} onChange={setWork} disabled={busy} />
                </label>
                {!creatingWork && <button className="btn btn-sm" onClick={() => setCreatingWork(true)}>作品を登録する</button>}
              </div>
              {creatingWork && (
                <div className="panel"><div className="panel-bd">
                  <WorkCreateForm onCancel={() => setCreatingWork(false)}
                                  onDone={(w) => { setCreatingWork(false); setWork({ id: w.id, title: w.title ?? `#${w.id}`, workCode: null }); }} />
                </div></div>
              )}
              {targetAgreement && (
                <ConditionEntryForm key={`${targetAgreement.id}-${work?.id ?? 0}`}
                  preset={{ counterpartyId: partyId, counterpartyName: partyName, agreementId: targetAgreement.id,
                            agreementLabel: `${targetAgreement.agreementNo ?? ""} ${targetAgreement.title}`.trim(),
                            workId: work?.id ?? null, workTitle: work?.title ?? null, direction: targetAgreement.direction }}
                  onDone={({ conditionIds }) => { setAdding(false); onCreated(conditionIds); }}
                  onCancel={() => setAdding(false)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
