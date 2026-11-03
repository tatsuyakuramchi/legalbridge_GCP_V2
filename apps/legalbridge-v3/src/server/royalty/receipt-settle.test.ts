import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ReceiptSettleService } from "./receipt-settle.js";
import type { Receipt } from "./receipts.js";

// 許諾先（OUT 条件 20）：相手社・作品 3・自社製造・他社販売。作者 A（IN 11）は未報告、作者 B（IN 12）は計算書済。
const outRow = { id: 20, condition_no: "OUT-1", name: "ito 他社販売", usage_type: "oem", currency: "JPY", status: "active",
  direction: "out", counterparty_id: 6, licensee_name: "相手社", work_id: 3, work_title: "ito", languages: null, regions: null };
const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  key: "1:20", paymentId: 1, paymentNo: "PAY-1", paidOn: "2026-11-01", status: "paid", amount: 1_000_000, currency: "JPY",
  outConditionId: 20, outConditionNo: "OUT-1", outName: "ito 他社販売", usageType: "oem", usageLabel: "自社製造・他社販売",
  licenseePartyId: 6, licenseeName: "相手社", workId: 3, workTitle: "ito", languages: [], regions: [],
  ins: [
    { conditionId: 11, conditionNo: "IN-A", name: "作者A", partyId: 101, partyName: "作者A", workId: 3, workTitle: "ito",
      usageLabel: "自社製造・他社販売", ratePct: 5, targeted: false, reports: [], state: "unreported", reported: 0 },
    { conditionId: 12, conditionNo: "IN-B", name: "作者B", partyId: 102, partyName: "作者B", workId: 3, workTitle: "ito",
      usageLabel: "自社製造・他社販売", ratePct: 2, targeted: false, state: "issued", reported: 1_000_000,
      reports: [{ id: 90, grossAmount: 1_000_000, amount: 20_000, occurredOn: "2026-11-01", languages: [], documentId: 500, documentNo: "RS-500" }] }
  ],
  state: "unreported", media: null, ...over
});

const db = () => new FakeDatabase((text) => {
  if (text.includes("FROM conditions oc") && text.includes("WHERE oc.id = $1")) return [outRow];
  if (text.includes("FROM condition_shares s")) return [];
  if (text.includes("FROM works WHERE id = $1")) return [{ id: 3, title: "ito" }];
  return [];
});

function deps(calls: string[], current: { r: Receipt }) {
  return {
    receipts: {
      list: async () => ({ receipts: [current.r] }),
      authorsFor: async () => ({ media: null, authors: current.r.ins.map((x) => ({ ...x, usageType: "oem", targetPartyId: null, series: x.conditionId })) }),
      createReports: async (input: { entries: Array<{ conditionId: number }> }) => {
        calls.push(`reports:${input.entries.map((e) => e.conditionId).join(",")}`);
        current.r = receipt({ ins: current.r.ins.map((x) => x.conditionId === 11
          ? { ...x, state: "waiting", reports: [{ id: 91, grossAmount: 1_000_000, amount: 50_000, occurredOn: "2026-11-01", languages: [], documentId: null, documentNo: null }] }
          : x) });
        return { eventIds: [91], receipt: current.r };
      }
    },
    payments: {
      create: async (input: { conditionId?: number | null; amount: number }) => { calls.push(`pay.create:${input.conditionId}:${input.amount}`); return { id: 7, paymentNo: "PAY-7", direction: "in" as const, compliance: {} as any, conditionId: 20 }; },
      markPaid: async (id: number, paidOn: string) => { calls.push(`pay.paid:${id}:${paidOn}`); return { paymentId: id, paidOn }; },
      createFromStatementDocument: async (documentId: number) => { calls.push(`pay.fromDoc:${documentId}`); return { paymentId: 70, paymentNo: "PAY-70" } as any; }
    },
    issuer: {
      issue: async (input: { entries: Array<{ conditionId: number; eventIds?: number[] }>; issuedOn?: string | null;
                             agreementId?: number | null; manualInputs?: Record<string, unknown> }) => {
        calls.push(`issue:${input.entries[0].conditionId}:${(input.entries[0].eventIds ?? []).join(",")}:${input.issuedOn}`
          + (input.agreementId ? `:a${input.agreementId}` : "") + (input.manualInputs?._termsNo ? `:t${input.manualInputs._termsNo}` : ""));
        return { document: { id: 600, documentNo: "RS-600" } } as any;
      },
      draft: async (input: { entries: Array<{ conditionId: number }> }) => { calls.push(`draft:${input.entries[0].conditionId}`); return { id: 601 } as any; }
    },
    events: {
      addWithin: async (_c: unknown, conditionId: number, input: { quantity?: number | null; unitAmount?: number | null }) => {
        calls.push(`event:${conditionId}:${input.quantity}x${input.unitAmount}`); return { id: 95 };
      }
    }
  };
}

