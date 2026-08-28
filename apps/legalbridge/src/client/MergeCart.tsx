import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";

// 統合カート（V1 の MergeCart / MatterMergeCart 相当）。
//   画面遷移しながら対象を「籠」に集め、最後にまとめて処理する。
//   ・課題カート：Backlog課題を集めて「新規案件を作成して束ねる」/「既存案件へ紐づけ」
//   ・案件カート：案件を集めて、残す1件（👑）へ他をまとめて統合する
//   キーの手入力を避け、件名を見ながら統合先を選べるようにするのが目的。
//   保存先は sessionStorage（タブを閉じれば消える。V1 と同じ挙動）。

export type CartKind = "issue" | "matter";
export type CartItem = { key: string; label: string; note?: string };

const STORAGE_PREFIX = "legalbridge.v2.cart.";

type CartState = { items: CartItem[]; targetKey: string | null };
const EMPTY: CartState = { items: [], targetKey: null };

function load(kind: CartKind): CartState {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${kind}`);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<CartState>;
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((item): item is CartItem => Boolean(item && typeof item.key === "string" && item.key))
      .map((item) => ({ key: String(item.key), label: String(item.label ?? item.key), note: item.note ? String(item.note) : undefined }));
    const targetKey = typeof parsed.targetKey === "string" && items.some((i) => i.key === parsed.targetKey)
      ? parsed.targetKey : null;
    return { items, targetKey };
  } catch { return EMPTY; }
}

// カートの購読（同一タブ内の複数コンポーネントで状態を共有する）。
const listeners = new Map<CartKind, Set<() => void>>();
function notify(kind: CartKind) {
  for (const listener of listeners.get(kind) ?? []) listener();
}

export function useCart(kind: CartKind) {
  const [state, setState] = useState<CartState>(() => load(kind));

  useEffect(() => {
    const listener = () => setState(load(kind));
    const set = listeners.get(kind) ?? new Set();
    set.add(listener);
    listeners.set(kind, set);
    return () => { set.delete(listener); };
  }, [kind]);

  const persist = useCallback((next: CartState) => {
    try { sessionStorage.setItem(`${STORAGE_PREFIX}${kind}`, JSON.stringify(next)); } catch { /* 保存できなくても操作は継続 */ }
    setState(next);
    notify(kind);
  }, [kind]);

  const add = useCallback((item: CartItem) => {
    const current = load(kind);
    if (current.items.some((i) => i.key === item.key)) return;
    persist({ items: [...current.items, item], targetKey: current.targetKey ?? item.key });
  }, [kind, persist]);

  const remove = useCallback((key: string) => {
    const current = load(kind);
    const items = current.items.filter((i) => i.key !== key);
    persist({ items, targetKey: current.targetKey === key ? (items[0]?.key ?? null) : current.targetKey });
  }, [kind, persist]);

  const clear = useCallback(() => persist(EMPTY), [persist]);
  const setTarget = useCallback((key: string) => {
    const current = load(kind);
    persist({ ...current, targetKey: key });
  }, [kind, persist]);

  const has = useCallback((key: string) => state.items.some((i) => i.key === key), [state.items]);

  return { items: state.items, targetKey: state.targetKey, add, remove, clear, setTarget, has };
}

// カート投入ボタン（一覧の各行に置く）。
export function CartButton({ kind, item, label = "カートに入れる" }: {
  kind: CartKind; item: CartItem; label?: string;
}) {
  const cart = useCart(kind);
  const inCart = cart.has(item.key);
  return <button type="button" className={inCart ? "" : "link-button"}
    onClick={() => inCart ? cart.remove(item.key) : cart.add(item)}
    title={inCart ? "カートから外す" : "統合・案件化のためカートに集める"}>
    {inCart ? "カートから外す" : label}
  </button>;
}

type MatterOption = { id: number; title: string; matterCode: string | null };

// 画面右下に常駐するカートパネル。中身があるときだけ表示する。
export function CartPanel({ onOpenMatter }: { onOpenMatter?: (matterId: number) => void }) {
  const issueCart = useCart("issue");
  const matterCart = useCart("matter");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CartKind>("issue");
  const total = issueCart.items.length + matterCart.items.length;

  useEffect(() => {
    // 中身のある方を既定タブにする。
    if (issueCart.items.length === 0 && matterCart.items.length > 0) setTab("matter");
    if (matterCart.items.length === 0 && issueCart.items.length > 0) setTab("issue");
  }, [issueCart.items.length, matterCart.items.length]);

  if (total === 0) return null;
  return <>
    <button type="button" className="cart-fab" onClick={() => setOpen((v) => !v)}
      title="統合カートを開く／閉じる">
      🧺 統合カート<span className="cart-count">{total}</span>
    </button>
    {open && <section className="cart-panel panel">
      <div className="cart-tabs">
        <button type="button" className={tab === "issue" ? "active" : ""} onClick={() => setTab("issue")}>
          課題 {issueCart.items.length}
        </button>
        <button type="button" className={tab === "matter" ? "active" : ""} onClick={() => setTab("matter")}>
          案件 {matterCart.items.length}
        </button>
        <button type="button" className="cart-close" onClick={() => setOpen(false)} title="閉じる">×</button>
      </div>
      {tab === "issue"
        ? <IssueCart cart={issueCart} onOpenMatter={onOpenMatter} />
        : <MatterCart cart={matterCart} onOpenMatter={onOpenMatter} />}
    </section>}
  </>;
}

// 課題カート：集めた課題を新規案件へ束ねる／既存案件へ紐づける。
function IssueCart({ cart, onOpenMatter }: {
  cart: ReturnType<typeof useCart>; onOpenMatter?: (matterId: number) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [matters, setMatters] = useState<MatterOption[]>([]);
  const primary = cart.targetKey ?? cart.items[0]?.key ?? null;
  const primaryLabel = useMemo(
    () => cart.items.find((i) => i.key === primary)?.label ?? "", [cart.items, primary]);

  useEffect(() => { if (!title.trim() && primaryLabel) setTitle(primaryLabel); }, [primaryLabel]);

  useEffect(() => {
    if (!query.trim()) { setMatters([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/v2/matters?q=${encodeURIComponent(query)}&limit=8`, { signal: controller.signal })
        .then((r) => r.ok ? r.json() : Promise.reject(new Error("matter search failed")))
        .then((d) => setMatters((d.matters ?? []).map((m: MatterOption) => ({ id: m.id, title: m.title, matterCode: m.matterCode ?? null }))))
        .catch((e) => { if (e.name !== "AbortError") setMatters([]); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  // 1課題を案件へ紐づける。失敗したキーを返す（成功なら null）。
  async function link(matterId: number, item: CartItem, relation: "primary" | "related") {
    const response = await fetch(`/api/v2/matters/${matterId}/issues`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backlogIssueKey: item.key, relation, summarySnapshot: item.label || null })
    });
    return response.ok ? null : item.key;
  }

  async function createMatter() {
    if (!title.trim() || !primary) return;
    setBusy(true);
    try {
      const response = await fetch("/api/v2/matters", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), status: "open", primaryIssueKey: primary })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { toast.push(data.error ?? "案件を作成できませんでした。", "error"); return; }
      const matterId = Number(data.matter?.id ?? data.id);
      const others = cart.items.filter((i) => i.key !== primary);
      const failed: string[] = [];
      for (const item of others) {
        const failedKey = await link(matterId, item, "related");
        if (failedKey) failed.push(failedKey);
      }
      toast.push(
        `案件を作成し${cart.items.length - failed.length}/${cart.items.length}件の課題を束ねました` +
        (failed.length ? `（紐づけ失敗：${failed.join("、")}）` : ""),
        failed.length ? "info" : "success");
      if (!failed.length) { cart.clear(); setTitle(""); }
      if (Number.isFinite(matterId)) onOpenMatter?.(matterId);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusy(false); }
  }

  async function linkExisting(matterId: number) {
    setBusy(true);
    try {
      const failed: string[] = [];
      for (const item of cart.items) {
        const failedKey = await link(matterId, item, item.key === primary ? "primary" : "related");
        if (failedKey) failed.push(failedKey);
      }
      toast.push(
        `${cart.items.length - failed.length}/${cart.items.length}件を既存案件へ紐づけました` +
        (failed.length ? `（失敗：${failed.join("、")}）` : ""),
        failed.length ? "info" : "success");
      if (!failed.length) cart.clear();
      onOpenMatter?.(matterId);
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusy(false); }
  }

  return <div className="cart-body">
    <p className="muted-note">👑が主要課題になります。残りは関連課題として同じ案件に紐づきます。</p>
    <ul className="cart-items">
      {cart.items.map((item) => <li key={item.key}>
        <label title="主要課題にする">
          <input type="radio" name="issue-cart-primary" checked={primary === item.key}
            onChange={() => cart.setTarget(item.key)} /> 👑
        </label>
        <span className="cart-item-key">{item.key}</span>
        <span className="cart-item-label">{item.label}</span>
        <button type="button" className="link-button" onClick={() => cart.remove(item.key)}>外す</button>
      </li>)}
    </ul>
    <label>新しい案件名<input value={title} onChange={(e) => setTitle(e.target.value)}
      placeholder="主要課題の件名が既定値です" maxLength={500} /></label>
    <div className="cart-actions">
      <button className="primary" disabled={busy || !title.trim() || !cart.items.length} onClick={() => void createMatter()}>
        {busy ? "処理中…" : "新規案件を作成して束ねる"}
      </button>
      <button disabled={busy} onClick={() => cart.clear()}>カートを空にする</button>
    </div>
    <label>既存案件へ紐づける<input value={query} onChange={(e) => setQuery(e.target.value)}
      placeholder="案件名・案件コードで検索" /></label>
    {matters.map((matter) => <button key={matter.id} type="button" className="cart-option"
      disabled={busy} onClick={() => void linkExisting(matter.id)}>
      {matter.matterCode ? `${matter.matterCode}／` : ""}{matter.title}
    </button>)}
  </div>;
}

