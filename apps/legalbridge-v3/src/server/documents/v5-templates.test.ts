import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocumentHtml } from "./render.js";
import { blankPlaceholders } from "./preflight.js";
import { LICENSE_MASTER_V5_VARIABLES, licenseMasterV5Patch } from "./license-master-v5.js";
import { LICENSE_TERMS_VARIABLES, licenseTermsPatch } from "./license-terms.js";
import { PUB_TERMS_VARIABLES, pubTermsPatch, pubTitleSeeds, pubTermsWarnings } from "./pub-terms.js";
import { bankInfoLine, termsVersionWarnings } from "./template-context.js";
import { context as gameContext, manual as gameManual } from "./license-terms.fixture.js";
import { orderMainDocs, MAIN_DOCS, MASTER_DOC } from "../workbench/catalog.js";

/**
 * V5（著作物利用許諾基本契約書V5 と、その個別利用許諾条件書V5 の 3 本）。本文は infra/v3/templates、
 * 本番へは infra/v3/212 が運ぶ（make-template-sql.mjs が本文から組む）。
 * 見張るのは：SQL が本文と同じこと、差し込みの名前がいまの計算ブロックからすべて出ること、
 * 事業別条項の位置と条の参照、条件書と基本契約の版の組み合わせの警告。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const infra = (p: string) => readFileSync(path.resolve(here, "../../../../../infra/v3/", p), "utf8");
const MASTER = infra("templates/license_master_v5.html");
const GAME = infra("templates/individual_license_terms_v5.html");
const PUB = infra("templates/pub_license_terms_v5.html");
const PUB_ANNEX = infra("templates/pub_license_terms_v5_annex.html");

test("V5：212 の SQL は templates の本文 4 本をそのまま運ぶ", () => {
  const sql = infra("212_v5_license_templates.sql");
  for (const [key, body] of [["license_master_v5", MASTER], ["individual_license_terms_v5", GAME],
                             ["pub_license_terms_v5", PUB], ["pub_license_terms_v5_annex", PUB_ANNEX]] as const) {
    assert.ok(sql.includes(`$tpl$${body.trimEnd()}\n$tpl$`), `${key} の本文が SQL と同じ`);
    assert.ok(sql.includes(`VALUES ('${key}',`), `${key} を登録する`);
  }
  // 採番は従来の帯を続ける。
  assert.match(sql, /VALUES \('license_master_v5', '著作物利用許諾基本契約書V5', base_category, 'LIC', true\)/);
  assert.match(sql, /VALUES \('individual_license_terms_v5', '[^']+', base_category, 'ILT', true\)/);
  assert.match(sql, /VALUES \('pub_license_terms_v5_annex', '[^']+', base_category, 'PUBT', true\)/);
});

// ---------------------------------------------------------------- 基本契約V5
const masterContext = (kind: "individual" | "corporate"): Record<string, any> => ({
  document: { number: "ARC-LIC-2026-0101", issuedOn: "2026-11-20" },
  company: { name: "株式会社サンプル", address: "東京都千代田区", rep: "代表取締役 乙山 乙子" },
  owner: { name: "編集 花子", department: "出版事業部", email: "hanako@example.test", phone: "03-0000-0000" },
  contacts: kind === "corporate" ? [{ role: "primary", name: "窓口 太郎", email: "t@example.test", phone: null, department: "ライセンス部" }] : [],
  bank: { bankName: "〇〇銀行", branchName: "本店", accountType: "ordinary", accountNumber: "0000000", holderKana: "コウノ" },
  condition: { counterparty: kind === "individual"
    ? { name: "甲野 甲太（筆名：甲）", kind: "individual", address: "神奈川県横浜市", withholding: true, email: "kono@example.test" }
    : { name: "株式会社甲", kind: "corporate", address: "大阪府大阪市", withholding: false, invoiceNo: "T1234567890123",
        representativeTitle: "代表取締役", representativeName: "甲野 一郎" } }
});
const renderMaster = (ctx: Record<string, any>, manual: Record<string, unknown> = {}) => {
  const values = { BANK_INFO: bankInfoLine(ctx.bank), ...manual, ...licenseMasterV5Patch(ctx, manual) };
  return { values, out: renderDocumentHtml(MASTER, values) };
};

test("基本契約V5：本文が差す名前はすべて計算ブロックから出る（個人・法人）", () => {
  for (const kind of ["individual", "corporate"] as const) {
    const { values, out } = renderMaster(masterContext(kind));
    assert.deepEqual(blankPlaceholders(MASTER, values, LICENSE_MASTER_V5_VARIABLES.map((v) => v.name)), [], kind);
    assert.ok(!out.includes("{{"), "差し込みが残っていない");
  }
});

test("基本契約V5：個人は源泉あり・代表者は省略、法人は登録番号と代表者。通知先と支払先が基本条件に出る", () => {
  const person = renderMaster(masterContext("individual")).out;
  assert.match(person, /許諾者（甲）：甲野 甲太（筆名：甲）/);
  assert.match(person, /源泉徴収：あり ／ 適格請求書発行事業者：未登録/);
  assert.match(person, /（個人のため省略）/);
  assert.match(person, /甲：甲野 甲太（筆名：甲） ／ kono@example\.test/, "個人で主担当が無ければ本人の連絡先");
  assert.match(person, /乙：出版事業部 ／ 編集 花子 ／ hanako@example\.test/);
  assert.match(person, /〇〇銀行 \/ 本店 \/ 普通 0000000 \/ コウノ ／ 振込手数料：乙負担/);
  const corp = renderMaster(masterContext("corporate")).out;
  assert.match(corp, /源泉徴収：なし ／ 適格請求書発行事業者：登録済（T1234567890123）/);
  assert.match(corp, /代表取締役 甲野 一郎/);
  assert.ok(!corp.includes("個人のため省略"));
  // 条文：事業別条項は個別条件書に置く（第3条第5項）。基本契約に出版・ボードゲームの章は無い。
  assert.match(corp, /乙所定の事業別条項を定める/);
  assert.ok(!corp.includes("第A1条") && !corp.includes("第B1条"));
  assert.match(corp, /<b>第30条（存続）<\/b>/);
});

test("基本契約V5：署名欄は署名・押印のどちらでもよい枠（選ぶ欄は無い）。記名は自動", () => {
  const out = renderMaster(masterContext("corporate")).out;
  assert.equal(out.split('<div class="seal">署名<br>／押印</div>').length - 1, 2, "甲・乙の両方");
  assert.match(out, /<div class="f">会社名<\/div><div class="v">株式会社甲<\/div>/);
  assert.match(out, /<div class="f">会社名<\/div><div class="v">株式会社サンプル<\/div>/);
  assert.ok(!LICENSE_MASTER_V5_VARIABLES.some((v) => v.name === "署名欄"), "署名／押印を選ぶ欄は無い");
});

// ---------------------------------------------------------------- 個別条件書V5（ボードゲーム）
test("条件書V5（ボードゲーム）：V4 と同じ差し込みで描け、04 に事業別条項、通知先は 05", () => {
  const values: Record<string, unknown> = { ...gameManual, ...licenseTermsPatch(gameContext, gameManual) };
  const rowNames = new Set(["condName", "condNameEn", "condExclusivity", "condRegion", "condLang", "appliedRate",
    "condFormulaRated", "hasGuarantee", "ag", "mg", "currency", "lcName", "lcRole", "lcHolder", "lcNote",
    "lcSourceDoc", "dealRates", "edition", "trigger", "note", "seId", "seText",
    "slPartner", "slCond", "slRegion", "slLang", "slRate", "slDate", "slNote"]);
  assert.deepEqual(blankPlaceholders(GAME, values, LICENSE_TERMS_VARIABLES.map((v) => v.name)).filter((n) => !rowNames.has(n)), []);
  const out = renderDocumentHtml(GAME, values);
  assert.ok(!out.includes("{{"));
  for (const h of ["01</span>対象著作物", "02</span>許諾条件", "03</span>再許諾", "04</span>ボードゲームに関する定め", "05</span>通知先"]) {
    assert.ok(out.includes(h), h);
  }
  assert.ok(out.indexOf("04</span>ボードゲームに関する定め") < out.indexOf("05</span>通知先"));
  assert.match(out, /基本契約第3条第5項に定める事業別条項（ボードゲーム）/);
  assert.match(out, /ARC-LICENSE \/ INDIVIDUAL TERMS \/ BOARD GAME/);
});

// ---------------------------------------------------------------- 個別条件書V5（出版）
const cond = (over: Record<string, any>) => ({
  direction: "in", kind: "license", pricingModel: "revenue_rate", currency: "JPY",
  exclusivity: "non_exclusive", exclusivityLabel: "非独占", notes: null, counterpartyId: 5,
  termStart: "2026-12-01", termEnd: "2031-11-19",
  scopes: { region: ["全世界"], language: ["日本語"], media: [] as string[] }, ...over
});
const pubContext: Record<string, any> = {
  document: { number: "ARC-PUBT-2026-0201", issuedOn: "2026-12-01" },
  company: { name: "株式会社サンプル", address: "東京都千代田区", rep: "代表取締役 乙山 乙子" },
  agreement: { no: "ARC-LIC-2026-0101", title: "著作物利用許諾基本契約書", kind: "master", isV5Master: true },
  contacts: [{ role: "primary", name: "甲野 甲太", email: "kono@example.test", phone: null, department: null }],
  owner: { name: "編集 花子", email: "hanako@example.test", phone: null, department: "出版事業部" },
  bank: null,
  conditions: [
    cond({ id: 1, conditionNo: "CL-1", name: "星の本（単行本）", workId: 10, work: { title: "星の本" }, ratePct: 10,
      exclusivity: "exclusive", exclusivityLabel: "独占", scopes: { region: ["全世界"], language: ["日本語"], media: ["紙"] } }),
    cond({ id: 2, conditionNo: "CL-2", name: "星の本（単行本）", workId: 10, work: { title: "星の本" }, ratePct: 15,
      scopes: { region: ["全世界"], language: ["日本語"], media: ["電子"] } })
  ]
};
pubContext.condition = { ...pubContext.conditions[0], counterparty: { name: "甲野 甲太", kind: "individual", address: "東京都", withholding: true } };
const renderPub = (html: string, manual: Record<string, unknown> = {}) => {
  const rows = pubTitleSeeds(pubContext).map((r: Record<string, unknown>) => ({ ...r, copyright: "© 甲", third_party: "なし" }));
  const m = { pub_titles: rows, ...manual };
  const values = { taxRate: 10, BANK_INFO: "", ...m, ...pubTermsPatch(pubContext, m) };
  return { values, out: renderDocumentHtml(html, values) };
};
const PUB_ROW_NAMES = new Set(["no", "title", "edition", "copyright", "thirdParty", "printRate", "printExclusivity", "digitalRate",
  "digitalExclusivity", "note", "hasPrint", "hasDigital", "translation", "hasTranslation", "translationConsent", "hasNoteRow",
  "translationLabel", "translationDerivative", "term", "hasTerm", "hasShares", "coAuthors", "payeeShare"]);

test("条件書V5（出版）：一覧形式・別紙形式とも V3 と同じ差し込みで描ける", () => {
  for (const html of [PUB, PUB_ANNEX]) {
    const { values, out } = renderPub(html);
    assert.deepEqual(blankPlaceholders(html, values, PUB_TERMS_VARIABLES.map((v) => v.name)).filter((n) => !PUB_ROW_NAMES.has(n)), []);
    assert.ok(!out.includes("{{"));
    assert.match(out, /07<\/span>出版に関する定め/);
    assert.match(out, /基本契約第3条第5項に定める事業別条項（出版）/);
    assert.match(out, /10%／独占/);
  }
});

test("条件書V5（出版）：一覧形式は 01 に表・別紙なし。別紙形式は別紙1 に一覧だけ。特約事項はどちらも本文の09（旧合意と署名の間）", () => {
  const list = renderPub(PUB).out;
  assert.ok(list.indexOf('<table class="grid">') < list.indexOf('class="sign"'), "表は署名欄より前");
  assert.match(list, /09<\/span>特約事項/);
  assert.match(list, /10<\/span>通知先/);
  assert.ok(!list.includes('class="annex"'));
  assert.match(list, /第1条の一覧の「紙」欄/);
  assert.match(list, /変更するときは第9条（特約事項）に定める/);

  // 別紙形式も特約事項は本文（08 旧合意 → 09 特約事項 → 10 通知先 → 署名）。別紙は対象著作物一覧だけ（別紙1）。
  const annex = renderPub(PUB_ANNEX, { 特記事項: "書影の利用を無償で認める。" }).out;
  assert.match(annex, /別紙1「対象著作物一覧」<\/b>（全 1 点）/);
  const order = ["08</span>旧合意との関係", "09</span>特約事項", "書影の利用を無償で認める。", "10</span>通知先", 'class="sign"', "別紙1</span>対象著作物一覧"]
    .map((k) => annex.indexOf(k));
  assert.ok(order.every((n) => n >= 0) && order.every((n, k) => k === 0 || order[k - 1] < n), `並び: ${order.join(",")}`);
  assert.equal(annex.split('<div class="part">').length - 1, 1, "別紙は1つ（対象著作物一覧）");
  assert.ok(!annex.includes("別紙2") && !annex.includes("別紙1</span>特約事項"));
  assert.match(annex, /別紙1の一覧の「紙」欄/);
  assert.match(annex, /変更するときは第9条（特約事項）に定める/);
  assert.ok(!annex.includes("第1条の一覧"), "参照先は別紙1");
});

test("条件書V5（出版・ボードゲーム）：署名欄は記名（自動）＋署名／押印の枠。出さないときだけ「表示しない」", () => {
  for (const html of [PUB, PUB_ANNEX]) {
    const out = renderPub(html, { 署名欄: "表示する" }).out;
    assert.match(out, /記名<br>署名／押印<\/span><span class="box sign-box"><span class="pname"><b>甲野 甲太<\/b><\/span><span class="stamp">印<\/span>/);
    assert.match(out, /<span class="pname"><b>株式会社サンプル<\/b><br>代表取締役 乙山 乙子<\/span><span class="stamp">印<\/span>/);
    assert.equal(out.split('<span class="lbl">署名日</span>').length - 1, 2);
    // 以前の値（署名・押印）で保存した下書きも同じ枠で出る。
    assert.match(renderPub(html, { 署名欄: "押印" }).out, /class="box sign-box"/);
    assert.ok(!renderPub(html, { 署名欄: "表示しない" }).out.includes('class="sign"'));
  }
  const game = renderDocumentHtml(GAME, { ...gameManual, ...licenseTermsPatch(gameContext, gameManual) });
  assert.match(game, /<span class="pname"><b>株式会社オリジナル<\/b><br>代表取締役 甲野 甲太<\/span><span class="stamp">印<\/span>/);
  assert.match(game, /<span class="pname"><b>株式会社アークライト<\/b>/);
  assert.ok(!renderDocumentHtml(GAME, { ...gameManual, 署名欄: "表示しない", ...licenseTermsPatch(gameContext, gameManual) }).includes('class="sign"'));
});

test("条件書V5（出版）：作品数の警告は V5 のひな形の名前を出す", () => {
  const few = pubTermsWarnings(pubContext, "pub_license_terms_v5_annex").map((w) => w.message).join("\n");
  assert.match(few, /個別利用許諾条件書V5（出版・一覧形式）/);
});

// ---------------------------------------------------------------- 版の組み合わせ
test("版の組み合わせ：V5 の条件書は基本契約V5 の下だけ。旧版は基本契約V5 の下で勧めない", () => {
  const withMaster = (m: Record<string, unknown> | null) => ({ masterAgreement: m });
  assert.deepEqual(termsVersionWarnings("pub_license_terms_v5", withMaster({ no: "X", title: "著作物利用許諾基本契約書", isV5Master: true })), []);
  assert.match(termsVersionWarnings("individual_license_terms_v5", withMaster(null))[0].message, /基本契約が選ばれていません/);
  assert.match(termsVersionWarnings("pub_license_terms_v5_annex", withMaster({ no: "ARC-PUBM-1", title: "出版等利用許諾基本契約", isV5Master: false }))[0].message,
    /基本契約V5（著作物利用許諾基本契約書V5）ではありません/);
  assert.match(termsVersionWarnings("individual_license_terms_v4", withMaster({ no: "X", title: "T", isV5Master: true }))[0].message,
    /V5 の個別条件書/);
  assert.deepEqual(termsVersionWarnings("individual_license_terms_v4", withMaster({ no: "X", title: "T", isV5Master: false })), []);
  assert.deepEqual(termsVersionWarnings("purchase_order", withMaster(null)), []);
});

test("作業テーブル：IN の基本契約は V5。旧基本契約の相手先は本体の文書の既定が旧版になる", () => {
  assert.equal(MASTER_DOC.game_in?.key, "license_master_v5");
  assert.equal(MASTER_DOC.pub_in?.key, "license_master_v5");
  assert.equal(MASTER_DOC.game_out?.key, "license_master", "OUT は当社が許諾者なので従来の基本契約");
  assert.equal(MAIN_DOCS.game_in[0].key, "individual_license_terms_v5");
  assert.equal(MAIN_DOCS.pub_in[0].key, "pub_license_terms_v5");
  assert.equal(orderMainDocs(MAIN_DOCS.game_in, true)[0].key, "individual_license_terms_v4");
  assert.equal(orderMainDocs(MAIN_DOCS.pub_in, true)[0].key, "pub_license_terms_v3");
  assert.deepEqual(orderMainDocs(MAIN_DOCS.pub_in, false), MAIN_DOCS.pub_in);
});

test("レビュー反映：基本契約V5 の適用範囲・暫定許諾・終了処理・賠償上限・委託報酬の版", () => {
  const out = renderMaster(masterContext("corporate")).out;
  assert.match(out, /委託業務に関する定めは第12条の発注書が発行された業務に適用する/);
  assert.match(out, /量産、予約の受付、販売および再許諾は、個別条件書にその旨と範囲を定めたときに限り行える/);
  assert.match(out, /委託先との契約により、当該部分の著作権の譲渡または必要な利用許諾を確保し、その著作者の著作者人格権の取扱いを取り決める/);
  // 第7条は「尊重」。不行使の約束は求めない。
  assert.match(out, /<b>第7条（著作者人格権の尊重）<\/b>　乙は、本著作物の著作者の著作者人格権を尊重し/);
  assert.match(out, /著作者が表示を望まないときは、その意向に従う/);
  assert.match(out, /乙は、著作者の名誉または声望を害する方法で本著作物を利用しない/);
  assert.match(out, /甲は、本条の内容をその者に伝え、その者の意向を乙に取り次ぐ/);
  assert.ok(!out.includes("不行使"), "著作者人格権の不行使の文言は無い");
  assert.match(out, /報酬に含まれるのは初版第1刷の利用に係るものに限る/);
  assert.match(out, /成果物の無い監修・出演等の役務は、その役務の提供を終えた日/);
  assert.match(out, /素材の差替え、販売の停止または本製品の回収を要するときは、その費用は紛争の原因を生じた当事者が負担する/);
  assert.match(out, /個別条件書に許諾期間の更新の方法（自動更新の有無、更新の単位、終了の通知期限等）を定めたときは、本項および前項によらず/);
  assert.match(out, /本契約が第22条または第25条により解除されたときは、解除した当事者が別段の意思を表示しない限り、すべての個別条件書も同時に終了する/);
  assert.match(out, /終了日から12か月間（個別条件書に別段の定めがあるときはその期間）販売できる/);
  assert.match(out, /終了日以後の新規の販売および配信は停止する/);
  // 賠償：上限額は無し。表明保証・秘密保持・反社の違反は一切の損害、それ以外は実損害。
  assert.match(out, /相手方に現実に生じた通常かつ直接の損害（以下「実損害」という。）を賠償する/);
  assert.match(out, /第15条（表明保証）、第18条（秘密保持）、第19条（個人情報の保護）もしくは第25条（反社会的勢力の排除）の違反により、または故意もしくは重大な過失により相手方に損害を与えたときは、実損害に限らず/);
  assert.match(out, /前2項の賠償額に上限は設けない/);
  assert.ok(!out.includes("100万円") && !out.includes("を上限とする"), "金額の上限は無い");
  // 項の番号が詰まっている（第12条は 10 項まで）。
  assert.match(out, /10　乙は、甲が前項の相談を行ったことを理由として/);
});

test("レビュー反映：出版は出版権設定を独占的利用許諾と分け、旧合意は基本契約第27条による", () => {
  for (const [html, ref] of [[PUB, "第9条（特約事項）"], [PUB_ANNEX, "第9条（特約事項）"]] as const) {
    const out = renderPub(html).out;
    assert.match(out, /独占の作品は独占的利用許諾とする。ただし、同一覧の備考欄または.*?に「出版権設定」とある作品は/);
    assert.match(out, /同条ただし書の別段の定めとして、基本契約第10条（販売）および第11条（販売終了）による/);
    assert.match(out, /同法第80条第3項により第三者に複製または公衆送信を許諾することを承諾する/);
    assert.ok(out.includes(`基本契約第27条により${ref}に定める`), ref);
    assert.ok(!out.includes("これらを本条件書に統合する"), "従前の合意を一律に統合しない");
    assert.ok(!out.includes("2割"), "改訂の線引きは行為で");
  }
});

test("レビュー反映：ボードゲームは明示承認の対象・製品安全・他言語版の優先関係を 04 に持つ", () => {
  const out = renderDocumentHtml(GAME, { ...gameManual, ...licenseTermsPatch(gameContext, gameManual) });
  assert.match(out, /基本契約第9条第3項の承認のみなしを適用しない/);
  assert.match(out, /製品の安全・表示・事故の通知・回収の判断者と費用の負担は、別紙1に定める/);
  assert.match(out, /第3条及び別紙3により再許諾を認めた他言語版、対象製品の再版/);
});

test("条件書V5（出版）：紙・電子が再許諾を含む（再許諾の独立した行は第2条の決まりだけ）。電子は配信価格 × DL数・四半期の報告受領で支払", () => {
  const sub = (id: number, usageType: string, ratePct: number, media: string) => cond({ id, conditionNo: `CL-${id}`, name: "星の本",
    workId: 10, work: { title: "星の本" }, ratePct, usageType, scopes: { region: ["日本"], language: ["日本語"], media: [media] } });
  const render = (extra: any[], html: string) => {
    const ctx = { ...pubContext, conditions: [...pubContext.conditions, ...extra] };
    const rows = pubTitleSeeds(ctx).map((r: Record<string, unknown>) => ({ ...r, copyright: "© 甲", third_party: "なし" }));
    const m = { pub_titles: rows };
    const values = { taxRate: 10, BANK_INFO: "", ...m, ...pubTermsPatch(ctx, m) };
    assert.deepEqual(blankPlaceholders(html, values, PUB_TERMS_VARIABLES.map((v) => v.name)).filter((n) => !PUB_ROW_NAMES.has(n)), []);
    return renderDocumentHtml(html, values);
  };
  for (const html of [PUB, PUB_ANNEX]) {
    for (const out of [render([], html), render([sub(3, "pub_sub_print", 50, "紙"), sub(4, "pub_sub_digital", 40, "電子")], html)]) {
      const art2 = out.slice(out.indexOf("02</span>許諾内容"), out.indexOf("03</span>"));
      const art4 = out.slice(out.indexOf("04</span>許諾料"), out.indexOf("05</span>支払時期・方法"));
      const art5 = out.slice(out.indexOf("05</span>支払時期・方法"), out.indexOf("06</span>"));
      assert.match(art2, /対象出版物の複製・頒布（乙の子会社その他の出版社に再許諾して行わせることを含む）/);
      assert.match(art2, /主要電子書店における配信（DRM付き。電子書籍の配信事業者に再許諾して行わせることを含む）/);
      assert.match(art2, /<td class="k">再許諾<\/td><td>紙媒体出版・電子書籍配信の再許諾は、本条件書の許諾の範囲（地域・言語・媒体）内で行い、甲の個別の事前承諾を要しない/);
      assert.ok(!art4.includes('<td class="k">再許諾</td>') && !art5.includes('<td class="k">再許諾</td>'), "第4条・第5条に再許諾の行は無い");
      assert.match(art4, /乙又は再許諾先が発行する対象出版物の税抜定価 × 印税対象部数 × 料率/);
      assert.match(art4, /乙又は再許諾先による配信の配信価格（税抜）× ダウンロード数 × 料率/);
      assert.ok(!art4.includes("受領する金額"), "電子は配信価格 × DL数に統一");
      // 電子：四半期で集計し、翌四半期の末日までに支払う。紙：刊行日（増刷は発行日）を含む月の翌月末日。
      assert.ok(art5.includes("毎年1月1日〜3月31日、4月1日〜6月30日、7月1日〜9月30日及び10月1日〜12月31日を集計期間とし、"
        + "乙は、各集計期間について再許諾先（配信事業者）から受領した報告に基づき、当該集計期間の翌四半期の末日までに支払う。"));
      assert.match(art5, /刷ごとに、当該刷の刊行日（増刷は発行日）を含む月の翌月末日までに支払う。/);
      assert.ok(!art5.includes("刷部数確定の都度"));
      assert.match(art5, /再許諾先が行うものは、再許諾先ごとに、受領した報告の対象期間を併記する/);
      const body = out.slice(out.indexOf("<body>"));
      for (const pct of ["50%", "40%"]) assert.ok(!body.includes(pct), `再許諾の料率は記載しない（${pct}）`);
    }
  }
  // 電子の条件が入金額基準なら、V5 では直すよう警告する（V3 では警告しない）。
  const receipts = { ...pubContext, conditions: pubContext.conditions.map((c: any) => c.id === 2 ? { ...c, priceBasis: "receipts" } : c) };
  assert.ok(pubTermsWarnings(receipts, "pub_license_terms_v5").some((w) => /価格の基準が「入金額」/.test(w.message)));
  assert.ok(!pubTermsWarnings(receipts, "pub_license_terms_v3").some((w) => /価格の基準が「入金額」/.test(w.message)));
});

test("基本契約V5：有効期間は 5年（既定）／3年を選べ、基本条件と第23条に出る。特約事項の節。タイトル下の副題は無い", () => {
  const five = renderMaster(masterContext("corporate")).out;
  assert.match(five, /締結日から5年間。満了3か月前までに書面で申入れがなければ5年ごとに自動更新。.*?2年未満なら満了日からさらに5年（第23条）/);
  assert.match(five, /本契約の有効期間は、締結日から5年間とする。/);
  const three = renderMaster(masterContext("corporate"), { 契約期間: "3年" }).out;
  assert.match(three, /締結日から3年間。満了3か月前までに書面で申入れがなければ3年ごとに自動更新。.*?2年未満なら満了日からさらに3年（第23条）/);
  assert.match(three, /本契約の有効期間は、締結日から3年間とする。.*?本契約は同一の条件でさらに3年間更新され/);
  assert.match(three, /本契約の期間満了日から3年を経過する日/);
  assert.equal(LICENSE_MASTER_V5_VARIABLES.find((v) => v.name === "契約期間")?.default, "5年");
  assert.match(five, /<div>個別利用許諾条件書は本契約と一体をなし、矛盾するときは個別条件書が優先する（第3条）。<\/div>/);
  assert.ok(!five.includes("出版・ボードゲーム共通 ／"), "副題は無い");
  assert.match(five, /<h2>3. 特約事項<\/h2>\s*<p class="art">なし<\/p>/);
  assert.match(five, /<h2>4. 署名<\/h2>/);
  const special = renderMaster(masterContext("corporate"), { 特約事項: "甲の作品のうちTRPGは出版・ボードゲームの両方の事業別条項による。" }).out;
  assert.match(special, /特約事項と本契約の条項が抵触するときは、特約事項が優先する。<\/p>\s*<p class="art special">甲の作品のうちTRPGは/);
  assert.ok(!five.includes("特記事項"), "基本契約も「特約事項」");
  // 条は項の境目でページを分けてよい（条ごと次のページへ送らない）。
  assert.ok(!/\.art \{ break-inside: avoid/.test(MASTER));
});

test("条件書V5（出版）：基本契約V5 の有効期間が更新の単位の既定になる（条件明細に定めが無いとき）。特約事項", () => {
  const ctx = (years: number | null) => ({ ...pubContext,
    conditions: pubContext.conditions.map((c: any) => ({ ...c, autoRenew: true, renewMonths: null })),
    agreement: { ...pubContext.agreement, isV5Master: years != null, v5TermYears: years } });
  const out = (years: number | null) => {
    const c = ctx(years);
    const rows = pubTitleSeeds(c).map((r: Record<string, unknown>) => ({ ...r, copyright: "© 甲", third_party: "なし" }));
    const m = { pub_titles: rows };
    return renderDocumentHtml(PUB, { taxRate: 10, BANK_INFO: "", ...m, ...pubTermsPatch(c, m) });
  };
  assert.match(out(3), /期間満了の3か月前までに.*?同一条件で3年ごとに自動更新する/);
  assert.match(out(5), /期間満了の3か月前までに.*?同一条件で5年ごとに自動更新する/);
  assert.match(renderPub(PUB).out, /09<\/span>特約事項/);
  assert.ok(!renderPub(PUB_ANNEX).out.includes("特記事項"));
  assert.ok(!renderDocumentHtml(GAME, { ...gameManual, ...licenseTermsPatch(gameContext, gameManual) }).includes("特記事項"), "ボードゲームも「特約事項」");
});
