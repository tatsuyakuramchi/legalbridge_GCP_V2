import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { DirectionTag, StatusTag } from "./labels.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { useReadOnly } from "./read-only.js";
import { CsvBar } from "./CsvBar.js";
import { CsvImport } from "./CsvImport.js";
import { DocumentImport } from "./DocumentImport.js";
import { TidyFlow } from "./TidyFlow.js";
import { DocMatter } from "./DocMatter.js";
import { PartySend } from "./PartySend.js";
import { DocumentRegister } from "./DocumentRegister.js";
import { MasterMerge } from "./MasterMerge.js";
import { Relations } from "./Relations.js";
import type { EntityKind } from "./Relations.js";
import type { AgreementDomain, AgreementKind } from "../server/agreements/service.js";
import type { LooseCondition, MapAgreement, MapIssue, MapNode, MapOrder, MapPartyRow, PartyMap, UnlinkedDocument } from "../server/agreements/party-map.js";

/**
 * 取引先 ⇔ 基本契約のマップ。
 *
 * 同じ取引先の基本契約が、画面によって違って見える（統合を辿る／辿らない、
 * 補助文書を親に寄せる／寄せない、種類・状態で絞る／絞らない）。
 * ここでは取引先ひとつぶんの契約を全部引いて
 *   取引先 → 基本契約・単体契約 → 補助文書・解除合意
 * の図にし、図にならないもの（ずれ）をその場で付け替える。
 *
 * 契約の形：取引先は種別（業務委託／ライセンス）× 方向ごとに基本契約を何本も持つ。
 * 条件明細を持つのは個別契約（条件書・発注書）か単体契約で、基本契約は個別契約を持つ。
 */

const KIND_LABEL: Record<AgreementKind, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "個別契約・覚書", termination: "解除合意", document: "文書だけ"
};
const DOMAIN_LABEL: Record<AgreementDomain, string> = { service: "業務委託", license: "ライセンス" };
/** 契約として登録された発注書か（サーバの isOrderAgreement と同じ判定）。 */
const isOrderAgreement = (a: Pick<MapAgreement, "kind" | "agreementNo" | "title">) =>
  (a.kind === "standalone" || a.kind === "document") && /-E?PO-|発注書|purchase_order/i.test(`${a.agreementNo ?? ""} ${a.title ?? ""}`);
/**
 * 「発注書（文書）に寄せる」を出す契約。名前で発注書と分かるもののほか、文書だけの契約と
 * 業務委託の単体契約（番号・件名だけでは発注書か分からない移行分）にも出す。
 * ライセンスの単体契約（条件書）は条件を持つ契約なので出さない。
 */
const canBeOrder = (a: Pick<MapAgreement, "kind" | "agreementNo" | "title" | "domain">) =>
  isOrderAgreement(a) || a.kind === "document" || (a.kind === "standalone" && a.domain === "service");

export function AgreementMapWorkspace(
  { initialPartyId, onOpen, onRegisterAgreement, initialMode, onModeChange, onPartyChange }: {
    initialPartyId?: number; onOpen?: (kind: EntityKind, id: number) => void;
    /** URL から来た切り替え（マップ／整理する）と、切り替え・取引先の変更を親（URL）へ知らせる。 */
    initialMode?: "map" | "tidy"; onModeChange?: (mode: "map" | "tidy") => void; onPartyChange?: (id: number | undefined) => void;
    /** 契約の登録へ（相手先を入れた状態で開く）。契約の無い取引先から始めるとき。 */
    onRegisterAgreement?: (partyId: number, partyName: string | null) => void;
  }
) {
  const [parties, setParties] = useState<MapPartyRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [partyId, setPartyIdState] = useState<number | undefined>(initialPartyId);
  const setPartyId = (id: number | undefined) => { setPartyIdState(id); onPartyChange?.(id); };
  const [map, setMap] = useState<PartyMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  // 「整理する」：同じ取引先の木を、条件から下（実績・支払文書・支払）まで広げて 4 つの印で直す
  // （docs/v3-tidy.md）。入口はここの見出しの切り替え。左の取引先は共有する。
  const [mode, setModeState] = useState<"map" | "tidy">(initialMode ?? "map");
  const setMode = (m: "map" | "tidy") => { setModeState(m); onModeChange?.(m); };

  useEffect(() => {
    const qs = new URLSearchParams();
    if (search.trim()) qs.set("q", search.trim());
    if (issuesOnly) qs.set("issues", "1");
    api.get<{ parties: MapPartyRow[] }>(`/agreement-map/parties?${qs}`)
      .then((r) => setParties(r.parties))
      .catch((e: ApiError) => setError(e.message));
  }, [search, issuesOnly, version]);

  useEffect(() => {
    if (!partyId) { setMap(null); return; }
    api.get<PartyMap>(`/agreement-map/parties/${partyId}`)
      .then(setMap).catch((e: ApiError) => setError(e.message));
  }, [partyId, version]);

  const issueCount = parties.filter((p) => p.issues > 0).length;
  /** CSV の一括修正を開いているか。 */
  const [csvOpen, setCsvOpen] = useState(false);

  const switcher = (
    <div className="chips" style={{ marginBottom: 10 }}>
      <button className="chip" aria-pressed={mode === "map"} onClick={() => setMode("map")}>取引先 ⇔ 基本契約</button>
      <button className="chip" aria-pressed={mode === "tidy"} onClick={() => setMode("tidy")}>整理する</button>
    </div>
  );
  if (mode === "tidy") {
    return <TidyFlow initialPartyId={partyId} onOpen={onOpen} header={switcher} onPartyChange={setPartyId} />;
  }

  return (
    <section className="workspace">
      {switcher}
      <header className="workspace-head">
        <h1>取引先 ⇔ 基本契約</h1>
        <p>
          取引先ごとに、基本契約とその下の個別契約・覚書・解除合意、単体契約を図にします。
          親の無い補助文書や種別の無い基本契約など、画面によって見え方が変わる原因（ずれ）はここで付け替えます。契約締結日もここで入れます（文書には「YYYY年M月D日付＋基本契約名」で出ます）。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      {/* 一括修正：書き出して表計算で直し、取り込んで戻す。当て方は画面の編集と同じ。 */}
      <CsvBar title="CSV で一括修正" style={{ marginBottom: 12 }}
        exports={[
          { value: "all", label: "全取引先の契約（ずれ・最新の参考列つき）",
            href: "/api/v3/agreement-map/export.csv" },
          { value: "party", label: map ? `${map.party.name} の契約だけ` : "選んだ取引先の契約だけ",
            href: partyId ? `/api/v3/agreement-map/export.csv?partyId=${partyId}` : undefined,
            disabled: partyId ? undefined : "先に左で取引先を選んでください" }
        ]}
        note={<>
          書き出した CSV の 件名・種類・種別・方向・親契約番号・締結日・有効開始日・終了日・自動更新・相手方番号 を直して、
          下の「取り込む」で戻します。空欄は触りません。消すときは「なし」。
          <button className="btn btn-sm" style={{ marginLeft: 8 }}
                  onClick={() => setCsvOpen((v) => !v)}>{csvOpen ? "取り込みを閉じる" : "直した CSV を取り込む"}</button>
        </>} />
      {csvOpen && (
        <div style={{ marginBottom: 12 }}>
          <CsvImport initialKind="agreements" lockKind
            onApplied={() => { setNotice("CSV の修正を取り込みました。図を読み直しました"); bump(); }} />
        </div>
      )}

      <div className="ledger-split">
        <div className="panel">
          <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
            <h2>取引先</h2>
            <div style={{ flex: "1 1 100%" }}>
              <ListSearch value={keyword} onChange={setKeyword} placeholder="名称・コード・カナ・別名" label="取引先を絞り込む" />
            </div>
            <label className="faint" style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />
              ずれ・未紐づけのあるものだけ{issueCount > 0 && !issuesOnly ? `（${issueCount}）` : ""}
            </label>
            <span className="faint" style={{ flexBasis: "100%" }}>
              {keyword.trim() ? "契約の無い取引先も出します" : "契約か、契約に繋がっていない文書・条件明細のある取引先。名前で探すと全取引先から"}
            </span>
          </div>
          <div className="ledger-tree">
            {parties.map((p) => (
              <button key={p.id} className="node" aria-pressed={p.id === partyId}
                      onClick={() => { setPartyId(p.id); setNotice(null); setError(null); }}>
                <span className="grow">{p.name}</span>
                {p.issues > 0 && <span className="tag warn">ずれ {p.issues}</span>}
                {p.unlinked > 0 && <span className="tag warn">未紐づけ {p.unlinked}</span>}
                {p.looseConditions > 0 && <span className="tag warn" title="契約に載っていない条件明細">条件 {p.looseConditions}</span>}
                <span className="faint">{p.roots}本</span>
              </button>
            ))}
            {!parties.length && <div className="faint" style={{ padding: 6 }}>該当する取引先はありません</div>}
          </div>
        </div>

        <div className="stack">
          {!map && <div className="note">左から取引先を選んでください。</div>}
          {map && (
            <PartyMapView map={map} onOpen={onOpen} onRegisterAgreement={onRegisterAgreement} sendVersion={version}
              onChanged={(msg) => { setNotice(msg); setError(null); bump(); }}
              onError={setError} />
          )}
        </div>
      </div>
    </section>
  );
}

