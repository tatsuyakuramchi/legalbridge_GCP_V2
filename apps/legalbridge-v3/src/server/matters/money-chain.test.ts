import test from "node:test";
import assert from "node:assert/strict";
import { chainIndexOf, moneyChain } from "./money-chain.js";
import { buildFlow } from "./flow.js";
import type { FlowFacts } from "./flow.js";

const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  matterKind: "outsourcing", documentStyle: null, matterStatus: "open",
  conditionCount: 0, activeConditionCount: 0, conditionsWithWork: 0,
  agreementExecuted: false, agreementNo: null,
  issuedDocuments: [], draftDocuments: 0, importedDocuments: 0,
  events: {}, latestEventOn: null, statements: 0, payments: { total: 0, paid: 0 },
  ...over
});

test("お金の流れは 条件明細 → 実績 → 文書 → 支払 の順で、間に文書が入る", () => {
  for (const kind of ["outsourcing", "work"] as const) {
    const steps = moneyChain(kind);
    assert.deepEqual(steps.map((s) => s.tab), ["conditions", "events", "documents", "payments"]);
    // 実績の次が支払ではないこと。ここを飛ばすと「実績から直接支払」を探して止まる。
    assert.equal(steps[2].tab, "documents");
    for (const s of steps) assert.ok(s.hint.length > 5, `${kind} の ${s.label} に説明が無い`);
  }
});

test("業務委託は検収書、ライセンスは計算書を挟む", () => {
  assert.match(moneyChain("outsourcing")[2].hint, /検収書/);
  assert.match(moneyChain("work")[2].hint, /計算書/);
  // 文書だけの案件には道しるべを出さない（工程バーで足りる）。
  assert.deepEqual(moneyChain("single"), []);
});

test("いまいるタブが流れの何番目か。流れの外は -1", () => {
  const steps = moneyChain("outsourcing");
  assert.equal(chainIndexOf(steps, "conditions"), 0);
  assert.equal(chainIndexOf(steps, "payments"), 3);
  assert.equal(chainIndexOf(steps, "communications"), -1);
  assert.equal(chainIndexOf(steps, "graph"), -1);
});

test("実績を入れる段階は実績タブへ送る（条件明細タブではない）", () => {
  // 工程バーの行き先と、お金の流れの並びが食い違うと、押した先で手が止まる。
  const steps = buildFlow(facts({ matterKind: "outsourcing" }));
  const byName = Object.fromEntries(steps.map((s) => [s.name, s]));
  assert.equal(byName["納品・報告"].tab, "events");
  assert.equal(byName["検収"].tab, "events");
  assert.equal(byName["支払"].tab, "payments");
  assert.equal(buildFlow(facts({ matterKind: "work" }))[3].tab, "events");

  // 行き先のあるタブは、お金の流れか案件のタブのどれかであること。
  const known = new Set(["conditions", "events", "documents", "payments", "communications"]);
  for (const kind of ["outsourcing", "work", "single"] as const) {
    for (const s of buildFlow(facts({ matterKind: kind }))) {
      assert.ok(s.tab && known.has(s.tab), `${kind} の「${s.name}」の行き先が無い／知らないタブ`);
    }
  }
});
