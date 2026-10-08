import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FakeDatabase } from "../core/fake-db.js";
import { publishingStatementPatch, royaltyStatementPatch, type BundleLine } from "../documents/royalty-patch.js";
import { renderDocumentHtml } from "../documents/render.js";
import { isPublishingBundle, PUB_STATEMENT_KEY, StatementIssuer } from "./statement-issue.js";
import { isRoyaltyStatementKey } from "../documents/settlement-docs.js";

/** 出版の行（電子 2 作品・紙 1 作品）。額は行ごとに切り捨て済み（事業部の Excel と同じ）。 */
const line = (over: Partial<BundleLine>): BundleLine => ({
  conditionId: 7, eventId: 1, contractTitle: "", contractNumber: "ARC-PUBT-2026-1006", conditionName: "",
  methodLabel: "売上報告ベース", salesJpy: 0, ratePct: 15, paymentJpy: 0, basisNote: "",
  masterNumber: "ATT-2026-00069", media: "電子", workTitle: "ケダモノオペラ", ...over
});
const LINES: BundleLine[] = [
  line({ eventId: 1, period: "2025年4月分", store: "Kindle", unitPrice: 1980, quantity: 7, salesJpy: 13860, paymentJpy: 2079 }),
  line({ eventId: 2, period: "2025年3月分", store: "DLsite", unitPrice: 1980, quantity: 5, salesJpy: 9900, paymentJpy: 1485 }),
  line({ eventId: 3, period: "2026年8月分", store: "BOOKWALKER", unitPrice: 2200, quantity: 3, salesJpy: 6600, paymentJpy: 990,
         workTitle: "ケダモノオペラ　サプリメント　花嫁", contractNumber: "ARC-PUBT-2026-1007" }),
  line({ eventId: 4, conditionId: 8, media: "紙", period: null, occurredOn: "2025-11-30", store: null, unitPrice: 3300,
         quantity: 900, salesJpy: 2970000, ratePct: 10, paymentJpy: 297000, basisNote: "対象期間 2025年11月分・第3刷" })
];

test("出版の計算書：作品 × 媒体で要約 1 行。集計期間は報告月の端、数量・売上・許諾料は合計", () => {
  const p = publishingStatementPatch(LINES, { tax: 30155, withholding: 30789, netTransfer: null });
  const works = p.pubWorks as Array<Record<string, unknown>>;
  assert.deepEqual(works.map((w) => [w.title, w.media, w.period, w.quantityStr, w.salesStr, w.rate, w.feeStr, w.rowCount]), [
    ["ケダモノオペラ", "電子", "2025年3月分〜2025年4月分", "12", "23,760", "15%", "3,564", 2],
    ["ケダモノオペラ", "紙", "2025年11月分", "900", "2,970,000", "10%", "297,000", 1],
    ["ケダモノオペラ　サプリメント　花嫁", "電子", "2026年8月分", "3", "6,600", "15%", "990", 1]
  ]);
  assert.equal(p.pubPeriodLabel, "2025年3月分〜2026年8月分");
  assert.equal(p.pubMediaLabel, "紙媒体出版・電子書籍配信");
  assert.equal(p.pubMasterNo, "ATT-2026-00069");
  assert.equal(p.pubTermsNo, "ARC-PUBT-2026-1006・ARC-PUBT-2026-1007");
  assert.equal(p.pubTotalFeeStr, "301,554");
  assert.equal(p.pubTotalIncTaxStr, "331,709");
  assert.equal(p.pubHasWithholding, true);
  assert.equal(p.pubNetTransferStr, "300,920", "差引振込額＝税込 − 源泉");

  // 別紙：作品ごとに報告月順、最初の行だけ作品名、紙は但し書き。
  const annex = p.pubAnnex as Array<{ title: string; rows: Array<Record<string, unknown>>; subtotalFeeStr: string }>;
  assert.deepEqual(annex[0].rows.map((r) => [r.first, r.period, r.detail, r.unitPriceStr, r.quantityStr, r.feeStr]), [
    [true, "2025年3月分", "DLsite", "1,980", "5", "1,485"],
    [false, "2025年4月分", "Kindle", "1,980", "7", "2,079"]
  ]);
  assert.equal(annex[0].subtotalFeeStr, "3,564");
  assert.deepEqual([annex[1].rows[0].period, annex[1].rows[0].detail], ["2025-11-30", "第3刷"]);
});

test("出版でない行だけなら何も足さない。源泉の無い相手は差引の行を出さない", () => {
  assert.deepEqual(publishingStatementPatch([line({ media: null })], { tax: 0, withholding: 0, netTransfer: null }), {});
  const p = publishingStatementPatch([LINES[0]], { tax: 207, withholding: 0, netTransfer: null });
  assert.equal(p.pubHasWithholding, false);
});

test("焼き付けた行から本文を組むと、出版の変数も入る（源泉と差引振込額は試算の値）", () => {
  const p = royaltyStatementPatch({}, {
    statementMode: "bundle", rs_bundle_lines: LINES, rs_bundle_tax: 30155,
    rs_bundle_withholding: 30789, rs_bundle_net_transfer: 300920
  })!;
  assert.equal(p.pubStatement, true);
  assert.equal(p.pubTaxStr, "30,155");
  assert.equal(p.pubNetTransferStr, "300,920");
  assert.equal((p.pubWorks as unknown[]).length, 3);
});

