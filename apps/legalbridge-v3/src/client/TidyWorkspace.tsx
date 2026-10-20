import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { OwnerStaffPicker } from "./OwnerStaffPicker.js";
import { useReadOnly } from "./read-only.js";
import type { EntityKind } from "./Relations.js";
import type { TidyPartyRow } from "../server/ops/tidy-service.js";
import {
  FIX_LABEL, LEVEL_LABEL, MARK_LABEL, allMarks, marksOnly,
  type MarkKind, type TidyFix, type TidyMark, type TidyNode, type TidyTree
} from "../server/ops/tidy.js";

/**
 * 整理する ― 取引先の木を 1 本ずつ直す。
 *
 * 左：取引先（直すところのある順）。中：木（取引先 → 取引 → 個別契約 → 条件 → 実績 → 支払文書 → 支払）。
 * 右：押した印の直し方。印は 4 つで、直し方も 4 つ（多重→統合する／未登録→登録する／欠け→繋ぐ／空→埋める）。
 * どれも今ある道具（名寄せ・契約を立てる・繋ぐ・期間・通知先・計算書の統合）の API を叩くだけで、
 * この画面だけの書き込みは無い。
 */

const MARK_CLASS: Record<MarkKind, string> = { dup: "danger", unregistered: "warn", missing: "accent", blank: "ghost" };
const KINDS: MarkKind[] = ["dup", "unregistered", "missing", "blank"];

