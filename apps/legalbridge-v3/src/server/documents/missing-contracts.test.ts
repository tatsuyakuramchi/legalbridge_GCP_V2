import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MissingContractsService } from "./missing-contracts.js";

/**
 * 契約書の無い相手先（出版）。
 *   作家A（個人、基本契約なし）：作品X 紙・電子（条件書なし）、作品Y 紙（条件書あり）
 *   作家B（法人、基本契約 #40 あり）：作品Z 電子（条件書なし）
 *   作家C：全部に条件書あり → 出ない
 */
const ROWS = [
  { id: 1, condition_no: "CL-1", usage_type: "pub_print", counterparty_id: 11, work_id: 100, work_title: "作品X", party_name: "作家A", party_kind: "individual", email: "a@example.test", master: null, has_terms: false },
  { id: 2, condition_no: "CL-2", usage_type: "pub_digital", counterparty_id: 11, work_id: 100, work_title: "作品X", party_name: "作家A", party_kind: "individual", email: "a@example.test", master: null, has_terms: false },
  { id: 3, condition_no: "CL-3", usage_type: "pub_print", counterparty_id: 11, work_id: 101, work_title: "作品Y", party_name: "作家A", party_kind: "individual", email: "a@example.test", master: null, has_terms: true },
  { id: 4, condition_no: "CL-4", usage_type: "pub_digital", counterparty_id: 12, work_id: 102, work_title: "作品Z", party_name: "作家B", party_kind: "corporate", email: null, master: { id: 40, no: "ARC-PUBM-2026-0040", title: "出版等利用許諾基本契約" }, has_terms: false },
  { id: 5, condition_no: "CL-5", usage_type: "pub_digital", counterparty_id: 13, work_id: 103, work_title: "作品W", party_name: "作家C", party_kind: "individual", email: "c@example.test", master: null, has_terms: true }
];
const db = () => new FakeDatabase((text) => {
  if (text.includes("AS has_terms")) return ROWS;
  if (text.includes("FROM conditions WHERE id = ANY")) return [{ id: 1, condition_no: "CL-1", direction: "in", counterparty_id: 11, agreement_id: null },
                                                                { id: 2, condition_no: "CL-2", direction: "in", counterparty_id: 11, agreement_id: null }];
  if (text.includes("UPDATE conditions SET agreement_id")) return [{ id: 1 }, { id: 2 }];
  return undefined;
});
const deps = (missingFor: Record<string, string[]> = {}) => {
  const calls: Array<{ what: string; args: unknown }> = [];
  let docId = 500;
  return {
    calls,
    db: db(),
    preview: async (x: { templateKey: string }) => { calls.push({ what: "preview", args: x }); return { missing: (missingFor[x.templateKey] ?? []).map((n) => ({ name: n, label: n })), templateLabel: x.templateKey }; },
    createDraft: async (x: unknown) => { calls.push({ what: "draft", args: x }); docId += 1; return { id: docId }; },
    issue: async (id: number) => { calls.push({ what: "issue", args: id }); return { documentNo: `DOC-${id}` }; },
    createAgreement: async (x: unknown) => { calls.push({ what: "agreement", args: x }); return { id: 90, agreementNo: "ARC-PUBM-2026-0090" }; }
  };
};

test("一覧：条件書の無い条件を相手先ごとに。全部に条件書がある相手先は出ない。基本契約・メールの有無が分かる", async () => {
  const svc = new MissingContractsService(db(), deps());
  const { parties } = await svc.list();
  assert.deepEqual(parties.map((p) => [p.partyName, p.missingTerms, p.missingWorks, p.master?.agreementNo ?? null, p.email]),
    [["作家A", 2, 1, null, "a@example.test"], ["作家B", 1, 1, "ARC-PUBM-2026-0040", null]]);
  assert.deepEqual(parties[0].conditions.map((c) => [c.conditionNo, c.hasTerms]), [["CL-1", false], ["CL-2", false], ["CL-3", true]]);
});

test("試算：基本契約の無い個人は出版許諾契約書（個人）を作る計画。必須の欄が空なら「必須の欄が空」。何も作らない", async () => {
  const d = deps({ pub_master_individual: ["許諾者住所"] });
  const svc = new MissingContractsService(d.db, d);
  const { outcomes } = await svc.preview({ partyIds: [11, 12, 99], signedOn: "2026-10-07" });
  assert.deepEqual(outcomes.map((o) => [o.partyId, o.status]), [[11, "missing"], [12, "ok"], [99, "nothing"]]);
  assert.deepEqual(outcomes[0].plan, { master: "create", masterTemplateKey: "pub_master_individual", termsTemplateKey: "pub_license_terms_v3", conditionIds: [1, 2] });
  assert.match(outcomes[0].problems[0], /pub_master_individual：許諾者住所/);
  assert.deepEqual(outcomes[1].plan, { master: "existing", masterTemplateKey: null, termsTemplateKey: "pub_license_terms_v3", conditionIds: [4] });
  assert.ok(d.calls.every((c) => c.what === "preview"), "試算は確かめるだけ");
  assert.deepEqual((d.calls[0].args as { manualInputs: Record<string, unknown> }).manualInputs, { 締結日: "2026-10-07" });
});

