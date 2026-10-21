/**
 * 「見る」― 文書の本文を別タブで開く小さなリンク。
 *
 * まとめて送る・送る欄・未送付の一覧で、チェックの横に置く。添付する紙をその場で確かめてから送れる。
 * 作った文書は本文（HTML）、取り込んだ文書は保存先（Drive）のファイルを開く。
 */
export function DocPeek({ id, imported, storageUrl, label = "見る" }: {
  id: number; imported?: boolean; storageUrl?: string | null; label?: string;
}) {
  const href = imported ? (storageUrl ?? `/api/v3/documents/${id}/pdf`) : `/api/v3/documents/${id}/html`;
  return (
    <a className="linky" href={href} target="_blank" rel="noreferrer" title="本文を別タブで開く（送る前に添付する紙を確かめる）"
       onClick={(e) => e.stopPropagation()} style={{ fontSize: "0.9em" }}>{label}</a>
  );
}
