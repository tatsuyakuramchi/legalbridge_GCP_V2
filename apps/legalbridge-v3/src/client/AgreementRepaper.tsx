import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import type { RepaperLinks, RepaperResult } from "../server/agreements/service.js";

/**
 * 契約の巻き直し（infra/v3/209_agreement_repaper.sql）。
 *
 * いまの基本契約・単体契約を、新しい契約で置き換える。新契約を立て、旧契約に載っている条件明細と
 * 下の個別契約を新契約へ引き継ぐ。旧契約は、新契約が締結済みになった時点で終了になる
 * （未締結のあいだは有効のまま）。旧契約の文書・実績・支払は旧契約に残る。
 * 立てたあとは、新しい契約書を「ファイルを上げる」か「ひな形で作る」。
 */

export interface RepaperTarget {
  id: number; agreementNo: string | null; title: string;
  kind: string; domain: string | null; partyId: number;
}

/** 種別ごとの基本契約書のひな形（無い種別はファイルを上げる）。 */
const MASTER_TEMPLATE: Record<string, { key: string; label: string }> = {
  license: { key: "license_master", label: "利用許諾基本契約書" },
  service: { key: "service_master", label: "業務委託基本契約書" }
};
const DOC_KIND: Record<string, string> = {
  license: "利用許諾契約書", service: "業務委託契約書", hybrid: "業務委託・利用許諾契約書", sale: "売買契約書"
};

