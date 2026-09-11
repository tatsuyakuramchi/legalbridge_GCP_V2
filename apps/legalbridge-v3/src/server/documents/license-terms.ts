/**
 * 個別利用許諾条件書（individual_license_terms_v3）。
 *
 * この書類だけ、項目の一覧が V1・V2 では **コードの中** にあった
 * （V2 template-repository の `databaseFields.length === 0 ? individualLicenseV3Fields`）。
 * V3 は移行でひな形の `variables` 列だけを引き継いだので、この書類の項目が
 * 1つも無く、ひな形を選んでも入力欄が出ないまま「決定する」だけが残っていた。
 * 本文（マトリクス表）を組む文脈も一緒に移していなかったので、仮に埋めても
 * 取引形態と構成要素の表は空で出る。
 *
 * ここは V2 の individual-license-v3.ts の移植。名前は本文との契約なので
 * そのままにしてある。V3 で足したのは「条件明細から表の種を作る」ところで、
 * V1・V2 は同じ表を人が手で打っていた（打った内容をあとから条件台帳へ
 * 逆流させていた）。V3 は条件明細が先にあるので、逆をやる。
 */

import type { TemplateVariable } from "./binding.js";

export const LICENSE_TERMS_KEY = "individual_license_terms_v3";
export const isLicenseTermsTemplate = (templateKey: string): boolean =>
  templateKey === LICENSE_TERMS_KEY;

type Data = Record<string, any>;

/**
 * 取引形態の固定3種。
 *
 * id は 1/2/3 固定。構成要素の料率マップ（v3_lcs[].rates）のキーになるので
 * 変えられない。自由記載をやめて固定軸にしてあるのは、加算型の料率合計と
 * 利用許諾計算が「どの形態の話か」で決まるため（V1 V3LicenseMatrix 準拠）。
 */
export const FIXED_DEALS: Data[] = [
  { id: 1, name: "自社製造・自社販売", calc_type: "BASE_QTY_RATE", addon: true,
    manufacturer: "Licensee", seller: "Licensee", maxReg: "全世界", maxLang: "全言語",
    basePrice: "上代（MSRP）× 数量", qty: "数量", ag: "0", mg: "0", cur: "JPY" },
  { id: 2, name: "権利許諾（サブライセンス）", calc_type: "BASE_RATE", addon: false,
    manufacturer: "Licensee", seller: "Sublicensee", maxReg: "全世界", maxLang: "全言語",
    basePrice: "許諾収入", qty: "1", ag: "0", mg: "0", cur: "JPY" },
  { id: 3, name: "自社製造・他社販売", calc_type: "SUPPLY_QTY", addon: true,
    manufacturer: "Licensee", seller: "販売店", maxReg: "全世界", maxLang: "全言語",
    basePrice: "供給価格 × 数量", qty: "数量", ag: "0", mg: "0", cur: "JPY" }
];

export const CALC_MODEL_LABEL: Record<string, string> = {
  BASE_QTY_RATE: "基準価格×個数×料率", BASE_RATE: "実効料率", FIXED: "固定額",
  SUBSCRIPTION: "サブスク", SUPPLY_QTY: "供給価格×個数×料率"
};

/** 加算型の形態。構成要素の料率を合算する側で、料率の列がここの数だけ出る。 */
export const addonDeals = (deals: Data[]): Data[] => deals.filter((d) => Boolean(d.addon));

/**
 * ひな形の項目。V2 の individualLicenseV3Fields をそのまま移す。
 * dbField は V1 の宣言のままで、V3 の対応表（legacy-variables）が読める。
 */
