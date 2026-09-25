import { useEffect, useState } from "react";
import { useDebounced } from "./ListTools.js";
import { RightsScopePicker } from "./RightsScopePicker.js";
import { SnippetPicker } from "./SnippetPicker.js";
import { api } from "./api.js";
import { splitContact, joinContactParts, mergeContactPick,
         type ContactParts } from "../server/documents/contact-line.js";

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
 *   文案   … 条件から組み立てた下書き。そのまま出してもよいし、直してもよい
 *   手入力 … ここから決まらない。人が入れる
 */
export interface FormField {
  name: string; label: string; group: string | null; type: string; required: boolean;
  source: "computed" | "auto" | "suggested" | "manual"; value: unknown;
  helpText: string | null; placeholder: string | null; options: string[] | null;
  readonly: boolean;
}
export interface Candidate { label: string; value: string; source: string; kind: "date" | "amount" | "text";
  /** 決まった欄にだけ出す候補（支払条件の定型文など）。 */
  forFields?: string[] }

const SOURCE_LABEL =
  { computed: "計算", auto: "自動", suggested: "文案", manual: "手入力" } as const;

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

/**
 * 候補の札に出す文字。前回の許諾範囲のような長文は、そのまま出すと1行が
 * 画面からはみ出す。頭だけ見せて、全文は title で読めるようにする。
 */
const brief = (v: string): string => {
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > 32 ? `${one.slice(0, 32)}…` : one;
};

