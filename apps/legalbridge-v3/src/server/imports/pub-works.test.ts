import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DomainError } from "../core/errors.js";
import { PubWorksImportService, parseShareText } from "./pub-works.js";

test("取り分の列：電子の料率を分けた率で読む。合計が 100 なら比率", () => {
  assert.deepEqual(parseShareText("作家B 10／作家C 5", 15).map((s) => [s.name, s.ppm]), [["作家B", 666667], ["作家C", 333333]]);
  assert.deepEqual(parseShareText("瀧里フユ 75%; 宝井ロメロ 25%", 15).map((s) => s.ppm), [750000, 250000]);
  assert.deepEqual(parseShareText("", 15), []);
  assert.throws(() => parseShareText("作家B 10／作家C 4", 15), (e: unknown) => e instanceof DomainError && /合計が合いません/.test(e.message));
  assert.throws(() => parseShareText("作家B", 15), (e: unknown) => e instanceof DomainError && /名前 10／名前 5/.test(e.message));
});

interface Options {
  works?: Array<{ id: number; work_code: string | null; title: string }>;
  parties?: Record<string, { id: number; name: string }>;
  existing?: Array<{ condition_no: string; usage_type: string }>;
}
const db = (o: Options = {}) => new FakeDatabase((text, params) => {
  if (text.includes("SELECT id, work_code, title FROM works")) {
    return (o.works ?? []).filter((w) => (params[0] ? w.work_code === params[0] : w.title === params[1]));
  }
  if (text.includes("SELECT id, name FROM parties")) {
    const hit = (o.parties ?? {})[String(params[1] || params[0])];
    return hit ? [hit] : [];
  }
  if (text.includes("FROM conditions") && text.includes("usage_type = ANY")) return o.existing ?? [];
  return undefined;
});
const PARTIES = { "冒険支援株式会社": { id: 11, name: "冒険支援株式会社" }, "作家B": { id: 21, name: "作家B" }, "作家C": { id: 22, name: "作家C" } };

const deps = () => {
  const calls: Array<{ what: string; args: unknown[] }> = [];
  return {
    calls,
    works: { create: async (input: unknown) => { calls.push({ what: "work", args: [input] }); return { id: 77, workCode: "WRK-2026-0077" }; } },
    conditions: {
      createPublishingSet: async (input: unknown) => {
        calls.push({ what: "set", args: [input] });
        return { print: { id: 501, conditionNo: "CL-501" }, digital: { id: 502, conditionNo: "CL-502" } };
      },
      replaceShares: async (...args: unknown[]) => { calls.push({ what: "shares", args }); return {}; }
    }
  };
};

const ROW = { "作品名": "新しい作品", "相手先": "冒険支援株式会社", "紙料率": "10", "電子料率": "15",
              "取り分": "作家B 10／作家C 5", "分配": "当社", "CID": "BT0001／BT0002", "言語": "日本語" };

test("試算：作品が無ければ「新しく作る」、紙・電子・取り分・CID を読み上げる。書かない", async () => {
  const fake = db({ parties: PARTIES });
  const d = deps();
  const r = await new PubWorksImportService(fake, d).run([ROW], true, "tester");
  assert.equal(r.ok, 1);
  assert.match(r.rows[0].message ?? "", /作品を新しく作る・紙 10%・電子 15%・相手先 冒険支援株式会社・取り分 作家B 66.67%／作家C 33.33%（当社が分配）・CID 2 件/);
  assert.equal(d.calls.length, 0);
  assert.equal(fake.all("INSERT").length, 0);
});

test("登録：作品を作り、出版セットを作り、電子の条件に取り分（作品全体に反映）、CID を覚える", async () => {
  const fake = db({ parties: PARTIES });
  const d = deps();
  const r = await new PubWorksImportService(fake, d).run([ROW], false, "tester");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.equal(r.rows[0].code, "WRK-2026-0077");
  assert.deepEqual(d.calls.map((c) => c.what), ["work", "set", "shares"]);
  const set = d.calls[1].args[0] as Record<string, any>;
  assert.equal(set.counterpartyId, 11);
  assert.equal(set.workId, 77);
  assert.deepEqual(set.print, { ratePct: 10, exclusivity: "non_exclusive" });
  assert.deepEqual(set.digital, { ratePct: 15, exclusivity: "non_exclusive" });
  const shares = d.calls[2].args;
  assert.equal(shares[0], 502, "電子の条件に入れる");
  assert.deepEqual(shares[1], [{ partyId: 21, sharePpm: 666667 }, { partyId: 22, sharePpm: 333333 }]);
  assert.equal(shares[3], "direct");
  assert.deepEqual(shares[4], { applyToWork: true }, "紙にも同じ按分");
  assert.equal(fake.all("INSERT INTO ebook_work_codes").length, 2);
});

test("既存の作品に当たれば作らない。同じ相手先の紙・電子があれば重複", async () => {
  const works = [{ id: 7, work_code: "WRK-7", title: "新しい作品" }];
  const d = deps();
  const r = await new PubWorksImportService(db({ parties: PARTIES, works }), d).run([ROW], false, "tester");
  assert.equal(r.ok, 1);
  assert.match(r.rows[0].message ?? "", /既存の作品 WRK-7/);
  assert.equal(d.calls[0].what, "set", "作品は作らない");

  const dup = await new PubWorksImportService(db({ parties: PARTIES, works, existing: [{ condition_no: "CL-9", usage_type: "pub_digital" }] }), deps())
    .run([ROW], true, "tester");
  assert.equal(dup.duplicate, 1);
  assert.match(dup.rows[0].message ?? "", /電子（CL-9）が既にあります/);
});

test("止める：相手先なし・料率なし・代表が取り分に無い・知らない権利者", async () => {
  const svc = new PubWorksImportService(db({ parties: PARTIES }), deps());
  const r = await svc.run([
    { ...ROW, "相手先": "" },
    { ...ROW, "紙料率": "", "電子料率": "" },
    { ...ROW, "分配": "代表" },
    { ...ROW, "取り分": "作家B 10／誰か 5" }
  ], true, "tester");
  assert.equal(r.error, 4);
  assert.match(r.rows[0].message ?? "", /相手先が空/);
  assert.match(r.rows[1].message ?? "", /紙料率か電子料率/);
  assert.match(r.rows[2].message ?? "", /相手先（代表）を取り分の中に/);
  assert.match(r.rows[3].message ?? "", /取り分の権利者「誰か」が見つかりません/);
});
