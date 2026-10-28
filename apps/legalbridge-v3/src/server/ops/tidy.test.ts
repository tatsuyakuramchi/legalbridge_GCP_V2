import test from "node:test";
import assert from "node:assert/strict";
import { allMarks, buildTidy, marksOnly, type TidyConditionRow, type TidyInput } from "./tidy.js";
import type { MapAgreement, MapNode, PartyMap } from "../agreements/party-map.js";

const agreement = (id: number, over: Partial<MapAgreement> = {}): MapAgreement => ({
  id, agreementNo: `ARC-${id}`, title: `契約${id}`, kind: "master", domain: "license", direction: "in",
  status: "executed", parentId: null, executedOn: "2026-10-08", terminatedOn: null, orderDocumentId: null,
  counterparty: { id: 1, name: "脇屋", merged: false }, parentResolvedPartyId: null, parentKind: null,
  conditionCount: 0, documentCount: 0, ...over
});
const root = (id: number, over: Partial<MapNode> = {}): MapNode => ({ ...agreement(id), children: [], primary: true, ...over });

const emptyMap = (over: Partial<PartyMap> = {}): PartyMap => ({
  party: { id: 1, name: "脇屋" }, roots: [], loose: [], documents: [], issues: [], unlinked: [], looseConditions: [], orders: [], ...over
});

const cond = (id: number, over: Partial<TidyConditionRow> = {}): TidyConditionRow => ({
  id, conditionNo: `CL-${id}`, name: `条件${id}`, kind: "license", direction: "in", status: "active", usageType: "pub_digital",
  pricingModel: "revenue_rate", ratePpm: 150000, flatAmount: null,
  workId: 10, workTitle: "作品A", agreementId: null, termStart: "2026-01-01", termEnd: null, autoRenew: false,
  holderDocumentId: null, shares: 0, shared: false, counterpartyName: null, ...over
});

const input = (over: Partial<TidyInput> = {}): TidyInput => ({
  party: { id: 1, name: "脇屋", kind: "individual", email: null }, members: [1],
  map: emptyMap(), conditions: [], events: [], statements: [], payments: [],
  mergeCandidates: [], termTargets: [], noticeTargets: [], noticeHolders: [], statementGroups: [],
  relatedDocuments: [], successions: [], ...over
});

test("型 1：基本契約の下に個別契約、その下に条件・実績・計算書・支払が並ぶ", () => {
  const map = emptyMap({ roots: [root(100, { children: [agreement(101, { kind: "supplement", parentId: 100 })] })] });
  const tree = buildTidy(input({
    map, conditions: [cond(5, { agreementId: 101 })],
    events: [{ conditionId: 5, total: 8, first: "2025-08-01", last: "2026-06-30", unallocated: 2, gap: 0 }],
    statements: [{ documentId: 50, documentNo: "ARC-ROY-1", status: "issued", issuedOn: "2026-07-01", period: "2026上", conditionId: 5, payeePartyId: null, netAmount: 1000 }],
    payments: [{ id: 70, paymentNo: "PAY-1", status: "planned", dueOn: "2026-08-31", paidOn: null, amount: 1000, currency: "JPY", conditionIds: [5] }]
  }));
  const deal = tree.roots.find((n) => n.level === "deal")!;
  assert.equal(deal.code, "ARC-100");
  const order = deal.children[0]!;
  assert.equal(order.level, "order");
  const c = order.children[0]!;
  assert.equal(c.level, "condition");
  assert.deepEqual(c.children.map((n) => n.level), ["events", "statement", "payment"]);
  assert.equal(c.children[0]!.detail, "2025/8〜2026/6");
  assert.equal(tree.total, 0);
  assert.ok(tree.roots.every((n) => n.ok));
});

