import { useState } from "react";
import { DOCUMENT_STATE_NOTE, StatusTag } from "./labels.js";
import { Relations, type EntityKind } from "./Relations.js";
import { DocumentEvents } from "./DocumentEvents.js";

/**
 * 文書1件の詳細。
 *
 * これまで一覧の行にボタンが7つ並んでいて、その状態でできないものも混ざって
 * いた（発行済みに「編集」が出るなど）。状態ごとに、いまできることだけを出す。
 *
 * 差し替えは版の連鎖として見せる。以前は状態に「差し替え済み」と出るだけで、
 * 何に差し替わったのかが画面のどこにも無かった。
 */

export interface DocumentRow {
  id: number; documentNo: string | null; status: string; templateLabel: string | null;
  title: string | null; counterparty: string | null;
  conditionCount: number;
  conditions: Array<{ id: number; conditionNo: string | null }>;
  matterId: number | null; matterNo: string | null;
  supersedesId: number | null;
  supersededById: number | null; supersededByNo: string | null;
  issuedAt: string | null; storageUrl: string | null;
  imported: boolean;
  /** 人が見る段階。下書き → 決定済み → 送信済み（退いた版・無効はそのまま）。 */
  phase: "draft" | "decided" | "sent" | "superseded" | "void";
  sentAt: string | null;
  sentVia: "gmail" | "cloudsign" | null;
}

export interface TemplateOption { templateKey: string; label: string; category: string | null }

