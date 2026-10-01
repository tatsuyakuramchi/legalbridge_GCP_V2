import test from "node:test";
import assert from "node:assert/strict";
import { buildRounds, settleRound, timingOf, type LedgerCondition, type LedgerEvent, type Round } from "./ledger-service.js";

const cond = (id: number, over: Partial<LedgerCondition> = {}): LedgerCondition => ({
  id, conditionNo: null, name: `c${id}`, usageType: "in_house", usageLabel: "", workId: 1, workTitle: "ito",
  agreementId: null, agreementNo: null, pricingModel: "revenue_rate", ratePpm: 80000, unitAmount: null,
  mgAmount: null, agAmount: null, currency: "JPY", paymentTerms: "締め月の翌月末払い",
  timing: "periodic", timingExplicit: false, schedules: 0, ...over
});
const ev = (id: number, conditionId: number, on: string, over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id, conditionId, scheduleId: null, eventType: "sales", occurredOn: on, period: null, usageType: "in_house",
  outConditionId: null, outName: null, workId: null, workTitle: null, quantity: null, unitAmount: null,
  grossAmount: 100, amount: 100, documentId: null, ...over
});
const Q = (conditionId: number, base = 0) => [
  { id: base + 1, conditionId, seq: 1, dueOn: "2026-06-30", payOn: "2026-07-31", label: "4〜6月" },
  { id: base + 2, conditionId, seq: 2, dueOn: "2026-09-30", payOn: "2026-10-31", label: "7〜9月" }
];

test("出し方の既定は、紙出版がイベント式、それ以外は時限式。明示があればそれ", () => {
  assert.equal(timingOf(null, "pub_print"), "event");
  assert.equal(timingOf(null, "in_house"), "periodic");
  assert.equal(timingOf("event", "in_house"), "event");
});

test("締めがずれた契約も、支払日が同じなら1つの回にまとまる（作家でまとめる）", () => {
  const rounds = buildRounds({
    conditions: [cond(1), cond(2, { workId: 2 })],
    schedules: [...Q(1), { id: 9, conditionId: 2, seq: 1, dueOn: "2026-08-31", payOn: "2026-10-31", label: "6〜8月" }],
    events: [ev(1, 1, "2026-09-10"), ev(2, 2, "2026-08-20")], skips: [], outs: [],
    bundle: "per_party", today: "2026-10-05"
  });
  const oct = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(oct.parts.map((p) => p.conditionId).sort(), [1, 2]);
  assert.deepEqual(oct.workIds.sort(), [1, 2]);
  // 作品ごとなら別の回
  const per = buildRounds({
    conditions: [cond(1), cond(2, { workId: 2 })],
    schedules: [...Q(1), { id: 9, conditionId: 2, seq: 1, dueOn: "2026-08-31", payOn: "2026-10-31", label: "6〜8月" }],
    events: [ev(1, 1, "2026-09-10"), ev(2, 2, "2026-08-20")], skips: [], outs: [],
    bundle: "per_work", today: "2026-10-05"
  });
  assert.equal(per.filter((r) => r.payOn === "2026-10-31").length, 2);
});

test("イベント式は実績1件が1回。支払日は支払条件から", () => {
  const rounds = buildRounds({
    conditions: [cond(1, { timing: "event", usageType: "pub_print" })], schedules: [],
    events: [ev(5, 1, "2026-08-20", { eventType: "manufacturing" })], skips: [], outs: [],
    bundle: "per_party", today: "2026-10-05"
  });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].kind, "event");
  assert.equal(rounds[0].payOn, "2026-09-30");
});

test("来るはずの行：言語・地域が1つでも行に持つ（英語×フランス・フランス語×フランス）", () => {
  const out = { id: 63, name: "ホラー｜フランス語・英語｜フランス｜DPG", usageType: "sublicense", workId: 1,
                termStart: null, languages: ["フランス語", "英語"], regions: ["フランス"] };
  const q = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1), events: [], skips: [], outs: [out],
    bundle: "single_work", today: "2026-10-05"
  }).find((r) => r.payOn === "2026-07-31")!;
  assert.deepEqual(q.parts[0].expected.map((x) => `${x.languages?.join("")}×${x.regions?.join("")}`).sort(),
    ["フランス語×フランス", "英語×フランス"]);
});

test("来るはずの行：前の回の地域なしの行は許諾先の地域で埋め、地域なしの報告はその組を覆う", () => {
  const out = { id: 64, name: "ito｜英語・フランス語｜欧州｜Alpha", usageType: "sublicense", workId: 1,
                termStart: null, languages: ["英語", "フランス語"], regions: ["欧州"] };
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    // 前の回：地域なしの英語の報告（A-061 より前の形）
    events: [ev(1, 1, "2026-06-10", { usageType: "sublicense", outConditionId: 64, outName: out.name, languages: ["英語"] })],
    skips: [], outs: [out], bundle: "single_work", today: "2026-10-05"
  });
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  assert.deepEqual(q2.parts[0].expected.map((x) => `${x.languages?.join("")}×${x.regions?.join("")}`),
    ["フランス語×欧州"], "地域なしの英語の報告が 英語×欧州 を覆う");
  const q3 = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(q3.parts[0].expected.map((x) => `${x.languages?.join("")}×${x.regions?.join("")}`).sort(),
    ["フランス語×欧州", "英語×欧州"], "前の回から来た英語の行は 欧州 で埋まり、行は2本だけ");
});

