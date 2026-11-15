import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import { DOMAIN_OPTIONS } from "./agreement-domains.js";
import { useMapLinks } from "./mapLinks.js";
import type { AlignResult, ForwardCarry, RepaperLinks, RepaperResult, StalePaper, TermsRepaperPlan, TermsRepaperResult } from "../server/agreements/service.js";

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 適用日が先の引き継ぎの結果（予約した版・見送った条件）。巻き直した直後と、あとから合わせたあとで同じ形。 */
function ForwardSummary({ forward }: { forward: ForwardCarry }) {
  return (
    <>
      <li>条件明細 {forward.scheduled.length} 本を、<b>{forward.on} からの改訂</b>として予約しました
        {forward.scheduled.length > 0 && <>（{forward.scheduled.map((x) => x.conditionNo ?? `#${x.id}`).join("・")}）</>}。
        いまの版は旧契約に残り、{forward.on} に新しい版へ切り替わります（それまでの計算は、いまの条件のまま）。</li>
      {forward.skipped.length > 0 && (
        <li>旧契約に残したもの：{forward.skipped.map((x) => `${x.conditionNo ?? x.name}（${x.reason}）`).join("、")}</li>
      )}
    </>
  );
}

/**
 * 契約の巻き直し（infra/v3/209_agreement_repaper.sql）。
 *
 * いまの基本契約・単体契約を、新しい契約で置き換える。新契約を立て、旧契約に載っている条件明細と
 * 下の個別契約を新契約へ引き継ぐ。旧契約は、新契約が締結済みになった時点で終了になる
 * （未締結のあいだは有効のまま）。旧契約の文書・実績・支払は旧契約に残る。
 * 立てたあとは、新しい契約書を「ファイルを上げる」か「ひな形で作る」。
 *
 * 単体契約は「基本契約＋個別契約」に切り替えて巻き直せる：新契約を基本契約で立て、条件明細を
 * いったん基本契約に載せる（個別契約待ち）。続けて条件書・発注書を決定すると、新しい番号の
 * 個別契約が基本契約の下に立つ。
 *
 * 適用日（有効期間の開始）が先のときは、条件明細を移さない。いま有効な条件明細について「適用日からの改訂」を
 * 新契約に予約し、いまの版は旧契約に残す（適用日に新しい版へ切り替わる）。予約した版で条件書を作ると、
 * 許諾開始日が適用日になる。先に条件を新契約へ移してしまったときは、契約の画面の「巻き直し」の帯から
 * あとで合わせられる（条件明細を適用日からの改訂にする → 条件書の訂正版を作る）。
 */

export interface RepaperTarget {
  id: number; agreementNo: string | null; title: string;
  kind: string; domain: string | null; partyId: number;
  /**
   * 個別契約（条件書）から開いた：条件書だけの巻き直しで始め、その個別契約の条件明細だけを選んだ状態にする。
   * id・番号などは親の基本契約のもの。
   */
  terms?: { holderId: number; holderNo: string | null };
}

/** 種別ごとの基本契約書のひな形（無い種別はファイルを上げる）。 */
const MASTER_TEMPLATE: Record<string, { key: string; label: string }> = {
  license: { key: "license_master", label: "利用許諾基本契約書" },
  service: { key: "service_master", label: "業務委託基本契約書" }
};
const MASTER_TITLE: Record<string, string> = {
  license: "利用許諾基本契約", service: "業務委託基本契約", hybrid: "業務委託・利用許諾基本契約", sale: "売買基本契約"
};
const DOC_KIND: Record<string, string> = {
  license: "利用許諾契約書", service: "業務委託契約書", hybrid: "業務委託・利用許諾契約書", sale: "売買契約書"
};