export const LICENSE_TERMS_VARIABLES: TemplateVariable[] = [
  { name: "契約書番号", label: "契約書番号", group: "I. 基本情報",
    dbField: "auto.docNumber", noGuess: true },
  { name: "発行日", label: "発行日", type: "date", group: "I. 基本情報", required: true,
    dbField: "auto.today", noGuess: true },
  { name: "許諾開始日", label: "許諾開始日", type: "date", group: "I. 基本情報", required: true,
    from: "condition.termStart" },
  { name: "基本契約名", label: "基本契約名", group: "I. 基本情報", from: "agreement.title" },
  { name: "work_id", label: "作品ID", group: "I. 基本情報",
    helpText: "作品台帳との参照キー", dbField: "work.code", noGuess: true },
  { name: "署名欄", label: "署名欄（末尾の記名押印欄）", type: "select", options: ["表示する", "表示しない"],
    group: "I. 基本情報", noGuess: true,
    helpText: "基本契約と一括で電子署名する場合は「表示しない」にすると、基本契約側の署名欄だけになります。" },

  { name: "Licensor_氏名会社名", label: "Licensor 名称", group: "II. Licensor", required: true,
    dbField: "vendor.vendor_name", noGuess: true },
  { name: "許諾者種別", label: "Licensor 種別", type: "select", options: ["法人", "個人"],
    group: "II. Licensor", required: true, dbField: "vendor.entity_type", noGuess: true },
  { name: "Licensor_住所", label: "Licensor 住所", type: "textarea", group: "II. Licensor",
    dbField: "vendor.address", noGuess: true },
  { name: "Licensor_代表者名", label: "Licensor 代表者名", group: "II. Licensor",
    dbField: "vendor.vendor_rep", noGuess: true },
  { name: "Licensor_担当者", label: "Licensor 担当者", group: "II. Licensor",
    dbField: "vendor.contact_name", noGuess: true },
  { name: "Licensor_電話", label: "Licensor 電話", group: "II. Licensor",
    dbField: "vendor.phone", noGuess: true },
  { name: "Licensor_メール", label: "Licensor メール", group: "II. Licensor",
    dbField: "vendor.email", noGuess: true },

  { name: "Licensee_氏名会社名", label: "Licensee 名称", group: "III. Licensee", required: true,
    dbField: "company.name", noGuess: true },
  { name: "Licensee_住所", label: "Licensee 住所", type: "textarea", group: "III. Licensee",
    dbField: "company.address", noGuess: true },
  { name: "Licensee_代表者名", label: "Licensee 代表者名", group: "III. Licensee",
    dbField: "company.rep", noGuess: true },
  // 空なら本文を組むときに当社の担当者から「氏名 ／ 電話 ／ メール」を作る。
  { name: "Licensee_連絡先", label: "Licensee 連絡先", group: "III. Licensee", noGuess: true,
    helpText: "空なら案件の担当者（氏名・電話・メール）が入ります" },

  { name: "対象製品予定名", label: "対象製品予定名", group: "IV. 許諾概要", required: true, noGuess: true,
    helpText: "許諾を受けて出す製品の名前。作品名とは別のことが多いので、ここは人が入れる" },
  { name: "独占性", label: "独占性", type: "select", options: ["独占", "非独占"],
    group: "IV. 許諾概要", required: true, from: "condition.exclusivityLabel" },
  // 自由記載だと「日本」「日本国内」「JP」が別物として入り、作品の権利包絡が
  // 割れる。ISO のコードから複数選ぶ欄にする（画面が type を見て出し分ける）。
  { name: "v3_maxRegion", label: "許諾地域（上限）", type: "regions",
    group: "IV. 許諾概要", noGuess: true },
  { name: "v3_maxLanguage", label: "許諾言語（上限）", type: "languages",
    group: "IV. 許諾概要", noGuess: true },
  { name: "v3_scope", label: "許諾範囲", type: "textarea", group: "IV. 許諾概要", noGuess: true },
  { name: "監修者", label: "監修者", group: "IV. 許諾概要", noGuess: true,
    helpText: "許諾者側の監修担当。当社の担当者ではない" },
  { name: "v3_productDefinition", label: "対象製品の定義", type: "textarea", group: "IV. 許諾概要",
    noGuess: true, helpText: "空なら定型文（ボードゲーム製品）が入ります" },

  // 表そのもの。画面は専用の編集欄を出すので、手入力の項目一覧には並べない。
  { name: "v3_conds", label: "取引形態", type: "array", group: "V. 取引形態" },
  { name: "v3_lcs", label: "構成要素", type: "array", group: "VI. 構成要素" },
  { name: "v3_sublicensees", label: "サブライセンシー", type: "array", group: "VII. サブライセンス" },
  { name: "v3_calc_base_rows", label: "算定基準", type: "array", group: "VIII. 算定基準" },
  { name: "v3_special_extras", label: "特記事項", type: "array", group: "IX. 特記" }
];

