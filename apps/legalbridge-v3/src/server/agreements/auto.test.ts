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

test("受取人（共著の取り分）宛ての条件書：合意の相手は受取人、親は文書で選んだ受取人の基本契約。条件の合意は触らない", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "in",
                                                   agreement_id: 3, agreement_kind: "master", work_title: "光砕のリヴァルチャー" }];
    if (t.includes("SELECT id, counterparty_id, kind FROM agreements")) return [{ id: 40, counterparty_id: 21, kind: "master" }];
    if (t.includes("SELECT id, agreement_no, domain FROM agreements")) return [{ id: 40, agreement_no: "ARC-PUBM-2026-0021", domain: "license" }];
    if (t.includes("count(*)::int AS n FROM agreements")) return [{ n: 1 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 93 }];
    return [];
  });
  const r = await ensureAgreementForTerms(db, {
    ...base, templateKey: "pub_license_terms_v3", agreementId: null, payeePartyId: 21, parentAgreementId: 40
  }, "who");
  assert.equal(r?.kind, "supplement");
  assert.equal(r?.agreementNo, "ARC-PUBM-2026-0021-S02");
  assert.equal(r?.parentId, 40);
  const ins = db.find("INSERT INTO agreements")!;
  assert.equal(ins.params[2], 21, "合意の相手は受取人");
  assert.equal(ins.params[1], "個別利用許諾条件書（光砕のリヴァルチャー）（共著の取り分）");
  assert.ok(db.find("UPDATE documents SET agreement_id = $2 WHERE id = $1"), "文書の基本契約を補助文書に差し替える");
  assert.equal(db.find("UPDATE conditions SET agreement_id"), undefined, "条件は代表の契約のまま");
});

test("受取人宛て：選んだ基本契約が受取人のものでなければ止める。基本契約を選ばなければ受取人との単体契約", async () => {
  const wrong = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "in", agreement_id: 3, agreement_kind: "master", work_title: null }];
    if (t.includes("SELECT id, counterparty_id, kind FROM agreements")) return [{ id: 3, counterparty_id: 5, kind: "master" }];
    return [];
  });
  await assert.rejects(
    () => ensureAgreementForTerms(wrong, { ...base, templateKey: "pub_license_terms_v3", payeePartyId: 21, parentAgreementId: 3 }, "who"),
    /受取人の契約ではありません/);

  const none = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "in", agreement_id: 3, agreement_kind: "master", work_title: null }];
    if (t.includes("FROM document_sequences")) return [];
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 8 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 94 }];
    return [];
  });
  const r = await ensureAgreementForTerms(none, { ...base, templateKey: "pub_license_terms_v3", payeePartyId: 21, parentAgreementId: null }, "who");
  assert.equal(r?.kind, "standalone");
  assert.equal(none.find("INSERT INTO agreements")!.params[2], 21);
  assert.equal(r?.conditionsLinked, 0, "条件は代表の契約のまま");
});
