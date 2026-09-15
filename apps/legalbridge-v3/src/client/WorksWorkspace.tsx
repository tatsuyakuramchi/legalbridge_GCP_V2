import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ListSearch, useDebounced } from "./ListTools.js";
import type { ConditionDetail, ConditionSummary, RightsEnvelope } from "../server/core/model.js";
import { api, ApiError, money, rate } from "./api.js";
import { Relations, type EntityKind } from "./Relations.js";
import { CreateForm, text } from "./CreateForm.js";
import { WorkCreateForm } from "./WorkCreateForm.js";
import { SearchSelect } from "./SearchSelect.js";
import { ConditionEdit, type EditResult } from "./ConditionEdit.js";
import { ConditionCreateForm } from "./ConditionCreateForm.js";
import { PubConditionSetForm } from "./PubConditionSetForm.js";
import { LicenseSetForm } from "./LicenseSetForm.js";
import { conditionUsageLabel } from "../server/core/condition-usage.js";
import { CONDITION_KIND_LABEL, EVENT_TYPE_LABEL, StatusTag } from "./labels.js";
import { useReadOnly } from "./read-only.js";

/**
 * 作品台帳。
 *
 * 作品・原作（Core Logic）・条件（取引モデル）を1つの画面で直す。
 * 以前の作品の画面は「見る」だけで、作品の題名も原作の繋がりも直せず、条件は
 * 1本ずつ条件明細の画面へ移って直していた。移行データを作り替えるには、
 * 作品を選んで、原作を付け替えて、条件をまとめて見て、要らないものを消す、
 * という一連が同じ画面で回らないといけない。
 *
 * 条件明細のロジック（予定・実績・計算書・改訂）はここでは触らない。
 * 条件の「頭」（名前・金額・相手先・作品・範囲）だけを、条件明細と同じ
 * フォーム（ConditionEdit）で直す。実績のある条件を直せば、条件明細と同じく
 * 改訂（新版）になる。
 *
 * 削除は2段階。条件は 無効化 → 削除、作品は 終了 → 削除。
 */

interface TreeWork {
  id: number; workCode: string | null; title: string; titleKana: string | null;
  kind: string; status: string; businessLine: string | null; legacy: boolean;
  mergedIntoId: number | null;
  conditions: number; parts: number;
}
interface Tree { works: TreeWork[]; lineage: Array<{ parentId: number; childId: number }> }

interface WorkRefRow { id: number; workCode: string | null; title: string; kind: string }
interface Part { id: number; partNo: number; name: string; partType: string; royaltyBearing: boolean }
interface WorkDetail {
  id: number; workCode: string | null; title: string; titleKana: string | null; kind: string;
  status: string; businessLine: string | null; remarks: string | null; legacy: boolean;
  copyrightNotice: string | null; thirdPartyRights: string | null;
  mergedInto: { id: number; workCode: string | null; title: string } | null;
  sources: WorkRefRow[]; children: WorkRefRow[]; parts: Part[];
}

interface LegacyCondition {
  id: number; conditionNo: string | null; name: string; direction: string; kind: string;
  status: string; pricingModel: string; counterparty: string | null; work: string | null;
  workId: number | null;
  used: { events: number; outRefs: number; documents: number; payments: number;
          statements: number; matters: number; children: number };
  unused: boolean;
}
interface LegacyWork {
  id: number; workCode: string | null; title: string; kind: string; status: string;
  used: { conditions: number; voidConditions: number; children: number; parts: number };
  unused: boolean;
}

interface Activity {
  events: Array<{ id: number; eventType: string; occurredOn: string | null; period: string | null;
                  quantity: number | null; amount: number; currency: string;
                  conditionId: number; conditionNo: string | null; conditionName: string;
                  documentId: number | null; documentNo: string | null }>;
  statements: Array<{ id: number; period: string; currency: string; netAmount: number;
                      taxAmount: number; conditionNo: string | null; conditionName: string;
                      documentId: number; documentNo: string | null; documentStatus: string }>;
  payments: Array<{ id: number; paymentNo: string | null; direction: string; currency: string;
                    amount: number; taxAmount: number; withholdingAmount: number;
                    dueOn: string | null; paidOn: string | null; status: string;
                    partyName: string | null }>;
  documents: Array<{ id: number; documentNo: string | null; status: string;
                     issuedAt: string | null; templateLabel: string | null }>;
}

const KIND_LABEL: Record<string, string> = {
  own: "自社作品", source_ip: "原作（Core Logic）", derivative: "派生作品"
};
const KIND_OPTIONS = Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }));
const STATUS_OPTIONS = [
  { value: "planning", label: "企画中" }, { value: "in_production", label: "制作中" },
  { value: "released", label: "公開済み" }, { value: "archived", label: "終了" }
];
const PART_TYPES = [
  { value: "unspecified", label: "未指定" }, { value: "text", label: "文章" },
  { value: "illustration", label: "イラスト" }, { value: "design", label: "デザイン" },
  { value: "music", label: "音楽" }, { value: "photo", label: "写真" }, { value: "other", label: "その他" }
];
const PRICING_LABEL: Record<string, string> = {
  fixed: "定額", revenue_rate: "料率", unit_rate: "単価×数量", subscription: "定期課金", none: "—"
};
const DIMENSION_LABEL: Record<string, string> = {
  region: "地域", language: "言語", media: "媒体", channel: "チャネル"
};

/** 条件の金額を1行で。計算方式ごとに見るものが違う。 */
function pricingSummary(c: ConditionSummary): string {
  const label = PRICING_LABEL[c.pricingModel] ?? c.pricingModel;
  switch (c.pricingModel) {
    case "fixed":        return `${label} ${money(c.flatAmount, c.currency)}`;
    case "revenue_rate": return `${label} ${rate(c.ratePpm)}${c.mgAmount ? `・MG ${money(c.mgAmount, c.currency)}` : ""}`;
    case "unit_rate":    return `${label} ${money(c.unitAmount, c.currency)}${c.quantity ? ` × ${c.quantity}` : ""}`;
    case "subscription": return `${label} ${money(c.flatAmount, c.currency)}`;
    default:             return label;
  }
}

/** まとめて実行して、できた数とできなかった理由を1つの文にする。 */
async function runEach<T>(
  items: T[], label: (t: T) => string, fn: (t: T) => Promise<unknown>
): Promise<{ ok: number; failed: string[] }> {
  let ok = 0;
  const failed: string[] = [];
  for (const item of items) {
    try { await fn(item); ok += 1; }
    catch (e) { failed.push(`${label(item)}：${e instanceof ApiError ? e.message : String(e)}`); }
  }
  return { ok, failed };
}

