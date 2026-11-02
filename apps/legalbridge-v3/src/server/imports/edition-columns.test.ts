import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { GAME_EDITION_NAMES, PUB_EDITION_NAMES, writeEditionRow } from "./edition-columns.js";

const deps = () => {
  const calls: Array<{ what: string; args: any[] }> = [];
  let seq = 500;
  return {
    calls,
    createOut: async (input: any) => { calls.push({ what: "out", args: [input] }); return { id: ++seq, conditionNo: `CL-${seq}` }; },
    editions: { create: async (workId: number, input: any) => { calls.push({ what: "edition", args: [workId, input] }); return { id: 1 }; } }
  };
};
const KADOKAWA = { id: 7, name: "KADOKAWA" };

test("出版：版元料率と版元電子料率で、版元との条件を紙・電子の 2 本に分ける（媒体の許諾範囲つき）。刊行物は紙を指す", async () => {
  const d = deps();
  const said = await writeEditionRow(new FakeDatabase(() => []), d, 3, "るるいえばけーしょん",
    { publisher: KADOKAWA, relation: "sublicense", isbn: "9784047276703", publishedOn: "2011-11-30", listPrice: null,
      outRatePct: 8, outDigitalRatePct: 25 }, PUB_EDITION_NAMES, "tester");
  const outs = d.calls.filter((c) => c.what === "out").map((c) => c.args[0]);
  assert.deepEqual(outs.map((o) => [o.name, o.ratePpm, o.priceBasis, o.statementTiming, o.scopes?.[0]?.code]), [
    ["るるいえばけーしょん｜出版の再許諾・紙（KADOKAWA）", 80000, "list", "event", "print"],
    ["るるいえばけーしょん｜出版の再許諾・電子（KADOKAWA）", 250000, null, "periodic", "digital"]
  ]);
  assert.equal(d.calls.find((c) => c.what === "edition")!.args[1].outConditionId, 501, "刊行物（本）は紙の条件");
  assert.equal(said, "版元との紙の条件 CL-501・版元との電子の条件 CL-502");
});

test("出版：既存の条件は媒体で当てる（媒体なしの古い条件は紙）。料率が違えば止める", async () => {
  const db = new FakeDatabase((text, params) => {
    if (text.includes("FROM conditions c") && params[2] === "sublicense") {
      return [{ id: 40, condition_no: "CL-40", rate_ppm: 80000, media: null }, { id: 41, condition_no: "CL-41", rate_ppm: 250000, media: "digital" }];
    }
    return [];
  });
  const d = deps();
  await writeEditionRow(db, d, 3, "作品", { publisher: KADOKAWA, relation: "sublicense", isbn: null, publishedOn: null, listPrice: null,
    outRatePct: 8, outDigitalRatePct: 25 }, PUB_EDITION_NAMES, "tester");
  assert.equal(d.calls.filter((c) => c.what === "out").length, 0, "どちらも既存を使う");
  assert.equal(d.calls[0].args[1].outConditionId, 40);
  await assert.rejects(writeEditionRow(db, deps(), 3, "作品", { publisher: KADOKAWA, relation: "sublicense", isbn: null, publishedOn: null,
    listPrice: null, outRatePct: 8, outDigitalRatePct: 30 }, PUB_EDITION_NAMES, "tester"), /電子の再許諾の条件 CL-41 は料率 25%/);
});

test("ゲーム：販売元料率は媒体なしの 1 本", async () => {
  const d = deps();
  await writeEditionRow(new FakeDatabase(() => []), d, 3, "新作", { publisher: { id: 9, name: "Alpha Games" }, relation: "sublicense",
    isbn: null, publishedOn: null, listPrice: null, outRatePct: 30 }, GAME_EDITION_NAMES, "tester");
  const outs = d.calls.filter((c) => c.what === "out").map((c) => c.args[0]);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].scopes, undefined);
  assert.equal(outs[0].name, "新作｜再許諾（Alpha Games）");
});

test("別の作品に登録済みの ISBN で新しい作品を作る行は、刊行物をその作品へ付け替える（二重に作らない）", async () => {
  const { readEditionColumns } = await import("./edition-columns.js");
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM work_editions e JOIN works w")) return [{ id: 77, work_id: 3, title: "クトゥルフ・ホラーショウ" }];
    return [];
  });
  const row = { "版元": "新紀元社", "版元コード": "", "版元との関係": "グループ会社", "ISBN": "9784775322727", "刊行日": "2026-03-19", "本体価格": "", "版元料率": "", "版元電子料率": "" };
  const find = async () => ({ id: 21, name: "新紀元社" });
  // 既存の作品（id 3）に足す行なら「登録済み」。
  const same = await readEditionColumns(db, row, PUB_EDITION_NAMES, find, 3);
  assert.equal(same!.reuse, true);
  // 別の作品（id 9）に足す行なら止める。
  await assert.rejects(() => readEditionColumns(db, row, PUB_EDITION_NAMES, find, 9), /登録済みです/);
  // 新しい作品を作る行なら付け替え。
  const fresh = await readEditionColumns(db, row, PUB_EDITION_NAMES, find, null);
  assert.deepEqual(fresh!.moveFrom, { editionId: 77, workId: 3, title: "クトゥルフ・ホラーショウ" });
  const d = deps();
  const said = await writeEditionRow(db, d, 40, "クトゥルフ・ホラーショウ（新紀元社版）", fresh!, PUB_EDITION_NAMES, "tester");
  assert.match(said, /付け替えた/);
  assert.equal(d.calls.length, 0, "刊行物も条件も新しく作らない");
  const moved = db.queries.find((q) => /UPDATE work_editions SET work_id/.test(q.text))!;
  assert.deepEqual(moved.params, [77, 40]);
});
