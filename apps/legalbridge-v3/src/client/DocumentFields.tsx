import { useEffect, useState } from "react";
import { useDebounced } from "./ListTools.js";
import { api } from "./api.js";

/**
 * 文書作成フォームの入力欄。ひな形の項目を区分ごとに縦に並べる。
 *
 * これまでは「必須なのに空の項目」だけを1つの格子に並べていた。何が自動で
 * 埋まり、何を人が入れるのかが見えず、任意の項目（備考など）はそもそも
 * 出てこなかった。V2 のフォーム（区分 I〜VII の見出し・項目の説明）を下敷きに、
 * 全項目を出どころ付きで見せる。
 *
 *   計算   … 明細・合計・消費税。手で直せない（表と合計がずれる）
 *   自動   … 条件・合意・相手先・案件から引いた。空なら手で補える。上書きもできる
 *   手入力 … ここから決まらない。人が入れる
 */
export interface FormField {
  name: string; label: string; group: string | null; type: string; required: boolean;
  source: "computed" | "auto" | "manual"; value: unknown;
  helpText: string | null; placeholder: string | null; options: string[] | null;
  readonly: boolean;
}
export interface Candidate { label: string; value: string; source: string; kind: "date" | "amount" | "text" }

const SOURCE_LABEL = { computed: "計算", auto: "自動", manual: "手入力" } as const;

/**
 * 入力欄の名前から、その欄に合う候補の種類を当てる。
 * 日付の欄に金額の候補を並べても選べない。当たらなければ全部出す。
 */
