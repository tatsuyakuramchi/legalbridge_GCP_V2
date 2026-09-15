import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MatterWriteService } from "./write-service.js";

const db = (staff: Array<Record<string, unknown>> = [{ id: 7, name: "浅井 崇", status: "active" }],
            matter: Array<Record<string, unknown>> = [{ owner_staff_id: null }]) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM staff WHERE id")) return staff;
    if (t.includes("SELECT owner_staff_id FROM matters")) return matter;
    return undefined;
  });

test("担当者を後から決められる（検収書の連絡先はここから出る）", async () => {
  const d = db();
  const r = await new MatterWriteService(d).changeOwner(3, 7, "kuramochi");
  assert.deepEqual(r, { id: 3, ownerStaffId: 7, ownerName: "浅井 崇" });
  assert.deepEqual(d.find("UPDATE matters SET owner_staff_id")!.params, [3, 7]);
  const audit = d.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "matter.change_owner");
  assert.match(JSON.stringify(audit.params), /浅井 崇/);
});

test("退職者は担当にできない（その名前が書類に出てしまう）", async () => {
  const d = db([{ id: 7, name: "退職 太郎", status: "retired" }]);
  await assert.rejects(() => new MatterWriteService(d).changeOwner(3, 7, "k"),
    /退職になっています/);
  assert.ok(!d.find("UPDATE matters SET owner_staff_id"), "書き込まない");
});

test("いない担当者は指定できない", async () => {
  await assert.rejects(() => new MatterWriteService(db([])).changeOwner(3, 9, "k"),
    /担当者 9 が見つかりません/);
});

test("外せる（付け替えの途中）", async () => {
  const d = db();
  const r = await new MatterWriteService(d).changeOwner(3, null, "k");
  assert.equal(r.ownerName, null);
  assert.deepEqual(d.find("UPDATE matters SET owner_staff_id")!.params, [3, null]);
  assert.ok(!d.find("FROM staff WHERE id"), "外すときは担当者を引きに行かない");
});

test("いない案件には何もしない", async () => {
  const d = db(undefined, []);
  await assert.rejects(() => new MatterWriteService(d).changeOwner(9, 7, "k"),
    /案件 9 が見つかりません/);
  assert.ok(!d.find("UPDATE matters SET owner_staff_id"));
});
