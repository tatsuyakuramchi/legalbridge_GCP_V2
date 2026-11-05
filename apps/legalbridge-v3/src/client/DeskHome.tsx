import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { useDebounced } from "./ListTools.js";
import { WorkLedger } from "./WorkLedger.js";
import { WorkRounds } from "./RoundsOverview.js";
import type { EntityKind } from "./Relations.js";

/**
 * ホーム（docs/desk-home.md）。上に「今日やること」、下に畳んだ「作業台」。
 *
 * 軽さが目的なので、開いたときに読むのは「今日やること」だけ（/desk/today。1 分覚える）。
 * 作業台は開いたとき（または今日やることの行を押したとき）に初めてツリーの一段目を読み、
 * 取引先の下（契約）は枝を開いたときに読む。右の中身は既存の工程表（WorkLedger）と
 * 回と文書（WorkRounds）をそのまま使う。開いた・畳んだと切り口はこの端末に覚えておく。
 */

type Root = "party" | "matter" | "work";
type When = "over" | "today" | "week" | "later" | "none";

export interface TodayItem {
  key: string; kind: "intake" | "task" | "deadline"; source: string | null;
  refId: number; refNo: string | null; title: string; sub: string | null; dueOn: string | null;
  when: When; updated: boolean; desk: { root: Root; id: number } | null;
}
interface Today { items: TodayItem[]; counts: { over: number; today: number; week: number; total: number }; at: string }
interface DeskNode {
  key: string; kind: "party" | "agreement" | "loose" | "matter" | "work"; id: number | null;
  label: string; sub: string | null; count: number; expandable: boolean; agreementIds?: number[];
}
interface Selected { node: DeskNode; partyId: number | null }

const OPEN_KEY = "lb.desk.open";
const ROOT_KEY = "lb.desk.root";
const SHOWN = 5;
const ROOTS: Array<[Root, string]> = [["party", "取引先"], ["matter", "案件"], ["work", "作品"]];
const KIND_LABEL: Record<TodayItem["kind"], string> = { intake: "依頼", task: "作業", deadline: "期限" };
const KIND_TAG: Record<TodayItem["kind"], string> = { intake: "tag accent", task: "tag", deadline: "tag warn" };
const DEADLINE_ACTION: Record<string, string> = { matter: "案件を開く", agreement: "契約を開く", payment: "支払を開く", schedule: "取引管理を開く" };

const load = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* 覚えられなくても動く */ } };

const dueLabel = (it: TodayItem) => {
  if (it.when === "over") return `期限切れ ${it.dueOn?.slice(5).replace("-", "/") ?? ""}`;
  if (it.when === "today") return it.dueOn ? "今日" : "今日（期日なし）";
  if (it.when === "none") return "期日なし";
  return it.dueOn?.slice(5).replace("-", "/") ?? "";
};
const actionLabel = (it: TodayItem) =>
  it.kind === "intake" ? "受付箱で開く" : it.kind === "task" ? "作業を開く" : DEADLINE_ACTION[it.source ?? ""] ?? "開く";

