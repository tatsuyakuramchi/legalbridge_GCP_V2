import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { amountOf, MailDraftService } from "./mail-draft.js";

const build = (over: { doc?: Record<string, any>; contacts?: any[]; requester?: any; settings?: any[] } = {}) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM documents d")) return [{
      id: 5, document_no: "ARC-IC-2026-1001", status: "issued", issued_at: "2026-09-27",
      matter_id: 9, rendered_values: { grandTotalPayableStr: "110000" }, counterparty: "株式会社甲",
      counterparty_id: 3, template_key: "inspection_certificate", template_label: "検収書",
      matter_no: "MTR-2026-00012", matter_title: "イラスト制作", owner_staff_id: 1,
      requester_email: "biz@example.com", ...over.doc
    }];
    if (t.includes("FROM settings")) return over.settings ?? [{ key: "company_profile", value: { name: "株式会社アークライト" } }];
    if (t.includes("FROM staff WHERE id")) return [{ name: "法務 太郎", email: "legal@example.com" }];
    if (t.includes("FROM staff WHERE lower(email)")) return over.requester === undefined ? [{ name: "事業 花子", email: "biz@example.com" }] : over.requester;
    if (t.includes("FROM party_contacts")) return over.contacts ?? [
      { name: "甲 一郎", email: "ichiro@kou.example", roles: ["primary"] },
      { name: "甲 経理", email: "keiri@kou.example", roles: ["billing"] }
    ];
    if (t.includes("FROM parties")) return [{ email: "info@kou.example" }];
    return undefined;
  });

test("担当者への確認は依頼者へ、法務の担当を cc に", async () => {
  const d = await new MailDraftService(build()).draft(5, "owner_check");
  assert.deepEqual(d.to.map((p) => p.email), ["biz@example.com"]);
  assert.deepEqual(d.cc.map((p) => p.email), ["legal@example.com"]);
  assert.match(d.body, /^事業 花子 さん/);
  assert.match(d.subject, /内容確認のお願い.*検収書（ARC-IC-2026-1001）株式会社甲/);
});

test("取引先への内容確認は主担当へ、依頼者を cc に", async () => {
  const d = await new MailDraftService(build()).draft(5, "party_check");
  assert.deepEqual(d.to.map((p) => p.email), ["ichiro@kou.example"]);
  assert.deepEqual(d.cc.map((p) => p.email), ["biz@example.com"]);
  assert.match(d.body, /株式会社甲 御中\n甲 一郎 様/);
  assert.match(d.body, /クラウドサイン/);
});

test("検収書の送付は請求先へ、検収書の文面と金額で", async () => {
  const d = await new MailDraftService(build()).draft(5, "delivery");
  assert.equal(d.kind, "inspection");
  assert.deepEqual(d.to.map((p) => p.email), ["keiri@kou.example"]);
  assert.match(d.subject, /検収書のご送付（ARC-IC-2026-1001）/);
  assert.match(d.body, /検収金額：¥110,000/);
  assert.match(d.body, /発行日　：2026年9月27日/);
});

test("利用許諾計算書は計算書の文面で", async () => {
  const d = await new MailDraftService(build({ doc: { template_key: "royalty_statement", template_label: "利用許諾計算書",
    rendered_values: { totalPaymentStr: "¥55,000" } } })).draft(5, "delivery");
  assert.equal(d.kind, "royalty");
  assert.match(d.body, /利用許諾料額：¥55,000/);
});

test("取引先に連絡先が無ければ取引先のメール、それも無ければ警告", async () => {
  const d = await new MailDraftService(build({ contacts: [] })).draft(5, "party_check");
  assert.deepEqual(d.to.map((p) => p.email), ["info@kou.example"]);
  assert.doesNotMatch(d.body, /^\s*様\s*$/m, "宛名が無ければ「様」だけの行を出さない");
});

test("依頼者が居なければ法務の担当を宛先にし、選び直すよう知らせる", async () => {
  const d = await new MailDraftService(build({ doc: { requester_email: null } })).draft(5, "owner_check");
  assert.deepEqual(d.to.map((p) => p.email), ["legal@example.com"]);
  assert.ok(d.warnings.some((w) => /依頼者のメールが無い/.test(w)));
});

test("保存した文面を使う", async () => {
  const d = await new MailDraftService(build({ settings: [
    { key: "mail_templates", value: { templates: { inspection: { subject: "検収 {文書番号}", body: "{相手先} 様" } } } }
  ] })).draft(5, "delivery");
  assert.equal(d.subject, "検収 ARC-IC-2026-1001");
  assert.equal(d.body, "株式会社甲 様");
});

