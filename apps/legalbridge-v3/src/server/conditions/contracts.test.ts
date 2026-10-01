import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { conditionContracts, contractRefText } from "./contracts.js";

test("計算書の契約番号は 基本契約 / 個別契約。片方だけならそれ、同じ番号は 1 つ", () => {
  assert.equal(contractRefText("ARC-LIC-2026-0001", "ARC-ILT-2026-0003"), "ARC-LIC-2026-0001 / ARC-ILT-2026-0003");
  assert.equal(contractRefText("CT-2026-00008", null), "CT-2026-00008");
  assert.equal(contractRefText(null, "ARC-ILT-2026-0003"), "ARC-ILT-2026-0003");
  assert.equal(contractRefText("X", "X"), "X");
  assert.equal(contractRefText(null, ""), "");
});

const db = (agreementKind: string) => new FakeDatabase((t) => {
  if (t.includes("LEFT JOIN agreements p ON p.id = a.parent_id")) {
    return [{ id: 1, direction: "in", counterparty_id: 3,
              a_id: 20, a_no: agreementKind === "supplement" ? "ARC-LIC-2026-0001-S01" : "ARC-LIC-2026-0001", a_title: "A",
              a_kind: agreementKind, a_status: "active",
              p_id: agreementKind === "supplement" ? 10 : null, p_no: "ARC-LIC-2026-0001", p_title: "基本", p_kind: "master", p_status: "active" }];
  }
  if (t.includes("SELECT 1 FROM document_conditions dc")) {
    return [
      { id: 7, document_no: "ARC-ILT-2026-0009", status: "draft", issued_at: null, label: "個別利用許諾条件書", agreement_no: null },
      { id: 5, document_no: "ARC-ILT-2026-0003", status: "issued", issued_at: "2026-09-01", label: "個別利用許諾条件書", agreement_no: "ARC-LIC-2026-0001-S01" }
    ];
  }
  return undefined;
});

test("個別契約は決定済みで新しいものを使う。下書きは使わない", async () => {
  const r = await conditionContracts(db("master"), 1);
  assert.equal(r.master?.no, "ARC-LIC-2026-0001");
  assert.deepEqual(r.terms.map((x) => [x.no, x.used]), [["ARC-ILT-2026-0009", false], ["ARC-ILT-2026-0003", true]]);
  assert.equal(r.contractRef, "ARC-LIC-2026-0001 / ARC-ILT-2026-0003");
});

test("補助文書に載っている条件は、その親を基本契約とみなす", async () => {
  const r = await conditionContracts(db("supplement"), 1);
  assert.equal(r.agreement?.no, "ARC-LIC-2026-0001-S01");
  assert.equal(r.master?.id, 10);
  assert.equal(r.master?.no, "ARC-LIC-2026-0001");
});
