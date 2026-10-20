import test from "node:test";
import assert from "node:assert/strict";
import { formatHash, parseHash, routePath } from "../../client/route.js";

test("ハッシュ → 場所。画面・id・問い合わせ。名前の副題は params.sub", () => {
  assert.deepEqual(parseHash("#/documents/123?step=party_check"), { view: "documents", id: 123, params: { step: "party_check" } });
  assert.deepEqual(parseHash("#/ops/fixes"), { view: "ops", id: undefined, params: { sub: "fixes" } });
  assert.deepEqual(parseHash("#/agreement-map/5?mode=tidy"), { view: "agreement-map", id: 5, params: { mode: "tidy" } });
  assert.deepEqual(parseHash("#/home"), { view: "home", id: undefined, params: {} });
  assert.equal(parseHash(""), null);
  assert.equal(parseHash("#"), null);
});

test("場所 → ハッシュ。空の値は書かない。往復で同じ", () => {
  assert.equal(formatHash({ view: "documents", id: 123, params: { step: "send", draft: "" } }), "#/documents/123?step=send");
  assert.equal(formatHash({ view: "ops", params: { sub: "fixes" } }), "#/ops/fixes");
  assert.equal(formatHash({ view: "home", params: {} }), "#/home");
  for (const h of ["#/documents/123?step=send", "#/ops/fixes", "#/agreement-map/5?mode=tidy", "#/parties/9"]) {
    assert.equal(formatHash(parseHash(h)!), h);
  }
});

test("道の部分だけ比べる（段の違いは同じ場所）", () => {
  assert.equal(routePath("#/documents/123?step=send"), "documents/123");
  assert.equal(routePath("#/documents/123"), routePath("#/documents/123?step=party_check"));
});
