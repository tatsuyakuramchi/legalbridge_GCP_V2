import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ensureAgreementForOrder } from "./order-agreement.js";

const cond = (id: number, over: Record<string, unknown> = {}) =>
  ({ id, counterparty_id: 5, direction: "in", agreement_id: null, agreement_kind: "master", agreement_parent: null, agreement_order: null, ...over });
const master = (id: number, no: string) => ({ id, agreement_no: no, domain: "service", kind: "master", terminated_on: null, resolved_id: 5 });

type Row = Record<string, unknown>;
function db(h: { conds?: Row[]; existing?: Row[]; master?: Row[]; taken?: string[] } = {}) {
  return new FakeDatabase((t, p) => {
    if (t.includes("AS agreement_order")) return h.conds ?? [];
    if (t.includes("WHERE order_document_id = $1")) return h.existing ?? [];
    if (t.includes("a.terminated_on, r.resolved_id")) return h.master ?? [];
    if (t.includes("SELECT resolved_id FROM v_party_resolved")) return [{ resolved_id: 5 }];
    if (t.includes("SELECT id FROM agreements WHERE agreement_no = $1")) return (h.taken ?? []).includes(String(p?.[0])) ? [{ id: 1 }] : [];
    if (t.includes("INSERT INTO agreements")) return [{ id: 900 }];
    if (t.includes("UPDATE conditions SET agreement_id")) return [{ id: 1 }];
    return [];
  });
}
const input = { documentId: 98, documentNo: "ARC-PO-2026-0098-R2", title: "試遊の発注", conditionIds: [501, 502] };

test("基本契約を直接指す条件（個別契約待ち）から基本契約を決め、その下に器（個別契約）を立てて条件を載せる。番号は -R を除く", async () => {
  const d = db({ conds: [cond(501, { agreement_id: 3 }), cond(502)], master: [master(3, "ARC-SVC-2026-0001")] });
  const r = await ensureAgreementForOrder(d, input, "k");
  assert.deepEqual(r, { agreementId: 900, agreementNo: "ARC-PO-2026-0098", kind: "supplement", masterId: 3, masterNo: "ARC-SVC-2026-0001",
                        created: true, conditionsLinked: 1 });
  const ins = d.find("INSERT INTO agreements")!.params;
  assert.deepEqual(ins, ["ARC-PO-2026-0098", "試遊の発注", 5, "in", "supplement", "service", 3, 98]);
  assert.deepEqual(d.find("UPDATE documents SET agreement_id")!.params, [98, 900], "発注書は器に繋ぐ");
  assert.deepEqual(d.find("UPDATE conditions SET agreement_id")!.params, [[501, 502], 900]);
});

test("基本契約が無ければ単体契約の器。本体番号が使われていれば発注書の番号そのまま", async () => {
  const d = db({ conds: [cond(501)], taken: ["ARC-PO-2026-0098"] });
  const r = await ensureAgreementForOrder(d, input, "k");
  assert.equal(r?.kind, "standalone"); assert.equal(r?.agreementNo, "ARC-PO-2026-0098-R2"); assert.equal(r?.masterId, null);
  assert.equal(d.find("INSERT INTO agreements")!.params[6], null);
  await assert.rejects(ensureAgreementForOrder(db({ conds: [cond(501)], taken: ["ARC-PO-2026-0098", "ARC-PO-2026-0098-R2"] }), input, "k"), /既にあります/);
});

test("条件が 2 本の基本契約に分かれていれば断る。人が基本契約を選べばそれ（null は基本契約なし）", async () => {
  const split = [cond(501, { agreement_id: 3 }), cond(502, { agreement_id: 4, agreement_kind: "supplement", agreement_parent: 7 })];
  await assert.rejects(ensureAgreementForOrder(db({ conds: split }), input, "k"), /2 本の基本契約/);
  const chosen = db({ conds: split, master: [master(3, "ARC-SVC-2026-0001")] });
  const r = await ensureAgreementForOrder(chosen, { ...input, masterId: 3 }, "k");
  assert.equal(r?.masterId, 3);
  assert.deepEqual(chosen.find("UPDATE conditions SET agreement_id")!.params, [[501], 900], "別の個別契約に載る条件は動かさない");
  const none = await ensureAgreementForOrder(db({ conds: split, master: [] }), { ...input, masterId: null }, "k");
  assert.equal(none?.kind, "standalone");
  await assert.rejects(ensureAgreementForOrder(db({ conds: [cond(501)], master: [{ ...master(9, "X"), kind: "standalone" }] }), { ...input, masterId: 9 }, "k"), /基本契約を選んで/);
});

test("既に器があれば使い回し、親を合わせる（立て直さない）", async () => {
  const d = db({ conds: [cond(501, { agreement_id: 900, agreement_kind: "supplement", agreement_parent: 3, agreement_order: 98 })],
                 existing: [{ id: 900, agreement_no: "ARC-PO-2026-0098", parent_id: 3, counterparty_id: 5, direction: "in" }],
                 master: [master(4, "ARC-SVC-2026-0002")] });
  const r = await ensureAgreementForOrder(d, { ...input, masterId: 4 }, "k");
  assert.equal(r?.created, false); assert.equal(r?.agreementId, 900); assert.equal(r?.masterNo, "ARC-SVC-2026-0002");
  assert.equal(d.find("INSERT INTO agreements"), undefined);
  assert.deepEqual(d.find("UPDATE agreements SET kind")!.params, [900, "supplement", 4, "service"]);
  assert.deepEqual(d.find("UPDATE conditions SET agreement_id")!.params, [[501], 900], "器を指す条件はそのまま器に");
});

test("条件が無く器も無ければ何もしない。相手先が混ざれば断る", async () => {
  assert.equal(await ensureAgreementForOrder(db(), { ...input, conditionIds: [] }, "k"), null);
  await assert.rejects(ensureAgreementForOrder(db({ conds: [cond(501), cond(502, { counterparty_id: 6 })] }), input, "k"), /相手先の違う/);
});