test("来るはずの行：地域を複数持つ報告（地域まで分かれていない売上）は、その地域の行をまとめて覆う", () => {
  const out = { id: 66, name: "ito｜英語｜中国・韓国・台湾｜Asmodee", usageType: "oem", workId: 1,
                termStart: null, languages: ["英語"], regions: ["中国", "韓国", "台湾"] };
  const q = buildRounds({
    conditions: [cond(1, { usageType: "oem" })], schedules: Q(1),
    events: [ev(1, 1, "2026-06-10", { usageType: "oem", outConditionId: 66, outName: out.name,
                                       languages: ["英語"], regions: ["中国", "韓国"] })],
    skips: [], outs: [out], bundle: "single_work", today: "2026-10-05"
  }).find((r) => r.payOn === "2026-07-31")!;
  assert.deepEqual(q.parts[0].expected.map((x) => `${x.languages?.join("")}×${x.regions?.join("")}`),
    ["英語×台湾"], "中国・韓国の行は 1 本の報告で入力済になり、台湾だけ待つ");
});

test("来るはずの行：途中で許諾言語・地域を変えたら、前の回から来た古い行は落とし、いまの範囲で待つ", () => {
  // 前の回：英語×北米で報告があった。その後、許諾先を フランス語×フランス だけに変えた。
  const out = { id: 65, name: "ホラー｜フランス語｜フランス｜DPG", usageType: "sublicense", workId: 1,
                termStart: null, languages: ["フランス語"], regions: ["フランス"], seriesIds: [65, 60] };
  const q3 = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    // 古い版（id 60）を指す報告でも、同じ許諾先として扱う。
    events: [ev(1, 1, "2026-06-10", { usageType: "sublicense", outConditionId: 60, outName: "旧", languages: ["英語"], regions: ["北米"] })],
    skips: [], outs: [out], bundle: "single_work", today: "2026-10-05"
  }).find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(q3.parts[0].expected.map((x) => [x.outConditionId, x.languages?.join(""), x.regions?.join("")]),
    [[65, "フランス語", "フランス"]], "英語×北米の古い行は残らず、フランス語×フランス を待つ");
});

test("許諾先専用の IN 条件（A-063）はその許諾先の行だけ。一律の条件からはその許諾先が外れる", () => {
  const alpha = { id: 70, name: "ito｜英語｜北米｜Alpha", usageType: "sublicense", workId: 1, termStart: null, languages: ["英語"], regions: [], partyId: 501 };
  const beta = { id: 71, name: "ito｜韓国語｜韓国｜Beta", usageType: "sublicense", workId: 1, termStart: null, languages: ["韓国語"], regions: [], partyId: 502 };
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" }),                                  // 一律 50%
                 cond(2, { usageType: "sublicense", targetPartyId: 501, targetPartyName: "Alpha" })], // Alpha 専用
    schedules: [...Q(1), ...Q(2, 10)], events: [], skips: [], outs: [alpha, beta], bundle: "single_work", today: "2026-10-05"
  });
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  const byCond = (id: number) => q2.parts.find((p) => p.conditionId === id)!.expected.map((x) => x.outName);
  assert.deepEqual(byCond(2), ["ito｜英語｜北米｜Alpha"], "専用の条件には Alpha だけ");
  assert.deepEqual(byCond(1), ["ito｜韓国語｜韓国｜Beta"], "一律の条件からは Alpha が外れ、Beta だけ");
});

test("来るはずの行：言語×地域で1行（英語×北米・英語×欧州・フランス語×欧州）", () => {
  const out = { id: 61, name: "ito｜英語・フランス語｜北米・欧州｜Alpha", usageType: "sublicense", workId: 1,
                termStart: null, languages: ["英語", "フランス語"], regions: ["北米", "欧州"] };
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    events: [ev(1, 1, "2026-06-10", { usageType: "sublicense", outConditionId: 61, outName: out.name,
                                     languages: ["英語"], regions: ["北米"] })],
    skips: [], outs: [out], bundle: "single_work", today: "2026-10-05"
  });
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  const rest = q2.parts[0].expected.map((x) => `${x.languages?.join("")}×${x.regions?.join("")}`).sort();
  assert.deepEqual(rest, ["フランス語×北米", "フランス語×欧州", "英語×欧州"], "英語×北米は来た。残り3組");
});

test("来るはずの行：前の回にあった許諾先と、生きている許諾先", () => {
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    events: [ev(1, 1, "2026-06-10", { usageType: "sublicense", outConditionId: 50, outName: "Alpha" })],
    skips: [], outs: [{ id: 60, name: "Beta", usageType: "sublicense", workId: 1, termStart: "2026-07-01" }],
    bundle: "single_work", today: "2026-10-05"
  });
  const q3 = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(q3.parts[0].expected.map((x) => x.outName).sort(), ["Alpha", "Beta"]);
  assert.equal(q3.state, "input");
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  assert.deepEqual(q2.parts[0].expected.map((x) => x.outName), [], "Beta は 7月から");
});

