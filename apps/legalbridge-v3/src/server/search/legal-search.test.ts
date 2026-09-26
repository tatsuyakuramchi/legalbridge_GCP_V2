import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { LegalSearchService } from "./legal-search.js";

const party = (over: Record<string, unknown> = {}) => ({
  id: 5, name: "株式会社甲", party_code: "PTY-5", matched_on: "正式名称と一致", via_merge: false, ...over
});

interface Rows {
  parties?: any[]; agreements?: any[]; partyDocuments?: any[]; partyMatters?: any[];
  requests?: any[]; backlog?: any[]; matters?: any[];
}
const db = (rows: Rows = {}) => new FakeDatabase((t) => {
  if (t.includes("FROM parties p")) return rows.parties ?? [];
  if (t.includes("FROM agreements a")) return rows.agreements ?? [];
  // 取引先の直近の文書・進行中の案件（統合を辿って引く）
  if (t.includes("FROM documents d") && t.includes("v_party_resolved")) return rows.partyDocuments ?? [];
  if (t.includes("FROM matters m") && t.includes("v_party_resolved")) return rows.partyMatters ?? [];
  if (t.includes("FROM intake_requests r")) return rows.requests ?? [];
  if (t.includes("target_type = 'backlog_issue'")) return rows.backlog ?? [];
  // 横断検索の案件
  if (t.includes("FROM matters m LEFT JOIN parties p")) return rows.matters ?? [];
  return undefined;
});

test("1文字では引かない（全件を舐めるだけで役に立たない）", async () => {
  const d = db();
  const r = await new LegalSearchService(d).search("甲");
  assert.equal(r.party, null);
  assert.equal(d.queries.length, 0);
});

test("取引先に1件だけ当たれば、契約チェックと同じ判定に直近の文書と進行中の案件を足す", async () => {
  const r = await new LegalSearchService(db({
    parties: [party()],
    agreements: [{ id: 1, agreement_no: "AGR-1", title: "業務委託基本契約", status: "executed", kind: "master",
                   effective_on: new Date(2025, 0, 1), expires_on: new Date(2030, 0, 1),
                   auto_renewal: false, days_to_expiry: 1000 }],
    partyDocuments: [{ document_no: "ARC-PO-2026-1001", status: "issued", issued_at: new Date(2026, 8, 1), label: "発注書" }],
    partyMatters: [{ matter_no: "MTR-2026-00012", title: "イラスト制作", status: "open" }]
  })).search("株式会社甲");

  assert.equal(r.party?.name, "株式会社甲");
  assert.equal(r.party?.verdict, "covered");
  assert.match(r.party!.message, /有効な基本契約があります/);
  assert.equal(r.party?.agreements[0].agreementNo, "AGR-1");
  assert.deepEqual(r.party?.documents[0], { documentNo: "ARC-PO-2026-1001", label: "発注書", status: "issued", issuedOn: "2026-09-01" });
  assert.equal(r.party?.openMatters[0].matterNo, "MTR-2026-00012");
});

test("取引先の候補が複数なら、名前だけ返して絞らせる（契約の状況は出さない）", async () => {
  const r = await new LegalSearchService(db({
    parties: [party(), party({ id: 6, name: "株式会社甲乙", party_code: "PTY-6", matched_on: "名称の一部が一致" })]
  })).search("甲");
  // 2文字未満なので何もしない
  assert.equal(r.party, null);

  const r2 = await new LegalSearchService(db({
    parties: [party(), party({ id: 6, name: "株式会社甲乙", party_code: "PTY-6", matched_on: "名称の一部が一致" })]
  })).search("株式会社");
  assert.equal(r2.party, null);
  assert.deepEqual(r2.partyNames, ["株式会社甲", "株式会社甲乙"]);
});

test("番号でも引ける：受付箱の依頼と Backlog の課題キー", async () => {
  const r = await new LegalSearchService(db({
    requests: [{ request_no: "REQ-2026-00003", title: "NDA の確認", state: "accepted",
                 backlog_issue_key: "LEGAL-120", matter_no: "MTR-2026-00040" }],
    backlog: [{ issue_key: "LEGAL-120", matter_no: "MTR-2026-00040", title: "NDA の確認", status: "open" }]
  })).search("LEGAL-120");
  assert.deepEqual(r.requests[0], {
    requestNo: "REQ-2026-00003", title: "NDA の確認", state: "accepted",
    matterNo: "MTR-2026-00040", backlogIssueKey: "LEGAL-120"
  });
  assert.equal(r.backlogMatters[0].matterNo, "MTR-2026-00040");
});

test("横断検索の取引先・支払は重ねない（取引先は契約の状況として出す）", async () => {
  const d = new FakeDatabase((t) => {
    if (t.includes("FROM parties\n")) return [{ id: 5, party_code: "PTY-5", name: "株式会社甲", kind: "corporate", status: "active", aliases: [] }];
    if (t.includes("FROM matters m LEFT JOIN parties p")) return [{ id: 1, matter_no: "MTR-2026-00001", title: "甲の件", kind: "single", status: "open", party: "株式会社甲" }];
    return undefined;
  });
  const r = await new LegalSearchService(d).search("甲の件");
  assert.deepEqual(r.hits.map((h) => h.target), ["matter"]);
});
