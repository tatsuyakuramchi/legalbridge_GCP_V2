import assert from "node:assert/strict";
import test from "node:test";
import { createSlackRecipientDirectory } from "./slack-recipient-resolver.js";

test("依頼者メールを明示登録されたSlackユーザーへ解決する", () => {
  const directory = createSlackRecipientDirectory(
    "requester@arclight.co.jp=U0123456789"
  );
  const result = directory.resolve("Requester@arclight.co.jp");
  assert.equal(result.resolution, "resolved");
  assert.equal(result.userId, "U0123456789");
  assert.equal(result.recipientEmailMasked, "re***@arclight.co.jp");
});

test("依頼者情報なし・未登録・不正IDを解決済みにしない", () => {
  const directory = createSlackRecipientDirectory(
    "invalid@arclight.co.jp=CHANNEL"
  );
  assert.equal(directory.resolve(null).resolution, "missing_identity");
  assert.equal(directory.resolve("unknown@arclight.co.jp").resolution, "unmapped");
  assert.equal(directory.resolve("invalid@arclight.co.jp").resolution, "invalid");
});

test("同じメールに複数のSlackユーザーがある場合は推測しない", () => {
  const directory = createSlackRecipientDirectory(
    "requester@arclight.co.jp=U0123456789,requester@arclight.co.jp=U9876543210"
  );
  const result = directory.resolve("requester@arclight.co.jp");
  assert.equal(result.resolution, "ambiguous");
  assert.equal(result.userId, null);
});
