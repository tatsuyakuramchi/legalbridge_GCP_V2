import test from "node:test";
import assert from "node:assert/strict";
import { RELATIONS, relationFor } from "./relations.js";

/**
 * 関連の定義そのものを見張る。
 *
 * 片側だけ作られた穴（案件から条件は繋げるのに条件から案件は繋げない）が
 * これまで何度も出た。定義が対になっているかは型では守れないので、ここで見る。
 */

test("繋げる関連は必ず外せる（片側だけ作らない）", () => {
  for (const [kind, group] of Object.entries(RELATIONS)) {
    for (const [relation, definition] of Object.entries(group)) {
      assert.equal(Boolean(definition.attach), Boolean(definition.detach),
        `${kind}.${relation} は繋ぐと外すの片方しかない`);
    }
  }
});

test("繋げる関連には候補の検索がある（探せないと繋げない）", () => {
  for (const [kind, group] of Object.entries(RELATIONS)) {
    for (const [relation, definition] of Object.entries(group)) {
      if (!definition.attach) continue;
      assert.ok(definition.candidates, `${kind}.${relation} に候補の検索が無い`);
    }
  }
});

test("関連は必ず双方向にある（どちらの画面からも見える）", () => {
  // A から B が見えるなら、B から A も見えなければならない。
  // 付け外しができるかは別（片側に寄せることはある）。見えることは対称。
  const pairs = new Set<string>();
  for (const [kind, group] of Object.entries(RELATIONS)) {
    for (const definition of Object.values(group)) {
      pairs.add(`${kind}->${definition.target}`);
    }
  }
  const missing: string[] = [];
  for (const pair of pairs) {
    const [from, to] = pair.split("->");
    if (from === to) continue;
    if (!pairs.has(`${to}->${from}`)) missing.push(pair);
  }
  assert.deepEqual(missing, [], `逆から見えない関連がある: ${missing.join(", ")}`);
});

test("無い種類・無い関連は名指しで断る", () => {
  assert.throws(() => relationFor("nope", "x"), /nope という種類はありません/);
  assert.throws(() => relationFor("matter", "nope"), /matter に nope という関連はありません/);
});

test("条件は契約・案件・文書・作品・相手先から辿れる", () => {
  assert.deepEqual(Object.keys(RELATIONS.condition).sort(),
    ["agreement", "documents", "matters", "party", "work"]);
});

test("文書は案件・条件・契約に紐づけ直せる", () => {
  for (const relation of ["matter", "conditions", "agreement"]) {
    assert.ok(RELATIONS.document[relation].attach,
      `文書から ${relation} を繋げない。作成のときにしか決められないと作り直すしかなくなる`);
  }
});
