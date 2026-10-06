import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag } from "./labels.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { useReadOnly } from "./read-only.js";
import { CsvBar } from "./CsvBar.js";
import { CsvImport } from "./CsvImport.js";
import { DocumentImport } from "./DocumentImport.js";
import { Relations } from "./Relations.js";
import type { EntityKind } from "./Relations.js";
import type { AgreementDomain, AgreementKind } from "../server/agreements/service.js";
import type { LooseCondition, MapAgreement, MapIssue, MapNode, MapPartyRow, PartyMap, UnlinkedDocument } from "../server/agreements/party-map.js";

/**
 * 取引先 ⇔ 基本契約のマップ。
 *
 * 同じ取引先の基本契約が、画面によって違って見える（統合を辿る／辿らない、
 * 補助文書を親に寄せる／寄せない、種類・状態で絞る／絞らない）。
 * ここでは取引先ひとつぶんの契約を全部引いて
 *   取引先 → 基本契約・単体契約 → 補助文書・解除合意
 * の図にし、図にならないもの（ずれ）をその場で付け替える。
 *
 * 「既定」の印は、他の画面がその取引先の基本契約として拾うべき1本
 * （種別 × 方向ごとに、締結済み・未解除の基本契約のうち新しいもの）。
 */

const KIND_LABEL: Record<AgreementKind, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "個別契約・覚書", termination: "解除合意", document: "文書だけ"
};
const DOMAIN_LABEL: Record<AgreementDomain, string> = { service: "業務委託", license: "ライセンス" };
/** 契約として登録された発注書か（サーバの isOrderAgreement と同じ判定）。 */
const isOrderAgreement = (a: Pick<MapAgreement, "kind" | "agreementNo" | "title">) =>
  (a.kind === "standalone" || a.kind === "document") && /-E?PO-|発注書|purchase_order/i.test(`${a.agreementNo ?? ""} ${a.title ?? ""}`);

export function AgreementMapWorkspace(
  { initialPartyId, onOpen, onRegisterAgreement }: {
    initialPartyId?: number; onOpen?: (kind: EntityKind, id: number) => void;
    /** 契約の登録へ（相手先を入れた状態で開く）。契約の無い取引先から始めるとき。 */
    onRegisterAgreement?: (partyId: number, partyName: string | null) => void;
  }
) {
  const [parties, setParties] = useState<MapPartyRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [partyId, setPartyId] = useState<number | undefined>(initialPartyId);
  const [map, setMap] = useState<PartyMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

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

  return (
    <section className="workspace">
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
          { value: "all", label: "全取引先の契約（ずれ・既定の参考列つき）",
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
            <PartyMapView map={map} onOpen={onOpen} onRegisterAgreement={onRegisterAgreement}
              onChanged={(msg) => { setNotice(msg); setError(null); bump(); }}
              onError={setError} />
          )}
        </div>
      </div>
    </section>
  );
}