// ---------------------------------------------------------------------------
// 表の種（V3 のデータから作る）
// ---------------------------------------------------------------------------

const list = (value: unknown): Data[] =>
  Array.isArray(value) ? value.filter((x): x is Data => Boolean(x) && typeof x === "object") : [];
const text = (value: unknown) => (value == null ? "" : String(value));
const number = (value: unknown): number | null => {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number | null) => (value == null ? "—" : `${+value.toFixed(2)}%`);
const joined = (labels: unknown) => (Array.isArray(labels) ? labels.join("・") : "");

/**
 * 取引形態の割り当て。どの条件明細がどの形態か。
 *
 * 計算方式（pricing_model）では決められない。本番の移行データは3種とも
 * revenue_rate で入っていて、そのまま見ると全部「権利許諾」になる。
 * 移行のとき V3 に置き場所が無かったので、形態は備考へ逃がしてある：
 *
 *   取引形態: 自社製造・自社販売 / 計算モデル: 基準価格 × 個数 × 料率
 *
 * 備考にも無いもの（V3 で起こした条件・古い移行分）は並び順で当てる。
 * 同じ素材に 形態1→2→3 の順で並ぶのが移行後の形なので、素材ごとに数える。
 * 推定した割り当ては画面に出して、人が直せるようにする。
 */
const DEAL_ID_BY_NAME = new Map(FIXED_DEALS.map((deal) => [String(deal.name), Number(deal.id)]));

export function dealModelFromNotes(notes: unknown): number | null {
  const found = /取引形態[:：]\s*([^/\n]+)/.exec(String(notes ?? ""));
  if (!found) return null;
  return DEAL_ID_BY_NAME.get(found[1].trim()) ?? null;
}

/**
 * 条件をまとめる鍵＝「どの契約の、どの素材か」。
 *
 * 素材だけでまとめると、同じ素材を2本の契約で取得している場合（本番の
 * ito_イラストは ARC-ILT-2026-0030 と 0033 の2本にある）に6本が1行へ潰れて、
 * 取引形態の当てはめも料率も混ざる。紙に根拠文書の列があるのはこのため。
 */
export const partKeyOf = (condition: Data): string =>
  `${condition.agreementId ?? ""}／`
  + String(condition.workPartId ?? condition.work?.part ?? condition.workId ?? "＿");

/** 条件明細 → 取引形態。備考が先、無ければ素材の中での並び順。 */
export function assignDeals(conditions: Data[]): Map<number, number> {
  const groups = new Map<string, Data[]>();
  for (const condition of conditions) {
    const key = partKeyOf(condition);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(condition);
  }
  const out = new Map<number, number>();
  for (const group of groups.values()) {
    // 備考で決まっている形態は先に押さえ、残りを空いている形態へ順に当てる。
    const taken = new Set<number>();
    const rest: Data[] = [];
    for (const condition of group) {
      const noted = dealModelFromNotes(condition.notes);
      if (noted && !taken.has(noted)) { out.set(Number(condition.id), noted); taken.add(noted); }
      else rest.push(condition);
    }
    const free = FIXED_DEALS.map((d) => Number(d.id)).filter((id) => !taken.has(id));
    // 並び順で当てるのは、その素材が3種そろっているときだけ。1本・2本しか
    // 無い素材は、どの形態なのかを順番からは決められない（本番では 1本=5組・
    // 2本=14組ある）。当てずに空けておき、画面で人に選ばせる。間違った形態を
    // 黙って紙に出すより良い。
    if (taken.size + rest.length !== FIXED_DEALS.length) continue;
    rest.forEach((condition, index) => {
      const id = free[index];
      if (id) out.set(Number(condition.id), id);
    });
  }
  return out;
}

/** その条件が備考で形態を名乗っているか（推定と区別して画面に出す）。 */
export const dealIdFor = (condition: Data): number | null =>
  dealModelFromNotes(condition.notes);

