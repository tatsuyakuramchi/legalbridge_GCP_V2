export type ScopeOption = { code: string; name: string };

export const WORLD_REGION: ScopeOption = { code: "WORLD", name: "全世界" };
export const ALL_LANGUAGE: ScopeOption = { code: "ALL", name: "全言語" };

export const COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR",
  "GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
  "HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM","PN",
  "PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL",
  "SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR",
  "TT","TV","TW","TZ","UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","YT","ZA","ZM","ZW"
] as const;

export const LANGUAGE_CODES = [
  "aa","ab","ae","af","ak","am","an","ar","as","av","ay","az","ba","be","bg","bh","bi","bm","bn","bo","br","bs",
  "ca","ce","ch","co","cr","cs","cu","cv","cy","da","de","dv","dz","ee","el","en","eo","es","et","eu","fa","ff",
  "fi","fj","fo","fr","fy","ga","gd","gl","gn","gu","gv","ha","he","hi","ho","hr","ht","hu","hy","hz","ia","id",
  "ie","ig","ii","ik","io","is","it","iu","ja","jv","ka","kg","ki","kj","kk","kl","km","kn","ko","kr","ks","ku",
  "kv","kw","ky","la","lb","lg","li","ln","lo","lt","lu","lv","mg","mh","mi","mk","ml","mn","mr","ms","mt","my",
  "na","nb","nd","ne","ng","nl","nn","no","nr","nv","ny","oc","oj","om","or","os","pa","pi","pl","ps","pt","qu",
  "rm","rn","ro","ru","rw","sa","sc","sd","se","sg","si","sk","sl","sm","sn","so","sq","sr","ss","st","su","sv",
  "sw","ta","te","tg","th","ti","tk","tl","tn","to","tr","ts","tt","tw","ty","ug","uk","ur","uz","ve","vi","vo",
  "wa","wo","xh","yi","yo","za","zh","zu"
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
