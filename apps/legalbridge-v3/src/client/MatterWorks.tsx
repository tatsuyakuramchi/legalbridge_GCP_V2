import { useState } from "react";
import { SearchSelect } from "./SearchSelect.js";
import { searchWorks } from "./MatterAxis.js";
import { useReadOnly } from "./read-only.js";

/**
 * 案件（または「案件なし」の取引）が扱う作品の一覧。足す・外すができる。
 *
 * ライセンスでは同じ相手から数作品をまとめて取得・許諾することがあり、作品は複数持てる
 * （軸の作品は matters.work_id、残りは matter_links。infra/v3/156）。先頭が軸の作品で、
 * 軸を外すと次の作品が軸になる。作品が要る取引（ライセンス・作品案件）では最後の 1 つは外せない。
 * 外しても、その作品について入れた条件明細はそのまま残る。
 */
export function MatterWorks(
  { works, required, onAdd, onRemove, onError }: {
    works: Array<{ id: number; title: string; workCode?: string | null }>;
    /** 作品が要るか（最後の 1 つを外せない）。 */
    required: boolean;
    onAdd: (workId: number, title: string) => Promise<void>;
    onRemove: (workId: number) => Promise<void>;
    onError: (message: string) => void;
  }
) {
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <span className="chips">
        {works.map((w, i) => {
          const last = required && works.length <= 1;
          return (
            <button key={w.id} type="button" className="chip" aria-pressed="true"
                    disabled={readOnly || busy || last}
                    title={last ? "最後の作品は外せません（先に別の作品を足してください）" : "外す（入れた条件明細は残ります）"}
                    onClick={() => void run(() => onRemove(w.id))}>
              {w.title}{i === 0 && works.length > 1 ? "（軸）" : ""}{last ? "" : " ×"}
            </button>
          );
        })}
        {!works.length && <span className="faint">作品なし</span>}
      </span>
      {!readOnly && (
        <span style={{ minWidth: 200 }}>
          <SearchSelect value="" search={searchWorks} placeholder="作品を足す" disabled={busy}
                        onChange={(v, o) => {
                          const id = Number(v);
                          if (!id || works.some((w) => w.id === id)) return;
                          void run(() => onAdd(id, o?.label ?? `#${id}`));
                        }} />
        </span>
      )}
    </span>
  );
}