test("決定：相手先ごとに文書セットを決定する（基本契約を作る → 条件書）。1 件の失敗で他を止めない", async () => {
  const d = deps();
  const svc = new MissingContractsService(d.db, d);
  const r = await svc.run({ partyIds: [11], signedOn: "2026-10-07" }, "tester");
  assert.equal(r.issued, 1);
  assert.equal(r.outcomes[0].status, "ok");
  assert.deepEqual(d.calls.filter((c) => c.what !== "preview").map((c) => c.what), ["agreement", "draft", "issue", "draft", "issue"]);
  const agreement = d.calls.find((c) => c.what === "agreement")!.args as Record<string, unknown>;
  assert.deepEqual([agreement.counterpartyId, agreement.kind, agreement.domain, agreement.title], [11, "master", "license", "出版等利用許諾基本契約"]);
  const drafts = d.calls.filter((c) => c.what === "draft").map((c) => c.args as Record<string, any>);
  assert.equal(drafts[0].templateKey, "pub_master_individual");
  assert.deepEqual([drafts[1].templateKey, drafts[1].conditionIds, drafts[1].agreementId], ["pub_license_terms_v3", [1, 2], null], "条件書には合意を付けない（決定で自動の合意が立つ）");
  assert.deepEqual(r.outcomes[0].result?.documents.map((x) => x.documentNo), ["DOC-501", "DOC-502"]);
  assert.ok(d.db.find("INSERT INTO audit_events"));
});

/**
 * 共著の受取人。作品X（条件 1・2、相手先＝作家A）は取り分を直接払う：作家A 50%・作家D 30%・作家E 20%。
 *   作家D（個人、基本契約なし）：受取人宛ての条件書なし → 受取人の行
 *   作家E（個人、基本契約なし）：作品V（条件 6）の相手先でもある → 相手先の行と受取人の行の両方
 *   作家A は相手先なので受取人の行にしない（SQL で除く）
 */
const SHARE_ROWS = [
  { id: 1, condition_no: "CL-1", usage_type: "pub_print", work_id: 100, work_title: "作品X", party_id: 21, party_name: "作家D", party_kind: "individual", email: "d@example.test", master: null, payee_has_terms: false },
  { id: 2, condition_no: "CL-2", usage_type: "pub_digital", work_id: 100, work_title: "作品X", party_id: 21, party_name: "作家D", party_kind: "individual", email: "d@example.test", master: null, payee_has_terms: false },
  { id: 1, condition_no: "CL-1", usage_type: "pub_print", work_id: 100, work_title: "作品X", party_id: 14, party_name: "作家E", party_kind: "individual", email: null, master: null, payee_has_terms: false },
  { id: 2, condition_no: "CL-2", usage_type: "pub_digital", work_id: 100, work_title: "作品X", party_id: 14, party_name: "作家E", party_kind: "individual", email: null, master: null, payee_has_terms: true }
];
const OWN_E = { id: 6, condition_no: "CL-6", usage_type: "pub_print", counterparty_id: 14, work_id: 104, work_title: "作品V", party_name: "作家E", party_kind: "individual", email: null, master: null, has_terms: false };
const CONDS: Record<number, number> = { 1: 11, 2: 11, 3: 11, 4: 12, 5: 13, 6: 14 };
const shareDb = () => new FakeDatabase((text, params) => {
  if (text.includes("AS has_terms")) return [...ROWS, OWN_E];
  if (text.includes("AS payee_has_terms")) return SHARE_ROWS;
  if (text.includes("FROM conditions WHERE id = ANY")) {
    return (params[0] as number[]).map((id) => ({ id, condition_no: `CL-${id}`, direction: "in", counterparty_id: CONDS[id], agreement_id: null }));
  }
  if (text.includes("FROM agreements WHERE id = $1")) return [{ id: params[0], agreement_no: "ARC-PUBM-2026-0091", counterparty_id: 14, kind: "master", direction: "in" }];
  if (text.includes("UPDATE conditions SET agreement_id")) return (params[0] as number[]).map((id) => ({ id }));
  return undefined;
});
const shareDeps = () => {
  const d = deps();
  let agreementId = 90;
  return { ...d, db: shareDb(),
           createAgreement: async (x: unknown) => { d.calls.push({ what: "agreement", args: x }); agreementId += 1; return { id: agreementId, agreementNo: `ARC-PUBM-2026-00${agreementId}` }; } };
};

