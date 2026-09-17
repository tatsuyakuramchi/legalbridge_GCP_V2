import test from "node:test";
import assert from "node:assert/strict";
import { settlesEvents, settlementDocFor } from "./settlement-docs.js";

test("実績を結ぶのは検収書・納品書・計算書だけ。発注書や条件書は結ばない", () => {
  assert.equal(settlesEvents("inspection_certificate"), true);
  assert.equal(settlesEvents("delivery_note"), true);
  assert.equal(settlesEvents("royalty_statement"), true);
  assert.equal(settlesEvents("purchase_order"), false);
  assert.equal(settlesEvents("intl_purchase_order"), false);
  assert.equal(settlesEvents("individual_license_terms_v3"), false);
  assert.equal(settlesEvents(null), false);
});

test("条件の種類で、実績から作る文書が決まる", () => {
  assert.deepEqual(settlementDocFor("service"), { label: "検収書", templateKey: "inspection_certificate" });
  assert.deepEqual(settlementDocFor("expense"), { label: "検収書", templateKey: "inspection_certificate" });
  assert.deepEqual(settlementDocFor("license"), { label: "計算書", templateKey: "royalty_statement" });
});
