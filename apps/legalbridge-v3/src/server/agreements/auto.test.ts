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

test("基本契約の無い条件書 → 単体契約を立て、文書と条件に付ける。番号は条件書の番号", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "out",
                                                   agreement_id: null, work_title: "星降る夜のはなし" }];
    if (t.includes("SELECT id FROM agreements WHERE agreement_no = $1")) return [];
    if (t.includes("FROM document_sequences")) return [];
    if (t.includes("UPDATE document_sequences")) return [{ current_value: 3 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 91 }];
    if (t.includes("UPDATE conditions")) return [{ id: 7 }];
    return [];
  });
  const r = await ensureAgreementForTerms(db, { ...base, templateKey: "individual_license_terms_v3" }, "who");
  assert.equal(r?.kind, "standalone");
  assert.equal(r?.agreementNo, "ARC-ILT-D-2026-0001", "条件書と同じ番号");
  assert.equal(r?.conditionsLinked, 1);
  const ins = db.find("INSERT INTO agreements")!;
  assert.equal(ins.params[1], "個別利用許諾条件書（星降る夜のはなし）");
  assert.ok(db.find("UPDATE documents SET agreement_id"));
});

test("基本契約の下の条件書 → 個別契約。番号は条件書の番号（訂正版の -R2 は除く）。条件は基本契約のまま", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "out",
                                                   agreement_id: 3, agreement_kind: "master", work_title: null }];
    if (t.includes("SELECT id FROM agreements WHERE agreement_no = $1")) return [];
    if (t.includes("SELECT id, agreement_no, domain FROM agreements")) return [{ id: 3, agreement_no: "ARC-LIC-2026-0002", domain: "license" }];
    if (t.includes("count(*)::int AS n FROM agreements")) return [{ n: 0 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 92 }];
    return [];
  });
  const r = await ensureAgreementForTerms(db, { ...base, documentNo: "ARC-PUBT-2026-1019-R2", templateKey: "pub_license_terms_v3" }, "who");
  assert.equal(r?.kind, "supplement");
  assert.equal(r?.agreementNo, "ARC-PUBT-2026-1019");
  assert.equal(r?.parentId, 3);
  assert.equal(db.find("UPDATE conditions SET agreement_id"), undefined);
});

test("条件書の番号が既に契約に使われていれば、親番号-S01 で採番する", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "out",
                                                   agreement_id: 3, agreement_kind: "master", work_title: null }];
    if (t.includes("SELECT id FROM agreements WHERE agreement_no = $1")) return [{ id: 77 }];
    if (t.includes("SELECT id, agreement_no, domain FROM agreements")) return [{ id: 3, agreement_no: "ARC-LIC-2026-0002", domain: "license" }];
    if (t.includes("count(*)::int AS n FROM agreements")) return [{ n: 0 }];
    if (t.includes("INSERT INTO agreements")) return [{ id: 92 }];
    return [];
  });
  const r = await ensureAgreementForTerms(db, { ...base, templateKey: "pub_license_terms_v3" }, "who");
  assert.equal(r?.agreementNo, "ARC-LIC-2026-0002-S01");
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
  assert.equal(r?.agreementNo, "ARC-ILT-D-2026-0001", "受取人宛ても条件書の番号");
  assert.equal(r?.parentId, 40);
  const ins = db.find("INSERT INTO agreements")!;
  assert.equal(ins.params[2], 21, "合意の相手は受取人");
  assert.equal(ins.params[1], "個別利用許諾条件書（光砕のリヴァルチャー）（共著の取り分）");
  assert.ok(db.find("UPDATE documents SET agreement_id = $2 WHERE id = $1"), "文書の基本契約を補助文書に差し替える");
  assert.equal(db.find("UPDATE conditions SET agreement_id"), undefined, "条件は代表の契約のまま");
});

test("受取人宛ての訂正版：前の版で立てた受取人の補助文書を引き継いでいれば、それを使い続ける（新しく立てない）", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c")) return [{ id: 7, counterparty_id: 5, direction: "in", agreement_id: 3, agreement_kind: "master", work_title: null }];
    if (t.includes("SELECT id, counterparty_id, kind FROM agreements")) return [{ id: 93, counterparty_id: 21, kind: "supplement" }];
    return [];
  });
  const input = { ...base, templateKey: "pub_license_terms_v3", payeePartyId: 21, parentAgreementId: 93 };
  assert.equal(await ensureAgreementForTerms(db, { ...input, revision: true }, "who"), null);
  assert.equal(db.find("INSERT INTO agreements"), undefined);
  assert.equal(db.find("UPDATE documents SET agreement_id"), undefined, "文書の合意（前の版の補助文書）のまま");
  // 訂正版でなければ、親に選べるのは基本契約だけ。
  await assert.rejects(() => ensureAgreementForTerms(db, input, "who"), /親に選べるのは基本契約だけ/);
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
