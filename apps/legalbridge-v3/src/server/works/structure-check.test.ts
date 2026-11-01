import test from "node:test";
import assert from "node:assert/strict";
import { duplicateWorkGroups, keepOf, normalizeTitle, type WorkCheck } from "./structure-check.js";
import { originalWorkTitle } from "../royalty/product-name.js";

const w = (id: number, title: string, o: Partial<WorkCheck> = {}): WorkCheck => ({
  id, code: `W-${id}`, title, kind: "own", legacy: false, sourceTitle: null,
  inConditions: 0, outConditions: 0, otherConditions: 0, documents: 0, editions: 0, parentIds: [], childIds: [], ...o
});

test("作品名の表記ゆれ：全角・半角・空白・記号は同じとみなす", () => {
  assert.equal(normalizeTitle("クトゥルフ・マニアックス ク トゥルフ・リザレクション"), normalizeTitle("クトゥルフ・マニアックス クトゥルフ・リザレクション"));
  assert.equal(normalizeTitle("クイックショット!"), normalizeTitle("クイックショット！"));
  assert.equal(normalizeTitle("ito　レインボー"), normalizeTitle("ito レインボー"));
  assert.notEqual(normalizeTitle("タイムボム"), normalizeTitle("タイムボムQ"));
});

test("作品の重複：同じ名前の組。残す側は決定した文書・条件の多い方。系譜で繋がっていれば印", () => {
  const groups = duplicateWorkGroups([
    w(1, "ラブレター", { legacy: true, inConditions: 2 }), w(2, "ラブレター", { documents: 3, outConditions: 1 }),
    w(3, "ito", { kind: "source_ip", childIds: [4] }), w(4, "ito", { parentIds: [3] }),
    w(5, "タイムボム"), w(6, "タイムボムQ")
  ]);
  assert.deepEqual(groups.map((g) => [g.works.map((x) => x.id), g.keepId, g.linked]), [[[3, 4], 3, true], [[1, 2], 2, false]]);
  assert.equal(keepOf([w(7, "a", { legacy: true }), w(8, "a")]), 8, "同じなら移行データでない方");
  assert.equal(keepOf([w(9, "a"), w(10, "a")]), 9, "それも同じなら古い方");
});

test("計算書の原著作物名：作品の原作名 > 原作の作品名 > 系譜の原作名 > 作品名", () => {
  assert.equal(originalWorkTitle({ inWorkTitle: "タイムボム", inWorkKind: "own", ownSourceTitle: "なんとかエボリューション" }), "なんとかエボリューション");
  assert.equal(originalWorkTitle({ inWorkTitle: "ito", inWorkKind: "source_ip" }), "ito");
  assert.equal(originalWorkTitle({ inWorkTitle: "ito レインボー", inWorkKind: "own", sourceTitles: ["ito"] }), "ito");
  assert.equal(originalWorkTitle({ inWorkTitle: "ラブレター", inWorkKind: "own", ownSourceTitle: "  " }), "ラブレター");
});
