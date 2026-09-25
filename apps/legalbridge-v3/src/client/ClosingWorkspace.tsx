import { useCallback, useEffect, useState } from "react";
import { api, ApiError, money, rate } from "./api.js";
import { SearchSelect, searchParties, type SearchOption } from "./SearchSelect.js";
import { PRICING_MODEL_LABEL } from "./labels.js";
import { ClosingRows } from "./ClosingRows.js";
import { ClosingRun } from "./ClosingRun.js";
import { ClosingSchedule } from "./ClosingSchedule.js";
import {
  monthLabel, shiftMonth, thisMonth,
  type CandidateRow, type MonthView, type PeriodsView, type RoyaltyGap, type StrayView
} from "./closing-types.js";

/**
 * 支払文書処理。
 *
 * 定期課金も料率も、やることは同じ4手で進む。
 *   予定を立てる → 実績（料率は売上報告）を入れる → 決済文書を出す → 支払を立てる
 * これまでこの4手は、条件画面・実績タブ・文書作成・支払タブに散っていて、
 * 「今月どこまで済んだか」を見る場所が無かった。
 *
 * 入口は2つ。月から入るのが定常運転（予定が立っているものを締める）。
 * 探して入るのが、予定がまだ無いもの・これから立てるもの。どちらも行の形は
 * 同じで、切り口が違うだけ。計算方式ごとに表は分けない。
 */

type Tab = "month" | "find" | "strays";

