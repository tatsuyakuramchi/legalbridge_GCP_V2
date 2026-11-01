import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { GameWorksImportService, GAME_WORKS_HEADERS } from "./game-works.js";

/** 作品・取引先・刊行物（製品）を覚えている偽の DB。作品と製品は deps から足す。 */
const world = () => {
  const works: Array<{ id: number; work_code: string | null; title: string }> = [];
  const editions: Array<{ work_id: number; isbn: string | null; title: string }> = [];
  const conds: Array<{ work_id: number; counterparty_id: number; usage_type: string; condition_no: string; direction: string; id: number; rate_ppm: number }> = [];
  const parties: Record<string, { id: number; name: string }> = {
    "デザイナーA": { id: 21, name: "デザイナーA" }, "V-21": { id: 21, name: "デザイナーA" },
    "イラストB": { id: 22, name: "イラストB" }, "Alpha Games": { id: 31, name: "Alpha Games" }
  };
  const db = new FakeDatabase((text, params) => {
    if (text.includes("FROM works") && text.includes("work_code")) {
      return works.filter((w) => (params[0] ? w.work_code === params[0] : w.title === params[1]));
    }
    if (text.includes("SELECT id, name FROM parties")) {
      const hit = parties[String(params[0] || params[1])];
      return hit ? [hit] : [];
    }
    if (text.includes("FROM work_editions e JOIN works w")) {
      return editions.filter((e) => e.isbn === params[0]).map((e) => ({ work_id: e.work_id, title: e.title }));
    }
    if (text.includes("direction = 'in'") && text.includes("usage_type = ANY")) {
      return conds.filter((c) => c.direction === "in" && c.work_id === params[0] && c.counterparty_id === params[1]
                                 && (params[2] as string[]).includes(c.usage_type));
    }
    if (text.includes("direction = 'out'") && text.includes("usage_type = $3")) {
      return conds.filter((c) => c.direction === "out" && c.work_id === params[0] && c.counterparty_id === params[1] && c.usage_type === params[2]);
    }
    return undefined;
  });
  const calls: Array<{ what: string; args: any[] }> = [];
  let seq = 900;
  const deps = {
    works: {
      create: async (input: any) => {
        calls.push({ what: "work", args: [input] });
        const id = 70 + works.length;
        works.push({ id, work_code: `WRK-${id}`, title: input.title });
        return { id, workCode: `WRK-${id}` };
      }
    },
    conditions: {
      createLicenseSet: async (input: any) => {
        calls.push({ what: "set", args: [input] });
        return { conditions: input.rows.map((r: any) => {
          const id = ++seq;
          conds.push({ id, work_id: input.workId, counterparty_id: input.counterpartyId, usage_type: r.usageType,
                       condition_no: `CL-${id}`, direction: "in", rate_ppm: r.ratePct * 10000 });
          return { usageType: r.usageType, id, conditionNo: `CL-${id}` };
        }) };
      },
      create: async (input: any) => {
        calls.push({ what: "out", args: [input] });
        const id = ++seq;
        conds.push({ id, work_id: input.workId, counterparty_id: input.counterpartyId, usage_type: input.usageType,
                     condition_no: `CL-${id}`, direction: "out", rate_ppm: input.ratePpm });
        return { id, conditionNo: `CL-${id}` };
      }
    },
    editions: {
      create: async (workId: number, input: any) => {
        calls.push({ what: "edition", args: [workId, input] });
        editions.push({ work_id: workId, isbn: input.isbn, title: works.find((w) => w.id === workId)?.title ?? "" });
        return { id: editions.length };
      }
    }
  };
  return { db, deps, calls, works, editions };
};

const ROWS: Array<Record<string, string>> = [
  { "作品名": "新作ボードゲーム", "相手先": "デザイナーA", "自社販売料率": "5", "他社販売料率": "3", "再許諾料率": "50",
    "JAN": "4901234567894", "発売日": "2026/11/20", "希望小売価格": "4,400" },
  { "作品名": "新作ボードゲーム", "相手先": "イラストB", "自社販売料率": "2", "再許諾料率": "20", "JAN": "4901234567894" },
  { "作品名": "新作ボードゲーム", "販売元": "Alpha Games", "販売元料率": "30", "発売日": "2027-06-01" }
];

