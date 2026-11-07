import { test } from "node:test";
import assert from "node:assert/strict";
import { docKeyOf, spansOf } from "./WorkLedger.js";
import type { GridRow } from "../server/matters/grid.js";

test("続く行の鍵が同じなら先頭の行が下の行の高さまでつなげ、下の行は 0。鍵が null の行はつながない", () => {
  const keys = ["a", "a", "a", null, "b", "b", "a"];
  const heights = [3, 1, 2, 1, 1, 4, 1];
  assert.deepEqual(spansOf(keys, heights, (k) => k), [6, 0, 0, 1, 5, 0, 1]);
  assert.deepEqual(spansOf([null, null], [2, 1], (k) => k), [2, 1]);
});

test("条件書の鍵：利用許諾は条件書・向き・相手・作品が同じならつなぐ。文書の無い行・食い違いのある発注書はつながない", () => {
  const lic = (over: Partial<GridRow>) => ({
    kind: "license", pricingModel: "rate", direction: "in", counterparty: { id: 505, name: "平沢" }, workId: 50,
    terms: { id: 100, documentNo: "LIC-LO-2026-0001-W-2026-0001", status: "issued", phase: "issued" },
    individual: null, order: null, onStandalone: false, agreementId: null, ...over
  }) as unknown as GridRow;
  assert.equal(docKeyOf(lic({})), docKeyOf(lic({})));
  assert.notEqual(docKeyOf(lic({})), docKeyOf(lic({ workId: 51 })));
  assert.equal(docKeyOf(lic({ terms: null })), null);
  const svc = (over: Partial<GridRow>) => ({
    kind: "service", pricingModel: "fixed", direction: "in", order: { id: 7, documentNo: "PO-7", status: "issued", phase: "issued" },
    onStandalone: false, agreementId: null, ...over
  }) as unknown as GridRow;
  assert.equal(docKeyOf(svc({})), "o7");
  assert.equal(docKeyOf(svc({ order: null })), null);
  assert.equal(docKeyOf(svc({ order: null, onStandalone: true, agreementId: 9 })), "s9");
});