test("ひな形（164）：本文に要約、別紙に明細。宛名の登録番号・振込先・作成者の登録番号を刷る", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(path.resolve(here, "../../../../../infra/v3/164_royalty_statement_pub.sql"), "utf8");
  const html = sql.split("$html$")[1];
  assert.ok(html.includes("<!-- royalty_statement_pub r1 -->"));
  const values = {
    ...royaltyStatementPatch({}, { rs_bundle_lines: LINES, rs_bundle_tax: 30155, rs_bundle_withholding: 30789, rs_bundle_net_transfer: 300920 })!,
    DOC_NO: "ARC-ROY-2026-0151", documentDate: "2026-10-08", PAYMENT_DATE: "2026-10-31",
    VENDOR_NAME: "岩﨑 亮馬", VENDOR_SUFFIX: "様", VENDOR_INVOICE_NO: "T1234567890123",
    BANK_INFO: "三井住友銀行 渋谷支店 普通 1234567 イワサキ リョウマ",
    COMPANY_NAME: "株式会社アークライト", COMPANY_ADDRESS: "東京都千代田区○○ 1-2-3", COMPANY_INVOICE_NO: "T0000000000000"
  };
  const out = renderDocumentHtml(html, values);
  for (const want of ["岩﨑 亮馬 様", "登録番号　T1234567890123", "ARC-ROY-2026-0151", "基本契約番号", "ATT-2026-00069",
                      "別紙1　明細", "ケダモノオペラ（電子）", "同上", "第3刷", "2026年10月31日",
                      "三井住友銀行 渋谷支店", "登録番号 T0000000000000", "仕入明細書", "▲¥30,789", "¥300,920"]) {
    assert.ok(out.includes(want), `本文に「${want}」が無い`);
  }
  assert.ok(!/{{|}}/.test(out), "差し込み漏れ");
  // 登録番号の無い相手・振込先の無い相手。
  const bare = renderDocumentHtml(html, { ...values, VENDOR_INVOICE_NO: "", BANK_INFO: "" });
  assert.ok(bare.includes("登録番号　なし"));
  assert.ok(bare.includes("振込先の登録がありません"));
});

test("ひな形の選択：従来の計算書を指定していても、出版だけの束で出版専用が登録済みなら出版専用", async () => {
  assert.equal(isPublishingBundle(LINES), true);
  assert.equal(isPublishingBundle([...LINES, line({ media: null })]), false);
  const issuer = (registered: boolean) => new StatementIssuer(
    new FakeDatabase((t) => t.includes("FROM document_templates") ? (registered ? [{ "?column?": 1 }] : []) : undefined),
    { royalty: {} as any, issues: {} as any });
  assert.equal(await issuer(true).templateFor("royalty_statement", LINES), PUB_STATEMENT_KEY);
  assert.equal(await issuer(false).templateFor("royalty_statement", LINES), "royalty_statement", "164 を流す前は従来のまま");
  assert.equal(await issuer(true).templateFor("royalty_statement", [line({ media: null })]), "royalty_statement");
  assert.equal(await issuer(true).templateFor("inspection_certificate", LINES), "inspection_certificate");
  assert.ok(isRoyaltyStatementKey(PUB_STATEMENT_KEY) && isRoyaltyStatementKey("royalty_statement"));
});

test("発行：試算 → 行と源泉を焼き付けた下書き → 決定日つきで決定 → 計算書を結ぶ。結べなければ文書を無効にする", async () => {
  const calls: Array<[string, unknown]> = [];
  const preview = { condition: { id: 7, currency: "JPY", counterpartyId: 5 }, payee: null, shares: null, events: [],
                    fee: { actual_ex_tax: 90000, tax_amount: 9000, total_inc_tax: 99000 },
                    payment: { withholdingTax: 9189, netTransfer: 89811 }, amounts: { netMinor: 90000 },
                    reported: { salesInput: 600000 } };
  const issuer = new StatementIssuer(new FakeDatabase(() => []), {
    royalty: {
      preview: async () => preview as any,
      finalizeAll: async (inputs: unknown) => { calls.push(["finalize", inputs]); return [] as any; }
    },
    issues: {
      createDraft: async (input: unknown) => { calls.push(["draft", input]); return { id: 55 }; },
      issue: async (id: number, _a: string, extra: unknown) => { calls.push(["issue", extra]); return { id, documentNo: "ARC-ROY-2026-1101" } as any; },
      void: async (id: number) => { calls.push(["void", id]); return {} as any; }
    }
  });
  (issuer as any).lines = async () => LINES;
  const out = await issuer.issue({ templateKey: "royalty_statement", entries: [{ conditionId: 7, eventIds: [51, 52] }],
                                   issuedOn: "2026-08-31" }, "tester");
  const draft = calls.find(([k]) => k === "draft")![1] as Record<string, any>;
  assert.equal(draft.manualInputs.rs_bundle_withholding, 9189);
  assert.equal(draft.manualInputs.rs_bundle_net_transfer, 89811);
  assert.equal(draft.manualInputs.rs_bundle_lines.length, 4);
  assert.deepEqual(calls.find(([k]) => k === "issue")![1], { eventIds: [51, 52], issuedOn: "2026-08-31" });
  assert.equal(out.document.documentNo, "ARC-ROY-2026-1101");

  // 結べなければ無効にして投げる。
  const failing = new StatementIssuer(new FakeDatabase(() => []), {
    royalty: { preview: async () => preview as any, finalizeAll: async () => { throw new Error("結べない"); } },
    issues: { createDraft: async () => ({ id: 56 }), issue: async (id: number) => ({ id, documentNo: "x" }) as any,
              void: async (id: number) => { calls.push(["void", id]); return {} as any; } }
  });
  (failing as any).lines = async () => LINES;
  await assert.rejects(failing.issue({ entries: [{ conditionId: 7, eventIds: [1] }] }, "t"), /結べない/);
  assert.ok(calls.some(([k, v]) => k === "void" && v === 56));
});