export function DeskHome(props: {
  /** home＝今日やること + 畳んだ作業台。desk＝作業台だけを全幅で（メニューの「作業台」）。 */
  mode?: "home" | "desk";
  /** 今日やることの行の「開く」。受付箱・デイリータスク・期限の元の画面へ。 */
  onOpenItem: (item: TodayItem) => void;
  /** 作業台の中身の見出しから、元の画面（案件・取引先・作品・契約）を開く。 */
  onOpen: (kind: EntityKind, id: number) => void;
  onOpenCondition: (id: number) => void;
  onOpenDocument: (id: number) => void;
  onCompose: (conditionIds: number[], eventIds: number[], matterId: number | null, templateKey: string | null) => void;
  onOpenDeals: (conditionId: number) => void;
  /** 以前のホーム（盤面）を出す。重い集計が走るので、押したときだけ。 */
  onShowBoard?: () => void;
}) {
  const isDesk = props.mode === "desk";
  const [today, setToday] = useState<Today | null>(null);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  const [openSaved, setOpen] = useState(() => load(OPEN_KEY) === "1");
  // 全幅の作業台はいつも開いている（開閉は覚えない）。
  const open = isDesk || openSaved;
  const [root, setRoot] = useState<Root>(() => (["party", "matter", "work"].includes(load(ROOT_KEY) ?? "") ? load(ROOT_KEY) as Root : "party"));
  const [q, setQ] = useState("");
  const query = useDebounced(q, 300);
  const [nodes, setNodes] = useState<DeskNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [kids, setKids] = useState<Record<number, DeskNode[] | "loading">>({});
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Selected | null>(null);
  const [version, setVersion] = useState(0);

  // 今日やること：自分（IAP のメール → 担当者）のデイリータスクで絞る。分からなければ全員。
  useEffect(() => {
    if (isDesk) return;
    let alive = true;
    (async () => {
      let assignee = "";
      try {
        const me = await api.get<{ user?: { email?: string } }>("/me");
        const email = me.user?.email?.toLowerCase();
        if (email) {
          const staff = await api.get<{ staff: Array<{ id: number; email: string | null }> }>("/staff");
          const mine = staff.staff.find((s) => s.email?.toLowerCase() === email);
          if (mine) assignee = `?assignee=${mine.id}`;
        }
      } catch { /* 担当が分からなくても全員ぶんで出す */ }
      try {
        const r = await api.get<Today>(`/desk/today${assignee}`);
        if (alive) { setToday(r); setTodayError(null); }
      } catch (e) {
        if (alive) setTodayError((e as ApiError).message);
      }
    })();
    return () => { alive = false; };
  }, [isDesk]);

  // 作業台のツリーの一段目：開いているときだけ読む。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTreeError(null);
    const qs = new URLSearchParams({ root });
    if (query.trim()) qs.set("q", query.trim());
    api.get<{ nodes: DeskNode[] }>(`/desk/tree?${qs}`)
      .then((r) => { if (alive) setNodes(r.nodes); })
      .catch((e: ApiError) => { if (alive) { setTreeError(e.message); setNodes([]); } });
    return () => { alive = false; };
  }, [open, root, query]);

  const setOpenSaved = (v: boolean) => { if (isDesk) return; setOpen(v); save(OPEN_KEY, v ? "1" : "0"); };
  const switchRoot = (r: Root) => {
    if (r === root) return;
    setRoot(r); save(ROOT_KEY, r); setNodes(null); setSelected(null); setExpanded(new Set());
  };

  const loadKids = (partyId: number) => {
    if (kids[partyId]) return;
    setKids((k) => ({ ...k, [partyId]: "loading" }));
    api.get<{ nodes: DeskNode[] }>(`/desk/tree/party/${partyId}`)
      .then((r) => setKids((k) => ({ ...k, [partyId]: r.nodes })))
      .catch(() => setKids((k) => { const n = { ...k }; delete n[partyId]; return n; }));
  };
  const toggle = (partyId: number) => {
    const next = new Set(expanded);
    if (next.has(partyId)) next.delete(partyId); else { next.add(partyId); loadKids(partyId); }
    setExpanded(next);
  };

  /** 今日やることの行を押した：作業台を開いて、その相手（案件・取引先）を選ぶ。 */
  const focusItem = (it: TodayItem) => {
    setActive(it.key);
    if (!it.desk) return;
    setOpenSaved(true);
    if (it.desk.root !== root) { setRoot(it.desk.root); save(ROOT_KEY, it.desk.root); setNodes(null); setExpanded(new Set()); }
    const kind = it.desk.root;
    const node: DeskNode = { key: `${kind}:${it.desk.id}`, kind, id: it.desk.id, label: it.sub ?? it.title, sub: null, count: 0, expandable: kind === "party" };
    setSelected({ node, partyId: kind === "party" ? it.desk.id : null });
    if (kind === "party") { setExpanded((s) => new Set(s).add(it.desk!.id)); loadKids(it.desk.id); }
  };

  // 選んだ行の見出しは、ツリーに読み込んだ行があればそちらの名前を使う。
  const selectedNode = useMemo(() => {
    if (!selected) return null;
    const all = [...(nodes ?? []), ...Object.values(kids).flatMap((v) => (v === "loading" ? [] : v))];
    return all.find((n) => n.key === selected.node.key) ?? selected.node;
  }, [selected, nodes, kids]);

  const filter = useMemo(() => {
    if (!selectedNode) return null;
    if (selectedNode.kind === "agreement") return { only: selectedNode.agreementIds ?? [] };
    if (selectedNode.kind === "loose") return { exclude: selectedNode.agreementIds ?? [] };
    return null;
  }, [selectedNode]);

  const items = today?.items ?? [];
  const shown = showAll ? items : items.slice(0, SHOWN);

  return (
    <section className="workspace desk">
      <div className="workspace-head">
        <h1>{isDesk ? "作業台" : "ホーム"}</h1>
        <p>{isDesk
          ? "取引先・案件・作品のツリーと、その中身。取引先を開くと基本契約が並びます。"
          : "今日やることを上に、取引先・案件・作品のツリー（作業台）を下に置いています。作業台は開いたときに読み込みます。"}</p>
      </div>

      {!isDesk && <div className="panel">
        <div className="panel-hd">
          <h2>今日やること</h2>
          {today && (
            <>
              <span className="tag out">期限切れ {today.counts.over}</span>
              <span className="tag">今日 {today.counts.today}</span>
              <span className="tag">今週 {today.counts.week}</span>
            </>
          )}
          <span className="faint" style={{ marginLeft: "auto" }}>行を押すと、下の作業台がその相手まで開きます</span>
        </div>
        {todayError && <div className="alert" style={{ margin: 12 }}>{todayError}</div>}
        {!today && !todayError && <div className="faint" style={{ padding: 14 }}>読み込み中…</div>}
        {today && items.length === 0 && <div className="faint" style={{ padding: 14 }}>今日やることはありません。</div>}
        <ul className="desk-today">
          {shown.map((it) => (
            <li key={it.key} className={active === it.key ? "on" : undefined}>
              <button className="desk-today-pick" onClick={() => focusItem(it)}
                      title={it.desk ? "作業台でこの相手を開く" : "この行は作業台に対応する相手がありません"}>
                <span className={`desk-dot ${it.when}`} aria-hidden="true" />
                <span className={KIND_TAG[it.kind]}>{KIND_LABEL[it.kind]}</span>
                {it.updated && <span className="tag accent">更新あり</span>}
                <span className="grow">
                  <b>{it.title}</b>
                  {it.sub && <span className="faint">{it.sub}</span>}
                </span>
                <span className={it.when === "over" ? "tag out" : "faint code"}>{dueLabel(it)}</span>
              </button>
              <button className="btn btn-sm" onClick={() => props.onOpenItem(it)}>{actionLabel(it)}</button>
            </li>
          ))}
        </ul>
        {items.length > SHOWN && (
          <div className="desk-today-more">
            <button className="btn btn-sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `${SHOWN} 件だけに戻す` : `すべて見る（残り ${items.length - SHOWN} 件）`}
            </button>
            {today && today.counts.total > items.length && <span className="faint">ほか {today.counts.total - items.length} 件は各画面で</span>}
          </div>
        )}
      </div>}

      <div className="panel">
        <div className="panel-hd">
          {!isDesk && <h2>作業台</h2>}
          {!isDesk && <span className="faint">取引先・案件・作品のツリーと、その中身</span>}
          {isDesk && <span className="faint">切り口</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {open && ROOTS.map(([r, label]) => (
              <button key={r} className="chip" aria-pressed={root === r} onClick={() => switchRoot(r)}>{label}</button>
            ))}
            {!isDesk && <button className="btn btn-sm" aria-expanded={open} onClick={() => setOpenSaved(!open)}>{open ? "畳む" : "作業台を開く"}</button>}
          </span>
        </div>
        {!open && (
          <div className="panel-bd faint">畳んであります。「作業台を開く」か、上の行を押すと読み込みます。</div>
        )}
        {open && (
          <div className="desk-body">
            <div className="desk-tree">
              <input className="inline-input" type="search" value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder={root === "party" ? "取引先の名前・コード" : root === "matter" ? "案件の件名・番号" : "作品の題名・コード"}
                     aria-label="ツリーを絞り込む" />
              {treeError && <div className="alert">{treeError}</div>}
              {nodes === null && !treeError && <div className="faint">読み込み中…</div>}
              {nodes && nodes.length === 0 && !treeError && <div className="faint">見つかりません。</div>}
              <div className="ledger-tree" role="tree" aria-label="作業台のツリー">
                {(nodes ?? []).map((n) => (
                  <div key={n.key} role="none">
                    <div className="desk-node">
                      {n.expandable ? (
                        <button className="desk-chev" aria-label={`${expanded.has(n.id!) ? "閉じる" : "開く"}：${n.label}`}
                                aria-expanded={expanded.has(n.id!)} onClick={() => toggle(n.id!)}>
                          {expanded.has(n.id!) ? "▾" : "▸"}
                        </button>
                      ) : <span className="desk-chev-sp" />}
                      <button className="node" role="treeitem" aria-pressed={selectedNode?.key === n.key}
                              onClick={() => setSelected({ node: n, partyId: n.kind === "party" ? n.id : null })}>
                        <span className="grow">{n.label}{n.sub && <span className="faint"> ・ {n.sub}</span>}</span>
                        <span className="faint code">{n.count}</span>
                      </button>
                    </div>
                    {n.kind === "party" && expanded.has(n.id!) && (
                      kids[n.id!] === "loading" ? <div className="faint desk-kid">読み込み中…</div>
                        : (kids[n.id!] as DeskNode[] | undefined)?.length === 0 ? <div className="faint desk-kid">契約はまだありません。</div>
                        : ((kids[n.id!] as DeskNode[] | undefined) ?? []).map((c) => (
                          <button key={c.key} className="node child" role="treeitem" aria-pressed={selectedNode?.key === c.key}
                                  onClick={() => setSelected({ node: c, partyId: n.id })}>
                            <span className="grow">{c.label}{c.sub && <span className="faint"> ・ {c.sub}</span>}</span>
                            <span className="faint code">{c.count}</span>
                          </button>
                        ))
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="desk-detail">
              {!selectedNode && <div className="faint">左で選ぶと、ここに中身が出ます。</div>}
              {selectedNode && (
                <>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <b style={{ fontSize: 15 }}>{selectedNode.label}</b>
                    {selectedNode.sub && <span className="faint">{selectedNode.sub}</span>}
                    <span style={{ marginLeft: "auto" }} />
                    {selectedNode.id !== null && selectedNode.kind !== "loose" && (
                      <button className="btn btn-sm" onClick={() => props.onOpen(selectedNode.kind as EntityKind, selectedNode.id!)}>
                        {({ party: "取引先の画面で開く", agreement: "契約の画面で開く", matter: "案件の画面で開く", work: "作品の画面で開く" } as Record<string, string>)[selectedNode.kind]}
                      </button>
                    )}
                  </div>
                  {selectedNode.kind === "work" && selectedNode.id !== null && (
                    <div style={{ marginBottom: 14 }}>
                      <h3 className="desk-h3">計算書の回</h3>
                      <WorkRounds key={`r${selectedNode.id}-${version}`} workId={selectedNode.id}
                                  onOpenCondition={props.onOpenCondition} onOpenDocument={props.onOpenDocument} />
                      <h3 className="desk-h3" style={{ marginTop: 14 }}>条件ごと</h3>
                    </div>
                  )}
                  <WorkLedger key={selectedNode.key}
                    matterId={selectedNode.kind === "matter" ? selectedNode.id : null}
                    workId={selectedNode.kind === "work" ? selectedNode.id : null}
                    forPartyId={selectedNode.kind === "matter" || selectedNode.kind === "work" ? null : selected?.partyId ?? null}
                    agreementFilter={filter}
                    reloadKey={version} onChanged={() => setVersion((v) => v + 1)}
                    onOpenCondition={props.onOpenCondition} onOpenDocument={props.onOpenDocument}
                    onOpenDeals={props.onOpenDeals}
                    // 文書を作るのは案件の中だけ（案件をまたぐ切り口では案件が決まらない）。
                    onCompose={selectedNode.kind === "matter"
                      ? (conditionIds, eventIds, mid, templateKey) => props.onCompose(conditionIds, eventIds, mid ?? selectedNode.id, templateKey ?? null)
                      : undefined} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {!isDesk && props.onShowBoard && (
        <div className="row">
          <button className="linky" onClick={props.onShowBoard}>以前のホーム（盤面）を見る</button>
          <span className="faint">集計に時間がかかるため、押したときだけ出します</span>
        </div>
      )}
    </section>
  );
}
