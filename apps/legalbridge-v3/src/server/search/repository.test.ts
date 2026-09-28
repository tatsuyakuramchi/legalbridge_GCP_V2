import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { SearchRepository, normalizeQuery, patternsOf, tokensOf } from "./repository.js";

test("全角・半角、ハイフンの書き方、空白を揃える", () => {
  assert.equal(normalizeQuery(" ＡＲＣ－ＰＯ－２０２６ "), "ARC-PO-2026");
  assert.equal(normalizeQuery("ｲﾄ　霧島"), "イト 霧島");
  assert.deepEqual(tokensOf("ito  霧島 ito"), ["ito", "霧島"]);
});

test("ひらがな・カタカナの両方で引く。% と _ は字として扱う", () => {
  assert.deepEqual(patternsOf("いと").sort(), ["%いと%", "%イト%"].sort());
  assert.ok(patternsOf("50%").includes("%50\\%%"));
});

test("空白で区切った言葉は、すべてを含むものだけ（言葉ごとに AND）", async () => {
  const d = new FakeDatabase(() => []);
  await new SearchRepository(d).find("ito 霧島", { targets: ["document"] });
  const q = d.queries[0]!;
  assert.equal((q.text.match(/ILIKE ANY/g) ?? []).length, 2);
  assert.match(q.text, /dp\.parties/, "文書は相手先の名前でも引く");
  assert.deepEqual(q.params[1], ["%ito%"]);
});

test("上限を超えたら more を立てる", async () => {
  const d = new FakeDatabase(() => Array.from({ length: 7 }, (_, i) => ({ id: i + 1, request_no: `REQ-${i}`, title: "t", state: "new" })));
  const r = await new SearchRepository(d).find("REQ", { targets: ["request"], limitPerType: 6 });
  assert.equal(r.results.length, 6);
  assert.equal(r.more.request, true);
});
