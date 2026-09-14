import { useEffect, useState } from "react";
import { api } from "./api.js";
import { useDebounced } from "./ListTools.js";

/**
 * 送り先を検索して足す。
 *
 * 案件の候補（担当者と相手先の連絡先）だけでは、経理や他部署の人を写しに
 * 入れられなかった。名前・メール・取引先名で引いて、どの欄に足すかを選ぶ。
 *
 * 欄はメールなら to / cc / bcc、CloudSign なら署名者 / 確認者。同じ部品で
 * どちらも扱う（宛先の入れ方が画面ごとに違うと、片方だけ直す漏れが出る）。
 *
 * 一覧に無い相手は手で足せる。取引先マスタに連絡先が入っていない相手へも
 * 送れないと、登録待ちで止まる。
 */

export interface Person { email: string; name: string | null }
interface Candidate {
  kind: "contact" | "staff"; name: string | null; email: string;
  belongsTo: string | null; role: string | null; department: string | null;
}

export function RecipientPicker(
  { fields, value, onChange, initialKeyword }: {
    /** 足し先の欄。key は value の鍵。 */
    fields: Array<{ key: string; label: string; hint?: string }>;
    value: Record<string, Person[]>;
    onChange: (next: Record<string, Person[]>) => void;
    /** 最初に引いておく言葉。送り先の取引先名を入れておくと候補が近くなる。 */
    initialKeyword?: string;
  }
) {
  const [keyword, setKeyword] = useState(initialKeyword ?? "");
  const search = useDebounced(keyword);
  const [found, setFound] = useState<Candidate[]>([]);
  const [manual, setManual] = useState("");

  useEffect(() => {
    let live = true;
    api.get<{ recipients: Candidate[] }>(
      `/recipients/search${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`)
      .then((r) => { if (live) setFound(r.recipients); })
      .catch(() => { if (live) setFound([]); });
    return () => { live = false; };
  }, [search]);

  const has = (key: string, email: string) =>
    (value[key] ?? []).some((p) => p.email.toLowerCase() === email.toLowerCase());

  /** 同じ人を2つの欄に入れない。to と cc に同じ相手が入ると二重に届く。 */
  const add = (key: string, person: Person) => {
    const email = person.email.trim();
    if (!email) return;
    const next: Record<string, Person[]> = {};
    for (const f of fields) {
      next[f.key] = (value[f.key] ?? []).filter((p) => p.email.toLowerCase() !== email.toLowerCase());
    }
    next[key] = [...next[key], { email, name: person.name }];
    onChange(next);
  };
  const drop = (key: string, email: string) =>
    onChange({ ...value, [key]: (value[key] ?? []).filter((p) => p.email !== email) });

  return (
    <div className="stack" style={{ gap: 8 }}>
      {fields.map((f) => (
        <div key={f.key} className="frow">
          <div className="flabel"><span>{f.label}</span></div>
          <div className="fbody">
            <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
              {(value[f.key] ?? []).map((p) => (
                <span key={p.email} className="chip" aria-pressed="true">
                  {p.name ? `${p.name}（${p.email}）` : p.email}
                  <button className="linky" style={{ marginLeft: 6 }}
                          aria-label={`${p.email} を外す`}
                          onClick={() => drop(f.key, p.email)}>✕</button>
                </span>
              ))}
              {!(value[f.key] ?? []).length && <span className="faint">（なし）</span>}
            </div>
            {f.hint && <small className="faint">{f.hint}</small>}
          </div>
        </div>
      ))}

      <div className="frow">
        <div className="flabel"><span>探して足す</span></div>
        <div className="fbody stack" style={{ gap: 6 }}>
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)}
                 placeholder="名前・メール・取引先名" />
          <div className="picker" style={{ maxHeight: 220, overflowY: "auto" }}>
            {found.map((c) => (
              <div key={`${c.kind}:${c.email}`} className="row"
                   style={{ justifyContent: "space-between", gap: 8, padding: "3px 0" }}>
                <span>
                  <span className={`src ${c.kind === "staff" ? "auto" : "suggested"}`}>
                    {c.kind === "staff" ? "自社" : c.belongsTo ?? "取引先"}
                  </span>
                  {" "}{c.name ?? "（名前なし）"}
                  <span className="code faint">　{c.email}</span>
                  {c.role && <span className="faint">　{c.role}</span>}
                </span>
                <span className="row" style={{ gap: 4 }}>
                  {fields.map((f) => (
                    <button key={f.key} className="btn btn-sm"
                            disabled={has(f.key, c.email)}
                            onClick={() => add(f.key, { email: c.email, name: c.name })}>
                      {f.label}
                    </button>
                  ))}
                </span>
              </div>
            ))}
            {!found.length && <span className="faint">当たる相手がいません</span>}
          </div>
          {/* 一覧に無い相手。取引先マスタに連絡先が無くても送れるようにする。 */}
          <div className="row">
            <input value={manual} onChange={(e) => setManual(e.target.value)}
                   placeholder="一覧に無いメールアドレスを直接入れる" style={{ flex: 1 }} />
            {fields.map((f) => (
              <button key={f.key} className="btn btn-sm"
                      disabled={!manual.includes("@")}
                      onClick={() => { add(f.key, { email: manual.trim(), name: null }); setManual(""); }}>
                {f.label} に足す
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
