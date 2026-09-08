import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentIssueService } from "./issue-service.js";

const doc = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 5, document_no: "ARC-PO-2026-0007", status,
  template_version_id: 2, matter_id: 3, agreement_id: null, manual_inputs: {}, ...extra
});

const build = (row: Record<string, unknown> | undefined) => new FakeDatabase((text) => {
  if (text.includes("FROM documents WHERE id")) return row ? [row] : [];
  if (text.includes("INSERT INTO documents")) return [{ id: 9 }];
  return undefined;
});

test("無効化しても行は消さない。status を変えて理由を残す", async () => {
  const db = build(doc("issued"));
  const r = await new DocumentIssueService(db).void(5, "宛先を間違えたため", "kuramochi");

  assert.equal(r.documentNo, "ARC-PO-2026-0007");
  assert.ok(!db.queries.some((q) => /DELETE\s+FROM\s+documents/i.test(q.text)),
    "発行した事実そのものが記録なので消さない");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "document.void");
  assert.match(JSON.stringify(audit.params), /宛先を間違えた/);
});

test("理由なしでは無効にできない", async () => {
  const svc = new DocumentIssueService(build(doc("issued")));
  await assert.rejects(() => svc.void(5, "   ", "k"), /理由を書いてください/);
});

test("すでに無効なものは二度無効にしない", async () => {
  const svc = new DocumentIssueService(build(doc("void")));
  await assert.rejects(() => svc.void(5, "重複", "k"), /すでに無効です/);
});

test("差し替え済みは無効にできない。新しい版を無効にする", async () => {
  const svc = new DocumentIssueService(build(doc("superseded")));
  await assert.rejects(() => svc.void(5, "取消", "k"), /新しい版を無効に/);
});

test("再発行は新しい下書きを作り、元を superseded にして繋ぐ", async () => {
  const db = build(doc("issued"));
  const r = await new DocumentIssueService(db).reissue(5, "金額を訂正するため", "kuramochi");

  assert.equal(r.id, 9);
  assert.equal(r.supersedesId, 5);
  const created = db.find("INSERT INTO documents")!;
  assert.equal(created.params[4], 5, "新版から旧版へ supersedes_id で繋ぐ");
  assert.ok(db.find("INSERT INTO document_conditions"), "紐づく条件を引き継ぐ");
  const marked = db.queries.find((q) => q.text.includes("status = 'superseded'"))!;
  assert.equal(marked.params[0], 5);
});

test("下書きは作り直せない。まだ発行していない", async () => {
  const svc = new DocumentIssueService(build(doc("draft")));
  await assert.rejects(() => svc.reissue(5, "訂正", "k"), /発行済みの文書だけ/);
});

test("テンプレートの無い取込文書は作り直せない", async () => {
  const svc = new DocumentIssueService(build(doc("issued", { template_version_id: null })));
  await assert.rejects(() => svc.reissue(5, "訂正", "k"), /取込文書は作り直せません/);
});

test("存在しない文書には何もしない", async () => {
  const svc = new DocumentIssueService(build(undefined));
  await assert.rejects(() => svc.void(5, "x", "k"), /見つかりません/);
  await assert.rejects(() => svc.reissue(5, "x", "k"), /見つかりません/);
});
