import assert from "node:assert/strict";
import test from "node:test";
import { findSelfStaff } from "./MasterDataPicker.js";

const rows = (...emails: Array<string | null>) =>
  emails.map((email, index) => ({
    id: String(index), type: "staff" as const, label: `staff${index}`,
    description: "", values: { email, staff_name: `staff${index}` }
  }));

test("メール完全一致の1件だけを自分として採用する", () => {
  const found = findSelfStaff(rows("other@example.co.jp", "me@example.co.jp"), "me@example.co.jp");
  assert.equal(found?.label, "staff1");
});

test("大文字小文字・前後空白は無視して一致させる", () => {
  assert.equal(findSelfStaff(rows(" Me@Example.co.jp "), "me@example.co.jp")?.label, "staff0");
});

test("部分一致では採用しない（他人を引用しない）", () => {
  assert.equal(findSelfStaff(rows("me@example.co.jp.invalid"), "me@example.co.jp"), null);
});

test("同一メールが複数ある場合は曖昧なので採用しない", () => {
  assert.equal(findSelfStaff(rows("me@example.co.jp", "me@example.co.jp"), "me@example.co.jp"), null);
});

test("該当なし・メール未設定・null メール行は null", () => {
  assert.equal(findSelfStaff(rows("other@example.co.jp"), "me@example.co.jp"), null);
  assert.equal(findSelfStaff(rows("me@example.co.jp"), ""), null);
  assert.equal(findSelfStaff(rows(null), "me@example.co.jp"), null);
});