test("見出し：料率は取引モデルごと、製品は販売元・JAN・発売日・希望小売価格・販売元料率", () => {
  for (const h of ["自社販売料率", "他社販売料率", "再許諾料率", "販売元", "販売元との関係", "JAN", "発売日", "希望小売価格", "販売元料率"]) {
    assert.ok(GAME_WORKS_HEADERS.includes(h), h);
  }
});

test("試算：作者ごとの行・同じ JAN は 1 件・海外版の再許諾。書かない", async () => {
  const w = world();
  const r = await new GameWorksImportService(w.db, w.deps).run(ROWS, true, "tester");
  assert.equal(r.ok, 3, JSON.stringify(r.rows));
  assert.match(r.rows[0].message ?? "", /作品を新しく作る・自社製造・自社販売 5%・自社製造・他社販売 3%・再許諾 50%・相手先 デザイナーA・製品 当社（自社製造・自社販売） JAN 4901234567894 2026-11-20 発売/);
  assert.match(r.rows[1].message ?? "", /前の行で作る作品・自社製造・自社販売 2%・再許諾 20%・相手先 イラストB・製品 4901234567894 は登録済み（足さない）/);
  assert.match(r.rows[2].message ?? "", /前の行で作る作品・製品 Alpha Games（再許諾 30%） JAN なし 2027-06-01 発売/);
  assert.equal(w.calls.length, 0);
});

test("登録：作品は 1 つ、作者ごとに条件、製品は 1 件、販売元との再許諾の条件を作って繋ぐ。もう一度流すと重複", async () => {
  const w = world();
  const r = await new GameWorksImportService(w.db, w.deps).run(ROWS, false, "tester");
  assert.equal(r.ok, 3, JSON.stringify(r.rows));
  assert.deepEqual(w.calls.map((c) => c.what), ["work", "set", "edition", "set", "out", "edition"]);
  assert.equal(w.works.length, 1);
  assert.equal(w.calls[0].args[0].businessLine, "ボードゲーム");
  assert.deepEqual(w.calls[1].args[0].rows.map((x: any) => [x.usageType, x.ratePct]), [["in_house", 5], ["oem", 3], ["sublicense", 50]]);
  assert.deepEqual(w.calls[2].args[1], { publisherPartyId: null, relation: "own", isbn: "4901234567894", publishedOn: "2026-11-20",
                                         listPrice: 4400, outConditionId: null });
  assert.equal(w.calls[3].args[0].counterpartyId, 22);
  const out = w.calls[4].args[0];
  assert.deepEqual([out.direction, out.usageType, out.counterpartyId, out.ratePpm, out.priceBasis], ["out", "sublicense", 31, 300000, "receipts"]);
  assert.equal(w.calls[5].args[1].relation, "sublicense");
  assert.ok(w.calls[5].args[1].outConditionId);

  const again = await new GameWorksImportService(w.db, w.deps).run(ROWS.slice(0, 2), false, "tester");
  assert.equal(again.duplicate, 2, JSON.stringify(again.rows));
  assert.match(again.rows[0].message ?? "", /既にあります.*製品も登録済み/);
});

test("止める：新しい作品に料率なし・他の作品の JAN・料率の範囲・関係が分からない販売元", async () => {
  const w = world();
  const svc = new GameWorksImportService(w.db, w.deps);
  let r = await svc.run([{ "作品名": "まだ無い作品", "JAN": "4901234567894" }], true, "tester");
  assert.match(r.rows[0].message ?? "", /新しい作品には料率/);
  r = await svc.run([{ "作品名": "別の作品", "相手先": "デザイナーA", "自社販売料率": "120" }], true, "tester");
  assert.match(r.rows[0].message ?? "", /0〜100/);
  r = await svc.run([{ "作品名": "別の作品", "相手先": "デザイナーA", "自社販売料率": "5", "販売元": "Alpha Games" }], true, "tester");
  assert.match(r.rows[0].message ?? "", /販売元との関係/);
  r = await svc.run([{ "作品名": "別の作品", "相手先": "デザイナーA", "自社販売料率": "5", "JAN": "4901234567890" }], true, "tester");
  assert.match(r.rows[0].message ?? "", /チェックディジット/);
  await svc.run([ROWS[0]], false, "tester");
  r = await svc.run([{ "作品名": "別の作品", "相手先": "デザイナーA", "自社販売料率": "5", "JAN": "4901234567894" }], false, "tester");
  assert.equal(r.rows[0].status, "duplicate");
  assert.match(r.rows[0].message ?? "", /「新作ボードゲーム」の製品に登録済み/);
});
