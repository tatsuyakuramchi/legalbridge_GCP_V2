import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionBundleService, SECTION_LABEL, hasManualAmounts } from "./bundle-service.js";
import type { BundlePatch } from "./bundle-service.js";

/**
 * まとめて直す。段ごとの書き込みは持ち主に任せ、断られると分かっているものは
 * 何も書く前に止める（前半だけ書けた状態を作らない）。
 */

const calls: string[] = [];
const parts = (over: Record<string, unknown> = {}) => {
  calls.length = 0;
  return {
    conditions: {
      updateEconomics: async (...a: unknown[]) => {
        calls.push(`condition:${JSON.stringify(a[1])}`);
        return { changed: [], resolvesThrough: [] } as never;
      }
    },
    schedules: {
      replace: async (...a: unknown[]) => { calls.push(`schedules:${(a[1] as unknown[]).length}`); return {} as never; }
    },
    events: {
      amend: async (...a: unknown[]) => {
        calls.push(`event:${JSON.stringify(a[2])}`);
        return { eventId: 9, changed: Object.keys(a[2] as object) };
      }
    },
    payments: {
      amend: async (...a: unknown[]) => {
        calls.push(`payment:${JSON.stringify(a[1])}`);
        return { paymentId: 4, changed: Object.keys(a[1] as object), due: null };
      }
    },
    documents: {
      reissue: async (...a: unknown[]) => {
        calls.push(`reissue:${a[0]}:${JSON.stringify(a[3] ?? null)}`);
        return { id: 900 + Number(a[0]), supersedesId: Number(a[0]) };
      }
    },
    ...over
  } as never;
};

const db = (over: Record<string, Array<Record<string, unknown>>> = {}) =>
  new FakeDatabase((t) => {
    for (const [fragment, rows] of Object.entries(over)) if (t.includes(fragment)) return rows;
    if (t.includes("FROM conditions WHERE id")) return [{ status: "active" }];
    if (t.includes("FROM condition_events e WHERE e.id")) return [{ status: "active", blocking_no: null }];
    if (t.includes("FROM payments WHERE id")) return [{ status: "planned" }];
    // 訂正版の下見と、下書きを作る前の下調べは、どちらも documents を引く。
    // 細かいほう（条件の紐づけまで見るほう）を先に判じる。
    if (t.includes("FROM document_conditions dc WHERE dc.document_id")) {
      return [{ document_no: "ARC-PO-1", manual_inputs: {}, condition_ids: [3] }];
    }
    if (t.includes("FROM documents d WHERE d.id")) return [{ status: "issued", document_no: "ARC-PO-1", open_draft: null }];
    if (t.includes("FROM conditions x, conditions c")) {
      return [{ id: 3, pricing_model: "fixed", flat_amount: 95000 }];
    }
    return [];
  });

const patch: BundlePatch = {
  condition: { flatAmount: 120000 },
  schedules: [{ seq: 1, triggerKind: "on_inspection", plannedAmount: 60000 } as never,
              { seq: 2, triggerKind: "on_inspection", plannedAmount: 60000 } as never],
  event: { id: 9, occurredOn: "2026-09-20" },
  payment: { id: 4, dueOn: "2026-10-31" }
};

test("上の段から順に書き、書けた段と欄を返す", async () => {
  const p = parts();
  const r = await new ConditionBundleService(db(), p).apply(3, patch, "納品数の再調整", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["condition", "schedules", "event", "payment"]);
  assert.equal(r.stoppedAt, null);
  // 条件 → 予定 → 実績 → 支払 の順。手前を飛ばして先を書かない。
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["condition", "schedules", "event", "payment"]);
});

test("支払が立っている実績の金額は、何も書く前に止める", async () => {
  // 先に条件だけ書けてしまうと、条件の金額と実績の金額が食い違ったまま残る。
  const p = parts();
  await assert.rejects(
    () => new ConditionBundleService(
      db({ "FROM condition_events e WHERE e.id": [{ status: "active", blocking_no: "PY-2026-0007" }] }), p)
      .apply(3, { ...patch, event: { id: 9, amount: 50000 } }, "訂正", "admin"),
    /支払 PY-2026-0007 が立っています/);
  assert.deepEqual(calls, [], "1つも書いていないこと");
});