test("下見：記録前の入金は許諾先の作者と 受領額 × 料率 の見込みを返す", async () => {
  const calls: string[] = [];
  const svc = new ReceiptSettleService(db(), deps(calls, { r: receipt() }) as any);
  const p = await svc.preview({ usageType: "oem", outConditionId: 20, amount: 1_000_000 });
  assert.equal(p.mode, "receipt"); assert.equal(p.licenseeName, "相手社"); assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.authors.map((a) => [a.partyName, a.estimate]), [["作者A", 50_000], ["作者B", 20_000]]);
});

test("実行：入金を記録して入金済みにし、作者ぜんぶの報告 → 計算書 → 支払", async () => {
  const calls: string[] = [];
  const svc = new ReceiptSettleService(db(), deps(calls, { r: receipt() }) as any);
  const r = await svc.settle({ usageType: "oem", outConditionId: 20, amount: 1_000_000, paidOn: "2026-11-01" }, "t");
  assert.equal(r.paymentCreated, true); assert.equal(r.paymentNo, "PAY-7");
  assert.deepEqual(calls.slice(0, 3), ["pay.create:20:1000000", "pay.paid:7:2026-11-01", "reports:11,12"], "新しい入金は作者ぜんぶ未報告");
  assert.ok(calls.includes("issue:11:91:2026-11-01") && calls.includes("pay.fromDoc:600"));
  assert.deepEqual(r.rows[0] && [r.rows[0].partyName, r.rows[0].documentNo, r.rows[0].paymentNo], ["作者A", "RS-600", "PAY-70"]);
});

test("実行：記録済みの入金では、未報告の作者だけ報告し、計算書済の作者は飛ばす", async () => {
  const calls: string[] = [];
  const svc = new ReceiptSettleService(db(), deps(calls, { r: receipt() }) as any);
  const r = await svc.settle({ usageType: "oem", paymentId: 1, outConditionId: 20 }, "t");
  assert.equal(r.paymentCreated, false); assert.equal(r.paymentNo, "PAY-1");
  assert.deepEqual(calls, ["reports:11", "issue:11:91:2026-11-01", "pay.fromDoc:600"]);
  assert.deepEqual(r.rows.map((x) => [x.partyName, x.documentNo, x.paymentNo, x.skipped]),
                   [["作者A", "RS-600", "PAY-70", null], ["作者B", "RS-500", null, "計算書済"]]);
});

test("実行：記録済みの入金からは入金を作らない。下書きで止めると決定・支払はしない", async () => {
  const calls: string[] = [];
  const svc = new ReceiptSettleService(db(), deps(calls, { r: receipt() }) as any);
  const r = await svc.settle({ usageType: "oem", paymentId: 1, outConditionId: 20, draftOnly: true, authors: [11] }, "t");
  assert.equal(r.paymentCreated, false);
  assert.deepEqual(calls, ["reports:11", "draft:11"]);
  assert.deepEqual(r.rows.map((x) => [x.partyName, x.documentId, x.draft]), [["作者A", 601, true]]);
});

test("止める理由：取引モデルが違う条件・作者のいない許諾先", async () => {
  const calls: string[] = [];
  const base = new FakeDatabase((text) => {
    if (text.includes("FROM conditions oc") && text.includes("WHERE oc.id = $1")) return [{ ...outRow, usage_type: "pub_print" }];
    return [];
  });
  const p = await new ReceiptSettleService(base, deps(calls, { r: receipt({ ins: [] }) }) as any).preview({ outConditionId: 20, amount: 1 });
  assert.ok(p.blockers.some((b) => b.includes("取引モデル")));
  assert.ok(p.blockers.some((b) => b.includes("作者の条件（IN）が見つかりません")));
  await assert.rejects(() => new ReceiptSettleService(base, deps(calls, { r: receipt({ ins: [] }) }) as any)
    .settle({ outConditionId: 20, amount: 1 }, "t"), /取引モデル/);
});

test("自社製造・自社販売：OUT 先なし。作品の in_house の作者に 数量 × 基準価格 の報告を立てて計算書", async () => {
  const calls: string[] = [];
  const base = new FakeDatabase((text, params) => {
    if (text.includes("FROM works WHERE id = $1")) return [{ id: 3, title: "ito" }];
    if (text.includes("c.usage_type = 'in_house'")) {
      assert.equal(params[0], 3);
      return [{ id: 13, condition_no: "IN-H", name: "作者A 自社販売", counterparty_id: 101, party_name: "作者A", work_id: 3, work_title: "ito", rate_ppm: 30000, target_party_id: null }];
    }
    return [];
  });
  const svc = new ReceiptSettleService(base, deps(calls, { r: receipt() }) as any);
  const p = await svc.preview({ usageType: "in_house", workId: 3, quantity: 100, unitAmount: 5000 });
  assert.equal(p.mode, "in_house"); assert.equal(p.amount, 500_000);
  assert.deepEqual(p.authors.map((a) => [a.partyName, a.ratePct, a.estimate]), [["作者A", 3, 15_000]]);
  await assert.rejects(() => svc.settle({ usageType: "in_house", workId: 3, amount: 500_000 }, "t"), /数量/);
  const r = await svc.settle({ usageType: "in_house", workId: 3, quantity: 100, unitAmount: 5000, paidOn: "2026-11-02" }, "t");
  assert.equal(r.paymentCreated, false);
  assert.deepEqual(calls, ["event:13:100x5000", "issue:13:95:2026-11-02", "pay.fromDoc:600"]);
});