export function ClosingWorkspace({ onOpenCondition, onOpenDocument, onRecord }: {
  onOpenCondition: (id: number) => void;
  onOpenDocument: (id: number) => void;
  /** その回の実績を入れに行く（条件明細の画面の実績フォームへ）。 */
  onRecord: (conditionId: number, scheduleId: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("month");
  const [month, setMonth] = useState(thisMonth());
  const [view, setView] = useState<MonthView | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    if (tab !== "month") return;
    setError(null);
    api.get<MonthView>(`/closing?month=${month}`)
      .then((v) => { setView(v); setSelected(new Set()); })
      .catch((e: ApiError) => setError(e.message));
  }, [tab, month, version]);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>支払文書処理</h1>
        <p>
          予定を立てて、回ごとに実績を記録し、決済文書を出し、支払を立てる。
          この4手を月ごとに、案件をまたいでまとめて進めます。定期課金も料率も同じ表に並びます。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="tabs">
        <button aria-selected={tab === "month"} onClick={() => setTab("month")}>月で見る</button>
        <button aria-selected={tab === "find"} onClick={() => setTab("find")}>支払文書をつくる</button>
        <button aria-selected={tab === "strays"} onClick={() => setTab("strays")}>こぼれたもの</button>
      </div>

      {tab === "month" && (
        <div className="stack">
          <div className="list-tools">
            <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
            <strong>{monthLabel(month)}</strong>
            <button className="btn btn-sm" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
            <button className="btn btn-sm" onClick={() => setMonth(thisMonth())}>今月</button>
            {view && (
              <span className="faint">
                実績待ち {view.counts.event}／文書待ち {view.counts.document}／
                支払待ち {view.counts.payment}／締め済 {view.counts.done}
              </span>
            )}
          </div>

          {closing
            ? <ClosingRun scheduleIds={[...selected]} onRan={refresh}
                onDone={() => setClosing(false)}
                onCancel={() => setClosing(false)} />
            : selected.size > 0 && (
              <div className="bulkbar">
                <strong>{selected.size} 行</strong>を選択中
                <button className="btn btn-sm" onClick={() => setClosing(true)}>まとめて締める</button>
                <button className="btn btn-sm" onClick={() => setSelected(new Set())}>選び直す</button>
              </div>
            )}

          {view && (
            <ClosingRows rows={view.rows} selected={selected} onSelect={setSelected}
              onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
              onRecord={onRecord}
              empty={`${monthLabel(month)}に締め日が来る回はありません。予定がまだ無いものは「支払文書をつくる」から探せます。`} />
          )}
        </div>
      )}

      {tab === "find" && (
        <FindPanel onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
          onRecord={onRecord} />
      )}

      {tab === "strays" && (
        <StraysPanel onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
          onRecord={onRecord} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ① 探す → ② 条件明細を選ぶ → ③ 回ごとに進める
// ---------------------------------------------------------------------------

type Where = "party" | "work" | "matter" | "q";

const WHERE_LABEL: Record<Where, string> = {
  party: "取引先", work: "作品", matter: "案件", q: "語で探す"
};

function FindPanel({ onOpenCondition, onOpenDocument, onRecord }: {
  onOpenCondition: (id: number) => void;
  onOpenDocument: (id: number) => void;
  onRecord: (conditionId: number, scheduleId: number) => void;
}) {
  const [where, setWhere] = useState<Where>("party");
  const [value, setValue] = useState("");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<CandidateRow[] | null>(null);
  const [picked, setPicked] = useState<PeriodsView | null>(null);
  /** 算定期間をその場で並べる条件（料率で契約期間の入っているもの）。 */
  const [building, setBuilding] = useState<CandidateRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = () => {
    if (where === "q") return text.trim() ? `q=${encodeURIComponent(text.trim())}` : "";
    if (!value) return "";
    return `${where === "party" ? "partyId" : where === "work" ? "workId" : "matterId"}=${value}`;
  };

  async function find(keepPicked = false) {
    const q = query();
    if (!q) return;
    setBusy(true); setError(null);
    if (!keepPicked) setPicked(null);
    try {
      const r = await api.get<{ rows: CandidateRow[] }>(`/closing/candidates?${q}`);
      setRows(r.rows);
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  /**
   * その候補で次にすること。行を押しても右端のボタンを押しても同じところへ行く。
   * 押す場所で行き先が変わると、押した人は覚えていられない。
   */
  const actionOf = (c: CandidateRow) =>
    c.periodCount ? "回を見る"
    : c.needsReport && c.termStart && c.termEnd ? "算定期間を並べる"
    // 料率以外の予定明細は金額が要る。条件画面の予定明細タブへ送る
    // （同じ欄を2つ作らない）。
    : "条件を開いて組む";

  const go = (c: CandidateRow) => {
    if (c.periodCount) return void open(c.id);
    if (c.needsReport && c.termStart && c.termEnd) return setBuilding(c);
    onOpenCondition(c.id);
  };

  async function open(id: number) {
    setBusy(true); setError(null);
    try {
      setPicked(await api.get<PeriodsView>(`/closing/conditions/${id}`));
      setSelected(new Set());
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  if (building) {
    return <ClosingSchedule gap={gapOf(building)}
      // 候補の表も引き直す。並べた直後に「予定 0／残り 0」のままだと、
      // 書き込めなかったように読める。
      onDone={() => { setBuilding(null); find(true); open(building.id); }}
      onCancel={() => setBuilding(null)} />;
  }

  return (
    <div className="stack">
      {error && <div className="alert">{error}</div>}

      <div className="panel">
        <div className="panel-hd">
          <h2>① 探す</h2>
          <span className="faint">知っていることから。相手の名前・作品・案件番号</span>
        </div>
        <div className="panel-bd stack">
          <div className="tabs">
            {(Object.keys(WHERE_LABEL) as Where[]).map((w) => (
              <button key={w} aria-selected={where === w}
                onClick={() => { setWhere(w); setValue(""); setText(""); setRows(null); setPicked(null); }}>
                {WHERE_LABEL[w]}
              </button>
            ))}
          </div>
          <div className="row">
            {where === "party" && (
              <SearchSelect value={value} onChange={setValue} search={searchParties}
                placeholder="取引先の名前" />
            )}
            {where === "work" && (
              <SearchSelect value={value} onChange={setValue} search={searchWorks}
                placeholder="作品名" />
            )}
            {where === "matter" && (
              <SearchSelect value={value} onChange={setValue} search={searchMatters}
                placeholder="案件番号・件名" />
            )}
            {where === "q" && (
              <input value={text} placeholder="条件名・条件番号・相手先・作品"
                style={{ minWidth: 280 }}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && find()} />
            )}
            <button className="btn accent" onClick={() => find()} disabled={busy || !query()}>
              {busy ? "探しています…" : "探す"}
            </button>
          </div>
        </div>
      </div>

      {rows && (
        <div className="panel">
          <div className="panel-hd">
            <h2>② 条件明細の候補（{rows.length}件）</h2>
          </div>
          <div className="panel-bd">
            {!rows.length
              ? <p className="faint">当たりませんでした。</p>
              : <div className="tablewrap">
                  <table>
                    <thead><tr>
                      <th>条件</th><th>計算方式</th><th>契約期間</th>
                      <th className="num">予定</th><th className="num">残り</th><th>次の締め</th><th></th>
                    </tr></thead>
                    <tbody>
                      {rows.map((c) => (
                        // 行ごと押せる。CSS が行に指のかたちを付けるので、
                        // 右端のボタンだけが効く作りだと「押しても開かない」に見える。
                        <tr key={c.id} tabIndex={0}
                            className={picked?.condition.id === c.id ? "sel" : undefined}
                            onClick={() => go(c)}
                            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && go(c)}>
                          <td>
                            {/* 名前は条件明細の画面へ。行の押し先（回を見る）とは別。 */}
                            <button className="linky" onClick={(e) => {
                              e.stopPropagation(); onOpenCondition(c.id);
                            }}>{c.name}</button>
                            <div className="faint code">{c.conditionNo ?? `#${c.id}`}</div>
                            <div className="faint">{c.party?.name ?? "—"}</div>
                          </td>
                          <td>
                            {PRICING_MODEL_LABEL[c.pricingModel] ?? c.pricingModel}
                            {c.ratePpm !== null && <span className="code">　{rate(c.ratePpm)}</span>}
                            {c.needsReport && <div className="faint">売上報告が要ります</div>}
                          </td>
                          <td className="code">
                            {c.termStart || c.termEnd ? `${c.termStart ?? "—"} 〜 ${c.termEnd ?? "—"}` : "—"}
                          </td>
                          <td className="num">{c.periodCount}</td>
                          <td className="num">{c.openCount}</td>
                          <td className="code">{c.nextClosingOn ?? "—"}</td>
                          <td>
                            <button className="btn btn-sm"
                              onClick={(e) => { e.stopPropagation(); go(c); }}>
                              {actionOf(c)}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>}
          </div>
        </div>
      )}

      {picked && (
        <div className="panel">
          <div className="panel-hd">
            <h2>③ {picked.condition.name} の回</h2>
            <span className="faint">
              {picked.condition.conditionNo ?? `#${picked.condition.id}`}　
              予定 {money(picked.total.planned)}／実績 {money(picked.total.recorded)}／
              支払 {money(picked.total.paid)}
            </span>
          </div>
          <div className="panel-bd stack">
            {closing
              ? <ClosingRun scheduleIds={[...selected]}
                  onRan={() => open(picked.condition.id)}
                  onDone={() => setClosing(false)}
                  onCancel={() => setClosing(false)} />
              : selected.size > 0 && (
                <div className="bulkbar">
                  <strong>{selected.size} 行</strong>を選択中
                  <button className="btn btn-sm" onClick={() => setClosing(true)}>まとめて締める</button>
                </div>
              )}
            <ClosingRows rows={picked.rows} showParty={false}
              selected={selected} onSelect={setSelected}
              onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
              onRecord={onRecord}
              empty="この条件にはまだ回が並んでいません。" />
            {!picked.rows.length && (
              <div className="row">
                <button className="btn accent" onClick={() => go(picked.condition)}>
                  {actionOf(picked.condition)}
                </button>
              </div>
            )}
            <p className="faint">
              ③ は月の表と同じ行です。予定明細1回が1行、列も同じ。
              違うのは切り口だけで、月で切るか条件で切るかです。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 候補の行を、算定期間を並べる欄が要る形に読み替える。
 * 料率は候補一覧に出る条件でも別枠でも同じものを並べるので、欄は1つにする。
 */
const gapOf = (c: CandidateRow): RoyaltyGap => ({
  id: c.id, conditionNo: c.conditionNo, name: c.name,
  party: c.party, work: c.work, ratePpm: c.ratePpm,
  termStart: c.termStart, termEnd: c.termEnd,
  schedulable: !!(c.termStart && c.termEnd),
  monthSpan: monthsBetween(c.termStart, c.termEnd)
});

/** 契約期間が何か月あるか。サーバの monthsBetween と同じ数え方（両端を含む）。 */
export function monthsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = { y: Number(from.slice(0, 4)), m: Number(from.slice(5, 7)) };
  const b = { y: Number(to.slice(0, 4)), m: Number(to.slice(5, 7)) };
  if (!a.y || !b.y) return null;
  const months = (b.y - a.y) * 12 + (b.m - a.m) + 1;
  return months > 0 ? months : null;
}

const searchWorks = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ works: Array<{ id: number; title: string; workCode?: string | null }> }>(
    `/works?q=${encodeURIComponent(q)}`);
  return r.works.map((w) => ({ value: String(w.id), label: w.title, hint: w.workCode ?? null }));
};

const searchMatters = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ matters: Array<{ id: number; matterNo: string | null; title: string }> }>(
    `/matters?q=${encodeURIComponent(q)}`);
  return r.matters.map((m) => ({ value: String(m.id), label: `${m.matterNo ?? `#${m.id}`} ${m.title}` }));
};

// ---------------------------------------------------------------------------
// 月の表からこぼれるもの
// ---------------------------------------------------------------------------

function StraysPanel({ onOpenCondition, onOpenDocument, onRecord }: {
  onOpenCondition: (id: number) => void;
  onOpenDocument: (id: number) => void;
  onRecord: (conditionId: number, scheduleId: number) => void;
}) {
  const [strays, setStrays] = useState<StrayView | null>(null);
  const [gaps, setGaps] = useState<RoyaltyGap[] | null>(null);
  const [building, setBuilding] = useState<RoyaltyGap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setError(null);
    Promise.all([
      api.get<StrayView>("/closing/strays"),
      api.get<{ rows: RoyaltyGap[] }>("/closing/royalty-gaps")
    ]).then(([s, g]) => { setStrays(s); setGaps(g.rows); })
      .catch((e: ApiError) => setError(e.message));
  }, [version]);

  if (building) {
    return <ClosingSchedule gap={building}
      onDone={() => { setBuilding(null); setVersion((n) => n + 1); }}
      onCancel={() => setBuilding(null)} />;
  }

  const ready = (gaps ?? []).filter((g) => g.schedulable);
  const blocked = (gaps ?? []).filter((g) => !g.schedulable);

  return (
    <div className="stack">
      {error && <div className="alert">{error}</div>}
      <p className="faint">
        月の表に並ぶのは「その月に締め日が来る予定明細」です。そこから外れるものを出します。
        放っておくと棚卸しで拾うことになります。
      </p>

      <div className="panel">
        <div className="panel-hd">
          <h2>締め日を過ぎて実績・報告がない（{strays?.overdue.length ?? 0}）</h2>
          <span className="faint">翌月の表には出てこない</span>
        </div>
        <div className="panel-bd">
          <ClosingRows rows={strays?.overdue ?? []}
            onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
            onRecord={onRecord}
            empty="ありません。" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd">
          <h2>予定が無いのに実績がある（{strays?.unplanned.length ?? 0}）</h2>
          <span className="faint">締められるが、予定との差が見られない</span>
        </div>
        <div className="panel-bd">
          <ClosingRows rows={strays?.unplanned ?? []}
            onOpenCondition={onOpenCondition} onOpenDocument={onOpenDocument}
            empty="ありません。" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd">
          <h2>料率で算定期間が並んでいない（{gaps?.length ?? 0}）</h2>
          <span className="faint">予定が0本の条件は月の表に出てきようがない</span>
        </div>
        <div className="panel-bd stack">
          <p className="faint">
            一括では並べません。契約期間の入力が怪しい条件が混ざっていると、間違った期が
            まとめて並びます。1本ずつ、人が見て並べます。
          </p>
          <GapTable rows={ready} title={`契約期間あり → その場で並べられる（${ready.length}）`}
            onBuild={setBuilding} onOpenCondition={onOpenCondition} />
          <GapTable rows={blocked} title={`契約期間が空 → 条件を先に直す（${blocked.length}）`}
            onOpenCondition={onOpenCondition} />
        </div>
      </div>
    </div>
  );
}

/** 一度に出す行数。84本を全部並べると、下の何もかもが読めなくなる。 */
const GAP_PAGE = 12;

function GapTable({ rows, title, onBuild, onOpenCondition }: {
  rows: RoyaltyGap[]; title: string;
  onBuild?: (gap: RoyaltyGap) => void;
  onOpenCondition: (id: number) => void;
}) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const shown = all ? rows : rows.slice(0, GAP_PAGE);
  return (
    <div className="stack">
      <strong>{title}</strong>
      <div className="tablewrap">
        <table>
          <thead><tr>
            <th>条件</th><th>取引先</th><th className="num">料率</th><th>契約期間</th><th></th>
          </tr></thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.id}>
                <td>
                  <button className="linky" onClick={() => onOpenCondition(g.id)}>{g.name}</button>
                  <div className="faint code">{g.conditionNo ?? `#${g.id}`}</div>
                </td>
                <td>{g.party?.name ?? "—"}</td>
                <td className="num">{rate(g.ratePpm)}</td>
                <td className="code">
                  {g.termStart || g.termEnd
                    ? <>{g.termStart ?? "—"} 〜 {g.termEnd ?? "—"}
                        {g.monthSpan && <span className="faint">（{g.monthSpan}か月）</span>}</>
                    : <span className="faint">開始も終了も空</span>}
                </td>
                <td>
                  {onBuild
                    ? <button className="btn btn-sm" onClick={() => onBuild(g)}>並べる</button>
                    : <span className="faint">条件画面で期間を入れる</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > GAP_PAGE && (
        <button className="btn btn-sm" onClick={() => setAll(!all)}>
          {all ? "畳む" : `ほか ${rows.length - GAP_PAGE} 件を出す`}
        </button>
      )}
    </div>
  );
}