test("型 2：独立契約は条件を直接持つ。基本契約の無い発注書も 1 取引", () => {
  const map = emptyMap({
    roots: [root(200, { kind: "standalone" })],
    orders: [{ id: 300, documentNo: "PO-1", title: "発注書", status: "issued", issuedOn: null, imported: false, masterId: null, agreementId: null,
               conditions: [{ id: 7, conditionNo: "CL-7", name: "条件7" }] }]
  });
  const tree = buildTidy(input({ map, conditions: [cond(6, { agreementId: 200 }), cond(7, { holderDocumentId: 300, workId: 11 })] }));
  const deals = tree.roots.filter((n) => n.level === "deal");
  assert.deepEqual(deals.map((d) => d.code), ["ARC-200", "PO-1"]);
  assert.equal(deals[0]!.children[0]!.id, 6);
  assert.equal(deals[1]!.children[0]!.id, 7);
  assert.match(deals[1]!.detail ?? "", /独立契約（発注書の約款）/);
  assert.equal(tree.total, 0);
});

test("契約に載っていない条件は「欠け」。載せ先は個別契約・単体契約だけ（基本契約は持たない）", () => {
  const map = emptyMap({ roots: [root(100, { children: [agreement(101, { kind: "supplement", parentId: 100 })] })] });
  const tree = buildTidy(input({ map, conditions: [cond(5)] }));
  const g = tree.roots.find((n) => n.key === "g-stray")!;
  const mark = g.children[0]!.marks[0]!;
  assert.equal(mark.kind, "missing");
  assert.equal(mark.fix?.action, "link_condition");
  assert.deepEqual((mark.fix as any).targets.map((t: any) => t.id), [101]);
  assert.equal(tree.counts.missing, 1);
});

test("基本契約に直接載っている条件は、基本契約の下に出して「欠け」を付ける", () => {
  const map = emptyMap({ roots: [root(100)], issues: [{ code: "master_holds_conditions", agreementId: 100, message: "基本契約に条件" }] });
  const tree = buildTidy(input({ map, conditions: [cond(5, { agreementId: 100 })] }));
  const deal = tree.roots.find((n) => n.level === "deal")!;
  assert.equal(deal.marks[0]!.kind, "missing");
  assert.equal(deal.children[0]!.marks[0]!.fix?.action, "link_condition");
  assert.equal(tree.counts.missing, 2);
});

test("同じ名前の取引先が 2 件なら取引先の節に「多重」。許諾期間が空なら条件に「空」", () => {
  const tree = buildTidy(input({
    map: emptyMap({ roots: [root(200, { kind: "standalone" })] }),
    conditions: [cond(5, { agreementId: 200 })],
    mergeCandidates: [{ keyName: "脇屋", parties: [
      { id: 1, partyCode: null, name: "脇屋", kind: "individual", status: "active", invoiceNo: null, corporateNo: null, conditions: 3, payments: 1, agreements: 1, matters: 0 },
      { id: 2, partyCode: null, name: "脇屋", kind: "individual", status: "active", invoiceNo: null, corporateNo: null, conditions: 0, payments: 0, agreements: 0, matters: 0 }
    ] }],
    termTargets: [{ conditionId: 5, conditionNo: "CL-5", conditionName: "条件5", partyId: 1, partyName: "脇屋", workTitle: "作品A",
                    documentNos: [], termStart: "2026-01-01", newTermEnd: "2028-12-31", label: null, skip: null }]
  }));
  const party = tree.roots[0]!;
  assert.equal(party.marks[0]!.kind, "dup");
  assert.equal(party.marks[0]!.fix?.action, "merge_party");
  const c = tree.roots[1]!.children[0]!;
  assert.equal(c.marks[0]!.kind, "blank");
  assert.deepEqual(c.marks[0]!.fix, { action: "fill_term", conditionIds: [5], newTermEnd: "2028-12-31", label: null });
  assert.deepEqual(tree.counts, { dup: 1, unregistered: 0, missing: 0, blank: 1 });
});

test("同じ作品・同じ種類で期間の重なる有効な条件が 2 本なら「多重」。自動更新は終わりが無い扱い", () => {
  const map = emptyMap({ roots: [root(200, { kind: "standalone" })] });
  const tree = buildTidy(input({ map, conditions: [
    cond(5, { agreementId: 200, termStart: "2024-01-01", termEnd: "2026-12-31", autoRenew: true }),
    cond(6, { agreementId: 200, termStart: "2027-01-01", termEnd: null }),
    cond(7, { agreementId: 200, usageType: "pub_print" }),
    cond(8, { agreementId: 200, ratePpm: 100000 })
  ] }));
  const [a, b, c, d] = tree.roots[1]!.children;
  assert.equal(a!.marks[0]?.kind, "dup");
  assert.equal(b!.marks[0]?.kind, "dup");
  assert.equal(c!.marks.length, 0);
  assert.equal(d!.marks.length, 0, "率が違えば別の条件");
});

