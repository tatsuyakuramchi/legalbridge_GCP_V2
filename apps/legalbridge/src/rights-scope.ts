export type ScopeOption = { code: string; name: string };

export const WORLD_REGION: ScopeOption = { code: "WORLD", name: "全世界" };
export const ALL_LANGUAGE: ScopeOption = { code: "ALL", name: "全言語" };

export const COUNTRY_CODES = [
  "JP","US","CA","MX","GB","IE","FR","DE","ES","IT","PT","NL","BE","LU","CH","AT",
  "DK","SE","NO","FI","IS","PL","CZ","SK","HU","RO","BG","GR","HR","SI","EE","LV",
  "LT","CY","MT","UA","TR","RU","CN","HK","TW","KR","SG","MY","TH","VN","PH","ID",
  "IN","PK","BD","LK","NP","AE","SA","IL","QA","KW","BH","OM","AU","NZ","BR","AR",
  "CL","CO","PE","UY","PY","BO","EC","VE","CR","PA","GT","HN","SV","NI","DO","PR",
  "ZA","EG","MA","TN","NG","KE","GH"
] as const;

export const LANGUAGE_CODES = [
  "ja","en","fr","de","es","it","pt","nl","pl","cs","sk","hu","ro","bg","el","hr",
  "sl","et","lv","lt","da","sv","no","fi","is","ru","uk","tr","zh","ko","th","vi",
  "id","ms","tl","hi","bn","ur","ar","he"
] as const;

export const REGION_PRESETS: Record<string, string[]> = {
  "北米": ["US","CA","MX"],
  "欧州": ["GB","IE","FR","DE","ES","IT","PT","NL","BE","LU","CH","AT","DK","SE","NO","FI","IS","PL","CZ","SK","HU","RO","BG","GR","HR","SI","EE","LV","LT","CY","MT","UA"],
  "アジア": ["JP","CN","HK","TW","KR","SG","MY","TH","VN","PH","ID","IN","PK","BD","LK","NP"],
  "オセアニア": ["AU","NZ"],
  "中南米": ["BR","AR","CL","CO","PE","UY","PY","BO","EC","VE","CR","PA","GT","HN","SV","NI","DO","PR"]
};

export function regionName(code: string) {
  if (code === "WORLD") return WORLD_REGION.name;
  try {
    return new Intl.DisplayNames(["ja"], { type: "region" }).of(code.toUpperCase()) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function languageName(code: string) {
  if (code === "ALL") return ALL_LANGUAGE.name;
  try {
    return new Intl.DisplayNames(["ja"], { type: "language" }).of(code.toLowerCase()) || code.toLowerCase();
  } catch {
    return code.toLowerCase();
  }
}

export function normalizeRegionOption(value: ScopeOption): ScopeOption {
  const code = String(value.code || "").trim().toUpperCase();
  return { code, name: code === "WORLD" ? WORLD_REGION.name : regionName(code) };
}

export function normalizeLanguageOption(value: ScopeOption): ScopeOption {
  const code = String(value.code || "").trim().toLowerCase() === "all"
    ? "ALL"
    : String(value.code || "").trim().toLowerCase();
  return { code, name: code === "ALL" ? ALL_LANGUAGE.name : languageName(code) };
}

export function displayScope(values: ScopeOption[]) {
  return values.map((value) => value.name).filter(Boolean).join("、");
}

export function scopeContains(source: ScopeOption[], target: ScopeOption[], universalCode: "WORLD" | "ALL") {
  if (!target.length) return true;
  const sourceCodes = new Set(source.map((value) => value.code));
  if (sourceCodes.has(universalCode)) return true;
  if (target.some((value) => value.code === universalCode)) return false;
  return target.every((value) => sourceCodes.has(value.code));
}
