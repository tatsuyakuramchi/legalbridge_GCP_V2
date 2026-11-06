import { useEffect, useRef, type ReactNode } from "react";

/** ネイティブの dialog。Esc と外側の押下で閉じる。 */
export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { if (d?.open) d.close(); };
  }, []);
  return (
    <dialog ref={ref} className={`lb-modal${wide ? " wide" : ""}`} onCancel={(e) => { e.preventDefault(); onClose(); }}
            onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="lb-modal-hd">
        <b>{title}</b>
        <button className="btn btn-sm" onClick={onClose} aria-label="閉じる">閉じる</button>
      </div>
      <div className="lb-modal-bd">{children}</div>
    </dialog>
  );
}
