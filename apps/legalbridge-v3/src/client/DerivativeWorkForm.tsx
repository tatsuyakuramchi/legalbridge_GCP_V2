import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 二次利用の作品を作る（シリーズのグッズ・アニメ化など）。
 *
 * 商品化・映像化などの二次利用は、1 冊ではなくシリーズ全体を対象に許諾することが多い。作品を 1 つ立てて、
 * 配下の書籍をまとめて原作として付ける（系譜。作品の種別は派生作品）。
 *
 *   ・二次利用追加条件書の行でこの作品を選ぶと、紙の「01 対象著作物」に原作が並び、条件明細はこの作品に 1 本付く
 *   ・利用許諾料計算書は、件名がこの作品の原作名（「シノビガミシリーズ」）、明細の製品名がこの作品名になる
 *
 * 作品の画面と、二次利用追加条件書の行（対象著作物の欄）の両方から使う。
 */
export const DERIVATIVE_CATEGORIES = ["商品化", "映像化", "デジタルゲーム化", "翻訳・翻案", "その他"] as const;

interface WorkOption { id: number; title: string; kind?: string; status?: string; workCode?: string | null }

export function DerivativeWorkForm(
  { initialCategory, onDone, onCancel }: {
    initialCategory?: string | null;
    onDone: (created: { id: number; title: string }) => void;
    onCancel: () => void;
  }
) {
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(
    initialCategory && (DERIVATIVE_CATEGORIES as readonly string[]).includes(initialCategory) ? initialCategory : "商品化");
  const [sourceTitle, setSourceTitle] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打った語でサーバに聞く（作品は数百点あり、一覧を一度に読むと先頭しか来ない）。選んだ作品は名前を覚えておく。
  useEffect(() => {
    const q = query.trim();
    if (!q) { setWorks([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api.get<{ works: WorkOption[] }>(`/works?q=${encodeURIComponent(q)}&limit=500`)
        .then((w) => { if (live) setWorks(w.works); }).catch(() => undefined);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  const [names, setNames] = useState<Record<number, string>>({});

  // 原作の候補：終了した作品と、二次利用の作品（派生作品）は出さない（原作は書籍などの元の作品）。
  const shown = useMemo(() => works.filter((w) => w.status !== "archived" && w.kind !== "derivative"), [works]);
  const pickedWorks = picked.map((id) => ({ id, title: names[id] ?? `#${id}` }));
  const remember = (list: WorkOption[]) => setNames((n) => ({ ...n, ...Object.fromEntries(list.map((w) => [w.id, w.title])) }));

  const toggle = (id: number) => { remember(shown); setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])); };
  const pickAllShown = () => { remember(shown); setPicked((p) => [...p, ...shown.map((w) => w.id).filter((id) => !p.includes(id))]); };
  // 名前を打つ前に原作を探したら、探した言葉を名前の候補にする（「シノビガミ」→「シノビガミ グッズ」）。
  const suggestTitle = () => (query.trim() ? `${query.trim()} ${category === "商品化" ? "グッズ" : category}` : "");

  const blockers = [
    !title.trim() ? "作品名" : "",
    !sourceTitle.trim() ? "計算書の件名（原作名）" : "",
    !picked.length ? "原作（1 つ以上）" : ""
  ].filter(Boolean);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const made = await api.post<{ id: number }>("/works", {
        title: title.trim(), kind: "derivative", status: "planning",
        sourceTitle: sourceTitle.trim(), businessLine: `二次利用（${category}）`, sourceWorkIds: picked
      });
      onDone({ id: made.id, title: title.trim() });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>二次利用の作品を作る</h2>
        <span className="faint">シリーズのグッズ・アニメ化など。配下の書籍を原作としてまとめて付ける</span>
      </div>
      <div className="panel-bd stack" style={{ gap: 10 }}>
        <div className="form-grid">
          <label className="field">
            <span>作品名 <em className="req">必須</em></span>
            <input value={title} placeholder="例：シノビガミ グッズ" onChange={(e) => setTitle(e.target.value)} />
            {/* 原作を探した語から名前の候補を出す。打っている途中で書き換えないよう、押したときだけ入れる。 */}
            {!title.trim() && suggestTitle() && (
              <button type="button" className="linky" style={{ alignSelf: "flex-start" }}
                      onClick={() => setTitle(suggestTitle())}>「{suggestTitle()}」にする</button>
            )}
            <small className="faint">利用許諾料計算書の明細の製品名になる</small>
          </label>
          <label className="field">
            <span>利用区分</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {DERIVATIVE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <small className="faint">作品の事業区分に「二次利用（{category}）」と入る</small>
          </label>
          <label className="field">
            <span>計算書の件名（原作名） <em className="req">必須</em></span>
            <input value={sourceTitle} placeholder="例：シノビガミシリーズ" onChange={(e) => setSourceTitle(e.target.value)} />
            <small className="faint">利用許諾料計算書の件名（原著作物名）になる。空だと原作の題名が全部並ぶので必ず入れる</small>
          </label>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <b>原作（配下の作品） <span className="faint">{picked.length} 点を選択</span></b>
          <div className="row" style={{ gap: 8 }}>
            <input value={query} placeholder="作品名の一部で探す（例：シノビガミ）" style={{ minWidth: 280 }}
                   onChange={(e) => setQuery(e.target.value)} aria-label="原作を探す" />
            <button type="button" className="btn btn-sm" disabled={!shown.length} onClick={pickAllShown}>
              表示中をすべて選ぶ{shown.length ? `（${shown.length}）` : ""}
            </button>
            {picked.length > 0 && <button type="button" className="btn btn-sm" onClick={() => setPicked([])}>選択を外す</button>}
          </div>
          {query.trim() && (
            <div className="picker" style={{ maxHeight: 220, overflow: "auto" }}>
              {shown.map((w) => (
                <label key={w.id} className="pick">
                  <input type="checkbox" checked={picked.includes(w.id)} onChange={() => toggle(w.id)} />
                  <span>{w.title}</span>
                  {w.workCode && <span className="code faint">{w.workCode}</span>}
                </label>
              ))}
              {!shown.length && <span className="faint">見つかりません</span>}
            </div>
          )}
          {pickedWorks.length > 0 && (
            <div className="chips">
              {pickedWorks.map((w) => (
                <button type="button" key={w.id} className="tag" title="外す" onClick={() => toggle(w.id)}>{w.title} ×</button>
              ))}
            </div>
          )}
          <small className="faint">
            二次利用追加条件書でこの作品を選ぶと、紙の「01 対象著作物」に原作がすべて並び、条件明細はこの作品に 1 本できる。
            原作はあとから作品の画面で足し引きできる
          </small>
        </div>

        {error && <div className="alert">{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void submit()}>
            {busy ? "作成中…" : "二次利用の作品を作る"}
          </button>
          <button className="btn" disabled={busy} onClick={onCancel}>やめる</button>
          {blockers.length > 0 && <span className="faint">{blockers.join("・")} が未入力です</span>}
        </div>
      </div>
    </div>
  );
}