interface Integrations {
  drive: { documents: boolean; matterFolders: boolean };
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

/** 版の連鎖の中から文書番号を引く。番号の無い版は id で呼ぶ。 */
const byNo = (versions: DocumentRow[], id: number) =>
  versions.find((v) => v.id === id)?.documentNo ?? `#${id}`;

export function DocumentDetail(
  { doc, versions, templates, integrations, busy, onOpen, onChanged, onLinkCondition, openConditions,
    onEditDraft, onIssueDraft, onReissue, onDerive, onVoid, onStore, onSend, onSelect }: {
    doc: DocumentRow;
    /** 「下敷きに次を作る」で選べるひな形。 */
    templates: TemplateOption[];
    /** 古い順に並べた版の連鎖。1件だけなら履歴は出さない。 */
    versions: DocumentRow[];
    integrations: Integrations | null;
    busy: boolean;
    onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: () => void;
    onEditDraft: (id: number) => void;
    onIssueDraft: (id: number) => void;
    onReissue: (id: number, no: string | null) => void;
    /** この文書を下敷きに、別の（または同じ）ひな形で次の下書きを作る。 */
    onDerive: (id: number, templateKey: string) => void;
    onVoid: (id: number, no: string | null) => void;
    onStore: (id: number) => void;
    onSend: (id: number) => void;
    onSelect: (id: number) => void;
    /** 「つながり」の条件明細の欄を開く。 */
    onLinkCondition: () => void;
    /** 開いた状態で描く（上の案内から押されたとき）。 */
    openConditions?: boolean;
  }
) {
  const note = DOCUMENT_STATE_NOTE[doc.phase] ?? { headline: doc.status, detail: "" };
  const canSend = integrations?.channels.some((c) =>
    (c.channel === "gmail" || c.channel === "cloudsign") && c.mode !== "off");
  // 「下敷きに次を作る」のひな形を選んでいる最中。
  const [deriving, setDeriving] = useState(false);
  const [deriveKey, setDeriveKey] = useState("");
  const pickable = templates.filter((t) => t.category !== "partial");
  // この版を直している最中の下書き。あるあいだは、もう1枚作らせない
  // （発行できるのは1枚だけなので、残りは行き場が無くなる）。
  const pending = versions.find((v) => v.supersedesId === doc.id && v.status === "draft") ?? null;
  // 条件明細が繋がっていない。書類は条件の出力物なので、繋がっていないと
  // 「何の取引から出た紙か」が分からない。移行してきた文書はほぼこの状態。
  const unlinked = doc.conditions.length === 0;

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-hd">
          <h2 className="code">{doc.documentNo ?? "（未決定）"}</h2>
          <span className="tag">{doc.templateLabel ?? "種別なし"}</span>
          <StatusTag kind="document" value={doc.phase} />
          {doc.imported && <span className="tag">取込</span>}
        </div>
        <div className="panel-bd stack">
          <div className={`state ${doc.phase}`}>
            <span className="mark" />
            <span className="txt">
              <b>{note.headline}</b>
              <span>
                {note.detail}
                {doc.phase === "sent" && doc.sentAt && (
                  <>　最後に送ったのは {day(doc.sentAt)}（{doc.sentVia === "cloudsign" ? "CloudSign" : "メール"}）。</>
                )}
                {doc.status === "superseded" && doc.supersededByNo && (
                  <>　現行は <b className="code">{doc.supersededByNo}</b> です。</>
                )}
              </span>
            </span>
          </div>

          {/* 状態ごとに、できることだけを出す。 */}
          <div className="row">
            {doc.status === "draft" && !doc.imported && (<>
              <button className="btn primary" disabled={busy}
                      onClick={() => onEditDraft(doc.id)}>中身を直す</button>
              <button className="btn" disabled={busy}
                      onClick={() => onIssueDraft(doc.id)}>
                {doc.supersedesId ? "訂正版として決定する" : "決定する"}
              </button>
              <button className="btn" disabled={busy}
                      onClick={() => onVoid(doc.id, doc.documentNo)}>破棄する</button>
            </>)}

            {doc.status === "issued" && (<>
              {!doc.imported && (<>
                <a className="btn" href={`/api/v3/documents/${doc.id}/html`}
                   target="_blank" rel="noreferrer">本文を見る</a>
                <a className="btn" href={`/api/v3/documents/${doc.id}/pdf`}>PDF</a>
              </>)}
              {doc.storageUrl
                ? <a className="btn" href={doc.storageUrl} target="_blank" rel="noreferrer">
                    {doc.imported ? "ファイル" : "Drive で開く"}
                  </a>
                : !doc.imported && integrations?.drive.documents
                  ? <button className="btn" disabled={busy}
                            onClick={() => onStore(doc.id)}>Drive に保存</button>
                  : null}
              {canSend && (
                <button className={doc.phase === "decided" ? "btn primary" : "btn"} disabled={busy}
                        onClick={() => onSend(doc.id)}>送る</button>
              )}
              {!doc.imported && (pending
                ? <button className="btn"
                          onClick={() => onSelect(pending.id)}>訂正版の下書きを開く</button>
                : <button className="btn" disabled={busy}
                          onClick={() => onReissue(doc.id, doc.documentNo)}>訂正版を作る</button>
              )}
              <button className="btn" disabled={busy}
                      onClick={() => { setDeriving((v) => !v); setDeriveKey(""); }}>
                下敷きに次を作る
              </button>
              <button className="btn" disabled={busy}
                      onClick={() => onVoid(doc.id, doc.documentNo)}>無効にする</button>
            </>)}

            {doc.status === "superseded" && (<>
              <a className="btn" href={`/api/v3/documents/${doc.id}/pdf`}>PDF</a>
              {doc.supersededById && (
                <button className="btn primary"
                        onClick={() => onSelect(doc.supersededById!)}>現行の版を開く</button>
              )}
            </>)}

            {doc.status === "void" && !doc.imported && (
              <a className="btn" href={`/api/v3/documents/${doc.id}/pdf`}>PDF</a>
            )}
          </div>

          {/* 下敷きに次を作る。発注書から検収書、契約書から覚書。前の文書は退かない。 */}
          {deriving && doc.status === "issued" && (
            <div className="note stack" style={{ gap: 8 }}>
              <div>
                <b>この文書を下敷きに、次の書類を作ります。</b>
                <span className="faint">
                  　条件明細・案件・手入力を引き継いだ下書きができます。この文書はそのまま残ります
                  （訂正版とは違い、退きません）。
                </span>
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {pickable.map((t) => (
                  <button key={t.templateKey} type="button" className="chip"
                          aria-pressed={deriveKey === t.templateKey}
                          onClick={() => setDeriveKey(t.templateKey)}>{t.label}</button>
                ))}
              </div>
              <div className="row">
                <button className="btn primary" disabled={busy || !deriveKey}
                        onClick={() => { onDerive(doc.id, deriveKey); setDeriving(false); }}>
                  {deriveKey ? `${pickable.find((t) => t.templateKey === deriveKey)?.label} の下書きを作る` : "ひな形を選んでください"}
                </button>
                <button className="btn" onClick={() => setDeriving(false)}>やめる</button>
              </div>
            </div>
          )}

          {doc.status === "issued" && !doc.imported && !deriving && (
            <div className="faint">
              {pending
                ? "この版を直している下書きがあります。まだ有効なのはこの版で、"
                  + "下書きを決定した瞬間に入れ替わります。下書きを捨ててもこの版は残ります。"
                : "直すなら「訂正版を作る」。条件明細も実績も引き継いだ下書きができ、決定した瞬間にこの版と入れ替わります。"
                  + "次の書類（発注書のあとの検収書など）なら「下敷きに次を作る」。この版はそのまま残ります。"}
            </div>
          )}

          {/*
            繋ぎ直しは下の「つながり」でできるが、そこはページの一番下にある。
            欠けているときだけ上に出して、押せばその欄が開くようにする。
          */}
          {unlinked && (
            <div className="note warn">
              条件明細が繋がっていません。この書類がどの取引から出たものかが辿れません。
              {" "}
              <button className="linky" onClick={onLinkCondition}>
                下の「つながり」で繋ぐ
              </button>
            </div>
          )}

          {doc.status === "draft" && doc.supersedesId !== null && (
            <div className="faint">
              {byNo(versions, doc.supersedesId)} の訂正版です。
              決定すると、その版が退いて、結びついている実績もこちらへ移ります。
              前の版を無効にする操作は要りません。
            </div>
          )}
        </div>
      </div>

      {/* 版の履歴。1版しかないときは出さない（枠だけ増えても読むものが無い）。 */}
      {versions.length > 1 && (
        <div className="panel">
          <div className="panel-hd">
            <h2>版の履歴</h2><span className="faint">{versions.length} 版</span>
          </div>
          <div className="panel-bd">
            <ol className="hist">
              {versions.map((v) => (
                <li key={v.id} className={v.id === doc.id ? "cur" : ""}>
                  <span className="tick"><span className="pip" /></span>
                  <span className="meta">
                    <span className="row" style={{ gap: 7 }}>
                      <button className="linky code" onClick={() => onSelect(v.id)}>
                        {v.documentNo ?? "（未決定）"}
                      </button>
                      {v.id === doc.id
                        ? <span className="tag accent">この版</span>
                        : <StatusTag kind="document" value={v.phase} />}
                    </span>
                    <span className="faint">{day(v.issuedAt)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {/*
        決定済みの文書だけ。下書きは決定のときに実績を選ぶので、ここで先に
        結ぶと二重になる。取込文書は決定の経路を通っていないので、ここが
        唯一の結び先になる。
      */}
      {(doc.status === "issued" || doc.status === "superseded") && (
        <DocumentEvents documentId={doc.id} documentNo={doc.documentNo}
                        conditions={doc.conditions} onChanged={onChanged} />
      )}

      <Relations kind="document" id={doc.id} initialOpen={openConditions ? "conditions" : undefined}
                 onOpen={onOpen} onChanged={onChanged} />
    </div>
  );
}