test("型 3：受取人としての条件は別の枝に出し、自分宛ての計算書だけを見る。多重には数えない", () => {
  const tree = buildTidy(input({
    members: [1],
    conditions: [cond(5, { shared: true, counterpartyName: "麻生", shares: 2 })],
    statements: [
      { documentId: 50, documentNo: "ARC-ROY-1", status: "issued", issuedOn: null, period: "2026上", conditionId: 5, payeePartyId: null, netAmount: 8000 },
      { documentId: 51, documentNo: "ARC-ROY-2", status: "issued", issuedOn: null, period: "2026上", conditionId: 5, payeePartyId: 1, netAmount: 2000 }
    ],
    payments: [{ id: 70, paymentNo: "PAY-1", status: "planned", dueOn: null, paidOn: null, amount: 2000, currency: "JPY", conditionIds: [5] }]
  }));
  const g = tree.roots.find((n) => n.key === "g-shared")!;
  assert.equal(g.shared, true);
  const c = g.children[0]!;
  assert.equal(c.shared, true);
  assert.match(c.detail ?? "", /相手方 麻生/);
  assert.deepEqual(c.children.filter((n) => n.level === "statement").map((n) => n.id), [51]);
  assert.equal(tree.counts.dup, 0);
});

test("本人分と受取人分の計算書が分かれていれば「多重」、決定済みで支払が無ければ「欠け」", () => {
  const group = { key: "1|2026上|JPY", partyId: 1, partyName: "脇屋", periodLabel: "2026上", currency: "JPY",
                  documents: [{ id: 50, documentNo: "ARC-ROY-1", payee: false, netAmount: 1, issuedOn: null }],
                  netAmount: 1, payments: [], status: "ready" as const, message: null };
  const tree = buildTidy(input({
    map: emptyMap({ roots: [root(200, { kind: "standalone" })] }),
    conditions: [cond(5, { agreementId: 200 })],
    statements: [{ documentId: 50, documentNo: "ARC-ROY-1", status: "issued", issuedOn: null, period: "2026上", conditionId: 5, payeePartyId: null, netAmount: 1 }],
    statementGroups: [group]
  }));
  const s = tree.roots[1]!.children[0]!.children[0]!;
  assert.deepEqual(s.marks.map((m) => m.kind), ["dup", "missing"]);
  assert.equal(s.marks[0]!.fix?.action, "merge_statements");
});

test("割り当て済みより前の実績が割り当たっていなければ、実績の節に「欠け」", () => {
  const tree = buildTidy(input({
    map: emptyMap({ roots: [root(200, { kind: "standalone" })] }),
    conditions: [cond(5, { agreementId: 200 })],
    events: [{ conditionId: 5, total: 16, first: "2025-01-01", last: "2026-06-30", unallocated: 3, gap: 2 }]
  }));
  const e = tree.roots[1]!.children[0]!.children[0]!;
  assert.equal(e.level, "events");
  assert.match(e.marks[0]!.message, /2 件/);
});

test("契約に繋がっていない基本契約書・条件書は「未登録」で、番号のまま契約を立てる", () => {
  const tree = buildTidy(input({ map: emptyMap({ unlinked: [
    { id: 90, documentNo: "ATT-2024-0112", label: "条件書", title: null, status: "issued", issuedOn: null, role: "terms", conditionCount: 1 },
    { id: 91, documentNo: "NDA-1", label: "NDA", title: null, status: "issued", issuedOn: null, role: null, conditionCount: 0 }
  ] }) }));
  const g = tree.roots.find((n) => n.key === "g-unlinked")!;
  assert.deepEqual(g.children.map((n) => n.marks[0]!.fix?.action), ["register_document", "open"]);
  assert.equal(tree.counts.unregistered, 2);
});