function PartyMapView(
  { map, onOpen, onRegisterAgreement, onChanged, onError }: {
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onRegisterAgreement?: (partyId: number, partyName: string | null) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const [editing, setEditing] = useState<number | null>(null);
  /** 「個別契約にする／単体契約に戻す」の欄を開いている契約。 */
  const [leveling, setLeveling] = useState<number | null>(null);
  const issuesOf = (id: number) => map.issues.filter((i) => i.agreementId === id);

  const node = (a: MapAgreement, extra?: { primary?: boolean }) => (
    <AgreementNode key={a.id} a={a} issues={issuesOf(a.id)} primary={extra?.primary}
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
          <span className="faint" style={{ marginLeft: "auto" }}>
            既定＝他の画面がこの取引先の基本契約として拾う1本（種別 × 方向ごと。基本契約だけで、単体契約は既定にしません）
          </span>
        </div>
        <div className="panel-bd">
          <p className="faint" style={{ margin: "0 0 10px" }}>
            取引の形は2つです。<b>（1）基本契約＋個別契約</b>：基本契約の下に個別契約（条件書など）をぶら下げ、条件明細は基本契約の明細になります。
            <b>（2）単体契約</b>：その取引だけで完結する契約で、条件明細は単体契約に載ります。
            条件書を先に結んで後から基本契約を結んだ相手は、単体契約の「個別契約にする」で（1）に揃えます。
          </p>
          <div className="amap">
            <div className="amap-party">{map.party.name}</div>
            <div className="amap-roots">
              {map.roots.map((r: MapNode) => (
                <div key={r.id} className={`amap-root${r.primary ? " primary" : ""}`}>
                  {node(r, { primary: r.primary })}
                  {r.children.length > 0 && (
                    <div className="amap-children">{r.children.map((c) => node(c))}</div>
                  )}
                </div>
              ))}
              {!map.roots.length && (
                <div className="faint">
                  基本契約・単体契約はありません。
                  {map.unlinked.some((d) => d.role)
                    ? "下の「契約に繋がっていない文書」で、基本契約書 → 条件書 の順に「この文書から立てる」を押してください。残った条件明細は、その下で契約に載せます。"
                    : (map.unlinked.length > 0 || map.looseConditions.length > 0) && "「契約を登録」で契約を立てると、下の文書・条件明細を繋げます。"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {map.unlinked.length > 0 && (
        <UnlinkedDocuments docs={map.unlinked} map={map} onOpen={onOpen} onChanged={onChanged} onError={onError} />
      )}

      {map.looseConditions.length > 0 && (
        <LooseConditions conds={map.looseConditions} map={map} onOpen={onOpen} onChanged={onChanged} onError={onError} />
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
  { docs, map, onOpen, onChanged, onError }: {
    docs: UnlinkedDocument[]; map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
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
  const hasMaster = map.roots.some((r) => r.kind === "master");
  const masterDocLeft = docs.some((d) => d.role === "master");
  async function create(doc: UnlinkedDocument) {
    setBusy(doc.id);
    try {
      const r = await api.post<{ agreementNo: string; kind: string; parentNo: string | null; conditionsLinked: number }>(
        `/agreement-map/documents/${doc.id}/agreement`, {});
      const what = r.kind === "master" ? "基本契約" : r.kind === "supplement" ? `${r.parentNo ?? "基本契約"} の下の個別契約` : "単体契約";
      onChanged(`${doc.documentNo ?? `#${doc.id}`} から${what}を立てました（番号 ${r.agreementNo}${r.conditionsLinked ? `・条件明細 ${r.conditionsLinked} 本を${r.kind === "supplement" ? "基本契約に" : ""}載せました` : ""}）。締結日は「編集」で入れてください`);
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
            基本契約書・条件書は「この文書から立てる」で契約にできます（番号・件名は文書のまま）。<b>基本契約書 → 条件書</b> の順に押すと、
            条件書は基本契約の下の個別契約になり、条件書に載っている条件明細も基本契約に載ります。基本契約が無ければ条件書は単体契約になります。
          </div>
        </div>
      )}
      <div className="tablewrap">
        <table>
          <thead><tr><th>文書番号</th><th>種別・件名</th><th>日付</th><th>この文書から立てる</th><th>既にある契約に繋ぐ</th><th></th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="code">
                  {onOpen ? <button className="linky" onClick={() => onOpen("document", d.id)}>{d.documentNo ?? `#${d.id}`}</button>
                          : d.documentNo ?? `#${d.id}`}
                </td>
                <td>{d.label}{d.title ? `（${d.title}）` : ""}</td>
                <td className="faint" style={{ whiteSpace: "nowrap" }}>{d.issuedOn ?? "—"}</td>
                <td>
                  {d.role === "master" && (
                    <button className="btn btn-sm primary" style={{ whiteSpace: "nowrap" }} disabled={readOnly || busy === d.id}
                            onClick={() => void create(d)}>基本契約として立てる</button>
                  )}
                  {d.role === "terms" && (
                    !hasMaster && masterDocLeft
                      ? <span className="faint">先に基本契約書を立ててください</span>
                      : <button className="btn btn-sm primary" style={{ whiteSpace: "nowrap" }} disabled={readOnly || busy === d.id}
                                title={d.conditionCount ? `載っている条件明細 ${d.conditionCount} 本も一緒に載せます` : undefined}
                                onClick={() => void create(d)}>
                          {hasMaster ? "個別契約として立てる" : "単体契約として立てる"}
                        </button>
                  )}
                  {!d.role && <span className="faint">—</span>}
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
  { conds, map, onOpen, onChanged, onError }: {
    conds: LooseCondition[]; map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const readOnly = useReadOnly();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = conds.filter((c) => picked.has(c.id));
  const directions = [...new Set(chosen.map((c) => c.direction))];
  // 載せ先は契約本体（基本契約・単体契約・補助文書）。文書だけ・解除合意には載せない。
  const targets = [...map.roots.flatMap((r) => [r as MapAgreement, ...r.children]), ...map.loose]
    .filter((a) => a.kind !== "document" && a.kind !== "termination" && a.status !== "terminated")
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
        <h2>契約に載っていない条件明細</h2>
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
                <td>{c.name}</td>
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
        {directions.length > 1
          ? <span className="tag warn">IN と OUT が混ざっています。向きごとに分けて載せてください</span>
          : targets.length
            ? <select value={target} disabled={readOnly || !chosen.length} style={{ maxWidth: 360 }}
                      onChange={(e) => setTarget(e.target.value)}>
                <option value="">載せる契約を選んでください</option>
                {targets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.agreementNo ?? `#${a.id}`} {a.title}（{KIND_LABEL[a.kind]}・{a.direction === "in" ? "IN" : "OUT"}）
                  </option>
                ))}
              </select>
            : <span className="faint">{chosen.length ? "載せられる契約がありません。先に「契約を登録」" : "条件を選んでください"}</span>}
        <button className="btn btn-sm primary" disabled={readOnly || busy || !target || !chosen.length || directions.length > 1}
                onClick={() => void attach()}>契約に載せる</button>
      </div>
    </div>
  );
}

function AgreementNode(
  { a, issues, primary, editing, onEdit, leveling, onLevel, onOpen, roots, onSaved, onDocsChanged, onError }: {
    a: MapAgreement; issues: MapIssue[]; primary?: boolean; editing: boolean; onEdit: () => void;
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
  const isOrder = isOrderAgreement(a);
  const [toDocBusy, setToDocBusy] = useState(false);
  async function toOrderDocument() {
    if (!window.confirm(`${a.agreementNo ?? `#${a.id}`} は発注書です。契約から外して発注書（文書）にし、載っている条件明細 ${a.conditionCount} 本に紐づけます。よろしいですか？`)) return;
    setToDocBusy(true);
    try {
      const r = await api.post<{ documentNo: string; created: boolean; conditionsLinked: number; masterNo: string | null }>(
        `/agreement-map/agreements/${a.id}/to-order-document`, {});
      onSaved(`${a.agreementNo ?? `#${a.id}`} を発注書（文書 ${r.documentNo}${r.created ? "・新しく登録" : ""}）にし、条件明細 ${r.conditionsLinked} 本に紐づけました。`
        + (r.masterNo ? `条件明細は基本契約 ${r.masterNo} に載せました` : "基本契約が無いので、条件明細は発注書の約款で取引する扱い（契約なし）です"));
    } catch (e) { onError((e as ApiError).message); }
    finally { setToDocBusy(false); }
  }
  const canDemote = a.kind === "standalone";
  const canPromote = a.kind === "supplement" && Boolean(a.parentId);
  return (
    <div className={`amap-node${issues.length ? " bad" : ""}`}>
      <div className="amap-line">
        <span className={`tag ${a.direction}`}>{a.direction === "in" ? "IN" : "OUT"}</span>
        <span className="tag ghost">{KIND_LABEL[a.kind]}</span>
        {(a.kind === "master" || a.kind === "standalone") && (
          a.domain ? <span className="tag ghost">{DOMAIN_LABEL[a.domain]}</span>
                   : <span className="tag warn">種別なし</span>
        )}
        {primary && <span className="tag accent">既定</span>}
        <button className="linky code" onClick={() => onOpen?.("agreement", a.id)}>{a.agreementNo ?? `#${a.id}`}</button>
        <span>{a.title}</span>
        <StatusTag kind="agreement" value={a.status} />
        {a.executedOn
          ? <span className="faint">締結 {a.executedOn}</span>
          : a.kind !== "document" && <span className="tag ghost warn">締結日なし</span>}
        {a.terminatedOn && <span className="faint">解除 {a.terminatedOn}</span>}
        {a.counterparty.merged && <span className="faint" title="統合前の取引先を指しています（参照は付け替えない決まり）">統合元：{a.counterparty.name}</span>}
        <span className="faint">条件 {a.conditionCount}・文書 {a.documentCount}</span>
        {a.kind !== "document" && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setCondsOpen((v) => !v)}>
            {condsOpen ? "条件を閉じる" : "条件"}
          </button>
        )}
        <button className="btn btn-sm" style={a.kind === "document" ? { marginLeft: "auto" } : undefined}
                onClick={() => setDocsOpen((v) => !v)}>
          {docsOpen ? "文書を閉じる" : "文書"}
        </button>
        {isOrder && (
          <button className="btn btn-sm primary" disabled={readOnly || toDocBusy} onClick={() => void toOrderDocument()}
                  title="発注書は文書として持ちます。契約から外し、発注書の文書として条件明細に紐づけます">
            {toDocBusy ? "寄せています…" : "発注書（文書）に寄せる"}
          </button>
        )}
        {(canDemote || canPromote) && !isOrder && (
          <button className="btn btn-sm" disabled={readOnly} onClick={onLevel}>
            {levelOpen ? "閉じる" : canDemote ? "個別契約にする" : "単体契約に戻す"}
          </button>
        )}
        <button className="btn btn-sm" disabled={readOnly} onClick={onEdit}>
          {editing ? "閉じる" : "編集"}
        </button>
      </div>
      {issues.map((i, n) => <div key={n} className="amap-issue">⚠ {i.message}</div>)}
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
 * 単体契約を、基本契約の下の個別契約にする。条件明細は基本契約の明細に移る。
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
      onSaved(`${a.agreementNo ?? `#${a.id}`} を ${r.masterNo ?? "基本契約"} の下の個別契約にしました（条件明細 ${r.conditionsMoved} 本を基本契約へ）`
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
                  {m.agreementNo ?? `#${m.id}`} {m.title}（{m.domain ? DOMAIN_LABEL[m.domain] : "種別なし"}{m.executedOn ? `・締結 ${m.executedOn}` : "・未締結"}{m.primary ? "・既定" : ""}）
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
          選んだ文書を基本契約（番号は文書の番号のまま）として登録し、文書はその基本契約に付け替えます。締結日は登録後に「編集」で入れてください（入れると締結済み・既定になります）。
        </span>
      )}
      <span className="faint">
        この契約は選んだ基本契約の下の個別契約になり、載っている条件明細 {a.conditionCount} 本は基本契約の明細に移ります。
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
      onSaved(`${a.agreementNo ?? `#${a.id}`} を単体契約に戻しました（条件明細 ${r.conditionsMoved} 本を戻す）`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="amap-form stack" style={{ gap: 8 }}>
      <b>（1）基本契約＋個別契約 → （2）単体契約</b>
      <span className="faint">
        {parent ? `${parent.agreementNo ?? `#${parent.id}`} の下から外し、` : ""}その取引だけで完結する単体契約にします。
        基本契約に載っている条件明細のうち、この契約の文書（条件書）に載っているものを、この契約に戻します。覚書のように条件明細を持たないものは、戻さないでください。
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
  const [direction, setDirection] = useState<"in" | "out">(a.direction);
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
        kind, direction,
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
        <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
          <option value="in">IN（取得）</option>
          <option value="out">OUT（許諾・委託）</option>
        </select>
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
