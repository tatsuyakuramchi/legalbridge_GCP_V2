import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { MatterWriteService } from "./write-service.js";

/**
 * 作品を複数扱う案件（ライセンスで数作品をまとめて取得・許諾する）。
 * 先頭が軸の作品で matters.work_id、残りは matter_links（target_type = 'work'。infra/v3/156）。
 */
const db = () => new FakeDatabase((t, params) => {
  if (t.includes("FROM parties WHERE id")) return [{ id: 5, name: "タンサン株式会社" }];
  if (t.includes("FROM staff WHERE id")) return [{ id: 7 }];
  if (t.includes("FROM works WHERE id")) {
    const id = Number(params?.[0]);
    return id === 404 ? [] : [{ id, title: { 11: "フロウ", 12: "ピルグリムス", 13: "サッチェ" }[id] ?? `作品${id}` }];
  }
  if (t.includes("INSERT INTO matters")) return [{ id: 900, matter_no: "MTR-2026-00900" }];
  return undefined;
});
const base = { kind: "work" as const, counterpartyId: 5, ownerStaffId: 7, matterNo: "MTR-2026-00900" };

test("作品を複数選ぶと、先頭を軸（work_id）にし、残りを案件のつながりに入れる", async () => {
  const d = db();
  const r = await new MatterWriteService(d).create({ ...base, workIds: [11, 12, 13] }, "legal@x");
  assert.equal(r.id, 900);
  const inserted = d.find("INSERT INTO matters")!;
  assert.equal(inserted.params[10], 11, "軸の作品は先頭");
  assert.match(String(inserted.params[1]), /フロウ/, "件名は軸の作品から組む");
  const links = d.queries.filter((c) => c.text.includes("INSERT INTO matter_links"));
  assert.deepEqual(links.map((c) => c.params), [[900, "12"], [900, "13"]]);
  assert.ok(links.every((c) => c.text.includes("'work'")));
});

test("作品が 1 つなら今までどおり（つながりは作らない）。workId と workIds の重なりは 1 つにする", async () => {
  const d = db();
  await new MatterWriteService(d).create({ ...base, workId: 11, workIds: [11] }, "legal@x");
  assert.equal(d.find("INSERT INTO matters")!.params[10], 11);
  assert.ok(!d.find("INSERT INTO matter_links"));
});

test("作品案件で作品が 1 つも無ければ断る。無い作品が混ざっていても断る", async () => {
  await assert.rejects(() => new MatterWriteService(db()).create({ ...base, workIds: [] }, "x"), /作品を選んでください/);
  await assert.rejects(() => new MatterWriteService(db()).create({ ...base, workIds: [11, 404] }, "x"), /作品 404 が見つかりません/);
});
