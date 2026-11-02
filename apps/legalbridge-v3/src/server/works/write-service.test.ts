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
  if (text.includes("UPDATE conditions SET work_id")) return [{ id: 11 }, { id: 12 }, { id: 13 }];
  if (text.includes("UPDATE condition_events SET work_id")) return [{ id: 71 }];
  if (text.includes("SELECT id, part_no FROM work_parts")) return [{ id: 5, part_no: 2 }];
  if (text.includes("UPDATE work_parts SET work_id")) return [{}];
  if (text.includes("UPDATE matter_links SET target_ref")) return [{ matter_id: 900 }];
  if (text.includes("FROM work_lineage WHERE parent_work_id = $1 OR child_work_id = $1") && text.startsWith("SELECT")) {
    return [{ parent_work_id: 3, child_work_id: 1, relation_type: "adaptation" }];
  }
  if (text.includes("INSERT INTO work_lineage")) return [{ parent_work_id: 3, child_work_id: 2, relation_type: "adaptation" }];
  return undefined;
};

test("統合は条件・パート・系譜を先へ付け替え、元は終了にして統合先を記録する", async () => {
  const db = new FakeDatabase(mergeRows());
  const result = await new WorkWriteService(db).merge(1, 2, "t");
  assert.deepEqual({ conditions: result.moved.conditions, parts: result.moved.parts, lineage: result.moved.lineage },
                   { conditions: 3, parts: 1, lineage: 2 });
  for (const t of ["work_editions", "ebook_work_codes", "work_credits", "condition_events", "matters"]) {
    assert.deepEqual(db.find(`UPDATE ${t} SET work_id`)?.params, [1, 2], `${t} も先へ（刊行物の ISBN・CID・クレジット・実績・案件）`);
  }
  assert.deepEqual(db.find("UPDATE conditions SET work_id")!.params, [1, 2], "条件は全部先へ");
  assert.ok(db.find("UPDATE work_parts SET work_id"), "パートは番号を振り直して先へ");
  assert.ok(db.find("DELETE FROM work_lineage WHERE parent_work_id = $1 OR child_work_id = $1"), "元の系譜は消す");
  const archived = db.find("merged_into_id = $2");
  assert.deepEqual(archived!.params, [1, 2, "統合：→ WRK-0002 ito"]);
  assert.equal(db.all("DELETE FROM works").length, 0, "行は消さない");
  const audits = db.all("INSERT INTO audit_events").map((a) => a.params[1]);
  assert.deepEqual(audits, ["work.merge", "work.merge_in"], "両方に記録を残す");
  // 取り消しのために、動かしたものの id を監査に残す。
  const detail = JSON.parse(String(db.find("INSERT INTO audit_events")!.params[5]));
  assert.deepEqual(detail.restore.conditions, [11, 12, 13], "条件の id");
  assert.deepEqual(detail.restore.condition_events, [71], "実績の id");
  assert.deepEqual(detail.restore.parts, [{ id: 5, partNo: 2 }], "パートは元の番号ごと");
  assert.deepEqual(detail.restore.links, [{ matterId: 900 }], "案件のほかの作品の繋がり");
  assert.deepEqual(detail.restore.lineage, [{ parentId: 3, childId: 1, relationType: "adaptation" }], "元の系譜");
  assert.equal(detail.restore.prevStatus, "released");
  assert.equal(db.find("UPDATE matter_links SET target_ref")!.params[1], "2", "案件の『ほかの作品』も先へ");
});

