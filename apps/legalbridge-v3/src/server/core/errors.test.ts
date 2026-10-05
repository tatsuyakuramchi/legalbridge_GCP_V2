import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, translate } from "./errors.js";

test("無い表に当たったら、どの表が無いかを言う", () => {
  const e = translate({ code: "42P01", message: 'relation "term_events" does not exist' });
  assert.ok(e instanceof DomainError);
  assert.match((e as DomainError).message, /まだ作られていません（term_events）/);
  assert.match((e as DomainError).message, /ops upgrade/);
  // 表の名前が読めなくても、従来の文言は出る。
  assert.match((translate({ code: "42P01" }) as DomainError).message, /^対象のテーブルがまだ作られていません。/);
});
