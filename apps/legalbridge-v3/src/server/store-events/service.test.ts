import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { StoreEventService } from "./service.js";

/** 店舗 2（大宮）に取引先 7（個人）が担当で載っている DB。基本契約の状態だけ変えられる。 */
function db(opts: { executed?: Array<{ id: number; agreement_no: string }>; setting?: { agreement_mode: string; agreement_id: number | null };
                    fixed?: { id: number; counterparty_id: number }; matter?: boolean } = {}) {
  return new FakeDatabase((text, params) => {
    if (text.includes("FROM parties WHERE id")) return [{ id: 7, name: "大滝昂", kind: "individual", status: "active" }];
    if (text.includes("FROM event_stores WHERE id = ANY")) return [{ id: 2, name: "ホビーステーション大宮店", short_name: "HBST大宮" }];
    if (text.includes("FROM event_store_judges WHERE party_id")) return (params[1] as number[]).includes(2) ? [{ store_id: 2 }] : [];
    if (text.includes("FROM matters") && text.includes("business_name")) return opts.matter ? [{ id: 40, matter_no: "MTR-1", title: "店舗事業｜大滝昂｜店舗イベント審判業務" }] : [];
    if (text.includes("FROM event_judge_settings")) return opts.setting ? [opts.setting] : [];
    if (text.includes("FROM agreements WHERE id")) return opts.fixed ? [{ ...opts.fixed, agreement_no: "AG-9", title: "業務委託基本契約", status: "executed" }] : [];
    if (text.includes("status = 'executed' ORDER BY")) return (opts.executed ?? []).map((a) => ({ ...a, title: "業務委託基本契約", status: "executed" }));
    return undefined;
  });
}

const days = [
  { date: "2026-11-18", startTime: "12:00", eventName: "氷星杯", storeId: 2, feeIncTax: 12000, travelIncTax: 502 },
  { date: "2026-11-25", startTime: "12:00", eventName: "氷星杯", storeId: 2, feeIncTax: 12000, travelIncTax: 502 }
];

function stubs() {
  const calls: Record<string, any[]> = { serviceSet: [], schedules: [], matter: [], draft: [] };
  return {
    calls,
    deps: {
      conditions: { createServiceSet: async (input: any) => {
        calls.serviceSet.push(input);
        return { conditions: input.rows.map((_: unknown, i: number) => ({ id: 100 + i, conditionNo: `C-${100 + i}` })), licenseConditions: [], scheduled: 0 };
      } } as any,
      schedules: { replace: async (id: number, lines: any[]) => { calls.schedules.push({ id, lines }); } } as any,
      matters: { create: async (input: any) => { calls.matter.push(input); return { id: 41, matterNo: "MTR-2" }; } } as any,
      issues: { createDraft: async (input: any) => { calls.draft.push(input); return { id: 500 }; } } as any
    }
  };
}

test("基本契約：締結済みが 1 本なら自動で載せる", async () => {
  const s = new StoreEventService(db({ executed: [{ id: 3, agreement_no: "AG-3" }], matter: true }));
  const p = await s.preview({ partyId: 7, days });
  assert.deepEqual(p.issues, []);
  assert.equal(p.agreement?.id, 3);
});

test("基本契約：無ければ基本契約なし（標準約款）で作れる", async () => {
  const s = new StoreEventService(db({ matter: true }));
  const p = await s.preview({ partyId: 7, days });
  assert.deepEqual(p.issues, []);
  assert.equal(p.agreement, null);
  assert.match(p.agreementNote, /標準約款/);
});

test("基本契約：複数あるときは選ばせる。人の設定（なし）があればそれ", async () => {
  const many = [{ id: 3, agreement_no: "AG-3" }, { id: 4, agreement_no: "AG-4" }];
  const p1 = await new StoreEventService(db({ executed: many, matter: true })).preview({ partyId: 7, days });
  assert.ok(p1.issues.some((i) => /複数/.test(i)));
  const p2 = await new StoreEventService(db({ executed: many, matter: true, setting: { agreement_mode: "none", agreement_id: null } }))
    .preview({ partyId: 7, days });
  assert.deepEqual(p2.issues, []);
  assert.equal(p2.agreement, null);
  assert.match(p2.agreementNote, /この人の設定/);
  // この 1 枚の指定が人の設定より強い
  const p3 = await new StoreEventService(db({ executed: many, matter: true, setting: { agreement_mode: "none", agreement_id: null },
    fixed: { id: 4, counterparty_id: 7 } })).preview({ partyId: 7, days, agreement: { mode: "fixed", agreementId: 4 } });
  assert.equal(p3.agreement?.id, 4);
  assert.match(p3.agreementNote, /この発注書の指定/);
});

