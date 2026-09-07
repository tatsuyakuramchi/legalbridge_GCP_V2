import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowServiceOutsourcingFlow } from "./matter-flow-visibility";

test("業務委託案件だけ業務委託フローを表示する", () => {
  assert.equal(shouldShowServiceOutsourcingFlow("service"), true);
  assert.equal(shouldShowServiceOutsourcingFlow("document_creation"), false);
  assert.equal(shouldShowServiceOutsourcingFlow("contract_review"), false);
  assert.equal(shouldShowServiceOutsourcingFlow("legal_consultation"), false);
  assert.equal(shouldShowServiceOutsourcingFlow("license"), false);
  assert.equal(shouldShowServiceOutsourcingFlow("unclassified"), false);
});
