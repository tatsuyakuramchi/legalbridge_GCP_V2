import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { WorkCreditService } from "./credits.js";

/**
 * クレジット表記の履歴（A-031）。行を足すと works の写しが今日時点の行に同期される。
 */
const build = (rows: Array<Record<string, unknown>> = []) => new FakeDatabase((text) => {
  if (text.includes("SELECT id FROM works WHERE id")) return [{ id: 9 }];
  if (text.includes("INSERT INTO work_credits")) return [{ id: 31 }];
  if (text.includes("FROM work_credits WHERE work_id = $1\n          ORDER BY")) return rows;
  if (text.includes("SELECT id FROM work_credits")) return rows.length ? [{ id: rows[0].id }] : [];
  if (text.includes("DELETE FROM work_credits")) return [{ id: 31, effective_from: "2026-10-01", copyright_notice: "© 2026 A" }];
  return undefined;
});

test("行を足すと同じ適用日なら上書きし、works の写しを同期して監査に残す", async () => {
  const db = build();
  const r = await new WorkCreditService(db).add(9,
    { effectiveFrom: "2026-10-01", edition: "第2刷", copyrightNotice: "© 2026 著者 / Arclight", thirdPartyRights: "挿絵：X" }, "k");
  assert.equal(r.id, 31);
  const ins = db.find("INSERT INTO work_credits")!;
  assert.match(ins.text, /ON CONFLICT \(work_id, effective_from\) DO UPDATE/);
  assert.deepEqual(ins.params.slice(0, 5), [9, "2026-10-01", "第2刷", "© 2026 著者 / Arclight", "挿絵：X"]);
  assert.ok(db.find("UPDATE works w\n        SET copyright_notice = c.copyright_notice"), "写しを同期する");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "work.credit");
});

test("著作権表示が空・適用日が無い行は止める", async () => {
  const svc = new WorkCreditService(build());
  await assert.rejects(() => svc.add(9, { effectiveFrom: "2026-10-01", copyrightNotice: " " }, "k"), /著作権表示は必須/);
  await assert.rejects(() => svc.add(9, { effectiveFrom: "", copyrightNotice: "© A" }, "k"), /適用開始日/);
});

test("一覧は新しい順で、今日時点の行に current が付く", async () => {
  const db = build([
    { id: 32, work_id: 9, effective_from: "2026-10-01", edition: "第2刷", copyright_notice: "© 2026 B", created_at: "2026-09-17T00:00:00Z" },
    { id: 31, work_id: 9, effective_from: "2026-01-01", edition: "初版", copyright_notice: "© 2026 A", created_at: "2026-01-01T00:00:00Z" }
  ]);
  const r = await new WorkCreditService(db).list(9);
  assert.deepEqual(r.credits.map((c) => [c.id, c.current]), [[32, true], [31, false]]);
  assert.equal(r.current?.copyrightNotice, "© 2026 B");
});

test("行を消すと残りの行から今の表記を決め直す", async () => {
  const db = build();
  await new WorkCreditService(db).remove(9, 31, "k");
  assert.ok(db.find("DELETE FROM work_credits"));
  assert.ok(db.find("SET copyright_notice = NULL"), "行が無ければ写しを空にする");
  assert.equal(db.find("INSERT INTO audit_events")!.params[1], "work.credit_remove");
});
