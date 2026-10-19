import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { NoticeFillService, NOTICE_REASON } from "./notice-fill.js";

/**
 * 901：条件書。甲・乙とも空。相手先 11（個人・連絡先なし、本人のメールあり）。
 * 902：基本契約書。通知先が空。相手先 12（法人・主担当あり）。
 * 903：条件書。乙だけ空。相手先 13（連絡先もメールも無い）。前に残った自分の下書き 995。
 * 904：条件書。甲が空。相手先 14（法人・連絡先もメールも電話も無い）→ 入れる値が無い。
 */
const db = () => new FakeDatabase((text) => {
  if (text.includes("rendered_values->>'licensorContact'")) return [
    { id: 901, document_no: "ARC-PUBT-2026-1024", issued_at: "2026-10-08T03:00:00Z", template_key: "pub_license_terms_v3",
      licensor: "", licensee: null, party_id: 11, open_draft: null },
    { id: 902, document_no: "ARC-PUBM-2026-0030", issued_at: "2026-10-08T03:00:00Z", template_key: "pub_master_corporate",
      licensor: null, licensee: null, party_id: 12, open_draft: null },
    { id: 903, document_no: "ARC-PUBT-2026-1025", issued_at: "2026-10-09T03:00:00Z", template_key: "pub_license_terms_v3",
      licensor: "作家丙", licensee: "", party_id: 13, open_draft: 995, open_draft_reason: NOTICE_REASON },
    { id: 904, document_no: "ARC-PUBT-2026-1026", issued_at: "2026-10-09T03:00:00Z", template_key: "pub_license_terms_v3",
      licensor: "", licensee: "法務部 ／ 倉持", party_id: 14, open_draft: null }
  ];
  if (text.includes("FROM parties p WHERE p.id = ANY")) return [
    { id: 11, name: "作家甲", kind: "individual", email: "kou@example.test", phone: null, contacts: [] },
    { id: 12, name: "株式会社乙", kind: "corporate", email: "info@otsu.test", phone: "03-0000-0000",
      contacts: [{ name: "総務 一郎", email: "ichiro@otsu.test", phone: "03-1111-1111", department: "総務部", roles: ["billing"] },
                 { name: "編集 花子", email: "hanako@otsu.test", phone: null, department: "編集部", roles: ["primary"] }] },
    { id: 13, name: "作家丙", kind: "individual", email: null, phone: null, contacts: [] },
    { id: 14, name: "有限会社丁", kind: "corporate", email: null, phone: null, contacts: [] },
    { id: 15, name: "株式会社戊", kind: "corporate", email: "info@bo.test", phone: "03-3333-3333",
      rep_name: "戊山 太郎", rep_title: "代表取締役",
      contacts: [{ name: "経理 次郎", email: "keiri@bo.test", phone: null, department: "経理部", roles: ["billing"] }] }
  ];
  if (text.includes("FROM staff s WHERE s.id")) return [{ name: "倉持 達也", email: "kura@arclight.test", department: "法務部", phone: "03-2222-2222" }];
  return undefined;
});

test("試算：甲・相手先の窓口は主担当（個人は本人）、乙は選んだ担当者。空いた欄だけ入れる", async () => {
  const r = await new NoticeFillService(db()).preview(7);
  const by = new Map(r.targets.map((t) => [t.documentId, t]));
  assert.deepEqual(by.get(901)!.patch, {
    "許諾者連絡先": "作家甲 ／ kou@example.test",
    "被許諾者連絡先": "法務部 ／ 倉持 達也 ／ kura@arclight.test ／ 03-2222-2222",
    _ownerStaffId: 7
  });
  assert.deepEqual(by.get(902)!.patch, { "通知先担当者": "編集部 編集 花子", "通知先メール": "hanako@otsu.test" },
    "基本契約書は主担当。請求先ではない");
  assert.equal(by.get(902)!.kind, "master");
  assert.deepEqual(Object.keys(by.get(903)!.patch), ["被許諾者連絡先", "_ownerStaffId"], "入っている甲は触らない");
  assert.equal(by.get(903)!.reuseDraftId, 995);
  assert.match(by.get(904)!.skip ?? "", /取引先に連絡先/);
});

test("試算：担当者を選ばなければ、乙だけ空いた条件書は出し直さない", async () => {
  const r = await new NoticeFillService(db()).preview(null);
  const by = new Map(r.targets.map((t) => [t.documentId, t]));
  assert.match(by.get(903)!.skip ?? "", /担当者を選んでください/);
  assert.deepEqual(Object.keys(by.get(901)!.patch), ["許諾者連絡先"], "甲だけでも入れられれば出し直す");
  assert.equal(by.get(901)!.skip, null);
});

test("出し直す：訂正版の下書きに空いた欄を足して、元の決定日で決定する。残った自分の下書きは使い回す", async () => {
  const calls: unknown[][] = [];
  const issuer = {
    reissue: async (id: number, reason: string) => { calls.push(["reissue", id, reason]); return { id: id + 1000 }; },
    issue: async (id: number, _who: string, extra?: { issuedOn?: string | null }) => { calls.push(["issue", id, extra?.issuedOn]); return { documentNo: `R-${id}` }; }
  };
  const database = db();
  const r = await new NoticeFillService(database, issuer).run([901, 903, 904], 7, "tester");
  assert.equal(r.reissued, 2);
  assert.deepEqual(calls, [["reissue", 901, NOTICE_REASON], ["issue", 1901, "2026-10-08"], ["issue", 995, "2026-10-09"]]);
  const updates = database.all("UPDATE documents SET manual_inputs");
  assert.deepEqual(updates.map((u) => u.params[0]), [1901, 995]);
  assert.equal(JSON.parse(String(updates[0]!.params[1]))["許諾者連絡先"], "作家甲 ／ kou@example.test");
  assert.deepEqual(r.results.map((x) => x.status), ["reissued", "reissued", "skipped"]);
});

test("法人で主担当がいなければ代表者（肩書・氏名と取引先のメール・電話）。個人は本人のまま", async () => {
  const database = new FakeDatabase((text) => {
    if (text.includes("rendered_values->>'licensorContact'")) return [
      { id: 905, document_no: "ARC-PUBM-2026-0031", issued_at: "2026-10-08T03:00:00Z", template_key: "pub_master_corporate",
        party_id: 15, open_draft: null },
      { id: 906, document_no: "ARC-PUBT-2026-1027", issued_at: "2026-10-08T03:00:00Z", template_key: "pub_license_terms_v3",
        licensor: "", licensee: "法務部 ／ 倉持", party_id: 15, open_draft: null }
    ];
    if (text.includes("FROM parties p WHERE p.id = ANY")) return [
      { id: 15, name: "株式会社戊", kind: "corporate", email: "info@bo.test", phone: "03-3333-3333",
        rep_name: "戊山 太郎", rep_title: "代表取締役",
        contacts: [{ name: "経理 次郎", email: "keiri@bo.test", phone: null, department: "経理部", roles: ["billing"] }] }
    ];
    return undefined;
  });
  const r = await new NoticeFillService(database).preview(null);
  const by = new Map(r.targets.map((t) => [t.documentId, t]));
  assert.deepEqual(by.get(905)!.patch, { "通知先担当者": "代表取締役 戊山 太郎", "通知先電話": "03-3333-3333", "通知先メール": "info@bo.test" },
    "請求先の人ではなく代表者");
  assert.equal(by.get(906)!.patch["許諾者連絡先"], "代表取締役 ／ 戊山 太郎 ／ info@bo.test ／ 03-3333-3333");
});
