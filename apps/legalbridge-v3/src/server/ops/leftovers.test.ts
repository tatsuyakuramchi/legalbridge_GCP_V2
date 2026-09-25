import test from "node:test";
import assert from "node:assert/strict";
import { DISPOSE_ORDER, LEFTOVER_LABEL, disposable, heldBy, tally } from "./leftovers.js";
import type { Leftover } from "./leftovers.js";

const item = (over: Partial<Leftover> = {}): Leftover => ({
  kind: "draft", id: 1, label: "下書き #1", origin: "訂正版の作りかけ",
  createdAt: "2026-09-01T00:00:00.000Z", context: null,
  disposable: true, caution: null, holders: [], ...over
});

test("指しているものが無ければ捨てられる", () => {
  assert.equal(disposable([]), true);
  assert.equal(disposable([{ target: "支払の割当", rows: 1 }]), false);
});

test("0 件の引き止めは並べない", () => {
  // 「0 件」の行が並ぶと、本当の引き止めが埋もれる。
  assert.deepEqual(heldBy([["支払の割当", 0], ["文書", 2], ["案件", 0]]),
    [{ target: "文書", rows: 2 }]);
  assert.deepEqual(heldBy([["支払の割当", 0]]), []);
});

test("種別ごとの件数と、そのうち捨てられる数", () => {
  const t = tally([
    item({ kind: "draft", id: 1 }),
    item({ kind: "draft", id: 2, disposable: false, holders: [{ target: "実績", rows: 1 }] }),
    item({ kind: "condition", id: 3 })
  ]);
  assert.deepEqual(t, [
    { kind: "draft", label: "出していない文書", total: 2, disposable: 1 },
    { kind: "condition", label: "無効にした条件", total: 1, disposable: 1 }
  ]);
  // 1件も無い種別は見出しに出さない。
  assert.equal(t.some((x) => x.kind === "event"), false);
});

test("捨てる順は 文書 → 実績 → 条件", () => {
  // 実績を先に外さないと、条件が実績に引き止められて消せない。
  assert.deepEqual(DISPOSE_ORDER, ["draft", "event", "condition"]);
  assert.ok(DISPOSE_ORDER.indexOf("event") < DISPOSE_ORDER.indexOf("condition"));
});

test("種別の名前が全部ある（画面の見出しに使う）", () => {
  for (const kind of DISPOSE_ORDER) assert.ok(LEFTOVER_LABEL[kind], `${kind} の名前が無い`);
});