export function RepaperDialog({ target, onDone, onClose, onOpenAgreement, onComposeContract }: {
  target: RepaperTarget;
  /** 巻き直した（一覧を読み直す）。 */
  onDone: (message: string, made: RepaperResult) => void;
  onClose: () => void;
  onOpenAgreement?: (id: number) => void;
  /** 新契約の契約書をひな形で作る（文書の画面へ）。無ければ出さない。 */
  onComposeContract?: (agreement: { id: number; label: string }, partyId: number, templateKey: string) => void;
}) {
  const oldNo = target.agreementNo ?? `契約 #${target.id}`;
  const [title, setTitle] = useState(target.title);
  const [no, setNo] = useState("");
  const [unsigned, setUnsigned] = useState(true);
  const [executedOn, setExecutedOn] = useState("");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [reason, setReason] = useState("契約の巻き直し");
  const [carryOver, setCarryOver] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<RepaperResult | null>(null);
  // 立てたあと：契約書のファイル
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);

  const template = MASTER_TEMPLATE[target.domain ?? ""] ?? null;
  const ready = title.trim() !== "" && (unsigned || executedOn !== "");

  async function go() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<RepaperResult>(`/agreements/${target.id}/repaper`, {
        title: title.trim(), agreementNo: no.trim() || null,
        executedOn: unsigned ? null : executedOn, effectiveOn: effectiveOn || null,
        reason: reason.trim() || null, carryOver
      });
      setMade(r);
      onDone(`${oldNo} を ${r.agreementNo ?? `#${r.id}`} で巻き直しました`
        + `${r.movedConditions || r.movedChildren ? `（条件明細 ${r.movedConditions} 本・個別契約 ${r.movedChildren} 本を引き継ぎ）` : ""}`, r);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  async function upload() {
    if (!made || !file) return;
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({
        title: title.trim() || target.title, documentKind: DOC_KIND[target.domain ?? ""] ?? "覚書",
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
    return (
      <Modal title={`${newNo} を立てました（${oldNo} の巻き直し）`} onClose={onClose}>
        <div className="stack" style={{ gap: 10 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>新契約：<span className="code">{newNo}</span>（{made.oldClosed ? "締結済み" : "交渉中"}）</li>
            <li>旧契約 <span className="code">{oldNo}</span>：{made.oldClosed
              ? "終了にしました（置き換え済み）"
              : "まだ有効です。新契約を締結済みにした時点で終了（置き換え済み）になります"}</li>
            <li>引き継ぎ：条件明細 {made.movedConditions} 本・個別契約 {made.movedChildren} 本{!made.movedConditions && !made.movedChildren ? "（移すものはありませんでした）" : ""}</li>
          </ul>
          <b>次に、新しい契約書を用意します</b>
          {uploaded ? <div className="note ok">契約書 {uploaded} を登録しました</div> : (
            <div className="stack" style={{ gap: 6 }}>
              <label className="fld"><span>作成済みの契約書（PDF など）を上げる</span>
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <small>文書番号は新契約の番号（{newNo}）と同じになります</small></label>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="btn" disabled={busy || !file} onClick={() => void upload()}>{busy ? "登録しています…" : "上げて登録する"}</button>
                {template && onComposeContract && (
                  <button className="btn primary" disabled={busy}
                          onClick={() => { onClose(); onComposeContract({ id: made.id, label: newNo }, target.partyId, template.key); }}>
                    ひな形で作る（{template.label}）</button>
                )}
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

  return (
    <Modal title={`${oldNo} を巻き直す（新しい契約で置き換える）`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>
          <li>新しい契約を立てます（種類・種別・向き・相手先はいまの契約と同じ）。</li>
          <li>いまの契約は、新契約を締結済みにした時点で終了（置き換え済み）になります。それまでは有効のままです。</li>
          <li>いまの契約の文書・実績・支払は、いまの契約に残ります。</li>
        </ul>
        <div className="grid4">
          <label className="fld"><span>新契約の件名 <em>必須</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="fld"><span>新契約の番号</span>
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
        </div>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={carryOver} onChange={(e) => setCarryOver(e.target.checked)} />
          <span>いまの契約の条件明細と、下の個別契約（条件書・発注書）を新契約に引き継ぐ</span>
        </label>
        <small className="faint">引き継ぐと、条件書・発注書・計算書は新しい基本契約の名前で出ます。番号・料率・期間・これまでの実績は変わりません。</small>
        <label className="fld"><span>理由（履歴に残ります）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：2026年12月に契約書式を改め、巻き直した" /></label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
          <button className="btn primary" disabled={busy || !ready} onClick={() => void go()}>{busy ? "立てています…" : "新契約を立てる"}</button>
        </div>
      </div>
    </Modal>
  );
}

/** 巻き直しのつながり（旧 → 新）。209 を流していなければ何も出さない。 */
export function RepaperLinksNote({ agreementId, version = 0, onOpen }: {
  agreementId: number; version?: number; onOpen?: (id: number) => void;
}) {
  const [links, setLinks] = useState<RepaperLinks | null>(null);
  useEffect(() => {
    let alive = true;
    setLinks(null);
    api.get<RepaperLinks>(`/agreements/${agreementId}/repaper`)
      .then((r) => { if (alive) setLinks(r); })
      .catch(() => { if (alive) setLinks(null); });
    return () => { alive = false; };
  }, [agreementId, version]);
  if (!links?.available || (!links.replaces && !links.replacedBy)) return null;
  const ref = (r: NonNullable<RepaperLinks["replaces"]>) => onOpen
    ? <button className="linky code" onClick={() => onOpen(r.id)}>{r.agreementNo ?? `#${r.id}`}</button>
    : <span className="code">{r.agreementNo ?? `#${r.id}`}</span>;
  return (
    <div className="note" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <span className="tag">巻き直し</span>
      {links.replaces && <span>旧契約 {ref(links.replaces)} を置き換えた契約です{links.replaces.terminatedOn ? `（旧契約は ${links.replaces.terminatedOn} で終了）` : "（旧契約はまだ有効。この契約を締結済みにすると終了になります）"}</span>}
      {links.replacedBy && <span>この契約は {ref(links.replacedBy)} で巻き直しています{links.replacedBy.status === "executed" ? "（置き換え済み）" : "（新契約は未締結。締結済みになるとこの契約は終了になります）"}</span>}
    </div>
  );
}
