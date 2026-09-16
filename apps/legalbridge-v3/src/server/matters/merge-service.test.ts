import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MatterMergeService } from "./merge-service.js";
import { DomainError } from "../core/errors.js";

const head = (over: Record<string, unknown> = {}) => ({
  id: 1, matter_no: "MTR-1", title: "契約書で作った案件", kind: "outsourcing", status: "open",
  merged_into_id: null, counterparty_id: 2, party_name: "アトリエ", remarks: "先方から届いた",
  drive_folder_url: "https://drive/x", conditions: 2, links: 1, documents: 3, tasks: 1, communications: 4, batches: 0,
  ...over
});
const build = (into: Record<string, unknown> = {}, from: Record<string, unknown> = {}, audit?: unknown) =>
  new FakeDatabase((text, params) => {
    if (text.includes("FROM matters m LEFT JOIN parties p")) {
      return [head(from), head({ id: 9, matter_no: "MTR-9", title: "発注で作った案件", remarks: null,
                                 drive_folder_url: null, conditions: 5, documents: 1, ...into })];
    }
    if (text.includes("SELECT l.target_type, l.target_ref FROM matter_links")) {
      return [{ target_type: "condition", target_ref: "41" }, { target_type: "backlog", target_ref: "LB-12" }];
    }
    if (text.includes("SET matter_id = $2 WHERE matter_id = $1 RETURNING id")) {
      if (text.includes("UPDATE documents")) return [{ id: 101 }, { id: 102 }, { id: 103 }];
      if (text.includes("UPDATE tasks")) return [{ id: 7 }];
      return [];
    }
    if (text.includes("SELECT id, remarks, drive_folder_url FROM matters")) {
      return [head(from), head({ id: 9, remarks: null, drive_folder_url: null, ...into })];
    }
    if (text.includes("SELECT id, matter_no, merged_into_id FROM matters WHERE id = $1 FOR UPDATE")) {
      return [{ id: 1, matter_no: "MTR-1", merged_into_id: 9 }];
    }
    if (text.includes("FROM audit_events")) return audit === undefined ? [] : [{ detail: audit }];
    return undefined;
  });

test("統合：中身を統合先へ付け替え、統合元に統合先の印を付け、動かしたものを監査に残す", async () => {
  const db = build();
  const r = await new MatterMergeService(db).merge(1, 9, "k");
  assert.deepEqual(r.blockers, []);
  assert.equal(r.moves.documents, 3);
  // 外部リンクは統合先に無いものだけ動かし、残りは捨てる。
  const moveLinks = db.find("UPDATE matter_links l SET matter_id = $2")!;
  assert.deepEqual(moveLinks.params, [1, 9]);
  assert.ok(db.find("DELETE FROM matter_links WHERE matter_id = $1"));
  for (const table of ["documents", "tasks", "document_batches"]) {
    assert.ok(db.all(`UPDATE ${table} SET matter_id = $2`).length, table);
  }
  // やり取りの記録は追記専用（実行ロールに UPDATE が無い）。動かさない。
  assert.equal(db.all("UPDATE matter_communications").length, 0);
  // Drive フォルダは統合先に無いので引き継ぐ。備考は足す。
  assert.deepEqual(db.find("SET drive_folder_url = $2")!.params, [9, "https://drive/x"]);
  assert.match(String(db.find("SET remarks = concat_ws")!.params[1]), /統合元 MTR-1 の備考/);
  assert.deepEqual(db.find("SET merged_into_id = $2, merged_at = now()")!.params, [1, 9]);
  const audit = db.all("INSERT INTO audit_events").find((q) => q.params[1] === "matter.merge")!;
  const moved = JSON.parse(String(audit.params[5])).moved;
  assert.deepEqual(moved.documents, [101, 102, 103]);
  assert.deepEqual(moved.links, [{ targetType: "condition", targetRef: "41" }, { targetType: "backlog", targetRef: "LB-12" }]);
  assert.equal(moved.driveFolderCopied, true);
  assert.ok(db.texts.includes("COMMIT"));
});

test("取引モデルが違う・統合済み・同じ案件は止める。相手先違いは確認つきでだけ通る", async () => {
  const svc = (into: Record<string, unknown> = {}, from: Record<string, unknown> = {}) => new MatterMergeService(build(into, from));
  await assert.rejects(() => svc().merge(1, 1, "k"), /同じ案件/);
  await assert.rejects(() => svc({ kind: "work" }).merge(1, 9, "k"), /取引モデルが違う/);
  await assert.rejects(() => svc({ merged_into_id: 3 }).merge(1, 9, "k"), /統合先はすでに/);
  await assert.rejects(() => svc({}, { merged_into_id: 3 }).merge(1, 9, "k"), /統合元はすでに/);
  const p = await svc({ counterparty_id: 5, party_name: "別の相手" }).preview(1, 9);
  assert.deepEqual(p.blockers, []);
  assert.match(p.warnings[0], /相手先が違います/);
  await assert.rejects(() => svc({ counterparty_id: 5, party_name: "別の相手" }).merge(1, 9, "k"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT" && /acknowledge/.test(e.message));
  const ok = await svc({ counterparty_id: 5, party_name: "別の相手" }).merge(1, 9, "k", { acknowledge: true });
  assert.equal(ok.into.id, 9);
});

test("取り消し：監査に残した分だけ付け戻し、印を外す", async () => {
  const db = build({}, {}, { moved: { documents: [101, 102], tasks: [7], communications: [], batches: [],
                                     links: [{ targetType: "condition", targetRef: "41" }] } });
  const r = await new MatterMergeService(db).unmerge(1, "k");
  assert.deepEqual(r, { id: 1, matterNo: "MTR-1", into: 9 });
  assert.deepEqual(db.find("UPDATE documents SET matter_id = $1")!.params, [1, 9, [101, 102]]);
  assert.deepEqual(db.find("UPDATE tasks SET matter_id = $1")!.params, [1, 9, [7]]);
  assert.equal(db.find("UPDATE matter_communications SET matter_id = $1"), undefined, "動かしていないものは触らない");
  assert.deepEqual(db.find("UPDATE matter_links SET matter_id = $1")!.params, [1, 9, "condition", "41"]);
  assert.ok(db.find("SET merged_into_id = NULL"));
  await assert.rejects(() => new MatterMergeService(new FakeDatabase((t) =>
    t.includes("FOR UPDATE") ? [{ id: 1, matter_no: "MTR-1", merged_into_id: null }] : undefined)).unmerge(1, "k"),
    /統合されていません/);
});
