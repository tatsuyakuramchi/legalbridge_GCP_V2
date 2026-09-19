import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import { SNIPPET_CATEGORIES, SNIPPET_CATEGORY_LABEL } from "../server/snippets/categories.js";

/**
 * 定型文の貼り付け。長文の欄の脇に出す。
 *
 * 許諾範囲・特約・仕様は、毎回ゼロから書くものではなく、全社で決めた言い回しを
 * 選んで貼るもの。V2 は定型文の画面を別タブで開いてコピーし、フォームに戻って
 * 貼っていた（Phase 16-1）。V3 は画面を移らずにその場で入れる。別タブへ移る
 * 導線だと、書きかけのフォームを置いて戻ってくることになる。
 *
 * 「入れる」は末尾に足す（今書いてあるものを消さない）。空なら本文そのもの。
 */
export interface Snippet {
  id: number; category: string; title: string; body: string; sortOrder: number;
}

/** 一度読んだら画面のあいだは使い回す。欄ごとに読み直すものではない。 */
let cache: Promise<Snippet[]> | null = null;
export const loadSnippets = (reload = false): Promise<Snippet[]> => {
  if (reload || !cache) {
    cache = api.get<{ snippets: Snippet[] }>("/snippets")
      .then((r) => r.snippets).catch(() => []);
  }
  return cache;
};
/** 定型文を直したあとに呼ぶ。開いたままの文書フォームにも次から新しい一覧が出る。 */
export const forgetSnippets = () => { cache = null; };

export function SnippetPicker(
  { value, onInsert, hint }: {
    /** 今の欄の中身。空かどうかで「入れる」の意味が変わる。 */
    value: string;
    onInsert: (next: string) => void;
    /** 最初に開く区分。許諾範囲の欄なら scope。 */
    hint?: string;
  }
) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Snippet[] | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>(hint ?? "");

  useEffect(() => { if (open && !rows) void loadSnippets().then(setRows); }, [open, rows]);

  const hits = useMemo(() => {
    const all = rows ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((s) =>
      (!category || s.category === category)
      && (!needle || s.title.toLowerCase().includes(needle)
          || s.body.toLowerCase().includes(needle)));
  }, [rows, q, category]);

  // 区分の札は、実際に文面がある区分だけ出す。空の区分を押させない。
  const used = useMemo(() => {
    const have = new Set((rows ?? []).map((s) => s.category));
    return SNIPPET_CATEGORIES.filter((c) => have.has(c));
  }, [rows]);

  const insert = (body: string) => {
    const current = String(value ?? "");
    onInsert(current.trim() ? `${current.replace(/\s+$/, "")}\n${body}` : body);
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>定型文</button>
    );
  }

  return (
    <div className="stack" style={{ gap: 4, width: "100%" }}>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        <input value={q} autoFocus placeholder="定型文を名前か本文で探す"
               style={{ flex: "1 1 200px" }}
               onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>閉じる</button>
      </div>
      {used.length > 1 && (
        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
          <button type="button" className={`btn btn-sm${category ? "" : " primary"}`}
                  onClick={() => setCategory("")}>すべて</button>
          {used.map((c) => (
            <button key={c} type="button"
                    className={`btn btn-sm${category === c ? " primary" : ""}`}
                    onClick={() => setCategory(c)}>
              {SNIPPET_CATEGORY_LABEL[c] ?? c}
            </button>
          ))}
        </div>
      )}
      {rows === null && <span className="faint">読み込み中…</span>}
      {rows !== null && !rows.length && (
        <span className="faint">
          定型文はまだありません（運用 ▸ 定型文 で、管理者か法務が足せます）
        </span>
      )}
      {rows !== null && rows.length > 0 && !hits.length && (
        <span className="faint">見つかりません</span>
      )}
      <div className="picker">
        {hits.map((s) => (
          <div key={s.id} className="snip">
            <div className="row" style={{ gap: 6 }}>
              <b>{s.title}</b>
              <span className="faint">{SNIPPET_CATEGORY_LABEL[s.category] ?? s.category}</span>
              <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }}
                      onClick={() => insert(s.body)}>
                {String(value ?? "").trim() ? "末尾に足す" : "入れる"}
              </button>
            </div>
            <p className="faint">{s.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