function PartyMapView(
  { map, onOpen, onRegisterAgreement, onChanged, onError, sendVersion = 0 }: {
    sendVersion?: number;
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onRegisterAgreement?: (partyId: number, partyName: string | null) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const [editing, setEditing] = useState<number | null>(null);
  /** 発注書を紐づける欄（文書か条件を選んだ状態で開く）。 */
  const [poLink, setPoLink] = useState<{ documentId: number | null; conditionIds: number[] } | null>(null);
  const orders = map.orders ?? [];
  /** 基本契約なしの発注書を入れられる基本契約（この取引先の基本契約）。 */
  const masters = map.roots.filter((r) => r.kind === "master");
  const [underChoice, setUnderChoice] = useState<Record<number, string>>({});
  const [underBusy, setUnderBusy] = useState<number | null>(null);
  async function putUnder(o: MapOrder) {
    const agreementId = Number(underChoice[o.id] ?? masters[0]?.id ?? 0);
    if (!agreementId) return;
    setUnderBusy(o.id);
    try {
      const r = await api.post<{ conditionsLinked: number; agreementNo: string | null }>(`/agreement-map/orders/${o.id}/master`, { agreementId });
      onChanged(`${o.documentNo ?? `#${o.id}`} を ${r.agreementNo ?? "基本契約"} の下の発注書にしました（条件明細 ${r.conditionsLinked} 本）`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setUnderBusy(null); }
  }
  const orderView = (o: MapOrder) => (
    <div key={`o${o.id}`} className="amap-node">
      <div className="amap-line">
        <span className="tag ghost">発注書</span>
        {o.imported && <span className="tag ghost">取込</span>}
        <button className="linky code" onClick={() => onOpen?.("document", o.id)}>{o.documentNo ?? `#${o.id}`}</button>
        <span>{o.title ?? ""}</span>
        {o.issuedOn && <span className="faint">{o.issuedOn}</span>}
        <span className="faint">
          {o.conditions.length ? `条件 ${o.conditions.length}：${o.conditions.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}` : "条件なし"}
        </span>
        <DocMatter documentId={o.id} busy={false} onOpen={onOpen}
                   onChanged={(m) => (m.startsWith("⚠") ? onError(m.slice(1).trim()) : onChanged(m))} />
        <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                onClick={() => setPoLink({ documentId: o.id, conditionIds: [] })}>条件を紐づける</button>
      </div>
    </div>
  );
  /** 「個別契約にする／単体契約に戻す」の欄を開いている契約。 */
  const [leveling, setLeveling] = useState<number | null>(null);
  const issuesOf = (id: number) => map.issues.filter((i) => i.agreementId === id);

  const node = (a: MapAgreement, extra?: { childCount?: number }) => (
    <AgreementNode key={a.id} a={a} issues={issuesOf(a.id)}
      childCount={extra?.childCount ?? 0} orderCount={orders.filter((o) => o.masterId === a.id).length}
      editing={editing === a.id} onEdit={() => setEditing(editing === a.id ? null : a.id)}
      leveling={leveling === a.id} onLevel={() => setLeveling(leveling === a.id ? null : a.id)}
      onOpen={onOpen} roots={map.roots}
      onSaved={(msg) => { setEditing(null); setLeveling(null); onChanged(msg); }}
      onDocsChanged={(msg) => onChanged(msg)} onError={onError} />
  );

  return (
    <>
      {map.issues.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>ずれ</h2><span className="tag warn">{map.issues.length}</span></div>
          <div className="panel-bd">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {map.issues.map((i, n) => (
                <li key={n}>
                  <button className="linky" onClick={() => i.code === "standalone_with_master"
                    ? setLeveling(i.agreementId) : setEditing(i.agreementId)}>{i.message}</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-hd">
          <h2>{map.party.name}</h2>
          {onOpen && <button className="linky" onClick={() => onOpen("party", map.party.id)}>取引先を開く</button>}
          {onRegisterAgreement && (
            <button className="btn btn-sm" style={{ whiteSpace: "nowrap" }} onClick={() => onRegisterAgreement(map.party.id, map.party.name)}>契約を登録</button>
          )}
          <button className="btn btn-sm primary" style={{ whiteSpace: "nowrap" }}
                  onClick={() => setPoLink({ documentId: null, conditionIds: [] })}>検索して紐づける（基本契約 → 発注書 → 条件）</button>
          <span className="faint" style={{ marginLeft: "auto" }}>
            基本契約は種別 × 方向ごとに何本あってもかまいません。基本契約の下に個別契約（条件書・発注書）が並び、条件明細はそこに載ります
          </span>
        </div>
        <div className="panel-bd">
          <p className="faint" style={{ margin: "0 0 10px" }}>
            取引の形は2つです。<b>（1）基本契約＋個別契約</b>：基本契約は個別契約を持ちます。条件明細は基本契約ではなく、その下の個別契約（業務委託なら発注書、ライセンスなら条件書）が持ちます。
            <b>（2）単体契約</b>：その取引だけで完結する契約で、条件明細を直接持ちます。
            どちらにも載っていない条件明細は下に並ぶので、発注書に紐づけるか、個別契約・単体契約に載せてください。
          </p>
          <div className="amap">
            <div className="amap-party">{map.party.name}</div>
            <div className="amap-roots">
              {map.roots.map((r: MapNode) => (
                <div key={r.id} className="amap-root">
                  {node(r, { childCount: r.children.length })}
                  {(r.children.length > 0 || orders.some((o) => o.masterId === r.id)) && (
                    <div className="amap-children">
                      {r.children.map((c) => node(c))}
                      {orders.filter((o) => o.masterId === r.id).map(orderView)}
                    </div>
                  )}
                </div>
              ))}
              {!map.roots.length && (
                <div className="faint">
                  基本契約・単体契約はありません。
                  {map.unlinked.some((d) => d.role)
                    ? "下の「契約に繋がっていない文書」で、基本契約書 → 条件書 の順に「この文書から立てる」を押してください。残った条件明細は、その下で契約に載せます。"
                    : map.looseConditions.length > 0
                      ? "基本契約を結ばず発注書で取引している相手なら、下の「持ち主の決まっていない条件明細」で発注書を紐づけてください（発注書の約款で取引）。基本契約を結んでいるなら、先に「契約を登録」で基本契約を立てると、紐づけた発注書がその下に入ります。"
                      : map.unlinked.length > 0 && "「契約を登録」で契約を立てると、下の文書を繋げます。"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 文書を番号・件名で探し、基本契約・個別契約・単体契約として登録して、メール・クラウドサインで送る。 */}
      <DocumentRegister map={map} version={sendVersion} onOpen={onOpen} onChanged={onChanged} onError={onError}
        onAsOrder={(id) => setPoLink({ documentId: id, conditionIds: [] })} />

      {/* 契約の構造を見ながら送る。決定済みの文書を契約ごとに並べ、選んで 1 通で送る。 */}
      <PartySend map={map} version={sendVersion} onOpen={onOpen} />

      {orders.some((o) => o.masterId === null) && (
        <div className="panel">
          <div className="panel-hd">
            <h2>基本契約なしの発注書</h2>
            <span className="faint">発注書の約款で取引しているもの。基本契約を結んだら、その下の個別契約として入れます</span>
          </div>
          <div className="panel-bd amap-children" style={{ marginLeft: 0 }}>
            {orders.filter((o) => o.masterId === null).map((o) => (
              <div key={`m${o.id}`}>
                {orderView(o)}
                {masters.length > 0 && o.conditions.length > 0 && (
                  <div className="row" style={{ gap: 6, margin: "2px 0 8px 12px", alignItems: "center" }}>
                    <span className="faint">基本契約の下に入れる：</span>
                    <select value={underChoice[o.id] ?? String(masters[0].id)}
                            onChange={(e) => setUnderChoice((c) => ({ ...c, [o.id]: e.target.value }))}>
                      {masters.map((m) => <option key={m.id} value={m.id}>{m.agreementNo ?? `#${m.id}`} {m.title}</option>)}
                    </select>
                    <button className="btn btn-sm primary" disabled={underBusy === o.id}
                            title="この発注書を基本契約の下の個別契約にします（別の契約に載っている条件明細は動かしません）"
                            onClick={() => void putUnder(o)}>入れる</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {poLink && (
        <OrderLinkPanel map={map} documentId={poLink.documentId} conditionIds={poLink.conditionIds}
          onDone={(msg) => { setPoLink(null); onChanged(msg); }} onCancel={() => setPoLink(null)} onError={onError} />
      )}

      {map.unlinked.length > 0 && (
        <UnlinkedDocuments docs={map.unlinked} map={map} onOpen={onOpen} onChanged={onChanged} onError={onError}
          onAsOrder={(id) => setPoLink({ documentId: id, conditionIds: [] })} />
      )}

      {map.looseConditions.length > 0 && (
        <LooseConditions conds={map.looseConditions} map={map} onOpen={onOpen} onChanged={onChanged} onError={onError}
          onLinkOrder={(ids) => setPoLink({ documentId: null, conditionIds: ids })} />
      )}

      {map.loose.length > 0 && (
        <div className="panel">
          <div className="panel-hd">
            <h2>どこにもぶら下がっていない補助文書・解除合意</h2>
            <span className="faint">親を付けると上の図に入ります</span>
          </div>
          <div className="panel-bd amap-children" style={{ marginLeft: 0 }}>{map.loose.map((a) => node(a))}</div>
        </div>
      )}

      {map.documents.length > 0 && (
        <div className="panel">
          <div className="panel-hd"><h2>文書だけ</h2><span className="faint">NDA など。基本契約としては拾われません</span></div>
          <div className="panel-bd amap-children" style={{ marginLeft: 0 }}>{map.documents.map((a) => node(a))}</div>
        </div>
      )}
    </>
  );
}

/**
 * 契約に繋がっていない文書（契約書・覚書・NDA など）。取り込んだだけで、契約（合意）に
 * 載っていない紙。選んだ契約に繋ぐ（文書のつながり「契約（合意）」と同じ）。
 */
function UnlinkedDocuments(
  { docs, map, onOpen, onChanged, onError, onAsOrder }: {
    docs: UnlinkedDocument[]; map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
    /** 発注書として扱う（契約に繋がず、条件に紐づける）。 */
    onAsOrder: (documentId: number) => void;
  }
) {
  const readOnly = useReadOnly();
  const targets = [
    ...map.roots.flatMap((r) => [r as MapAgreement, ...r.children]), ...map.loose, ...map.documents
  ];
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  // 基本契約書 → 条件書 の順に立てる。基本契約がまだ無く、基本契約書が残っているうちは
  // 条件書を立てない（先に立てると単体契約になり、あとで個別契約にし直す手間が出る）。
  const liveMasters = map.roots.filter((r) => r.kind === "master" && !r.terminatedOn);
  const hasMaster = liveMasters.length > 0;
  const masterDocLeft = docs.some((d) => d.role === "master");
  /** 条件書を個別契約にするときの親の基本契約（基本契約が何本もあるとき選ぶ）。 */
  const [parentOf, setParentOf] = useState<Record<number, string>>({});
  async function create(doc: UnlinkedDocument, as: "master" | "standalone" | null = null) {
    setBusy(doc.id);
    try {
      const parentId = !as && hasMaster ? Number(parentOf[doc.id] ?? liveMasters[0].id) : null;
      const r = await api.post<{ agreementNo: string; kind: string; parentNo: string | null; conditionsLinked: number }>(
        `/agreement-map/documents/${doc.id}/agreement`, as ? { as } : parentId ? { as: "supplement", parentId } : {});
      const what = r.kind === "master" ? "基本契約" : r.kind === "supplement" ? `${r.parentNo ?? "基本契約"} の下の個別契約` : "単体契約";
      onChanged(`${doc.documentNo ?? `#${doc.id}`} から${what}を立てました（番号 ${r.agreementNo}${r.conditionsLinked ? `・条件明細 ${r.conditionsLinked} 本を載せました` : ""}）。締結日は「編集」で入れてください`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(null); }
  }
  async function link(doc: UnlinkedDocument) {
    const target = Number(choice[doc.id] ?? "");
    if (!target) return;
    setBusy(doc.id);
    try {
      await api.post(`/links/document/${doc.id}/agreement`, { targetId: target });
      const a = targets.find((t) => t.id === target);
      onChanged(`${doc.documentNo ?? `#${doc.id}`} を ${a?.agreementNo ?? `#${target}`} に繋ぎました`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(null); }
  }
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>契約に繋がっていない文書</h2>
        <span className="tag warn">{docs.length}</span>
        <span className="faint">契約書・覚書・NDA など。発注書・検収書・計算書は契約に繋がないので出しません</span>
      </div>
      {docs.some((d) => d.role) && (
        <div className="panel-bd" style={{ paddingBottom: 0 }}>
          <div className="note">
            基本契約書・業務委託契約書・条件書は「この文書から立てる」で契約にできます（番号・件名は文書のまま）。
            業務委託契約書は、継続取引の土台なら「基本契約として立てる」、その取引だけで完結するなら「単体契約として立てる」を選びます。<b>基本契約書 → 条件書</b> の順に押すと、
            条件書は基本契約の下の個別契約になり、載っている条件明細はその個別契約のものになります。基本契約が無ければ条件書は単体契約になります。
          </div>
        </div>
      )}
      <div className="tablewrap">
        <table>
          <thead><tr><th>文書番号</th><th>種別・件名</th><th>日付</th><th>案件</th><th>この文書から立てる</th><th>既にある契約に繋ぐ</th><th></th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="code">
                  {onOpen ? <button className="linky" onClick={() => onOpen("document", d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                          : d.documentNo ?? `#${d.id}`}
                </td>
                <td>{d.label}{d.title ? `（${d.title}）` : ""}</td>
                <td className="faint" style={{ whiteSpace: "nowrap" }}>{d.issuedOn ?? "—"}</td>
                <td><DocMatter documentId={d.id} busy={readOnly || busy === d.id} onOpen={onOpen}
                               onChanged={(m) => (m.startsWith("⚠") ? onError(m.slice(1).trim()) : onChanged(m))} /></td>
                <td>
                  {d.role === "master" && (
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <button className="btn btn-sm primary" style={{ whiteSpace: "nowrap" }} disabled={readOnly || busy === d.id}
                              title="この文書を基本契約にします。以後の発注書・条件書はこの下に入ります"
                              onClick={() => void create(d, "master")}>基本契約として立てる</button>
                      <button className="btn btn-sm" style={{ whiteSpace: "nowrap" }} disabled={readOnly || busy === d.id}
                              title="この取引だけで完結する契約（単体契約）にします。載っている条件明細を直接持ちます"
                              onClick={() => void create(d, "standalone")}>単体契約として立てる</button>
                    </div>
                  )}
                  {d.role === "terms" && (
                    !hasMaster && masterDocLeft
                      ? <span className="faint">先に基本契約書を立ててください</span>
                      : (
                        <div className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                          <button className="btn btn-sm primary" style={{ whiteSpace: "nowrap" }} disabled={readOnly || busy === d.id}
                                  title={d.conditionCount ? `載っている条件明細 ${d.conditionCount} 本も一緒に載せます` : undefined}
                                  onClick={() => void create(d)}>
                            {hasMaster ? "個別契約として立てる" : "単体契約として立てる"}
                          </button>
                          {liveMasters.length > 1 && (
                            <select value={parentOf[d.id] ?? String(liveMasters[0].id)} disabled={readOnly} style={{ maxWidth: 240 }}
                                    aria-label="親の基本契約" onChange={(e) => setParentOf((p) => ({ ...p, [d.id]: e.target.value }))}>
                              {liveMasters.map((m) => <option key={m.id} value={m.id}>{m.agreementNo ?? `#${m.id}`} {m.title}</option>)}
                            </select>
                          )}
                        </div>
                      )
                  )}
                  {!d.role && (
                    <button className="btn btn-sm" style={{ whiteSpace: "nowrap" }} disabled={readOnly}
                            title="発注書は契約に繋がず、条件明細に紐づけます"
                            onClick={() => onAsOrder(d.id)}>発注書として扱う</button>
                  )}
                  {d.role && d.conditionCount > 0 && <div className="faint" style={{ fontSize: 12 }}>条件明細 {d.conditionCount} 本</div>}
                </td>
                <td>
                  {targets.length
                    ? <select value={choice[d.id] ?? ""} disabled={readOnly} style={{ maxWidth: 320 }}
                              onChange={(e) => setChoice((c) => ({ ...c, [d.id]: e.target.value }))}>
                        <option value="">選んでください</option>
                        {targets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.agreementNo ?? `#${a.id}`} {a.title}（{KIND_LABEL[a.kind]}）
                          </option>
                        ))}
                      </select>
                    : <span className="faint">{d.role ? "左のボタンで立てる" : "先に「契約を登録」"}</span>}
                </td>
                <td>
                  <button className="btn btn-sm primary" style={{ whiteSpace: "nowrap" }} disabled={readOnly || !choice[d.id] || busy === d.id}
                          onClick={() => void link(d)}>繋ぐ</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * 契約に載っていない条件明細。契約（基本契約・単体契約など）を登録したあと、ここで
 * 選んでまとめて載せる（条件のつながり「契約（合意）」と同じ。向きの違う契約には載せない）。
 * 条件が載ると、計算書の「契約番号」や文書の基本契約がこの契約から出る。
 */
function LooseConditions(
  { conds, map, onOpen, onChanged, onError, onLinkOrder }: {
    conds: LooseCondition[]; map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
    /** 選んだ条件に発注書を紐づける（（1）基本契約の下の発注書が条件を持つ）。 */
    onLinkOrder: (conditionIds: number[]) => void;
  }
) {
  const readOnly = useReadOnly();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = conds.filter((c) => picked.has(c.id));
  const directions = [...new Set(chosen.map((c) => c.direction))];
  // 載せ先は契約本体（基本契約・単体契約・補助文書）。文書だけ・解除合意には載せない。
  // 条件を直接持つのは単体契約と個別契約（条件書）。基本契約は条件を持たない（発注書が持つ）。
  const targets = [...map.roots.flatMap((r) => [r as MapAgreement, ...r.children]), ...map.loose]
    .filter((a) => (a.kind === "standalone" || a.kind === "supplement") && a.status !== "terminated")
    .filter((a) => directions.length !== 1 || a.direction === directions[0]);
  const toggle = (id: number) => setPicked((p) => {
    const next = new Set(p); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  async function attach() {
    const agreementId = Number(target);
    if (!agreementId || !chosen.length) return;
    setBusy(true);
    const done: string[] = [];
    try {
      for (const c of chosen) {
        await api.post(`/links/condition/${c.id}/agreement`, { targetId: agreementId });
        done.push(c.conditionNo ?? `#${c.id}`);
      }
      const a = targets.find((t) => t.id === agreementId);
      setPicked(new Set()); setTarget("");
      onChanged(`${done.join("・")} を ${a?.agreementNo ?? `#${agreementId}`} に載せました`);
    } catch (e) {
      // 途中で止まったら、載せたぶんを知らせて読み直す（残りは一覧に残る）。
      onError(`${done.length ? `${done.join("・")} は載せました。` : ""}${(e as ApiError).message}`);
      if (done.length) onChanged(`${done.join("・")} を載せました（残りは載っていません）`);
    } finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd" style={{ flexWrap: "wrap", gap: 6 }}>
        <h2>持ち主の決まっていない条件明細</h2>
        <span className="tag warn">{conds.length}</span>
        <span className="faint">選んで契約に載せます。取り消し・差し替え済みの条件は出しません</span>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th></th><th>条件番号</th><th>条件名</th><th>作品</th><th>向き</th><th>状態</th></tr></thead>
          <tbody>
            {conds.map((c) => (
              <tr key={c.id}>
                <td><input type="checkbox" aria-label={`${c.conditionNo ?? c.id} を選ぶ`} disabled={readOnly}
                           checked={picked.has(c.id)} onChange={() => toggle(c.id)} /></td>
                <td className="code">
                  {onOpen ? <button className="linky" onClick={() => onOpen("condition", c.id)}>{c.conditionNo ?? `#${c.id}`}</button>
                          : c.conditionNo ?? `#${c.id}`}
                </td>
                <td>{c.name}{c.masterNo && <span className="tag warn" style={{ marginLeft: 6 }} title="条件明細を持つのは個別契約（条件書・発注書）か単体契約です。発注書に紐づけるか、個別契約・単体契約に載せてください">基本契約 {c.masterNo} に直接</span>}</td>
                <td className="faint">{c.workTitle ?? "—"}</td>
                <td><span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span></td>
                <td><StatusTag kind="condition" value={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel-bd row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span>選んだ {chosen.length} 本を</span>
        <button className="btn btn-sm primary" disabled={readOnly || !chosen.length || directions.length > 1}
                onClick={() => onLinkOrder(chosen.map((c) => c.id))}>（1）発注書を紐づける</button>
        <span className="faint">または（2）個別契約・単体契約に載せる：</span>
        {directions.length > 1
          ? <span className="tag warn">IN と OUT が混ざっています。向きごとに分けて載せてください</span>
          : targets.length
            ? <select value={target} disabled={readOnly || !chosen.length} style={{ maxWidth: 360 }}
                      onChange={(e) => setTarget(e.target.value)}>
                <option value="">単体契約・個別契約を選んでください</option>
                {targets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.agreementNo ?? `#${a.id}`} {a.title}（{KIND_LABEL[a.kind]}・{a.direction === "in" ? "IN" : "OUT"}）
                  </option>
                ))}
              </select>
            : <span className="faint">{chosen.length ? "載せられる単体契約・個別契約がありません" : "条件を選んでください"}</span>}
        <button className="btn btn-sm primary" disabled={readOnly || busy || !target || !chosen.length || directions.length > 1}
                onClick={() => void attach()}>載せる</button>
      </div>
    </div>
  );
}

function AgreementNode(
  { a, issues, childCount, orderCount, editing, onEdit, leveling, onLevel, onOpen, roots, onSaved, onDocsChanged, onError }: {
    a: MapAgreement; issues: MapIssue[]; editing: boolean; onEdit: () => void;
    /** 基本契約の下の個別契約・発注書の数（基本契約は条件明細ではなく個別契約を持つ）。 */
    childCount: number; orderCount: number;
    /** 個別契約にする（単体契約）／単体契約に戻す（個別契約）の欄。 */
    leveling: boolean; onLevel: () => void;
    onOpen?: (kind: EntityKind, id: number) => void; roots: MapNode[];
    onSaved: (msg: string) => void;
    /** 文書を取り込んだ・繋いだ・外したとき。図（文書の件数）を読み直す。 */
    onDocsChanged: (msg: string) => void;
    onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  /** 文書の欄（取り込む・既存を繋ぐ）を開いているか。 */
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsVersion, setDocsVersion] = useState(0);
  /** 条件明細の欄（載っている条件を見る・載せる・外す）を開いているか。 */
  const [condsOpen, setCondsOpen] = useState(false);
  const levelOpen = leveling;
  const isOrder = canBeOrder(a);
  const [toDocBusy, setToDocBusy] = useState(false);
  /** 発注書（文書）に寄せるとき、どの基本契約の下に入れるか。同じ向きの基本契約が何本もあれば選ぶ。 */
  const toDocMasters = roots.filter((r) => r.kind === "master" && r.id !== a.id && r.direction === a.direction && !r.terminatedOn);
  const [toDocMaster, setToDocMaster] = useState<string>("");
  const toDocChoice = toDocMasters.length > 1 ? (toDocMaster || String(toDocMasters[0].id)) : null;
  async function toOrderDocument() {
    const under = toDocChoice ? (toDocChoice === "none" ? "基本契約なし（発注書の約款）" : `${toDocMasters.find((m) => String(m.id) === toDocChoice)?.agreementNo ?? ""} の下`) : null;
    if (!window.confirm(`${a.agreementNo ?? `#${a.id}`} は発注書です。契約から外して発注書（文書）にし、載っている条件明細 ${a.conditionCount} 本に紐づけます${under ? `（${under}）` : ""}。よろしいですか？`)) return;
    setToDocBusy(true);
    try {
      const r = await api.post<{ documentNo: string; created: boolean; conditionsLinked: number; masterNo: string | null }>(
        `/agreement-map/agreements/${a.id}/to-order-document`,
        toDocChoice ? { masterId: toDocChoice === "none" ? null : Number(toDocChoice) } : {});
      onSaved(`${a.agreementNo ?? `#${a.id}`} を発注書（文書 ${r.documentNo}${r.created ? "・新しく登録" : ""}）にし、条件明細 ${r.conditionsLinked} 本に紐づけました。`
        + (r.masterNo ? `基本契約 ${r.masterNo} の下の発注書です` : "基本契約が無いので、発注書の約款で取引する扱い（契約なし）です"));
    } catch (e) { onError((e as ApiError).message); }
    finally { setToDocBusy(false); }
  }
  const canDemote = a.kind === "standalone";
  const canPromote = a.kind === "supplement" && Boolean(a.parentId);
  /** 基本契約を別の契約・文書に差し替える欄（二重に作った基本契約を寄せるときも）。 */
  const [merging, setMerging] = useState(false);
  const canMerge = a.kind === "master" && a.status !== "terminated";
  return (
    <div className={`amap-node${issues.length ? " bad" : ""}`}>
      <div className="amap-line">
        <DirectionTag direction={a.direction} />
        <span className="tag ghost">{KIND_LABEL[a.kind]}</span>
        {(a.kind === "master" || a.kind === "standalone") && (
          a.domain ? <span className="tag ghost">{DOMAIN_LABEL[a.domain]}</span>
                   : <span className="tag warn">種別なし</span>
        )}
        <button className="linky code" onClick={() => onOpen?.("agreement", a.id)}>{a.agreementNo ?? `#${a.id}`}</button>
        <span>{a.title}</span>
        <StatusTag kind="agreement" value={a.status} />
        {a.executedOn
          ? <span className="faint">締結 {a.executedOn}</span>
          : a.kind !== "document" && <span className="tag ghost warn">締結日なし</span>}
        {a.terminatedOn && <span className="faint">解除 {a.terminatedOn}</span>}
        {a.kind !== "document" && (
          <DocMatter agreementId={a.id} busy={readOnly} onOpen={onOpen}
                     onChanged={(m) => (m.startsWith("⚠") ? onError(m.slice(1).trim()) : onDocsChanged(m))} />
        )}
        {a.counterparty.merged && <span className="faint" title="統合前の取引先を指しています（参照は付け替えない決まり）">統合元：{a.counterparty.name}</span>}
        <span className="faint">
          {a.kind === "master"
            ? `個別契約 ${childCount}・発注書 ${orderCount}・文書 ${a.documentCount}`
            : `条件 ${a.conditionCount}・文書 ${a.documentCount}`}
        </span>
        {/* 条件明細を持つのは個別契約・単体契約。基本契約には「条件」を出さない（基本契約は個別契約を持つ）。 */}
        {a.kind !== "document" && a.kind !== "master" && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setCondsOpen((v) => !v)}>
            {condsOpen ? "条件を閉じる" : "条件"}
          </button>
        )}
        <button className="btn btn-sm" style={a.kind === "document" || a.kind === "master" ? { marginLeft: "auto" } : undefined}
                onClick={() => setDocsOpen((v) => !v)}>
          {docsOpen ? "文書を閉じる" : "文書"}
        </button>
        {isOrder && toDocMasters.length > 1 && (
          <select value={toDocChoice ?? ""} aria-label="どの基本契約の下の発注書にするか" style={{ maxWidth: 220 }}
                  onChange={(e) => setToDocMaster(e.target.value)}>
            {toDocMasters.map((m) => <option key={m.id} value={m.id}>{m.agreementNo ?? `#${m.id}`} の下</option>)}
            <option value="none">基本契約なし（発注書の約款）</option>
          </select>
        )}
        {isOrder && (
          <button className="btn btn-sm primary" disabled={readOnly || toDocBusy} onClick={() => void toOrderDocument()}
                  title="発注書は文書として持ちます。契約から外し、発注書の文書として条件明細に紐づけます">
            {toDocBusy ? "寄せています…" : "発注書（文書）に寄せる"}
          </button>
        )}
        {(canDemote || canPromote) && !isOrderAgreement(a) && (
          <button className="btn btn-sm" disabled={readOnly} onClick={onLevel}>
            {levelOpen ? "閉じる" : canDemote ? "個別契約にする" : "単体契約に戻す"}
          </button>
        )}
        {canMerge && (
          <button className="btn btn-sm" disabled={readOnly} onClick={() => setMerging((v) => !v)}
                  title="この基本契約を別の契約・文書に置き換える（下の個別契約・条件・文書・案件を移し、この契約は解除扱い）">
            {merging ? "閉じる" : "基本契約を差し替える"}
          </button>
        )}
        <button className="btn btn-sm" disabled={readOnly} onClick={onEdit}>
          {editing ? "閉じる" : "編集"}
        </button>
      </div>
      {issues.map((i, n) => <div key={n} className="amap-issue">⚠ {i.message}</div>)}
      {merging && (
        <MasterMerge a={a} onOpen={onOpen} onError={onError} onCancel={() => setMerging(false)}
                     onDone={(msg) => { setMerging(false); onSaved(msg); }} />
      )}
      {editing && <RemapForm a={a} roots={roots} onSaved={onSaved} onError={onError} />}
      {levelOpen && canDemote && (
        <DemoteForm a={a} roots={roots} onSaved={onSaved} onError={onError} />
      )}
      {levelOpen && canPromote && (
        <PromoteForm a={a} roots={roots} onSaved={onSaved} onError={onError} />
      )}
      {condsOpen && (
        <div className="amap-form stack" style={{ gap: 8 }}>
          {/* この契約に載っている条件明細。同じ取引先・同じ向きの条件から載せる・外す。 */}
          <Relations kind="agreement" id={a.id} exclude={["documents", "party"]} initialOpen="conditions" onOpen={onOpen}
            onChanged={() => onDocsChanged(`${a.agreementNo ?? `#${a.id}`} の条件明細を更新しました`)} />
        </div>
      )}
      {docsOpen && (
        <div className="amap-form stack" style={{ gap: 8 }}>
          {/* 外で結んだ契約書（PDF など）を、この契約に繋いだ状態で登録する。 */}
          <DocumentImport agreementId={a.id}
            onOpenDocument={(id) => onOpen?.("document", id)}
            onDone={() => { setDocsVersion((v) => v + 1); onDocsChanged(`${a.agreementNo ?? `#${a.id}`} に文書を登録しました`); }} />
          {/* 既にある文書を繋ぐ・外す。同じ取引先の文書が先に並ぶ。 */}
          <Relations kind="agreement" id={a.id} reloadKey={docsVersion}
            exclude={["conditions", "party"]} initialOpen="documents" onOpen={onOpen}
            onChanged={() => onDocsChanged(`${a.agreementNo ?? `#${a.id}`} の文書を更新しました`)} />
        </div>
      )}
    </div>
  );
}

/**
 * 単体契約を、基本契約の下の個別契約にする。条件明細はこの個別契約のものとして基本契約の下に入る。
 * 親にできるのは同じ取引先・同じ向きの、解除されていない基本契約。
 */
function DemoteForm(
  { a, roots, onSaved, onError }: {
    a: MapAgreement; roots: MapNode[]; onSaved: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const masters = roots.filter((r) => r.kind === "master" && r.direction === a.direction && !r.terminatedOn)
    .sort((x, y) => Number(y.domain === a.domain) - Number(x.domain === a.domain) || Number(y.primary) - Number(x.primary));
  // この契約に繋いでいる基本契約の文書。基本契約を結んでも契約として登録せず、
  // 条件書の単体契約に紙だけ繋いでいることがある。選ぶとその紙から基本契約を起こす。
  const [docs, setDocs] = useState<Array<{ id: number; documentNo: string; title: string; label: string; issuedOn: string | null }> | null>(null);
  useEffect(() => {
    api.get<{ documents: NonNullable<typeof docs> }>(`/agreement-map/agreements/${a.id}/master-documents`)
      .then((r) => setDocs(r.documents)).catch(() => setDocs([]));
  }, [a.id]);
  // 値は "m:基本契約id" か "d:文書id"。
  const [pick, setPick] = useState<string>("");
  const chosen = pick || (masters[0] ? `m:${masters[0].id}` : docs?.[0] ? `d:${docs[0].id}` : "");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const [k, v] = chosen.split(":");
      const r = await api.post<{ conditionsMoved: number; masterNo: string | null; masterCreated: boolean }>(
        `/agreement-map/agreements/${a.id}/demote`, k === "d" ? { masterDocumentId: Number(v) } : { masterId: Number(v) });
      onSaved(`${a.agreementNo ?? `#${a.id}`} を ${r.masterNo ?? "基本契約"} の下の個別契約にしました（条件明細 ${r.conditionsMoved} 本）`
        + (r.masterCreated ? `。${r.masterNo} は文書から基本契約として登録しました。締結日は「編集」で入れてください` : ""));
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  if (docs === null) return <div className="amap-form faint">基本契約の候補を探しています…</div>;
  if (!masters.length && !docs.length) {
    return (
      <div className="amap-form note">
        この取引先に、{a.direction === "in" ? "IN" : "OUT"} の基本契約がありません。この契約に繋いでいる文書にも基本契約書がありません。
        先に基本契約書をこの契約の「文書」に繋ぐ（取り込む）か、「契約を登録」で基本契約を立ててください。
      </div>
    );
  }
  return (
    <div className="amap-form stack" style={{ gap: 8 }}>
      <b>（2）単体契約 → （1）基本契約＋個別契約</b>
      <label className="field"><span>ぶら下げる基本契約</span>
        <select value={chosen} onChange={(e) => setPick(e.target.value)}>
          {masters.length > 0 && (
            <optgroup label="登録済みの基本契約">
              {masters.map((m) => (
                <option key={m.id} value={`m:${m.id}`}>
                  {m.agreementNo ?? `#${m.id}`} {m.title}（{m.domain ? DOMAIN_LABEL[m.domain] : "種別なし"}{m.executedOn ? `・締結 ${m.executedOn}` : "・未締結"}）
                </option>
              ))}
            </optgroup>
          )}
          {docs.length > 0 && (
            <optgroup label="この契約に繋いでいる基本契約の文書（基本契約として登録する）">
              {docs.map((d) => (
                <option key={d.id} value={`d:${d.id}`}>
                  {d.documentNo} {d.label}{d.issuedOn ? `（${d.issuedOn.slice(0, 10)}）` : ""}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {chosen.startsWith("d:") && (
        <span className="faint">
          選んだ文書を基本契約（番号は文書の番号のまま）として登録し、文書はその基本契約に付け替えます。締結日は登録後に「編集」で入れてください（入れると締結済みになります）。
        </span>
      )}
      <span className="faint">
        この契約は選んだ基本契約の下の個別契約になり、載っている条件明細 {a.conditionCount} 本はその個別契約のものとして基本契約の下に入ります。
        これから作る発注書・検収書・計算書は、この基本契約に拠って出ます。番号（{a.agreementNo ?? `#${a.id}`}）と文書はそのまま。「単体契約に戻す」で戻せます。
      </span>
      <div className="row">
        <button className="btn primary btn-sm" disabled={busy || !chosen} onClick={() => void save()}>
          {busy ? "移しています…" : "個別契約にする"}
        </button>
      </div>
    </div>
  );
}

/** 個別契約を単体契約に戻す。基本契約に移した条件明細のうち、この契約の文書に載るものを戻す。 */
function PromoteForm(
  { a, roots, onSaved, onError }: {
    a: MapAgreement; roots: MapNode[]; onSaved: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const parent = roots.find((r) => r.id === a.parentId) ?? null;
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await api.post<{ conditionsMoved: number }>(`/agreement-map/agreements/${a.id}/promote`, {});
      onSaved(`${a.agreementNo ?? `#${a.id}`} を単体契約に戻しました${r.conditionsMoved ? `（基本契約に直接載っていた条件明細 ${r.conditionsMoved} 本を戻しました）` : ""}`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="amap-form stack" style={{ gap: 8 }}>
      <b>（1）基本契約＋個別契約 → （2）単体契約</b>
      <span className="faint">
        {parent ? `${parent.agreementNo ?? `#${parent.id}`} の下から外し、` : ""}その取引だけで完結する単体契約にします。
        この個別契約の文書（条件書）に載っている条件明細は、そのまま単体契約の条件明細になります。覚書のように条件明細を持たないものは、戻さないでください。
      </span>
      <div className="row">
        <button className="btn btn-sm" disabled={busy} onClick={() => void save()}>{busy ? "戻しています…" : "単体契約に戻す"}</button>
      </div>
    </div>
  );
}

function RemapForm(
  { a, roots, onSaved, onError }: {
    a: MapAgreement; roots: MapNode[]; onSaved: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const [kind, setKind] = useState<AgreementKind>(a.kind);
  const [domain, setDomain] = useState<string>(a.domain ?? "");
  /** none は向きなし（文書だけの契約のときだけ）。 */
  const [direction, setDirection] = useState<"in" | "out" | "none">(a.direction ?? "none");
  const [parentId, setParentId] = useState<string>(a.parentId ? String(a.parentId) : "");
  const [counterpartyId, setCounterpartyId] = useState<string>(String(a.counterparty.id));
  const [executedOn, setExecutedOn] = useState<string>(a.executedOn ?? "");
  const [busy, setBusy] = useState(false);
  const needsParent = kind === "supplement" || kind === "termination";
  const isRoot = kind === "master" || kind === "standalone";
  const parents = roots.filter((r) => r.id !== a.id);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/agreement-map/agreements/${a.id}`, {
        kind, direction: direction === "none" ? null : direction,
        domain: domain ? domain : null,
        parentId: needsParent && parentId ? Number(parentId) : null,
        counterpartyId: Number(counterpartyId),
        executedOn: executedOn || null
      });
      onSaved(`${a.agreementNo ?? `#${a.id}`} を保存しました（番号はそのまま）`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="form-grid amap-form">
      <label className="field"><span>種類</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as AgreementKind)}>
          {(Object.keys(KIND_LABEL) as AgreementKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="field"><span>種別{isRoot ? "（必須）" : ""}</span>
        <select value={domain} onChange={(e) => setDomain(e.target.value)}>
          <option value="">未設定</option>
          <option value="service">業務委託</option>
          <option value="license">ライセンス</option>
        </select>
      </label>
      <label className="field"><span>方向</span>
        <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out" | "none")}>
          <option value="in">IN（取得）</option>
          <option value="out">OUT（許諾・委託）</option>
          <option value="none">向きなし（文書だけ）</option>
        </select>
        {direction === "none" && kind !== "document" && (
          <small className="bad">向きなしにできるのは「文書だけ」の契約だけです</small>
        )}
      </label>
      {needsParent && (
        <label className="field"><span>親の契約</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">選んでください</option>
            {parents.map((r) => (
              <option key={r.id} value={r.id}>
                {r.agreementNo ?? `#${r.id}`} {r.title}（{KIND_LABEL[r.kind]}・{r.direction === "in" ? "IN" : "OUT"}）
              </option>
            ))}
          </select>
          {!parents.length && (
            <small className="faint">親にできる契約がありません。単体契約なら「個別契約にする」から、繋いでいる基本契約書を基本契約として登録して親にできます</small>
          )}
        </label>
      )}
      <label className="field"><span>契約締結日</span>
        <input type="date" value={executedOn} onChange={(e) => setExecutedOn(e.target.value)} />
        {executedOn && (a.status === "draft" || a.status === "negotiating") && (
          <small className="faint">締結日を入れると「締結済み」になります</small>
        )}
      </label>
      <div className="field"><span>相手先</span>
        <SearchSelect value={counterpartyId} onChange={(v) => setCounterpartyId(v)}
          search={searchParties} valueLabel={a.counterparty.name} placeholder="取引先名で探す" />
      </div>
      <div className="row" style={{ gridColumn: "1 / -1" }}>
        <button className="btn primary btn-sm" disabled={busy || (needsParent && !parentId)} onClick={save}>保存する</button>
        <span className="faint">
          番号は振り直しません。文書には「{executedOn ? `${Number(executedOn.slice(0, 4))}年${Number(executedOn.slice(5, 7))}月${Number(executedOn.slice(8, 10))}日付` : ""}{a.title}」と出ます。{isRoot ? "基本契約・単体契約にすると親は外れます。" : ""}
          相手先を別の取引先にすると、この取引先の図から外れます。
        </span>
      </div>
    </div>
  );
}

/**
 * 検索して紐づける：① 基本契約を決める → ② 発注書を決める → ③ 条件を決める。
 *
 * 取引の形は（1）基本契約の下の発注書が条件明細を持つ。それぞれ番号・件名で探して決める。
 *   ① 基本契約 … この取引先の基本契約のほか、番号・件名で全部の基本契約から探せる
 *                 （「基本契約なし＝発注書の約款」も選べる）。契約に繋がっていない基本契約書
 *                 （文書番号だけで浮いているもの）は、選ぶと基本契約として立ててから使う。
 *                 別の取引先で登録された基本契約は、相手先をこの取引先に直してから使う。
 *   ② 発注書   … 番号・件名で全部の文書から探す（別の取引先の発注書は相手先名を出して知らせる）
 *                 紙・PDF を取り込んでもよい。選ぶと、いまの基本契約と条件明細を ①③ に読み込む
 *   ③ 条件     … この取引先の条件明細から番号・名前・作品で探して選ぶ（複数）。
 *                 チェックを外した条件はこの発注書から外し、別の発注書が持つ条件は付け替える
 * 決定すると、発注書を条件に紐づけ、その発注書の条件を①の基本契約にそろえる。
 */
interface DocHit { id: number; documentNo: string | null; status: string; templateKey: string | null; templateLabel: string | null;
  title: string | null; imported: boolean; counterparty: string | null; issuedAt: string | null;
  conditions: Array<{ id: number; conditionNo: string | null }> }
interface CondHit { id: number; conditionNo: string | null; name: string; status: string; direction: string;
  work: { title: string } | null; agreement: { agreementNo: string | null; title: string } | null }
interface MasterHit { id: number; agreementNo: string | null; title: string; kind: AgreementKind; status: string;
  executedOn: string | null; terminatedOn: string | null; direction: "in" | "out"; counterparty: { id: number; name: string } }
/** ① の選択肢。m＝この取引先の基本契約、x＝別の取引先の基本契約（相手先を直して使う）、d＝基本契約書の文書（立てて使う）。 */
type MasterPick = { key: string; kind: "m" | "x" | "d"; id: number; label: string; party?: string };

function OrderLinkPanel(
  { map, documentId, conditionIds, onDone, onCancel, onError }: {
    map: PartyMap; documentId: number | null; conditionIds: number[];
    onDone: (msg: string) => void; onCancel: () => void; onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  const orders = map.orders ?? [];
  const masters = map.roots.filter((r) => r.kind === "master");
  const primary = masters.find((m) => m.primary) ?? masters[0] ?? null;
  const masterTag = (no: string | null, id: number, title: string) => `${no ?? `#${id}`} ${title}`;
  const localPicks: MasterPick[] = [
    ...masters.map((m) => ({ key: `m:${m.id}`, kind: "m" as const, id: m.id,
      label: `${masterTag(m.agreementNo, m.id, m.title)}${m.executedOn ? `（${m.executedOn}）` : "（締結日なし）"}${m.terminatedOn ? "・解除済み" : ""}` })),
    ...map.unlinked.filter((u) => u.role === "master").map((u) => ({ key: `d:${u.id}`, kind: "d" as const, id: u.id,
      label: `${u.documentNo ?? `#${u.id}`} ${u.label}${u.title ? `（${u.title}）` : ""}` }))
  ];
  /** 発注書のいまの基本契約（"" は基本契約なし）。 */
  const orderMasterKey = (id: number | null) => {
    const o = id ? orders.find((x) => x.id === id) : undefined;
    return o ? (o.masterId ? `m:${o.masterId}` : "") : null;
  };
  // ① 基本契約。"" は基本契約なし。
  const [masterQ, setMasterQ] = useState("");
  const masterSearch = useDebounced(masterQ);
  const [masterHits, setMasterHits] = useState<MasterPick[] | null>(null);
  const [extraPicks, setExtraPicks] = useState<MasterPick[]>([]);
  // 基本契約が 1 本ならそれを初期値に。何本もあれば人が選ぶ（黙って 1 本に決めない）。
  const [masterKey, setMasterKey] = useState<string>(() => orderMasterKey(documentId) ?? (masters.length === 1 && primary ? `m:${primary.id}` : ""));
  // ② 発注書
  const [docQ, setDocQ] = useState("");
  const docSearch = useDebounced(docQ);
  const [docHits, setDocHits] = useState<DocHit[] | null>(null);
  /** 選んだ発注書と、いま載っている条件明細・基本契約（付け替えの元）。 */
  const [doc, setDoc] = useState<{ id: number; label: string; conds: number[]; masterKey: string | null } | null>(() => {
    if (!documentId) return null;
    const o = orders.find((x) => x.id === documentId);
    const u = map.unlinked.find((x) => x.id === documentId);
    return { id: documentId, label: `${o?.documentNo ?? u?.documentNo ?? `#${documentId}`} ${o?.title ?? u?.title ?? ""}`,
             conds: o?.conditions.map((c) => c.id) ?? [], masterKey: orderMasterKey(documentId) };
  });
  const [importing, setImporting] = useState(false);
  // ③ 条件
  const [condQ, setCondQ] = useState("");
  const [conds, setConds] = useState<CondHit[]>([]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set([...conditionIds, ...(doc?.conds ?? [])]));
  const [busy, setBusy] = useState(false);
  // 開いたら見える所まで寄せる（見出しの釦から開くと、欄は図の下に出る）。
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }); }, []);

  useEffect(() => {
    api.get<{ conditions: CondHit[] }>(`/conditions?counterpartyId=${map.party.id}&limit=500`)
      .then((r) => setConds(r.conditions.filter((c) => c.status !== "void" && c.status !== "superseded")))
      .catch(() => setConds([]));
  }, [map.party.id]);
  useEffect(() => {
    if (!docSearch.trim()) { setDocHits(null); return; }
    let live = true;
    api.get<{ documents: DocHit[] }>(`/documents?q=${encodeURIComponent(docSearch.trim())}`)
      .then((r) => { if (live) setDocHits(r.documents.filter((d) => d.status !== "void" && d.status !== "superseded"
        && (d.templateKey === "purchase_order" || d.templateKey === "intl_purchase_order" || d.imported))); })
      .catch(() => { if (live) setDocHits([]); });
    return () => { live = false; };
  }, [docSearch]);
  // ① 番号・件名で全部の基本契約から探す。この取引先のもの（統合元を含む）は上の候補に出ているので除く。
  useEffect(() => {
    if (!masterSearch.trim()) { setMasterHits(null); return; }
    let live = true;
    const mine = new Set(masters.map((m) => m.id));
    api.get<{ agreements: MasterHit[] }>(`/agreements?q=${encodeURIComponent(masterSearch.trim())}`)
      .then((r) => { if (live) setMasterHits(r.agreements.filter((a) => a.kind === "master" && !mine.has(a.id)).slice(0, 30)
        .map((a) => ({ key: `x:${a.id}`, kind: "x" as const, id: a.id, party: a.counterparty.name,
          label: `${masterTag(a.agreementNo, a.id, a.title)}${a.executedOn ? `（${a.executedOn}）` : "（締結日なし）"}${a.terminatedOn ? "・解除済み" : ""}` }))); })
      .catch(() => { if (live) setMasterHits([]); });
    return () => { live = false; };
  }, [masterSearch]);

  // 条件がいまどこに載っているか（発注書・契約）。
  const holderOf = (c: CondHit) => {
    const o = orders.find((x) => x.conditions.some((y) => y.id === c.id));
    return o ? `発注書 ${o.documentNo ?? `#${o.id}`}` : c.agreement ? `${c.agreement.agreementNo ?? c.agreement.title}` : "持ち主なし";
  };
  /** 条件を持っている別の発注書（付け替えの元）。 */
  const otherOrderOf = (id: number) => orders.find((x) => x.id !== doc?.id && x.conditions.some((y) => y.id === id)) ?? null;
  const looseIds = new Set(map.looseConditions.map((c) => c.id));
  const original = new Set(doc?.conds ?? []);
  const condShown = conds
    .filter((c) => !condQ.trim() || `${c.conditionNo ?? ""} ${c.name} ${c.work?.title ?? ""}`.toLowerCase().includes(condQ.trim().toLowerCase())
      || picked.has(c.id) || original.has(c.id))
    .sort((a, b) => Number(picked.has(b.id) || original.has(b.id)) - Number(picked.has(a.id) || original.has(a.id))
      || Number(looseIds.has(b.id)) - Number(looseIds.has(a.id)))
    .slice(0, 60);
  const ids = [...picked];
  /** 選び直しで外した、この発注書の条件。 */
  const removeIds = [...original].filter((id) => !picked.has(id));
  const moving = ids.filter((id) => otherOrderOf(id));
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const q = masterQ.trim().toLowerCase();
  const localShown = localPicks.filter((m) => !q || m.label.toLowerCase().includes(q) || m.key === masterKey);
  const allPicks = [...localPicks, ...extraPicks, ...(masterHits ?? [])];
  const chosenMaster = masterKey ? allPicks.find((m) => m.key === masterKey) ?? null : null;
  const masterLabel = masterKey ? chosenMaster?.label ?? masterKey : "基本契約なし（発注書の約款）";
  const pickMaster = (m: MasterPick | null) => {
    if (m && m.kind === "x" && !extraPicks.some((e) => e.key === m.key)) setExtraPicks((e) => [...e, m]);
    setMasterKey(m ? m.key : "");
  };
  const masterChanged = doc?.masterKey !== undefined && doc.masterKey !== null && doc.masterKey !== masterKey;
  const labelOfKey = (k: string | null) => k === null ? null : k === "" ? "基本契約なし" : allPicks.find((m) => m.key === k)?.label ?? k;

  const choose = (d: { id: number; label: string; conds: number[] }) => {
    // 前に選んだ発注書から読み込んだ条件は戻し、新しい発注書のいまの条件を読み込む。
    setPicked((p) => {
      const n = new Set([...p].filter((id) => !original.has(id) || conditionIds.includes(id)));
      d.conds.forEach((id) => n.add(id));
      return n;
    });
    const mk = orderMasterKey(d.id);
    if (mk !== null) setMasterKey(mk);
    setDoc({ ...d, masterKey: mk });
  };
  const docList: Array<{ id: number; no: string | null; title: string | null; tag: string; party: string | null; note: string; conds: number[] }> = docHits
    ? docHits.map((d) => ({ id: d.id, no: d.documentNo, title: d.title, tag: d.imported ? "取込" : "発注書", party: d.counterparty,
        note: d.conditions.length ? `紐づき：${d.conditions.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}` : "条件なし",
        conds: d.conditions.map((c) => c.id) }))
    : [...orders.map((o) => ({ id: o.id, no: o.documentNo, title: o.title, tag: o.imported ? "取込" : "発注書", party: map.party.name,
          note: (o.conditions.length ? `紐づき：${o.conditions.map((c) => c.conditionNo ?? `#${c.id}`).join("・")}` : "条件なし")
            + `・${o.masterId ? `基本契約 ${masters.find((m) => m.id === o.masterId)?.agreementNo ?? `#${o.masterId}`}` : "基本契約なし"}`,
          conds: o.conditions.map((c) => c.id) })),
       ...map.unlinked.filter((u) => !u.role).map((u) => ({ id: u.id, no: u.documentNo, title: u.title ?? u.label, tag: "文書", party: map.party.name,
          note: "契約に繋がっていない文書（発注書として扱う）", conds: [] }))];

  /** ① で選んだものを、紐づけに使える基本契約の id にする（文書から立てる・相手先を直す）。 */
  async function resolveMaster(): Promise<{ id: number | null; note: string }> {
    if (!chosenMaster) return { id: null, note: "" };
    if (chosenMaster.kind === "m") return { id: chosenMaster.id, note: "" };
    if (chosenMaster.kind === "d") {
      const r = await api.post<{ agreementId: number; agreementNo: string; kind: string }>(
        `/agreement-map/documents/${chosenMaster.id}/agreement`, { as: "master" });
      return { id: r.agreementId, note: `${r.agreementNo} を基本契約として立てました（締結日は「編集」で入れてください）。` };
    }
    await api.patch(`/agreement-map/agreements/${chosenMaster.id}`, { counterpartyId: map.party.id });
    return { id: chosenMaster.id, note: `${chosenMaster.label.split(" ")[0]} の相手先を ${map.party.name} に直しました。` };
  }

  async function link(target: number | null = doc?.id ?? null) {
    if (!target || (!ids.length && !removeIds.length)) return;
    if (chosenMaster?.kind === "x" && !window.confirm(
      `${chosenMaster.label} は相手先が「${chosenMaster.party}」で登録されています。相手先を ${map.party.name} に直して、この発注書の基本契約にします。よろしいですか？`)) return;
    if (moving.length && !window.confirm(
      `${moving.length} 本の条件明細は別の発注書（${[...new Set(moving.map((id) => otherOrderOf(id)?.documentNo ?? ""))].join("・")}）に紐づいています。そちらから外して付け替えます。よろしいですか？`)) return;
    setBusy(true);
    try {
      if (!ids.length) {
        // 条件を全部外すだけ（基本契約は条件に付くので触らない）。
        for (const id of removeIds) await api.del(`/links/condition/${id}/documents/${target}`);
        onDone(`${doc?.label.split(" ")[0] ?? "発注書"} から条件明細 ${removeIds.length} 本を外しました`);
        return;
      }
      const m = await resolveMaster();
      const r = await api.post<{ linked: number; masterNo: string | null; documentNo: string | null; removed: number; detachedFrom: string[] }>(
        "/agreement-map/orders/link", { documentId: target, conditionIds: ids, masterId: m.id,
          removeConditionIds: removeIds, detachOtherOrders: moving.length > 0 });
      onDone(`${m.note}${r.documentNo ?? "発注書"} を条件明細 ${r.linked} 本に紐づけました`
        + (r.masterNo ? `（基本契約 ${r.masterNo} の下の発注書）` : "（基本契約なし＝発注書の約款）")
        + (r.removed ? `。${r.removed} 本を外しました` : "")
        + (r.detachedFrom.length ? `。${r.detachedFrom.join("・")} から付け替えました` : ""));
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const step = (no: string, title: string, chosen: string | null) => (
    <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
      <b>{no} {title}</b>
      {chosen ? <span className="tag ok">{chosen}</span> : <span className="tag warn">未決定</span>}
    </div>
  );

  return (
    <div ref={box} className="panel">
      <div className="panel-hd">
        <h2>検索して紐づける</h2>
        <span className="faint">① 基本契約 → ② 発注書 → ③ 条件明細 の順に、番号・件名で探して決めます。発注書が条件明細を持ち、基本契約の下に入ります。紐づいているものは外して付け替えられます</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onCancel}>閉じる</button>
      </div>
      <div className="panel-bd stack" style={{ gap: 14 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            {step("①", "基本契約", masterLabel.trim())}
            {doc && doc.masterKey !== null && (
              masterChanged
                ? <span className="tag warn">付け替え：{labelOfKey(doc.masterKey)} → {masterKey ? "選んだ基本契約" : "基本契約なし"}</span>
                : <span className="faint">この発注書のいまの基本契約</span>
            )}
          </div>
          <input value={masterQ} placeholder="基本契約の番号・件名で探す（全部の基本契約から。例：ARC-SVC-2026-0001）" onChange={(e) => setMasterQ(e.target.value)} />
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {localShown.map((m) => (
              <button key={m.key} type="button" className="chip" aria-pressed={masterKey === m.key} onClick={() => pickMaster(m)}
                      title={m.kind === "d" ? "契約に繋がっていない基本契約書です。決定すると基本契約として立ててから使います" : undefined}>
                {m.kind === "d" && <span className="tag warn" style={{ marginRight: 4 }}>文書だけ</span>}{m.label}
              </button>
            ))}
            {extraPicks.filter((m) => !masterHits?.some((h) => h.key === m.key)).map((m) => (
              <button key={m.key} type="button" className="chip" aria-pressed={masterKey === m.key} onClick={() => pickMaster(m)}>
                <span className="tag warn" style={{ marginRight: 4 }}>相手先：{m.party}</span>{m.label}
              </button>
            ))}
            <button type="button" className="chip" aria-pressed={masterKey === ""} onClick={() => pickMaster(null)}>
              基本契約なし（発注書の約款）{doc?.masterKey && masterKey !== "" ? "＝基本契約から外す" : ""}
            </button>
          </div>
          {masterHits && (
            <div className="picker" style={{ maxHeight: 180, overflowY: "auto" }}>
              {masterHits.map((m) => (
                <label key={m.key} className="row" style={{ gap: 6, padding: "2px 0", cursor: "pointer" }}>
                  <input type="radio" name="master" checked={masterKey === m.key} onChange={() => pickMaster(m)} />
                  <span className="tag ghost">基本契約</span><span>{m.label}</span>
                  <span className="tag warn">相手先：{m.party}</span>
                </label>
              ))}
              {!masterHits.length && <span className="faint">ほかの取引先にも当たる基本契約がありません</span>}
            </div>
          )}
          {chosenMaster?.kind === "x" && (
            <span className="faint">別の取引先（{chosenMaster.party}）で登録された基本契約です。決定すると相手先を {map.party.name} に直してから使います</span>
          )}
          {chosenMaster?.kind === "d" && (
            <span className="faint">文書番号だけで契約に繋がっていない基本契約書です。決定すると、この文書から基本契約（番号は文書のまま）を立ててから使います</span>
          )}
          {!localPicks.length && !masterHits && <span className="faint">この取引先に基本契約がありません。番号・件名で探すか、結んでいるなら先に「契約を登録」で立ててください</span>}
        </div>

        <div className="stack" style={{ gap: 6 }}>
          {step("②", "発注書", doc ? doc.label : null)}
          <div className="row" style={{ gap: 6 }}>
            <input value={docQ} placeholder="発注書番号・件名で探す（例：ARC-PO-2026-0097）" style={{ flex: 1 }} onChange={(e) => setDocQ(e.target.value)} />
            <button type="button" className="btn btn-sm" onClick={() => setImporting((v) => !v)}>{importing ? "取り込みをやめる" : "紙・PDF を取り込む"}</button>
          </div>
          {importing ? (
            ids.length
              ? <DocumentImport key={ids.join(",")} conditionIds={ids} defaultKind="発注書" initialMode="import"
                  onDone={() => undefined} onRegistered={(id) => void link(id)} />
              : <span className="faint">取り込む前に ③ で条件明細を選んでください（取り込むと、そのまま紐づけます）</span>
          ) : (
            <div className="picker" style={{ maxHeight: 220, overflowY: "auto" }}>
              {docList.map((d) => (
                <label key={d.id} className="row" style={{ gap: 6, padding: "2px 0", cursor: "pointer" }}>
                  <input type="radio" name="po" checked={doc?.id === d.id}
                         onChange={() => choose({ id: d.id, label: `${d.no ?? `#${d.id}`} ${d.title ?? ""}`, conds: d.conds })} />
                  <span className="tag ghost">{d.tag}</span><span className="code">{d.no ?? `#${d.id}`}</span><span>{d.title ?? ""}</span>
                  {d.party && d.party !== map.party.name && <span className="tag warn">相手先：{d.party}</span>}
                  <span className="faint">{d.note}</span>
                </label>
              ))}
              {!docList.length && <span className="faint">{docHits ? "当たる発注書がありません" : "この取引先の発注書はまだありません。番号で探すか、紙・PDF を取り込んでください"}</span>}
            </div>
          )}
          {doc && doc.conds.length > 0 && (
            <span className="faint">この発注書にいま紐づいている条件明細 {doc.conds.length} 本を ③ にチェックして読み込みました。外すものはチェックを外してください</span>
          )}
        </div>

        <div className="stack" style={{ gap: 6 }}>
          {step("③", "条件明細", ids.length ? `${ids.length} 本` : null)}
          <input value={condQ} placeholder="条件番号・条件名・作品で探す" onChange={(e) => setCondQ(e.target.value)} />
          <div className="picker" style={{ maxHeight: 260, overflowY: "auto" }}>
            {condShown.map((c) => {
              const other = picked.has(c.id) ? otherOrderOf(c.id) : null;
              return (
                <label key={c.id} className="row" style={{ gap: 6, padding: "2px 0" }}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="code">{c.conditionNo ?? `#${c.id}`}</span><span>{c.name}</span>
                  <span className="faint">{c.work?.title ?? ""}</span>
                  <span className={`tag ${looseIds.has(c.id) ? "warn" : "ghost"}`}>{holderOf(c)}</span>
                  {original.has(c.id) && !picked.has(c.id) && <span className="tag warn">この発注書から外す</span>}
                  {other && <span className="tag warn">{other.documentNo ?? `#${other.id}`} から付け替える</span>}
                </label>
              );
            })}
            {!condShown.length && <span className="faint">当たる条件明細がありません</span>}
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={readOnly || busy || !doc || (!ids.length && !removeIds.length)} onClick={() => void link()}>
            {busy ? "紐づけています…" : ids.length ? "決定して紐づける" : "外す"}
          </button>
          <span className="faint">
            {masterLabel.trim()} ／ {doc ? doc.label : "発注書 未決定"} ／ 条件明細 {ids.length} 本
            {removeIds.length > 0 && `（外す ${removeIds.length} 本）`}{moving.length > 0 && `（付け替え ${moving.length} 本）`}
          </span>
        </div>
      </div>
    </div>
  );
}
