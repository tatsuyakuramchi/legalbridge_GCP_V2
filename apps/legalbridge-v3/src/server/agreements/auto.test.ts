import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ensureAgreementForTerms } from "./auto.js";

const base = {
  documentId: 10, documentNo: "ARC-ILT-D-2026-0001", templateLabel: "個別利用許諾条件書",
  conditionIds: [7], agreementId: null, issuedOn: "2026-06-01"
};

test("発注書・検収書では合意を立てない", async () => {
  const db = new FakeDatabase(() => []);
  const r = await ensureAgreementForTerms(db, { ...base, templateKey: "purchase_order" }, "who");
  assert.equal(r, null);
  assert.equal(db.queries.length, 0);
});

test("基本契約の無い条件書 → 単体契約（ARC-ILT）を立て、文書と条件に付ける", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "out",
                                                   agreement_id: null, work_title: "星降る夜のはなし" }];
    if (t.includes("FROM document_sequences")) return [];
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 3 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 91 }];
    if (t.includes("UPDATE conditions")) return [{ id: 7 }];
    return [];
  });
  const r = await ensureAgreementForTerms(db, { ...base, templateKey: "individual_license_terms_v3" }, "who");
  assert.equal(r?.kind, "standalone");
  assert.match(r?.agreementNo ?? "", /^ARC-ILT-\d{4}-0003$/);
  assert.equal(r?.conditionsLinked, 1);
  const ins = db.find("INSERT INTO agreements")!;
  assert.equal(ins.params[1], "個別利用許諾条件書（星降る夜のはなし）");
  assert.ok(db.find("UPDATE documents SET agreement_id"));
});

test("基本契約の下の条件書 → 補助文書（親番号-S01）。条件は基本契約のまま", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "out",
                                                   agreement_id: 3, agreement_kind: "master", work_title: null }];
    if (t.includes("SELECT id, agreement_no, domain FROM agreements")) return [{ id: 3, agreement_no: "ARC-LIC-2026-0002", domain: "license" }];
    if (t.includes("count(*)::int AS n FROM agreements")) return [{ n: 0 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 92 }];
    return [];
  });
  const r = await ensureAgreementForTerms(db, { ...base, templateKey: "pub_license_terms_v3" }, "who");
  assert.equal(r?.kind, "supplement");
  assert.equal(r?.agreementNo, "ARC-LIC-2026-0002-S01");
  assert.equal(r?.parentId, 3);
  assert.equal(db.find("UPDATE conditions SET agreement_id"), undefined);
});

test("文書に合意が付いていれば触らない（人が選んだものを上書きしない）", async () => {
  const db = new FakeDatabase(() => []);
  const r = await ensureAgreementForTerms(db, { ...base, templateKey: "pub_license_terms_v3", agreementId: 4 }, "who");
  assert.equal(r, null);
});
