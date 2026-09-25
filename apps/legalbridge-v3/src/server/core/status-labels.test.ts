import test from "node:test";
import assert from "node:assert/strict";
import { VERSION_KINDS, labelsOf, statusOf, type StatusKind } from "./status-labels.js";
import { SETTLEMENT_LABEL } from "../conditions/settlement.js";

/**
 * 状態の語が軸をまたいで重ならないこと。
 *
 * 「支払済み」が支払1件・条件の決着・予定の回の3か所にあって、条件の一覧で
 * 見たときに1件払ったのか条件が終わったのかが読めなかった。語が重なると
 * 画面をいくら整えても読めないので、ここで止める。
 */

const KINDS: StatusKind[] = ["matter", "task", "condition", "document",
  "payment", "event", "agreement", "party", "staff", "work"];

test("お金の2軸（支払1件と条件の決着）は、同じ語を使わない", () => {
  const payment = new Set(labelsOf("payment"));
  const settlement = new Set(Object.values(SETTLEMENT_LABEL));
  const both = [...payment].filter((l) => settlement.has(l));
  assert.deepEqual(both, [],
    `支払の札と条件の決着で同じ語を使っている：${both.join("、")}`);
  // 支払1件は「支払済み」、条件1本は「払い切り」。
  assert.ok(payment.has("支払済み"));
  assert.ok(settlement.has("払い切り"));
  assert.ok(!settlement.has("支払済み"));
});

test("支払の「予定」は使わない（予定明細の回と紛らわしい）", () => {
  assert.equal(statusOf("payment", "planned").label, "未払");
  // 承認の導線が無いので、承認済みは未払と同じ扱い（移行データにだけある値）。
  assert.equal(statusOf("payment", "approved").label, "未払");
});

test("void はどの軸でも「無効」（実績だけ「取消」と呼んでいた）", () => {
  for (const kind of ["condition", "document", "event"] as const) {
    assert.equal(statusOf(kind, "void").label, "無効", `${kind} の void`);
  }
  // 支払は canceled なので「取消」。DB の値が違うものは語も分ける。
  assert.equal(statusOf("payment", "canceled").label, "取消");
});

test("生きている実績にも札がある（他の段と並べたとき抜けて見えない）", () => {
  assert.equal(statusOf("event", "active").label, "記録済み");
});

test("版・生死の軸は条件と実績。進み具合とは形を変えて出す", () => {
  assert.deepEqual([...VERSION_KINDS].sort(), ["condition", "event"]);
  for (const kind of KINDS) {
    if (VERSION_KINDS.has(kind)) continue;
    assert.ok(!VERSION_KINDS.has(kind), `${kind} は進み具合の軸`);
  }
});

test("訳せない値はそのまま出す（黙って空欄にすると状態を見失う）", () => {
  assert.equal(statusOf("payment", "sonzai_shinai").label, "sonzai_shinai");
  assert.equal(statusOf("payment", null).label, "—");
});

test("どの軸も、同じ語を2つの値に割り当てていない", () => {
  for (const kind of KINDS) {
    const labels = labelsOf(kind);
    const dup = labels.filter((l, i) => labels.indexOf(l) !== i);
    /*
     * 重なってよいのは、別の値を同じ意味に畳んでいる2か所だけ。
     *   支払 … 承認済み（移行データにだけある値）を未払に畳んでいる
     *   文書 … issued（保存の値）と decided（画面に出す段階）が同じもの
     */
    const allowed = kind === "payment" ? ["未払"] : kind === "document" ? ["決定済み"] : [];
    assert.deepEqual([...new Set(dup)], allowed, `${kind} で同じ語が2度出ている`);
  }
});