test("統合の取り消しは、監査に残した id のものだけ元へ戻し、作品を元の状態に戻す", async () => {
  const restore = {
    prevStatus: "released", conditions: [11, 12], work_editions: [31], ebook_work_codes: [], work_credits: [],
    condition_events: [71], matters: [900], parts: [{ id: 5, partNo: 2 }], links: [{ matterId: 901 }],
    lineage: [{ parentId: 3, childId: 1, relationType: "adaptation" }],
    lineageAdded: [{ parentId: 3, childId: 2, relationType: "adaptation" }]
  };
  const db = new FakeDatabase((text, params) => {
    if (text.includes("FROM works WHERE id = $1 FOR UPDATE")) {
      return [{ id: 1, work_code: "WRK-0001", title: "ito（旧）", status: "archived", merged_into_id: 2 }];
    }
    if (text.includes("action = 'work.merge'")) return [{ detail: { intoId: 2, restore } }];
    if (text.includes("UPDATE conditions SET work_id = $1")) return [{}, {}];
    if (text.includes("UPDATE work_parts SET work_id = $1")) return [{}];
    if (text.includes("UPDATE matter_links SET target_ref = $1")) return [{}];
    if (text.includes("INSERT INTO work_lineage")) return [{}];
    return params.length ? undefined : undefined;
  });
  const r = await new WorkWriteService(db).unmerge(1, "t");
  assert.equal(r.intoId, 2);
  assert.equal(r.restored.conditions, 2);
  assert.deepEqual(db.find("UPDATE conditions SET work_id = $1")!.params, [1, 2, [11, 12]], "統合で動かした条件だけ戻す");
  assert.deepEqual(db.find("UPDATE condition_events SET work_id = $1")!.params, [1, 2, [71]]);
  assert.deepEqual(db.find("UPDATE matters SET work_id = $1")!.params, [1, 2, [900]]);
  assert.deepEqual(db.find("UPDATE work_parts SET work_id = $1, part_no = $4")!.params, [1, 2, 5, 2], "パートは元の番号へ");
  assert.deepEqual(db.find("UPDATE matter_links SET target_ref = $1")!.params, ["1", "2", 901]);
  assert.deepEqual(db.find("DELETE FROM work_lineage WHERE parent_work_id = $1 AND child_work_id = $2")!.params,
                   [3, 2, "adaptation"], "先へ写した系譜は消す");
  assert.deepEqual(db.find("INSERT INTO work_lineage")!.params, [3, 1, "adaptation"], "元の系譜を戻す");
  const back = db.find("merged_into_id = NULL");
  assert.deepEqual(back!.params, [1, "released"], "状態を統合前へ戻す");
  assert.equal(db.find("INSERT INTO audit_events")!.params[1], "work.unmerge");
});

test("統合されていない作品の取り消しは断る", async () => {
  const db = new FakeDatabase((text) => text.includes("FOR UPDATE")
    ? [{ id: 1, work_code: "WRK-0001", title: "ito", status: "released", merged_into_id: null }] : undefined);
  await assert.rejects(() => new WorkWriteService(db).unmerge(1, "t"), /統合されていません/);
});

test("統合の下見は、移るものの数と止める理由・注意を返す", async () => {
  const db = new FakeDatabase((text, params) => {
    if (text.includes("FROM works WHERE id = $1")) {
      return Number(params[0]) === 1
        ? [{ id: 1, work_code: "WRK-0001", title: "ito（旧）", kind: "original", status: "released", merged_into_id: null }]
        : [{ id: 2, work_code: "WRK-0002", title: "ito", kind: "source_ip", status: "released", merged_into_id: null }];
    }
    if (text.includes("WITH RECURSIVE up")) return [];
    if (text.includes("FROM conditions WHERE work_id = $1 AND status IN")) return [{ n: Number(params[0]) === 1 ? 2 : 1 }];
    if (text.includes("FROM conditions WHERE work_id = $1")) return [{ n: 3 }];
    if (text.includes("FROM condition_events")) return [{ n: 4 }];
    if (text.includes("count(*)")) return [{ n: 0 }];
    return undefined;
  });
  const p = await new WorkWriteService(db).mergePreview(1, 2);
  assert.equal(p.from.title, "ito（旧）"); assert.equal(p.into.title, "ito");
  assert.equal(p.moves.conditions, 3); assert.equal(p.moves.activeConditions, 2); assert.equal(p.moves.events, 4);
  assert.deepEqual(p.blockers, []);
  assert.ok(p.warnings.some((w) => w.includes("種別が違います")), "種別の違いは注意");
  assert.ok(p.warnings.some((w) => w.includes("両方に生きている条件")), "二重の条件の注意");

  const merged = await new WorkWriteService(new FakeDatabase((text, params) => {
    if (text.includes("FROM works WHERE id = $1")) {
      return [{ id: Number(params[0]), work_code: null, title: "x", kind: "original", status: "released",
                merged_into_id: Number(params[0]) === 1 ? 9 : null }];
    }
    if (text.includes("count(*)")) return [{ n: 0 }];
    return [];
  })).mergePreview(1, 2);
  assert.ok(merged.blockers.some((b) => b.includes("すでに別の作品")), "統合済みは止める");
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