export function TidyWorkspace({ initialPartyId, onOpen }: { initialPartyId?: number; onOpen?: (kind: EntityKind, id: number) => void }) {
  const [parties, setParties] = useState<TidyPartyRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [issuesOnly, setIssuesOnly] = useState(true);
  const [partyId, setPartyId] = useState<number | undefined>(initialPartyId);
  const [tree, setTree] = useState<TidyTree | null>(null);
  const [onlyMarks, setOnlyMarks] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    const q = new URLSearchParams({ q: search, issues: issuesOnly ? "1" : "0" });
    api.get<{ parties: TidyPartyRow[] }>(`/tidy/parties?${q}`)
      .then((r) => setParties(r.parties)).catch((e: ApiError) => setError(e.message));
  }, [search, issuesOnly, version]);

  useEffect(() => {
    if (!partyId) { setTree(null); return; }
    setLoading(true);
    api.get<TidyTree>(`/tidy/parties/${partyId}`)
      .then((t) => { setTree(t); setError(null); })
      .catch((e: ApiError) => { setTree(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [partyId, version]);

  const marks = useMemo(() => (tree ? allMarks(tree.roots) : []), [tree]);
  const current = marks.find((m) => m.mark.id === picked) ?? marks[0] ?? null;
  useEffect(() => { if (tree && !marks.some((m) => m.mark.id === picked)) setPicked(marks[0]?.mark.id ?? null); }, [tree]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = tree ? (onlyMarks ? marksOnly(tree.roots) : tree.roots) : [];
  const nodeCount = tree ? count(tree.roots) : 0;
  const okCount = tree ? count(tree.roots, (n) => n.ok) : 0;
  const idx = current ? marks.findIndex((m) => m.mark.id === current.mark.id) : -1;
  const next = () => { if (idx >= 0 && marks[idx + 1]) setPicked(marks[idx + 1]!.mark.id); };
  const nextParty = () => {
    const i = parties.findIndex((p) => p.id === partyId);
    const n = parties.slice(i + 1).find((p) => p.marks > 0) ?? parties[i + 1];
    if (n) setPartyId(n.id);
  };

  function done(msg: string) { setNotice(msg); setError(null); bump(); }

  return (
    <section className="workspace">
      <div className="workspace-head">
        <h1>整理する</h1>
        <p>取引先を根に、取引（基本契約 or 独立契約）→ 個別契約 → 条件（作品）→ 実績 → 支払文書 → 支払 の木を 1 本ずつ見る。印を押すと右に直し方が出る。</p>
      </div>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="note ok">{notice}</div>}

      <div className="tidy-split">
        <div className="panel">
          <div className="panel-hd"><h2>取引先</h2>
            <label className="faint" style={{ marginLeft: "auto" }}>
              <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} /> 直すところのある取引先だけ
            </label>
          </div>
          <div className="panel-bd" style={{ paddingTop: 8 }}>
            <ListSearch value={keyword} onChange={setKeyword} placeholder="取引先名・コード・カナ" />
            <div className="ledger-tree" style={{ marginTop: 8 }}>
              {parties.map((p) => (
                <button key={p.id} className="node" aria-pressed={p.id === partyId} onClick={() => { setPartyId(p.id); setPicked(null); }}>
                  <span className="grow">{p.name}</span>
                  {p.marks > 0 ? <span className="tag warn">⚠ {p.marks}</span> : <span className="faint">✓</span>}
                </button>
              ))}
              {!parties.length && <div className="faint">該当なし</div>}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>{tree ? `${tree.party.name} の木` : "木"}</h2>
            {tree && (
              <span className="tidy-counts">
                {KINDS.map((k) => (
                  <span key={k} className={`tag ${MARK_CLASS[k]}`}>{MARK_LABEL[k]} {tree.counts[k]}</span>
                ))}
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <button className="chip" aria-pressed={onlyMarks} onClick={() => setOnlyMarks(true)}>⚠ 直すところだけ</button>
              <button className="chip" aria-pressed={!onlyMarks} onClick={() => setOnlyMarks(false)}>全部</button>
              <button className="btn btn-sm" onClick={nextParty} disabled={!parties.length}>次の取引先 →</button>
            </span>
          </div>
          <div className="panel-bd">
            {!partyId && <div className="faint">左で取引先を選ぶ</div>}
            {loading && <div className="faint">読み込み中…</div>}
            {tree && (
              <>
                <div className="tidy-legend">
                  {KINDS.map((k) => <span key={k}><span className={`tag ${MARK_CLASS[k]}`}>{MARK_LABEL[k]}</span> → {FIX_LABEL[k]}</span>)}
                  <span style={{ marginLeft: "auto" }}>✓ 問題なし</span>
                </div>
                {!shown.length && <div className="note ok">直すところはありません。</div>}
                <div className="tidy-tree">
                  {shown.map((n) => <TreeNode key={n.key} node={n} depth={0} picked={current?.mark.id ?? null} onPick={setPicked} onOpen={onOpen} />)}
                </div>
                <div className="tidy-progress">
                  <div className="tidy-bar"><span style={{ width: `${nodeCount ? Math.round((okCount / nodeCount) * 100) : 100}%` }} /></div>
                  <span className="faint">問題なし {nodeCount ? Math.round((okCount / nodeCount) * 100) : 100}%　直すところ {tree.total}　節 {nodeCount}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="tidy-fix">
          {current ? (
            <FixPane key={current.mark.id} node={current.node} mark={current.mark} members={tree?.members ?? []}
              onDone={done} onError={setError} onOpen={onOpen}
              position={`${idx + 1} / ${marks.length}`} onNext={idx + 1 < marks.length ? next : undefined} />
          ) : (
            <div className="panel"><div className="panel-bd faint">印を押すと、ここに直し方が出ます。</div></div>
          )}
          <div className="panel">
            <div className="panel-bd tidy-help">
              <b>4 つの直し方（印ごとに 1 つ）</b>
              <div><span className="tag danger">多重</span> <b>統合する</b>　残す方を選ぶ。参照は付け替えず、統合の印で辿る</div>
              <div><span className="tag warn">未登録</span> <b>登録する</b>　番号を変えずに契約を立てる</div>
              <div><span className="tag accent">欠け</span> <b>繋ぐ</b>　親を選んで指す</div>
              <div><span className="tag ghost">空</span> <b>埋める</b>　決まりの値を入れ、紙に出るものは訂正版で出し直す</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function count(nodes: TidyNode[], pred: (n: TidyNode) => boolean = () => true): number {
  let n = 0;
  const walk = (x: TidyNode) => { if (pred(x)) n += 1; x.children.forEach(walk); };
  nodes.forEach(walk);
  return n;
}

function TreeNode({ node, depth, picked, onPick, onOpen }: {
  node: TidyNode; depth: number; picked: string | null; onPick: (id: string) => void; onOpen?: (kind: EntityKind, id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const has = node.children.length > 0;
  const bad = node.marks.length > 0;
  return (
    <>
      <div className={`tidy-row${bad ? " bad" : ""}${node.shared ? " shared" : ""}${node.level === "group" ? " group" : ""}`}
           style={{ paddingLeft: 8 + depth * 22 }}>
        <button className="tidy-caret" onClick={() => setOpen((o) => !o)} disabled={!has} aria-label={open ? "畳む" : "開く"}>
          {has ? (open ? "▾" : "▸") : "·"}
        </button>
        <span className="tidy-level">{LEVEL_LABEL[node.level]}</span>
        {node.code && <span className="code">{node.code}</span>}
        {node.entity && onOpen ? (
          <button className="linky tidy-title" onClick={() => onOpen(node.entity!.kind as EntityKind, node.entity!.id)}
                  disabled={node.entity.kind === "payment"}>{node.title}</button>
        ) : <span className="tidy-title">{node.title}</span>}
        {node.shared && <span className="tag ghost">受取人として</span>}
        {node.detail && <span className="faint tidy-detail">{node.detail}</span>}
        {node.marks.map((m) => (
          <button key={m.id} className={`tag ${MARK_CLASS[m.kind]} tidy-mark`} aria-pressed={picked === m.id}
                  onClick={() => onPick(m.id)} title={m.message}>{MARK_LABEL[m.kind]}</button>
        ))}
        {!bad && node.ok && node.level !== "group" && <span className="tidy-ok">✓</span>}
      </div>
      {open && node.children.map((c) => <TreeNode key={c.key} node={c} depth={depth + 1} picked={picked} onPick={onPick} onOpen={onOpen} />)}
    </>
  );
}

function FixPane({ node, mark, members, onDone, onError, onOpen, position, onNext }: {
  node: TidyNode; mark: TidyMark; members: number[];
  onDone: (msg: string) => void; onError: (msg: string) => void; onOpen?: (kind: EntityKind, id: number) => void;
  position: string; onNext?: () => void;
}) {
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState("");
  const [staffId, setStaffId] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ from: { name: string }; into: { name: string }; moves: Record<string, number>; blockers: string[]; warnings: string[] } | null>(null);
  const fix = mark.fix;

  // 名寄せ：残す方を選ぶと試算が出る。
  const mergeParties = fix?.action === "merge_party" ? fix.parties : [];
  const keepId = fix?.action === "merge_party" ? Number(choice || (mergeParties.find((p) => members.includes(p.id))?.id ?? mergeParties[0]?.id ?? 0)) : 0;
  const fromParty = mergeParties.find((p) => p.id !== keepId) ?? null;
  useEffect(() => {
    if (fix?.action !== "merge_party" || !fromParty || !keepId) { setPreview(null); return; }
    api.get<NonNullable<typeof preview>>(`/parties/merge/preview?fromId=${fromParty.id}&intoId=${keepId}`)
      .then(setPreview).catch((e: ApiError) => { setPreview(null); onError(e.message); });
  }, [fix?.action, fromParty?.id, keepId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(job: () => Promise<string>) {
    setBusy(true);
    try { onDone(await job()); }
    catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const title = `${MARK_LABEL[mark.kind]}：${fix ? FIX_LABEL[mark.kind] : "この画面からは直せません"}`;
  const where = [LEVEL_LABEL[node.level], node.code, node.title].filter(Boolean).join("　");

  function body(f: TidyFix) {
    switch (f.action) {
      case "merge_party":
        return (
          <>
            <div className="faint">同じ人が {f.parties.length} 件に分かれています。残す方を選ぶと、もう片方に付いている契約・条件・文書・支払が全部そちらから見えるようになります。参照は付け替えないので取り消せます。</div>
            <div className="tidy-choices">
              {f.parties.map((p) => (
                <label key={p.id} className={`tidy-choice${p.id === keepId ? " on" : ""}`}>
                  <input type="radio" name="keep" checked={p.id === keepId} onChange={() => setChoice(String(p.id))} /> <b>残す</b>
                  <div>{p.name}（#{p.id}）{p.partyCode && <span className="faint"> {p.partyCode}</span>}</div>
                  <div className="faint">契約 {p.agreements}・条件 {p.conditions}・支払 {p.payments}・案件 {p.matters}</div>
                </label>
              ))}
            </div>
            {f.parties.length > 2 && <div className="faint">3 件以上は 1 件ずつ統合します（残す方以外の先頭から）。</div>}
            {preview && (
              <div className="note">
                移るもの：条件 {preview.moves.conditions}・契約 {preview.moves.agreements}・支払 {preview.moves.payments}・案件 {preview.moves.matters}
                {preview.warnings.map((w) => <div key={w} className="faint">⚠ {w}</div>)}
                {preview.blockers.map((b) => <div key={b} style={{ color: "var(--out)" }}>✕ {b}</div>)}
              </div>
            )}
            <button className="btn danger" disabled={readOnly || busy || !preview || preview.blockers.length > 0 || !fromParty}
              onClick={() => run(async () => {
                await api.post("/parties/merge", { fromId: fromParty!.id, intoId: keepId });
                return `${fromParty!.name}（#${fromParty!.id}）を #${keepId} に統合しました。取り消せます`;
              })}>#{keepId} に統合する</button>
          </>
        );
      case "register_document":
        return (
          <>
            <div className="faint">{f.role === "master" ? "基本契約書から基本契約を立てます" : "条件書から個別契約（基本契約があればその下、無ければ単体契約）を立てます"}。番号・件名は文書のままで、載っている条件も一緒に載ります。</div>
            <button className="btn primary" disabled={readOnly || busy}
              onClick={() => run(async () => {
                const r = await api.post<{ agreementNo?: string | null }>(`/agreement-map/documents/${f.documentId}/agreement`);
                return `${node.code ?? `#${f.documentId}`} から契約 ${r.agreementNo ?? ""} を立てました`;
              })}>登録する</button>
          </>
        );
      case "link_condition":
        return (
          <>
            <div className="faint">条件を載せる契約を選びます。条件を持つのは個別契約（条件書・発注書）と単体契約で、基本契約は持ちません。</div>
            {f.targets.length ? (
              <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">載せ先を選ぶ</option>
                {f.targets.map((t) => <option key={t.id} value={t.id}>{t.code ?? `#${t.id}`}　{t.title}</option>)}
              </select>
            ) : <div className="note warn">載せ先になる個別契約・単体契約がありません。先に契約を登録してください（契約に繋がっていない条件書があれば「登録する」）。</div>}
            <button className="btn primary" disabled={readOnly || busy || !choice}
              onClick={() => run(async () => {
                for (const id of f.conditionIds) await api.post(`/links/condition/${id}/agreement`, { targetId: Number(choice) });
                const t = f.targets.find((x) => String(x.id) === choice);
                return `${node.code ?? ""} を ${t?.code ?? `#${choice}`} に載せました`;
              })}>繋ぐ</button>
          </>
        );
      case "set_parent":
        return (
          <>
            <div className="faint">この個別契約をぶら下げる基本契約を選びます。</div>
            {f.targets.length ? (
              <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">基本契約を選ぶ</option>
                {f.targets.map((t) => <option key={t.id} value={t.id}>{t.code ?? `#${t.id}`}　{t.title}</option>)}
              </select>
            ) : <div className="note warn">この取引先に基本契約がありません。単体契約に格上げするなら契約の画面で。</div>}
            <button className="btn primary" disabled={readOnly || busy || !choice}
              onClick={() => run(async () => {
                await api.patch(`/agreement-map/agreements/${f.agreementId}`, { parentId: Number(choice) });
                return `${node.code ?? ""} を基本契約 #${choice} の下に繋ぎました`;
              })}>繋ぐ</button>
          </>
        );
      case "patch_agreement":
        return (
          <>
            {f.choices ? (
              <select value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">{f.label}</option>
                {f.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            ) : <div className="faint">{f.label}</div>}
            <button className="btn primary" disabled={readOnly || busy || (Boolean(f.choices) && !choice)}
              onClick={() => run(async () => {
                await api.patch(`/agreement-map/agreements/${f.agreementId}`, f.choices ? { domain: choice } : f.body);
                return `${node.code ?? ""}：${f.label}`;
              })}>{f.label}</button>
          </>
        );
      case "order_to_document":
        return (
          <>
            <div className="faint">契約として登録された発注書を、文書（発注書）に寄せます。条件はそのまま発注書に載ります。</div>
            <button className="btn primary" disabled={readOnly || busy}
              onClick={() => run(async () => {
                await api.post(`/agreement-map/agreements/${f.agreementId}/to-order-document`);
                return `${node.code ?? ""} を発注書（文書）にしました`;
              })}>文書に寄せる</button>
          </>
        );
      case "fill_term":
        return (
          <>
            <div className="faint">許諾期間を 開始日から 3 年（終了 {f.newTermEnd ?? "?"}）・3 年ごとの自動更新 にします。{f.label && <>今日の時点では「{f.label}」。</>}</div>
            <div className="faint">決定済みの条件書は、運用 › 一括修正 › 許諾期間 で訂正版を出し直せます。</div>
            <button className="btn primary" disabled={readOnly || busy || !f.newTermEnd}
              onClick={() => run(async () => {
                await api.post("/conditions/term-default", { conditionIds: f.conditionIds });
                return `${node.code ?? ""} の許諾期間を入れました（〜${f.newTermEnd}・自動更新）`;
              })}>埋める（3 年）</button>
          </>
        );
      case "fill_notice":
        return (
          <>
            <div className="faint">空いている通知先を入れて、訂正版で出し直します（元の締結日・決定日のまま）。</div>
            {f.fills.length > 0 && (
              <div className="dl">{f.fills.map((x) => <div key={x.field}><span className="faint">{x.label}</span>　{x.value}</div>)}</div>
            )}
            {f.needsStaff && (
              <div>
                <div className="faint">乙（当社）の通知先に入れる担当者</div>
                <OwnerStaffPicker value={staffId} onChange={setStaffId} disabled={busy} emptyLabel="担当者を選ぶ" />
              </div>
            )}
            <button className="btn primary" disabled={readOnly || busy || (f.needsStaff && !staffId)}
              onClick={() => run(async () => {
                const r = await api.post<{ reissued: number; results: Array<{ error?: string | null; newDocumentNo?: string | null }> }>(
                  "/notice-fill", { documentIds: f.documentIds, ownerStaffId: staffId });
                const err = r.results.find((x) => x.error)?.error;
                if (err) throw new Error(err);
                return `通知先を入れて訂正版を出しました（${r.reissued} 枚）`;
              })}>埋めて出し直す</button>
          </>
        );
      case "merge_statements":
        return (
          <>
            <div className="faint">{f.group.periodLabel ?? ""} の本人分と受取人分の計算書を 1 枚にまとめ、未払いの支払を立て直します。</div>
            <div className="dl">
              {f.group.documents.map((d) => <div key={d.id}><span className="code">{d.documentNo ?? `#${d.id}`}</span>　{d.payee ? "受取人分" : "本人分"}</div>)}
            </div>
            {f.group.status !== "ready" && <div className="note warn">{f.group.message ?? "いまはまとめられません"}</div>}
            <button className="btn primary" disabled={readOnly || busy || f.group.status !== "ready"}
              onClick={() => run(async () => {
                const r = await api.post<{ merged: number; results: Array<{ error?: string | null; newDocumentNo?: string | null }> }>(
                  "/royalty-ledger/statements/merge", { keys: [f.group.key] });
                const err = r.results.find((x) => x.error)?.error;
                if (err) throw new Error(err);
                return `計算書を 1 枚にまとめました（${r.results[0]?.newDocumentNo ?? ""}）`;
              })}>1 枚にまとめる</button>
          </>
        );
      case "open":
        return (
          <>
            <div className="faint">この画面からは直せません。{f.label}。</div>
            <button className="btn" disabled={!onOpen} onClick={() => onOpen?.(f.kind, f.id)}>開く →</button>
          </>
        );
    }
  }

  return (
    <div className={`panel tidy-fixpane ${MARK_CLASS[mark.kind]}`}>
      <div className="panel-hd">
        <span className={`tag ${MARK_CLASS[mark.kind]}`}>{MARK_LABEL[mark.kind]}</span>
        <h2>{title}</h2>
        <span className="faint" style={{ marginLeft: "auto" }}>{position}</span>
      </div>
      <div className="panel-bd stack">
        <div className="faint">{where}</div>
        <div>{mark.message}</div>
        {fix ? body(fix) : node.entity && onOpen && (
          <button className="btn" onClick={() => onOpen(node.entity!.kind as EntityKind, node.entity!.id)}>開いて直す →</button>
        )}
        {onNext && <button className="btn btn-sm ghost" onClick={onNext}>次の印へ →</button>}
      </div>
    </div>
  );
}
