import { test } from "node:test";
import assert from "node:assert/strict";
import { editionWarnings, normalizeIsbn, normalizeProductCode, usageCovers } from "./editions.js";
import { coversOf, type FlowIn } from "./rights-flow.js";

test("ISBN：区切り・タブ・見えない文字を落とし、チェックディジットを確かめる", () => {
  assert.equal(normalizeIsbn("978-4-04-729464-6"), "9784047294646");
  assert.equal(normalizeIsbn("\t‎9784047340510"), "9784047340510", "表計算から紛れ込むタブと U+200E");
  assert.equal(normalizeIsbn("９７８４０４７２９４６４６"), "9784047294646", "全角数字");
  assert.equal(normalizeIsbn("4-04-729464-0"), "4047294640", "10 桁");
  assert.equal(normalizeIsbn(""), null);
  assert.equal(normalizeIsbn(null), null);
  assert.throws(() => normalizeIsbn("9784047294647"), /チェックディジット/);
  assert.throws(() => normalizeIsbn("12345"), /13 桁/);
});

test("刊行物の確かめてほしいこと", () => {
  assert.deepEqual(editionWarnings({ relation: "own", publisherPartyId: null, outConditionId: null, isbn: "9784047294646" }), []);
  assert.deepEqual(editionWarnings({ relation: "group", publisherPartyId: 5, outConditionId: null, isbn: "9784047294646" }), [],
    "グループ会社（料率なし）は条件が無くてよい");
  assert.match(editionWarnings({ relation: "sublicense", publisherPartyId: 5, outConditionId: null, isbn: "9784047294646" })[0], /版元・販売元との条件/);
  assert.match(editionWarnings({ relation: "oem", publisherPartyId: 5, outConditionId: null, isbn: "4904810123457" })[0], /OEM の条件/);
  assert.match(editionWarnings({ relation: "sublicense", publisherPartyId: 5, outConditionId: 9, isbn: null })[0], /ISBN/);
});

test("出版の再許諾には、その媒体の作者の条件だけが効く（紙と電子を取り違えない）", () => {
  assert.equal(usageCovers("sublicense", "sublicense", null), true);
  assert.equal(usageCovers("pub_print", "sublicense", null), false, "出版の再許諾でなければ同じ利用形態だけ");
  assert.equal(usageCovers("pub_print", "sublicense", "print"), true);
  assert.equal(usageCovers("pub_digital", "sublicense", "print"), false, "紙の再許諾に作者の電子は効かない");
  assert.equal(usageCovers("pub_digital", "sublicense", "digital"), true);
  assert.equal(usageCovers("pub_print", "sublicense", "digital"), false, "電子の再許諾に作者の紙は効かない");
  assert.equal(usageCovers("pub_print", "oem", "print"), false);
  const inC = (id: number, usageType: string): FlowIn => ({
    id, conditionNo: null, name: "", partyId: 1, partyName: "スタジオ・アーカム", workId: 7, workTitle: "作品",
    usageType, usageLabel: usageType, pricingModel: "revenue_rate", ratePct: 7, unitAmount: null, timing: "event",
    targetPartyId: null, targetPartyName: null
  } as FlowIn);
  const ins = [inC(1, "pub_print"), inC(2, "pub_digital")];
  const out = (id: number) => ({ id, usageType: "sublicense", workId: 7, partyId: 9 });
  assert.deepEqual(coversOf(out(50), ins, () => [7]), [], "出版の再許諾でなければ届かない");
  const pub = new Map<number, "print" | "digital">([[50, "print"], [51, "digital"]]);
  assert.deepEqual(coversOf(out(50), ins, () => [7], pub), [1], "KADOKAWA 紙 → 作者の紙だけ");
  assert.deepEqual(coversOf(out(51), ins, () => [7], pub), [2], "KADOKAWA 電子 → 作者の電子だけ");
});

test("JAN：13 桁・短縮 8 桁を ISBN と同じ重みで確かめる", () => {
  assert.equal(normalizeProductCode("4901234567894", "JAN"), "4901234567894");
  assert.equal(normalizeProductCode("4901-2345-6789-4", "JAN"), "4901234567894", "区切りを落とす");
  assert.equal(normalizeProductCode("49123456", "JAN"), "49123456", "短縮 JAN");
  assert.throws(() => normalizeProductCode("4901234567890", "JAN"), /JAN 4901234567890 のチェックディジット/);
  assert.throws(() => normalizeProductCode("49123457", "JAN"), /チェックディジット/);
});
