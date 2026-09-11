/**
 * 許諾の範囲（地域・言語）。V2 の rights-scope.ts の移植。
 *
 * 画面（選ばせる）とサーバ（作品の権利包絡と照らす）の両方が同じ表を見る。
 * 片方だけが名前の揺れを知っていると、画面で通って保存で弾かれる、あるいは
 * その逆が起きるので、コードと表示名の対応はここ1か所に置く。
 *
 * 自由記載にすると「日本」「日本国内」「JP」が別物として台帳に入り、作品の
 * 権利包絡（全パートの取得条件の積）が割れる。ISO の国コード・言語コードから
 * 複数選ぶ形にして、表示名はコードから引く。
 *
 * 保存する文字列は表示名を「、」で繋いだもの（書類の本文にそのまま出る）。
 * 読み直すときは名前からコードへ引き当てる（当たらないものは自由記載として扱う）。
 */

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
  "wa","wo","xh","yi","yo","za","zh","zu",
  // ここから V3 で足したぶん。ISO 639-1 は中国語を1つしか持たないが、台帳の
  // 許諾範囲は繁体字と簡体字を書き分けている（台湾・香港と中国本土で許諾先も
  // 条件も別）。区別できないと、この業務で最も多い指定が自由記載に落ちる。
  "zh-Hant","zh-Hans"
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
  const normalize = (code: string) => universalCode === "WORLD"
    ? code.toUpperCase()
    : (code.toUpperCase() === "ALL" ? "ALL" : code.toLowerCase());
  const sourceCodes = new Set(source.map((value) => normalize(value.code)));
  if (sourceCodes.has(universalCode)) return true;
  if (target.some((value) => normalize(value.code) === universalCode)) return false;
  return target.every((value) => sourceCodes.has(normalize(value.code)));
}

// ---------------------------------------------------------------------------
// 文字列との行き来（V3 で足したぶん）
//
// 書類の本文は「日本、台湾」のような文字列を差す。画面は選択として持つので、
// 保存の直前に文字列へ、開いたときに選択へ戻す。名前で引き当てられなかった
// ものは、自由記載としてそのまま残す（移行したデータを黙って捨てない）。
// ---------------------------------------------------------------------------

const splitScope = (text: string): string[] =>
  String(text ?? "").split(/[、,／/]/).map((s) => s.trim()).filter(Boolean);

/** 表示名（または ISO コード）から選択へ戻す。 */
export function parseRegions(text: string): ScopeOption[] {
  const byName = new Map(COUNTRY_CODES.map((code) => [regionName(code), code] as const));
  return splitScope(text).map((word) => {
    if (word === WORLD_REGION.name || word.toUpperCase() === "WORLD") return WORLD_REGION;
    const code = byName.get(word)
      ?? (COUNTRY_CODES as readonly string[])
           .find((c) => c.toUpperCase() === word.toUpperCase());
    return code ? { code, name: regionName(code) } : { code: "", name: word };
  });
}

export function parseLanguages(text: string): ScopeOption[] {
  const byName = new Map(LANGUAGE_CODES.map((code) => [languageName(code), code] as const));
  return splitScope(text).map((word) => {
    if (word === ALL_LANGUAGE.name || word.toUpperCase() === "ALL") return ALL_LANGUAGE;
    const code = byName.get(word)
      ?? (LANGUAGE_CODES as readonly string[])
           .find((c) => c.toLowerCase() === word.toLowerCase());
    return code ? { code, name: languageName(code) } : { code: "", name: word };
  });
}

/**
 * 許諾できる範囲に収まっているか。V2 の scopeAllowed と同じ考え方。
 *
 * コードで比べる。名前だけで比べると「アメリカ」と「アメリカ合衆国」が別物に
 * なり、取得済みの国が上限外と出る。ただし移行してきた行にはコードが無いので、
 * コードで当たらなければ名前でも見る。どちらかで一致すれば範囲内とする
 * （コードが揃うまでのあいだ、同じ国を上限外と言わないため）。
 *
 * 上限の側に 全世界／全言語 があれば、その次元は無制限。逆に上限が国ごとの
 * 指定なら、全世界での許諾は出せない。
 */
export function scopeAllows(
  allowed: ScopeOption[],
  requested: ScopeOption[],
  universalCode: "WORLD" | "ALL"
): { ok: boolean; outside: ScopeOption[] } {
  if (!requested.length) return { ok: true, outside: [] };

  const universalName = universalCode === "WORLD" ? WORLD_REGION.name : ALL_LANGUAGE.name;
  const canonical = (option: ScopeOption) => {
    const code = String(option.code ?? "").trim();
    if (!code) return "";
    return universalCode === "WORLD" || code.toUpperCase() === "ALL"
      ? code.toUpperCase() : code.toLowerCase();
  };
  const isUniversal = (option: ScopeOption) =>
    canonical(option) === universalCode || (!canonical(option) && option.name === universalName);

  if (allowed.some(isUniversal)) return { ok: true, outside: [] };

  const codes = new Set(allowed.map(canonical).filter(Boolean));
  const names = new Set(allowed.map((a) => a.name).filter(Boolean));
  const outside = requested.filter((r) => {
    if (isUniversal(r)) return true;          // 上限が国ごとなら全世界では出せない
    const code = canonical(r);
    return !(code && codes.has(code)) && !names.has(r.name);
  });
  return { ok: outside.length === 0, outside };
}