test("日付だけなら、支払が立っていても直せる", async () => {
  const p = parts();
  const r = await new ConditionBundleService(
    db({ "FROM condition_events e WHERE e.id": [{ status: "active", blocking_no: "PY-1" }] }), p)
    .apply(3, { event: { id: 9, occurredOn: "2026-09-20" } }, "納品日の訂正", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["event"]);
});

test("無効にした条件・実績・支払は、何も書く前に止める", async () => {
  for (const [fragment, rows, message] of [
    ["FROM conditions WHERE id", [{ status: "void" }], /無効にした条件/],
    ["FROM condition_events e WHERE e.id", [{ status: "void" }], /無効にした実績/],
    ["FROM payments WHERE id", [{ status: "canceled" }], /取り消した支払/]
  ] as const) {
    const p = parts();
    await assert.rejects(
      () => new ConditionBundleService(db({ [fragment]: rows as never }), p).apply(3, patch, "訂正", "admin"),
      message);
    assert.deepEqual(calls, [], `${fragment} で止まったのに書いている`);
  }
});

test("途中で断られたら、そこで止めて どこまで書けたかを返す", async () => {
  const p = parts({
    schedules: { replace: async () => { throw new Error("予定の合計が条件の定額と合いません"); } }
  });
  const r = await new ConditionBundleService(db(), p).apply(3, patch, "訂正", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["condition"]);
  assert.equal(r.stoppedAt?.section, "schedules");
  assert.match(r.stoppedAt!.message, /予定の合計/);
  // 止まった先（実績・支払）は書かない。
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["condition"]);
});

test("実績があって版が増えたときは、増えたことを返す（黙らない）", async () => {
  // 打ち間違いを正したつもりで版が増えるのは驚く。画面がそれを言えるようにする。
  const p = parts({
    conditions: { updateEconomics: async () => ({ changed: [], resolvesThrough: [], revisedTo: 822 }) }
  });
  const r = await new ConditionBundleService(db(), p).apply(
    3, { condition: { flatAmount: 13000 } }, "訂正", "admin");
  assert.equal(r.revisedTo, 822);

  const plain = await new ConditionBundleService(db(), parts()).apply(
    3, { condition: { flatAmount: 13000 } }, "訂正", "admin");
  assert.equal(plain.revisedTo, null);
});

test("理由は必須。直す欄が無ければ断る", async () => {
  await assert.rejects(
    () => new ConditionBundleService(db(), parts()).apply(3, patch, "  ", "admin"),
    /直す理由は必須です/);
  await assert.rejects(
    () => new ConditionBundleService(db(), parts()).apply(3, {}, "訂正", "admin"),
    /直す欄がありません/);
});

test("段の名前が全部ある（画面の見出しに使う）", () => {
  for (const key of ["condition", "schedules", "event", "payment"] as const) {
    assert.ok(SECTION_LABEL[key], `${key} の名前が無い`);
  }
});

test("訂正版は、条件を直したあとに作る", async () => {
  const p = parts();
  const r = await new ConditionBundleService(db(), p).apply(
    3, { condition: { flatAmount: 95000 }, reissue: [41] }, "発注額の訂正", "admin");
  assert.deepEqual(r.applied.map((a) => a.section), ["condition", "reissue"]);
  assert.deepEqual(r.reissued, [{
    documentId: 41, documentNo: "ARC-PO-1", draftId: 941, repriced: null, needsManualFix: false
  }]);
  // 条件 → 訂正版 の順。先に作ると古い金額の下書きになる。
  assert.deepEqual(calls.map((c) => c.split(":")[0]), ["condition", "reissue"]);
});

test("条件が改訂になったら、訂正版は新しい版を指す", async () => {
  // 引き継いだままだと旧版（古い金額）を指すので、直した意味がなくなる。
  const p = parts({
    conditions: { updateEconomics: async () => ({ changed: [], resolvesThrough: [], revisedTo: 822 }) }
  });
  await new ConditionBundleService(db(), p).apply(
    3, { condition: { flatAmount: 95000 }, reissue: [41] }, "訂正", "admin");
  assert.ok(calls.includes("reissue:41:[822]"), calls.join(" / "));
});

