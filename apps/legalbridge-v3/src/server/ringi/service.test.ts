import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { RingiService, normalizeRingiNo, parseRingiInput } from "./service.js";

test("稟議番号を揃える：5 桁は R- を付ける。B- はそのまま。読めなければ null", () => {
  assert.equal(normalizeRingiNo("00012"), "R-00012");
  assert.equal(normalizeRingiNo(" r-00012 "), "R-00012");
  assert.equal(normalizeRingiNo("B00001"), "B-00001");
  assert.equal(normalizeRingiNo("R－00012"), "R-00012", "全角のハイフンも読む");
  assert.equal(normalizeRingiNo("R-123"), null);
  assert.equal(normalizeRingiNo("X-00001"), null);
});

test("登録には番号と件名が要る。状態・日付・課題キーの形を確かめる", () => {
  assert.throws(() => parseRingiInput({ title: "x" }, "create"), /稟議番号は/);
  assert.throws(() => parseRingiInput({ ringiNo: "00001", title: " " }, "create"), /件名は空にできません/);
  assert.throws(() => parseRingiInput({ status: "done" }, "update"), /状態 done は使えません/);
  assert.throws(() => parseRingiInput({ approvedOn: "2026/4/1" }, "update"), /YYYY-MM-DD/);
  assert.throws(() => parseRingiInput({ backlogIssueKey: "123" }, "update"), /LEGAL-123/);
  assert.deepEqual(parseRingiInput({ backlogIssueKey: "legal-12", totalBudget: 5000000 }, "update"),
                   { backlog_issue_key: "LEGAL-12", total_budget: 5000000 });
});

const row = { id: 7, ringi_no: "R-00012", decision_type: "ringi", title: "挿絵発注", status: "approved", link_count: 1 };

test("同じ番号は二重に登録させない", async () => {
  const d = new FakeDatabase((t) => (t.includes("SELECT id FROM ringi WHERE ringi_no") ? [{ id: 7 }] : undefined));
  await assert.rejects(new RingiService(d).create({ ringiNo: "00012", title: "x" }, "u@x"), /R-00012 はもう登録されています/);
});

test("B- で登録すると取締役会決議になる。監査に残す", async () => {
  const d = new FakeDatabase((t) => {
    if (t.includes("INSERT INTO ringi (")) return [{ id: 9 }];
    if (t.includes("FROM ringi r") && t.includes("WHERE r.id")) return [{ ...row, id: 9, ringi_no: "B-00003", decision_type: "board_resolution" }];
    return undefined;
  });
  const r = await new RingiService(d).create({ ringiNo: "b00003", title: "グループ会社との取引" }, "u@x");
  assert.equal(r.decisionType, "board_resolution");
  const ins = d.all("INSERT INTO ringi (")[0];
  assert.ok(ins.params.includes("board_resolution"));
  assert.ok(d.all("INSERT INTO audit_events").some((q) => q.params[1] === "ringi.create"));
});

test("番号で繋ぐ：何の番号かはこちらで見分ける。見つからなければそう言う", async () => {
  const d = new FakeDatabase((t) => {
    if (t.includes("'document' AS t")) return [{ t: "document", id: 44 }];
    if (t.includes("SELECT ringi_no FROM ringi")) return [{ ringi_no: "R-00012" }];
    if (t.includes("INSERT INTO ringi_links")) return [{}];
    if (t.includes("FROM ringi r")) return [row];
    return undefined;
  });
  await new RingiService(d).link(7, { ref: "arc-po-2026-1001" }, "u@x");
  const ins = d.all("INSERT INTO ringi_links")[0];
  assert.deepEqual(ins.params.slice(0, 3), [7, "document", 44]);
  assert.equal(d.all("'document' AS t")[0].params[0], "ARC-PO-2026-1001", "大文字に揃えて完全一致で引く");

  const none = new FakeDatabase(() => undefined);
  await assert.rejects(new RingiService(none).link(7, { ref: "NOPE-1" }, "u@x"), /NOPE-1」に当たる/);
});
