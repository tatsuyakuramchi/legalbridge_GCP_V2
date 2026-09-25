import { useState } from "react";
import type { MatterDetail, MatterSummary } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { SearchSelect, type SearchOption } from "./SearchSelect.js";
import { BUSINESS_LINE_LABEL, MATTER_KIND_LABEL, StatusTag } from "./labels.js";
import { BUSINESS_LINES } from "../server/matters/title.js";
import { useReadOnly } from "./read-only.js";

/**
 * 案件の軸（A-044）。
 *
 * 案件は 作品ごと か 業務ごと の2択に その他 を足した3種。
 *   作品案件 … 作品 1 つが軸。制作委託 → 許諾、または許諾のみ
 *   業務案件 … 事業区分（店舗／管理）と業務名が軸
 *   その他案件 … 軸を持たない（新しい契約スキームの立案、プロジェクト単位の運用）
 * 件名は軸から自動で組む。手で付けたものは触らない。
 * 親子（孫まで）と関連（並列）で案件どうしを繋ぐが、案件そのものは独立したまま。
 */

export const searchWorks = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ works: Array<{ id: number; title: string; workCode: string | null }> }>(
    `/works?q=${encodeURIComponent(q)}`);
  return r.works.map((w) => ({ value: String(w.id), label: w.title, hint: w.workCode ?? null }));
};

export const searchMatters = (exclude: number[]) => async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ matters: MatterSummary[] }>(`/matters?q=${encodeURIComponent(q)}`);
  return r.matters.filter((m) => !exclude.includes(m.id)).map((m) => ({
    value: String(m.id), label: `${m.matterNo ?? `#${m.id}`} ${m.title}`,
    hint: [MATTER_KIND_LABEL[m.kind], m.counterparty?.name].filter(Boolean).join("／")
  }));
};

/**
 * 一覧を親子の順に並べ替える。親の直下に子（さらにその子）を置き、深さを返す。
 * 親が一覧に無い子（絞り込みで親が落ちた）は、そのまま上の階層に出す。
 */