test("改訂が無ければ、条件の紐づけはそのまま引き継ぐ", async () => {
  const p = parts();
  await new ConditionBundleService(db(), p).apply(3, { reissue: [41] }, "訂正", "admin");
  assert.ok(calls.includes("reissue:41:null"), calls.join(" / "));
});

test("決定済みでない文書・すでに訂正版がある文書は、何も書く前に止める", async () => {
  for (const [rows, message] of [
    [[{ status: "draft", document_no: "ARC-PO-1", open_draft: null }], /決定済みではない/],
    [[{ status: "issued", document_no: "ARC-PO-1", open_draft: 77 }], /もう訂正版の下書きがあります/]
  ] as const) {
    const p = parts();
    await assert.rejects(
      () => new ConditionBundleService(
        db({ "FROM documents d WHERE d.id": rows as never }), p)
        .apply(3, { condition: { flatAmount: 95000 }, reissue: [41] }, "訂正", "admin"),
      message);
    assert.deepEqual(calls, [], "止まったのに書いている");
  }
});

test("手入力の明細に金額があるかを見分ける（訂正版に引き継がれる）", () => {
  assert.equal(hasManualAmounts({}), false);
  assert.equal(hasManualAmounts({ items: [] }), false);
  assert.equal(hasManualAmounts({ items: [{ item_name: "挿絵", amount_ex_tax: "" }] }), false);
  assert.equal(hasManualAmounts({ items: [{ item_name: "挿絵", amount_ex_tax: 120000 }] }), true);
  assert.equal(hasManualAmounts({ delivery_line_items: [{ 金額: "95,000" }] }), true);
  // 金額の入っていない手入力（業務内容だけ）は引き継いでも困らない。
  assert.equal(hasManualAmounts({ items: [{ spec: "A4 カラー" }] }), false);
});

test("訂正版に引き継いだ手入力の明細を、新しい金額に引き直す", async () => {
  // 手入力は条件より強い。張り替えただけでは、紙に古い金額が載ったまま出る。
  const p = parts();
  const r = await new ConditionBundleService(db({
    "FROM document_conditions dc WHERE dc.document_id": [{
      document_no: "ARC-PO-1", condition_ids: [3],
      manual_inputs: { items: [{ item_name: "表紙イラスト", quantity: 1, unit_price: 120000, amount_ex_tax: 120000 }] }
    }]
  }), p).apply(3, { condition: { flatAmount: 95000 }, reissue: [41] }, "訂正", "admin");
  assert.equal(r.reissued[0].repriced, "表紙イラスト ¥120,000 → ¥95,000");
  assert.equal(r.reissued[0].needsManualFix, false);
});

test("引き直せない明細は、引き直さずに「人が直して」と返す", async () => {
  // 明細が2本。どの行が減ったのかは書いた人にしか分からない。
  const p = parts();
  const r = await new ConditionBundleService(db({
    "FROM document_conditions dc WHERE dc.document_id": [{
      document_no: "ARC-PO-1", condition_ids: [3],
      manual_inputs: { items: [{ item_name: "表紙", amount_ex_tax: 80000 },
                               { item_name: "口絵", amount_ex_tax: 40000 }] }
    }]
  }), p).apply(3, { condition: { flatAmount: 95000 }, reissue: [41] }, "訂正", "admin");
  assert.equal(r.reissued[0].repriced, null);
  assert.equal(r.reissued[0].needsManualFix, true);
});

test("条件を何本も載せた文書の明細は引き直さない", async () => {
  // 総額のどこがこの条件のぶんか分けられない。
  const p = parts();
  const r = await new ConditionBundleService(db({
    "FROM document_conditions dc WHERE dc.document_id": [{
      document_no: "ARC-PO-1", condition_ids: [3, 99],
      manual_inputs: { items: [{ item_name: "表紙", amount_ex_tax: 120000 }] }
    }]
  }), p).apply(3, { condition: { flatAmount: 95000 }, reissue: [41] }, "訂正", "admin");
  assert.equal(r.reissued[0].repriced, null);
  assert.equal(r.reissued[0].needsManualFix, true);
});
