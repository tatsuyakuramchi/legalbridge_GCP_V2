import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { buildPartyMap, planRemap, PartyAgreementMapService, type MapAgreement, type RemapCurrent } from "./party-map.js";

const party = { id: 5, name: "株式会社サンプル" };

function a(over: Partial<MapAgreement> & { id: number }): MapAgreement {
  return {
    agreementNo: `ARC-${over.id}`, title: "契約", kind: "master", domain: "license", direction: "out",
    status: "executed", parentId: null, executedOn: "2025-04-01", terminatedOn: null,
    counterparty: { id: 5, name: party.name, merged: false },
    parentResolvedPartyId: null, parentKind: null, conditionCount: 0, documentCount: 0,
    ...over
  };
}

test("基本契約の下に補助文書・解除合意がぶら下がり、文書だけは別に並ぶ", () => {
  const map = buildPartyMap(party, [
    a({ id: 1 }),
    a({ id: 2, kind: "supplement", parentId: 1, parentResolvedPartyId: 5, parentKind: "master" }),
    a({ id: 3, kind: "termination", parentId: 1, parentResolvedPartyId: 5, parentKind: "master" }),
    a({ id: 4, kind: "document", domain: null })
  ]);
  assert.equal(map.roots.length, 1);
  assert.deepEqual(map.roots[0].children.map((c) => c.id), [2, 3]);
  assert.deepEqual(map.documents.map((d) => d.id), [4]);
  assert.equal(map.issues.length, 0);
  assert.equal(map.roots[0].primary, true);
});

test("親の無い補助文書・別の取引先の親・基本契約でない親は木に入れず、ずれとして出す", () => {
  const map = buildPartyMap(party, [
    a({ id: 1 }),
    a({ id: 2, kind: "supplement" }),
    a({ id: 3, kind: "supplement", parentId: 99, parentResolvedPartyId: 8, parentKind: "master" }),
    a({ id: 4, kind: "supplement", parentId: 2, parentResolvedPartyId: 5, parentKind: "supplement" })
  ]);
  assert.deepEqual(map.loose.map((x) => x.id), [2, 3, 4]);
  assert.deepEqual(map.issues.map((i) => i.code), ["orphan", "parent_party_mismatch", "parent_not_master"]);
});

test("種別の無い基本契約・親を持つ基本契約はずれ", () => {
  const map = buildPartyMap(party, [
    a({ id: 1, domain: null }),
    a({ id: 2, parentId: 1, parentResolvedPartyId: 5, parentKind: "master" })
  ]);
  const codes = map.issues.map((i) => `${i.code}:${i.agreementId}`).sort();
  assert.deepEqual(codes, ["master_with_parent:2", "no_domain:1"]);
});

test("同じ種別・方向の生きた基本契約が2本あれば、新しい方を既定にして古い方をずれに出す", () => {
  const map = buildPartyMap(party, [
    a({ id: 1, executedOn: "2020-04-01" }),
    a({ id: 2, executedOn: "2024-04-01" }),
    // 解除済みと別方向は数えない
    a({ id: 3, executedOn: "2025-01-01", terminatedOn: "2025-06-30" }),
    a({ id: 4, direction: "in" })
  ]);
  const primary = map.roots.filter((r) => r.primary).map((r) => r.id).sort();
  assert.deepEqual(primary, [2, 4]);
  assert.deepEqual(map.issues.map((i) => `${i.code}:${i.agreementId}`), ["duplicate_master:1"]);
});

test("生きた基本契約が無ければ単体契約を既定にする。未締結は既定にしない", () => {
  const map = buildPartyMap(party, [
    a({ id: 1, status: "negotiating" }),
    a({ id: 2, kind: "standalone" })
  ]);
  assert.deepEqual(map.roots.filter((r) => r.primary).map((r) => r.id), [2]);
});

const current: RemapCurrent = {
  id: 10, kind: "supplement", domain: "license", direction: "out", parentId: null,
  counterpartyId: 5, resolvedPartyId: 5, childCount: 0
};

test("付け替え：親の無い補助文書に、同じ取引先の基本契約を親として付ける", () => {
  const next = planRemap(current, { parentId: 1 }, { id: 1, kind: "master", resolvedPartyId: 5 }, 5);
  assert.equal(next.parentId, 1);
  assert.equal(next.kind, "supplement");
});

test("付け替え：基本契約に変えると親は外れ、種別が要る", () => {
  assert.throws(() => planRemap({ ...current, domain: null }, { kind: "master" }, null, 5), /種別/);
  const next = planRemap({ ...current, parentId: 1 }, { kind: "master", domain: "service" }, null, 5);
  assert.equal(next.parentId, null);
  assert.equal(next.domain, "service");
});

test("付け替え：通らない形を断る", () => {
  assert.throws(() => planRemap(current, {}, null, 5), /親の契約を選んで/);
  assert.throws(() => planRemap(current, { parentId: 10 }, null, 5), /自分自身/);
  assert.throws(() => planRemap(current, { parentId: 1 }, { id: 1, kind: "supplement", resolvedPartyId: 5 }, 5),
                /基本契約か単体契約だけ/);
  assert.throws(() => planRemap(current, { parentId: 1 }, { id: 1, kind: "master", resolvedPartyId: 8 }, 5),
                /相手先が違います/);
  const root: RemapCurrent = { ...current, kind: "master", childCount: 2 };
  assert.throws(() => planRemap(root, { kind: "document" }, null, 5), /ぶら下がっています/);
  assert.throws(() => planRemap(root, { counterpartyId: 8 }, null, 8), /相手先は変えられません/);
});

test("取引先のマップは統合先で引き、件数の上限を付けない", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT resolved_id, resolved_name FROM v_party_resolved")) return [{ resolved_id: 5, resolved_name: "株式会社サンプル" }];
    if (t.includes("FROM agreements a")) return [
      { id: 1, agreement_no: "ARC-LIC-2025-0001", title: "基本", kind: null, domain: "license", direction: "out",
        status: "executed", parent_id: null, counterparty_id: 3, party_name: "旧サンプル", party_merged: true }
    ];
    return [];
  });
  const map = await new PartyAgreementMapService(db).forParty(3);
  assert.equal(map?.party.id, 5);
  assert.equal(map?.roots[0].kind, "master", "kind が空の移行行は基本契約とみなす");
  assert.equal(map?.roots[0].counterparty.merged, true);
  const q = db.find("WHERE r.resolved_id = $1")!;
  assert.deepEqual(q.params, [5]);
  assert.ok(!q.text.includes("LIMIT"));
});

test("付け替えは agreements の列を書き、前後を監査に残す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF a")) return [{ id: 10, kind: "supplement", domain: "license", direction: "out",
                                               parent_id: null, counterparty_id: 5, resolved_id: 5, child_count: 0 }];
    if (t.includes("SELECT a.id, a.kind, r.resolved_id")) return [{ id: 1, kind: "master", resolved_id: 5 }];
    return [];
  });
  await new PartyAgreementMapService(db).remap(10, { parentId: 1 }, "legal@example.test");
  const up = db.find("UPDATE agreements")!;
  assert.deepEqual(up.params, [10, "supplement", "license", "out", 1, 5]);
  assert.ok(db.queries.some((q) => q.params.includes("agreement.remap")));
});
