import test from "node:test";
import assert from "node:assert/strict";
import { findIssues, type GraphCondition, type GraphDocument, type GraphEvent } from "./graph-service.js";

const cond = (over: Partial<GraphCondition>): GraphCondition => ({
  id: 1, conditionNo: "CL-1", name: "委託", kind: "service", status: "active", series: 1, supersededById: null,
  effectiveFrom: null, currency: "JPY", flatAmount: 1000, linkedToMatter: true, closedAt: null, ...over
});
const doc = (over: Partial<GraphDocument>): GraphDocument => ({
  id: 10, documentNo: "ARC-PO-1", status: "issued", templateKey: "purchase_order", templateLabel: "発注書",
  issuedAt: "2026-09-01", matterId: 1, supersedesId: null, conditionIds: [1], eventIds: [], draftEventIds: [], ...over
});
const ev = (over: Partial<GraphEvent>): GraphEvent => ({
  id: 100, conditionId: 1, eventType: "inspection", occurredOn: "2026-09-13", amount: 1000, status: "active",
  documentId: null, documentNo: null, documentStatus: null, followUp: null, varianceNote: null, ...over
});
const base = { matter: { id: 1, matterNo: "MTR-1", title: "t", kind: "outsourcing" }, payments: [] };

test("ねじれを名指しで出す：無効文書に付いた実績・下書きの旧版・案件外の条件・発注書の無い検収書・同じ実績の下書き", () => {
  const conditions = [
    cond({ id: 997, conditionNo: "CL-447", status: "superseded", series: 997, supersededById: 998, linkedToMatter: false }),
    cond({ id: 998, conditionNo: "CL-447-R2", series: 997 }),
    cond({ id: 996, conditionNo: "CL-446", series: 996 }),
    cond({ id: 500, conditionNo: "CL-500", series: 500, linkedToMatter: false })
  ];
  const events = [
    ev({ id: 168, conditionId: 997, documentId: 1589, documentNo: "ARC-INS-1005", documentStatus: "void" }),
    ev({ id: 169, conditionId: 996, documentId: 1589, documentNo: "ARC-INS-1005", documentStatus: "void" })
  ];
  const documents = [
    doc({ id: 217, documentNo: "ARC-PO-0121", conditionIds: [997, 996] }),
    doc({ id: 1589, documentNo: "ARC-INS-1005", status: "void", templateKey: "inspection_certificate", conditionIds: [997, 996], eventIds: [168, 169] }),
    doc({ id: 1594, documentNo: null, status: "draft", templateKey: "inspection_certificate", conditionIds: [997, 996], draftEventIds: [168, 169] }),
    doc({ id: 1595, documentNo: null, status: "draft", templateKey: "inspection_certificate", conditionIds: [998], draftEventIds: [168] }),
    doc({ id: 1600, documentNo: null, status: "draft", templateKey: "inspection_certificate", conditionIds: [500], draftEventIds: [] })
  ];
  const issues = findIssues({ ...base, conditions, events, documents });
  const codes = issues.map((i) => i.code);
  assert.equal(codes.filter((c) => c === "event_on_dead_document").length, 2, "無効な検収書に付いたままの実績 2 件");
  assert.ok(issues.some((i) => i.code === "event_on_old_version" && i.eventId === 168 && i.currentConditionId === 998));
  // 決定済みの発注書に旧版が載っているのは記録なので出るが「そのままで構いません」、下書きは差し替えを促す
  const old = issues.filter((i) => i.code === "document_has_old_version");
  assert.ok(old.some((i) => i.documentId === 217 && /そのままで構いません/.test(i.message)));
  assert.ok(old.some((i) => i.documentId === 1594 && /差し替えられます/.test(i.message) && i.currentConditionId === 998));
  assert.ok(issues.some((i) => i.code === "document_condition_not_in_matter" && i.documentId === 1600 && i.conditionId === 500));
  assert.ok(issues.some((i) => i.code === "inspection_without_order" && i.documentId === 1600), "条件 500 には発注書が無い");
  assert.ok(!issues.some((i) => i.code === "inspection_without_order" && i.documentId === 1594), "997/996 には発注書 217 がある（系列で見る）");
  assert.ok(issues.some((i) => i.code === "drafts_share_events" && /#168/.test(i.message)));
  assert.ok(!issues.some((i) => i.code === "old_version_linked_to_matter"), "旧版は案件に紐づいていない");
});

test("整っていれば何も出ない", () => {
  const issues = findIssues({ ...base,
    conditions: [cond({})],
    events: [ev({ documentId: 11, documentNo: "ARC-INS-1", documentStatus: "issued" })],
    documents: [doc({}), doc({ id: 11, documentNo: "ARC-INS-1", templateKey: "inspection_certificate", eventIds: [100] })]
  });
  assert.deepEqual(issues, []);
});
