import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PdfStore } from "./pdf-store.js";
import { MemoryPdfRenderer } from "./pdf-renderer.js";

const html = async () => ({ html: "<p>x</p>", documentNo: "ARC-PO-2026-0001" });
const store = (db: FakeDatabase, renderer = new MemoryPdfRenderer(), log?: (m: string) => void) =>
  new PdfStore(db, renderer, html, "memory", log ?? (() => undefined));

test("置いてあればそれを返し、描かない", async () => {
  let rendered = 0;
  const renderer = { render: async () => { rendered += 1; return Buffer.from("x"); } };
  const db = new FakeDatabase((t) => t.includes("FROM document_pdfs") ? [{ data: Buffer.from("cached") }] : []);
  const out = await store(db, renderer).ensure(7);
  assert.equal(out.toString(), "cached");
  assert.equal(rendered, 0);
});

test("無ければ描いて置く（UPSERT）", async () => {
  const db = new FakeDatabase(() => []);
  const out = await store(db).ensure(7);
  assert.match(out.toString(), /^%PDF/);
  const ins = db.find("INSERT INTO document_pdfs")!;
  assert.equal(ins.params[0], 7);
  assert.equal(ins.params[2], out.length);
  assert.match(String(ins.params[3]), /^[0-9a-f]{64}$/);
  assert.match(ins.text, /ON CONFLICT \(document_id\) DO UPDATE/);
});

test("決定後の作り置きは失敗しても投げない（次に使うときに描く）", async () => {
  const notes: string[] = [];
  const renderer = { render: async () => { throw new Error("chromium down"); } };
  const db = new FakeDatabase(() => []);
  assert.equal(await store(db, renderer, (m) => notes.push(m)).warm(7), false);
  assert.match(notes[0], /chromium down/);
  assert.equal(db.find("INSERT INTO document_pdfs"), undefined);
});

test("まだ置いていない決定済みの文書を古い順に引く（取込文書は除く）", async () => {
  const db = new FakeDatabase((t) => t.includes("NOT EXISTS (SELECT 1 FROM document_pdfs") ? [{ id: 3 }, { id: 2 }] : []);
  assert.deepEqual(await store(db).missing(10), [3, 2]);
  assert.match(db.find("NOT EXISTS")!.text, /template_version_id IS NOT NULL/);
});