test("空のまま過ぎた回は、人が報告なしにするまで報告待ち。締め前は before", () => {
  const rounds = buildRounds({
    conditions: [cond(1)], schedules: [...Q(1), { id: 3, conditionId: 1, seq: 3, dueOn: "2026-12-31", payOn: "2027-01-31", label: "10〜12月" }],
    events: [ev(1, 1, "2026-09-10")], skips: [], outs: [], bundle: "single_work", today: "2026-12-01"
  });
  assert.equal(rounds.find((r) => r.payOn === "2026-07-31")!.state, "input", "あとの回に実績があっても自動では閉じない");
  assert.equal(rounds.find((r) => r.payOn === "2026-07-31")!.parts[0].state, "waiting");
  assert.equal(rounds.find((r) => r.payOn === "2027-01-31")!.state, "before");
  const skipped = buildRounds({
    conditions: [cond(1)], schedules: Q(1), events: [], skips: [{ conditionId: 1, scheduleId: 2 }], outs: [],
    bundle: "single_work", today: "2026-10-05"
  });
  assert.equal(skipped.find((r) => r.payOn === "2026-10-31")!.state, "skipped");
  assert.equal(skipped.find((r) => r.payOn === "2026-07-31")!.state, "input", "報告待ち");
});

test("予定の行（A-062）：from_on 以降の回で来るはずとして待ち、数字が来れば消える", () => {
  const out = { id: 62, name: "ito｜韓国語｜韓国｜Beta", usageType: "sublicense", workId: 1, termStart: null, languages: ["韓国語"], regions: ["韓国"] };
  const plan = { id: 7, conditionId: 1, outConditionId: 62, outName: out.name, languages: ["韓国語"], regions: ["韓国"], fromOn: "2026-09-01" };
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    events: [], skips: [], outs: [], plans: [plan], bundle: "single_work", today: "2026-10-05"
  });
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  assert.equal(q2.parts[0].expected.filter((x) => x.planId).length, 0, "6/30 締めは from_on より前");
  const q3 = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(q3.parts[0].expected.map((x) => [x.planId, x.why]), [[7, "予定"]]);
  const got = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    events: [ev(9, 1, "2026-09-20", { usageType: "sublicense", outConditionId: 62, outName: out.name, languages: ["韓国語"], regions: ["韓国"] })],
    skips: [], outs: [], plans: [plan], bundle: "single_work", today: "2026-10-05"
  }).find((r) => r.payOn === "2026-10-31")!;
  assert.equal(got.parts[0].expected.length, 0, "数字が来たら予定の行は消える");
});

test("決まった回は、支払・送付・AG 充当だけ（支払なし）で閉じる", () => {
  const base: Round = { key: "p", kind: "period", payOn: null, closeOn: null, workIds: [], parts: [],
    documents: [{ id: 1, documentNo: "RS-1", status: "issued", sent: false, net: 100, paymentIds: [] }], payments: [],
    requests: [], state: "issued", open: true };
  assert.equal(settleRound(base).state, "issued");
  assert.equal(settleRound({ ...base, documents: [{ ...base.documents[0], sent: true }] }).state, "sent");
  assert.equal(settleRound({ ...base, documents: [{ ...base.documents[0], net: 0 }] }).open, false);
  const pay = { id: 1, paymentNo: null, status: "planned", amount: 1, dueOn: "2026-10-31", paidOn: null };
  assert.equal(settleRound({ ...base, payments: [pay] }).state, "scheduled");
  const paid = settleRound({ ...base, payments: [{ ...pay, status: "paid" }] });
  assert.equal(paid.state, "paid"); assert.equal(paid.open, false);
});

test("1本の許諾で英語・フランス語を出していれば、報告は言語ごとに1行で待つ（A-061）", () => {
  const out = { id: 60, name: "ito｜英語・フランス語｜欧州｜Alpha", usageType: "sublicense", workId: 1,
                termStart: null, languages: ["英語", "フランス語"] };
  const rounds = buildRounds({
    conditions: [cond(1, { usageType: "sublicense" })], schedules: Q(1),
    events: [ev(1, 1, "2026-06-10", { usageType: "sublicense", outConditionId: 60, outName: out.name, languages: ["英語"] })],
    skips: [], outs: [out], bundle: "single_work", today: "2026-10-05"
  });
  const q2 = rounds.find((r) => r.payOn === "2026-07-31")!;
  assert.deepEqual(q2.parts[0].expected.map((x) => x.languages), [["フランス語"]], "英語は来た、フランス語はまだ");
  const q3 = rounds.find((r) => r.payOn === "2026-10-31")!;
  assert.deepEqual(q3.parts[0].expected.map((x) => x.languages?.join("")).sort(), ["フランス語", "英語"]);
});
