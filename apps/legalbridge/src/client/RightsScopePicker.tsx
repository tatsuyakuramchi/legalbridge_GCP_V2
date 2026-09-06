import { useMemo, useState } from "react";
import {
  ALL_LANGUAGE,
  COUNTRY_CODES,
  LANGUAGE_CODES,
  REGION_PRESETS,
  WORLD_REGION,
  languageName,
  regionName,
  type ScopeOption
} from "../rights-scope";

export function RightsScopePicker({
  regions,
  languages,
  onRegionsChange,
  onLanguagesChange
}: {
  regions: ScopeOption[];
  languages: ScopeOption[];
  onRegionsChange: (values: ScopeOption[]) => void;
  onLanguagesChange: (values: ScopeOption[]) => void;
}) {
  const [regionQuery, setRegionQuery] = useState("");
  const [languageQuery, setLanguageQuery] = useState("");

  const regionOptions = useMemo(() => {
    const q = regionQuery.trim().toLowerCase();
    return COUNTRY_CODES
      .map((code) => ({ code, name: regionName(code) }))
      .filter((item) => !q || item.code.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
      .slice(0, 80);
  }, [regionQuery]);

  const languageOptions = useMemo(() => {
    const q = languageQuery.trim().toLowerCase();
    return LANGUAGE_CODES
      .map((code) => ({ code, name: languageName(code) }))
      .filter((item) => !q || item.code.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
      .slice(0, 80);
  }, [languageQuery]);

  function toggleRegion(option: ScopeOption) {
    if (option.code === "WORLD") {
      onRegionsChange(regions.some((item) => item.code === "WORLD") ? [] : [WORLD_REGION]);
      return;
    }
    const base = regions.filter((item) => item.code !== "WORLD");
    onRegionsChange(toggle(base, option));
  }

  function applyPreset(codes: string[]) {
    onRegionsChange(codes.map((code) => ({ code, name: regionName(code) })));
  }

  function toggleLanguage(option: ScopeOption) {
    if (option.code === "ALL") {
      onLanguagesChange(languages.some((item) => item.code === "ALL") ? [] : [ALL_LANGUAGE]);
      return;
    }
    const base = languages.filter((item) => item.code !== "ALL");
    onLanguagesChange(toggle(base, option));
  }

  return <div className="rights-scope-picker">
    <section>
      <div className="scope-picker-head">
        <div><strong>対象地域</strong><small>国コードを複数選択できます</small></div>
        <button type="button"
          className={regions.some((item) => item.code === "WORLD") ? "active" : ""}
          onClick={() => toggleRegion(WORLD_REGION)}>WORLD / 全世界</button>
      </div>
      <div className="scope-presets">
        {Object.entries(REGION_PRESETS).map(([label, codes]) =>
          <button type="button" key={label} onClick={() => applyPreset(codes)}>{label}</button>)}
      </div>
      <Selected values={regions} onRemove={(code) => onRegionsChange(regions.filter((item) => item.code !== code))} />
      {!regions.some((item) => item.code === "WORLD") && <>
        <input className="scope-search" value={regionQuery}
          onChange={(event) => setRegionQuery(event.target.value)}
          placeholder="国名・ISOコードで検索" />
        <div className="scope-option-grid">
          {regionOptions.map((option) => <label key={option.code}>
            <input type="checkbox"
              checked={regions.some((item) => item.code === option.code)}
              onChange={() => toggleRegion(option)} />
            <span>{option.name}</span><small>{option.code}</small>
          </label>)}
        </div>
      </>}
    </section>

    <section>
      <div className="scope-picker-head">
        <div><strong>対象言語</strong><small>言語コードを複数選択できます</small></div>
        <button type="button"
          className={languages.some((item) => item.code === "ALL") ? "active" : ""}
          onClick={() => toggleLanguage(ALL_LANGUAGE)}>ALL / 全言語</button>
      </div>
      <Selected values={languages} onRemove={(code) => onLanguagesChange(languages.filter((item) => item.code !== code))} />
      {!languages.some((item) => item.code === "ALL") && <>
        <input className="scope-search" value={languageQuery}
          onChange={(event) => setLanguageQuery(event.target.value)}
          placeholder="言語名・コードで検索" />
        <div className="scope-option-grid">
          {languageOptions.map((option) => <label key={option.code}>
            <input type="checkbox"
              checked={languages.some((item) => item.code === option.code)}
              onChange={() => toggleLanguage(option)} />
            <span>{option.name}</span><small>{option.code}</small>
          </label>)}
        </div>
      </>}
    </section>
  </div>;
}

function Selected({ values, onRemove }: { values: ScopeOption[]; onRemove: (code: string) => void }) {
  if (!values.length) return <p className="scope-empty">未選択</p>;
  return <div className="scope-chips">
    {values.map((value) => <button type="button" key={value.code}
      onClick={() => onRemove(value.code)} title="クリックして解除">
      <span>{value.name}</span><small>{value.code}</small><i>×</i>
    </button>)}
  </div>;
}

function toggle(values: ScopeOption[], option: ScopeOption) {
  return values.some((item) => item.code === option.code)
    ? values.filter((item) => item.code !== option.code)
    : [...values, option];
}
