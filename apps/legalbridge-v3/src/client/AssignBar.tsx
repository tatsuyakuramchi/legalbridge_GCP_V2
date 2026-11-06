import { useState } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect } from "./SearchSelect.js";
import { searchMatters, searchWorks } from "./MatterAxis.js";

/**
 * マップで選んだ行を、作品・案件に入れる（途中から立ててカテゴライズする。docs/navigation.md §11）。
 *
 * Excel で行を足すように：既にある作品・案件を選ぶか、新しい名前を打って Enter。新しい名前なら
 * その場で作品・案件を立ててから入れる。
 *   作品に入れる … 条件（POST /conditions/assign-work。作品の無い条件はいつでも、付いている条件は
 *                  決定した文書が無いときだけ付け替える）
 *   案件に入れる … 条件（POST /matters/:id/conditions）と、帯の契約（文書は /matters/:id/documents、
 *                  契約の記録は /links/agreement/:id/matters）。会社全体の契約は会社全体の案件に入れる。
 */
/** 新しく立てる案件の担当者：開いている人（IAP のメール → 担当者）。案件は担当者が必須（期限の通知先）。 */
async function myStaffId(): Promise<number | null> {
  try {
    const me = await api.get<{ user?: { email?: string } }>("/me");
    const email = me.user?.email?.toLowerCase();
    if (!email) return null;
    const staff = await api.get<{ staff: Array<{ id: number; email: string | null; status?: string }> }>("/staff");
    return staff.staff.find((s) => s.email?.toLowerCase() === email && s.status !== "inactive")?.id ?? null;
  } catch { return null; }
}

export function AssignBar({ conditionIds, contractKeys, workId, counterpartyId, onDone }: {
  conditionIds: number[];
  /** 帯の行（"document:12" / "agreement:108"）。 */
  contractKeys: string[];
  /**
   * 作品の切り口なら、新しい案件はその作品の作品案件にする。作品案件は相手先が要るので、
   * 選んだ条件の相手先が 1 社に決まるときだけ（決まらなければその他案件）。
   */
  workId?: number | null;
  counterpartyId?: number | null;
  onDone: (message: string) => void;
}) {
  const [work, setWork] = useState({ id: "", label: null as string | null, name: "" });
  const [matter, setMatter] = useState({ id: "", label: null as string | null, name: "" });
  const [busy, setBusy] = useState<"work" | "matter" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toWork() {
    setBusy("work"); setError(null);
    try {
      let id = Number(work.id) || 0;
      let label = work.label ?? "";
      if (!id) {
        const made = await api.post<{ id: number }>("/works", { title: work.name.trim() });
        id = made.id; label = work.name.trim();
      }
      const r = await api.post<{ updated: number[]; skipped: Array<{ conditionId: number; reason: string }> }>(
        "/conditions/assign-work", { conditionIds, workId: id });
      const skipped = r.skipped.length ? `（${r.skipped.length} 本は入れませんでした：${[...new Set(r.skipped.map((x) => x.reason))].join("／")}）` : "";
      setWork({ id: "", label: null, name: "" });
      onDone(`作品「${label}」に条件を ${r.updated.length} 本入れました${skipped}`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function toMatter() {
    setBusy("matter"); setError(null);
    try {
      let id = Number(matter.id) || 0;
      let label = matter.label ?? "";
      if (!id) {
        const title = matter.name.trim();
        const ownerStaffId = await myStaffId();
        if (!ownerStaffId) throw new Error("あなたが担当者の一覧に見つからないので、案件を立てられません（案件の画面で担当者を選んで立ててください）");
        const made = await api.post<{ id: number; matterNo: string | null }>("/matters",
          workId && counterpartyId ? { kind: "work", workId, counterpartyId, title, ownerStaffId } : { kind: "single", title, ownerStaffId });
        id = made.id; label = `${made.matterNo ?? ""} ${title}`.trim();
      }
      const notes: string[] = [];
      if (conditionIds.length) {
        await api.post(`/matters/${id}/conditions`, { conditionIds });
        notes.push(`条件 ${conditionIds.length} 本`);
      }
      let docs = 0, refs = 0, agrs = 0;
      for (const key of contractKeys) {
        const [kind, raw] = key.split(":") as [string, string];
        const targetId = Number(raw);
        if (kind === "agreement") { await api.post(`/links/agreement/${targetId}/matters`, { targetId: id }); agrs++; continue; }
        try { await api.post(`/matters/${id}/documents`, { documentId: targetId, mode: "attach" }); docs++; }
        catch (e) {
          // 別の案件に付いている文書は動かさず、参照として繋ぐ（元の案件に残す）。
          if (e instanceof ApiError && e.status === 409) { await api.post(`/matters/${id}/documents`, { documentId: targetId, mode: "reference" }); refs++; }
          else throw e;
        }
      }
      if (docs) notes.push(`文書 ${docs} 枚`);
      if (refs) notes.push(`文書 ${refs} 枚（別の案件に付いているので参照で）`);
      if (agrs) notes.push(`契約 ${agrs} 本`);
      setMatter({ id: "", label: null, name: "" });
      onDone(`案件「${label}」に ${notes.join("・")} を入れました`);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const canWork = conditionIds.length > 0 && (Boolean(work.id) || work.name.trim().length > 0);
  const canMatter = (conditionIds.length + contractKeys.length) > 0 && (Boolean(matter.id) || matter.name.trim().length > 0);

  return (
    <div className="assignbar">
      {conditionIds.length > 0 && (
        <div className="assign-row">
          <b>作品に入れる</b>
          <div style={{ minWidth: 220 }}>
            <SearchSelect value={work.id} valueLabel={work.label} search={searchWorks} placeholder="既にある作品を探す"
                          emptyLabel="（新しく立てる）"
                          onChange={(v, o) => setWork({ id: v, label: o?.label ?? null, name: "" })} />
          </div>
          <span className="faint">または</span>
          <input className="inline-input" style={{ maxWidth: 240 }} placeholder="新しい作品名を打って Enter" value={work.name}
                 onChange={(e) => setWork({ id: "", label: null, name: e.target.value })}
                 onKeyDown={(e) => { if (e.key === "Enter" && canWork && !busy) void toWork(); }} />
          <button className="btn btn-sm primary" disabled={!canWork || busy !== null} onClick={toWork}>
            {busy === "work" ? "入れています…" : `条件 ${conditionIds.length} 本を入れる`}</button>
        </div>
      )}
      <div className="assign-row">
        <b>案件に入れる</b>
        <div style={{ minWidth: 220 }}>
          <SearchSelect value={matter.id} valueLabel={matter.label} search={searchMatters([])} placeholder="既にある案件を探す"
                        emptyLabel="（新しく立てる）"
                        onChange={(v, o) => setMatter({ id: v, label: o?.label ?? null, name: "" })} />
        </div>
        <span className="faint">または</span>
        <input className="inline-input" style={{ maxWidth: 240 }} placeholder="新しい案件名を打って Enter（会社全体の案件も）" value={matter.name}
               onChange={(e) => setMatter({ id: "", label: null, name: e.target.value })}
               onKeyDown={(e) => { if (e.key === "Enter" && canMatter && !busy) void toMatter(); }} />
        <button className="btn btn-sm primary" disabled={!canMatter || busy !== null} onClick={toMatter}>
          {busy === "matter" ? "入れています…" : `${[conditionIds.length ? `条件 ${conditionIds.length}` : "", contractKeys.length ? `契約 ${contractKeys.length}` : ""].filter(Boolean).join("・")} を入れる`}</button>
      </div>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