test("基本契約：別の取引先の契約は載せない", async () => {
  const p = await new StoreEventService(db({ matter: true, fixed: { id: 4, counterparty_id: 99 } }))
    .preview({ partyId: 7, days, agreement: { mode: "fixed", agreementId: 4 } });
  assert.ok(p.issues.some((i) => /この取引先の契約ではありません/.test(i)));
});

test("担当でない店舗の発注は止める", async () => {
  const p = await new StoreEventService(db({ matter: true })).preview({ partyId: 7, days: [{ ...days[0], storeId: 5 }] });
  assert.ok(p.issues.some((i) => /担当に登録されていません/.test(i)));
});

test("案件が無く担当者も無ければ止める", async () => {
  const p = await new StoreEventService(db()).preview({ partyId: 7, days });
  assert.ok(p.issues.some((i) => /担当者を選んでください/.test(i)));
});

test("下書きを作る：委託料 1 本（2 日）＋交通費 1 本、予定は行ごと、経費は日ごと、基本契約を載せる", async () => {
  const { calls, deps } = stubs();
  const s = new StoreEventService(db({ executed: [{ id: 3, agreement_no: "AG-3" }] }), deps);
  const r = await s.createOrder({ partyId: 7, days, ownerStaffId: 11 }, "tester");
  assert.equal(r.documentId, 500);
  assert.equal(r.matterCreated, true);
  assert.equal(calls.matter[0].businessName, "店舗イベント審判業務");
  assert.equal(calls.matter[0].ownerStaffId, 11);

  const set = calls.serviceSet[0];
  assert.equal(set.agreementId, 3);
  assert.equal(set.matterId, 41);
  assert.equal(set.title, "ホビステ11月開催ジャッジ業務");
  assert.equal(set.rows.length, 2);
  assert.equal(set.rows[0].kind, "service");
  assert.equal(set.rows[0].name, "審判業務（氷星杯 2日‗HBST大宮）");
  assert.equal(set.rows[0].flatAmount, 21818);
  assert.equal(set.rows[1].kind, "expense");
  assert.equal(set.rows[1].flatAmount, 1004);

  assert.equal(calls.schedules.length, 1);
  assert.equal(calls.schedules[0].lines[0].plannedAmount, 21818);
  assert.equal(calls.schedules[0].lines[0].payOn, "2026-12-20");

  const draft = calls.draft[0];
  assert.equal(draft.templateKey, "purchase_order");
  assert.equal(draft.agreementId, 3);
  assert.deepEqual(draft.conditionIds, [100, 101]);
  assert.equal(draft.manualInputs.PROJECT_TITLE, "ホビステ11月開催ジャッジ業務");
  assert.equal(draft.manualInputs.items.length, 1);
  assert.equal(draft.manualInputs.items[0].quantity, 2);
  assert.equal(draft.manualInputs.items[0].unit_price, 10909);
  assert.deepEqual(draft.manualInputs.expenses.map((e: any) => [e.spent_date, e.amount_inc_tax, e.condition_id]),
    [["2026-11-18", 502, 101], ["2026-11-25", 502, 101]]);
});

test("下書きを作る：交通費なし・基本契約なし・開いている案件に載せる", async () => {
  const { calls, deps } = stubs();
  const s = new StoreEventService(db({ matter: true }), deps);
  const r = await s.createOrder({ partyId: 7, days: days.map((d) => ({ ...d, travelIncTax: null })) }, "tester");
  assert.equal(r.matterId, 40);
  assert.equal(calls.matter.length, 0);
  assert.equal(calls.serviceSet[0].rows.length, 1);
  assert.equal(calls.serviceSet[0].agreementId, null);
  assert.equal(calls.draft[0].agreementId, null);
  assert.deepEqual(calls.draft[0].manualInputs.expenses, []);
});

test("不備があれば何も作らない", async () => {
  const { calls, deps } = stubs();
  const s = new StoreEventService(db({ matter: true }), deps);
  await assert.rejects(s.createOrder({ partyId: 7, days: [] }, "tester"), /開催日/);
  assert.equal(calls.serviceSet.length, 0);
  assert.equal(calls.draft.length, 0);
});
