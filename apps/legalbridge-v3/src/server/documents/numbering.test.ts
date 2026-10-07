import test from "node:test";
import assert from "node:assert/strict";
import { currentYearInTokyo, formatDocumentNumber, normalizePrefix, nextSequence,
         baseDocumentNumber, revisionOf, revisionNumber, nextRevisionNumber, printedDocumentNumber, showRevisionOf } from "./numbering.js";
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

test("進めた番号の文書がもうあれば、空いている番号まで進める（採番表の遅れ）", async () => {
  let current = 10;
  const db = new FakeDatabase((text, params) => {
    if (text.includes("INSERT INTO document_sequences")) { current += 1; return [{ current_value: current }]; }
    if (text.includes("FROM documents WHERE document_no")) {
      return ["ARC-PO-2026-0011", "ARC-PO-2026-0012"].includes(String(params[0])) ? [{ x: 1 }] : [];
    }
    return undefined;
  });
  assert.equal(await nextSequence(db, "PO", 2026), 13);
});

test("空き番号が見つからなければ止まる（黙って重複させない）", async () => {
  const db = new FakeDatabase((text) =>
    text.includes("INSERT INTO document_sequences") ? [{ current_value: 1 }]
      : text.includes("FROM documents WHERE document_no") ? [{ x: 1 }] : undefined);
  await assert.rejects(() => nextSequence(db, "PO", 2026, 3), /3 回試しても確保できません/);
});

test("訂正版の番号は連番を取らず、元の番号に枝番を付ける", () => {
  assert.equal(baseDocumentNumber("ARC-PO-2026-0031-R2"), "ARC-PO-2026-0031");
  assert.equal(baseDocumentNumber("ARC-PO-2026-0031"), "ARC-PO-2026-0031");
  assert.equal(revisionOf("ARC-PO-2026-0031"), 1);
  assert.equal(revisionOf("ARC-PO-2026-0031-R3"), 3);
  assert.equal(revisionNumber("ARC-PO-2026-0031", 1), "ARC-PO-2026-0031");
  assert.equal(revisionNumber("ARC-PO-2026-0031", 2), "ARC-PO-2026-0031-R2");
});

test("次の枝番は、同じ本体の番号を持つ文書（無効にした訂正版も）を数えて決める", async () => {
  const db = new FakeDatabase((text) =>
    text.includes("SELECT document_no FROM documents WHERE document_no = $1 OR document_no LIKE $2")
      ? [{ document_no: "ARC-PO-2026-0031" }, { document_no: "ARC-PO-2026-0031-R2" },
         { document_no: "ARC-PO-2026-0031-R3" }, { document_no: "ARC-PO-2026-00310" }]
      : undefined);
  // 訂正版の訂正版でも、本体は元のまま。R3 まであれば（無効でも）次は R4。
  assert.equal(await nextRevisionNumber(db, "ARC-PO-2026-0031-R2"), "ARC-PO-2026-0031-R4");
  assert.deepEqual(db.find("LIKE $2")!.params, ["ARC-PO-2026-0031", "ARC-PO-2026-0031-R%"]);
  const fresh = new FakeDatabase((text) => text.includes("LIKE $2") ? [{ document_no: "ARC-PO-2026-0031" }] : undefined);
  assert.equal(await nextRevisionNumber(fresh, "ARC-PO-2026-0031"), "ARC-PO-2026-0031-R2");
});

test("紙に出す番号は本体。改訂の印は見せると決めたときだけ「（改訂 n）」", () => {
  assert.equal(printedDocumentNumber("ARC-PO-2026-0031", true), "ARC-PO-2026-0031");
  assert.equal(printedDocumentNumber("ARC-PO-2026-0031-R2", true), "ARC-PO-2026-0031（改訂2）");
  assert.equal(printedDocumentNumber("ARC-PO-2026-0031-R2", false), "ARC-PO-2026-0031");
  // 書いていなければ見せる。"0" / false で見せない。
  assert.equal(showRevisionOf({}), true);
  assert.equal(showRevisionOf(null), true);
  assert.equal(showRevisionOf({ _showRevision: "0" }), false);
  assert.equal(showRevisionOf({ _showRevision: false }), false);
  assert.equal(showRevisionOf({ _showRevision: "1" }), true);
});