export function RepaperDialog({ target, onDone, onClose, onOpenAgreement, onComposeContract: composeContractProp, onComposeTerms: composeTermsProp }: {
  target: RepaperTarget;
  /** 巻き直した（一覧を読み直す）。 */
  onDone: (message: string, made: RepaperResult) => void;
  onClose: () => void;
  onOpenAgreement?: (id: number) => void;
  /** 新契約の契約書をひな形で作る（文書の画面へ）。無ければ出さない。 */
  onComposeContract?: (agreement: { id: number; label: string }, partyId: number, templateKey: string) => void;
  /** 引き継いだ条件明細で、条件書・発注書を作る（作業テーブルへ）。無ければ出さない。 */
  onComposeTerms?: (conditionIds: number[], templateKey?: string | null) => void;
}) {
  // 行き先は、渡されなければ App が配る道（mapLinks）を使う（契約の画面・表・工程表のどこから開いても同じ）。
  const links = useMapLinks();
  const onComposeContract = composeContractProp ?? links.composeContract;
  const onComposeTerms = composeTermsProp ?? links.composeTerms;
  const oldNo = target.agreementNo ?? `契約 #${target.id}`;
  const standalone = target.kind === "standalone";
  /** 新しい契約の形。単体契約のときだけ選べる：same＝単体契約のまま／master＝基本契約＋個別契約に切り替える。 */
  const [shape, setShape] = useState<"same" | "master">("same");
  const toMaster = standalone && shape === "master";
  /** 新契約が基本契約になる（基本契約の巻き直し、または単体契約からの切り替え）。種別を選べる。 */
  const resultMaster = toMaster || target.kind === "master";
  const [domain, setDomain] = useState<string>(target.domain ?? "");
  const [title, setTitle] = useState(target.title);
  const [no, setNo] = useState("");
  const [unsigned, setUnsigned] = useState(true);
  const [executedOn, setExecutedOn] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [reason, setReason] = useState("契約の巻き直し");
  const [carryOver, setCarryOver] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<RepaperResult | null>(null);
  /**
   * 何を巻き直すか。contract＝契約ごと（新しい契約を立てて置き換える）／terms＝条件書だけ（契約はそのまま、
   * 下の条件明細で新しい条件書を出す）。
   */
  const [scope, setScope] = useState<"contract" | "terms">(target.terms ? "terms" : "contract");
  // やり直し：この契約が、まだ締結していない巻き直し先のとき。新契約は元の旧契約を直接置き換える。
  const [redoOf, setRedoOf] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<RepaperLinks>(`/agreements/${target.id}/repaper`)
      .then((l) => { if (alive) setRedoOf(l.redo && l.replaces ? (l.replaces.agreementNo ?? `契約 #${l.replaces.id}`) : null); })
      .catch(() => { /* 出せなくても巻き直しは進められる */ });
    return () => { alive = false; };
  }, [target.id]);
  // 立てたあと：契約書のファイル
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);

  const ready = title.trim() !== "" && (unsigned || executedOn !== "") && (!resultMaster || domain !== "");
  /** 適用日（有効期間の開始。空なら締結日）が先。条件明細は移さず、適用日からの改訂として予約する。 */
  const startsOn = effectiveOn || (unsigned ? "" : executedOn);
  const forward = carryOver && !redoOf && startsOn !== "" && startsOn > todayStr();

  /**
   * 基本契約の種別を選ぶ（ライセンスの基本契約／業務委託の基本契約 …）。番号の頭と、基本契約書のひな形が決まる。
   * 件名が種別の既定（利用許諾基本契約 など）のままなら、選んだ種別の既定に合わせる。
   */
  function chooseDomain(next: string) {
    setDomain(next);
    if (Object.values(MASTER_TITLE).includes(title) && MASTER_TITLE[next]) setTitle(MASTER_TITLE[next]!);
  }

  /** 形を切り替えたら、件名の初期値を合わせる（単体契約の件名は「条件書（◯◯）」などで、基本契約の名前にならない）。 */
  function chooseShape(next: "same" | "master") {
    setShape(next);
    const masterTitle = MASTER_TITLE[domain] ?? "";
    if (next === "master" && (title === target.title || title === "") && masterTitle) setTitle(masterTitle);
    if (next === "same" && Object.values(MASTER_TITLE).includes(title)) setTitle(target.title);
  }

  async function go() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<RepaperResult>(`/agreements/${target.id}/repaper`, {
        title: title.trim(), agreementNo: no.trim() || null,
        executedOn: unsigned ? null : executedOn, effectiveOn: effectiveOn || null, expiresOn: expiresOn || null,
        reason: reason.trim() || null, carryOver,
        ...(toMaster ? { toMaster: true } : {}),
        // 基本契約の種別（ライセンス／業務委託 …）。旧契約と違う種別にもできる。
        ...(resultMaster && domain ? { domain } : {})
      });
      setMade(r);
      onDone(`${r.redo ? (r.oldNo ?? oldNo) : oldNo} を ${r.agreementNo ?? `#${r.id}`} で巻き直しました`
        + `${r.forward ? `（条件明細 ${r.forward.scheduled.length} 本を ${r.forward.on} からの改訂として予約）`
            : r.movedConditions || r.movedChildren ? `（条件明細 ${r.movedConditions} 本・個別契約 ${r.movedChildren} 本を引き継ぎ）` : ""}`, r);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  async function upload() {
    if (!made || !file) return;
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({
        title: title.trim() || target.title, documentKind: DOC_KIND[made.domain ?? ""] ?? "覚書",
        agreementId: String(made.id), filename: file.name, inbound: "0", sameNoAsAgreement: "1"
      });
      if (!unsigned && executedOn) params.set("receivedOn", executedOn);
      const doc = await api.postRaw<{ id: number; documentNo: string }>(`/documents/import?${params}`, file, file.type || "application/pdf");
      setUploaded(doc.documentNo);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (made) {
    const newNo = made.agreementNo ?? `契約 #${made.id}`;
    const isMaster = made.kind === "master";
    // 基本契約書のひな形は、新契約が基本契約のときだけ（単体契約の紙は条件書・発注書）。
    // ひな形は種別に合うものを先（主）に、もう一方も選べるように並べる（ハイブリッドはどちらも主）。
    const templates = isMaster
      ? Object.entries(MASTER_TEMPLATE)
          .map(([d, t]) => ({ ...t, primary: made.domain === d || made.domain === "hybrid" }))
          .sort((a, b) => Number(b.primary) - Number(a.primary))
      : [];
    const switched = standalone && isMaster;
    const termsReady = Boolean(onComposeTerms) && made.conditionIds.length > 0;
    // 適用日が先：予約した版で条件書を作る（基本契約の巻き直しでも、個別契約を新しく立てる）。
    const forwardTerms = Boolean(made.forward && made.forward.scheduled.length > 0);
    // やり直しのときの旧契約は、元の旧契約（途中の契約ではない）。
    const replacedNo = made.redo ? (made.oldNo ?? oldNo) : oldNo;
    return (
      <Modal title={`${newNo} を立てました（${replacedNo} の巻き直し）`} onClose={onClose}>
        <div className="stack" style={{ gap: 10 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>新契約：<span className="code">{newNo}</span>（{isMaster ? "基本契約" : "単体契約"}・{made.oldClosed ? "締結済み" : "交渉中"}）</li>
            {made.redo && (
              <li>やり直し：<span className="code">{made.redo.agreementNo ?? oldNo}</span> は{made.redo.removed
                ? "、何も載っていなかったので消しました"
                : "、文書などが載っているので残しました（巻き直しのつながりだけ外しています）"}。新契約が <span className="code">{replacedNo}</span> を直接置き換えます。</li>
            )}
            <li>旧契約 <span className="code">{replacedNo}</span>：{made.oldClosed
              ? "終了にしました（置き換え済み）"
              : "まだ有効です。新契約を締結済みにした時点で終了（置き換え済み）になります"}</li>
            {made.forward
              ? <ForwardSummary forward={made.forward} />
              : <li>引き継ぎ：条件明細 {made.movedConditions} 本・個別契約 {made.movedChildren} 本{!made.movedConditions && !made.movedChildren ? "（移すものはありませんでした）" : ""}</li>}
            {made.forward && made.forward.scheduled.length > 0 && (
              <li>予約した版は、いったん新しい{isMaster ? "基本契約" : "契約"}に載せました{isMaster ? "（個別契約待ち）。下の ② で条件書を決定すると、新しい番号の個別契約が基本契約の下に立ち" : "。下で条件書を作ると"}、許諾開始日は {made.forward.on} になります。</li>
            )}
            {switched && made.movedConditions > 0 && (
              <li>条件明細は、いったん新しい基本契約に載せました（個別契約待ち）。下の ② で条件書・発注書を決定すると、新しい番号の個別契約が基本契約の下に立ちます。</li>
            )}
          </ul>
          <b>{switched || forwardTerms ? "① 新しい基本契約書を用意します" : "次に、新しい契約書を用意します"}</b>
          {uploaded ? <div className="note ok">契約書 {uploaded} を登録しました</div> : (
            <div className="stack" style={{ gap: 6 }}>
              <label className="fld"><span>作成済みの契約書（PDF など）を上げる</span>
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <small>文書番号は新契約の番号（{newNo}）と同じになります</small></label>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="btn" disabled={busy || !file} onClick={() => void upload()}>{busy ? "登録しています…" : "上げて登録する"}</button>
                {onComposeContract && templates.map((t) => (
                  <button key={t.key} className={`btn${t.primary ? " primary" : ""}`} disabled={busy}
                          title={t.primary ? undefined : "この契約の種別とは別のひな形です。こちらの書式で作るときに"}
                          onClick={() => { onClose(); onComposeContract({ id: made.id, label: newNo }, target.partyId, t.key); }}>
                    ひな形で作る（{t.label}）</button>
                ))}
              </div>
            </div>
          )}
          {(switched || !isMaster || forwardTerms) && termsReady && (
            <div className="stack" style={{ gap: 6 }}>
              <b>{switched || forwardTerms ? "② 個別契約（条件書・発注書）を作ります" : "条件書・発注書を作り直すとき"}</b>
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button className={`btn${switched || forwardTerms ? " primary" : ""}`} disabled={busy}
                        onClick={() => { onClose(); onComposeTerms!(made.conditionIds); }}>
                  条件書・発注書を作る（作業テーブルへ・{made.forward ? `${made.forward.on} からの版` : "条件"} {made.conditionIds.length} 本）</button>
                {(switched || forwardTerms) && <small className="faint">基本契約書を先に済ませても、あとからでも作れます（条件明細の画面・作業テーブルから）</small>}
              </div>
            </div>
          )}
          {error && <div className="alert">{error}</div>}
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            {onOpenAgreement && <button className="btn" onClick={() => { onClose(); onOpenAgreement(made.id); }}>新契約を開く</button>}
            <button className="btn" onClick={onClose}>閉じる</button>
          </div>
        </div>
      </Modal>
    );
  }

  const scopeChooser = (
    <div className="fld">
      <span>何を巻き直しますか</span>
      <div className="chips" role="radiogroup" aria-label="何を巻き直すか">
        <button type="button" className="chip" role="radio" aria-checked={scope === "contract"} aria-pressed={scope === "contract"}
                onClick={() => setScope("contract")}>{standalone ? "契約ごと" : "基本契約ごと"}（新しい契約を立てる）</button>
        <button type="button" className="chip" role="radio" aria-checked={scope === "terms"} aria-pressed={scope === "terms"}
                onClick={() => setScope("terms")}>条件書だけ（{standalone ? "契約" : "基本契約"}はそのまま）</button>
      </div>
    </div>
  );
  if (scope === "terms") {
    return (
      <Modal title={`${oldNo} の条件書を巻き直す（${standalone ? "契約" : "基本契約"}はそのまま）`} onClose={onClose} wide>
        <div className="stack" style={{ gap: 10 }}>
          {scopeChooser}
          <TermsRepaper target={target} onClose={onClose} onComposeTerms={onComposeTerms} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`${oldNo} を巻き直す（新しい契約で置き換える）`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        {scopeChooser}
        {redoOf && (
          <div className="note" role="note">
            <b>やり直しになります。</b>この契約（<span className="code">{oldNo}</span>）は、<span className="code">{redoOf}</span> の巻き直し先で、まだ締結していません。
            巻き直すと、新しい契約が <span className="code">{redoOf}</span> を直接置き換え、この契約は（文書が載っていなければ）消します。
            種別や番号を選び直すときに使います。
          </div>
        )}
        <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>
          <li>新しい契約を立てます（{toMaster ? "基本契約として。向き・相手先はいまの契約と同じ" : "種類・種別・向き・相手先はいまの契約と同じ"}）。</li>
          <li>いまの契約は、新契約を締結済みにした時点で終了（置き換え済み）になります。それまでは有効のままです。</li>
          <li>いまの契約の文書・実績・支払は、いまの契約に残ります。</li>
        </ul>
        {standalone && (
          <div className="fld">
            <span>新しい契約の形</span>
            <div className="chips" role="radiogroup" aria-label="新しい契約の形">
              <button type="button" className="chip" role="radio" aria-checked={shape === "same"} aria-pressed={shape === "same"}
                      onClick={() => chooseShape("same")}>単体契約のまま（1 通で定める）</button>
              <button type="button" className="chip" role="radio" aria-checked={shape === "master"} aria-pressed={shape === "master"}
                      onClick={() => chooseShape("master")}>基本契約＋個別契約に切り替える</button>
            </div>
            {toMaster && (
              <small>新しい基本契約を立て、条件明細を引き継ぎます。続けて条件書・発注書を決定すると、新しい番号の個別契約が基本契約の下に立ちます。</small>
            )}
          </div>
        )}
        {resultMaster && (
          <div className="fld">
            <span>基本契約の種類 <em>必須</em></span>
            <div className="chips" role="radiogroup" aria-label="基本契約の種類">
              {DOMAIN_OPTIONS.map(([v, label]) => (
                <button key={v} type="button" className="chip" role="radio" aria-checked={domain === v} aria-pressed={domain === v}
                        onClick={() => chooseDomain(v)}>{v === "license" ? "ライセンスの基本契約" : v === "service" ? "業務委託の基本契約" : label}</button>
              ))}
            </div>
            <small>番号の頭と、基本契約書のひな形（利用許諾基本契約書／業務委託基本契約書）がこれで決まります{target.domain && domain && domain !== target.domain ? "。いまの契約とは別の種類で立てます" : ""}</small>
          </div>
        )}
        <div className="grid4">
          <label className="fld"><span>{toMaster ? "新しい基本契約の件名" : "新契約の件名"} <em>必須</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="fld"><span>{toMaster ? "基本契約の番号" : "新契約の番号"}</span>
            <input value={no} onChange={(e) => setNo(e.target.value)} placeholder="空なら自動" />
            <small>{no.trim() ? `${no.trim()} で立てます` : "新しい番号を取ります"}</small></label>
          <label className="fld"><span>締結日 {!unsigned && <em>必須</em>}</span>
            <input type="date" value={unsigned ? "" : executedOn} disabled={unsigned} onChange={(e) => setExecutedOn(e.target.value)} />
            <label className="row" style={{ gap: 4, marginTop: 4 }}>
              <input type="checkbox" checked={unsigned} onChange={(e) => setUnsigned(e.target.checked)} />
              <small>まだ締結していない（これから契約書を送る）</small>
            </label></label>
          <label className="fld"><span>有効期間の開始</span>
            <input type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
            <small>空なら締結日。いまの契約の終了日はこの日になります</small></label>
          <label className="fld"><span>有効期間の終了</span>
            <input type="date" value={expiresOn} min={startsOn || undefined} onChange={(e) => setExpiresOn(e.target.value)} />
            <small>空なら期間の定めなし{forward ? "（予約する条件明細の終了日も空になります）" : ""}</small></label>
        </div>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={carryOver} onChange={(e) => setCarryOver(e.target.checked)} />
          <span>{toMaster
            ? "いまの契約の条件明細（と下の覚書）を新しい基本契約に引き継ぐ"
            : "いまの契約の条件明細と、下の個別契約（条件書・発注書）を新契約に引き継ぐ"}</span>
        </label>
        {forward ? (
          <div className="note" role="note">
            <b>適用日が先（{startsOn}）なので、条件明細は移しません。</b>
            いま有効な条件明細について、<b>{startsOn} からの改訂</b>を新しい{toMaster || !standalone ? "基本契約" : "契約"}に予約します
            （開始日は {startsOn}、終了日は{expiresOn ? ` ${expiresOn}` : "上の「有効期間の終了」"}。料率などはそのまま）。
            いまの版と下の個別契約・発注書は旧契約に残り、{startsOn} までの計算は変わりません。
            予約した版で条件書を作ると、許諾開始日が {startsOn} になります。
          </div>
        ) : (
          <small className="faint">引き継ぐと、条件書・発注書・計算書は新しい{toMaster || !standalone ? "基本契約" : "契約"}の名前で出ます。番号・料率・期間・これまでの実績は変わりません。</small>
        )}
        <label className="fld"><span>理由（履歴に残ります）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：2026年12月に契約書式を改め、巻き直した" /></label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
          <button className="btn primary" disabled={busy || !ready} onClick={() => void go()}>{busy ? "立てています…" : toMaster ? "新しい基本契約を立てる" : "新契約を立てる"}</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 条件書だけの巻き直し（基本契約はそのまま）。
 *
 * 契約（と下の個別契約）に載っている条件明細を選び、新しい条件書を出し直す。契約ごとの巻き直しと同じく、
 * 適用日が先なら、選んだ条件明細を「適用日からの改訂」として予約し、その版で条件書を作る
 * （いまの版は適用日まで有効）。適用日が空・今日以前なら、条件明細は変えず、紙だけ出し直す。
 * 出版の条件が 2 作品以上なら、作品ごとに番号を持つ条件書 1 枚にまとめる（決定すると旧条件書は差し替え済みになる）。
 */
function TermsRepaper({ target, onClose, onComposeTerms }: {
  target: RepaperTarget; onClose: () => void;
  onComposeTerms?: (conditionIds: number[], templateKey?: string | null) => void;
}) {
  const mapLinks = useMapLinks();
  const [plan, setPlan] = useState<TermsRepaperPlan | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [effectiveOn, setEffectiveOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [reason, setReason] = useState("条件書の巻き直し");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TermsRepaperResult | null>(null);
  const [drafts, setDrafts] = useState<Record<number, number>>({});
  useEffect(() => {
    let alive = true;
    api.get<TermsRepaperPlan>(`/agreements/${target.id}/repaper/terms`)
      .then((p) => {
        if (!alive) return;
        setPlan(p);
        // 個別契約から開いたときは、その個別契約の条件だけを選んでおく（無ければすべて）。
        const mine = target.terms ? p.conditions.filter((c) => c.holderId === target.terms!.holderId) : [];
        setPicked(new Set((mine.length ? mine : p.conditions).map((c) => c.id)));
      })
      .catch((e) => { if (alive) setError((e as ApiError).message); });
    return () => { alive = false; };
  }, [target.id, target.terms?.holderId]);

  if (!plan) return error ? <div className="alert">{error}</div> : <div className="faint">読み込んでいます…</div>;
  const forward = effectiveOn !== "" && effectiveOn > plan.today;
  const chosen = plan.conditions.filter((c) => picked.has(c.id));
  const works = new Set(chosen.map((c) => c.workId ?? `c${c.id}`)).size;
  const toggle = (id: number) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** 個別契約ごとにまとめて選ぶ・外す。 */
  const holders = [...new Map(plan.conditions.map((c) => [c.holderId, c])).values()];
  const toggleHolder = (holderId: number) => {
    const ids = plan.conditions.filter((c) => c.holderId === holderId).map((c) => c.id);
    const all = ids.every((id) => picked.has(id));
    setPicked((prev) => { const n = new Set(prev); for (const id of ids) { if (all) n.delete(id); else n.add(id); } return n; });
  };

  async function go() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<TermsRepaperResult>(`/agreements/${target.id}/repaper/terms`, {
        conditionIds: [...picked], effectiveOn: effectiveOn || null, expiresOn: forward ? (expiresOn || null) : null,
        reason: reason.trim() || null
      });
      setResult(r);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  async function revise(paper: TermsRepaperResult["papers"][number]) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${paper.id}/reissue`,
        { reason: reason.trim() || "条件書の巻き直し", conditionIds: paper.conditionIds });
      setDrafts((d) => ({ ...d, [paper.id]: r.id }));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (result) {
    const n = result.conditionIds.length;
    return (
      <div className="stack" style={{ gap: 10 }}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {result.forward
            ? <ForwardSummary forward={result.forward} />
            : <li>条件明細は変えていません。選んだ {n} 本のまま、条件書を出し直します。</li>}
        </ul>
        <b>次に、新しい条件書を作ります</b>
        {onComposeTerms && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn primary" disabled={busy}
                    onClick={() => { onClose(); onComposeTerms(result.conditionIds, result.templateKey); }}>
              {result.templateKey
                ? `1 枚の条件書にまとめて作る（作品ごとに番号・条件 ${n} 本）`
                : `条件書を作る（作業テーブルへ・条件 ${n} 本）`}</button>
            <small className="faint">
              条件 {n} 本を載せた状態で作業テーブルが開きます
              {result.templateKey ? "。決定すると、載せた作品の旧条件書は自動で「差し替え済み」になり、作品ごとの番号はそのまま残ります" : ""}
            </small>
          </div>
        )}
        {result.papers.length > 0 && result.papers.length <= 5 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="faint">または、いまの条件書の訂正版として出す（元の条件書は決定で「訂正済み」。番号は、作品ごとに番号の条件書なら新しい番号、それ以外は元の番号に -R2）：</span>
            {result.papers.map((paper) => {
              const draftId = drafts[paper.id];
              return (
                <div key={paper.id} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="code">{paper.documentNo ?? `#${paper.id}`}</span>
                  <span className="faint">{paper.label}・条件 {paper.conditionIds.length} 本</span>
                  {draftId
                    ? (mapLinks.document
                        ? <button className="btn" onClick={() => { onClose(); mapLinks.document!(draftId); }}>訂正版の下書き（#{draftId}）を開く</button>
                        : <span>訂正版の下書き（#{draftId}）を作りました（文書の画面で開けます）</span>)
                    : <button className="btn" disabled={busy} onClick={() => void revise(paper)}>訂正版を作る</button>}
                </div>
              );
            })}
          </div>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>閉じる</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>
        <li>契約はそのままです。下の条件明細を選んで、新しい条件書を出し直します。</li>
        {target.terms && (
          <li><span className="code">{target.terms.holderNo ?? `#${target.terms.holderId}`}</span> の条件明細だけを選んであります。
            同じ基本契約のほかの作品も一緒に出し直すなら、チェックを足してください。</li>
        )}
        <li>適用日を先の日付にすると、選んだ条件明細を「適用日からの改訂」として予約し、その版で条件書を作ります（いまの版は適用日まで有効）。</li>
        <li>適用日が空・今日以前なら、条件明細は変えません（紙だけ出し直します）。</li>
      </ul>
      <div className="grid4">
        <label className="fld"><span>適用日</span>
          <input type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
          <small>{forward ? `${effectiveOn} からの改訂を予約します` : "空なら、条件明細はそのまま"}</small></label>
        <label className="fld"><span>新しい期間の終了</span>
          <input type="date" value={forward ? expiresOn : ""} disabled={!forward} min={effectiveOn || undefined}
                 onChange={(e) => setExpiresOn(e.target.value)} />
          <small>{forward ? "空なら、いまの終了日（適用日より後まで続くとき）" : "適用日が先のときだけ"}</small></label>
        <label className="fld" style={{ gridColumn: "span 2" }}><span>理由（履歴に残ります）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b>載せる条件明細</b>
        <span className="faint">{chosen.length} 本を選択（{works} 作品）／全 {plan.conditions.length} 本</span>
        <button className="btn btn-sm" onClick={() => setPicked(new Set(plan.conditions.map((c) => c.id)))}>すべて選ぶ</button>
        <button className="btn btn-sm" onClick={() => setPicked(new Set())}>すべて外す</button>
      </div>
      {plan.conditions.length === 0
        ? <div className="note">この契約の下に、いま有効なライセンスの条件明細がありません。</div>
        : (
          <div className="tablewrap" style={{ maxHeight: 320, overflow: "auto" }}>
            <table>
              <thead><tr><th></th><th>個別契約</th><th>条件番号</th><th>条件名</th><th>期間</th><th>料率</th><th></th></tr></thead>
              <tbody>
                {holders.map((h) => {
                  const rows = plan.conditions.filter((c) => c.holderId === h.holderId);
                  return rows.map((c, i) => (
                    <tr key={c.id}>
                      <td><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`${c.conditionNo ?? c.id} を載せる`} /></td>
                      <td>{i === 0 && (
                        <button className="linky code" title="この契約の条件をまとめて選ぶ・外す" onClick={() => toggleHolder(h.holderId)}>
                          {c.onMaster ? "（契約に直接）" : c.holderNo ?? `#${c.holderId}`}</button>
                      )}</td>
                      <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                      <td>{c.name}</td>
                      <td className="faint">{c.termStart ?? "—"} 〜 {c.termEnd ?? "期限なし"}</td>
                      <td className="faint">{c.ratePpm !== null ? `${c.ratePpm / 10000}%` : "—"}</td>
                      <td>{c.pendingOn && <span className="tag" title="この条件明細には、もう改訂が予約されています">{c.pendingOn} の改訂あり</span>}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        )}
      {plan.papers.length > 0 && (
        <small className="faint">
          いまの条件書：{plan.papers.slice(0, 8).map((d) => d.documentNo ?? `#${d.id}`).join("・")}{plan.papers.length > 8 ? ` ほか ${plan.papers.length - 8} 枚` : ""}
        </small>
      )}
      {error && <div className="alert">{error}</div>}
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
        <button className="btn primary" disabled={busy || chosen.length === 0} onClick={() => void go()}>
          {busy ? "用意しています…" : forward ? `${effectiveOn} からの改訂を予約して、条件書の作成へ` : "条件書の作成へ"}</button>
      </div>
    </div>
  );
}

/** 巻き直しのつながり（旧 → 新）。209 を流していなければ何も出さない。 */
export function RepaperLinksNote({ agreementId, version = 0, onOpen, onChanged, onComposeTerms: composeTermsProp }: {
  agreementId: number; version?: number; onOpen?: (id: number) => void;
  /** あとから合わせた（一覧・詳細を読み直す）。 */
  onChanged?: (message: string) => void;
  onComposeTerms?: (conditionIds: number[]) => void;
}) {
  const mapLinks = useMapLinks();
  const onComposeTerms = composeTermsProp ?? mapLinks.composeTerms;
  const [links, setLinks] = useState<RepaperLinks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aligned, setAligned] = useState<AlignResult | null>(null);
  const [tick, setTick] = useState(0);
  /** 作った訂正版の下書き（元の条件書 → 下書き）。 */
  const [drafts, setDrafts] = useState<Record<number, number>>({});
  useEffect(() => {
    let alive = true;
    setLinks(null);
    api.get<RepaperLinks>(`/agreements/${agreementId}/repaper`)
      .then((r) => { if (alive) setLinks(r); })
      .catch(() => { if (alive) setLinks(null); });
    return () => { alive = false; };
  }, [agreementId, version, tick]);
  useEffect(() => { setAligned(null); setError(null); setDrafts({}); }, [agreementId]);
  if (!links?.available || (!links.replaces && !links.replacedBy)) return null;
  const ref = (r: NonNullable<RepaperLinks["replaces"]>) => onOpen
    ? <button className="linky code" onClick={() => onOpen(r.id)}>{r.agreementNo ?? `#${r.id}`}</button>
    : <span className="code">{r.agreementNo ?? `#${r.id}`}</span>;
  const papers = links.papers ?? [];
  const ended = (on: string) => on > todayStr() ? `旧契約は ${on} で終了の予定` : `旧契約は ${on} で終了`;
  async function align() {
    if (!links?.align) return;
    if (!window.confirm(`この契約の下にある条件明細 ${links.align.count} 本を、${links.align.on} からの改訂にします。\n`
      + `・${links.align.on} からの版を予約します（開始日 ${links.align.on}。終了日はこの契約の有効期間の終了）\n`
      + "・いまの版は旧契約へ戻します（適用日までの計算は変わりません）\nよろしいですか？")) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<AlignResult>(`/agreements/${agreementId}/repaper/align`, {});
      setAligned(r); setTick((n) => n + 1);
      onChanged?.(`条件明細 ${r.forward.scheduled.length} 本を ${r.on} からの改訂として予約しました`);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  /** いまの版のまま決定していた条件書の訂正版を、適用日からの版で起こす（下書き。決定は文書の画面で）。 */
  async function revise(paper: StalePaper) {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${paper.id}/reissue`,
        { reason: `適用日を ${paper.on} に（契約の巻き直し）`, conditionIds: paper.conditionIds });
      setDrafts((d) => ({ ...d, [paper.id]: r.id }));
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="note stack" style={{ gap: 6 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span className="tag">巻き直し</span>
        {links.replaces && <span>旧契約 {ref(links.replaces)} を置き換えた契約です{links.replaces.terminatedOn ? `（${ended(links.replaces.terminatedOn)}）` : "（旧契約はまだ有効。この契約を締結済みにすると終了になります）"}</span>}
        {links.replacedBy && <span>この契約は {ref(links.replacedBy)} で巻き直しています{links.replacedBy.status === "executed" ? "（置き換え済み）" : "（新契約は未締結。締結済みになるとこの契約は終了になります）"}</span>}
      </div>
      {links.align && !aligned && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span>適用日は {links.align.on}（先の日付）ですが、いま有効な条件明細 {links.align.count} 本がこの契約の下に載っています。</span>
          <button className="btn" disabled={busy} onClick={() => void align()}>
            {busy ? "予約しています…" : `条件明細を ${links.align.on} からの改訂にする`}</button>
        </div>
      )}
      {aligned && (
        <div className="stack" style={{ gap: 6 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <ForwardSummary forward={aligned.forward} />
          </ul>
          {onComposeTerms && aligned.conditionIds.length > 0 && papers.length === 0 && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn primary" onClick={() => onComposeTerms(aligned.conditionIds)}>
                条件書を作る（作業テーブルへ・{aligned.on} からの版 {aligned.conditionIds.length} 本）</button>
              <small className="faint">許諾開始日が {aligned.on} の条件書になります</small>
            </div>
          )}
        </div>
      )}
      {/* いまの版のまま決定していた条件書は、訂正版にする（同じ個別契約のまま）。予約がある限り出し続ける。 */}
      {papers.map((paper) => {
        const draftId = drafts[paper.id] ?? paper.draftId;
        return (
          <div key={paper.id} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {draftId ? (
              <>
                <span>条件書 <span className="code">{paper.documentNo ?? `#${paper.id}`}</span> の訂正版の下書き（#{draftId}）があります。</span>
                {mapLinks.document && <button className="btn primary" onClick={() => mapLinks.document!(draftId)}>下書きを開く（確かめて決定する）</button>}
              </>
            ) : (
              <>
                <span>条件書 <span className="code">{paper.documentNo ?? `#${paper.id}`}</span> は、いまの版（{paper.on} より前の開始日）のまま決定しています。</span>
                <button className="btn primary" disabled={busy} onClick={() => void revise(paper)}>
                  訂正版を作る（{paper.on} からの版 {paper.conditionIds.length} 本）</button>
              </>
            )}
            <small className="faint">許諾開始日が {paper.on} の条件書になります。決定すると、元の条件書は「訂正済み」になります</small>
          </div>
        );
      })}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
