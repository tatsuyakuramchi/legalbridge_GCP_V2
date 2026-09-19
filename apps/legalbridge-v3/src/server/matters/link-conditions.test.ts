import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MatterLinkService } from "./link-service.js";

/**
 * 条件をまとめて案件に繋ぐ。1件ずつしか繋げず、10本あれば10回押していた。
 * 取引モデルに合わない条件は、その行だけ断って残りは繋ぐ。
 */
const build = (matterKind = "outsourcing", conditions: Record<number, string> = { 7: "service", 8: "expense" }) =>
  new FakeDatabase((text, params) => {
    if (text.includes("SELECT id FROM matters WHERE id")) return [{ id: 3 }];
    if (text.includes("FROM matters WHERE id")) return [{ id: 3, matter_no: "MTR-1", kind: matterKind }];
    if (text.includes("FROM conditions WHERE id")) {
      const id = Number(params?.[0]);
      return conditions[id] ? [{ id, condition_no: `CL-${id}`, kind: conditions[id], status: "active" }] : [];
    }
    if (text.includes("INSERT INTO matter_links")) return [{ id: 1 }];
    return undefined;
  });

test("選んだ条件をまとめて繋ぐ。重複は落として1回ずつ", async () => {
  const db = build();
  const r = await new MatterLinkService(db).attachConditions(3, [7, 8, 7], "k");
  assert.equal(r.attached, 2);
  assert.deepEqual(r.results.map((x) => x.conditionId), [7, 8]);
  assert.equal(db.all("INSERT INTO matter_links").length, 2);
  assert.equal(db.all("INSERT INTO audit_events").length, 2);
});

test("取引モデルに合わない条件はその行だけ断り、残りは繋ぐ", async () => {
  // 業務委託の案件に許諾料の条件が混ざっている。
  const db = build("outsourcing", { 7: "service", 9: "license" });
  const r = await new MatterLinkService(db).attachConditions(3, [7, 9], "k");
  assert.equal(r.attached, 1);
  const refused = r.results.find((x) => x.conditionId === 9)!;
  assert.equal(refused.attached, false);
  assert.match(refused.reason ?? "", /繋げません/);
  assert.equal(db.all("INSERT INTO matter_links").length, 1, "通った条件は繋ぐ");
});

test("案件が無ければ全体を止める。条件が空でも止める", async () => {
  const none = new FakeDatabase((t) => t.includes("SELECT id FROM matters WHERE id") ? [] : undefined);
  await assert.rejects(() => new MatterLinkService(none).attachConditions(3, [7], "k"), /案件 3/);
  await assert.rejects(() => new MatterLinkService(build()).attachConditions(3, [], "k"), /条件を選んで/);
});

test("別の処理の中から繋ぐときは、合わない条件を黙って飛ばす（文書の作成を止めない）", async () => {
  const db = build("outsourcing", { 7: "service", 9: "license" });
  const client = { query: (text: string, params?: unknown[]) => db.query(text, params) };
  const attached = await new MatterLinkService(db).attachWithin(client as never, 3, [7, 9], "k");
  assert.deepEqual(attached, [7]);
});
