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

/** 案件の作品を後から足す・外す。 */
const editDb = (matter: Record<string, unknown>, links: string[] = []) => new FakeDatabase((t) => {
  if (t.includes("FROM matters WHERE id = $1 FOR UPDATE")) return [matter];
  if (t.includes("FROM works WHERE id")) return [{ id: 1 }];
  if (t.includes("SELECT target_ref FROM matter_links")) return links.slice(0, 1).map((r) => ({ target_ref: r }));
  if (t.includes("UNION ALL")) return [];
  return undefined;
});

test("作品を足す：作品の無い案件なら軸に、あればつながりに入れる", async () => {
  const empty = editDb({ id: 3, kind: "outsourcing", work_id: null });
  await new MatterWriteService(empty).addWork(3, 12, "x");
  assert.deepEqual(empty.find("UPDATE matters SET work_id")!.params, [3, 12]);
  assert.ok(!empty.find("INSERT INTO matter_links"));

  const has = editDb({ id: 3, kind: "work", work_id: 11 });
  await new MatterWriteService(has).addWork(3, 12, "x");
  assert.deepEqual(has.find("INSERT INTO matter_links")!.params, [3, "12"]);
  assert.ok(!has.find("UPDATE matters SET work_id"));

  const same = editDb({ id: 3, kind: "work", work_id: 11 });
  await new MatterWriteService(same).addWork(3, 11, "x");
  assert.ok(!same.find("INSERT INTO matter_links") && !same.find("UPDATE matters SET work_id"), "既に軸なら何もしない");
});

test("作品を外す：軸を外すとつながりの最初の作品が軸に上がる。作品案件の最後の 1 つは外せない", async () => {
  const promote = editDb({ id: 3, kind: "work", work_id: 11 }, ["12", "13"]);
  await new MatterWriteService(promote).removeWork(3, 11, "x");
  assert.deepEqual(promote.find("UPDATE matters SET work_id")!.params, [3, 12]);
  assert.deepEqual(promote.find("DELETE FROM matter_links")!.params, [3, "12"], "上がった作品はつながりから抜く");

  const extra = editDb({ id: 3, kind: "work", work_id: 11 }, ["12"]);
  await new MatterWriteService(extra).removeWork(3, 12, "x");
  assert.deepEqual(extra.find("DELETE FROM matter_links")!.params, [3, "12"]);
  assert.ok(!extra.find("UPDATE matters SET work_id"), "軸はそのまま");

  await assert.rejects(() => new MatterWriteService(editDb({ id: 3, kind: "work", work_id: 11 })).removeWork(3, 11, "x"),
    /最後の作品は外せません/);
  const service = editDb({ id: 3, kind: "outsourcing", work_id: 11 });
  await new MatterWriteService(service).removeWork(3, 11, "x");
  assert.deepEqual(service.find("UPDATE matters SET work_id")!.params, [3, null], "業務委託は作品なしにできる");
});
