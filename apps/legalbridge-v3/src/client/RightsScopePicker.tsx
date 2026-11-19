import { useMemo, useState } from "react";
import {
  ALL_LANGUAGE, COUNTRY_CODES, LANGUAGE_CODES, REGION_PRESETS, WORLD_EX_JP_REGION, WORLD_REGION,
  displayScope, languageName, parseLanguages, parseRegions, regionName, type ScopeOption
} from "../server/core/rights-scope.js";

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
  { kind, value, onChange, disabled, emptyNote }: {
    kind: "region" | "language";
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    /**
     * 何も選んでいないときの添え書き。既定は書類の欄向け（空のまま出すと本文が空欄になる）。
     * 条件明細の登録・編集では、選ばなければ制限なし（全世界・全言語）で、欄の下の補足がそれを説明するので「未選択」だけにする。
     */
    emptyNote?: string;
  }
) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const region = kind === "region";
  const universal = region ? WORLD_REGION : ALL_LANGUAGE;
  const selected = useMemo(
    () => (region ? parseRegions(value) : parseLanguages(value)), [kind, value]);
  const hasUniversal = selected.some((s) => s.code === universal.code);
  // 国を挙げない選び方（全世界・全言語、地域なら「日本を除く全世界」も）。どれも個別の指定とは同居しない。
  const broad: ScopeOption[] = region ? [universal, WORLD_EX_JP_REGION] : [universal];
  const isBroad = (o: ScopeOption) => broad.some((b) => b.code === o.code);
  const picked = selected.find(isBroad) ?? null;

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
    if (isBroad(option)) {
      put(picked?.code === option.code ? [] : [option]);
      return;
    }
    // 全世界・全言語（日本を除く全世界）と個別の指定は同居しない。個別を選んだら全体は外れる。
    const base = selected.filter((s) => !isBroad(s));
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
        {region && (
          <button type="button" className={`btn btn-sm${picked?.code === WORLD_EX_JP_REGION.code ? " primary" : ""}`}
                  disabled={disabled} title="海外だけの許諾。日本以外の国をすべて含みます"
                  onClick={() => toggle(WORLD_EX_JP_REGION)}>
            {WORLD_EX_JP_REGION.name}
          </button>
        )}
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
              {s.name}{s.code && !isBroad(s) ? ` ${s.code}` : ""} ×
            </button>
          ))}
        </div>
      ) : (
        <span className="faint">{emptyNote ?? "未選択（空のまま出すと、本文のその欄は空欄になります）"}</span>
      )}

      {open && !picked && (
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
      {open && picked && (
        <span className="faint">
          {picked.name}を選んでいるあいだは、個別の指定は要りません
        </span>
      )}
    </div>
  );
}
