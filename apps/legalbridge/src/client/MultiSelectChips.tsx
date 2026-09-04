import { useEffect, useRef, useState } from "react";
import type { CodedName } from "../condition-ledger";
import { searchCodedNames, type TerritoryGroup } from "./territory-master";

// 複数選択チップ（許諾地域・言語）。検索して候補から追加、× で外す。
// 候補に無い名前も Enter で自由追加できる（コード無し）。

export function MultiSelectChips({ value, groups, placeholder, onChange, compact }: {
  value: CodedName[];
  groups: TerritoryGroup[];
  placeholder?: string;
  onChange: (next: CodedName[]) => void;
  compact?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const hits = open ? searchCodedNames(groups, query, value) : [];
  const add = (item: CodedName) => { onChange([...value, item]); setQuery(""); };
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index));

  return <div className={`msc${compact ? " compact" : ""}`} ref={root}>
    <div className="msc-chips" onClick={() => setOpen(true)}>
      {value.map((item, index) => <span key={`${item.code ?? ""}|${item.name}|${index}`} className="msc-chip" title={item.code ?? undefined}>
        {item.name}<button type="button" aria-label={`${item.name} を外す`} onClick={(e) => { e.stopPropagation(); remove(index); }}>×</button>
      </span>)}
      <input value={query} placeholder={value.length ? "追加…" : (placeholder ?? "検索して追加…")}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query.trim()) {
            e.preventDefault();
            const first = hits[0]?.items[0];
            add(first && first.name.toLowerCase().includes(query.trim().toLowerCase()) ? first : { code: null, name: query.trim() });
          }
          if (e.key === "Backspace" && !query && value.length) remove(value.length - 1);
        }} />
    </div>
    {open && hits.length > 0 && <div className="msc-pop" role="listbox">
      {hits.map((g) => <div key={g.label}>
        <div className="msc-grp">{g.label}</div>
        {g.items.slice(0, 40).map((item) => <button type="button" role="option" key={`${item.code ?? ""}|${item.name}`}
          onMouseDown={(e) => { e.preventDefault(); add(item); }}>{item.name}{item.code && !item.code.startsWith("R-") && !item.code.startsWith("WW") && item.code !== "ALL" ? <small>{item.code}</small> : null}</button>)}
      </div>)}
    </div>}
  </div>;
}