test("複数の入金（前金・後金）：入金ごとに記録・報告し、作者 1 人の計算書 1 枚に全部の報告を並べる", async () => {
  const calls: string[] = [];
  let seq = 0;
  const current = { r: receipt({ ins: [receipt().ins[0]] }) };
  const d = deps(calls, current) as any;
  d.payments.create = async (input: { amount: number }) => { seq += 1; calls.push(`pay.create:${input.amount}`); return { id: seq, paymentNo: `PAY-${seq}` }; };
  d.receipts.createReports = async (input: { paymentId: number; entries: Array<{ paymentStage?: string | null }> }) => {
    const id = 900 + input.paymentId;
    calls.push(`reports:p${input.paymentId}:${input.entries[0].paymentStage}`);
    current.r = receipt({ paymentId: input.paymentId, ins: [{ ...receipt().ins[0], state: "waiting",
      reports: [{ id, grossAmount: 1, amount: 1, occurredOn: null, languages: [], documentId: null, documentNo: null }] }] });
    return { eventIds: [id], receipt: current.r };
  };
  const svc = new ReceiptSettleService(db(), d);
  const pre = await svc.previewMany({ receipts: [
    { usageType: "oem", outConditionId: 20, amount: 600_000, paidOn: "2026-10-01", paymentStage: "advance" },
    { usageType: "oem", outConditionId: 20, amount: 400_000, paidOn: "2026-11-01", paymentStage: "balance" }
  ] });
  assert.equal(pre.authors.length, 1); assert.equal(pre.authors[0].estimate, 50_000, "見込みは合計"); assert.equal(pre.authors[0].receiptCount, 2);
  const r = await svc.settleMany({ receipts: [
    { usageType: "oem", outConditionId: 20, amount: 600_000, paidOn: "2026-10-01", paymentStage: "advance" },
    { usageType: "oem", outConditionId: 20, amount: 400_000, paidOn: "2026-11-01", paymentStage: "balance" }
  ] }, "t");
  assert.equal(r.payments.length, 2);
  assert.ok(calls.includes("reports:p1:advance") && calls.includes("reports:p2:balance"));
  assert.ok(calls.includes("issue:11:901,902:2026-11-01"), `1 枚に両方の報告、決定日は遅い入金日: ${calls.join(" ")}`);
  assert.equal(calls.filter((c) => c.startsWith("issue:")).length, 1, "計算書は作者 1 人に 1 枚");
  assert.deepEqual(r.rows.map((x) => [x.partyName, x.eventIds, x.documentNo]), [["作者A", [901, 902], "RS-600"]]);
});

test("複数の入金：2 件目の入力が足りなければ、1 件目も書かずに止める", async () => {
  const calls: string[] = [];
  const svc = new ReceiptSettleService(db(), deps(calls, { r: receipt() }) as any);
  await assert.rejects(() => svc.settleMany({ receipts: [
    { usageType: "oem", outConditionId: 20, amount: 600_000 }, { usageType: "oem", outConditionId: 20 }
  ] }, "t"), /入金 2：入金額/);
  assert.deepEqual(calls, []);
});

test("作者ごとの契約の選び直し（基本契約・個別契約番号）は計算書に渡る。下見は自動の契約（空なら契約未指定）を返す", async () => {
  const calls: string[] = [];
  const svc = new ReceiptSettleService(db(), deps(calls, { r: receipt() }) as any);
  const p = await svc.preview({ usageType: "oem", outConditionId: 20, amount: 1 });
  assert.deepEqual(p.authors[0].contract, { title: "", number: "" }, "契約の無い作者は空（紙は契約未指定）");
  await svc.settleMany({ receipts: [{ usageType: "oem", paymentId: 1, outConditionId: 20 }], authors: [11],
                         contracts: [{ conditionId: 11, agreementId: 77, termsNo: "ARC-ILT-2026-0001" }] }, "t");
  assert.ok(calls.includes("issue:11:91:2026-11-01:a77:tARC-ILT-2026-0001"), calls.join(" "));
});

test("計算書の備考（statementNotes）は手入力 notes として計算書に渡る", async () => {
  const calls: string[] = [];
  const d = deps(calls, { r: receipt() }) as any;
  let seen: Record<string, unknown> | undefined;
  d.issuer.issue = async (input: { manualInputs?: Record<string, unknown> }) => { seen = input.manualInputs; return { document: { id: 600, documentNo: "RS-600" } }; };
  await new ReceiptSettleService(db(), d).settleMany({ receipts: [{ usageType: "oem", paymentId: 1, outConditionId: 20 }], authors: [11],
                                                       statementNotes: "振込手数料は当社負担" }, "t");
  assert.equal(seen?.notes, "振込手数料は当社負担");
});