test("通知先の空いた契約書の印は、その文書が付いている契約の節に付く", () => {
  const map = emptyMap({ roots: [root(100, { children: [agreement(101, { kind: "supplement", parentId: 100 })] })] });
  const tree = buildTidy(input({
    map, conditions: [cond(5, { agreementId: 101 })],
    noticeTargets: [{ documentId: 40, documentNo: "ARC-PUBT-1", kind: "terms", partyId: 1, partyName: "脇屋", issuedOn: null,
                      fills: [{ field: "許諾者連絡先", label: "甲", value: "脇屋 / a@b" }], skip: null, reuseDraftId: null, patch: {} }],
    noticeHolders: [{ documentId: 40, agreementId: 101, conditionIds: [5] }]
  }));
  const order = tree.roots[1]!.children[0]!;
  assert.equal(order.marks[0]!.kind, "blank");
  assert.equal(order.marks[0]!.fix?.action, "fill_notice");
});

test("親の無い個別契約は「欠け」で、基本契約の下に繋ぐ", () => {
  const map = emptyMap({ roots: [root(100)], loose: [agreement(150, { kind: "supplement", parentId: null })],
                         issues: [{ code: "orphan", agreementId: 150, message: "親が無い" }] });
  const tree = buildTidy(input({ map }));
  const g = tree.roots.find((n) => n.key === "g-loose")!;
  const m = g.children[0]!.marks[0]!;
  assert.equal(m.fix?.action, "set_parent");
  assert.deepEqual((m.fix as any).targets.map((t: any) => t.id), [100]);
});

test("「直すところだけ」は印の無い枝を落とす。印は木の順に並ぶ", () => {
  const map = emptyMap({ roots: [root(200, { kind: "standalone" }), root(201, { kind: "standalone" })] });
  const tree = buildTidy(input({ map, conditions: [cond(5, { agreementId: 200 }), cond(6, { agreementId: 201, workId: 11 })],
    termTargets: [{ conditionId: 6, conditionNo: "CL-6", conditionName: "条件6", partyId: 1, partyName: "脇屋", workTitle: null,
                    documentNos: [], termStart: "2026-01-01", newTermEnd: "2028-12-31", label: null, skip: null }] }));
  const only = marksOnly(tree.roots);
  assert.deepEqual(only.map((n) => n.code), ["ARC-201"]);
  assert.deepEqual(allMarks(tree.roots).map((x) => x.mark.id), ["term:6"]);
});

test("型 3：関係当事者として載っている文書は別の枝に 1 件として出る。承継は取引の説明と、譲渡人の木の足跡", () => {
  const sc = { id: 1, agreementId: 100, agreementNo: "ARC-100", agreementTitle: "契約100", from: { id: 1, name: "脇屋" }, to: { id: 9, name: "新社" },
               effectiveOn: "2026-11-01", documentId: 77, documentNo: "ARC-ASG-1", note: null, appliedAt: null, revertedAt: null, state: "pending" as const };
  const pending = buildTidy(input({ map: emptyMap({ roots: [root(100)] }), successions: [sc],
    relatedDocuments: [{ documentId: 77, documentNo: "ARC-ASG-1", title: "承継合意書", status: "issued", issuedOn: null, role: "assignor", note: null, counterpartyName: "新社" }] }));
  assert.match(pending.roots[1]!.detail ?? "", /承継予定 → 新社（2026-11-01 から）/);
  const g = pending.roots.find((n) => n.key === "g-related")!;
  assert.equal(g.children[0]!.shared, true);
  assert.match(g.children[0]!.detail ?? "", /譲渡人・相手方 新社/);
  assert.equal(pending.total, 0);

  const applied = buildTidy(input({ map: emptyMap(), successions: [{ ...sc, appliedAt: "2026-11-01T00:00:00Z", state: "applied" }] }));
  const moved = applied.roots.find((n) => n.key === "g-succession")!;
  assert.equal(moved.children[0]!.code, "ARC-100");
  assert.match(moved.children[0]!.detail ?? "", /→ 新社（2026-11-01 から）・根拠 ARC-ASG-1/);
});
