import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentPartyService, SuccessionService } from "./multi-party.js";

test("関係当事者を置き換えるとき、宛名の取引先は相手方として必ず残す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("AS addressee") && t.includes("FOR UPDATE OF d")) return [{ id: 10, addressee: 5 }];
    if (t.includes("SELECT id FROM parties WHERE id = ANY")) return [{ id: 5 }, { id: 7 }, { id: 8 }];
    if (t.includes("SELECT party_id, role FROM document_parties")) return [];
    if (t.includes("FROM document_parties dp") && t.includes("ORDER BY dp.sort_order")) return [];
    return undefined;
  });
  await new DocumentPartyService(db).replace(10, [{ partyId: 7, role: "coauthor" }, { partyId: 8, role: "signer" }, { partyId: 7, role: "coauthor" }], "me");
  const inserts = db.all("INSERT INTO document_parties");
  assert.deepEqual(inserts.map((q) => [q.params[1], q.params[2], q.params[4]]),
    [[5, "counterparty", 0], [7, "coauthor", 1], [8, "signer", 2]], "宛名が先頭、同じ組は 1 回");
  assert.ok(db.find("DELETE FROM document_parties"));
  assert.equal(db.find("INSERT INTO audit_events")?.params[1], "document.parties");
});

test("無い取引先を関係当事者にはできない", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF d")) return [{ id: 10, addressee: null }];
    if (t.includes("SELECT id FROM parties WHERE id = ANY")) return [];
    return undefined;
  });
  await assert.rejects(new DocumentPartyService(db).replace(10, [{ partyId: 99, role: "signer" }], "me"), /取引先 99 が見つかりません/);
});

const successionDb = (opts: { counterparty?: number; open?: boolean; merged?: boolean; row?: Record<string, unknown> } = {}) =>
  new FakeDatabase((t, p) => {
    if (t.includes("SELECT id, counterparty_id, status FROM agreements")) return [{ id: 100, counterparty_id: opts.counterparty ?? 1, status: "executed" }];
    if (t.includes("applied_at IS NULL AND reverted_at IS NULL", 0) && t.startsWith("SELECT id FROM agreement_successions WHERE agreement_id")) return opts.open ? [{ id: 3 }] : [];
    if (t.includes("SELECT id, status FROM parties WHERE id = $1")) return [{ id: p[0], status: opts.merged ? "merged" : "active" }];
    if (t.includes("INSERT INTO agreement_successions")) return [{ id: 42 }];
    if (t.includes("effective_on <= $1::date")) return [{ id: 42 }];
    if (t.includes("SELECT * FROM agreement_successions WHERE id = $1 FOR UPDATE")) {
      return [{ id: 42, agreement_id: 100, from_party_id: 1, to_party_id: 9, effective_on: "2026-11-01", applied_at: null, reverted_at: null, ...(opts.row ?? {}) }];
    }
    if (t.includes("UPDATE agreements SET counterparty_id")) return [{ id: 100 }, { id: 101 }];
    if (t.includes("UPDATE conditions SET counterparty_id")) return [{ id: 5 }, { id: 6 }, { id: 7 }];
    if (t.includes("FROM agreement_successions s")) {
      return [{ id: 42, agreement_id: 100, agreement_no: "ARC-100", agreement_title: "基本契約", from_party_id: 1, from_name: "旧社",
                to_party_id: 9, to_name: "新社", effective_on: "2026-11-01", document_id: null, document_no: null, note: null,
                applied_at: opts.row?.applied_at ?? null, reverted_at: null }];
    }
    return undefined;
  });

test("発効日が先の承継は予定として登録し、相手方はまだ変えない", async () => {
  const db = successionDb();
  const s = await new SuccessionService(db, () => "2026-10-20").create(100, { toPartyId: 9, effectiveOn: "2026-11-01" }, "me");
  assert.equal(s.state, "pending");
  assert.equal(db.find("INSERT INTO agreement_successions")?.params[1], 1, "from は契約の今の相手方");
  assert.equal(db.find("UPDATE agreements SET counterparty_id"), undefined);
});

test("発効日が今日以前なら、その場で契約（と個別契約）と条件の相手方を切り替える", async () => {
  const db = successionDb();
  await new SuccessionService(db, () => "2026-12-01").create(100, { toPartyId: 9, effectiveOn: "2026-11-01" }, "me");
  const a = db.find("UPDATE agreements SET counterparty_id")!;
  assert.deepEqual(a.params, [100, 1, 9]);
  const c = db.find("UPDATE conditions SET counterparty_id")!;
  assert.deepEqual(c.params, [1, 9, [100, 101]], "個別契約の条件も移す");
  assert.ok(db.find("UPDATE agreement_successions SET applied_at = now()"));
  const audit = db.all("INSERT INTO audit_events").map((q) => q.params[1]);
  assert.deepEqual(audit, ["agreement.succession", "agreement.succession_apply"]);
});

test("譲受人が今の相手方と同じ・統合済み・予定が開いている、は登録できない", async () => {
  const svc = (db: FakeDatabase) => new SuccessionService(db, () => "2026-10-20");
  await assert.rejects(svc(successionDb({ counterparty: 9 })).create(100, { toPartyId: 9, effectiveOn: "2026-11-01" }, "me"), /今の相手方と同じ/);
  await assert.rejects(svc(successionDb({ merged: true })).create(100, { toPartyId: 9, effectiveOn: "2026-11-01" }, "me"), /統合済み/);
  await assert.rejects(svc(successionDb({ open: true })).create(100, { toPartyId: 9, effectiveOn: "2026-11-01" }, "me"), /発効前の承継がすでに/);
});

test("適用した承継は戻せる（to → from）。未適用は消す", async () => {
  const applied = successionDb({ row: { applied_at: "2026-11-01T00:00:00Z" } });
  const s = await new SuccessionService(applied).revert(42, "me");
  assert.deepEqual(applied.find("UPDATE agreements SET counterparty_id")!.params, [100, 9, 1]);
  assert.ok(applied.find("SET reverted_at = now()"));
  assert.equal(s.id, 42);
  await assert.rejects(new SuccessionService(applied).remove(42, "me"), /適用済みの承継は消せません/);

  const pending = successionDb();
  await assert.rejects(new SuccessionService(pending).revert(42, "me"), /まだ適用していない/);
  await new SuccessionService(pending).remove(42, "me");
  assert.ok(pending.find("DELETE FROM agreement_successions"));
});

test("日次：発効日の来た承継だけ適用する", async () => {
  const db = successionDb();
  const ids = await new SuccessionService(db, () => "2026-11-01").applyDue(db);
  assert.deepEqual(ids, [42]);
  assert.equal(db.find("effective_on <= $1::date")?.params[0], "2026-11-01");
});