/**
 * 取引形態の種。この条件書に載せる条件明細から作る。
 *
 * 固定3種のうち、条件明細が当たった形態だけを載せる。1種しか無い案件も
 * 2種の案件もあるので（本番では 1本=5組・2本=14組・3本=18組）、3種とも
 * 出すのは「何も当たらなかったとき」だけにする。
 */
export function dealSeeds(context: Data): Data[] {
  const picked = list(context.conditions);
  const assigned = assignDeals(picked);
  return FIXED_DEALS.map((deal) => {
    const matches = picked.filter((c) => assigned.get(Number(c.id)) === Number(deal.id));
    const match = matches[0];
    if (!match) {
      // 当たる条件が無い形態。行そのものは残すが、載せるかどうかは別。
      // 何も当たらないときは3種とも出して、人に選んでもらう。
      return { ...deal, use: assigned.size === 0, reg: deal.maxReg, lang: deal.maxLang };
    }
    return {
      ...deal,
      use: true,
      conditionId: match.id,
      conditionNo: matches.map((c) => c.conditionNo).filter(Boolean).join("・") || null,
      /**
       * 形態の出どころ。notes=備考に書いてあった / order=並び順から推定。
       * 1本でも推定が混ざっていれば推定として出す（素材ごとに当て方が違う）。
       */
      assignedFrom: matches.every((c) => dealModelFromNotes(c.notes)) ? "notes" : "order",
      // 非加算型（サブライセンス）は条件の料率がそのまま実効料率になる。
      // 加算型は構成要素ごとの料率を合算するので、ここには置かない。
      fixedRate: deal.addon ? "" : text(match.ratePct ?? ""),
      /**
       * 非加算型に当たった条件が複数あって、料率が割れている。
       * 実効料率は1つしか書けないので、どれを書くかは人が決める。
       * 黙って先頭を採ると、書かれなかったほうの料率が紙から消える。
       */
      rateConflict: !deal.addon
        && new Set(matches.map((c) => text(c.ratePct ?? ""))).size > 1,
      reg: joined(match.scopes?.region) || String(deal.maxReg),
      lang: joined(match.scopes?.language) || String(deal.maxLang),
      ag: text(match.agAmount ?? 0), mg: text(match.mgAmount ?? 0),
      cur: match.currency ?? deal.cur
    };
  });
}

/**
 * この条件書に載せる形態か。
 *
 * 固定3種は「料率合算の軸」を揃えるための決め打ちで、3種すべてを毎回
 * 許諾するという意味ではない。再許諾しかしない案件に自社製造の行が出ると、
 * 許諾していない取引の条件を書いた紙になる。
 * use が無い行（手で足した行・古い下書き）は載せる扱いにする。
 */
export const dealInUse = (deal: Data): boolean => deal.use !== false;

/**
 * 構成上の役割。許諾の対象そのものが コアロジック、追加の許諾料が発生する
 * ものが サブコンポーネント。
 *
 * V1 の work_materials.material_role（core_logic / sub_component）にあたるが、
 * V3 は移行していない。ただ素材の種別（work_parts.part_type）が残っていて、
 * 本番のデータはそこで割れている：
 *
 *   ito_原作ゲームデザイン   game_design   … 許諾の対象（コアロジック）
 *   ito_イラスト             illustration  … 追加の要素（サブコンポーネント）
 *
 * 種別が入っていない素材（part_type='other'）は名前で見る。どちらとも言えなければ
 * サブとして置く。コアは1件のはずなので、増やすより人に足してもらうほうが安全。
 */
export function roleOfPart(part: { partType?: string | null; part?: string | null }): "core" | "sub" {
  const type = String(part.partType ?? "").toLowerCase();
  if (type === "game_design") return "core";
  if (type && type !== "other" && type !== "unspecified") return "sub";
  // Original_Core_Logic は台帳の命名規則（旧「原作ゲームデザイン」）。
  return /Original_Core_Logic|ゲームデザイン|原作|コアロジック|core/i
    .test(String(part.part ?? "")) ? "core" : "sub";
}

