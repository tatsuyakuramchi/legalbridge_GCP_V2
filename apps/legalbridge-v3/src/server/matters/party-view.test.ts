import test from "node:test";
import assert from "node:assert/strict";
import { filterByParty, partiesOf } from "./party-view.js";
import type { MatterDetail } from "../core/model.js";

const party = (id: number, name: string) => ({ id, name, kind: "corporate" as const });
const cond = (id: number, p: { id: number; name: string } | null) =>
  ({ id, conditionNo: `CL-${id}`, name: `条件${id}`, kind: "license", direction: "out",
     status: "active", currency: "JPY", pricingModel: "revenue_rate",
     counterparty: p } as unknown as MatterDetail["conditions"][number]);
const doc = (id: number, partyId: number | null, name: string | null) =>
  ({ id, documentNo: `D-${id}`, status: "issued", templateLabel: null, templateKey: null,
     counterparty: name, counterpartyId: partyId, issuedAt: null,
     sentAt: null, sentVia: null, agreementStatus: null }) as MatterDetail["documents"][number];
const pay = (id: number, partyId: number | null, name: string | null) =>
  ({ id, paymentNo: `PY-${id}`, direction: "out" as const, amount: 1000, currency: "JPY",
     dueOn: null, status: "planned", basisReceivedOn: null, paidOn: null, note: null,
     counterpartyId: partyId, counterparty: name }) as MatterDetail["payments"][number];

const detail = {
  id: 1, matterNo: "MTR-1", title: "企画", kind: "work", status: "open",
  conditions: [cond(1, party(10, "あ社")), cond(2, party(10, "あ社")), cond(3, party(20, "い社")), cond(4, null)],
  documents: [doc(1, 10, "あ社"), doc(2, 20, "い社"), doc(3, null, null)],
  payments: [pay(1, 20, "い社"), pay(2, null, null)],
  communications: [], links: [], tasks: []
} as unknown as MatterDetail;

test("取引先は条件・文書・支払のどれからでも拾い、件数を添える", () => {
  const list = partiesOf(detail);
  assert.deepEqual(list.map((p) => p.name), ["あ社", "い社"]);
  assert.deepEqual(list[0], { id: 10, name: "あ社", conditions: 2, documents: 1, payments: 0 });
  assert.deepEqual(list[1], { id: 20, name: "い社", conditions: 1, documents: 1, payments: 1 });
});

test("条件の多い社が先に来る（並びが毎回変わらない）", () => {
  const same = partiesOf(detail).map((p) => p.id);
  assert.deepEqual(partiesOf(detail).map((p) => p.id), same);
  assert.equal(same[0], 10);
});

test("絞り込むと、その社の条件・文書・支払だけになる", () => {
  const only = filterByParty(detail, 20);
  assert.deepEqual(only.conditions.map((c) => c.id), [3]);
  assert.deepEqual(only.documents.map((d) => d.id), [2]);
  assert.deepEqual(only.payments.map((p) => p.id), [1]);
  // 元は動かさない（同じ detail を別の社で絞り直せる）。
  assert.equal(detail.conditions.length, 4);
  // 案件そのものの情報は残す。
  assert.equal(only.matterNo, "MTR-1");
});

test("相手先の分からない行は、絞ったときに出さない", () => {
  // 残すと「この社のぶん」として読まれ、絞り込んだ意味がなくなる。
  const only = filterByParty(detail, 10);
  assert.ok(!only.conditions.some((c) => !c.counterparty));
  assert.ok(!only.documents.some((d) => d.counterpartyId === null));
  assert.ok(!only.payments.some((p) => p.counterpartyId === null));
});

test("絞り込みなし（null）は元のまま返す", () => {
  assert.equal(filterByParty(detail, null), detail);
});
