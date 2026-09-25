import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { ListCount, ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag } from "./labels.js";
import { Relations, type EntityKind } from "./Relations.js";
import { SearchSelect, searchParties } from "./SearchSelect.js";
import { TermHistoryTable } from "./TermHistory.js";
import { ConditionCreateForm } from "./ConditionCreateForm.js";
import { useReadOnly } from "./read-only.js";
import type { AgreementRow, AgreementKind, AgreementDomain, TerminatePlanLine } from "../server/agreements/service.js";
import type { TermHistory } from "../server/agreements/term-history.js";

/**
 * 契約（合意）。
 *
 * 「合意」は締結の事実と期間を持つ器。「文書」は出力物。「条件」は金額。
 * これまで合意は V2 から移した器しか無く、画面からは作れなかった。
 * 新しい相手と契約を結んでも合意が立たず、工程「基本契約の確認」は
 * 未済のまま、契約チェックは「なし」のままだった。
 *
 * 作られ方は 3 通り。
 *   ① 外で結んだ契約を人がここで登録する（Drive のリンクだけ持つ）
 *   ② 条件書（個別利用許諾条件書・出版条件書）を決定したとき自動で立つ
 *   ③ 発注書・検収書・計算書は合意にしない
 *
 * 種類：基本契約（ARC-SVC／ARC-LIC）・単体契約（ARC-ISA／ARC-ILT）・
 *       補助文書（親番号-S01。覚書で条件を定める・一部を直す）・
 *       解除合意（親番号-T01）・文書だけ（NDA など。番号なし）
 */

interface LineRow {
  id: number; conditionNo: string | null; name: string; kind: string; status: string;
  direction: string; currency: string; pricingModel: string;
  ratePct: number | null; flatAmount: number | null;
  mgAmount: number | null; agAmount: number | null;
  termStart: string | null; termEnd: string | null; effectiveFrom: string | null;
  work: { id: number; code: string | null; title: string; part: string | null } | null;
}
interface WorkRow { id: number; code: string | null; title: string; conditionCount: number; activeCount: number }
interface Detail {
  agreement: AgreementRow; parent: AgreementRow | null; children: AgreementRow[];
  history: TermHistory; conditions: LineRow[]; works: WorkRow[];
}

export const KIND_LABEL: Record<AgreementKind, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "補助文書", termination: "解除合意", document: "文書だけ"
};
const KIND_TONE: Record<AgreementKind, string> = {
  master: "ghost accent", standalone: "ghost warn", supplement: "ghost", termination: "ghost out", document: "ghost"
};
const COND_KIND_LABEL: Record<string, string> = {
  license: "許諾料", product: "製品", service: "委託料", expense: "実費", fee: "手数料"
};

function terms(line: LineRow): string {
  const parts: string[] = [];
  if (line.ratePct !== null) parts.push(`料率 ${line.ratePct}%`);
  if (line.flatAmount) parts.push(`定額 ${money(line.flatAmount, line.currency)}`);
  if (line.mgAmount) parts.push(`MG ${money(line.mgAmount, line.currency)}`);
  if (line.agAmount) parts.push(`AG ${money(line.agAmount, line.currency)}`);
  return parts.join("／") || "—";
}

const KindTag = ({ kind }: { kind: AgreementKind }) =>
  <span className={`tag ${KIND_TONE[kind] ?? "ghost"}`}>{KIND_LABEL[kind] ?? kind}</span>;

/** 番号の見込み。登録前に「こう振られる」と出す。 */
function previewNumber(kind: AgreementKind, domain: AgreementDomain, parent: AgreementRow | null): string {
  const year = new Date().getFullYear();
  if (kind === "master") return `${domain === "license" ? "ARC-LIC" : "ARC-SVC"}-${year}-NNNN`;
  if (kind === "standalone") return `${domain === "license" ? "ARC-ILT" : "ARC-ISA"}-${year}-NNNN`;
  if (kind === "supplement") return `${parent?.agreementNo ?? "（親）"}-Snn`;
  if (kind === "termination") return `${parent?.agreementNo ?? "（親）"}-Tnn`;
  return "番号なし";
}

export interface CreatePreset {
  partyId: number; partyName?: string | null;
  /** 補助文書を足すときの親。 */
  parentId?: number | null;
  kind?: AgreementKind;
  domain?: AgreementDomain;
}

