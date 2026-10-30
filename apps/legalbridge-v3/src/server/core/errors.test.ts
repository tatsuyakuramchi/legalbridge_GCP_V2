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

test("向きの決まり（CHECK・トリガー）に当たったら、何を直せばよいかを言う", () => {
  const e = translate({ code: "23514", constraint: "conditions_agreement_direction_chk" });
  assert.match((e as DomainError).message, /向き（IN／OUT）の無い契約/);
  assert.match((translate({ code: "23514", constraint: "agreements_direction_chk" }) as DomainError).message, /文書だけ/);
  assert.match((translate({ code: "23514", constraint: "other_chk" }) as DomainError).message, /台帳の決まりに合いません（other_chk）/);
});
