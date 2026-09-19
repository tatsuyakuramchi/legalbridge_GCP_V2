import test from "node:test";
import assert from "node:assert/strict";
import { currentYearInTokyo, formatDocumentNumber, normalizePrefix, nextSequence } from "./numbering.js";
import { FakeDatabase } from "../core/fake-db.js";

test("文書番号は ARC-<prefix>-<year>-<0001> 形式（既存の発番形式を変えない）", () => {
  assert.equal(formatDocumentNumber("RS", 2026, 7), "ARC-RS-2026-0007");
  assert.equal(formatDocumentNumber("ARC-PO", 2026, 31), "ARC-PO-2026-0031");
  assert.equal(formatDocumentNumber("PO", 2026, 12345), "ARC-PO-2026-12345");
});

test("プレフィックスは大文字化し、ARC- は基底に戻す", () => {
  assert.equal(normalizePrefix(" arc-po "), "PO");
  assert.equal(normalizePrefix("RS"), "RS");
  assert.equal(normalizePrefix("bad prefix!"), null);
  assert.equal(normalizePrefix(null), null);
});

test("採番の年は東京時刻で切る", () => {
  // 2026-01-01 00:30 JST は UTC ではまだ 2025-12-31。東京基準で 2026 になること。
  assert.equal(currentYearInTokyo(new Date("2025-12-31T15:30:00Z")), 2026);
  assert.equal(currentYearInTokyo(new Date("2025-12-31T14:30:00Z")), 2025);
});

test("連番はプレフィックスと年ごとに1つ進む", async () => {
  const db = new FakeDatabase((text) =>
    text.includes("INSERT INTO document_sequences") ? [{ current_value: 8 }] : undefined);
  assert.equal(await nextSequence(db, "RS", 2026), 8);
  assert.deepEqual(db.find("document_sequences")!.params, ["RS", 2026]);
});
