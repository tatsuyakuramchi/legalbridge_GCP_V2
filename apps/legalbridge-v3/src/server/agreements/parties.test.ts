import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { AgreementPartyService, ordinalFor, partiesOf, roleOf } from "./parties.js";

/**
 * 契約の当事者（三社間契約。A-068）。
 * 主たる相手先は agreements.counterparty_id のまま、他の当事者だけを agreement_parties に持つ。
 */

test("当事者の列：主たる相手先が乙、他の当事者は順に丙・丁。主たる相手先と同じ id は畳む", () => {
  const list = partiesOf({ id: 9, name: "株式会社ほか" }, [
    { partyId: 5, name: "サンプル", role: "co_party", seq: 2, note: null, merged: false },
    { partyId: 9, name: "株式会社ほか", role: "co_party", seq: 3, note: null, merged: false },
    { partyId: 7, name: "窓口社", role: "agent", seq: 3, note: "代理店", merged: true }
  ]);
  assert.deepEqual(list.map((p) => `${p.ordinal}:${p.partyId}:${p.roleLabel}`),
    ["乙:9:主たる相手先", "丙:5:共同当事者", "丁:7:窓口・代理"]);
  assert.equal(list[2].merged, true);
  assert.equal(ordinalFor(1), "乙");
  assert.equal(ordinalFor(4), "戊");
});

test("立場は決まった値だけ。空なら共同当事者", () => {
  assert.equal(roleOf(null), "co_party");
  assert.equal(roleOf("guarantor"), "guarantor");
  assert.throws(() => roleOf("boss"), /立場が読めません/);
});

function db(extras: Array<{ party_id: number; resolved_id: number; role: string; seq: number }> = [],
            resolvedOf: Record<number, number> = {}) {
  return new FakeDatabase((t, params) => {
    if (t.includes("FOR UPDATE OF a")) return [{ id: 1, agreement_no: "ARC-LIC-2026-0001", counterparty_id: 9, resolved_id: 9 }];
    if (t.includes("FROM agreement_parties ap JOIN v_party_resolved r")) return extras.map((e) => ({ ...e, note: null }));
    if (t.includes("SELECT resolved_id FROM v_party_resolved WHERE party_id = $1")) {
      const id = Number(params[0]);
      return [{ resolved_id: resolvedOf[id] ?? id }];
    }
    if (t.includes("count(*)::int AS n FROM agreements WHERE parent_id")) return [{ n: 0 }];
    return [];
  });
}

test("足す：次の席（丙→丁）に入れて監査に残す", async () => {
  const d = db([{ party_id: 5, resolved_id: 5, role: "co_party", seq: 2 }]);
  await new AgreementPartyService(d).add(1, { partyId: 7, role: "agent", note: "代理店" }, "legal@example.test");
  const ins = d.find("INSERT INTO agreement_parties")!;
  assert.deepEqual(ins.params, [1, 7, "agent", 3, "代理店", "legal@example.test"]);
  assert.ok(d.queries.some((q) => q.params.includes("agreement.party.add")));
});

test("足す：主たる相手先と同じ取引先（統合先が同じ）・すでにいる取引先は断る", async () => {
  await assert.rejects(() => new AgreementPartyService(db()).add(1, { partyId: 9 }, "who"), /主たる相手先と同じ/);
  // 12 は 9 に統合されている → 同じ相手先
  await assert.rejects(() => new AgreementPartyService(db([], { 12: 9 })).add(1, { partyId: 12 }, "who"), /主たる相手先と同じ/);
  await assert.rejects(() => new AgreementPartyService(db([{ party_id: 5, resolved_id: 5, role: "co_party", seq: 2 }]))
    .add(1, { partyId: 5 }, "who"), /すでに当事者に/);
});

test("外す：主たる相手先は外せない。他の当事者は消して監査に残す", async () => {
  await assert.rejects(() => new AgreementPartyService(db()).remove(1, 9, "who"), /主たる相手先は外せません/);
  const d = new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF a")) return [{ id: 1, agreement_no: "A", counterparty_id: 9, resolved_id: 9 }];
    if (t.startsWith("DELETE FROM agreement_parties")) return [{ ok: 1 }];
    return [];
  });
  await new AgreementPartyService(d).remove(1, 5, "who");
  assert.deepEqual(d.find("DELETE FROM agreement_parties")!.params, [1, 5]);
  assert.ok(d.queries.some((q) => q.params.includes("agreement.party.remove")));
});

test("順の入れ替え：相手の行と席を交換する", async () => {
  const d = db([{ party_id: 5, resolved_id: 5, role: "co_party", seq: 2 }, { party_id: 7, resolved_id: 7, role: "agent", seq: 3 }]);
  await new AgreementPartyService(d).update(1, 7, { seq: 2 }, "who");
  const ups = d.all("UPDATE agreement_parties SET seq");
  assert.deepEqual(ups[0].params, [1, 5, 3], "丙だった 5 を丁へ");
  assert.deepEqual(ups[1].params, [2, 1, 7], "7 を丙へ");
});

test("主たる相手先との入れ替え：元の相手先がその席に下がり、契約の相手先が替わる", async () => {
  const d = db([{ party_id: 5, resolved_id: 5, role: "co_party", seq: 2 }]);
  await new AgreementPartyService(d).makePrimary(1, 5, "who");
  assert.deepEqual(d.find("UPDATE agreement_parties SET party_id = $3")!.params, [1, 5, 9]);
  assert.deepEqual(d.find("UPDATE agreements SET counterparty_id = $2")!.params, [1, 5]);
  await assert.rejects(() => new AgreementPartyService(db()).makePrimary(1, 7, "who"), /他の当事者にいません/);
});