/* 前回の許諾範囲のような長文も並ぶので、1行に押し込めず枠の中で折り返す。 */
const CAND_STYLE = { whiteSpace: "normal", textAlign: "left", maxWidth: "100%" } as const;

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
  { fields, manual, candidates, partyId, onChange, onPick, blanked, onBlank }: {
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
    /** 「空にする」と決めた自動の欄。自動の値があっても紙には空で出す。 */
    blanked?: Set<string>;
    onBlank?: (name: string, on: boolean) => void;
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
    // どの欄から引いているかを伝える。前回この欄に入れた文言を並べるため。
    params.set("field", quoteFor);
    api.get<{ candidates: Candidate[] }>(`/quote-sources?${params}`)
      .then((r) => setQuoteHits(r.candidates)).catch(() => setQuoteHits([]));
  }, [quoteFor, quoteSearch, partyId]);

  /**
   * 候補を欄に入れる。通知先（contact）の欄だけは別の扱いにする。
   *
   * 通知先は 部署／氏名／メール／電話 の4つを1行に畳んだもので、候補は
   * 「◯◯ のメール」のように1つぶんしか持っていない。そのまま入れると、
   * 入れたつもりのない3つが消える（「検索すると一括で変わる」）。
   * どこに入る値かを札と値から決めて、そこだけ差し替える。
   */
  const pickInto = (f: FormField, current: string, c: Candidate) =>
    onPick(f.name, f.type === "contact" ? mergeContactPick(current, c.label, c.value) : c.value);

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
              {g.fields.filter((f) => f.source === "computed" || f.source === "auto").length > 0 &&
                `自動 ${g.fields.filter((f) => f.source === "computed" || f.source === "auto").length}`}
              {g.fields.some((f) => f.source === "suggested") &&
                `　文案 ${g.fields.filter((f) => f.source === "suggested").length}`}
              {g.fields.some((f) => f.source === "manual") &&
                `　手入力 ${g.fields.filter((f) => f.source === "manual").length}`}
            </span>
          </div>
          <div className="panel-bd stack" style={{ gap: 10 }}>
            {g.fields.map((f) => {
              const isBlanked = Boolean(blanked?.has(f.name));
              const editing = !isBlanked && (f.source === "manual" || f.source === "suggested"
                || overriding.has(f.name)
                || (f.source === "auto" && f.name in manual));
              const value = f.name in manual ? manual[f.name] : show(f.value);
              const blank = !String(value ?? "").trim();
              const want = kindFor(f.name, f.label, f.type);
              const fits = candidates.filter((c) => (!want || c.kind === want)
                && (!c.forFields || c.forFields.includes(f.name)));
              const inline = want === "date" || want === "amount";
              const open = inline || opened.has(f.name);
              return (
                <div key={f.name} className={`frow${f.required && blank && editing ? " miss" : ""}`}>
                  <div className="flabel">
                    <span className={`src ${f.source}`}>{SOURCE_LABEL[f.source]}</span>
                    <span>{f.label}{f.required && <em className="req"> 必須</em>}</span>
                  </div>
                  <div className="fbody">
                    {isBlanked ? (
                      <div className="fro">
                        <span className="faint">（空のまま出します）</span>
                        {onBlank && (
                          <button type="button" className="linky" onClick={() => onBlank(f.name, false)}>
                            自動に戻す
                          </button>
                        )}
                      </div>
                    ) : !editing ? (
                      <div className="fro">
                        <span className={blank ? "faint" : ""}>{blank ? "（空）" : show(f.value)}</span>
                        {f.source === "auto" && !f.readonly && (
                          <button type="button" className="linky"
                                  onClick={() => setOverriding((s) => toggle(s, f.name))}>
                            {blank ? "手で入れる" : "上書きする"}
                          </button>
                        )}
                        {f.source === "auto" && !f.readonly && !blank && onBlank && (
                          <button type="button" className="linky" title="自動の値を使わず、この欄を空のまま紙に出す"
                                  onClick={() => onBlank(f.name, true)}>
                            空にする
                          </button>
                        )}
                      </div>
                    ) : f.type === "contact" ? (
                      <ContactEditor value={value} candidates={candidates}
                                     side={/乙|被許諾者|自社|当社|発注者/.test(f.label) ? "licensee" : "licensor"}
                                     onChange={(v) => onChange(f.name, v)} />
                    ) : f.type === "regions" || f.type === "languages" ? (
                      /* 許諾の範囲。自由記載だと表記が割れるので ISO のコードから選ぶ。 */
                      <RightsScopePicker kind={f.type === "regions" ? "region" : "language"}
                                         value={value}
                                         onChange={(v) => onChange(f.name, v)} />
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
                        {/*
                          長文は台帳から引けるものではなく、決めた言い回しを選んで
                          貼るもの。許諾範囲がその代表で、V2 は定型文の画面を別タブで
                          開いてコピペしていた。
                        */}
                        {f.type === "textarea" && (
                          <SnippetPicker value={value}
                                         hint={/許諾|範囲|scope/i.test(`${f.name} ${f.label}`)
                                           ? "scope" : undefined}
                                         onInsert={(v) => onChange(f.name, v)} />
                        )}
                        {quoteFor === f.name && (
                          <div className="stack" style={{ gap: 4, width: "100%", marginTop: 4 }}>
                            <input value={quoteQ} autoFocus
                                   placeholder={partyId
                                     ? "この取引先の前回の文言・契約・文書、スタッフ・先方担当を名前で探す"
                                     : "スタッフ・取引先・先方担当を名前で探す"}
                                   onChange={(e) => setQuoteQ(e.target.value)} />
                            <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
                              {quoteHits.map((c) => (
                                <button key={`${c.label}:${c.value}`} type="button"
                                        className="btn btn-sm" style={CAND_STYLE}
                                        title={`${c.source}\n${c.value}`}
                                        onClick={() => { pickInto(f, value, c); setQuoteFor(null); }}>
                                  {brief(c.value)}
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
                                  className="btn btn-sm" style={CAND_STYLE}
                                  title={`${c.source}／${c.label}\n${c.value}`}
                                  onClick={() => pickInto(f, value, c)}>
                            {brief(c.value)}
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

/**
 * 通知先（部署 ／ 氏名 ／ メール ／ 電話）の欄。
 *
 * 紙には1行で出るが、1つの欄に「／」区切りで打たせると甲と乙で書き方が
 * 揃わない（乙は自動で4つ揃うのに、甲は電話だけ、のように）。4つの欄で
 * 編集し、値は紙と同じ1行で持つ。行き来と候補の入れ方は contact-line.ts。
 */

function ContactEditor(
  { value, candidates, side, onChange }: {
    value: string; candidates: Candidate[];
    /** 甲（相手先）なら取引先の担当者、乙（当社）なら案件の担当者を候補に出す。 */
    side: "licensor" | "licensee";
    onChange: (v: string) => void;
  }
) {
  const v = splitContact(value);
  const set = (key: keyof ContactParts, x: string) => onChange(joinContactParts({ ...v, [key]: x }));
  // 候補から 4 つまとめて入れる。候補の札は candidates.ts の付け方に合わせる。
  const get = (label: string) => candidates.find((c) => c.label === label)?.value ?? "";
  const from = (who: string) => ({
    department: get(`${who}の部署`), name: get(`${who}の氏名`), email: get(`${who}のメール`), phone: get(`${who}の電話`)
  });
  const fill = (side === "licensor"
    ? ["先方担当", "署名者", "請求先"].map((who) => ({ who, parts: from(who) }))
    : [{ who: "案件の担当者", parts: { department: get("担当者の部署"), name: get("担当者名"),
                                       email: get("担当者のメール"), phone: get("担当者の電話") } }])
    .filter((x) => x.parts.name || x.parts.email);
  const cell = (key: keyof ContactParts, label: string, placeholder: string, type = "text") => (
    <label className="stack" style={{ gap: 2, minWidth: 0 }}>
      <small className="faint">{label}</small>
      <input value={v[key]} placeholder={placeholder} type={type}
             onChange={(e) => set(key, e.target.value)} />
    </label>
  );
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px" }}>
        {cell("department", "部署", "編集部")}
        {cell("name", "氏名", "担当者名")}
        {cell("email", "メール", "tanto@example.co.jp", "email")}
        {cell("phone", "電話", "03-0000-0000", "tel")}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span className="faint">
          紙には「{joinContactParts(v) || "（空）"}」と出ます。
          「候補」「探して入れる」で選んだものは、選んだ1つぶん（氏名・部署・メール・電話のどれか）だけが入ります
        </span>
        {fill.map((x) => (
          <button key={x.who} type="button" className="linky"
                  onClick={() => onChange(joinContactParts(x.parts))}>{x.who}を入れる</button>
        ))}
      </div>
    </div>
  );
}
