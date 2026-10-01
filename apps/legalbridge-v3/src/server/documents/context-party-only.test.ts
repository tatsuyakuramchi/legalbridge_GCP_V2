import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentContextRepository } from "./context-repository.js";

/** 条件の無い文書（基本契約書）の相手先は契約か案件から引く。 */
const db = (over: { agreement?: Record<string, unknown> | null; matter?: Record<string, unknown> | null } = {}) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM agreements a")) return over.agreement === null ? [] : [{
      id: 7, agreement_no: "ARC-LIC-2026-0007", title: "利用許諾基本契約", direction: "in", status: "executed",
      executed_on: "2026-04-01", effective_on: "2026-04-01", expires_on: "2029-03-31",
      auto_renewal: true, renewal_notice_months: 3, renewal_months: 12, counterparty_id: 3,
      party_name: "合同会社アトリエ蒼", party_kind: "corporate", ...(over.agreement ?? {})
    }];
    if (t.includes("FROM matters m LEFT JOIN staff")) return over.matter === null ? [] : [{
      id: 9, matter_no: "MTR-1", title: "星降る夜のミュゼ 権利取得", kind: "work", work_id: 5, counterparty_id: 3, owner_name: "倉持",
      ...(over.matter ?? {})
    }];
    if (t.includes("FROM parties p WHERE p.id = $1")) return [{
      party_name: "合同会社アトリエ蒼", party_kana: "アトリエアオ", party_kind: "corporate", party_invoice_no: "T1", party_corporate_no: null,
      party_withholding: false, party_row: { address: "東京都", representative_title: "代表社員", representative_name: "青柳 みなも" }
    }];
    if (t.includes("FROM settings")) return [];
    return [];
  });

test("条件が無くても、契約の相手先と期間が条件の形で入る（基本契約書の Licensor・期間が埋まる）", async () => {
  const ctx = await new DocumentContextRepository(db()).build({ conditionIds: [], agreementId: 7, matterId: 9 });
  assert.equal(ctx.conditions.length, 1);
  const c = ctx.condition!;
  assert.equal(c.counterparty.name, "合同会社アトリエ蒼");
  assert.equal(c.counterparty.representativeName, "青柳 みなも");
  assert.equal(c.counterparty.address, "東京都");
  assert.equal(c.termStart, "2026-04-01"); assert.equal(c.termEnd, "2029-03-31");
  assert.equal(c.autoRenew, true); assert.equal(c.renewMonths, 12);
  assert.equal((c as any).partyOnly, true);
  assert.equal(ctx.totals.exTax, 0);
});

test("契約が無ければ案件の相手先。どちらも無ければ条件なしのまま", async () => {
  const ctx = await new DocumentContextRepository(db({ agreement: null })).build({ conditionIds: [], matterId: 9 });
  assert.equal(ctx.condition?.counterparty.name, "合同会社アトリエ蒼");
  assert.equal(ctx.condition?.termStart, null);
  const none = await new DocumentContextRepository(db({ agreement: null, matter: null })).build({ conditionIds: [] });
  assert.equal(none.condition, null);
});
