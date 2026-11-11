import { useState } from "react";
import { Modal } from "./Modal.js";

/**
 * 「見る」― 文書をその場（ポップアップ）で開く小さなリンク。画面は切り替えない。
 *
 * まとめて送る・送る欄・未送付の一覧で、チェックの横に置く。添付する紙をその場で確かめてから送れる。
 * 作った文書は本文（HTML）、取り込んだ文書は保存先（Drive）のファイルを開く。
 */
export function DocPeek({ id, imported, storageUrl, label = "見る", documentNo }: {
  id: number; imported?: boolean; storageUrl?: string | null; label?: string; documentNo?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="linky" title="文書をこの画面のまま開く（送る前に添付する紙を確かめる）"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }} style={{ fontSize: "0.9em" }}>{label}</button>
      {open && <DocViewer id={id} documentNo={documentNo ?? null} imported={Boolean(imported)} storageUrl={storageUrl ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * 「見る」― 文書をその場（ポップアップ）で開く。画面は切り替えない。
 *   作った文書 … 本文（/documents/:id/html）
 *   取り込んだ文書 … 保存先（Drive）のファイル。Drive のファイルは埋め込み表示（/preview）にする。
 *                  埋め込めない保存先は「別タブで開く」だけ出す。
 */
export function DocViewButton({ id, documentNo, imported, storageUrl, label = "見る" }: {
  id: number; documentNo?: string | null; imported?: boolean; storageUrl?: string | null; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ct-act ct-view" title="文書をこの画面のまま開く" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label}</button>
      {open && <DocViewer id={id} documentNo={documentNo ?? null} imported={Boolean(imported)} storageUrl={storageUrl ?? null} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Drive の共有リンクを埋め込み表示の URL に。Drive でなければ null。 */
export function embeddableUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/) ?? url.match(/drive\.google\.com\/open\?id=([^&#]+)/)
    ?? url.match(/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([^/?#]+)/);
  if (!m) return null;
  if (url.includes("docs.google.com/")) return url.replace(/\/(edit|view)[^/]*$/, "/preview");
  return `https://drive.google.com/file/d/${m[1]}/preview`;
}

export function DocViewer({ id, documentNo, imported, storageUrl, onClose }: {
  id: number; documentNo: string | null; imported: boolean; storageUrl: string | null; onClose: () => void;
}) {
  const src = imported ? embeddableUrl(storageUrl) : `/api/v3/documents/${id}/html`;
  const tab = imported ? storageUrl : `/api/v3/documents/${id}/html`;
  return (
    <Modal title={<>{documentNo ?? `文書 #${id}`}{imported && <span className="tag" style={{ marginLeft: 6 }}>取込</span>}</>} onClose={onClose} wide>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {tab && <a className="btn btn-sm" href={tab} target="_blank" rel="noreferrer">別タブで開く</a>}
          {!imported && <a className="btn btn-sm" href={`/api/v3/documents/${id}/pdf`}>PDF を保存</a>}
          <span className="faint" style={{ marginLeft: "auto" }}>Esc か外側を押すと閉じます</span>
        </div>
        {src
          ? <iframe className="doc-viewer" src={src} title={documentNo ?? `文書 ${id}`} />
          : <div className="note">{storageUrl
              ? "この保存先はここでは開けません。「別タブで開く」で見てください。"
              : "取り込んだファイルの保存先がありません（ファイルなしで取り込んだ文書）。"}</div>}
      </div>
    </Modal>
  );
}

/** URL だけの「見る」（契約に付けた Drive のリンクなど）。Drive なら埋め込み、ほかは別タブで開く案内。 */
export function LinkViewButton({ url, title, label = "見る" }: { url: string; title: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const src = embeddableUrl(url);
  return (
    <>
      <button className="ct-act ct-view" title="この画面のまま開く" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label}</button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)} wide>
          <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">別タブで開く</a>
              <span className="faint" style={{ marginLeft: "auto" }}>Esc か外側を押すと閉じます</span>
            </div>
            {src ? <iframe className="doc-viewer" src={src} title={title} />
                 : <div className="note">このリンクはここでは開けません。「別タブで開く」で見てください。</div>}
          </div>
        </Modal>
      )}
    </>
  );
}
