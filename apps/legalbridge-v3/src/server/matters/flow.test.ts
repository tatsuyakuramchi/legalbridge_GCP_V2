import test from "node:test";
import assert from "node:assert/strict";
import { buildFlow, currentStep, type FlowFacts } from "./flow.js";

const facts = (over: Partial<FlowFacts> = {}): FlowFacts => ({
  matterKind: "outsourcing", documentStyle: null, matterStatus: "open",
  conditionCount: 0, activeConditionCount: 0, conditionsWithWork: 0,
  agreementExecuted: false, agreementNo: null,
  issuedDocuments: [], draftDocuments: 0, importedDocuments: 0,
  events: {}, latestEventOn: null, statements: 0,
  payments: { total: 0, paid: 0 }, ...over
});

test("何も無い案件は、最初の段階が「いま」になる", () => {
  const steps = buildFlow(facts());
  assert.deepEqual(steps.map((s) => s.done), [false, false, false, false, false]);
  assert.equal(currentStep(steps)?.name, "基本契約の確認");
});

test("業務委託は 合意→発注→納品→検収→支払 の順で埋まる", () => {
  const steps = buildFlow(facts({
    agreementExecuted: true, agreementNo: "AGR-2026-0012",
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }],
    events: { delivery: 1 }, latestEventOn: "2026-06-30"
  }));
  assert.deepEqual(steps.map((s) => s.done), [true, true, true, false, false]);
  assert.equal(currentStep(steps)?.name, "検収");
  assert.match(steps[0].detail, /AGR-2026-0012 締結済み/);
  assert.match(steps[2].detail, /2026-06-30/);
});

test("検収の実績が入れば検収が済になる", () => {
  const steps = buildFlow(facts({ events: { delivery: 1, inspection: 2 } }));
  assert.equal(steps[3].done, true);
  assert.match(steps[3].detail, /検収の実績 2 件/);
});

test("支払は「支払済み」になって初めて済（予定だけでは済まない）", () => {
  const planned = buildFlow(facts({ payments: { total: 3, paid: 0 } }));
  assert.equal(planned[4].done, false);
  assert.match(planned[4].detail, /3 件のうち 0 件が支払済み/);

  const paid = buildFlow(facts({ payments: { total: 3, paid: 3 } }));
  assert.equal(paid[4].done, true);
});

test("ライセンスは作品への紐づけから始まる", () => {
  const steps = buildFlow(facts({ matterKind: "work" }));
  assert.equal(steps[0].name, "権利の上限確認");
  assert.match(steps[0].detail, /許諾できる上限が決まらない/);

  const withWork = buildFlow(facts({
    matterKind: "work", conditionsWithWork: 2, activeConditionCount: 2 }));
  assert.deepEqual(withWork.slice(0, 2).map((s) => s.done), [true, true]);
});

test("ライセンスの実績は 売上・製造・再許諾の受領 を数える", () => {
  const steps = buildFlow(facts({
    matterKind: "work", events: { sales: 4, inspection: 9 }, latestEventOn: "2026-06-30" }));
  assert.equal(steps[3].done, true, "売上は実績として数える");
  assert.match(steps[3].detail, /実績 4 件/, "検収はライセンスでは数えない");
});

test("文書作成は条件を持たないので、文書と案件の状態だけで進む", () => {
  const steps = buildFlow(facts({ matterKind: "single" }));
  assert.equal(steps.length, 4);
  assert.equal(steps[0].done, true, "案件が立っている時点で受付は済");
  assert.equal(currentStep(steps)?.name, "文書の用意");

  const done = buildFlow(facts({
    matterKind: "single", matterStatus: "done",
    issuedDocuments: [{ documentNo: "ARC-NDA-2026-0001", label: "NDA" }] }));
  assert.equal(currentStep(done), null, "すべて済なら次にやることは無い");
});

// ---- 進め方（何をするか） ----

test("他社文書レビュー型は、相手方の文書を取り込むまで進まない", () => {
  const steps = buildFlow(facts({ documentStyle: "counterparty_review" }));
  assert.equal(steps[1].name, "相手方の文書を確認");
  assert.equal(steps[1].done, false);
  assert.match(steps[1].detail, /受け取った文書を登録/);

  // 自社で発行しても、レビュー型では取り込みの代わりにならない。
  const issued = buildFlow(facts({
    documentStyle: "counterparty_review",
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }] }));
  assert.equal(issued[1].done, false);

  const imported = buildFlow(facts({
    documentStyle: "counterparty_review", importedDocuments: 1 }));
  assert.equal(imported[1].done, true);
  assert.match(imported[1].detail, /取り込んだ文書 1 件/);
});

test("自社テンプレート型は、下書きの段階では済にしない", () => {
  const draft = buildFlow(facts({ documentStyle: "own_template", draftDocuments: 1 }));
  assert.equal(draft[1].name, "ひな形から文書を決定");
  assert.equal(draft[1].done, false);
  assert.match(draft[1].detail, /決定するとここが済になる/);

  const issued = buildFlow(facts({
    documentStyle: "own_template",
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }] }));
  assert.equal(issued[1].done, true);
});

test("自社ドラフト型は名前が変わり、やることが分かる", () => {
  const steps = buildFlow(facts({ documentStyle: "own_draft" }));
  assert.equal(steps[1].name, "自社ドラフトを決定");
  assert.match(steps[1].detail, /自社で書いた文書を登録/);
});

test("進め方が未設定なら、それを次にやることとして出す", () => {
  const steps = buildFlow(facts());
  assert.equal(steps[1].name, "発注", "これまでの名前のまま");
  assert.match(steps[1].detail, /進め方が未設定/);
});

test("ライセンスでも進め方が段階の名前を決める", () => {
  const steps = buildFlow(facts({ matterKind: "work", documentStyle: "counterparty_review" }));
  assert.equal(steps[2].name, "相手方の文書を確認");

  // 合意が締結済みなら、そちらが根拠になる（文書を待たない）。
  const executed = buildFlow(facts({
    matterKind: "work", documentStyle: "counterparty_review",
    agreementExecuted: true, agreementNo: "AGR-2026-0012" }));
  assert.equal(executed[2].name, "契約書の締結");
  assert.equal(executed[2].done, true);
});

test("文書作成モデルでも進め方が効く", () => {
  const steps = buildFlow(facts({ matterKind: "single", documentStyle: "own_template" }));
  assert.equal(steps[1].name, "ひな形から文書を決定");
});

test("済の理由を必ず添える（印だけでは確かめようがない）", () => {
  for (const step of buildFlow(facts({ matterKind: "work" }))) {
    assert.ok(step.detail.trim().length > 0, `${step.name} に根拠がない`);
  }
});