/**
 * 構成要素（素材）の種。この条件書に載せる条件明細が指している素材を並べる。
 *
 * 原作には構成要素があり、許諾の対象そのものが コアロジック、追加の許諾料が
 * 発生するものが サブコンポーネント。加算型の適用料率は、この表に並ぶ料率の
 * 合算（コアの基本料率＋サブの追加料率）になる。
 *
 * 移行後のデータは「同じ素材に、取引形態のぶんだけ条件明細が並ぶ」形なので、
 * 素材でまとめれば行が立ち、形態で割れば料率の列になる。表はもう条件明細の
 * 中にある。
 *
 * 非加算型（サブライセンス）の料率はここに入れない。入れると加算型の合計に
 * 混ざって、5% + 50% = 55% のような紙が出る。
 */
export function materialSeeds(context: Data): Data[] {
  const picked = list(context.conditions);
  const assigned = assignDeals(picked);
  const addonIds = new Set(addonDeals(FIXED_DEALS).map((d) => Number(d.id)));
  // 権利元・根拠文書は作品の取得条件のほうが詳しい（契約番号を持っている）。
  const acquisitions = list(context.acquisitions);

  const groups = new Map<string, Data[]>();
  for (const condition of picked) {
    const key = partKeyOf(condition);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(condition);
  }

  return [...groups.values()].map((group) => {
    const head = group[0];
    const source = acquisitions.find((a) => Number(a.id) === Number(head.id))
      ?? acquisitions.find((a) => a.partName && a.partName === head.work?.part);
    const rates: Data = {};
    for (const condition of group) {
      const dealId = assigned.get(Number(condition.id));
      if (dealId && addonIds.has(dealId)) rates[String(dealId)] = text(condition.ratePct ?? "");
    }
    return {
      material_code: text(source?.conditionNo ?? head.conditionNo ?? ""),
      name: text(head.work?.part || head.name || head.work?.title || ""),
      holder: text(head.counterparty?.name ?? ""),
      source_doc: text(source?.agreementNo ?? ""),
      region: joined(head.scopes?.region) || joined(source?.regions) || "全世界",
      language: joined(head.scopes?.language) || joined(source?.languages) || "全言語",
      // 構成上の役割。素材の種別から決める。人が直せる。
      role: roleOfPart(head.work ?? {}),
      rates
    };
  });
}

/**
 * 画面の編集欄に渡す種。手入力があればそちらが勝つ（人が直したものを消さない）。
 *
 * サブライセンシーと特記事項は V3 のデータから導けないので空で始める。
 * 種が空でも欄は要る（本文がその表を差しているので、無いと出す手段が無い）。
 */
export function licenseTermsSeeds(context: Data): Record<string, Data[]> {
  return {
    v3_conds: dealSeeds(context),
    v3_lcs: materialSeeds(context),
    v3_sublicensees: [],
    v3_special_extras: []
  };
}

// ---------------------------------------------------------------------------
// 本文の文脈（V2 buildIndividualLicenseV3Context の移植）
// ---------------------------------------------------------------------------

/**
 * 許諾範囲の文案。
 *
 * この文は、中身のほとんどが既にどこかにある。独占性は条件明細、地域と言語は
 * 許諾範囲、対象製品はこの書類の上の欄。人が打ち直すと、条件を直したときに
 * 文だけ古いまま残る（地域を足したのに範囲の文は前のまま、が起きる）。
 *
 * 組み立てた文を既定で入れておき、いつもと違うことを書くときだけ人が直す。
 * 直した文はそのまま残り、以後この組み立ては効かない（手入力が勝つ）。
 *
 * 材料が足りないとき（地域も言語も未指定）は文を作らない。空欄のほうが、
 * 中身の無い文が紙に載るより良い。
 */
export function licenseScopeSentence(context: Data, bound: Data = {}): string {
  const value = (...keys: string[]): string => {
    for (const key of keys) {
      const found = bound[key] ?? context[key];
      if (found != null && String(found).trim() !== "") return String(found).trim();
    }
    return "";
  };
  const region = value("v3_maxRegion", "許諾地域", "maxRegion");
  const language = value("v3_maxLanguage", "許諾言語", "maxLanguage");
  if (!region && !language) return "";

  const product = value("対象製品予定名", "productName");
  const exclusivity = value("独占性", "exclusivity");
  const sublicensable = context.condition?.sublicensable;

  const parts: string[] = [];
  parts.push(`本許諾の範囲は、${region || "全世界"}における${language || "全言語"}`
    + `${product ? `の${product}` : ""}とする。`);
  if (exclusivity) parts.push(`本許諾は${exclusivity}とする。`);
  // 再許諾は「書いていない＝できない」と読まれる。条件明細で決まっているので、
  // どちらであっても書く。
  if (sublicensable === true) parts.push("被許諾者は、許諾者の事前の書面による承諾を得て、第三者に再許諾することができる。");
  if (sublicensable === false) parts.push("被許諾者は、第三者に再許諾することができない。");
  return parts.join("");
}

