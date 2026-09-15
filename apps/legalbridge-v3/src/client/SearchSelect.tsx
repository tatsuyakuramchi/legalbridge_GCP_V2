import { useEffect, useMemo, useRef, useState } from "react";
import { useDebounced } from "./ListTools.js";
import { api } from "./api.js";

/**
 * 検索して選ぶ欄。
 *
 * 取引先は 2,500 件、担当者も部署をまたぐと一覧から目で探せない。
 * プルダウンの代わりに、名前の一部を打って絞り、上下キーか押して決める。
 *
 * 選択肢は2通りで渡せる。
 *   options … 手元にある一覧（担当者・作品）。ここで絞る。
 *   search  … サーバに聞く（取引先）。打つたびに問い合わせる（少し待ってから）。
 * どちらも「表示は名前、値は ID」で扱う。
 */
export interface SearchOption {
  value: string;
  label: string;
  /** 部署・コードなど、同名を見分ける手がかり。 */
  hint?: string | null;
}

export function SearchSelect(
  { value, onChange, options, search, placeholder, emptyLabel, disabled, autoFocus, valueLabel }: {
    value: string;
    onChange: (value: string, option: SearchOption | null) => void;
    options?: SearchOption[];
    search?: (q: string) => Promise<SearchOption[]>;
    placeholder?: string;
    /** 空にできるなら、その選択肢の名前。無ければ空にはできない。 */
    emptyLabel?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    /** 選択肢にまだ無い値の表示名（編集で開いたときの現在値）。 */
    valueLabel?: string | null;
  }
) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchOption[]>([]);
  const [cursor, setCursor] = useState(0);
  const q = useDebounced(text, 250);
  const box = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => (options ?? hits).find((o) => o.value === value) ?? null, [options, hits, value]);
  const shownLabel = selected?.label ?? valueLabel ?? (value ? `#${value}` : "");

  // 手元の一覧はここで絞る。名前・手がかりのどちらに当たってもよい。
  const local = useMemo(() => {
    if (!options) return null;
    const needle = text.trim().toLowerCase();
    const matched = needle
      ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle))
      : options;
    return matched.slice(0, 40);
  }, [options, text]);

  useEffect(() => {
    if (!search || !open) return;
    let alive = true;
    search(q.trim()).then((r) => { if (alive) setHits(r.slice(0, 40)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [search, q, open]);

  const list = local ?? hits;
  const rows: SearchOption[] = emptyLabel && !text.trim()
    ? [{ value: "", label: emptyLabel }, ...list] : list;

  useEffect(() => { setCursor(0); }, [text, open]);

  // 外を押したら閉じる。
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setText(""); }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (o: SearchOption) => {
    onChange(o.value, o.value ? o : null);
    setOpen(false); setText("");
  };

  return (
    <div className="sselect" ref={box}>
      <input
        value={open ? text : shownLabel}
        placeholder={placeholder ?? "名前で探す"}
        disabled={disabled} autoFocus={autoFocus}
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setText(e.target.value); if (!open) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          else if (e.key === "Enter") { e.preventDefault(); if (open && rows[cursor]) pick(rows[cursor]); }
          else if (e.key === "Escape") { setOpen(false); setText(""); }
        }} />
      {open && (
        <div className="sselect-menu" role="listbox">
          {rows.length === 0 && (
            <div className="sselect-empty">
              {text.trim() ? "見つかりません" : search ? "名前の一部を打って探す" : "候補がありません"}
            </div>
          )}
          {rows.map((o, i) => (
            <div key={o.value || "__empty"} role="option" aria-selected={i === cursor}
                 className={`sselect-item${o.value === value ? " current" : ""}`}
                 onMouseEnter={() => setCursor(i)}
                 onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              <span>{o.label}</span>
              {o.hint && <span className="faint">{o.hint}</span>}
            </div>
          ))}
          {list.length >= 40 && <div className="sselect-empty">さらに絞ってください</div>}
        </div>
      )}
    </div>
  );
}

/** 取引先をサーバに聞く。名前・コード・別名・カナのどれかに当たる。 */
export const searchParties = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ parties: Array<{ id: number; name: string; partyCode: string | null; status: string }> }>(
    `/parties?q=${encodeURIComponent(q)}`);
  return r.parties
    .filter((p) => p.status !== "merged")
    .map((p) => ({ value: String(p.id), label: p.name, hint: p.partyCode }));
};

/** 担当者の選択肢。退職者は書類に出す担当にできないので、既定では出さない。 */
export const staffOptions = (
  staff: Array<{ id: number; name: string; department?: string | null; status?: string }>,
  includeRetired = false
): SearchOption[] =>
  staff
    .filter((s) => includeRetired || (s.status ?? "active") === "active")
    .map((s) => ({ value: String(s.id), label: s.name, hint: s.department ?? null }));