export function kindFor(name: string, label: string, type?: string): Candidate["kind"] | null {
  if (type === "date") return "date";
  if (type === "number") return "amount";
  const s = `${name} ${label}`;
  if (/日|期日|年月日/.test(s) && !/氏名|名前/.test(label)) return "date";
  if (/額|金額|価格|料金|税/.test(s)) return "amount";
  if (/名|者|部署|内容|件名|住所|番号/.test(s)) return "text";
  return null;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** 区分の見出し。V1 の field_schema は "I. 基本情報" のように番号を持っている。 */
export function groupsOf(fields: FormField[]): Array<{ name: string; fields: FormField[] }> {
  const order: string[] = [];
  const by = new Map<string, FormField[]>();
  for (const f of fields) {
    const g = f.group ?? "その他の入力";
    if (!by.has(g)) { by.set(g, []); order.push(g); }
    by.get(g)!.push(f);
  }
  // 区分の無い項目は末尾へ（番号付きの区分の前に割り込ませない）。
  const named = order.filter((g) => g !== "その他の入力");
  const rest = order.filter((g) => g === "その他の入力");
  return [...named, ...rest].map((name) => ({ name, fields: by.get(name)! }));
}

export function DocumentFields(
  { fields, manual, candidates, partyId, onChange, onPick }: {
    fields: FormField[];
    /** 人が入れた値。自動の欄を上書きしたものも含む。 */
    manual: Record<string, string>;
    candidates: Candidate[];
    /**
     * この文書の相手先。決まっていれば「探して入れる」で、その取引先の
     * 契約と文書を引ける。他社の契約が並ぶと選び間違えるので絞る。
     */
    partyId?: number | null;
    /** 手で打った。 */
    onChange: (name: string, value: string) => void;
    /** 候補から選んだ（「前回の値」として覚えない）。 */
    onPick: (name: string, value: string) => void;
  }
) {
  // 自動の欄を手で直している最中のもの。
  const [overriding, setOverriding] = useState<Set<string>>(new Set());
  // 候補を開いている欄。文字の欄は候補が多いので、押したときだけ出す。
  const [opened, setOpened] = useState<Set<string>>(new Set());
  // 候補に無い人を名前で探して引く。別部署の検収者や、相手先の別の担当者。
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [quoteQ, setQuoteQ] = useState("");
  const [quoteHits, setQuoteHits] = useState<Candidate[]>([]);
  const quoteSearch = useDebounced(quoteQ, 300);

  useEffect(() => {
    // 取引先が決まっていれば、打つ前でもその取引先の契約と文書を並べる。
    // 基本契約名のような欄は「この相手との契約」から選ぶもので、思い出して
    // 打つものではない。
    if (!quoteFor || (!quoteSearch.trim() && !partyId)) { setQuoteHits([]); return; }
    const params = new URLSearchParams({ q: quoteSearch.trim() });
    if (partyId) params.set("partyId", String(partyId));
    api.get<{ candidates: Candidate[] }>(`/quote-sources?${params}`)
      .then((r) => setQuoteHits(r.candidates)).catch(() => setQuoteHits([]));
  }, [quoteFor, quoteSearch, partyId]);

  const toggle = (set: Set<string>, name: string) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  };

  if (!fields.length) {
    return (
      <div className="panel">
        <div className="panel-bd faint">
          このひな形に人が入れる項目はありません。条件明細と実績から本文が埋まります。
        </div>
      </div>
    );
  }

  const groups = groupsOf(fields);

  return (
    <>
      {groups.map((g) => (
        <div key={g.name} className="panel fsec">
          <div className="panel-hd">
            <h2>{g.name}</h2>
            <span className="faint">
              {g.fields.filter((f) => f.source !== "manual").length > 0 &&
                `自動 ${g.fields.filter((f) => f.source !== "manual").length}`}
              {g.fields.some((f) => f.source === "manual") &&
                `　手入力 ${g.fields.filter((f) => f.source === "manual").length}`}
            </span>
          </div>
          <div className="panel-bd stack" style={{ gap: 10 }}>
            {g.fields.map((f) => {
              const editing = f.source === "manual" || overriding.has(f.name)
                || (f.source === "auto" && f.name in manual);
              const value = f.name in manual ? manual[f.name] : show(f.value);
              const blank = !String(value ?? "").trim();
              const want = kindFor(f.name, f.label, f.type);
              const fits = candidates.filter((c) => !want || c.kind === want);
              const inline = want === "date" || want === "amount";
              const open = inline || opened.has(f.name);
              return (
                <div key={f.name} className={`frow${f.required && blank && editing ? " miss" : ""}`}>
                  <div className="flabel">
                    <span className={`src ${f.source}`}>{SOURCE_LABEL[f.source]}</span>
                    <span>{f.label}{f.required && <em className="req"> 必須</em>}</span>
                  </div>
                  <div className="fbody">
                    {!editing ? (
                      <div className="fro">
                        <span className={blank ? "faint" : ""}>{blank ? "（空）" : show(f.value)}</span>
                        {f.source === "auto" && !f.readonly && (
                          <button type="button" className="linky"
                                  onClick={() => setOverriding((s) => toggle(s, f.name))}>
                            {blank ? "手で入れる" : "上書きする"}
                          </button>
                        )}
                      </div>
                    ) : f.type === "textarea" ? (
                      <textarea rows={3} value={value} placeholder={f.placeholder ?? undefined}
                                onChange={(e) => onChange(f.name, e.target.value)} />
                    ) : f.type === "select" && f.options?.length ? (
                      <select value={value} onChange={(e) => onChange(f.name, e.target.value)}>
                        <option value="">選んでください</option>
                        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : f.type === "boolean" ? (
                      <label className="row" style={{ gap: 6 }}>
                        <input type="checkbox" checked={value === "true" || value === "1"}
                               onChange={(e) => onChange(f.name, e.target.checked ? "true" : "")} />
                        <span className="faint">{f.helpText ?? ""}</span>
                      </label>
                    ) : (
                      <input value={value} placeholder={f.placeholder ?? undefined}
                             type={f.type === "date" ? "date" : "text"}
                             inputMode={f.type === "number" ? "numeric" : undefined}
                             onChange={(e) => onChange(f.name, e.target.value)} />
                    )}
                    {editing && f.source === "auto" && (
                      <div className="row" style={{ gap: 6, marginTop: 4 }}>
                        <span className="faint">自動の値: {show(f.value) || "（空）"}</span>
                        <button type="button" className="linky"
                                onClick={() => {
                                  onChange(f.name, "");
                                  setOverriding((s) => { const n = new Set(s); n.delete(f.name); return n; });
                                }}>自動に戻す</button>
                      </div>
                    )}
                    {editing && f.type !== "boolean" && (
                      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                        {!inline && fits.length > 0 && (
                          <button type="button" className="btn btn-sm"
                                  onClick={() => setOpened((s) => toggle(s, f.name))}>
                            候補 {open ? "▴" : "▾"}
                          </button>
                        )}
                        {!inline && (
                          <button type="button" className="btn btn-sm"
                                  onClick={() => {
                                    setQuoteFor(quoteFor === f.name ? null : f.name);
                                    setQuoteQ(""); setQuoteHits([]);
                                  }}>
                            探して入れる
                          </button>
                        )}
                        {quoteFor === f.name && (
                          <div className="stack" style={{ gap: 4, width: "100%", marginTop: 4 }}>
                            <input value={quoteQ} autoFocus
                                   placeholder={partyId
                                     ? "この取引先の契約・文書、スタッフ・先方担当を名前で探す"
                                     : "スタッフ・取引先・先方担当を名前で探す"}
                                   onChange={(e) => setQuoteQ(e.target.value)} />
                            <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                              {quoteHits.map((c) => (
                                <button key={`${c.label}:${c.value}`} type="button"
                                        className="btn btn-sm" style={{ whiteSpace: "nowrap" }}
                                        title={c.source}
                                        onClick={() => { onPick(f.name, c.value); setQuoteFor(null); }}>
                                  {c.value}
                                  <span className="faint" style={{ marginLeft: 4 }}>{c.label}</span>
                                </button>
                              ))}
                              {quoteSearch.trim() && !quoteHits.length && (
                                <span className="faint">見つかりません</span>
                              )}
                            </div>
                          </div>
                        )}
                        {open && fits.slice(0, 8).map((c) => (
                          <button key={`${c.label}:${c.value}`} type="button"
                                  className="btn btn-sm" style={{ whiteSpace: "nowrap" }}
                                  title={`${c.source}／${c.label}`}
                                  onClick={() => onPick(f.name, c.value)}>
                            {c.value}
                            <span className="faint" style={{ marginLeft: 4 }}>{c.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {f.helpText && f.type !== "boolean" && (
                      <div className="faint" style={{ marginTop: 3 }}>{f.helpText}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