/**
 * この書類に載せる条件明細が持っている許諾範囲。
 *
 * 上限の地域・言語は条件明細（condition_scopes）に既にある。人が思い出して
 * 打つものではない。条件を複数載せるときは、どれかに挙がっている範囲を
 * すべて並べる（載せた条件の合計がこの書類の範囲になる）。
 */
function scopeOfConditions(context: Data, type: "region" | "language"): string {
  const conditions = Array.isArray(context.conditions) ? context.conditions as Data[]
    : context.condition ? [context.condition as Data] : [];
  const labels: string[] = [];
  for (const condition of conditions) {
    for (const label of (condition?.scopes?.[type] ?? []) as string[]) {
      const value = String(label ?? "").trim();
      if (value && !labels.includes(value)) labels.push(value);
    }
  }
  return labels.join("、");
}

/**
 * ひな形ごとの文案。人が直せる（計算と違い、手入力が勝つ）。
 *
 * 地域・言語は条件明細から、許諾範囲の文はその地域・言語から組む。文は
 * 1回目の束縛で埋まった値（bound）を見るので、人が欄で地域を変えていれば
 * そちらで組み直る。
 */
export function licenseTermsSuggestions(context: Data, bound: Data = {}): Data {
  const out: Data = {};
  const region = scopeOfConditions(context, "region");
  const language = scopeOfConditions(context, "language");
  if (region) out.v3_maxRegion = region;
  if (language) out.v3_maxLanguage = language;
  const scope = licenseScopeSentence(context, { ...out, ...bound });
  if (scope) out.v3_scope = scope;
  return out;
}