export function AgreementsWorkspace(
  { initialId, onOpen, createPreset }: {
    initialId?: number; onOpen?: (kind: EntityKind, id: number) => void;
    /** 案件の工程「契約を登録する」から来たとき。相手先が入った状態で登録を開く。 */
    createPreset?: CreatePreset | null;
  }
) {
  const readOnly = useReadOnly();
  const [rows, setRows] = useState<AgreementRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState<CreatePreset | null>(createPreset ?? null);
  const [terminating, setTerminating] = useState(false);
  const [addingCondition, setAddingCondition] = useState(false);
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    api.get<{ agreements: AgreementRow[] }>(
      `/agreements${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`)
      .then((r) => setRows(r.agreements))
      .catch((e: ApiError) => setError(e.message));
  }, [search, version]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setTerminating(false); setAddingCondition(false);
    api.get<Detail>(`/agreements/${selected}`)
      .then(setDetail).catch((e: ApiError) => setError(e.message));
  }, [selected, version]);

  async function act(path: string, body: Record<string, unknown>, done: string) {
    setError(null);
    try {
      await api.post(path, body);
      setNotice(done); bump();
    } catch (e) { setError((e as ApiError).message); }
  }

  const a = detail?.agreement ?? null;

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>契約</h1>
        <p>
          契約は器。期間と更新は契約が持ち、金額と料率は中の条件明細が持ちます。
          基本契約なしの単体契約も、ここに載ります。外で結んだ契約書は Drive のリンクで持ちます。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      <div className="row">
        {!creating && (
          <button className="btn primary btn-sm" disabled={readOnly}
                  onClick={() => { setCreating({ partyId: 0 }); setSelected(undefined); }}>契約を登録</button>
        )}
        <span className="faint">
          外で結んだ契約書（Drive にある紙）をここに入れます。
          このシステムで決定した条件書は、決定した瞬間に自動でここに載ります
        </span>
      </div>

      {creating && (
        <AgreementCreate preset={creating}
          onDone={(id, no) => { setCreating(null); setSelected(id); bump();
                                setNotice(`${no ?? "契約"} を登録しました`); }}
          onCancel={() => setCreating(null)} />
      )}

      <div className="stack">
        <div className="panel">
          <div className="panel-hd">
            <h2>契約</h2>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="契約番号・件名・相手先" label="契約を絞り込む" />
          </div>
          <ListCount shown={rows.length} keyword={search} onClear={() => setKeyword("")} />
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>契約番号</th><th>種類</th><th>件名</th><th>相手先</th>
                <th className="num">条件明細</th><th>期間</th><th>状態</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.id === selected ? "sel" : undefined}
                      onClick={() => { setSelected(r.id); setCreating(null); }} style={{ cursor: "pointer" }}>
                    <td className="code">
                      {r.parentId
                        ? <span className="faint">　└ {r.agreementNo ?? `#${r.id}`}</span>
                        : <><span className={`tag ${r.direction}`}>{r.direction === "in" ? "IN" : "OUT"}</span>
                           {" "}{r.agreementNo ?? <span className="faint">（番号なし）</span>}</>}
                    </td>
                    <td><KindTag kind={r.kind} /></td>
                    <td>{r.title}</td>
                    <td>{r.counterparty.name}</td>
                    <td className="num">{r.conditionCount || "—"}</td>
                    <td className="faint">
                      {r.kind === "termination"
                        ? `解除日 ${r.terminatedOn ?? "—"}`
                        : <>{r.effectiveOn ?? r.executedOn ?? "—"} 〜 {r.currentEnd ?? "期限なし"}
                            {r.renewals > 0 && <span className="faint">（更新 {r.renewals}）</span>}</>}
                    </td>
                    <td><StatusTag kind="agreement" value={r.status} /></td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={7} className="faint">
                    {search.trim() ? `「${search}」に一致する契約はありません` : "契約がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {detail && a && (
          <>
            <div className="panel">
              <div className="panel-hd" style={{ gap: 8, flexWrap: "wrap" }}>
                <h2><span className="code">{a.agreementNo ?? `#${a.id}`}</span>　{a.title}</h2>
                <KindTag kind={a.kind} />
                <span className={`tag ${a.direction}`}>{a.direction === "in" ? "IN" : "OUT"}</span>
                <StatusTag kind="agreement" value={a.status} />
                <span className="faint" style={{ marginLeft: "auto" }}>{a.counterparty.name}</span>
              </div>
              <div className="panel-bd stack">
                <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
                  <span><span className="faint">締結 </span>{a.executedOn ?? "—"}</span>
                  <span><span className="faint">有効 </span>{a.effectiveOn ?? "—"} 〜 <b>{a.currentEnd ?? "期限なし"}</b></span>
                  <span><span className="faint">自動更新 </span>
                    {a.autoRenewal
                      ? `あり（${a.renewalMonths ? `${a.renewalMonths}か月ごと` : "当初と同じ長さ"}${a.renewalNoticeMonths ? `・${a.renewalNoticeMonths}か月前通知` : ""}）`
                      : "なし"}</span>
                  {a.renewalStoppedOn && <span><span className="faint">不更新 </span>{a.renewalStoppedOn}</span>}
                  {a.terminatedOn && <span style={{ color: "var(--out)" }}><span className="faint">解除 </span>{a.terminatedOn}</span>}
                  {a.counterpartyRefNo && <span><span className="faint">相手方番号 </span>{a.counterpartyRefNo}</span>}
                  <span><span className="faint">契約書 </span>
                    {a.sourceUrl ? <a className="linky" href={a.sourceUrl} target="_blank" rel="noreferrer">Drive で開く</a>
                                 : <span className="faint">リンクなし</span>}</span>
                  {detail.parent && (
                    <span><span className="faint">親 </span>
                      <button className="linky" onClick={() => setSelected(detail.parent!.id)}>
                        {detail.parent.agreementNo ?? `#${detail.parent.id}`} {detail.parent.title}
                      </button></span>
                  )}
                </div>

                {/* 締結の記録は文書からでも契約からでもできる（外で結んだ契約には文書が無い）。 */}
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {a.status !== "executed" && a.status !== "terminated" && (
                    <DateAction label="締結を記録" disabled={readOnly}
                      onRun={(on) => act(`/agreements/${a.id}/execute`, { on }, `${a.agreementNo ?? a.title} の締結を記録しました`)} />
                  )}
                  {(a.kind === "master" || a.kind === "standalone") && (
                    <button className="btn btn-sm" disabled={readOnly}
                      onClick={() => setCreating({ partyId: a.counterparty.id, partyName: a.counterparty.name,
                                                   parentId: a.id, kind: "supplement", domain: a.domain ?? undefined })}>
                      補助文書を足す
                    </button>
                  )}
                  {a.autoRenewal && !a.renewalStoppedOn && !a.terminatedOn && (
                    <DateAction label="不更新を決めた" disabled={readOnly}
                      onRun={(on) => act(`/agreements/${a.id}/decline`, { on }, "不更新を記録しました。いまの期間は満了まで有効です")} />
                  )}
                  {(a.kind === "master" || a.kind === "standalone") && !a.terminatedOn && (
                    <button className="btn btn-sm danger" disabled={readOnly} onClick={() => setTerminating(true)}>解除する</button>
                  )}
                  <button className="btn btn-sm" disabled={readOnly} onClick={() => setAddingCondition((v) => !v)}>
                    {addingCondition ? "条件の登録をやめる" : "条件明細を登録する"}
                  </button>
                  <span className="faint">締結の記録は、文書からでも契約からでもできます</span>
                </div>

                {terminating && (
                  <TerminatePanel agreement={a} conditions={detail.conditions}
                    onCancel={() => setTerminating(false)}
                    onDone={(msg) => { setTerminating(false); setNotice(msg); bump(); }} />
                )}

                {addingCondition && (
                  <ConditionCreateForm
                    title={`${a.agreementNo ?? a.title} の条件明細を登録`}
                    preset={{ counterpartyId: String(a.counterparty.id), agreementId: String(a.id),
                              direction: a.direction,
                              kind: a.domain === "license" ? "license" : "service" }}
                    presetLabels={{ counterpartyId: a.counterparty.name,
                                    agreementId: `${a.agreementNo ?? ""} ${a.title}`.trim() }}
                    onDone={() => { setAddingCondition(false); bump(); setNotice("条件明細を登録しました"); }}
                    onCancel={() => setAddingCondition(false)} />
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-hd">
                <h2>更新履歴</h2>
                <span className="faint">行は計算で出ます。最終行の終了日がいまの終了日</span>
              </div>
              <div className="panel-bd"><TermHistoryTable history={detail.history} /></div>
            </div>

            {(detail.children.length > 0 || a.kind === "master" || a.kind === "standalone") && (
              <div className="panel">
                <div className="panel-hd">
                  <h2>この契約にぶら下がるもの</h2>
                  <span className="faint">補助文書・解除合意は枝番で並びます</span>
                </div>
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>番号</th><th>種類</th><th>件名</th><th>日付</th><th>状態</th><th></th></tr></thead>
                    <tbody>
                      {detail.children.map((c) => (
                        <tr key={c.id}>
                          <td className="code">{c.agreementNo ?? `#${c.id}`}</td>
                          <td><KindTag kind={c.kind} /></td>
                          <td>{c.title}</td>
                          <td className="faint">{c.kind === "termination" ? `解除日 ${c.terminatedOn ?? "—"}` : (c.executedOn ?? c.effectiveOn ?? "—")}</td>
                          <td><StatusTag kind="agreement" value={c.status} /></td>
                          <td><button className="btn btn-sm" onClick={() => setSelected(c.id)}>開く</button></td>
                        </tr>
                      ))}
                      {!detail.children.length && (
                        <tr><td colSpan={6} className="faint">まだありません。覚書や解除合意はここに増えます</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.works.length > 0 && (
              <div className="panel">
                <div className="panel-hd">
                  <h2>及ぶ作品 {detail.works.length}</h2>
                  <span className="faint">契約は作品を直接持ちません。条件明細がどの作品を指しているかで決まります</span>
                </div>
                <div className="panel-bd">
                  <div className="chips">
                    {detail.works.map((w) => (
                      <button key={w.id} type="button" className="tag accent"
                              onClick={() => onOpen?.("work", w.id)} title={w.code ?? undefined}>
                        {w.title}
                        <span className="faint" style={{ marginLeft: 4 }}>
                          条件 {w.activeCount}{w.conditionCount !== w.activeCount && `／${w.conditionCount}`}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-hd">
                <h2>条件明細</h2>
                <span className="faint">この契約の中身。金額と料率はここが持ちます（契約そのものは持ちません）</span>
              </div>
              <div className="tablewrap">
                <table>
                  <thead><tr>
                    <th>番号</th><th>作品</th><th>名称</th><th>種類</th><th>条件</th>
                    <th>期間</th><th>状態</th><th></th>
                  </tr></thead>
                  <tbody>
                    {detail.conditions.map((line) => (
                      <tr key={line.id}>
                        <td className="code">{line.conditionNo ?? `#${line.id}`}</td>
                        <td>{line.work ? <>{line.work.title}{line.work.part && <span className="faint" style={{ marginLeft: 4 }}>{line.work.part}</span>}</>
                                       : <span className="faint">作品なし</span>}</td>
                        <td>{line.name}</td>
                        <td>{COND_KIND_LABEL[line.kind] ?? line.kind}</td>
                        <td className="faint">{terms(line)}</td>
                        <td className="faint">{line.termStart ?? "—"}{line.termEnd ? ` 〜 ${line.termEnd}` : " 〜 期限なし"}</td>
                        <td><StatusTag kind="condition" value={line.status} /></td>
                        <td>{onOpen && <button className="btn btn-sm" onClick={() => onOpen("condition", line.id)}>開く</button>}</td>
                      </tr>
                    ))}
                    {!detail.conditions.length && (
                      <tr><td colSpan={8} className="faint">
                        {a.kind === "document"
                          ? "文書だけの契約です。条件明細は持ちません"
                          : "この契約にはまだ条件明細がありません。上の「条件明細を登録する」から登録できます"}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <Relations kind="agreement" id={a.id} reloadKey={version} onOpen={onOpen} onChanged={bump} />
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 登録
// ---------------------------------------------------------------------------

function AgreementCreate({ preset, onDone, onCancel }: {
  preset: CreatePreset;
  onDone: (id: number, agreementNo: string | null) => void;
  onCancel: () => void;
}) {
  const [partyId, setPartyId] = useState(preset.partyId ? String(preset.partyId) : "");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [domain, setDomain] = useState<AgreementDomain>(preset.domain ?? "service");
  const [title, setTitle] = useState("");
  const [executedOn, setExecutedOn] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [autoRenewal, setAutoRenewal] = useState(false);
  const [renewalMonths, setRenewalMonths] = useState("");
  const [noticeMonths, setNoticeMonths] = useState("");
  const [refNo, setRefNo] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  /** 「条件明細がぶら下がりますか」。null はまだ答えていない。 */
  const [hasConditions, setHasConditions] = useState<boolean | null>(preset.kind ? true : null);
  const [kind, setKind] = useState<AgreementKind>(preset.kind ?? "master");
  const [parents, setParents] = useState<AgreementRow[]>([]);
  const [parentId, setParentId] = useState(preset.parentId ? String(preset.parentId) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 相手先が決まったら、その相手の基本契約・単体契約を親の候補に出す。
  useEffect(() => {
    if (!partyId) { setParents([]); return; }
    api.get<{ agreements: AgreementRow[] }>(`/agreements?partyId=${partyId}`)
      .then((r) => setParents(r.agreements.filter((x) => x.kind === "master" || x.kind === "standalone")))
      .catch(() => setParents([]));
  }, [partyId]);

  const parent = parents.find((p) => String(p.id) === parentId) ?? null;
  const effectiveKind: AgreementKind = hasConditions === false ? "document" : kind;
  const ready = partyId && title.trim() && executedOn && hasConditions !== null
    && (effectiveKind !== "supplement" || parentId);

  async function submit(thenConditions: boolean) {
    setBusy(true); setError(null);
    try {
      const made = await api.post<{ id: number; agreementNo: string | null }>("/agreements", {
        counterpartyId: Number(partyId), direction, kind: effectiveKind,
        domain: effectiveKind === "document" ? null : domain,
        parentId: effectiveKind === "supplement" ? Number(parentId) : null,
        title: title.trim(), executedOn, status: "executed",
        effectiveOn: effectiveOn || executedOn, expiresOn: expiresOn || null,
        autoRenewal, renewalMonths: renewalMonths ? Number(renewalMonths) : null,
        renewalNoticeMonths: noticeMonths ? Number(noticeMonths) : null,
        counterpartyRefNo: refNo || null, sourceUrl: sourceUrl || null
      });
      onDone(made.id, made.agreementNo);
      // 「登録して、条件明細の登録へ」は、開いた詳細で登録欄を出す（親は detail 側）。
      void thenConditions;
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>{preset.kind === "supplement" ? "補助文書の登録" : "契約の登録"}</h2>
        <span className="faint">必須は 相手先・向き・種別・件名・締結日</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        <div className="grid4">
          <label className="fld"><span>相手先 <em>必須</em></span>
            {preset.partyId && preset.partyName
              ? <b style={{ paddingTop: 6 }}>{preset.partyName}</b>
              : <SearchSelect value={partyId} onChange={(v) => setPartyId(v)} search={searchParties}
                              placeholder="取引先名・コードで探す" />}
            <small>無ければ「取引先・担当」で登録してから</small>
          </label>
          <label className="fld"><span>向き <em>必須</em></span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
              <option value="in">IN 取得（費用側）</option><option value="out">OUT 許諾（収入側）</option>
            </select></label>
          <label className="fld"><span>種別 <em>必須</em></span>
            <select value={domain} onChange={(e) => setDomain(e.target.value as AgreementDomain)}>
              <option value="service">業務委託</option><option value="license">ライセンス</option>
            </select><small>番号の頭が決まる（SVC／LIC、単体は ISA／ILT）</small></label>
          <label className="fld"><span>件名 <em>必須</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="業務委託基本契約 など" /></label>
        </div>
        <div className="grid4">
          <label className="fld"><span>締結日 <em>必須</em></span>
            <input type="date" value={executedOn} onChange={(e) => setExecutedOn(e.target.value)} /></label>
          <label className="fld"><span>有効期間</span>
            <span className="row" style={{ gap: 6 }}>
              <input type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
              <span className="faint">〜</span>
              <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </span><small>開始が空なら締結日。終了が空なら期限なし</small></label>
          <label className="fld"><span>自動更新</span>
            <select value={autoRenewal ? "1" : ""} onChange={(e) => setAutoRenewal(e.target.value === "1")}>
              <option value="">なし</option><option value="1">あり</option>
            </select>
            {autoRenewal && (
              <span className="row" style={{ gap: 6, marginTop: 4 }}>
                <input value={renewalMonths} onChange={(e) => setRenewalMonths(e.target.value)} placeholder="更新期間（か月）" style={{ width: 130 }} />
                <input value={noticeMonths} onChange={(e) => setNoticeMonths(e.target.value)} placeholder="通知（か月前）" style={{ width: 120 }} />
              </span>
            )}
            <small>{autoRenewal ? "更新期間が空なら当初の期間と同じ長さ" : "終了日が来たら満了"}</small></label>
          <label className="fld"><span>相手方の契約番号</span>
            <input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="相手が付けた番号があれば" /></label>
        </div>
        <label className="fld"><span>契約書（Drive）</span>
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://drive.google.com/…" />
          <small>現物は Drive に置く。ここにはリンクだけ</small></label>

        {preset.kind !== "supplement" && (
          <div className="ask">
            <div className="ask-q">この契約の下に、条件明細（金額・期間の行）がぶら下がりますか？</div>
            <div className="ask-help">発注書・検収書・計算書は条件明細から出ます。NDA や秘密保持のように金額を持たないものは「いいえ」。</div>
            <label className={`opt${hasConditions === false ? " on" : ""}`}>
              <input type="radio" name="hasc" checked={hasConditions === false} onChange={() => setHasConditions(false)} />
              {" "}<b>いいえ</b><span className="faint">　文書として登録するだけ。番号は振らない（相手方の番号だけ持つ）</span>
            </label>
            <label className={`opt${hasConditions === true ? " on" : ""}`}>
              <input type="radio" name="hasc" checked={hasConditions === true} onChange={() => setHasConditions(true)} />
              {" "}<b>はい</b><span className="faint">　どれですか</span>
            </label>
            {hasConditions && (
              <div className="ask-sub">
                {(["master", "supplement", "standalone"] as AgreementKind[]).map((k) => (
                  <label key={k} className={`opt${kind === k ? " on" : ""}`}>
                    <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                    {" "}<b>{KIND_LABEL[k]}</b>
                    <span className="faint">
                      {k === "master" && "　器を作る。条件はあとで発注書・条件書から付く"}
                      {k === "supplement" && "　既存の基本契約の下で条件を定める・一部を直す（個別条件書・覚書・変更合意）"}
                      {k === "standalone" && "　基本契約なしで、この 1 通が金額・期間まで定める"}
                      {"　→ "}<span className="code">{previewNumber(k, domain, k === "supplement" ? parent : null)}</span>
                    </span>
                    {k === "supplement" && kind === "supplement" && (
                      <span className="row" style={{ margin: "4px 0 0 22px" }}>
                        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                          <option value="">親の契約を選ぶ</option>
                          {parents.map((p) => <option key={p.id} value={p.id}>{p.agreementNo ?? `#${p.id}`} {p.title}</option>)}
                        </select>
                        {!parents.length && <span className="faint">この相手には基本契約・単体契約がありません</span>}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {preset.kind === "supplement" && (
          <div className="note">親：<span className="code">{parent?.agreementNo ?? preset.parentId}</span>　番号は <span className="code">{previewNumber("supplement", domain, parent)}</span></div>
        )}

        <div className="row">
          <button className="btn primary" disabled={!ready || busy} onClick={() => void submit(true)}>
            {effectiveKind === "document" ? "登録する" : "登録する（続けて条件明細を登録できます）"}
          </button>
          <button className="btn" onClick={onCancel}>やめる</button>
          {!ready && <span className="faint">相手先・件名・締結日と、条件明細の要否を入れると登録できます</span>}
        </div>
      </div>
    </div>
  );
}

/** 日付を 1 つ聞いてから走る小さなボタン（締結を記録・不更新）。 */
function DateAction({ label, onRun, disabled }: { label: string; onRun: (on: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  if (!open) return <button className="btn btn-sm" disabled={disabled} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="faint">{label}：</span>
      <input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
      <button className="btn btn-sm primary" disabled={!on} onClick={() => { setOpen(false); onRun(on); }}>記録</button>
      <button className="btn btn-sm" onClick={() => setOpen(false)}>やめる</button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 解除
// ---------------------------------------------------------------------------

function TerminatePanel({ agreement, conditions, onCancel, onDone }: {
  agreement: AgreementRow; conditions: LineRow[];
  onCancel: () => void; onDone: (message: string) => void;
}) {
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [scope, setScope] = useState<"whole" | "conditions">("whole");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sourceUrl, setSourceUrl] = useState("");
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<{ lines: TerminatePlanLine[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = conditions.filter((c) => c.status === "active");

  // 日付・範囲が変わるたびに下見を引き直す。押す前に何が起きるかを見せる。
  useEffect(() => {
    if (!on || (scope === "conditions" && !picked.size)) { setPlan(null); return; }
    let live = true;
    api.post<{ lines: TerminatePlanLine[]; warnings: string[] }>(`/agreements/${agreement.id}/terminate/preview`,
      { on, scope, conditionIds: [...picked] })
      .then((p) => { if (live) { setPlan(p); setError(null); } })
      .catch((e: ApiError) => { if (live) { setPlan(null); setError(e.message); } });
    return () => { live = false; };
  }, [on, scope, [...picked].join(","), agreement.id]);

  async function run() {
    if (!window.confirm(`${on} で解除します。条件・紙・支払は消しませんが、解除日より後の予定は取り消します。進めますか。`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ terminationNo: string | null; conditions: number; schedulesRemoved: number }>(
        `/agreements/${agreement.id}/terminate`, { on, scope, conditionIds: [...picked], reason, sourceUrl: sourceUrl || null });
      onDone(`解除しました（${r.terminationNo ?? "解除合意"}）。条件 ${r.conditions} 本を ${on} で終え、予定 ${r.schedulesRemoved} 回を取り消しました`);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ borderColor: "var(--out)" }}>
      <div className="panel-hd"><h2>解除します</h2><span className="faint">{agreement.agreementNo ?? `#${agreement.id}`} {agreement.title}</span></div>
      <div className="panel-bd stack">
        <div className="note">解除は「ここで終わる」と日付を置く処理です。条件・紙・支払は消しません。番号も戻りません。</div>
        {error && <div className="alert">{error}</div>}
        <div className="grid4">
          <label className="fld"><span>解除日 <em>必須</em></span>
            <input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
          <label className="fld"><span>範囲 <em>必須</em></span>
            <select value={scope} onChange={(e) => setScope(e.target.value as "whole" | "conditions")}>
              <option value="whole">契約ごと終える（契約の状態を「解除」に）</option>
              <option value="conditions">一部の条件だけ終える（契約は締結済みのまま）</option>
            </select></label>
          <label className="fld"><span>解除合意書（Drive）</span>
            <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://drive.google.com/…" /></label>
          <label className="fld"><span>番号</span><span className="code" style={{ paddingTop: 6 }}>{agreement.agreementNo ?? `#${agreement.id}`}-Tnn</span></label>
        </div>

        {scope === "conditions" && (
          <div className="stack" style={{ gap: 4 }}>
            <span className="faint">終える条件を選ぶ</span>
            {active.map((c) => (
              <label key={c.id} className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={picked.has(c.id)}
                  onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
                <span className="code">{c.conditionNo ?? `#${c.id}`}</span> {c.name}
              </label>
            ))}
            {!active.length && <span className="faint">有効な条件がありません</span>}
          </div>
        )}

        {plan && (
          <>
            <div className="tablewrap"><table>
              <thead><tr><th>条件</th><th>いまの終了日</th><th>解除後</th><th className="num">取り消す予定</th><th className="num">残す実績・支払</th></tr></thead>
              <tbody>
                {plan.lines.map((l) => (
                  <tr key={l.conditionId}>
                    <td><span className="code">{l.conditionNo ?? `#${l.conditionId}`}</span> {l.name}</td>
                    <td className="code">{l.currentEnd ?? "期限なし"}</td>
                    <td className="code"><b>{l.newEnd}</b></td>
                    <td className="num">{l.schedulesToRemove ? <b>{l.schedulesToRemove} 回</b> : "—"}</td>
                    <td className="num">実績 {l.events}／未払 {l.unpaidPayments}</td>
                  </tr>
                ))}
                {!plan.lines.length && <tr><td colSpan={5} className="faint">終える条件がありません（契約の状態だけ変わります）</td></tr>}
              </tbody>
            </table></div>
            {plan.warnings.map((w, i) => <div key={i} className="note warn">{w}</div>)}
          </>
        )}

        <label className="fld"><span>理由 <em>必須</em></span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：受託者の都合により 9 月末で終了（解除合意書のとおり）" />
          <small>監査に残ります</small></label>
        <div className="row">
          <button className="btn" onClick={onCancel}>やめる</button>
          <button className="btn danger" disabled={busy || !plan || !reason.trim()} onClick={() => void run()}>
            {busy ? "解除しています…" : "解除する"}
          </button>
        </div>
      </div>
    </div>
  );
}
