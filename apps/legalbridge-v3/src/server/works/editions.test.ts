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

test("刊行物の根拠の再許諾には、作者の紙・電子の条件も効く", () => {
  assert.equal(usageCovers("sublicense", "sublicense", false), true);
  assert.equal(usageCovers("pub_print", "sublicense", false), false, "刊行物の根拠でなければ同じ利用形態だけ");
  assert.equal(usageCovers("pub_print", "sublicense", true), true);
  assert.equal(usageCovers("pub_digital", "sublicense", true), true);
  assert.equal(usageCovers("game_goods", "sublicense", true), false);
  assert.equal(usageCovers("pub_print", "oem", true), false);
  const inC = (id: number, usageType: string): FlowIn => ({
    id, conditionNo: null, name: "", partyId: 1, partyName: "スタジオ・アーカム", workId: 7, workTitle: "作品",
    usageType, usageLabel: usageType, pricingModel: "revenue_rate", ratePct: 7, unitAmount: null, timing: "event",
    targetPartyId: null, targetPartyName: null
  } as FlowIn);
  const ins = [inC(1, "pub_print"), inC(2, "pub_digital")];
  const out = { id: 50, usageType: "sublicense", workId: 7, partyId: 9 };
  assert.deepEqual(coversOf(out, ins, () => [7]), [], "刊行物が無ければ届かない");
  assert.deepEqual(coversOf(out, ins, () => [7], new Set([50])), [1, 2], "刊行物（KADOKAWA 版）の根拠なら紙・電子の作者に届く");
});

test("JAN：13 桁・短縮 8 桁を ISBN と同じ重みで確かめる", () => {
  assert.equal(normalizeProductCode("4901234567894", "JAN"), "4901234567894");
  assert.equal(normalizeProductCode("4901-2345-6789-4", "JAN"), "4901234567894", "区切りを落とす");
  assert.equal(normalizeProductCode("49123456", "JAN"), "49123456", "短縮 JAN");
  assert.throws(() => normalizeProductCode("4901234567890", "JAN"), /JAN 4901234567890 のチェックディジット/);
  assert.throws(() => normalizeProductCode("49123457", "JAN"), /チェックディジット/);
});
