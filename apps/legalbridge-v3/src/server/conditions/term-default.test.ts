import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { TermDefaultService, termEndFrom } from "./term-default.js";

test("満了日は開始日の 3 年後の前日", () => {
  assert.equal(termEndFrom("2018-04-01"), "2021-03-31");
  assert.equal(termEndFrom("2024-02-29"), "2027-02-28", "うるう日開始は 2/28 満了");
  assert.equal(termEndFrom("2025-10-15"), "2028-10-14");
});

/** 条件 7：2018/4/1 開始・終了なし。条件 8：開始も終了もなし。 */
const db = () => new FakeDatabase((text) => {
  if (text.includes("FROM conditions c") && text.includes("c.term_end IS NULL")) return [
    { id: 7, condition_no: "C-7", name: "紙", term_start: "2018-04-01", party_name: "作家甲", work_title: "本A",
      document_nos: ["ARC-PUBT-2026-1001"] },
    { id: 8, condition_no: "C-8", name: "電子", term_start: null, party_name: "作家乙", work_title: "本B",
      document_nos: ["ARC-PUBT-2026-1002"] }
  ];
  if (text.includes("condition.term_default") && text.includes("FROM documents d")) return [
    { id: 901, document_no: "ARC-PUBT-2026-1001", issued_at: "2026-10-01T03:00:00Z", party_name: "作家甲", conditions: 1, open_draft: null },
    { id: 902, document_no: "ARC-PUBT-2026-1003", issued_at: "2026-10-02T03:00:00Z", party_name: "作家丙", conditions: 2, open_draft: 990 }
  ];
  return undefined;
});

test("試算：開始から 3 年・3 年ごとに更新として、今日までの更新回数を出す。開始日の無い条件は直さない", async () => {
  const r = await new TermDefaultService(db(), null, () => "2026-10-19").preview();
  assert.deepEqual(r.targets.map((t) => [t.conditionId, t.newTermEnd, t.label, Boolean(t.skip)]), [
    [7, "2021-03-31", "2018.4.1〜2027.3.31（更新 2回）", false],
    [8, null, null, true]
  ]);
});

test("直す：終了日・自動更新・3 年ごとを入れ、監査に残す。開始日の無い条件は選んでも直さない", async () => {
  const database = db();
  const r = await new TermDefaultService(database, null, () => "2026-10-19").run([7, 8], "tester");
  assert.equal(r.updated, 1);
  const updates = database.all("UPDATE conditions SET term_end");
  assert.deepEqual(updates.map((q) => q.params), [[7, "2021-03-31", 36]]);
  assert.match(updates[0]!.text, /auto_renew = true/);
  assert.match(updates[0]!.text, /term_end IS NULL/, "その間に終了日が入った条件は上書きしない");
  const audit = database.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "condition.term_default");
});

test("出し直す：訂正版の下書きを作って元の決定日で決定する。下書きが開いている条件書は飛ばす", async () => {
  const calls: Array<[string, number, unknown]> = [];
  const issuer = {
    reissue: async (id: number, reason: string) => { calls.push(["reissue", id, reason]); return { id: id + 1000 }; },
    issue: async (id: number, _who: string, extra?: { issuedOn?: string | null }) => {
      calls.push(["issue", id, extra?.issuedOn]); return { documentNo: "ARC-PUBT-2026-1001-R2" };
    }
  };
  const r = await new TermDefaultService(db(), issuer).reissue([901, 902, 903], "tester");
  assert.equal(r.reissued, 1);
  assert.deepEqual(calls, [["reissue", 901, "許諾期間（3年・3年ごとの自動更新）を記載する"], ["issue", 1901, "2026-10-01"]]);
  assert.deepEqual(r.results.map((x) => [x.documentId, x.status]), [[901, "reissued"], [902, "skipped"], [903, "skipped"]]);
  assert.equal(r.results[0]!.newDocumentNo, "ARC-PUBT-2026-1001-R2");
  assert.match(r.results[1]!.message ?? "", /訂正版の下書き（#990）/);
});