export function treeOrder(rows: MatterSummary[]): Array<{ row: MatterSummary; depth: number }> {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<number, MatterSummary[]>();
  const roots: MatterSummary[] = [];
  for (const r of rows) {
    if (r.parentId && ids.has(r.parentId)) {
      const list = children.get(r.parentId) ?? [];
      list.push(r); children.set(r.parentId, list);
    } else roots.push(r);
  }
  const out: Array<{ row: MatterSummary; depth: number }> = [];
  const seen = new Set<number>();
  const walk = (r: MatterSummary, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ row: r, depth });
    for (const c of children.get(r.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** 種類と区分の印。一覧と詳細の見出しで同じものを出す。 */
export function MatterKindTags({ m }: { m: MatterSummary }) {
  return (
    <span className="row" style={{ gap: 4, display: "inline-flex" }}>
      <span className="tag accent">{MATTER_KIND_LABEL[m.kind]}</span>
      {m.kind === "work" && m.production === true && <span className="tag ghost">制作＋許諾</span>}
      {m.kind === "work" && m.production === false && <span className="tag ghost">許諾のみ</span>}
      {m.businessLine && (
        <span className="tag ghost">{BUSINESS_LINE_LABEL[m.businessLine]}</span>
      )}
      {m.childCount > 0 && <span className="tag ghost" title="子の案件を持つ">子 {m.childCount}</span>}
    </span>
  );
}

const PRODUCTION_LABEL = (v: boolean | null) =>
  v === true ? "あり（制作委託 → 許諾）" : v === false ? "なし（許諾のみ）" : "未決定";

/**
 * 軸の表示と編集。
 * 作品案件は 作品・制作委託の有無、業務案件は 事業区分・業務名。件名は軸から組む。
 */
export function AxisPanel(
  { detail, onChanged, onError }:
  { detail: MatterDetail; onChanged: () => void; onError: (m: string | null) => void }
) {
  const readOnly = useReadOnly();
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workId, setWorkId] = useState<string>(detail.work ? String(detail.work.id) : "");
  const [production, setProduction] = useState<string>(
    detail.production === null ? "" : String(detail.production));
  const [line, setLine] = useState<string>(detail.businessLine ?? "");
  const [name, setName] = useState<string>(detail.businessName ?? "");
  const [manual, setManual] = useState<boolean>(detail.titleManual);
  const [title, setTitle] = useState<string>(detail.title);

  function open() {
    setWorkId(detail.work ? String(detail.work.id) : "");
    setProduction(detail.production === null ? "" : String(detail.production));
    setLine(detail.businessLine ?? ""); setName(detail.businessName ?? "");
    setManual(detail.titleManual); setTitle(detail.title);
    setEdit(true);
  }

  async function save() {
    setBusy(true); onError(null);
    try {
      await api.patch(`/matters/${detail.id}/axis`, {
        workId: detail.kind === "work" ? (workId ? Number(workId) : null) : undefined,
        production: detail.kind === "work" ? (production === "" ? null : production === "true") : undefined,
        businessLine: line || null,
        businessName: detail.kind === "outsourcing" ? (name.trim() || null) : undefined,
        // 手で付けるなら件名を送る。自動に戻すなら null（サーバが軸から組み直す）。
        title: manual || detail.kind === "single" ? title.trim() : null
      });
      setEdit(false); onChanged();
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (detail.kind === "single") {
    return (
      <>
        <dt>件名</dt>
        <dd>
          {edit ? (
            <div className="row">
              <input className="inline-input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 260 }} />
              <button className="btn btn-sm primary" disabled={busy || !title.trim()} onClick={() => void save()}>保存</button>
              <button className="btn btn-sm" onClick={() => setEdit(false)}>やめる</button>
            </div>
          ) : (
            <div className="row"><span>{detail.title}</span><button className="btn btn-sm" disabled={readOnly} onClick={open}>変更</button></div>
          )}
          <div className="faint">その他案件は軸を持たないので、件名は人が付ける</div>
        </dd>
      </>
    );
  }

  return (
    <>
      <dt>{detail.kind === "work" ? "作品（軸）" : "業務（軸）"}</dt>
      <dd>
        {edit ? (
          <div className="stack" style={{ gap: 6 }}>
            {detail.kind === "work" ? (
              <>
                <SearchSelect value={workId} search={searchWorks} placeholder="作品名・作品コードで探す"
                              valueLabel={detail.work?.title ?? null} onChange={(v) => setWorkId(v)} />
                <label className="row" style={{ gap: 6 }}>
                  <span className="faint">制作委託</span>
                  <select value={production} onChange={(e) => setProduction(e.target.value)}>
                    <option value="">未決定（条件から推す）</option>
                    <option value="true">あり（制作委託 → 許諾）</option>
                    <option value="false">なし（許諾のみ）</option>
                  </select>
                </label>
                <div className="faint">
                  未決定のまま、委託料の条件か 成果物が受注者に帰属する条件を繋ぐと、自動で「あり」になる
                </div>
              </>
            ) : (
              <>
                <label className="row" style={{ gap: 6 }}>
                  <span className="faint">業務名</span>
                  <input className="inline-input" value={name} placeholder="例：店舗内装デザイン"
                         onChange={(e) => setName(e.target.value)} style={{ minWidth: 240 }} />
                </label>
              </>
            )}
            {/* 事業区分は案件の最初の軸。作品案件にも付ける（業務案件は必須）。 */}
            <label className="row" style={{ gap: 6 }}>
              <span className="faint">事業区分</span>
              <select value={line} onChange={(e) => setLine(e.target.value)}>
                <option value="">未設定</option>
                {BUSINESS_LINES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
            </label>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
              <span>件名を手で付ける</span>
              <span className="faint">（外すと軸から自動で組み直す）</span>
            </label>
            {manual && (
              <input className="inline-input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 260 }} />
            )}
            <div className="row">
              <button className="btn btn-sm primary" disabled={busy || (manual && !title.trim())} onClick={() => void save()}>保存</button>
              <button className="btn btn-sm" onClick={() => setEdit(false)}>やめる</button>
            </div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 3 }}>
            <div className="row">
              {detail.kind === "work" ? (
                <span>
                  {detail.work ? detail.work.title : <span className="tag warn">作品が未設定</span>}
                  {detail.work?.workCode && <span className="faint code" style={{ marginLeft: 6 }}>{detail.work.workCode}</span>}
                  <span className="faint" style={{ marginLeft: 8 }}>制作委託：{PRODUCTION_LABEL(detail.production)}</span>
                  <span className="faint" style={{ marginLeft: 8 }}>事業：{detail.businessLine ? BUSINESS_LINE_LABEL[detail.businessLine] : "未設定"}</span>
                </span>
              ) : (
                <span>
                  {detail.businessLine ? BUSINESS_LINE_LABEL[detail.businessLine] : <span className="tag warn">事業区分が未設定</span>}
                  <span style={{ marginLeft: 8 }}>{detail.businessName ?? <span className="tag warn">業務名が未設定</span>}</span>
                </span>
              )}
              <button className="btn btn-sm" disabled={readOnly} onClick={open}>変更</button>
            </div>
            <div className="faint">
              {detail.titleManual ? "件名は手で付けたもの" : "件名は軸から自動で付いている"}
              {detail.remappedFrom && `（旧データから移した：${
                { outsourcing: "業務委託 → 作品案件", work: "ライセンス → 作品案件", single: "文書作成 → その他案件" }[detail.remappedFrom]
                ?? detail.remappedFrom}）`}
            </div>
          </div>
        )}
      </dd>
    </>
  );
}

/** 親子と関連。親は 1 つ（孫まで可）、関連は並列で何件でも。 */
export function FamilyPanel(
  { detail, onOpen, onChanged, onError }:
  { detail: MatterDetail; onOpen: (id: number) => void; onChanged: () => void;
    onError: (m: string | null) => void }
) {
  const readOnly = useReadOnly();
  const [parentEdit, setParentEdit] = useState(false);
  const [relAdd, setRelAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(f: () => Promise<unknown>) {
    setBusy(true); onError(null);
    try { await f(); onChanged(); }
    catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  const excluded = [detail.id, ...detail.children.map((c) => c.id), ...detail.related.map((c) => c.id)];
  const ref = (m: { id: number; matterNo: string | null; title: string; kind: string; status: string; counterparty: string | null }) => (
    <span className="row" style={{ gap: 6, display: "inline-flex" }}>
      <button type="button" className="linky code" onClick={() => onOpen(m.id)}>{m.matterNo ?? `#${m.id}`}</button>
      <span>{m.title}</span>
      <span className="tag accent">{MATTER_KIND_LABEL[m.kind] ?? m.kind}</span>
      <StatusTag kind="matter" value={m.status} />
    </span>
  );

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>親子と関連</h2>
        <span className="faint">プロジェクト → 作品 → 補助の業務委託 のように孫まで。関連は並列で、案件そのものは独立したまま</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 10 }}>
        <div>
          <div className="row" style={{ gap: 8 }}>
            <b>親の案件</b>
            {detail.parent ? ref(detail.parent) : <span className="faint">なし</span>}
            {!parentEdit && (
              <button className="btn btn-sm" disabled={readOnly} onClick={() => setParentEdit(true)}>{detail.parent ? "変更" : "親を付ける"}</button>
            )}
            {detail.parent && !parentEdit && (
              <button className="btn btn-sm" disabled={busy || readOnly}
                      onClick={() => void run(() => api.patch(`/matters/${detail.id}/parent`, { parentId: null }))}>外す</button>
            )}
          </div>
          {parentEdit && (
            <div className="row" style={{ marginTop: 6 }}>
              <SearchSelect value="" autoFocus search={searchMatters(excluded)}
                            placeholder="親にする案件を 件名・案件番号・相手先 で探す"
                            onChange={(v) => { if (v) { setParentEdit(false); void run(() => api.patch(`/matters/${detail.id}/parent`, { parentId: Number(v) })); } }} />
              <button className="btn btn-sm" onClick={() => setParentEdit(false)}>やめる</button>
            </div>
          )}
          <div className="faint">自分の子や孫は親にできません（循環になる）</div>
        </div>

        <div>
          <b>子の案件</b>
          {detail.children.length ? (
            <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0 0" }}>
              {detail.children.map((c) => <li key={c.id}>{ref(c)}</li>)}
            </ul>
          ) : <span className="faint" style={{ marginLeft: 8 }}>なし（子の案件は、その案件の側で親を付ける）</span>}
          {detail.children.some((c) => c.status !== "done" && c.status !== "canceled") && (
            <div className="faint">開いている子の案件が残っている間は、この案件を完了にできません</div>
          )}
        </div>

        <div>
          <div className="row" style={{ gap: 8 }}>
            <b>関連する案件</b>
            {!relAdd && <button className="btn btn-sm" disabled={readOnly} onClick={() => setRelAdd(true)}>関連を足す</button>}
          </div>
          {relAdd && (
            <div className="row" style={{ marginTop: 6 }}>
              <SearchSelect value="" autoFocus search={searchMatters(excluded)}
                            placeholder="関連にする案件を探す"
                            onChange={(v) => { if (v) { setRelAdd(false); void run(() => api.post(`/matters/${detail.id}/relations`, { matterId: Number(v) })); } }} />
              <button className="btn btn-sm" onClick={() => setRelAdd(false)}>やめる</button>
            </div>
          )}
          {detail.related.length ? (
            <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0 0" }}>
              {detail.related.map((c) => (
                <li key={c.id} className="row" style={{ gap: 6 }}>
                  {ref(c)}
                  <button className="btn btn-sm" disabled={busy || readOnly}
                          onClick={() => void run(() => api.del(`/matters/${detail.id}/relations/${c.id}`))}>外す</button>
                </li>
              ))}
            </ul>
          ) : <div className="faint">なし</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * 継続。付帯する契約が終わるまで案件は開いたまま
 * （時限払い・製造時払い・料率は契約が終わるまで回る）。
 */
export function ContinuePanel({ detail }: { detail: MatterDetail }) {
  const live = detail.agreements.filter((a) => a.live);
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>付帯する契約</h2>
        <span className="faint">
          {live.length ? `生きている契約 ${live.length} 本。終わるまで案件は開いたまま` : "生きている契約はない。工程が済めば完了にできる"}
        </span>
      </div>
      {detail.agreements.length > 0 && (
        <div className="panel-bd">
          <table className="compact">
            <thead><tr><th>契約番号</th><th>件名</th><th>種類</th><th>状態</th><th>いまの終了日</th><th></th></tr></thead>
            <tbody>
              {detail.agreements.map((a) => (
                <tr key={a.id}>
                  <td className="code">{a.agreementNo ?? `#${a.id}`}</td>
                  <td>{a.title}</td>
                  <td>{AGREEMENT_KIND[a.kind] ?? a.kind}</td>
                  <td><StatusTag kind="agreement" value={a.status} /></td>
                  <td className="code">{a.currentEnd ?? (a.live ? "期限なし" : "—")}</td>
                  <td>{a.live ? <span className="tag ok">継続中</span> : <span className="tag ghost">終了</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const AGREEMENT_KIND: Record<string, string> = {
  master: "基本契約", standalone: "単体契約", supplement: "付帯文書", termination: "解除合意", document: "文書のみ"
};

/** 案件の状態。完了は、付帯する契約が終わり 子の案件も閉じて初めて通る（サーバが断る）。 */
export function StatusPanel(
  { detail, onChanged, onError }:
  { detail: MatterDetail; onChanged: () => void; onError: (m: string | null) => void }
) {
  const readOnly = useReadOnly();
  const [edit, setEdit] = useState(false);
  const [status, setStatus] = useState(detail.status);
  const [reason, setReason] = useState(detail.blockedReason ?? "");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); onError(null);
    try {
      await api.patch(`/matters/${detail.id}/status`, {
        status, blockedReason: status === "blocked" ? (reason.trim() || null) : null });
      setEdit(false); onChanged();
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(false); }
  }
  const liveCount = detail.agreements.filter((a) => a.live).length;
  const openKids = detail.children.filter((c) => c.status !== "done" && c.status !== "canceled").length;
  return (
    <>
      <dt>状態</dt>
      <dd>
        {edit ? (
          <div className="row">
            <select value={status} onChange={(e) => setStatus(e.target.value as MatterDetail["status"])}>
              {(["open", "waiting", "blocked", "done", "canceled"] as const).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
            {status === "blocked" && (
              <input className="inline-input" value={reason} placeholder="停滞の理由"
                     onChange={(e) => setReason(e.target.value)} />
            )}
            <button className="btn btn-sm primary" disabled={busy} onClick={() => void save()}>保存</button>
            <button className="btn btn-sm" onClick={() => setEdit(false)}>やめる</button>
          </div>
        ) : (
          <div className="row">
            <StatusTag kind="matter" value={detail.status} />
            <button className="btn btn-sm" disabled={readOnly} onClick={() => { setStatus(detail.status); setReason(detail.blockedReason ?? ""); setEdit(true); }}>変更</button>
          </div>
        )}
        {(liveCount > 0 || openKids > 0) && detail.status !== "done" && (
          <div className="faint">
            完了にできません：
            {liveCount > 0 && `生きている契約 ${liveCount} 本`}
            {liveCount > 0 && openKids > 0 && "・"}
            {openKids > 0 && `開いている子の案件 ${openKids} 件`}
          </div>
        )}
      </dd>
    </>
  );
}

const STATUS_LABEL: Record<string, string> = {
  open: "進行中", waiting: "相手待ち", blocked: "停滞", done: "完了", canceled: "取りやめ"
};
