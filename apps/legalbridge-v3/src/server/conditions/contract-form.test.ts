import test from "node:test";
import assert from "node:assert/strict";
import { contractFormFor, readContractForm } from "./contract-form.js";
import { parsePaymentTerms } from "./payment-terms.js";

test("契約形式は支払条件として読めない。だから列を分ける", () => {
  // これが元の不具合。「請負」を支払条件の欄に入れると、支払期日を出す処理が
  // null を返し、予定明細の支払期日が黙って空欄のまま出ていた。
  assert.equal(parsePaymentTerms("請負"), null);
  assert.notEqual(parsePaymentTerms("月末締め翌月末払い"), null);
});

test("空白だけの契約形式は入れない", () => {
  assert.equal(readContractForm("  "), null);
  assert.equal(readContractForm(null), null);
  assert.equal(readContractForm(" 請負 "), "請負");
});

test("実績 → 予定 → 条件 の順に、書いてあるものを使う", () => {
  assert.equal(contractFormFor("委任", "準委任", "請負"), "委任");
  assert.equal(contractFormFor(null, "準委任", "請負"), "準委任");
  assert.equal(contractFormFor(null, "", "請負"), "請負", "空文字は書いていない扱い");
  assert.equal(contractFormFor(null, null, null), null);
});
