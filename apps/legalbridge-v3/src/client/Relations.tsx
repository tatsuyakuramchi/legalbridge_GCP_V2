import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { useDebounced } from "./ListTools.js";

/**
 * 関連（画面と画面をつなぐハブ）。
 *
 * これまで、繋ぐ操作は片側の画面にしか無かった。案件から条件は繋げるのに
 * 条件から案件は繋げない、案件から文書は繋げるのに文書から案件は繋げない。
 * どちらから作業を始めるかは人の都合なので、同じ関連はどちらの画面からも
 * 触れなければならない。ここはその共通部品。
 */

export type EntityKind = "matter" | "condition" | "document" | "agreement" | "work" | "party";

export interface LinkItem {
  id: number; code: string | null; label: string; note: string | null; kind: EntityKind;
}

interface RelationView {
  relation: string; label: string; target: EntityKind;
  single: boolean; editable: boolean; hint: string | null; items: LinkItem[];
}

export const ENTITY_LABEL: Record<EntityKind, string> = {
  matter: "案件", condition: "条件明細", document: "文書",
  agreement: "契約（合意）", work: "作品", party: "取引先"
};

export function Relations(
  { kind, id, reloadKey, exclude = [], onOpen, onChanged }: {
    kind: EntityKind;
    id: number;
    /** 外の操作で関連が変わったときに読み直す。 */
    reloadKey?: number;
    /** 専用の画面が別にある関連は出さない（同じものが2つ並ぶのを避ける）。 */
    exclude?: string[];
    onOpen?: (kind: EntityKind, id: number) => void;
    onChanged?: () => void;
  }
) {
  const [relations, setRelations] = useState<RelationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword, 300);
  const [hits, setHits] = useState<LinkItem[]>([]);

  useEffect(() => { void load(); }, [kind, id, reloadKey]);
  async function load() {
    try {
      const r = await api.get<{ relations: RelationView[] }>(`/links/${kind}/${id}`);
      setRelations(r.relations.filter((x) => !exclude.includes(x.relation)));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  useEffect(() => {
    if (!open) { setHits([]); return; }
    api.get<{ candidates: LinkItem[] }>(
      `/links/${kind}/${id}/${open}/candidates?q=${encodeURIComponent(search.trim())}`)
      .then((r) => setHits(r.candidates)).catch(() => setHits([]));
  }, [open, search, kind, id]);

  async function attach(relation: string, targetId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/links/${kind}/${id}/${relation}`, { targetId });
      setOpen(null); setKeyword("");
      await load(); onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function detach(relation: string, item: LinkItem) {
    if (!window.confirm(`${item.code ?? item.label} を外します。相手のデータは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/links/${kind}/${id}/${relation}/${item.id}`);
      await load(); onChanged?.();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!relations) return null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>つながり</h2>
        <span className="faint">この{ENTITY_LABEL[kind]}が何に繋がっているか</span>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {relations.map((r) => (
          <div key={r.relation} className="stack" style={{ gap: 6 }}>
            <div className="row">
              <b>{r.label}</b>
              <span className="faint">{r.items.length ? `${r.items.length} 件` : "なし"}</span>
              {r.editable && (
                <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={busy}
                        onClick={() => { setOpen(open === r.relation ? null : r.relation); setKeyword(""); }}>
                  {open === r.relation ? "やめる"
                    : r.single && r.items.length ? "付け替える" : "繋ぐ"}
                </button>
              )}
            </div>
            {r.hint && <div className="faint">{r.hint}</div>}

            {r.items.length ? (
              <div className="picker">
                {r.items.map((item) => (
                  <div key={item.id} className="pick">
                    <span className="code">{item.code ?? `#${item.id}`}</span>
                    <span>{item.label}</span>
                    <span className="faint">{item.note ?? ""}</span>
                    <span className="row" style={{ marginLeft: "auto" }}>
                      {onOpen && (
                        <button className="btn btn-sm"
                                onClick={() => onOpen(item.kind, item.id)}>開く</button>
                      )}
                      {r.editable && (
                        <button className="btn btn-sm" disabled={busy}
                                onClick={() => void detach(r.relation, item)}>外す</button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="faint">繋がっていません。</div>
            )}

            {open === r.relation && (
              <div className="stack" style={{ gap: 4 }}>
                <input value={keyword} autoFocus placeholder={`${r.label}を番号・名前で探す`}
                       onChange={(e) => setKeyword(e.target.value)} />
                <div className="picker">
                  {hits.map((h) => (
                    <button key={h.id} className="btn btn-sm" style={{ textAlign: "left" }}
                            disabled={busy} onClick={() => void attach(r.relation, h.id)}>
                      <span className="code">{h.code ?? `#${h.id}`}</span> {h.label}
                      <span className="faint"> {h.note ?? ""}</span>
                    </button>
                  ))}
                  {!hits.length && <span className="faint">見つかりません</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