// 案件カート：残す1件（👑）へ他をまとめて統合する（既存の /matter-merge を順に実行）。
const MATTER_MERGE_TOKEN = "COMMIT_MATTER_MERGE";

function MatterCart({ cart, onOpenMatter }: {
  cart: ReturnType<typeof useCart>; onOpenMatter?: (matterId: number) => void;
}) {
  const toast = useToast();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const target = cart.targetKey ?? cart.items[0]?.key ?? null;
  const sources = cart.items.filter((i) => i.key !== target);
  // 合言葉のスペル違いのまま実行して「理由の分からない全件失敗」になった実績があるため、
  // 一致するまでボタンを無効化し、入力中は不一致を明示する。
  const tokenOk = confirmation.trim() === MATTER_MERGE_TOKEN;

  async function merge() {
    if (!target || !sources.length || !tokenOk) return;
    if (!window.confirm(
      `${sources.map((s) => s.label).join("、")} を「${cart.items.find((i) => i.key === target)?.label}」へ統合します。統合元はアーカイブされます。よろしいですか？`
    )) return;
    setBusy(true);
    try {
      const failed: string[] = [];
      let reason = "";
      for (const source of sources) {
        const response = await fetch("/api/v2/matter-merge", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: Number(target), sourceId: Number(source.key), confirmation: confirmation.trim() })
        });
        if (!response.ok) {
          failed.push(source.label);
          if (!reason) {
            const data = await response.json().catch(() => ({} as Record<string, unknown>));
            reason = String(data.error ?? "") === "invalid request"
              ? String((data.issues as Array<{ message?: string }> | undefined)?.[0]?.message ?? "invalid request")
              : String(data.error ?? `HTTP ${response.status}`);
          }
        } else cart.remove(source.key);
      }
      toast.push(
        `${sources.length - failed.length}/${sources.length}件を統合しました` +
        (failed.length ? `（失敗：${failed.join("、")}／理由: ${reason}）` : ""),
        failed.length ? "error" : "success");
      if (!failed.length) { cart.clear(); setConfirmation(""); onOpenMatter?.(Number(target)); }
    } catch { toast.push("通信に失敗しました。", "error"); }
    finally { setBusy(false); }
  }

  return <div className="cart-body">
    <p className="muted-note">👑が残る案件（統合先）です。他はここへ寄せてアーカイブされます。</p>
    <ul className="cart-items">
      {cart.items.map((item) => <li key={item.key}>
        <label title="統合先（残す案件）にする">
          <input type="radio" name="matter-cart-target" checked={target === item.key}
            onChange={() => cart.setTarget(item.key)} /> 👑
        </label>
        <span className="cart-item-label">{item.label}</span>
        {item.note && <span className="cart-item-key">{item.note}</span>}
        <button type="button" className="link-button" onClick={() => cart.remove(item.key)}>外す</button>
      </li>)}
    </ul>
    <label>合言葉<input value={confirmation} onChange={(e) => setConfirmation(e.target.value)}
      placeholder={MATTER_MERGE_TOKEN} /></label>
    {confirmation.trim() !== "" && !tokenOk &&
      <p className="muted-note">合言葉が一致していません（{MATTER_MERGE_TOKEN} を入力してください）。</p>}
    <div className="cart-actions">
      <button className="primary" disabled={busy || sources.length === 0 || !tokenOk}
        onClick={() => void merge()}>{busy ? "統合中…" : `${sources.length}件を統合`}</button>
      <button disabled={busy} onClick={() => cart.clear()}>カートを空にする</button>
    </div>
  </div>;
}
