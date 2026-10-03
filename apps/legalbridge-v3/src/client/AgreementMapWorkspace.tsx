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
import type { MapAgreement, MapIssue, MapNode, MapPartyRow, PartyMap } from "../server/agreements/party-map.js";

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
  master: "基本契約", standalone: "単体契約", supplement: "補助文書", termination: "解除合意", document: "文書だけ"
};
const DOMAIN_LABEL: Record<AgreementDomain, string> = { service: "業務委託", license: "ライセンス" };

export function AgreementMapWorkspace(
  { initialPartyId, onOpen }: { initialPartyId?: number; onOpen?: (kind: EntityKind, id: number) => void }
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
          取引先ごとに、基本契約とその下の補助文書・解除合意を図にします。
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
            <ListSearch value={keyword} onChange={setKeyword} placeholder="取引先名" label="取引先を絞り込む" />
            <label className="faint" style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} />
              ずれのあるものだけ{issueCount > 0 && !issuesOnly ? `（${issueCount}）` : ""}
            </label>
          </div>
          <div className="ledger-tree">
            {parties.map((p) => (
              <button key={p.id} className="node" aria-pressed={p.id === partyId}
                      onClick={() => { setPartyId(p.id); setNotice(null); setError(null); }}>
                <span className="grow">{p.name}</span>
                {p.issues > 0 && <span className="tag warn">ずれ {p.issues}</span>}
                <span className="faint">{p.roots}本</span>
              </button>
            ))}
            {!parties.length && <div className="faint" style={{ padding: 6 }}>該当する取引先はありません</div>}
          </div>
        </div>

        <div className="stack">
          {!map && <div className="note">左から取引先を選んでください。</div>}
          {map && (
            <PartyMapView map={map} onOpen={onOpen}
              onChanged={(msg) => { setNotice(msg); setError(null); bump(); }}
              onError={setError} />
          )}
        </div>
      </div>
    </section>
  );
}

function PartyMapView(
  { map, onOpen, onChanged, onError }: {
    map: PartyMap; onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: (msg: string) => void; onError: (msg: string) => void;
  }
) {
  const [editing, setEditing] = useState<number | null>(null);
  const issuesOf = (id: number) => map.issues.filter((i) => i.agreementId === id);

  const node = (a: MapAgreement, extra?: { primary?: boolean }) => (
    <AgreementNode key={a.id} a={a} issues={issuesOf(a.id)} primary={extra?.primary}
      editing={editing === a.id} onEdit={() => setEditing(editing === a.id ? null : a.id)}
      onOpen={onOpen} roots={map.roots}
      onSaved={(msg) => { setEditing(null); onChanged(msg); }}
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
                  <button className="linky" onClick={() => setEditing(i.agreementId)}>{i.message}</button>
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
          <span className="faint" style={{ marginLeft: "auto" }}>
            既定＝他の画面がこの取引先の基本契約として拾う1本（種別 × 方向ごと。基本契約だけで、単体契約は既定にしません）
          </span>
        </div>
        <div className="panel-bd">
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
              {!map.roots.length && <div className="faint">基本契約・単体契約はありません</div>}
            </div>
          </div>
        </div>
      </div>

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

function AgreementNode(
  { a, issues, primary, editing, onEdit, onOpen, roots, onSaved, onDocsChanged, onError }: {
    a: MapAgreement; issues: MapIssue[]; primary?: boolean; editing: boolean; onEdit: () => void;
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
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setDocsOpen((v) => !v)}>
          {docsOpen ? "文書を閉じる" : "文書"}
        </button>
        <button className="btn btn-sm" disabled={readOnly} onClick={onEdit}>
          {editing ? "閉じる" : "編集"}
        </button>
      </div>
      {issues.map((i, n) => <div key={n} className="amap-issue">⚠ {i.message}</div>)}
      {editing && <RemapForm a={a} roots={roots} onSaved={onSaved} onError={onError} />}
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
