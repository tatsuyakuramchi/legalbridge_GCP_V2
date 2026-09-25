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

// ---- 統合 ------------------------------------------------------------

const mergeRows = (
  over: { sourceMerged?: number | null; targetMerged?: number | null; targetStatus?: string; related?: boolean } = {}
) => (text: string, params: unknown[]): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM works WHERE id = $1 FOR UPDATE")) {
    const id = Number(params[0]);
    return id === 1
      ? [{ id: 1, work_code: "WRK-0001", title: "ito（旧）", status: "released", merged_into_id: over.sourceMerged ?? null }]
      : [{ id: 2, work_code: "WRK-0002", title: "ito", status: over.targetStatus ?? "released", merged_into_id: over.targetMerged ?? null }];
  }
  if (text.includes("WITH RECURSIVE up")) return over.related ? [{ "?column?": 1 }] : [];
  if (text.includes("UPDATE conditions SET work_id")) return [{}, {}, {}];
  if (text.includes("UPDATE work_parts SET work_id")) return [{}];
  if (text.includes("INSERT INTO work_lineage")) return [{}];
  return undefined;
};

test("統合は条件・パート・系譜を先へ付け替え、元は終了にして統合先を記録する", async () => {
  const db = new FakeDatabase(mergeRows());
  const result = await new WorkWriteService(db).merge(1, 2, "t");
  assert.deepEqual(result.moved, { conditions: 3, parts: 1, lineage: 2 });
  assert.deepEqual(db.find("UPDATE conditions SET work_id")!.params, [1, 2], "条件は全部先へ");
  assert.ok(db.find("UPDATE work_parts SET work_id"), "パートは番号を振り直して先へ");
  assert.ok(db.find("DELETE FROM work_lineage WHERE parent_work_id = $1 OR child_work_id = $1"), "元の系譜は消す");
  const archived = db.find("merged_into_id = $2");
  assert.deepEqual(archived!.params, [1, 2, "統合：→ WRK-0002 ito"]);
  assert.equal(db.all("DELETE FROM works").length, 0, "行は消さない");
  const audits = db.all("INSERT INTO audit_events").map((a) => a.params[1]);
  assert.deepEqual(audits, ["work.merge", "work.merge_in"], "両方に記録を残す");
});

test("同じ作品・統合済み・終了した先・系譜で繋がった2つはまとめない", async () => {
  await assert.rejects(() => new WorkWriteService(new FakeDatabase(mergeRows())).merge(1, 1, "t"), /同じ作品/);
  await assert.rejects(
    () => new WorkWriteService(new FakeDatabase(mergeRows({ sourceMerged: 9 }))).merge(1, 2, "t"),
    /すでに別の作品にまとめて/);
  await assert.rejects(
    () => new WorkWriteService(new FakeDatabase(mergeRows({ targetMerged: 9 }))).merge(1, 2, "t"),
    /統合先がすでに/);
  await assert.rejects(
    () => new WorkWriteService(new FakeDatabase(mergeRows({ targetStatus: "archived" }))).merge(1, 2, "t"),
    /終了した作品には/);
  const related = new FakeDatabase(mergeRows({ related: true }));
  await assert.rejects(() => new WorkWriteService(related).merge(1, 2, "t"), /系譜で繋がっている/);
  assert.equal(related.all("UPDATE conditions").length, 0, "止まったら何も動かさない");
});
