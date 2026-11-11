import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import { DocViewButton } from "./DocPeek.js";
import { useReadOnly } from "./read-only.js";

/**
 * 文書を無効にする・無効を取り消す（ポップアップ。画面は切り替えない）。
 *
 * 重複・主旨に合わない・誤って作った文書を外すため。サーバは documents/:id/void（理由が要る）。
 *   ・行は消えず、決定・送付の記録は残る（無効は取り消せる：documents/:id/unvoid）
 *   ・送付済み・Drive に保存したファイルは取り消せない
 *   ・この文書の実績に支払が立っていれば止まる（先に支払を取り消す）
 *   ・差し替え済み（古い版）は無効にできない。訂正版を無効にしても、前の版は差し替え済みのまま
 */

export interface VoidTarget { id: number; documentNo: string | null; label?: string | null; status: string }

const REASONS = ["重複して作成した", "主旨に合っていない（別の取引の文書）", "誤って作成した", "取込の重複"];

export function VoidDialog({ doc, onDone, onClose }: {
  doc: VoidTarget; onDone: (msg: string) => void; onClose: () => void;
}) {
  const undo = doc.status === "void";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true); setError(null);
    try {
      await api.post(`/documents/${doc.id}/${undo ? "unvoid" : "void"}`, { reason: reason.trim() });
      onDone(`${doc.documentNo ?? `文書 #${doc.id}`} ${undo ? "の無効を取り消しました" : "を無効にしました"}`);
      onClose();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={`${doc.documentNo ?? `文書 #${doc.id}`} を${undo ? "元に戻す（無効を取り消す）" : "無効にする"}`} onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        {doc.label && <div className="faint">{doc.label}</div>}
        {!undo ? (
          <ul className="faint" style={{ margin: 0, paddingLeft: 18 }}>
            <li>文書は消えず、決定・送付の記録は残ります（あとで「無効を取り消す」で戻せます）。</li>
            <li>すでに送付・Drive に保存したファイルは取り消せません。</li>
            <li>この文書の実績に支払が立っていると無効にできません（先に支払を取り消してください）。</li>
            <li>訂正版（-R2 など）を無効にしても、前の版は「差し替え済み」のまま決定済みには戻りません。</li>
          </ul>
        ) : <div className="faint">無効にした文書を、無効にする前の状態に戻します。</div>}
        <div className="chips" role="group" aria-label="よくある理由">
          {(undo ? ["誤って無効にした"] : REASONS).map((r) => (
            <button key={r} className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>
          ))}
        </div>
        <label className="stack" style={{ gap: 4 }}>
          <span>理由（必須）</span>
          <textarea className="inline-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder={undo ? "戻す理由" : "例：ARC-PUBT-2026-1030 と同じ内容で重複して作成した"} />
        </label>
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
          <button className={`btn ${undo ? "primary" : "danger"}`} disabled={busy || !reason.trim()} onClick={() => void go()}>
            {busy ? "実行中…" : undo ? "無効を取り消す" : "無効にする"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const STATUS_LABEL: Record<string, string> = { draft: "下書き", issued: "決定済み", superseded: "差し替え済み", void: "無効" };

interface AgreementDoc {
  id: number; documentNo: string | null; label: string; title: string | null; status: string;
  issuedOn: string | null; imported: boolean; storageUrl: string | null; supersedesId: number | null; conditionCount: number;
}

/** 契約に繋がっている文書ぜんぶ。見る・無効にする・無効を取り消す。 */
export function AgreementDocsDialog({ agreementId, title, onChanged, onClose, onOpenDocument }: {
  agreementId: number; title: string; onChanged: (msg: string) => void; onClose: () => void;
  /** 文書番号を押したとき、文書の画面（送る・訂正など）を開く。 */
  onOpenDocument?: (documentId: number) => void;
}) {
  const readOnly = useReadOnly();
  const [docs, setDocs] = useState<AgreementDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [target, setTarget] = useState<VoidTarget | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ documents: AgreementDoc[] }>(`/agreement-map/agreements/${agreementId}/documents`)
      .then((r) => { if (alive) setDocs(r.documents); })
      .catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [agreementId, version]);
  const issued = (docs ?? []).filter((d) => d.status === "issued");
  return (
    <>
      <Modal title={`${title} の文書`} onClose={onClose} wide>
        <div className="stack" style={{ gap: 8 }}>
          {issued.length > 1 && (
            <div className="note warn">決定済みの文書が {issued.length} 枚あります。重複や主旨に合わないものは「無効にする」で外してください。</div>
          )}
          {error && <div className="alert">{error}</div>}
          {!docs && !error && <div className="faint">読み込み中…</div>}
          {docs && !docs.length && <div className="faint">文書はありません。</div>}
          {docs && docs.length > 0 && (
            <table className="table">
              <thead><tr><th>文書番号</th><th>種類・件名</th><th>状態</th><th>決定日</th><th className="num">条件</th><th></th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} style={d.status === "void" ? { opacity: 0.6 } : undefined}>
                    <td className="code">
                      {onOpenDocument
                        ? <button className="linky code" title="文書の画面を開く（送る・訂正など）" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? "（番号なし）"}</button>
                        : d.documentNo ?? "（番号なし）"}
                      {d.imported && <span className="tag" style={{ marginLeft: 4 }}>取込</span>}</td>
                    <td>{d.label}{d.title && <div className="faint">{d.title}</div>}</td>
                    <td><span className={`tag${d.status === "void" ? " warn" : d.status === "issued" ? " ok" : ""}`}>{STATUS_LABEL[d.status] ?? d.status}</span></td>
                    <td>{d.issuedOn ?? "—"}</td>
                    <td className="num">{d.conditionCount}</td>
                    <td>
                      <span className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <DocViewButton id={d.id} documentNo={d.documentNo} imported={d.imported} storageUrl={d.storageUrl} />
                        {!readOnly && (d.status === "issued" || d.status === "draft") && (
                          <button className="ct-act ct-danger" onClick={() => setTarget(d)}>無効にする</button>
                        )}
                        {!readOnly && d.status === "void" && (
                          <button className="ct-act" onClick={() => setTarget(d)}>無効を取り消す</button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <small className="faint">差し替え済み（古い版）は無効にできません。いちばん新しい版を無効にするか、訂正版を出し直してください。</small>
        </div>
      </Modal>
      {target && (
        <VoidDialog doc={target} onClose={() => setTarget(null)}
          onDone={(msg) => { onChanged(msg); setVersion((v) => v + 1); }} />
      )}
    </>
  );
}
