import test from "node:test";
import assert from "node:assert/strict";
import { applyRefNoMode, citeContractRef, citeJoined, citeNo, citeText, refNoModeOf } from "./cite-no.js";

test("refNoModeOf: 知らない値は当社番号", () => {
  assert.equal(refNoModeOf(undefined), "ours");
  assert.equal(refNoModeOf("theirs"), "theirs");
  assert.equal(refNoModeOf("both"), "both");
  assert.equal(refNoModeOf("x"), "ours");
});

test("citeText: 控えが無ければ当社番号、両方は括弧で添える", () => {
  assert.equal(citeText("theirs", "ARC-PO-2026-0001", null), "ARC-PO-2026-0001");
  assert.equal(citeText("theirs", "ARC-PO-2026-0001", "PO-9"), "PO-9");
  assert.equal(citeText("both", "ARC-PO-2026-0001", "PO-9"), "ARC-PO-2026-0001（相手方番号 PO-9）");
  assert.equal(citeText("ours", "ARC-PO-2026-0001", "PO-9"), "ARC-PO-2026-0001");
  assert.equal(citeText("both", "A", "A"), "A");
});

test("citeNo / citeJoined: 表で引く。枝番は本体の番号でも引ける。区切りは保つ", () => {
  const nos = new Map([["ARC-PO-2026-0001", "PO-9"], ["AGR-2025-0011", "K-001"]]);
  assert.equal(citeNo("theirs", nos, "ARC-PO-2026-0001-R2"), "PO-9");
  assert.equal(citeNo("theirs", nos, "ARC-PO-2026-0002"), "ARC-PO-2026-0002");
  assert.equal(citeJoined("both", nos, "AGR-2025-0011 / ARC-PO-2026-0001"),
    "AGR-2025-0011（相手方番号 K-001） / ARC-PO-2026-0001（相手方番号 PO-9）");
  assert.equal(citeJoined("theirs", nos, "ARC-PO-2026-0001・ARC-PO-2026-0002"), "PO-9・ARC-PO-2026-0002");
  assert.equal(citeJoined("ours", nos, "AGR-2025-0011 / ARC-PO-2026-0001"), "AGR-2025-0011 / ARC-PO-2026-0001");
});

test("applyRefNoMode: 文脈の引用番号だけを置き換え、文書そのものの番号は触らない", () => {
  const nos = new Map([["ARC-PO-2026-0001", "PO-9"], ["AGR-2025-0011", "K-001"]]);
  const agreement = { id: 1, no: "AGR-2025-0011", kind: "master" };
  const ctx: Record<string, any> = {
    document: { number: "ARC-IC-2026-0003" },
    agreement, masterAgreement: agreement,
    conditions: [{ id: 5, standaloneNo: null, agreement }],
    related: [{ documentNo: "ARC-PO-2026-0001-R2", templateKey: "purchase_order" }],
    parentPoNo: "ARC-PO-2026-0001",
    contractRefText: "AGR-2025-0011 / ARC-PO-2026-0001"
  };
  applyRefNoMode(ctx, "theirs", nos);
  assert.equal(ctx.document.number, "ARC-IC-2026-0003");
  // 同じオブジェクトを 2 回通っても二重にならない
  assert.equal(ctx.masterAgreement.no, "K-001");
  assert.equal(ctx.agreement.no, "K-001");
  assert.equal(ctx.related[0].documentNo, "PO-9");
  assert.equal(ctx.parentPoNo, "PO-9");
  assert.equal(ctx.contractRefText, "K-001 / PO-9");
  assert.equal(ctx.refNoMode, "theirs");

  const untouched: Record<string, any> = { masterAgreement: { no: "AGR-2025-0011" } };
  applyRefNoMode(untouched, "ours", nos);
  assert.equal(untouched.masterAgreement.no, "AGR-2025-0011");
});

test("citeContractRef: 計算書の契約番号と基本契約番号", () => {
  const nos = new Map([["AGR-2025-0011", "K-001"]]);
  const ref = citeContractRef("both", nos, { title: "t", number: "AGR-2025-0011", masterNumber: "AGR-2025-0011" });
  assert.equal(ref.number, "AGR-2025-0011（相手方番号 K-001）");
  assert.equal(ref.masterNumber, "AGR-2025-0011（相手方番号 K-001）");
  assert.equal(ref.title, "t");
});
