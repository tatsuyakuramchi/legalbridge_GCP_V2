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
  assert.deepEqual(steps.map((s) => s.done), [false, false, false, false, false, false]);
  assert.equal(currentStep(steps)?.name, "基本契約の確認");
});

/**
 * 発注書も検収書も条件明細から出る。段階に無いと、案件を見ている人には
 * どこで委託の中身を登録するのかが読めない。
 */
test("業務委託は 発注の前に 条件明細の登録 を置く", () => {
  const steps = buildFlow(facts({ agreementExecuted: true }));
  assert.deepEqual(steps.map((s) => s.name),
    ["基本契約の確認", "条件明細の登録", "発注", "納品・報告", "検収", "支払"]);
  assert.equal(currentStep(steps)?.name, "条件明細の登録");
  assert.match(steps[1].detail, /発注書はここから出る/);

  const withCondition = buildFlow(facts({ agreementExecuted: true, activeConditionCount: 2 }));
  assert.equal(withCondition[1].done, true);
  assert.match(withCondition[1].detail, /有効な条件 2 件/);
});

test("段階には、その作業をする場所が付いている", () => {
  // 「次はこれ」と分かっても、どこで手を動かすかが分からなければ止まる。
  for (const kind of ["outsourcing", "work", "single"] as const) {
    for (const step of buildFlow(facts({ matterKind: kind }))) {
      assert.ok(step.tab, `${kind} の「${step.name}」に置き場所が無い`);
    }
  }
  const steps = buildFlow(facts());
  assert.equal(steps[1].tab, "conditions");
  assert.equal(steps[2].tab, "documents");
  assert.equal(steps[5].tab, "payments");
});

test("業務委託は 合意→発注→納品→検収→支払 の順で埋まる", () => {
  const steps = buildFlow(facts({
    agreementExecuted: true, agreementNo: "AGR-2026-0012",
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }],
    events: { delivery: 1 }, latestEventOn: "2026-06-30"
  }));
  assert.deepEqual(steps.map((s) => s.done), [true, false, true, true, false, false]);
  assert.equal(currentStep(steps)?.name, "条件明細の登録");
  assert.match(steps[0].detail, /AGR-2026-0012 締結済み/);
  assert.match(steps[3].detail, /2026-06-30/);
});

test("検収の実績が入れば検収が済になる", () => {
  const steps = buildFlow(facts({ events: { delivery: 1, inspection: 2 } }));
  assert.equal(steps[4].done, true);
  assert.match(steps[4].detail, /検収の実績 2 件/);
});

test("支払は「支払済み」になって初めて済（予定だけでは済まない）", () => {
  const planned = buildFlow(facts({ payments: { total: 3, paid: 0 } }));
  assert.equal(planned[5].done, false);
  assert.match(planned[5].detail, /3 件のうち 0 件が支払済み/);

  const paid = buildFlow(facts({ payments: { total: 3, paid: 3 } }));
  assert.equal(paid[5].done, true);
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
  assert.equal(steps[2].name, "相手方の文書を確認");
  assert.equal(steps[2].done, false);
  assert.match(steps[2].detail, /外で作った文書を登録/);

  // 自社で発行しても、レビュー型では取り込みの代わりにならない。
  const issued = buildFlow(facts({
    documentStyle: "counterparty_review",
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }] }));
  assert.equal(issued[2].done, false);

  const imported = buildFlow(facts({
    documentStyle: "counterparty_review", importedDocuments: 1 }));
  assert.equal(imported[2].done, true);
  assert.match(imported[2].detail, /取り込んだ文書 1 件/);
});

test("自社テンプレート型は、下書きの段階では済にしない", () => {
  const draft = buildFlow(facts({ documentStyle: "own_template", draftDocuments: 1 }));
  assert.equal(draft[2].name, "ひな形から文書を決定");
  assert.equal(draft[2].done, false);
  assert.match(draft[2].detail, /決定するとここが済になる/);

  const issued = buildFlow(facts({
    documentStyle: "own_template",
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }] }));
  assert.equal(issued[2].done, true);
});

test("自社ドラフト型は名前が変わり、やることが分かる", () => {
  const steps = buildFlow(facts({ documentStyle: "own_draft" }));
  assert.equal(steps[2].name, "自社ドラフトを決定");
  assert.match(steps[2].detail, /外で作った文書を登録/);
});

test("進め方が未設定なら、それを次にやることとして出す", () => {
  const steps = buildFlow(facts());
  assert.equal(steps[2].name, "発注", "これまでの名前のまま");
  assert.match(steps[2].detail, /進め方が未設定/);
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

/**
 * 文書作成モデルの3択で、やることが変わる。
 *   他社レビュー型・自社ドラフト型 … 外で作った文書を登録する。条件は要るときだけ
 *   自社テンプレート型             … ひな形の中身が条件から埋まるので、条件明細が要る
 */
test("文書作成モデルでも進め方が効く", () => {
  const template = buildFlow(facts({ matterKind: "single", documentStyle: "own_template" }));
  assert.deepEqual(template.map((s) => s.name),
    ["相談の受付", "条件明細の登録", "ひな形から文書を決定", "締結", "完了"]);
  assert.equal(currentStep(template)?.name, "条件明細の登録");

  for (const style of ["counterparty_review", "own_draft"] as const) {
    const steps = buildFlow(facts({ matterKind: "single", documentStyle: style }));
    assert.equal(steps.length, 4, `${style} に条件明細の段階は挟まない`);
    assert.match(steps[1].detail, /外で作った文書を登録/);
    assert.match(steps[1].detail, /条件明細も登録/, "要るときは条件も登録できると分かる");
  }
});

test("文書作成モデルでも条件明細を持てる", () => {
  // 覚書のように金銭の条件を持つ文書がある。持てないと、ひな形の明細が埋まらない。
  const withCondition = buildFlow(facts({
    matterKind: "single", documentStyle: "own_template", activeConditionCount: 1 }));
  assert.equal(withCondition[1].done, true);
  assert.match(withCondition[1].detail, /有効な条件 1 件/);
});

test("済の理由を必ず添える（印だけでは確かめようがない）", () => {
  for (const step of buildFlow(facts({ matterKind: "work" }))) {
    assert.ok(step.detail.trim().length > 0, `${step.name} に根拠がない`);
  }
});
