import test from "node:test";
import assert from "node:assert/strict";
import { canonicalField, expandShared } from "./field-synonyms.js";

test("基本契約書と条件書の同じ意味の欄は同じ組になる", () => {
  assert.equal(canonicalField("VENDOR_NAME"), canonicalField("Licensor_氏名会社名"));
  assert.equal(canonicalField("NOTICE_CONTACT_EMAIL"), canonicalField("Licensor_メール"));
  assert.notEqual(canonicalField("VENDOR_NAME"), canonicalField("PARTY_A_NAME"));
  assert.equal(canonicalField("発行日"), "発行日", "組に無い欄は名前のまま");
});

test("共通の欄に入れた値は、組のすべての名前に入る", () => {
  assert.deepEqual(expandShared({ [canonicalField("Licensor_担当者")]: "山田", 発行日: "2026-10-02" }),
    { NOTICE_CONTACT_NAME: "山田", Licensor_担当者: "山田", VENDOR_CONTACT_NAME: "山田", 発行日: "2026-10-02" });
});

test("業務委託：基本契約書の通知先（乙）と発注書の発注先担当者は同じ組", () => {
  assert.equal(canonicalField("NOTICE_CONTACT_NAME"), canonicalField("VENDOR_CONTACT_NAME"));
  assert.equal(canonicalField("NOTICE_CONTACT_PHONE"), canonicalField("VENDOR_CONTACT_PHONE"));
});
