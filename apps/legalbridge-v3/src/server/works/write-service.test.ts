import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { WorkWriteService } from "./write-service.js";

const rows = (
  over: { status?: string; loop?: boolean; known?: number[]; partRefs?: number;
          used?: Record<string, number> } = {}
) => (text: string, params: unknown[]): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM works WHERE id = $1 FOR UPDATE")) {
    return [{ id: 1, work_code: "WRK-0001", title: "星降る夜のミュゼ", status: over.status ?? "planning" }];
  }
  if (text.includes("FROM works WHERE id = ANY")) {
    const wanted = (params[0] as number[]);
    return wanted.filter((id) => (over.known ?? wanted).includes(id)).map((id) => ({ id }));
  }
  if (text.includes("WITH RECURSIVE up")) return over.loop ? [{ "?column?": 1 }] : [];
  if (text.includes("FROM work_parts WHERE id = $1 AND work_id = $2 FOR UPDATE")) return [{ id: 5 }];
  if (text.includes("FROM conditions WHERE work_part_id = $1")) return [{ n: over.partRefs ?? 0 }];
  if (text.includes("AS part_refs")) {
    return [{ conditions: 0, part_refs: 0, children: 0, ...over.used }];
  }
  return undefined;
};

test("作品の本体を1文で書き換える", async () => {
  const db = new FakeDatabase(rows());
  await new WorkWriteService(db).update(1, { title: "新しい題名", status: "released" }, "t");
  const update = db.find("UPDATE works SET");
  assert.ok(update);
  assert.deepEqual(update!.params, [1, "新しい題名", "released"]);
  assert.equal(db.find("INSERT INTO audit_events")!.params[1], "work.update");
});

test("空の題名にはできない。変更が無ければ止まる", async () => {
  const svc = new WorkWriteService(new FakeDatabase(rows()));
  await assert.rejects(() => svc.update(1, { title: "  " }, "t"), /作品名は必須/);
  await assert.rejects(() => svc.update(1, {}, "t"), /変更する項目がありません/);
});

test("原作は集合ごと置き換える。原作 N に対して作品 N", async () => {
  const db = new FakeDatabase(rows());
  const result = await new WorkWriteService(db).setSources(1, [10, 11, 11], "t");
  assert.deepEqual(result.sources, [10, 11], "重複は1つに");
  assert.ok(db.find("DELETE FROM work_lineage WHERE child_work_id = $1"), "いまの親を外してから");
  assert.equal(db.all("INSERT INTO work_lineage").length, 2, "渡された親だけを付ける");
});

test("自分自身と、自分から派生した作品は原作にできない", async () => {
  await assert.rejects(
    () => new WorkWriteService(new FakeDatabase(rows())).setSources(1, [1], "t"),
    /自分自身/);
  await assert.rejects(
    () => new WorkWriteService(new FakeDatabase(rows({ loop: true }))).setSources(1, [10], "t"),
    /輪になります/);
});

test("無い作品は原作にできない", async () => {
  await assert.rejects(
    () => new WorkWriteService(new FakeDatabase(rows({ known: [10] }))).setSources(1, [10, 99], "t"),
    /作品 99 が見つかりません/);
});

test("パートは条件が指していなければ消せる", async () => {
  const ok = new FakeDatabase(rows());
  await new WorkWriteService(ok).removePart(1, 5, "t");
  assert.ok(ok.find("DELETE FROM work_parts"));

  const used = new FakeDatabase(rows({ partRefs: 2 }));
  await assert.rejects(() => new WorkWriteService(used).removePart(1, 5, "t"), /条件が 2 件/);
  assert.equal(used.all("DELETE FROM work_parts").length, 0);
});

test("終了 → 削除の2段階。終了は理由必須で備考に残す", async () => {
  const db = new FakeDatabase(rows());
  const svc = new WorkWriteService(db);
  await assert.rejects(() => svc.archive(1, " ", "t"), /理由は必須/);
  await svc.archive(1, "重複登録", "t");
  const update = db.find("SET status = 'archived'");
  assert.deepEqual(update!.params, [1, "終了：重複登録"]);
  // 終了していない作品は消せない
  await assert.rejects(() => new WorkWriteService(new FakeDatabase(rows())).remove(1, "t"), /先に終了に/);
});

test("削除は条件が指していないときだけ。指していれば何が指しているかを言う", async () => {
  const blocked = new FakeDatabase(rows({ status: "archived", used: { conditions: 3, children: 1 } }));
  await assert.rejects(() => new WorkWriteService(blocked).remove(1, "t"), (e: Error) => {
    assert.match(e.message, /条件 3 件/);
    assert.match(e.message, /原作にしている作品 1 件/);
    return true;
  });
  assert.equal(blocked.all("DELETE FROM works").length, 0);

  const free = new FakeDatabase(rows({ status: "archived" }));
  const result = await new WorkWriteService(free).remove(1, "t");
  assert.deepEqual(result, { deleted: true, workCode: "WRK-0001" });
  assert.ok(free.find("DELETE FROM works WHERE id = $1"));
});
