import test from "node:test";
import assert from "node:assert/strict";
import { coversOf, flowWarnings, type FlowIn, type FlowOut } from "./rights-flow.js";

const inC = (id: number, partyId: number, usageType: string, over: Partial<FlowIn> = {}): FlowIn => ({
  id, conditionNo: `CI-${id}`, name: "", partyId, partyName: partyId === 1 ? "作者A" : "イラストB", workId: 1, workTitle: "ito",
  usageType, usageLabel: usageType === "oem" ? "自社製造・他社販売" : "再許諾", pricingModel: "revenue_rate",
  ratePct: 5, unitAmount: null, timing: "periodic", targetPartyId: null, targetPartyName: null, ...over
});
const outC = (id: number, partyId: number, usageType: string, workId: number): FlowOut => ({
  id, conditionNo: `CO-${id}`, name: "", partyId, partyName: partyId === 3 ? "Asmodee" : "Hobby Japan", workId, workTitle: null,
  usageType, usageLabel: usageType === "oem" ? "自社製造・他社販売" : "再許諾", languages: [], regions: [], agreementNo: null, covers: []
});
// 作品 1（ito）→ 2（英語版）
const lineageOf = (id: number) => id === 2 ? [2, 1] : [id];

test("許諾先に効く作者：同じ利用形態・作品かその元の作品・許諾先専用の条件が勝つ", () => {
  const ins = [inC(10, 1, "sublicense"), inC(11, 2, "sublicense"), inC(12, 1, "sublicense", { targetPartyId: 3 }), inC(13, 1, "oem")];
  assert.deepEqual(coversOf(outC(20, 3, "sublicense", 2), ins, lineageOf), [11, 12], "Asmodee には作者A の専用の条件、イラストB は一律");
  assert.deepEqual(coversOf(outC(21, 4, "sublicense", 2), ins, lineageOf), [10, 11], "ほかの許諾先には一律");
  assert.deepEqual(coversOf(outC(22, 4, "oem", 1), ins, lineageOf), [13]);
  assert.deepEqual(coversOf(outC(23, 4, "sublicense", 9), ins, lineageOf), [], "関係の無い作品");
});

test("確かめてほしいこと：作者のいない許諾先・払いが出ない作者・重複", () => {
  const ins = [inC(10, 1, "sublicense"), inC(11, 2, "sublicense"), inC(13, 1, "oem"), inC(14, 1, "oem")];
  const outs = [outC(20, 3, "sublicense", 2), outC(22, 4, "oem", 1), outC(24, 4, "sublicense", 9)];
  for (const o of outs) o.covers = coversOf(o, ins, lineageOf);
  const w = flowWarnings(ins, outs);
  assert.deepEqual(w.map((x) => x.kind).sort(), ["duplicate", "missing_author", "uncovered"]);
  assert.match(w.find((x) => x.kind === "missing_author")!.message, /Hobby Japan.*イラストB に払いが出ません/);
  assert.match(w.find((x) => x.kind === "duplicate")!.message, /作者A × ito × 自社製造・他社販売 の条件が 2 本/);
});
