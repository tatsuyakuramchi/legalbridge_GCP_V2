import { DOCUMENT_STATE_NOTE, StatusTag } from "./labels.js";
import { Relations, type EntityKind } from "./Relations.js";

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
}

interface Integrations {
  drive: { documents: boolean; matterFolders: boolean };
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

/** 版の連鎖の中から文書番号を引く。番号の無い版は id で呼ぶ。 */
const byNo = (versions: DocumentRow[], id: number) =>
  versions.find((v) => v.id === id)?.documentNo ?? `#${id}`;

export function DocumentDetail(
  { doc, versions, integrations, busy, onOpen, onChanged, onLinkCondition, openConditions,
    onEditDraft, onIssueDraft, onReissue, onVoid, onStore, onSend, onSelect }: {
    doc: DocumentRow;
    /** 古い順に並べた版の連鎖。1件だけなら履歴は出さない。 */
    versions: DocumentRow[];
    integrations: Integrations | null;
    busy: boolean;
    onOpen?: (kind: EntityKind, id: number) => void;
    onChanged: () => void;
    onEditDraft: (id: number) => void;
    onIssueDraft: (id: number) => void;
    onReissue: (id: number, no: string | null) => void;
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
  const note = DOCUMENT_STATE_NOTE[doc.status] ?? { headline: doc.status, detail: "" };
  const canMail = integrations?.channels.some((c) => c.channel === "gmail" && c.mode !== "off");
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
          <h2 className="code">{doc.documentNo ?? "（未発行）"}</h2>
          <span className="tag">{doc.templateLabel ?? "種別なし"}</span>
          <StatusTag kind="document" value={doc.status} />
          {doc.imported && <span className="tag">取込</span>}
        </div>
        <div className="panel-bd stack">
          <div className={`state ${doc.status}`}>
            <span className="mark" />
            <span className="txt">
              <b>{note.headline}</b>
              <span>
                {note.detail}
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
                {doc.supersedesId ? "訂正版として発行する" : "発行する"}
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
              {canMail && (
                <button className="btn" disabled={busy}
                        onClick={() => onSend(doc.id)}>送付</button>
              )}
              {!doc.imported && (pending
                ? <button className="btn primary"
                          onClick={() => onSelect(pending.id)}>訂正版の下書きを開く</button>
                : <button className="btn primary" disabled={busy}
                          onClick={() => onReissue(doc.id, doc.documentNo)}>訂正版を作る</button>
              )}
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

          {doc.status === "issued" && !doc.imported && (
            <div className="faint">
              {pending
                ? "この版を直している下書きがあります。まだ有効なのはこの版で、"
                  + "下書きを発行した瞬間に入れ替わります。下書きを捨ててもこの版は残ります。"
                : "訂正版を作ると、条件明細も実績もそのまま引き継いだ下書きができます。"
                  + "直して発行した瞬間に、この版と入れ替わります。先にこの版を無効にする必要はありません。"}
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
              発行すると、その版が退いて、結びついている実績もこちらへ移ります。
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
                        {v.documentNo ?? "（未発行）"}
                      </button>
                      {v.id === doc.id
                        ? <span className="tag accent">この版</span>
                        : <StatusTag kind="document" value={v.status} />}
                    </span>
                    <span className="faint">{day(v.issuedAt)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      <Relations kind="document" id={doc.id} initialOpen={openConditions ? "conditions" : undefined}
                 onOpen={onOpen} onChanged={onChanged} />
    </div>
  );
}