export function WorksWorkspace(
  { onOpenCondition, initialId, onOpen, onCompose }: {
    onOpenCondition: (id: number) => void;
    initialId?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
    /** 文書の画面へ、選んだ条件を載せた状態で移る。台帳から文書を作る入口。 */
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null,
                 templateKey?: string | null) => void;
  }
) {
  const readOnly = useReadOnly();
  const [tree, setTree] = useState<Tree>({ works: [], lineage: [] });
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeVoid, setIncludeVoid] = useState(false);
  const [kindFilter, setKindFilter] = useState<"all" | "source" | "work">("all");
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [envelope, setEnvelope] = useState<RightsEnvelope | null>(null);
  const [conditions, setConditions] = useState<ConditionSummary[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<ConditionDetail | null>(null);
  const [creating, setCreating] = useState<"work" | "source" | "part" | "condition" | "publishing" | "license" | null>(null);
  const [moveTo, setMoveTo] = useState<string>("");
  const [moving, setMoving] = useState(false);
  const [mergeTo, setMergeTo] = useState<string>("");
  const [merging, setMerging] = useState(false);
  const [newSource, setNewSource] = useState<{ title: string; titleKana: string } | null>(null);
  const [cleanup, setCleanup] = useState<{ conditions: LegacyCondition[]; works: LegacyWork[] } | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : String(e));

  function reloadTree(select?: number) {
    const q = search.trim();
    return api.get<Tree>(`/works/tree?q=${encodeURIComponent(q)}&archived=${includeArchived ? 1 : 0}`)
      .then((r) => {
        setTree(r);
        if (select) setSelected(select);
        else if (!selected && r.works[0]) setSelected(r.works[0].id);
      })
      .catch(fail);
  }
  useEffect(() => { void reloadTree(); }, [search, includeArchived]);

  function reloadWork() {
    if (!selected) { setWork(null); return; }
    setChecked(new Set()); setEditing(null);
    return Promise.all([
      api.get<WorkDetail>(`/works/${selected}`),
      api.get<{ envelope: RightsEnvelope }>(`/works/${selected}/envelope`),
      api.get<{ conditions: ConditionSummary[] }>(`/conditions?workId=${selected}&void=${includeVoid ? 1 : 0}`),
      api.get<Activity>(`/works/${selected}/activity`)
    ]).then(([w, e, c, a]) => {
      setWork(w); setEnvelope(e.envelope); setConditions(c.conditions); setActivity(a);
      setForm({
        title: w.title, titleKana: w.titleKana ?? "", kind: w.kind, status: w.status,
        businessLine: w.businessLine ?? "", remarks: w.remarks ?? "",
        copyrightNotice: w.copyrightNotice ?? "", thirdPartyRights: w.thirdPartyRights ?? ""
      });
    }).catch(fail);
  }
  useEffect(() => { void reloadWork(); }, [selected, includeVoid]);

  function reloadCleanup() {
    return api.get<{ conditions: LegacyCondition[]; works: LegacyWork[] }>("/cleanup/legacy")
      .then(setCleanup).catch(fail);
  }
  useEffect(() => { if (cleanupOpen && !cleanup) void reloadCleanup(); }, [cleanupOpen]);

  // ---- ツリー（親のある作品は親の下に。原作を先に） ----
  //
  // 親は原作とは限らない。自社作品の下に派生作品がぶら下がることもある
  // （星降る夜のミュゼ → 繁体字版）。原作の下だけを見ていると、そういう
  // 派生作品がどこにも出ない。親が一覧に居るなら、その下に出す。
  const grouped = useMemo(() => {
    const byId = new Map(tree.works.map((w) => [w.id, w]));
    const childrenOf = new Map<number, TreeWork[]>();
    const hasParent = new Set<number>();
    for (const l of tree.lineage) {
      const child = byId.get(l.childId);
      if (!child || !byId.has(l.parentId)) continue;
      if ((childrenOf.get(l.parentId) ?? []).some((c) => c.id === child.id)) continue;
      hasParent.add(child.id);
      childrenOf.set(l.parentId, [...(childrenOf.get(l.parentId) ?? []), child]);
    }
    const roots = tree.works.filter((w) => !hasParent.has(w.id));
    const sources = roots.filter((w) => w.kind === "source_ip");
    const loose = roots.filter((w) => w.kind !== "source_ip");
    return { sources, loose, childrenOf };
  }, [tree]);

  const sourceOptions = useMemo(
    () => tree.works
      .filter((w) => w.kind === "source_ip" && w.id !== selected)
      .map((w) => ({ value: String(w.id), label: w.title, hint: w.workCode })),
    [tree, selected]);
  const moveOptions = useMemo(
    () => tree.works.filter((w) => w.id !== selected)
      .map((w) => ({ value: String(w.id), label: w.title, hint: `${w.workCode ?? ""} ${KIND_LABEL[w.kind] ?? ""}`.trim() })),
    [tree, selected]);

  // ---- 作品の保存 ----
  const dirty = work && (
    form.title !== work.title || form.titleKana !== (work.titleKana ?? "") ||
    form.kind !== work.kind || form.status !== work.status ||
    form.businessLine !== (work.businessLine ?? "") || form.remarks !== (work.remarks ?? "") ||
    form.copyrightNotice !== (work.copyrightNotice ?? "") || form.thirdPartyRights !== (work.thirdPartyRights ?? ""));

  async function saveWork() {
    if (!work) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.patch(`/works/${work.id}`, {
        title: form.title.trim(), titleKana: form.titleKana.trim() || null,
        kind: form.kind, status: form.status,
        businessLine: form.businessLine.trim() || null, remarks: form.remarks.trim() || null,
        copyrightNotice: form.copyrightNotice.trim() || null,
        thirdPartyRights: form.thirdPartyRights.trim() || null
      });
      setNotice("作品を保存しました");
      await Promise.all([reloadTree(), reloadWork()]);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function setSources(ids: number[]) {
    if (!work) return;
    setBusy(true); setError(null);
    try {
      await api.put(`/works/${work.id}/sources`, { parentIds: ids });
      setNotice("原作を付け替えました");
      await Promise.all([reloadTree(), reloadWork()]);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  /**
   * 統合。条件・パート・系譜を先へ付け替え、この作品は終了にして統合先を記録する。
   * 移行データの表記違いをまとめるための操作なので、実績のある条件も一緒に動く
   * （条件の work_id を付け替えるだけで、条件の中身は変わらない）。
   */
  async function mergeWork() {
    if (!work || !mergeTo) return;
    const target = tree.works.find((t) => String(t.id) === mergeTo);
    if (!confirm(`「${work.title}」を「${target?.title ?? mergeTo}」にまとめます。\n` +
                 `条件 ${conditions.length} 件・パート ${work.parts.length} 件・原作の繋がりを移し、` +
                 `「${work.title}」は終了になります。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ moved: { conditions: number; parts: number; lineage: number } }>(
        `/works/${work.id}/merge`, { intoId: Number(mergeTo) });
      setNotice(`「${target?.title ?? ""}」にまとめました（条件 ${r.moved.conditions}・パート ${r.moved.parts}・系譜 ${r.moved.lineage}）`);
      setMerging(false); setMergeTo("");
      setSelected(Number(mergeTo));
      await reloadTree();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  /** 原作をその場で登録して、この作品に付ける。登録してから探し直す往復を無くす。 */
  async function createSourceAndAttach() {
    if (!work || !newSource || !newSource.title.trim()) return;
    setBusy(true); setError(null);
    try {
      const made = await api.post<{ id: number }>("/works", {
        title: newSource.title.trim(), titleKana: newSource.titleKana.trim() || null,
        kind: "source_ip", status: "released"
      });
      await api.put(`/works/${work.id}/sources`, { parentIds: [...work.sources.map((s) => s.id), made.id] });
      setNotice(`原作「${newSource.title.trim()}」を登録して付けました`);
      setNewSource(null);
      await Promise.all([reloadTree(), reloadWork()]);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function archiveWork() {
    if (!work) return;
    const reason = prompt(`作品「${work.title}」を終了にします。理由を書いてください。`);
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/works/${work.id}/archive`, { reason: reason.trim() });
      setNotice("終了にしました。条件が無ければ削除できます");
      setIncludeArchived(true);
      await Promise.all([reloadTree(), reloadWork()]);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function removeWork() {
    if (!work) return;
    if (!confirm(`作品「${work.title}」を削除します。元に戻せません。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/works/${work.id}`);
      setNotice(`作品「${work.title}」を削除しました`);
      setSelected(undefined); setWork(null);
      await reloadTree();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  // ---- パート ----
  async function savePart(p: Part, patch: Partial<Part>) {
    if (!work) return;
    setError(null);
    try {
      await api.patch(`/works/${work.id}/parts/${p.id}`, patch);
      await reloadWork();
    } catch (e) { fail(e); }
  }
  async function removePart(p: Part) {
    if (!work) return;
    if (!confirm(`パート「${p.name}」を削除します。よろしいですか？`)) return;
    setError(null);
    try {
      await api.del(`/works/${work.id}/parts/${p.id}`);
      await Promise.all([reloadTree(), reloadWork()]);
    } catch (e) { fail(e); }
  }

  // ---- 条件（取引モデル） ----
  const toggle = (id: number) => setChecked((prev) => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const picked = conditions.filter((c) => checked.has(c.id));

  async function openEdit(id: number) {
    setError(null);
    try { setEditing(await api.get<ConditionDetail>(`/conditions/${id}`)); }
    catch (e) { fail(e); }
  }

  async function removeCondition(c: ConditionSummary) {
    if (!confirm(`条件 ${c.conditionNo ?? `#${c.id}`}「${c.name}」を削除します。元に戻せません。よろしいですか？`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/conditions/${c.id}`);
      setNotice(`条件 ${c.conditionNo ?? `#${c.id}`} を削除しました`);
      await Promise.all([reloadTree(), reloadWork()]);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function voidPicked() {
    if (!picked.length) return;
    const reason = prompt(`条件 ${picked.length} 件を無効化します。理由を書いてください（全件に同じ理由が付きます）。`);
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    const r = await runEach(picked, (c) => c.conditionNo ?? `#${c.id}`,
      (c) => api.post(`/conditions/${c.id}/void`, { reason: reason.trim() }));
    setBusy(false);
    setNotice(`${r.ok} 件を無効化しました。「無効化済みも」を付けると見えます。何も指していなければ、そこから削除できます`);
    if (r.failed.length) setError(r.failed.join("\n"));
    await Promise.all([reloadTree(), reloadWork()]);
  }

  async function movePicked() {
    if (!picked.length || !moveTo) return;
    const target = tree.works.find((w) => String(w.id) === moveTo);
    if (!confirm(`条件 ${picked.length} 件を「${target?.title ?? moveTo}」へ移します。実績のある条件は改訂（新版）になります。よろしいですか？`)) return;
    setBusy(true); setError(null);
    const r = await runEach(picked, (c) => c.conditionNo ?? `#${c.id}`,
      (c) => api.patch(`/conditions/${c.id}`, { workId: Number(moveTo) }));
    setBusy(false); setMoving(false); setMoveTo("");
    setNotice(`${r.ok} 件を「${target?.title ?? ""}」へ移しました`);
    if (r.failed.length) setError(r.failed.join("\n"));
    await Promise.all([reloadTree(), reloadWork()]);
  }

  // ---- 棚卸し ----
  const [cleanupChecked, setCleanupChecked] = useState<Set<string>>(new Set());
  const [onlyUnused, setOnlyUnused] = useState(true);
  const toggleCleanup = (key: string) => setCleanupChecked((prev) => {
    const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const pickedLegacyConditions = (cleanup?.conditions ?? []).filter((c) => cleanupChecked.has(`c${c.id}`));
  const pickedLegacyWorks = (cleanup?.works ?? []).filter((w) => cleanupChecked.has(`w${w.id}`));

  async function cleanupRun(
    kind: "void" | "delete" | "archive" | "delete-work"
  ) {
    setBusy(true); setError(null); setNotice(null);
    let r: { ok: number; failed: string[] };
    if (kind === "void") {
      const reason = prompt(`移行データの条件 ${pickedLegacyConditions.length} 件を無効化します。理由を書いてください。`);
      if (!reason?.trim()) { setBusy(false); return; }
      r = await runEach(pickedLegacyConditions, (c) => c.conditionNo ?? `#${c.id}`,
        (c) => api.post(`/conditions/${c.id}/void`, { reason: reason.trim() }));
    } else if (kind === "delete") {
      if (!confirm(`条件 ${pickedLegacyConditions.length} 件を削除します。元に戻せません。よろしいですか？`)) { setBusy(false); return; }
      r = await runEach(pickedLegacyConditions, (c) => c.conditionNo ?? `#${c.id}`,
        (c) => api.del(`/conditions/${c.id}`));
    } else if (kind === "archive") {
      const reason = prompt(`移行データの作品 ${pickedLegacyWorks.length} 件を終了にします。理由を書いてください。`);
      if (!reason?.trim()) { setBusy(false); return; }
      r = await runEach(pickedLegacyWorks, (w) => w.title,
        (w) => api.post(`/works/${w.id}/archive`, { reason: reason.trim() }));
    } else {
      if (!confirm(`作品 ${pickedLegacyWorks.length} 件を削除します。元に戻せません。よろしいですか？`)) { setBusy(false); return; }
      r = await runEach(pickedLegacyWorks, (w) => w.title, (w) => api.del(`/works/${w.id}`));
    }
    setBusy(false);
    setNotice(`${r.ok} 件できました${r.failed.length ? `。${r.failed.length} 件はできませんでした` : ""}`);
    if (r.failed.length) setError(r.failed.join("\n"));
    setCleanupChecked(new Set());
    await Promise.all([reloadCleanup(), reloadTree(), reloadWork()]);
  }

  const editable = !readOnly;
  /** 1つの作品と、その下の作品（3段まで。輪は setSources で止めてある）。 */
  const renderNode = (w: TreeWork, depth = 0): ReactElement => (
    <div key={w.id}>
      <button className={`node${depth ? " child" : ""}`} aria-pressed={w.id === selected}
              style={depth > 1 ? { marginLeft: 18 * depth } : undefined}
              onClick={() => { setNotice(null); setError(null); setSelected(w.id); }}>
        {w.kind === "source_ip" && <span className="tag accent">原作</span>}
        <span className="grow">{w.title}</span>
        {w.legacy && <span className="faint" title="V2 から移した作品">移行</span>}
        {w.mergedIntoId ? <span className="faint">統合済</span> : w.status === "archived" && <span className="faint">終了</span>}
        <span className="faint num">{w.conditions}</span>
      </button>
      {depth < 3 && kindFilter === "all" && (grouped.childrenOf.get(w.id) ?? []).map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>作品台帳</h1>
        <p>作品・原作（Core Logic）・条件（利用形態ごとに1本）をここで直す。原作 N に対して作品 N。条件の中身（予定・実績・計算書）は条件明細で扱う。</p>
      </header>

      {error && <div className="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      <div className="row">
        {editable && creating === null && (<>
          <button className="btn primary btn-sm" onClick={() => setCreating("work")}>作品を登録</button>
          <button className="btn btn-sm" onClick={() => setCreating("source")}>原作を登録</button>
        </>)}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} aria-pressed={cleanupOpen}
                onClick={() => setCleanupOpen((v) => !v)}>
          移行データの棚卸し{cleanup ? `（条件 ${cleanup.conditions.length}・作品 ${cleanup.works.length}）` : ""}
        </button>
      </div>

      {creating === "work" && (
        <WorkCreateForm onDone={(r) => { setCreating(null); void reloadTree(r.id); }}
                        onCancel={() => setCreating(null)} />
      )}
      {creating === "source" && (
        <CreateForm title="原作（Core Logic）の登録" path="/works"
          initial={{ kind: "source_ip", status: "released" }}
          fields={[
            { name: "title", label: "原作名", required: true },
            { name: "titleKana", label: "カナ" },
            { name: "businessLine", label: "事業区分" },
            { name: "remarks", label: "備考", type: "textarea" }
          ]}
          toPayload={(v) => ({ title: text(v.title), titleKana: text(v.titleKana), kind: "source_ip",
                               status: "released", businessLine: text(v.businessLine), remarks: text(v.remarks) })}
          onDone={(r: { id: number }) => { setCreating(null); void reloadTree(r.id); }}
          onCancel={() => setCreating(null)}>
          <p className="faint">原作は許諾の対象そのもの。作品は原作にぶら下がる（1つの原作に複数の作品、1つの作品に複数の原作）。</p>
        </CreateForm>
      )}

      {cleanupOpen && (
        <div className="panel">
          <div className="panel-hd">
            <h2>移行データの棚卸し</h2>
            <span className="faint">V2 から移したもの。「使っていない」は実績・文書・支払・計算書・案件のどれにも指されていない</span>
            <label className="ledger-check" style={{ marginLeft: "auto" }}>
              <input type="checkbox" checked={onlyUnused} onChange={(e) => setOnlyUnused(e.target.checked)} />
              使っていないものだけ
            </label>
          </div>
          {!cleanup ? <div className="panel-bd faint">読み込み中…</div> : (
            <div className="panel-bd stack">
              <div className="row">
                <b>条件</b>
                <span className="faint">選択 {pickedLegacyConditions.length} 件</span>
                {editable && (<>
                  <button className="btn btn-sm" disabled={busy || !pickedLegacyConditions.length}
                          onClick={() => void cleanupRun("void")}>選択を無効化</button>
                  <button className="btn btn-sm" disabled={busy || !pickedLegacyConditions.length}
                          onClick={() => void cleanupRun("delete")}>選択を削除（無効化済みのみ）</button>
                </>)}
              </div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th></th><th>番号</th><th>向き</th><th>名前</th><th>相手先</th><th>作品</th>
                             <th>状態</th><th>指しているもの</th></tr></thead>
                  <tbody>
                    {cleanup.conditions.filter((c) => !onlyUnused || c.unused).slice(0, 300).map((c) => (
                      <tr key={c.id} aria-selected={cleanupChecked.has(`c${c.id}`)}>
                        <td><input type="checkbox" checked={cleanupChecked.has(`c${c.id}`)}
                                   onChange={() => toggleCleanup(`c${c.id}`)} /></td>
                        <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                        <td><span className={`tag ${c.direction}`}>{c.direction.toUpperCase()}</span></td>
                        <td>{c.name}</td>
                        <td>{c.counterparty ?? "—"}</td>
                        <td>{c.work ?? "—"}</td>
                        <td><StatusTag kind="condition" value={c.status} /></td>
                        <td className="faint">
                          {c.unused ? "（無し）" : [
                            c.used.events && `実績 ${c.used.events}`, c.used.documents && `文書 ${c.used.documents}`,
                            c.used.payments && `支払 ${c.used.payments}`, c.used.statements && `計算書 ${c.used.statements}`,
                            c.used.matters && `案件 ${c.used.matters}`, c.used.outRefs && `アウト参照 ${c.used.outRefs}`,
                            c.used.children && `派生 ${c.used.children}`
                          ].filter(Boolean).join("・")}
                        </td>
                      </tr>
                    ))}
                    {!cleanup.conditions.filter((c) => !onlyUnused || c.unused).length && (
                      <tr><td colSpan={8} className="faint">該当する条件はありません</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="row">
                <b>作品</b>
                <span className="faint">選択 {pickedLegacyWorks.length} 件。条件が1本も無い作品だけ削除できる</span>
                {editable && (<>
                  <button className="btn btn-sm" disabled={busy || !pickedLegacyWorks.length}
                          onClick={() => void cleanupRun("archive")}>選択を終了に</button>
                  <button className="btn btn-sm" disabled={busy || !pickedLegacyWorks.length}
                          onClick={() => void cleanupRun("delete-work")}>選択を削除（終了済みのみ）</button>
                </>)}
              </div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th></th><th>コード</th><th>題名</th><th>種別</th><th>状態</th><th>指しているもの</th></tr></thead>
                  <tbody>
                    {cleanup.works.filter((w) => !onlyUnused || w.unused).slice(0, 300).map((w) => (
                      <tr key={w.id} aria-selected={cleanupChecked.has(`w${w.id}`)}>
                        <td><input type="checkbox" checked={cleanupChecked.has(`w${w.id}`)}
                                   onChange={() => toggleCleanup(`w${w.id}`)} /></td>
                        <td className="code">{w.workCode ?? `#${w.id}`}</td>
                        <td><button className="btn btn-sm" onClick={() => setSelected(w.id)}>{w.title}</button></td>
                        <td>{KIND_LABEL[w.kind] ?? w.kind}</td>
                        <td><StatusTag kind="work" value={w.status} /></td>
                        <td className="faint">
                          {w.unused ? `（無し）${w.used.parts ? `パート ${w.used.parts}` : ""}` : [
                            w.used.conditions && `条件 ${w.used.conditions}`,
                            w.used.voidConditions && `無効化した条件 ${w.used.voidConditions}`,
                            w.used.children && `原作にしている作品 ${w.used.children}`
                          ].filter(Boolean).join("・")}
                        </td>
                      </tr>
                    ))}
                    {!cleanup.works.filter((w) => !onlyUnused || w.unused).length && (
                      <tr><td colSpan={6} className="faint">該当する作品はありません</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="ledger">
        {/* ---- 左：作品を選ぶ ---- */}
        <div className="panel">
          <div className="panel-hd">
            <h2>作品を選ぶ</h2>
            <span className="faint num">{tree.works.length}</span>
          </div>
          <div className="panel-bd stack" style={{ gap: 8 }}>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="作品名・コード・カナ" label="作品を絞り込む" />
            <div className="row" style={{ gap: 6 }}>
              {([["all", "すべて"], ["source", "原作"], ["work", "作品"]] as const).map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={kindFilter === v} onClick={() => setKindFilter(v)}>{l}</button>
              ))}
              <label className="ledger-check" style={{ marginLeft: "auto" }}>
                <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
                終了も
              </label>
            </div>
          </div>
          <div className="ledger-tree">
            {kindFilter !== "work" && grouped.sources.map((s) => (
              <div key={s.id} className="group">{renderNode(s)}</div>
            ))}
            {kindFilter !== "source" && grouped.loose.length > 0 && (
              <div className="group">
                {kindFilter === "all" && grouped.sources.length > 0 && (
                  <div className="faint" style={{ padding: "6px 8px 2px" }}>原作の付いていない作品</div>
                )}
                {(kindFilter === "work"
                  ? tree.works.filter((w) => w.kind !== "source_ip")
                  : grouped.loose).map((w) => renderNode(w))}
              </div>
            )}
            {!tree.works.length && (
              <div className="faint" style={{ padding: 8 }}>
                {search.trim() ? `「${search}」に一致する作品はありません` : "作品がありません"}
              </div>
            )}
          </div>
        </div>

        {/* ---- 右：選んだ作品 ---- */}
        <div className="stack">
          {!work && <div className="panel"><div className="panel-bd faint">左から作品を選んでください</div></div>}
          {work && (<>
            <div className="panel">
              <div className="panel-hd">
                <h2 className="code">{work.workCode ?? `#${work.id}`}</h2>
                <span className="tag accent">{KIND_LABEL[work.kind] ?? work.kind}</span>
                <StatusTag kind="work" value={work.status} />
                {work.legacy && <span className="tag">V2 から移行</span>}
                {work.mergedInto && (
                  <button className="btn btn-sm" onClick={() => setSelected(work.mergedInto!.id)}>
                    → {work.mergedInto.workCode ?? `#${work.mergedInto.id}`} {work.mergedInto.title} にまとめ済み
                  </button>
                )}
                {editable && !work.mergedInto && (
                  <span className="row" style={{ marginLeft: "auto" }}>
                    {!merging && work.status !== "archived" && (
                      <button className="btn btn-sm" disabled={busy} onClick={() => setMerging(true)}>別の作品に統合</button>
                    )}
                    {work.status !== "archived"
                      ? <button className="btn btn-sm" disabled={busy} onClick={() => void archiveWork()}>終了にする</button>
                      : <button className="btn btn-sm" disabled={busy} onClick={() => void removeWork()}>削除する</button>}
                    <button className="btn btn-sm primary" disabled={busy || !dirty || !form.title.trim()}
                            onClick={() => void saveWork()}>保存</button>
                  </span>
                )}
              </div>
              {merging && (
                <div className="panel-bd row" style={{ borderBottom: "1px solid var(--line)" }}>
                  <b>まとめる先</b>
                  <div style={{ minWidth: 320 }}>
                    <SearchSelect value={mergeTo} placeholder="残す側の作品を探す" autoFocus
                      options={moveOptions.filter((o) => {
                        const t = tree.works.find((x) => String(x.id) === o.value);
                        return t && t.status !== "archived" && !t.mergedIntoId;
                      })}
                      onChange={(v) => setMergeTo(v)} />
                  </div>
                  <button className="btn btn-sm primary" disabled={busy || !mergeTo} onClick={() => void mergeWork()}>統合する</button>
                  <button className="btn btn-sm" onClick={() => { setMerging(false); setMergeTo(""); }}>やめる</button>
                  <span className="faint">条件・パート・原作の繋がりを先へ移し、この作品は終了になります。系譜で繋がっている2つはまとめられません</span>
                </div>
              )}
              <div className="panel-bd ledger-form">
                <label className="field"><span>題名</span>
                  <input value={form.title ?? ""} disabled={!editable} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
                <label className="field"><span>カナ</span>
                  <input value={form.titleKana ?? ""} disabled={!editable} onChange={(e) => setForm({ ...form, titleKana: e.target.value })} /></label>
                <label className="field"><span>種別</span>
                  <select value={form.kind ?? "own"} disabled={!editable} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                    {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select></label>
                <label className="field"><span>状態</span>
                  <select value={form.status ?? "planning"} disabled={!editable} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select></label>
                <label className="field"><span>事業区分</span>
                  <input value={form.businessLine ?? ""} disabled={!editable} onChange={(e) => setForm({ ...form, businessLine: e.target.value })} /></label>
                <label className="field"><span>著作権表示</span>
                  <input value={form.copyrightNotice ?? ""} disabled={!editable} placeholder="© 2026 著作者名"
                         onChange={(e) => setForm({ ...form, copyrightNotice: e.target.value })} />
                  <small className="faint">出版条件書の一覧に出る</small></label>
                <label className="field"><span>共同著作・第三者権利</span>
                  <input value={form.thirdPartyRights ?? ""} disabled={!editable} placeholder="挿絵：◯◯ など。無ければ空"
                         onChange={(e) => setForm({ ...form, thirdPartyRights: e.target.value })} /></label>
                <label className="field wide"><span>備考</span>
                  <textarea value={form.remarks ?? ""} disabled={!editable} onChange={(e) => setForm({ ...form, remarks: e.target.value })} /></label>
              </div>
            </div>

            {/* 原作。作品の側から付け替える。原作の側からは、使っている作品が見える。 */}
            <div className="panel">
              <div className="panel-hd">
                <h2>{work.kind === "source_ip" ? "この原作を使う作品" : "原作（Core Logic）"}</h2>
                <span className="faint">
                  {work.kind === "source_ip" ? "作品の側で付け替える" : "複数付けられる。検索して足す"}
                </span>
              </div>
              <div className="panel-bd stack" style={{ gap: 8 }}>
                {work.kind === "source_ip" ? (
                  <div className="filters">
                    {work.children.map((c) => (
                      <button key={c.id} className="chip" onClick={() => setSelected(c.id)}>{c.title}</button>
                    ))}
                    {!work.children.length && <span className="faint">まだこの原作を使う作品がありません</span>}
                  </div>
                ) : (<>
                  <div className="filters">
                    {work.sources.map((s) => (
                      <span key={s.id} className="chip" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <button className="node" style={{ padding: 0, border: 0 }} onClick={() => setSelected(s.id)}>{s.title}</button>
                        {editable && (
                          <button className="btn btn-sm" title="外す" disabled={busy}
                                  onClick={() => void setSources(work.sources.filter((x) => x.id !== s.id).map((x) => x.id))}>×</button>
                        )}
                      </span>
                    ))}
                    {!work.sources.length && <span className="faint">原作が付いていません</span>}
                  </div>
                  {editable && (
                    <div className="row" style={{ alignItems: "flex-start" }}>
                      <div style={{ minWidth: 300, flex: "0 1 420px" }}>
                        <SearchSelect value="" options={sourceOptions.filter((o) => !work.sources.some((s) => String(s.id) === o.value))}
                          placeholder="原作名で探して足す" disabled={busy}
                          onChange={(v) => { if (v) void setSources([...work.sources.map((s) => s.id), Number(v)]); }} />
                      </div>
                      {!newSource && (
                        <button className="btn btn-sm" disabled={busy}
                                onClick={() => setNewSource({ title: keyword.trim(), titleKana: "" })}>
                          無ければ登録して付ける
                        </button>
                      )}
                    </div>
                  )}
                  {editable && newSource && (
                    <div className="note stack" style={{ gap: 8 }}>
                      <b>原作（Core Logic）を新しく登録して、この作品に付ける</b>
                      <div className="ledger-form">
                        <label className="field"><span>原作名</span>
                          <input autoFocus value={newSource.title}
                                 onChange={(e) => setNewSource({ ...newSource, title: e.target.value })}
                                 onKeyDown={(e) => { if (e.key === "Enter") void createSourceAndAttach(); }} /></label>
                        <label className="field"><span>カナ</span>
                          <input value={newSource.titleKana}
                                 onChange={(e) => setNewSource({ ...newSource, titleKana: e.target.value })} /></label>
                      </div>
                      <div className="row">
                        <button className="btn btn-sm primary" disabled={busy || !newSource.title.trim()}
                                onClick={() => void createSourceAndAttach()}>登録して付ける</button>
                        <button className="btn btn-sm" onClick={() => setNewSource(null)}>やめる</button>
                      </div>
                    </div>
                  )}
                </>)}
              </div>
            </div>

            {/* パート。名前・種別・課金対象をその場で直す。畳んでおく（毎回は見ない）。 */}
            <details className="panel" open={work.parts.length > 0 || creating === "part"}>
              <summary className="panel-hd" style={{ cursor: "pointer" }}>
                <h2 style={{ display: "inline" }}>構成パート</h2>
                <span className="faint" style={{ marginLeft: 8 }}>{work.parts.length} 件</span>
                {editable && creating === null && (
                  <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setCreating("part")}>パートを追加</button>
                )}
              </summary>
              {creating === "part" && (
                <div className="panel-bd">
                  <CreateForm title="構成パートの追加" path={`/works/${work.id}/parts`}
                    initial={{ partType: "unspecified", royaltyBearing: "1" }}
                    fields={[
                      { name: "name", label: "パート名", required: true, placeholder: "本文 / 挿絵 / Original_Core_Logic など" },
                      { name: "partType", label: "種類", type: "select", options: PART_TYPES },
                      { name: "royaltyBearing", label: "ロイヤリティの対象", type: "checkbox" },
                      { name: "remarks", label: "備考", type: "textarea" }
                    ]}
                    toPayload={(v) => ({ name: text(v.name), partType: text(v.partType),
                                         royaltyBearing: v.royaltyBearing === "1", remarks: text(v.remarks) })}
                    onDone={() => { setCreating(null); void reloadWork(); void reloadTree(); }}
                    onCancel={() => setCreating(null)} />
                </div>
              )}
              <div className="tablewrap">
                <table>
                  <thead><tr><th>No</th><th>名称</th><th>種類</th><th>課金</th><th></th></tr></thead>
                  <tbody>
                    {work.parts.map((p) => (
                      <tr key={p.id}>
                        <td className="num">{p.partNo}</td>
                        <td>
                          <input className="inline-input" defaultValue={p.name} disabled={!editable}
                                 onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== p.name) void savePart(p, { name: v }); }} />
                        </td>
                        <td>
                          <select className="inline-input" value={p.partType} disabled={!editable}
                                  onChange={(e) => void savePart(p, { partType: e.target.value })}>
                            {PART_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            {!PART_TYPES.some((o) => o.value === p.partType) && <option value={p.partType}>{p.partType}</option>}
                          </select>
                        </td>
                        <td>
                          <label className="ledger-check">
                            <input type="checkbox" checked={p.royaltyBearing} disabled={!editable}
                                   onChange={(e) => void savePart(p, { royaltyBearing: e.target.checked })} />
                            {p.royaltyBearing ? "対象" : "対象外"}
                          </label>
                        </td>
                        <td>{editable && <button className="btn btn-sm" onClick={() => void removePart(p)}>削除</button>}</td>
                      </tr>
                    ))}
                    {!work.parts.length && <tr><td colSpan={5} className="faint">パートがありません</td></tr>}
                  </tbody>
                </table>
              </div>
            </details>

            {/* 条件（取引モデル）。ここで直すのは頭だけ。中身は条件明細へ。 */}
            <div className="panel">
              <div className="panel-hd">
                <h2>条件</h2>
                <span className="faint">利用形態ごとに1本　{conditions.length} 件</span>
                <label className="ledger-check" style={{ marginLeft: "auto" }}>
                  <input type="checkbox" checked={includeVoid} onChange={(e) => setIncludeVoid(e.target.checked)} />
                  無効化済みも
                </label>
                {editable && creating === null && (
                  <button className="btn btn-sm primary" onClick={() => setCreating("condition")}>条件を登録</button>
                )}
                {editable && creating === null && (
                  <button className="btn btn-sm" onClick={() => setCreating("license")}
                          title="この作品の自社製造・再許諾・他社販売の条件を1回で作る">
                    許諾セット（ゲーム）
                  </button>
                )}
                {editable && creating === null && (
                  <button className="btn btn-sm" onClick={() => setCreating("publishing")}
                          title="この作品の紙・電子の条件を1回で作る。出版条件書はこの2本を1行に畳んで出す">
                    出版セット（紙・電子）
                  </button>
                )}
              </div>
              {creating === "condition" && (
                <div className="panel-bd">
                  <ConditionCreateForm preset={{ workId: String(work.id) }}
                    onDone={() => { setCreating(null); void reloadWork(); void reloadTree(); }}
                    onCancel={() => setCreating(null)} />
                </div>
              )}
              {creating === "publishing" && (
                <div className="panel-bd">
                  <PubConditionSetForm preset={{ workId: String(work.id) }}
                    onDone={() => { setCreating(null); void reloadWork(); void reloadTree(); }}
                    onCancel={() => setCreating(null)} />
                </div>
              )}
              {creating === "license" && (
                <div className="panel-bd">
                  <LicenseSetForm preset={{ workId: String(work.id) }}
                    onDone={() => { setCreating(null); void reloadWork(); void reloadTree(); }}
                    onCancel={() => setCreating(null)} />
                </div>
              )}
              {editable && picked.length > 0 && (
                <div className="panel-bd row" style={{ borderBottom: "1px solid var(--line)" }}>
                  <b>選択 {picked.length} 件</b>
                  {onCompose && (
                    <button className="btn btn-sm primary" disabled={busy}
                            title="選んだ条件を載せた状態で文書の画面へ移る（条件書・計算書）"
                            onClick={() => onCompose(picked.map((c) => c.id))}>この条件で文書を作る</button>
                  )}
                  <button className="btn btn-sm" disabled={busy} onClick={() => void voidPicked()}>無効化</button>
                  {!moving
                    ? <button className="btn btn-sm" disabled={busy} onClick={() => setMoving(true)}>別の作品へ移す</button>
                    : (<>
                        <div style={{ minWidth: 280 }}>
                          <SearchSelect value={moveTo} options={moveOptions} placeholder="移す先の作品を探す"
                            onChange={(v) => setMoveTo(v)} />
                        </div>
                        <button className="btn btn-sm primary" disabled={busy || !moveTo} onClick={() => void movePicked()}>移す</button>
                        <button className="btn btn-sm" onClick={() => { setMoving(false); setMoveTo(""); }}>やめる</button>
                      </>)}
                  <button className="btn btn-sm" onClick={() => setChecked(new Set())}>選択を外す</button>
                </div>
              )}
              <div className="tablewrap">
                <table>
                  <thead><tr>
                    <th>{editable && (
                      <input type="checkbox" aria-label="全部選ぶ"
                             checked={conditions.some((c) => c.status !== "void") && checked.size === conditions.filter((c) => c.status !== "void").length}
                             onChange={(e) => setChecked(e.target.checked ? new Set(conditions.filter((c) => c.status !== "void").map((c) => c.id)) : new Set())} />
                    )}</th>
                    <th>番号</th><th>向き</th><th>利用形態</th><th>名前</th><th>相手先</th>
                    <th>計算</th><th>期間</th><th>状態</th><th></th>
                  </tr></thead>
                  <tbody>
                    {conditions.map((c) => (
                      <tr key={c.id} aria-selected={checked.has(c.id)}>
                        <td>{editable && c.status !== "void" && <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} />}</td>
                        <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                        <td><span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span></td>
                        <td>{c.usageType ? conditionUsageLabel(c.usageType)
                              : <span className="faint">{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span>}</td>
                        <td>{c.name}</td>
                        <td>{c.counterparty?.name ?? "—"}</td>
                        <td className="faint" style={{ whiteSpace: "nowrap" }}>{pricingSummary(c)}</td>
                        <td className="code">{c.termStart ?? "—"} → {c.termEnd ?? "—"}</td>
                        <td><StatusTag kind="condition" value={c.status} /></td>
                        <td className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                          {editable && c.status !== "superseded" && c.status !== "void" && (
                            <button className="btn btn-sm" onClick={() => void openEdit(c.id)}>編集</button>
                          )}
                          {editable && c.status === "void" && (
                            <button className="btn btn-sm" disabled={busy} onClick={() => void removeCondition(c)}>削除</button>
                          )}
                          <button className="btn btn-sm" onClick={() => onOpenCondition(c.id)}>条件明細</button>
                        </td>
                      </tr>
                    ))}
                    {!conditions.length && <tr><td colSpan={10} className="faint">この作品に条件がありません</td></tr>}
                  </tbody>
                </table>
              </div>
              {editing && (
                <div className="panel-bd">
                  <ConditionEdit detail={editing}
                    onCancel={() => setEditing(null)}
                    onDone={(r: EditResult) => {
                      setEditing(null);
                      setNotice(r.revisedTo
                        ? `実績があるので改訂しました（新しい版 #${r.revisedTo}）`
                        : "条件を保存しました");
                      void reloadWork(); void reloadTree();
                    }} />
                </div>
              )}
            </div>

            {/* 権利の上限。畳んでおく。作り替えの作業では毎回は見ない。 */}
            {envelope && (
              <details className="panel">
                <summary className="panel-hd" style={{ cursor: "pointer" }}>
                  <h2 style={{ display: "inline" }}>許諾できる上限</h2>
                  <span className="faint" style={{ marginLeft: 8 }}>取得条件 {envelope.acquiredCount} 件の積</span>
                </summary>
                <div className="panel-bd">
                  {envelope.acquiredCount === 0 ? (
                    <div className="note">取得条件が無いので上限が決まりません。展開の照合もできません。</div>
                  ) : (
                    <table>
                      <thead><tr><th>次元</th><th>上限</th><th>狭めている取得条件</th></tr></thead>
                      <tbody>
                        {envelope.scopes.map((s) => (
                          <tr key={s.scopeType}>
                            <td>{DIMENSION_LABEL[s.scopeType] ?? s.scopeType}</td>
                            <td>{s.values.map((x) => x.label).join("・")}</td>
                            <td className="faint">—</td>
                          </tr>
                        ))}
                        <tr><td>期間</td><td>{envelope.termLimit ? `${envelope.termLimit} まで` : "期限なし"}</td>
                            <td className="code faint">{envelope.termLimitedBy ?? "—"}</td></tr>
                        <tr><td>独占</td><td>{envelope.exclusivityLimit === "non_exclusive" ? "非独占のみ"
                          : envelope.exclusivityLimit === "exclusive" ? "独占可" : "—"}</td>
                            <td className="code faint">{envelope.exclusivityLimitedBy ?? "—"}</td></tr>
                        <tr><td>再許諾</td><td>{envelope.sublicensable ? "可" : "不可"}</td>
                            <td className="code faint">{envelope.sublicenseLimitedBy ?? "—"}</td></tr>
                      </tbody>
                    </table>
                  )}
                </div>
              </details>
            )}

            {/* つながりと動き。作り替えの作業では毎回は見ないので畳んでおく。 */}
            <details className="ledger-more">
              <summary className="faint" style={{ cursor: "pointer", padding: "4px 0" }}>
                つながり（案件・文書・契約）と、この作品の動き（実績・計算書・支払）を見る
              </summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <Relations kind="work" id={work.id} onOpen={onOpen} />
                {activity && <WorkActivity activity={activity} onOpen={onOpen} />}
              </div>
            </details>
          </>)}
        </div>
      </div>
    </section>
  );
}

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  planned: "予定", approved: "承認済み", paid: "支払済み", canceled: "取消"
};

/**
 * 作品の動き。実績 → 計算書 → 文書 → 支払 の順に並べる。
 * 権利の話（上限・展開）とは別の軸なので、パネルを分けてある。
 */
function WorkActivity(
  { activity, onOpen }: { activity: Activity; onOpen?: (kind: EntityKind, id: number) => void }
) {
  const paid = activity.payments.filter((p) => p.status === "paid").length;
  const sum = (rows: Array<{ netAmount: number }>) =>
    rows.reduce((total, r) => total + r.netAmount, 0);
  const currency = activity.statements[0]?.currency ?? "JPY";

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>この作品の動き</h2>
        <span className="faint">
          実績 <b className="num">{activity.events.length}</b> 件 ／
          計算書 <b className="num">{activity.statements.length}</b> 件 ／
          文書 <b className="num">{activity.documents.length}</b> 件 ／
          支払 <b className="num">{activity.payments.length}</b> 件（うち支払済み {paid} 件）
        </span>
      </div>
      <div className="panel-bd stack">
        {activity.statements.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <div className="row">
              <b>計算書</b>
              <span className="faint">
                実額の合計 {money(sum(activity.statements), currency)}（税抜）
              </span>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>文書番号</th><th>取引モデル</th><th>期間</th>
                           <th className="num">実額（税抜）</th><th></th></tr></thead>
                <tbody>
                  {activity.statements.slice(0, 10).map((s) => (
                    <tr key={s.id}>
                      <td className="code">{s.documentNo ?? `#${s.documentId}`}</td>
                      <td>{s.conditionName}</td>
                      <td>{s.period}</td>
                      <td className="num">{money(s.netAmount, s.currency)}</td>
                      <td>
                        {onOpen && (
                          <button className="btn btn-sm"
                                  onClick={() => onOpen("document", s.documentId)}>開く</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activity.events.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>実績</b>
            <div className="tablewrap">
              <table>
                <thead><tr><th>発生日</th><th>取引モデル</th><th>種類</th><th>期間</th>
                           <th className="num">数量</th><th className="num">金額</th>
                           <th>結んだ文書</th></tr></thead>
                <tbody>
                  {activity.events.slice(0, 10).map((e) => (
                    <tr key={e.id}>
                      <td className="code">{e.occurredOn ?? "—"}</td>
                      <td>{e.conditionName}</td>
                      <td>{EVENT_TYPE_LABEL[e.eventType] ?? e.eventType}</td>
                      <td>{e.period ?? "—"}</td>
                      <td className="num">{e.quantity ?? "—"}</td>
                      <td className="num">{money(e.amount, e.currency)}</td>
                      <td className="code faint">{e.documentNo ?? "（未結）"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {activity.events.length > 10 && (
              <span className="faint">直近 10 件。残りは条件明細の実績で見られます</span>
            )}
          </div>
        )}

        {activity.payments.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>支払・入金</b>
            <div className="tablewrap">
              <table>
                <thead><tr><th>支払番号</th><th>相手先</th><th>向き</th>
                           <th className="num">金額</th><th>期日</th><th>状態</th></tr></thead>
                <tbody>
                  {activity.payments.slice(0, 10).map((p) => (
                    <tr key={p.id}>
                      <td className="code">{p.paymentNo ?? `#${p.id}`}</td>
                      <td>{p.partyName ?? "—"}</td>
                      <td>{p.direction === "in" ? "入金" : "支払"}</td>
                      <td className="num">{money(p.amount, p.currency)}</td>
                      <td className="code">{p.dueOn ?? "—"}</td>
                      <td>{PAYMENT_STATUS_LABEL[p.status] ?? p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activity.documents.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>文書</b>
            <div className="picker">
              {activity.documents.slice(0, 20).map((d) => (
                <button key={d.id} className="btn btn-sm" style={{ textAlign: "left" }}
                        disabled={!onOpen} onClick={() => onOpen?.("document", d.id)}>
                  <span className="code">{d.documentNo ?? "（下書き）"}</span>
                  {" "}{d.templateLabel ?? "—"}
                </button>
              ))}
            </div>
          </div>
        )}

        {!activity.events.length && !activity.statements.length
          && !activity.documents.length && !activity.payments.length && (
          <div className="faint">
            この作品ではまだ実績も文書も動いていません。条件明細に実績を入れると、ここに並びます。
          </div>
        )}
      </div>
    </div>
  );
}
