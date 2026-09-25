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
  // 末尾の「継続」は状態なので、契約が無ければ済（完了にできる）。
  assert.deepEqual(steps.map((s) => s.done), [false, false, false, false, false, false, true]);
  assert.equal(currentStep(steps)?.name, "基本契約の確認");
});

/**
 * 発注書も検収書も条件明細から出る。段階に無いと、案件を見ている人には
 * どこで委託の中身を登録するのかが読めない。
 */
test("業務委託は 発注の前に 条件明細の登録 を置く", () => {
  const steps = buildFlow(facts({ agreementExecuted: true }));
  assert.deepEqual(steps.map((s) => s.name),
    ["基本契約の確認", "条件明細の登録", "発注", "納品・報告", "検収", "支払", "継続"]);
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
  assert.deepEqual(steps.map((s) => s.done), [true, false, true, true, false, false, true]);
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

test("作品案件は作品の登録から始まる", () => {
  const steps = buildFlow(facts({ matterKind: "work" }));
  assert.equal(steps[0].name, "作品の登録");
  assert.equal(steps[0].block, "work");
  assert.match(steps[0].detail, /許諾できる上限が決まらない/);

  const withWork = buildFlow(facts({
    matterKind: "work", workId: 7, workTitle: "作品A", licenseConditions: 2, activeConditionCount: 2 }));
  assert.deepEqual(withWork.slice(0, 2).map((s) => s.done), [true, true]);
  assert.match(withWork[0].detail, /作品「作品A」/);
});

test("作品案件は 作品 → 許諾 → 継続 の順。制作委託があれば 作品 → 制作委託 → 許諾", () => {
  const plain = buildFlow(facts({ matterKind: "work" }));
  assert.deepEqual(plain.map((s) => s.block),
    ["work", "license", "license", "license", "license", "continue"]);

  // 人が「制作委託あり」と決めた。
  const decided = buildFlow(facts({ matterKind: "work", production: true }));
  assert.deepEqual(decided.map((s) => s.name),
    ["作品の登録", "基本契約の確認", "条件明細の登録", "発注", "納品・報告", "検収", "支払",
     "条件の合意", "契約書の締結", "実績の受領", "計算書と分配", "継続"]);
  assert.equal(decided[1].block, "production");

  // 未決定でも、委託料の条件か成果物が相手に帰属する条件が繋がれば制作委託を出す。
  const inferred = buildFlow(facts({ matterKind: "work", production: null, contractorOwned: 1 }));
  assert.ok(inferred.some((s) => s.block === "production"));
  // 人が「なし」と決めたら、条件があっても出さない。
  const off = buildFlow(facts({ matterKind: "work", production: false, serviceConditions: 3 }));
  assert.ok(!off.some((s) => s.block === "production"));
});

test("許諾の実績は 売上・製造・再許諾の受領 を数える", () => {
  const steps = buildFlow(facts({
    matterKind: "work", events: { sales: 4, inspection: 9 }, latestEventOn: "2026-06-30" }));
  assert.equal(steps[3].name, "実績の受領");
  assert.equal(steps[3].done, true, "売上は実績として数える");
  assert.match(steps[3].detail, /実績 4 件/, "検収は許諾では数えない");
});

test("その他案件は 受付 → 検討 → 決定 → 完了 の簡単な制御で進む", () => {
  const steps = buildFlow(facts({ matterKind: "single" }));
  assert.deepEqual(steps.map((s) => s.name), ["受付", "検討", "決定", "完了"]);
  assert.equal(steps[0].done, true, "案件が立っている時点で受付は済");
  assert.equal(currentStep(steps)?.name, "検討");

  const considering = buildFlow(facts({ matterKind: "single", tasks: { total: 3, done: 1 } }));
  assert.equal(considering[1].done, true);
  assert.match(considering[1].detail, /タスク 1／3/);
  assert.equal(currentStep(considering)?.name, "決定");

  const done = buildFlow(facts({
    matterKind: "single", matterStatus: "done",
    issuedDocuments: [{ documentNo: "ARC-NDA-2026-0001", label: "NDA" }] }));
  assert.equal(currentStep(done), null, "すべて済なら次にやることは無い");
});

test("継続は状態であって作業ではない（次にやることに数えない・生きている契約があれば未済）", () => {
  const all = buildFlow(facts({
    agreementExecuted: true, activeConditionCount: 1,
    issuedDocuments: [{ documentNo: "ARC-PO-2026-0031", label: "発注書" }],
    events: { delivery: 1, inspection: 1 }, payments: { total: 1, paid: 1 },
    liveAgreements: [{ agreementNo: "ARC-SVC-2026-0001", kind: "master", currentEnd: "2027-03-31" }]
  }));
  const last = all[all.length - 1];
  assert.equal(last.name, "継続");
  assert.equal(last.optional, true);
  assert.equal(last.done, false);
  assert.match(last.detail, /ARC-SVC-2026-0001 〜2027-03-31/);
  assert.equal(currentStep(all), null, "工程は全部済。継続は次にやることに数えない");

  const kids = buildFlow(facts({ children: { total: 2, open: 1 } }));
  assert.match(kids[kids.length - 1].detail, /開いている子の案件 1／2/);
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

test("作品案件でも進め方が段階の名前を決める", () => {
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
test("その他案件でも文書と条件を持てる（検討の根拠になる）", () => {
  // 新しい契約スキームの立案なら、文書の下書きや金銭の条件を持つことがある。
  const withCondition = buildFlow(facts({
    matterKind: "single", documentStyle: "own_template", activeConditionCount: 1 }));
  assert.equal(withCondition[1].done, true);
  assert.match(withCondition[1].detail, /条件 1 件/);

  const decided = buildFlow(facts({
    matterKind: "single", issuedDocuments: [{ documentNo: "ARC-MOU-2026-0001", label: "覚書" }] }));
  assert.equal(decided[2].done, true);
  assert.match(decided[2].detail, /ARC-MOU-2026-0001/);
});

test("済の理由を必ず添える（印だけでは確かめようがない）", () => {
  for (const step of buildFlow(facts({ matterKind: "work" }))) {
    assert.ok(step.detail.trim().length > 0, `${step.name} に根拠がない`);
  }
});

test("業務委託の「支払」は、定額の条件が全部払い切れて済になる（1件払っただけでは済にしない）", () => {
  const half = buildFlow(facts({ payments: { total: 2, paid: 1 }, fixedConditions: { total: 2, done: 1 } }));
  assert.equal(half[5].done, false);
  assert.match(half[5].detail, /2 本のうち 1 本が払い切り/);
  const all = buildFlow(facts({ payments: { total: 2, paid: 2 }, fixedConditions: { total: 2, done: 2 } }));
  assert.equal(all[5].done, true);
  // 定額の条件が無い（料率だけ）なら、これまでどおり支払の件数で見る。
  const rate = buildFlow(facts({ payments: { total: 1, paid: 1 }, fixedConditions: { total: 0, done: 0 } }));
  assert.equal(rate[5].done, true);
});

// ---- 受付（docs/v3-request-inbox.md）----

test("受付箱から繋いだ依頼があれば、どのフローにも先頭に「受付」を出す", () => {
  const intake = { total: 2, unseen: 1, keys: ["LEGAL-9001", "LEGAL-9002"] };
  for (const kind of ["outsourcing", "work"] as const) {
    const steps = buildFlow(facts({ matterKind: kind, intake }));
    assert.equal(steps[0].name, "受付");
    assert.equal(steps[0].done, true);
    assert.equal(steps[0].tab, "communications");
    assert.match(steps[0].detail, /依頼 2 件（LEGAL-9001・LEGAL-9002）/);
    assert.match(steps[0].detail, /更新あり 1 件/);
    assert.equal(steps[0].no, 1);
    assert.notEqual(currentStep(steps)?.name, "受付", "受付は済なので「いま」にならない");
  }
});

test("その他案件は元の「受付」の根拠を差し替えるだけ（二重に出さない）", () => {
  const steps = buildFlow(facts({ matterKind: "single", intake: { total: 1, unseen: 0, keys: ["REQ-2026-00001"] } }));
  assert.equal(steps.filter((s) => s.name === "受付").length, 1);
  assert.match(steps[0].detail, /REQ-2026-00001/);
});

test("受付箱を通っていない案件は、そう書く。渡されなければ従来どおり", () => {
  const none = buildFlow(facts({ intake: { total: 0, unseen: 0, keys: [] } }));
  assert.match(none[0].detail, /受付箱を通っていない/);
  assert.notEqual(buildFlow(facts())[0].name, "受付");
});
