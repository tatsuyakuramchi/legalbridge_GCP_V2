import { useMemo, useState } from "react";
import {
  ALL_LANGUAGE, COUNTRY_CODES, LANGUAGE_CODES, REGION_PRESETS, WORLD_REGION,
  displayScope, languageName, parseLanguages, parseRegions, regionName, type ScopeOption
} from "./rights-scope.js";

/**
 * 許諾の範囲（地域・言語）を複数選ぶ欄。V2 の RightsScopePicker の移植。
 *
 * 自由記載だと「日本」「日本国内」「JP」が別物として入り、作品の権利包絡
 * （全パートの取得条件の積）が割れる。ISO のコードから選ばせる。
 *
 * 値は表示名を「、」で繋いだ文字列で持つ（書類の本文がその形で差すため）。
 * 開くときは名前からコードへ引き当てる。当たらない語は自由記載として残す。
 */
export function RightsScopePicker(
  { kind, value, onChange, disabled }: {
    kind: "region" | "language";
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }
) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const region = kind === "region";
  const universal = region ? WORLD_REGION : ALL_LANGUAGE;
  const selected = useMemo(
    () => (region ? parseRegions(value) : parseLanguages(value)), [kind, value]);
  const hasUniversal = selected.some((s) => s.code === universal.code);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const codes: readonly string[] = region ? COUNTRY_CODES : LANGUAGE_CODES;
    const name = region ? regionName : languageName;
    return codes
      .map((code) => ({ code, name: name(code) }))
      .filter((o) => !q || o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
      .slice(0, 60);
  }, [kind, query]);

  const put = (next: ScopeOption[]) => onChange(displayScope(next));

  function toggle(option: ScopeOption) {
    if (option.code === universal.code) {
      put(hasUniversal ? [] : [universal]);
      return;
    }
    // 全世界・全言語と個別の指定は同居しない。個別を選んだら全体は外れる。
    const base = selected.filter((s) => s.code !== universal.code);
    const found = base.some((s) => s.code === option.code && s.code !== "");
    put(found ? base.filter((s) => s.code !== option.code) : [...base, option]);
  }

  return (
    <div className="stack" style={{ gap: 5 }}>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className={`btn btn-sm${hasUniversal ? " primary" : ""}`}
                disabled={disabled} onClick={() => toggle(universal)}>
          {universal.name}
        </button>
        {region && Object.entries(REGION_PRESETS).map(([label, codes]) => (
          <button type="button" key={label} className="btn btn-sm" disabled={disabled}
                  onClick={() => put(codes.map((code) => ({ code, name: regionName(code) })))}>
            {label}
          </button>
        ))}
        <button type="button" className="btn btn-sm" disabled={disabled}
                onClick={() => { setOpen(!open); setQuery(""); }}>
          {open ? "閉じる" : region ? "国を選ぶ" : "言語を選ぶ"}
        </button>
        {selected.length > 0 && (
          <button type="button" className="btn btn-sm" disabled={disabled}
                  onClick={() => put([])}>空にする</button>
        )}
      </div>

      {selected.length ? (
        <div className="chips">
          {selected.map((s, i) => (
            <button type="button" key={`${s.code}:${i}`} className="tag" disabled={disabled}
                    title="外す"
                    onClick={() => put(selected.filter((_, n) => n !== i))}>
              {s.name}{s.code && s.code !== universal.code ? ` ${s.code}` : ""} ×
            </button>
          ))}
        </div>
      ) : (
        <span className="faint">未選択（空のまま出すと、本文のその欄は空欄になります）</span>
      )}

      {open && !hasUniversal && (
        <div className="stack" style={{ gap: 4 }}>
          <input value={query} autoFocus disabled={disabled}
                 placeholder={region ? "国名・ISO コードで探す" : "言語名・コードで探す"}
                 onChange={(e) => setQuery(e.target.value)} />
          <div className="picker">
            {options.map((o) => (
              <label key={o.code} className="pick">
                <input type="checkbox" disabled={disabled}
                       checked={selected.some((s) => s.code === o.code)}
                       onChange={() => toggle(o)} />
                <span>{o.name}</span>
                <span className="code faint">{o.code}</span>
              </label>
            ))}
            {!options.length && <span className="faint">見つかりません</span>}
          </div>
        </div>
      )}
      {open && hasUniversal && (
        <span className="faint">
          {universal.name}を選んでいるあいだは、個別の指定は要りません
        </span>
      )}
    </div>
  );
}