test("金額は整形済みを優先し、数だけなら桁区切りに", () => {
  assert.equal(amountOf({ grandTotalPayableStr: "¥1,000" }), "¥1,000");
  assert.equal(amountOf({ totalAmount: 250000 }), "¥250,000");
  assert.equal(amountOf({}), "");
});

test("取引先へのメールには、設定のいつも入れる cc（経理）を足す。担当者への確認には足さない", async () => {
  const settings = [{ key: "mail_templates", value: { partyCc: ["keiri@example.com"] } }];
  const party = await new MailDraftService(build({ settings })).draft(5, "delivery");
  assert.deepEqual(party.cc.map((p) => p.email), ["biz@example.com", "keiri@example.com"]);
  const owner = await new MailDraftService(build({ settings })).draft(5, "owner_check");
  assert.ok(!owner.cc.some((p) => p.email === "keiri@example.com"));
});

// ---- 案件の無い文書（デイリータスクで作ったもの。A-064） ----

const daily = (over: Record<string, any> = {}) => new FakeDatabase((t) => {
  if (t.includes("FROM documents d")) return [{
    id: 8, document_no: "NDA-2026-0120", status: "issued", issued_at: "2026-10-01",
    matter_id: null, rendered_values: {}, counterparty: null, counterparty_id: null,
    template_key: "nda", template_label: "秘密保持契約書",
    matter_no: null, matter_title: null, owner_staff_id: null, requester_email: null, requester_slack_id: null
  }];
  if (t.includes("FROM intake_request_links l")) return over.origin === undefined ? [{
    request_no: "REQ-2026-00012", request_title: "NDA の依頼", requester_email: null, requester_slack_id: "U123",
    requester_name: "開発 太郎", counterparty_id: 3, counterparty_name: "取引先E",
    task_title: "秘密保持契約（当社ひな形）の締結", assignee_staff_id: 1, ...over.request
  }] : over.origin;
  if (t.includes("FROM settings")) return [{ key: "company_profile", value: { name: "株式会社アークライト" } }];
  if (t.includes("FROM staff WHERE id")) return [{ name: "法務 太郎", email: "legal@example.com" }];
  if (t.includes("FROM staff WHERE lower(email)")) return [];
  if (t.includes("FROM staff WHERE slack_user_id")) return over.slackStaff ?? [{ name: "開発 太郎", email: "dev@example.com" }];
  if (t.includes("FROM party_contacts")) return [];
  if (t.includes("FROM parties")) return [{ email: "info@e.example" }];
  return undefined;
});

test("案件の無い文書は、繋がっている依頼と作業から 依頼者・担当・番号・件名 を取る", async () => {
  const d = await new MailDraftService(daily()).draft(8, "owner_check");
  assert.deepEqual(d.to.map((p) => p.email), ["dev@example.com"], "依頼者のメールが無ければ Slack の ID から社員を引く");
  assert.deepEqual(d.cc.map((p) => p.email), ["legal@example.com"], "作業の担当が cc");
  assert.match(d.body, /^開発 太郎 さん/);
  assert.match(d.body, /REQ-2026-00012 秘密保持契約（当社ひな形）の締結 の秘密保持契約書/);
  assert.deepEqual(d.warnings, []);
});

test("依頼にメールがあればそれを使う。取引先は依頼の相手先で補う", async () => {
  const d = await new MailDraftService(daily({ request: { requester_email: "Biz@Example.com" } })).draft(8, "party_check");
  assert.deepEqual(d.to.map((p) => p.email), ["info@e.example"], "依頼の counterparty_id から取引先のメール");
  assert.deepEqual(d.cc.map((p) => p.email), ["Biz@Example.com"]);
  assert.match(d.body, /取引先E 御中/);
});

test("依頼者のメールも Slack の社員も無ければ、法務の担当を宛先にして警告する", async () => {
  const d = await new MailDraftService(daily({ slackStaff: [] })).draft(8, "owner_check");
  assert.deepEqual(d.to.map((p) => p.email), ["legal@example.com"]);
  assert.match(d.warnings[0], /デイリータスクに依頼者のメールが無い/);
});

test("案件にもデイリータスクにも繋がっていなければ、その旨を警告する", async () => {
  const d = await new MailDraftService(daily({ origin: [] })).draft(8, "owner_check");
  assert.deepEqual(d.to, []);
  assert.match(d.warnings[0], /案件にもデイリータスクにも繋がっていない/);
});