export function licenseTermsPatch(context: Data, manual: Data = {}): Data {
  const seeds = licenseTermsSeeds(context);
  const all = list(manual.v3_conds).length ? list(manual.v3_conds) : seeds.v3_conds;
  // 載せない形態は表からも料率の列からも消す。値は消さないので、載せ直せば戻る。
  const deals = all.filter(dealInUse);
  // コアロジック（許諾の対象）を先に、サブコンポーネント（追加許諾料）を後に。
  // 紙の読み順がそうなっている。並べ替えだけで、行は落とさない。
  const materials = (list(manual.v3_lcs).length ? list(manual.v3_lcs) : seeds.v3_lcs)
    .slice()
    .sort((a, b) => (a.role === "sub" ? 1 : 0) - (b.role === "sub" ? 1 : 0));

  /** 加算型は構成要素の料率の合計、非加算型は実効料率。 */
  const appliedRate = (deal: Data): string => {
    if (!deal.addon) return percent(number(deal.fixedRate));
    const key = String(deal.id ?? "");
    let total = 0;
    let found = false;
    for (const material of materials) {
      const rates = material.rates && typeof material.rates === "object" ? material.rates as Data : {};
      const rate = number(rates[key]);
      if (rate !== null) { total += rate; found = true; }
    }
    return found ? percent(total) : "—";
  };

  const conds = deals.map((deal, index) => ({
    condLabel: `条件${index + 1}`,
    condName: text(deal.name),
    basePrice: text(deal.basePrice),
    condType: deal.addon ? "【加算型】" : "【非加算型】",
    calcModel: CALC_MODEL_LABEL[text(deal.calc_type)] ?? "",
    condRegion: text(deal.reg),
    condLang: text(deal.lang),
    appliedRate: appliedRate(deal),
    quantity: text(deal.qty) || "1",
    ag: text(deal.ag) || "0",
    mg: text(deal.mg) || "0",
    currency: text(deal.cur) || "JPY"
  }));

  const addons = deals.map((deal, index) => ({ deal, index })).filter(({ deal }) => Boolean(deal.addon));
  const holders = new Set(materials.map((m) => text(m.holder).trim()).filter(Boolean));
  const showHolder = holders.size > 1;

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = manual[key] ?? context[key];
      if (value != null && String(value).trim() !== "") return String(value);
    }
    return "";
  };
  const contact = (...keys: string[]) =>
    keys.map((k) => manual[k]).filter((v) => v != null && String(v).trim() !== "").join(" ／ ");

  const calcBaseRows = list(manual.v3_calc_base_rows)
    .map((row) => ({ edition: text(row.edition), trigger: text(row.trigger), note: text(row.note) }))
    .filter((row) => row.edition || row.trigger || row.note);

  return {
    issueDate: pick("発行日", "issueDate"),
    contractNo: pick("契約書番号", "contractNo"),
    workId: pick("work_id", "台帳ID", "workId"),
    masterAgreement: pick("基本契約名", "masterAgreement"),
    licensorName: pick("Licensor_氏名会社名", "Licensor_名称", "licensorName"),
    licenseeName: pick("Licensee_氏名会社名", "Licensee_名称", "licenseeName"),
    startDate: pick("許諾開始日", "startDate"),
    licensorContact: contact("Licensor_担当者", "Licensor_電話", "Licensor_メール"),
    // 自社側の通知先。欄が空なら当社の担当者から組む（V1 と同じ連結形）。
    licenseeContact: pick("Licensee_連絡先", "licenseeContact")
      || [context.owner?.name, context.owner?.phone, context.owner?.email]
        .filter((v) => v != null && String(v).trim() !== "").join(" ／ "),
    productDefinition: pick("v3_productDefinition", "対象製品の定義", "productDefinition")
      || "被許諾者（Licensee）が本契約に基づき対象作品を利用して企画・開発・製造・販売するボードゲーム製品（以下「対象製品」という。）",
    productName: pick("対象製品予定名", "productName"),
    exclusivity: pick("独占性", "exclusivity"),
    maxRegion: pick("v3_maxRegion", "許諾地域", "maxRegion"),
    maxLanguage: pick("v3_maxLanguage", "許諾言語", "maxLanguage"),
    scope: pick("v3_scope", "許諾範囲", "scope"),
    conds,
    addonConds: addons.map(({ deal, index }) => ({
      condLabel: conds[index].condLabel, condName: conds[index].condName, appliedRate: appliedRate(deal)
    })),
    showHolder,
    scopeColCount: 5 + (showHolder ? 1 : 0),
    rateColCount: 2 + addons.length,
    licensorIsCorp: pick("許諾者種別") !== "個人",
    lcs: materials.map((material) => {
      const rates = material.rates && typeof material.rates === "object" ? material.rates as Data : {};
      const source = text(material.source_doc).trim();
      return {
        lcId: text(material.material_code),
        lcName: text(material.name),
        lcHolder: text(material.holder),
        lcSourceDoc: !source || /^(この|本)条件書/.test(source) ? "本条件書（新規）" : source,
        lcRegion: text(material.region),
        lcLanguage: text(material.language),
        /** 構成上の役割。本文が出し分けるならこれを見る。 */
        lcRole: material.role === "sub" ? "サブコンポーネント" : "コアロジック",
        lcIsCore: material.role !== "sub",
        addonRates: addons.map(({ deal }) => percent(number(rates[String(deal.id ?? "")])))
      };
    }),
    calcBaseRows: calcBaseRows.length ? calcBaseRows
      : [{ edition: "初版", trigger: "発売日", note: "" }, { edition: "2版以降", trigger: "製造日", note: "" }],
    sublicensees: list(manual.v3_sublicensees),
    supervisor: pick("監修者", "supervisor"),
    specialExtras: list(manual.v3_special_extras),
    licensorAddress: pick("Licensor_住所", "licensorAddress"),
    licensorRep: pick("Licensor_代表者名", "licensorRep"),
    licenseeAddress: pick("Licensee_住所", "licenseeAddress"),
    licenseeRep: pick("Licensee_代表者名", "licenseeRep")
  };
}