test("一覧：共著の受取人も 1 行（鍵 payee:<id>）。代表の名前が付き、受取人宛ての条件書がある条件は済み。相手先の条件書は受取人宛てを数えない", async () => {
  const d = shareDeps();
  const svc = new MissingContractsService(d.db, d);
  const { parties } = await svc.list();
  assert.deepEqual(parties.map((p) => [p.key, p.partyName, p.missingTerms, p.missingWorks]), [
    ["party:11", "作家A", 2, 1], ["party:12", "作家B", 1, 1], ["payee:21", "作家D", 2, 1],
    ["party:14", "作家E", 1, 1], ["payee:14", "作家E", 1, 1]
  ]);
  const dRow = parties.find((p) => p.key === "payee:21")!;
  assert.deepEqual([dRow.role, dRow.representatives], ["payee", ["作家A"]]);
  const sql = d.db.find("AS has_terms")!.text;
  assert.match(sql, /_payeePartyId[\s\S]*c\.counterparty_id\) = c\.counterparty_id/, "相手先の行は宛名の無い（か相手先宛ての）条件書だけ");
  const share = d.db.find("AS payee_has_terms")!.text;
  assert.match(share, /'distribution', 'direct'\) <> 'representative'/, "代表が分配する条件は受取人の行にしない");
  assert.match(share, /s\.party_id <> c\.counterparty_id/);
});

test("試算：受取人の行は受取人宛て（_payeePartyId）の条件書。基本契約が無ければ受取人と作る計画", async () => {
  const d = shareDeps();
  const svc = new MissingContractsService(d.db, d);
  const { outcomes } = await svc.preview({ keys: ["payee:21", "payee:99"], signedOn: "2026-10-07" });
  assert.deepEqual(outcomes.map((o) => [o.key, o.role, o.status]), [["payee:21", "payee", "ok"], ["payee:99", "payee", "nothing"]]);
  assert.deepEqual(outcomes[0].plan, { master: "create", masterTemplateKey: "pub_master_individual", termsTemplateKey: "pub_license_terms_v3", conditionIds: [1, 2] });
  const terms = d.calls.filter((c) => c.what === "preview").map((c) => c.args as Record<string, any>)[1];
  assert.deepEqual(terms.manualInputs, { 締結日: "2026-10-07", _payeePartyId: 21 });
});

test("決定：受取人の行は受取人と基本契約を作り、受取人宛ての条件書をその下に。条件は代表の契約のまま", async () => {
  const d = shareDeps();
  const svc = new MissingContractsService(d.db, d);
  const r = await svc.run({ keys: ["payee:21"], signedOn: "2026-10-07" }, "tester");
  assert.deepEqual([r.issued, r.outcomes[0].status], [1, "ok"], JSON.stringify(r.outcomes));
  const agreement = d.calls.find((c) => c.what === "agreement")!.args as Record<string, unknown>;
  assert.equal(agreement.counterpartyId, 21, "基本契約は受取人と");
  const drafts = d.calls.filter((c) => c.what === "draft").map((c) => c.args as Record<string, any>);
  assert.deepEqual([drafts[1].templateKey, drafts[1].conditionIds, drafts[1].agreementId], ["pub_license_terms_v3", [1, 2], 91],
    "受取人の条件書は受取人の基本契約を親に（決定で -S01 が立つ）");
  assert.equal(drafts[1].manualInputs._payeePartyId, 21);
  assert.equal(d.db.find("UPDATE conditions SET agreement_id"), undefined, "条件を受取人の基本契約に載せ替えない");
});

test("決定：同じ人が相手先と受取人の両方なら相手先の行を先に回し、作った基本契約を受取人の行でも使う", async () => {
  const d = shareDeps();
  const svc = new MissingContractsService(d.db, d);
  const r = await svc.run({ keys: ["payee:14", "party:14"], signedOn: "2026-10-07" }, "tester");
  assert.deepEqual(r.outcomes.map((o) => [o.key, o.status]), [["party:14", "ok"], ["payee:14", "ok"]], JSON.stringify(r.outcomes));
  assert.equal(d.calls.filter((c) => c.what === "agreement").length, 1, "基本契約は 1 本");
  assert.deepEqual(r.outcomes[1].plan?.master, "existing");
  const drafts = d.calls.filter((c) => c.what === "draft").map((c) => c.args as Record<string, any>);
  assert.deepEqual(drafts.map((x) => [x.templateKey, x.conditionIds, x.manualInputs._payeePartyId ?? null]), [
    ["pub_master_individual", [], null], ["pub_license_terms_v3", [6], null], ["pub_license_terms_v3", [1], 14]
  ]);
});
